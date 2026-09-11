import test from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { readFile, stat } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { panelFixture, request } from "./bridge-panel.mjs"
import { createBridge } from "../src/bridge.mjs"
import { hash, releaseMetadata } from "../src/protocol.mjs"
import { randomUUID } from "node:crypto"

const exec = promisify(execFile)

test("compatibility runtime metadata validates release targets and credential-free HTTPS URLs", () => {
  const defaults = releaseMetadata()
  assert.equal(defaults.cookieMonsterVersion, null)
  assert.equal(defaults.cookieMonsterVersionStatus, "not_configured")
  assert.equal(defaults.releaseSourceUrl, "https://github.com/trmosala/CookieJar/releases")
  assert.ok(Object.values(defaults.updates).every(update => update.status === "not_configured" && update.url === null))
  const update = { version: "0.2.2", protocol: 1, url: "https://releases.example.test/ae/0.2.2" }
  assert.equal(releaseMetadata({ cookieMonsterVersion: "2.4.1", updates: { panel: update } }).updates.panel.status, "configured")
  for (const url of ["javascript:alert(1)", "http://example.test/a", "file:///C:/secret", "//example.test/a",
    "https://user:secret@example.test/a", "https://example.test/a?token=secret", "https://example.test/a#secret",
    "https://example.test/%0aevil", "https://example.test/\\nsecret", "https://example.test/a b", {}, "https://" + "a".repeat(2050)])
    assert.throws(() => releaseMetadata({ updates: { panel: { ...update, url } } }), { code: "invalid_payload" })
  for (const suffix of ["\n", "\r", "\r\n", "\t", "\0", "\u2028", "\u2029"]) {
    assert.throws(() => releaseMetadata({ cookieMonsterVersion: "1.0" + suffix }), { code: "invalid_payload" })
    assert.throws(() => releaseMetadata({ updates: { panel: { ...update, url: update.url + suffix } } }),
      { code: "invalid_payload" })
  }
  for (const metadata of [{ cookieMonsterVersion: "C:/Users/SECRET" }, { cookieMonsterVersion: {} },
    { cookieMonsterVersion: "1.0\\n" }, { updates: { unexpected: update } }, { updates: [] },
    { updates: { panel: { ...update, version: "9.0.0" } } }, { updates: { panel: { ...update, protocol: 2 } } },
    { updates: { panel: { ...update, approved: true } } }, { approved: true }])
    assert.throws(() => releaseMetadata(metadata), { code: "invalid_payload" })
})

test("compatibility probes retain only authenticated versions, never authorize tools, and preserve pending recovery locks", async t => {
  const configured = { cookieMonsterVersion: "2.4.1",
    updates: { panel: { version: "0.2.2", protocol: 1, url: "https://releases.example.test/ae/0.2.2" } } }
  const p = await panelFixture(t, { releaseMetadata: configured })
  configured.cookieMonsterVersion = "9.9.9"
  const peer = { panelId: "test-panel", protocol: 2, version: "0.2.2" }
  const initial = (await p.bridge.connections())[0].compatibility
  assert.equal(initial.panelVersion, "0.2.2")
  assert.equal(initial.status, "compatible")
  assert.equal(initial.cookieMonsterVersion, "2.4.1")
  assert.equal((await request(p.port, "/compatibility", peer)).status, 401)
  assert.equal((await p.send("/compatibility", { ...peer, panelId: "foreign" })).status, 401)
  for (const bad of [{ version: "C:/Users/SECRET" }, { version: { secret: true } }, { version: "1.0\\n" },
    { version: "1".repeat(65) }, { protocol: "2" }, { protocol: 0 }, { protocol: -1 }, { protocol: 1.5 },
    { protocol: Number.MAX_SAFE_INTEGER + 1 }, { updateUrl: "https://evil.test" }, { releaseMetadata: configured }]) {
    const response = await p.send("/compatibility", { ...peer, ...bad })
    assert.equal(response.body.error.code, "invalid_payload")
    assert.deepEqual(response.body.error.details, {})
  }
  assert.deepEqual((await p.bridge.connections())[0].compatibility, initial)
  await p.bridge.lock("session", { kind: "structured" })
  const pending = p.bridge.call("session", "execute", { actions: [] }, { allowLocked: true })
  const rejected = assert.rejects(pending, { code: "outcome_uncertain" })
  assert.ok((await p.send("/poll")).body.command)
  const probe = await p.send("/compatibility", peer)
  await rejected
  assert.equal(probe.status, 200)
  assert.equal(probe.body.compatibility.status, "incompatible")
  assert.equal(probe.body.compatibility.panelProtocol, 2)
  assert.equal(probe.body.compatibility.panelVersion, "0.2.2")
  assert.equal(probe.body.compatibility.updates.panel.url, "https://releases.example.test/ae/0.2.2")
  const connection = (await p.bridge.connections())[0]
  assert.equal(connection.connected, false)
  assert.equal(connection.lock.state, "uncertain")
  assert.equal(connection.binding.state, "suspended")
  await assert.rejects(p.bridge.bind("session", p.connectionId), { code: "disconnected" })
  await assert.rejects(p.bridge.call("session", "inspect", {}, { allowLocked: true }), { code: "binding_suspended" })
  assert.equal((await p.send("/poll")).body.error.code, "disconnected")
  assert.equal((await p.send("/panel", { action: "diagnostics" })).body.error.code, "disconnected")
  const connect = { ...peer, project: p.state.project, aeVersion: "26.0", capabilities: p.state.capabilities }
  const mismatch = await p.send("/connect", connect)
  assert.equal(mismatch.body.error.code, "incompatible_version")
  assert.deepEqual(mismatch.body.error.details.compatibility, probe.body.compatibility)
  const persisted = await readFile(path.join(p.dataDir, "bridge-state.json"), "utf8")
  for (const excluded of ["panelVersion", "cookieMonsterVersion", "0.2.2", "releases.example.test"])
    assert.ok(!persisted.includes(excluded), excluded)
  await p.send("/compatibility", { ...peer, version: "0.2.2", protocol: 1 })
  assert.equal((await p.bridge.connections())[0].connected, false)
  await p.connect()
  await p.bridge.bind("session", p.connectionId)
  assert.equal(p.bridge.binding("session", { allowLocked: true }).lock.state, "uncertain")
  await p.restart()
  assert.deepEqual(await p.bridge.connections(), [])
  assert.equal((await p.send("/connect", connect)).body.error.code, "incompatible_version")
  const fresh = (await p.bridge.connections())[0]
  assert.equal(fresh.project, null)
  assert.equal(fresh.capabilities, null)
  assert.equal(fresh.compatibility.panelVersion, "0.2.2")
  assert.equal(fresh.connected, false)
  await p.send("/unpair", {})
  assert.equal((await p.bridge.connections())[0].compatibility.panelVersion, null)
  assert.equal((await p.send("/compatibility", peer)).status, 401)
})

test("compatibility pairing mismatch is code-authenticated, session-scoped, volatile and expires without credentials", async t => {
  let clock = Date.now()
  const p = await panelFixture(t, { now: () => clock, pairingTtlMs: 1000 })
  const peer = { code: "invalid", panelId: "untrusted-panel", protocol: 2, version: "0.2.2" }
  const rejected = await request(p.port, "/pair", peer)
  assert.equal(rejected.body.error.code, "invalid_pairing_code")
  assert.deepEqual(rejected.body.error.details, {})
  assert.deepEqual(p.bridge.compatibility("other").pendingPanels, [])
  const before = await readFile(path.join(p.dataDir, "bridge-state.json"), "utf8")
  peer.code = p.bridge.pairingCode("other").code
  assert.equal((await request(p.port, "/pair", peer)).body.error.code, "incompatible_version")
  assert.equal(p.bridge.compatibility("other").pendingPanels[0].panelVersion, "0.2.2")
  assert.deepEqual(p.bridge.compatibility("session").pendingPanels, [])
  assert.equal((await p.bridge.connections()).length, 1)
  assert.equal(await readFile(path.join(p.dataDir, "bridge-state.json"), "utf8"), before)
  await p.bridge.release("other")
  assert.deepEqual(p.bridge.compatibility("other").pendingPanels, [])
  peer.code = p.bridge.pairingCode("other").code
  await request(p.port, "/pair", peer)
  clock += 1001
  assert.deepEqual(p.bridge.compatibility("other").pendingPanels, [])
  peer.code = p.bridge.pairingCode("other").code
  await request(p.port, "/pair", peer)
  const paired = await request(p.port, "/pair", { ...peer, protocol: 1, version: "0.2.2" })
  assert.equal(paired.status, 200)
  assert.equal(paired.body.compatibility.status, "compatible")
  assert.deepEqual(p.bridge.compatibility("other").pendingPanels, [])
})

test("panel services authenticate, derive own session, recheck binding, and await host RPC without queue deadlock", async t => {
  const p = await panelFixture(t)
  let entered, resume
  const started = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { resume = resolve })
  const scopes = []
  p.bridge.setPanelHandler(async ({ connectionId, sessionID, binding, body }) => {
    scopes.push({ connectionId, sessionID })
    assert.equal(binding.connectionId, connectionId)
    if (body.action === "diagnostics") { entered(); await gate; return {} }
    if (body.action === "checkpoint.restore.confirm") {
      await p.bridge.lock(sessionID, { kind: "restore" })
      const result = await p.bridge.call(sessionID, "save", {}, { allowLocked: true })
      await p.bridge.unlock(sessionID)
      return result
    }
    return { session: sessionID }
  })
  assert.throws(() => p.bridge.setPanelHandler(() => {}), { code: "handler_registered" })
  assert.equal((await request(p.port, "/panel", { action: "renders" })).status, 401)
  assert.equal((await p.send("/panel", { action: "raw" })).body.error.code, "invalid_payload")
  assert.equal((await p.send("/panel", { action: "renders", sessionID: "other" })).body.error.code, "invalid_payload")
  assert.equal((await p.send("/panel", { action: "checkpoint.pin", id: "x", pinned: "yes" })).body.error.code, "invalid_payload")
  const other = await request(p.port, "/pair", { code: p.bridge.pairingCode("other").code,
    panelId: "second", protocol: 1, version: "0.2.2" })
  const sendOther = (endpoint, body) => request(p.port, endpoint, body, { credential: other.body.credential })
  await sendOther("/connect", { panelId: "second", protocol: 1, version: "0.2.2",
    project: p.state.project, capabilities: p.state.capabilities, aeVersion: "26.0" })
  assert.equal((await sendOther("/panel", { action: "renders" })).body.error.code, "not_bound")
  await p.bridge.bind("other", other.body.connectionId)
  assert.equal((await sendOther("/panel", { action: "renders" })).body.result.session, "other")
  await p.start(async command => ({ project: p.state.project, method: command.method }))
  const reply = await p.send("/panel", { action: "checkpoint.restore.confirm", token: "adapter-owned-token" })
  assert.equal(reply.status, 200)
  assert.equal(reply.body.result.method, "save")
  const pending = p.send("/panel", { action: "diagnostics" })
  await started
  assert.equal((await p.send("/panel", { action: "renders" })).body.error.code, "panel_busy")
  await p.bridge.bind("session", p.connectionId)
  resume()
  assert.equal((await pending).body.error.code, "stale_binding")
  assert.deepEqual(scopes.map(s => s.sessionID), ["other", "session", "session"])
})

test("capture has exclusive 7 MiB JSON / 5 MiB binary reply budget, templates dispatch, and capture requires lock/capability", async t => {
  const p = await panelFixture(t)
  await assert.rejects(p.bridge.call("session", "capture", {}), { code: "lock_required" })
  p.state.capabilities.fileNetwork = false
  await p.heartbeat()
  await assert.rejects(p.bridge.call("session", "capture", {}), { code: "capability_missing" })
  p.state.capabilities.fileNetwork = true
  await p.heartbeat()
  await p.bridge.lock("session", { kind: "capture" })
  const payload = { mime: "image/png", width: 2000, height: 2000, data: Buffer.alloc(5 * 1024 * 1024).toString("base64") }
  const pending = p.bridge.call("session", "capture", {}, { allowLocked: true })
  await new Promise(resolve => setImmediate(resolve))
  const command = (await p.send("/poll")).body.command
  assert.equal((await p.send("/reply", { id: command.id, result: payload })).status, 200)
  assert.deepEqual(await pending, payload)
  await p.bridge.unlock("session")
  const templates = p.bridge.call("session", "templates", { compId: 1 })
  const next = (await p.send("/poll")).body.command
  assert.equal(next.method, "templates")
  // A capture-sized payload is not permitted for another method.
  try {
    assert.equal((await p.send("/reply", { id: next.id, result: payload })).status, 413)
  } catch (error) { assert.ok(["ECONNRESET", "EPIPE"].includes(error.code)) }
  await p.send("/reply", { id: next.id, result: { renderSettings: [], outputModules: [] } })
  assert.deepEqual(await templates, { renderSettings: [], outputModules: [] })
  await p.bridge.lock("session", { kind: "capture" })
  const invalid = assert.rejects(p.bridge.call("session", "capture", {}, { allowLocked: true }), { code: "outcome_uncertain" })
  await new Promise(resolve => setImmediate(resolve))
  const bad = (await p.send("/poll")).body.command
  await p.send("/reply", { id: bad.id, result: { ...payload, data: "not base64" } })
  await invalid
  assert.equal(p.bridge.binding("session", { allowLocked: true }).lock.state, "uncertain")
})

test("bind refuses project switch or connection replacement during asynchronous release", async t => {
  for (const reconnect of [false, true]) {
    const p = await panelFixture(t)
    const expectedProject = structuredClone(p.state.project)
    const owner = p.bridge.binding("session").id
    p.bridge.onRelease(async () => {
      if (reconnect) await p.connect()
      else {
        p.state.project = { ...p.state.project, id: "switched", path: path.join(p.dataDir, "other.aep") }
        await p.heartbeat()
      }
    })
    await assert.rejects(p.bridge.bind("new", p.connectionId, {
      takeover: true, expectedProject, expectedOwner: owner,
    }), { code: "stale_binding" })
    assert.throws(() => p.bridge.binding("new"), { code: "not_bound" })
  }
})

test("manual restore protocol validates scope proof phase replay and durable fallback transitions", async t => {
  const p = await panelFixture(t)
  p.state.revision = 1
  const original = structuredClone(p.state.project)
  const transaction = { id: randomUUID(), sessionID: "session", bindingID: p.bridge.binding("session").id }
  const prepare = { phase: "restore_prepare", transaction, recoveryId: randomUUID(), expected: structuredClone(p.state),
    path: path.join(p.dataDir, "workflow-emergency-" + randomUUID() + ".aep") }
  const reason = { kind: "restore", checkpointId: "source", planHash: hash("plan"), fingerprint: hash(p.state) }
  await p.bridge.lock("session", reason)
  for (const [params, code] of [
    [{ ...prepare, transaction: { ...transaction, sessionID: "foreign" } }, "stale_binding"],
    [{ ...prepare, transaction: { ...transaction, bindingID: "foreign" } }, "stale_binding"],
    [{ ...prepare, expected: { ...p.state, revision: 2 } }, "unsafe_state"],
    [{ ...prepare, expected: Object.fromEntries(Object.entries(p.state).filter(([key]) => key !== "activeCompId")) }, "invalid_payload"],
    [{ ...prepare, expected: { ...p.state, project: { ...original, id: "foreign" } } }, "invalid_payload"],
    [{ ...prepare, path: path.join(p.dataDir, "artist.aep") }, "invalid_path"],
    [{ ...prepare, extra: true }, "invalid_payload"],
    [{ ...prepare, phase: "restore_finish", verifiedCheckpoint: { id: "backup", hash: hash("bytes"), size: 1 } }, "unsafe_state"],
  ]) await assert.rejects(p.bridge.call("session", "execute", params, { allowLocked: true }), { code })
  assert.equal((await p.send("/poll")).body.command, null)
  await p.start(async command => {
    const durable = JSON.parse(await readFile(path.join(p.dataDir, "bridge-state.json"))).locks[0]
    assert.equal(durable.recoveryOriginal.path, original.path)
    assert.equal(durable.restore.phase, command.params.phase === "restore_prepare" ? "preparing" : "finishing")
    p.state.project = { id: "path:" + hash(command.params.path), path: command.params.path, saved: true }
    return { status: command.params.phase === "restore_prepare" ? "recovery_saved" : "recovered",
      project: p.state.project, snapshot: structuredClone(p.state) }
  })
  const saved = await p.bridge.call("session", "execute", prepare, { allowLocked: true })
  assert.equal(p.bridge.binding("session", { allowLocked: true }).project.path, prepare.path)
  await assert.rejects(p.bridge.call("session", "execute", prepare, { allowLocked: true }), { code: "invalid_payload" })
  await assert.rejects(p.bridge.call("session", "save", {}, { allowLocked: true }), { code: "restore_in_progress" })
  await assert.rejects(p.bridge.unlock("session"), { code: "recovery_target_mismatch" })
  const finish = { phase: "restore_finish", transaction, recoveryId: prepare.recoveryId,
    expected: saved.snapshot, path: path.join(p.dataDir, "workflow-recovery-" + randomUUID() + ".aep"),
    verifiedCheckpoint: { id: "backup", hash: hash("bytes"), size: 1 } }
  await assert.rejects(p.bridge.call("session", "execute", finish, { allowLocked: true }), { code: "unsafe_state" })
  await p.bridge.recordOutcome("session", { outcome: "dispatched", planHash: reason.planHash,
    checkpointId: "source", currentCheckpointId: "backup" })
  for (const [params, code] of [
    [{ ...finish, transaction: { ...transaction, id: randomUUID() } }, "unsafe_state"],
    [{ ...finish, recoveryId: "foreign" }, "unsafe_state"],
    [{ ...finish, expected: { ...saved.snapshot, revision: 2 } }, "unsafe_state"],
    [{ ...finish, verifiedCheckpoint: { ...finish.verifiedCheckpoint, id: "other" } }, "unsafe_state"],
    [{ ...finish, verifiedCheckpoint: { ...finish.verifiedCheckpoint, hash: "bad" } }, "invalid_payload"],
    [{ ...finish, path: path.join(p.dataDir, "artist.aep") }, "invalid_path"],
  ]) await assert.rejects(p.bridge.call("session", "execute", params, { allowLocked: true }), { code })
  const restored = await p.bridge.call("session", "execute", finish, { allowLocked: true })
  assert.equal(restored.project.path, finish.path)
  assert.equal(p.log.length, 2)
  await assert.rejects(p.bridge.call("session", "execute", { ...finish, expected: restored.snapshot }, { allowLocked: true }),
    { code: "unsafe_state" })
  assert.equal((await p.send("/reply", { id: p.log[1].id, result: restored })).body.error.code, "invalid_reply")
  await p.bridge.markUncertain("session", "Recovery copy requires review")
  await assert.rejects(p.bridge.unlock("session"), { code: "recovery_target_mismatch" })
  await p.stop()
  await p.restart()
  await p.connect()
  await p.bridge.bind("session", p.connectionId)
  const lock = p.bridge.binding("session", { allowLocked: true }).lock
  assert.equal(lock.recoveryOriginal.path, original.path)
  assert.equal(lock.restore.openPath, finish.path)
  assert.equal(lock.state, "uncertain")
})

test("manual restore rejects forged prepare replies without advancing durable state", async t => {
  for (const mode of ["path", "snapshot", "status"]) {
    const p = await panelFixture(t)
    p.state.revision = 1
    const original = structuredClone(p.state.project)
    const params = { phase: "restore_prepare", transaction: { id: randomUUID(), sessionID: "session",
      bindingID: p.bridge.binding("session").id }, recoveryId: randomUUID(), expected: structuredClone(p.state),
      path: path.join(p.dataDir, "workflow-emergency-" + randomUUID() + ".aep") }
    await p.bridge.lock("session", { kind: "restore", checkpointId: "source", planHash: hash("plan"), fingerprint: hash(p.state) })
    await p.start(async () => {
      const project = { id: "saved", path: mode === "path" ? original.path : params.path, saved: true }
      return { status: mode === "status" ? "recovered" : "recovery_saved", project,
        snapshot: { ...p.state, project, revision: mode === "snapshot" ? 3 : 1 } }
    })
    await assert.rejects(p.bridge.call("session", "execute", params, { allowLocked: true }), { code: "outcome_uncertain" })
    const lock = JSON.parse(await readFile(path.join(p.dataDir, "bridge-state.json"))).locks[0]
    assert.equal(lock.state, "uncertain")
    assert.deepEqual(lock.project, original)
    assert.equal(lock.restore.phase, "preparing")
    assert.equal(lock.restore.emergencyPath, params.path)
    assert.equal(p.log.length, 1)
  }
})

test("manual restore forged finish and foreign replies cannot confirm a path transition", async t => {
  for (const fault of ["path", "snapshot", "identity"]) {
    const p = await panelFixture(t)
    p.state.revision = 1
    const original = structuredClone(p.state.project)
    const transaction = { id: randomUUID(), sessionID: "session", bindingID: p.bridge.binding("session").id }
    const prepare = { phase: "restore_prepare", transaction, recoveryId: randomUUID(), expected: structuredClone(p.state),
      path: path.join(p.dataDir, "workflow-emergency-" + randomUUID() + ".aep") }
    const planHash = hash("plan")
    await p.bridge.lock("session", { kind: "restore", checkpointId: "source", planHash, fingerprint: hash(p.state) })
    await p.start(async command => {
      const project = command.params.phase === "restore_prepare"
        ? { id: "emergency", path: prepare.path, saved: true } : { ...original }
      if (command.params.phase === "restore_finish") {
        if (fault === "path") project.path = path.join(p.dataDir, "foreign.aep")
        if (fault === "identity") project.id = "foreign"
      } else p.state.project = project
      const snapshot = { ...p.state, project }
      if (command.params.phase === "restore_finish" && fault === "snapshot") delete snapshot.items
      return { status: command.params.phase === "restore_prepare" ? "recovery_saved" : "recovered", project, snapshot }
    })
    const saved = await p.bridge.call("session", "execute", prepare, { allowLocked: true })
    await p.stop()
    await p.bridge.recordOutcome("session", { outcome: "dispatched", checkpointId: "source",
      currentCheckpointId: "backup", planHash })
    const finish = { phase: "restore_finish", transaction, recoveryId: prepare.recoveryId,
      expected: saved.snapshot, path: original.path, verifiedCheckpoint: { id: "backup", hash: hash("bytes"), size: 1 } }
    const foreign = await request(p.port, "/pair", { code: p.bridge.pairingCode("foreign").code,
      panelId: "foreign-panel", protocol: 1, version: "0.2.2" })
    await request(p.port, "/connect", { panelId: "foreign-panel", protocol: 1, version: "0.2.2",
      project: original, capabilities: p.state.capabilities, aeVersion: "26.0" }, { credential: foreign.body.credential })
    const pending = p.bridge.call("session", "execute", finish, { allowLocked: true })
    const rejected = assert.rejects(pending, { code: "outcome_uncertain" })
    let command
    while (!command) command = (await p.send("/poll")).body.command
    assert.equal((await request(p.port, "/reply", { id: command.id, result: {} },
      { credential: foreign.body.credential })).body.error.code, "invalid_reply")
    const project = { ...original }
    if (fault === "path") project.path = path.join(p.dataDir, "foreign.aep")
    if (fault === "identity") project.id = "foreign"
    const snapshot = { ...p.state, project }
    if (fault === "snapshot") delete snapshot.items
    await p.send("/reply", { id: command.id, result: { status: "recovered", project, snapshot } })
    await rejected
    const lock = JSON.parse(await readFile(path.join(p.dataDir, "bridge-state.json"))).locks[0]
    assert.equal(lock.state, "uncertain")
    assert.equal(lock.restore.phase, "finishing")
    assert.equal(lock.project.path, prepare.path)
    assert.equal(lock.recoveryOriginal.path, original.path)
  }
})

test("manual restore reconnect during dispatched prepare preserves original and emergency locks", async t => {
  const p = await panelFixture(t)
  p.state.revision = 1
  const original = structuredClone(p.state.project)
  const prepare = { phase: "restore_prepare",
    transaction: { id: randomUUID(), sessionID: "session", bindingID: p.bridge.binding("session").id },
    recoveryId: randomUUID(), expected: structuredClone(p.state),
    path: path.join(p.dataDir, "workflow-emergency-" + randomUUID() + ".aep") }
  await p.bridge.lock("session", { kind: "restore", checkpointId: "source", planHash: hash("plan"), fingerprint: hash(p.state) })
  const pending = p.bridge.call("session", "execute", prepare, { allowLocked: true })
  const rejected = assert.rejects(pending, { code: "outcome_uncertain" })
  let command
  while (!command) command = (await p.send("/poll")).body.command
  await p.connect()
  await rejected
  await assert.rejects(p.bridge.call("session", "execute", prepare, { allowLocked: true }), { code: "binding_suspended" })
  assert.equal((await p.send("/reply", { id: command.id, result: {} })).body.error.code, "invalid_reply")
  p.state.project = { id: "emergency", path: prepare.path, saved: true }
  await p.connect()
  await p.bridge.bind("session", p.connectionId)
  const lock = p.bridge.binding("session", { allowLocked: true }).lock
  assert.equal(lock.state, "uncertain")
  assert.equal(lock.recoveryOriginal.path, original.path)
  assert.equal(lock.restore.emergencyPath, prepare.path)
  await assert.rejects(p.bridge.unlock("session"), { code: "recovery_target_mismatch" })
})

test("malformed stopped evidence cannot authorize recovery or clear the durable lock", async t => {
  const p = await panelFixture(t)
  await p.bridge.lock("session", { kind: "structured" })
  await p.start(async () => ({
    status: "stopped", results: [], failure: { code: "native_exception", message: "stopped", actionIndex: 8 },
    recovery: { id: "forged", snapshot: { ...p.state, revision: 1 } },
  }))
  await assert.rejects(p.bridge.call("session", "execute", { actions: [{ type: "layer.create" }] },
    { allowLocked: true }), { code: "outcome_uncertain" })
  const durable = JSON.parse(await readFile(path.join(p.dataDir, "bridge-state.json"), "utf8"))
  assert.equal(durable.locks[0].state, "uncertain")
  await assert.rejects(p.bridge.call("session", "execute", {
    phase: "recovery_prepare", transaction: { id: "x", sessionID: "session", bindingID: p.bridge.binding("session", { allowLocked: true }).id },
    recoveryId: "forged", expected: p.state, path: path.join(p.dataDir, "workflow-emergency-123.aep"),
  }, { allowLocked: true }), error => ["host_busy", "lock_required"].includes(error.code))
  assert.equal(p.log.length, 1)
})

test("long project identities and concurrent shutdown release descriptor and ownership", async t => {
  const p = await panelFixture(t)
  p.state.project.id = "path:" + "a".repeat(300)
  assert.equal((await p.heartbeat()).status, 200)
  await p.bridge.bind("session", p.connectionId)
  assert.equal(p.bridge.binding("session").project.id, p.state.project.id)
  await Promise.all([p.bridge.close(), p.bridge.close()])
  await assert.rejects(readFile(path.join(p.dataDir, "descriptor.json")), { code: "ENOENT" })
  await p.restart()
  assert.ok(p.port > 0)
})

test("native loopback authentication, schemas, pairing replay/expiry, rotation and secure storage", async t => {
  let clock = Date.now()
  const p = await panelFixture(t, { now: () => clock, pairingTtlMs: 100 })
  const descriptor = JSON.parse(await readFile(path.join(p.dataDir, "descriptor.json"), "utf8"))
  assert.deepEqual(Object.keys(descriptor).sort(), ["instanceId", "port", "protocol", "updateUrl", "version"])
  assert.equal((await request(p.port, "/poll")).status, 401)
  assert.equal((await p.send("/poll", undefined, { headers: { Origin: "http://evil.test" } })).status, 403)
  assert.equal((await p.send("/poll", undefined, { headers: { Host: "evil.test" } })).status, 403)
  assert.equal((await p.send("/heartbeat", {}, { headers: { "Content-Type": "text/plain" } })).status, 400)
  assert.equal((await p.send("/heartbeat", {}, { raw: "{" })).body.error.code, "invalid_payload")
  assert.equal((await p.send("/heartbeat", { project: p.state.project, capabilities: {}, busy: false })).status, 400)
  const code = p.bridge.pairingCode("other").code
  const pair = { code, protocol: 1, version: "0.2.2", panelId: "other-panel" }
  const mismatch = await request(p.port, "/pair", { ...pair, protocol: 2 })
  assert.equal(mismatch.body.error.code, "incompatible_version")
  assert.equal(mismatch.body.error.details.version, "0.2.2")
  assert.equal((await request(p.port, "/pair", pair)).status, 200)
  assert.equal((await request(p.port, "/pair", pair)).body.error.code, "invalid_pairing_code")
  pair.code = p.bridge.pairingCode("expiry").code
  clock += 101
  assert.equal((await request(p.port, "/pair", pair)).body.error.code, "invalid_pairing_code")
  let limited
  for (let i = 0; i < 10; i++) limited = await request(p.port, "/pair", pair)
  assert.equal(limited.status, 429)
  const before = p.credential
  const rotated = await p.send("/rotate", {})
  assert.equal(rotated.status, 200)
  assert.equal((await p.send("/poll")).status, 401)
  p.setCredential(rotated.body.credential)
  await p.connect()
  assert.throws(() => p.bridge.binding("session"), { code: "binding_suspended" })
  await p.bridge.bind("session", p.connectionId)
  const persisted = await readFile(path.join(p.dataDir, "bridge-state.json"), "utf8")
  assert.ok(!persisted.includes(before))
  assert.ok(!persisted.includes(p.credential))
  assert.match(JSON.parse(persisted).credentials[0].hash, /^[a-f0-9]{64}$/)
  if (process.platform === "win32") {
    const target = Buffer.from(p.dataDir).toString("base64")
    const script = `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${target}'));$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;foreach($f in @($p,(Join-Path $p 'descriptor.json'),(Join-Path $p 'bridge-state.json'))){$acl=if([IO.Directory]::Exists($f)){[IO.Directory]::GetAccessControl($f)}else{[IO.File]::GetAccessControl($f)};$rules=$acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]);foreach($r in $rules){if($r.IdentityReference.Value -ne $sid){throw 'Non-owner ACL entry'}}}`
    await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")])
  } else {
    assert.equal((await stat(p.dataDir)).mode & 0o777, 0o700)
    assert.equal((await stat(path.join(p.dataDir, "descriptor.json"))).mode & 0o777, 0o600)
  }
  await p.send("/unpair", {})
  assert.equal((await p.send("/poll")).status, 401)
})

test("discovery accepts validated active composition metadata and clears it across project and connection changes", async t => {
  const p = await panelFixture(t)
  const connect = activeCompId => p.send("/connect", { protocol: 1, version: "0.2.2", panelId: "test-panel",
    project: p.state.project, aeVersion: "26.0-test", capabilities: p.state.capabilities, activeCompId })
  const heartbeat = activeCompId => p.send("/heartbeat", {
    project: p.state.project, capabilities: p.state.capabilities, busy: false, activeCompId,
  })
  const connection = async () => (await p.bridge.connections())[0]
  assert.equal((await connect(7)).status, 200)
  assert.equal((await connection()).activeCompId, 7)
  for (const invalid of [0, -1, 1.5, "7", {}, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal((await heartbeat(invalid)).body.error.code, "invalid_payload")
    assert.equal((await connect(invalid)).body.error.code, "invalid_payload")
    assert.equal((await connection()).activeCompId, 7)
  }
  assert.equal((await heartbeat(null)).status, 200)
  assert.equal((await connection()).activeCompId, null)
  await heartbeat(8)
  await p.heartbeat()
  assert.equal((await connection()).activeCompId, 8)
  await p.bridge.bind("session", p.connectionId)
  p.state.project.path = path.join(p.dataDir, "save-as.aep")
  await p.heartbeat()
  assert.equal((await connection()).activeCompId, null)
  assert.equal((await connection()).binding.state, "suspended")
  await heartbeat(9)
  await p.send("/disconnect", {})
  assert.equal((await connection()).activeCompId, null)
  await p.connect()
  assert.equal((await connection()).connectionId, p.connectionId)
  assert.equal((await connection()).activeCompId, null)
  assert.throws(() => p.bridge.binding("session"), { code: "binding_suspended" })
})

test("saved-state changes suspend inspection bindings until explicit rebind, including a saved-state round trip", async t => {
  const p = await panelFixture(t)
  const original = p.bridge.binding("session")
  p.state.project.saved = false
  assert.equal((await p.heartbeat()).body.binding.state, "suspended")
  const suspended = p.bridge.binding("session", { allowSuspended: true, allowLocked: true })
  assert.equal(suspended.id, original.id)
  assert.equal(suspended.state, "suspended")
  assert.throws(() => p.bridge.binding("session", { allowSuspended: true, write: true }), { code: "binding_suspended" })
  p.state.project.saved = true
  await p.heartbeat()
  await assert.rejects(p.bridge.call("session", "inspect"), { code: "binding_suspended" })
  await assert.rejects(p.bridge.lock("session", "write"), { code: "binding_suspended" })
  await p.bridge.bind("session", p.connectionId)
  assert.notEqual(p.bridge.binding("session", { write: true }).id, original.id)
})

test("exclusive binding, takeover, heartbeat loss, project switch, Save As and unsaved writes", async t => {
  let clock = Date.now()
  const p = await panelFixture(t, { now: () => clock, heartbeatMs: 100 })
  await assert.rejects(p.bridge.bind("other", p.connectionId), { code: "binding_owned" })
  await p.bridge.bind("other", p.connectionId, { takeover: true })
  assert.throws(() => p.bridge.binding("session"), { code: "not_bound" })
  await p.bridge.release("other")
  await p.bridge.bind("session", p.connectionId)
  p.state.project.id = "project-2"
  assert.equal((await p.heartbeat()).body.binding.state, "suspended")
  await p.bridge.bind("session", p.connectionId)
  p.state.project.path = path.join(p.dataDir, "save-as.aep")
  await p.heartbeat()
  assert.throws(() => p.bridge.binding("session"), { code: "binding_suspended" })
  await p.bridge.bind("session", p.connectionId)
  clock += 101
  await p.bridge.connections()
  assert.throws(() => p.bridge.binding("session"), { code: "binding_suspended" })
  await p.connect()
  assert.throws(() => p.bridge.binding("session"), { code: "binding_suspended" })
  p.state.project = { id: "unsaved", path: null, saved: false }
  await p.heartbeat()
  await p.bridge.bind("session", p.connectionId)
  assert.equal(p.bridge.binding("session").project.saved, false)
  assert.throws(() => p.bridge.binding("session", { write: true }), { code: "unsaved_project" })
  await p.send("/disconnect", {})
  assert.throws(() => p.bridge.binding("session"), { code: "binding_suspended" })
  await p.connect()
  assert.throws(() => p.bridge.binding("session"), { code: "binding_suspended" })
})

test("one-shot command delivery/replies and uncertain locks survive release and listener restart", async t => {
  const p = await panelFixture(t)
  await assert.rejects(createBridge({ dataDir: p.dataDir }), { code: "bridge_in_use" })
  await p.bridge.lock("session", "transaction")
  const pending = p.bridge.call("session", "execute", { actions: [] }, { allowLocked: true, timeoutMs: 100 })
  const rejected = assert.rejects(pending, { code: "outcome_uncertain" })
  const { command } = (await p.send("/poll")).body
  assert.equal(command.method, "execute")
  assert.equal((await p.send("/poll")).body.command, null)
  await rejected
  assert.equal((await p.send("/reply", { id: command.id, result: {} })).body.error.code, "invalid_reply")
  await p.bridge.release("session")
  await p.bridge.bind("session", p.connectionId)
  assert.throws(() => p.bridge.binding("session"), { code: "target_locked" })
  await p.restart()
  await p.connect()
  assert.throws(() => p.bridge.binding("session"), { code: "not_bound" })
  await p.bridge.bind("session", p.connectionId)
  assert.equal(p.bridge.binding("session", { allowLocked: true }).lock.state, "uncertain")
  const inspect = p.bridge.call("session", "inspect", {}, { allowLocked: true })
  const next = (await p.send("/poll")).body.command
  assert.equal((await p.send("/reply", { id: next.id, result: { ok: true }, error: { code: "x", message: "x" } })).status, 400)
  assert.equal((await p.send("/reply", { id: next.id, result: { ok: true } })).status, 200)
  assert.deepEqual(await inspect, { ok: true })
  assert.equal((await p.send("/reply", { id: next.id, result: {} })).body.error.code, "invalid_reply")
  await p.bridge.unlock("session")
  assert.equal(p.bridge.binding("session").lock, null)
})
