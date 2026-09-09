import test from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { readFile, stat } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { panelFixture, request } from "./bridge-panel.mjs"
import { createBridge } from "../src/bridge.mjs"

const exec = promisify(execFile)

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
    panelId: "second", protocol: 1, version: "0.1.0" })
  const sendOther = (endpoint, body) => request(p.port, endpoint, body, { credential: other.body.credential })
  await sendOther("/connect", { panelId: "second", protocol: 1, version: "0.1.0",
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
  const pair = { code, protocol: 1, version: "0.1.0", panelId: "other-panel" }
  const mismatch = await request(p.port, "/pair", { ...pair, protocol: 2 })
  assert.equal(mismatch.body.error.code, "incompatible_version")
  assert.equal(mismatch.body.error.details.version, "0.1.0")
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
  const connect = activeCompId => p.send("/connect", { protocol: 1, version: "0.1.0", panelId: "test-panel",
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
