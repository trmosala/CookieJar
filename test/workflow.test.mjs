import test from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { createHash } from "node:crypto"
import { readFile, writeFile, copyFile } from "node:fs/promises"
import { createWorkflow } from "../src/workflow.mjs"
import { createRuntime } from "../src/plugin.mjs"
import { createCheckpoints, createGrants } from "../src/storage.mjs"
import { hash, PROPOSAL_TTL } from "../src/protocol.mjs"
import { panelFixture, simulatedHost, restoreFixture } from "./bridge-panel.mjs"
import { hostDouble, manualRestoreBridge } from "./workflow-host.mjs"
import fs from "node:fs/promises"
import vm from "node:vm"
import { setTimeout as delay } from "node:timers/promises"
import transport from "../panel/transport.cjs"

async function fixture(t, options = {}) {
  const p = await panelFixture(t, options.bridge)
  let clock = Date.now()
  const manifests = new Map()
  const events = []
  const checkpoints = options.realStorage ? createCheckpoints({ dataDir: p.dataDir }) : {
    async create(input) {
      const id = `checkpoint-${manifests.size + 1}`
      const file = path.join(p.dataDir, id + ".aep")
      await copyFile(input.projectPath, file)
      const m = { ...input, id, path: file, size: (await fs.stat(file)).size, hash: createHash("sha256").update(await readFile(file)).digest("hex"), createdAt: new Date().toISOString(), verified: true }
      manifests.set(id, m)
      events.push("checkpoint")
      return structuredClone(m)
    },
    async verify(id) {
      const m = manifests.get(id)
      assert.ok(m)
      assert.equal(createHash("sha256").update(await readFile(m.path)).digest("hex"), m.hash)
      return structuredClone(m)
    },
    async pin(id, pinned) {
      events.push(pinned ? "pin" : "unpin")
      manifests.get(id).pinned = pinned
    },
    async protect(id, owner, active = true) {
      const m = manifests.get(id)
      const owners = new Set(m.protectionOwners || [])
      if (active) owners.add(owner)
      else owners.delete(owner)
      m.protectionOwners = [...owners]
      m.inUse = owners.size > 0
      return structuredClone(m)
    },
    async restore(id, { canonicalPath, beforeReplace }) {
      const m = await checkpoints.verify(id)
      await beforeReplace?.()
      await copyFile(m.path, canonicalPath)
      events.push("restore")
      return { path: canonicalPath, recoveryCopy: false }
    },
  }
  const grants = {
    async check(input) { events.push("grant"); return path.resolve(input.path) },
    async release() { events.push("release") },
  }
  const actual = options.actualHost ? hostDouble(p.state.project.path) : null
  if (actual) {
    Object.assign(p.state, actual.call("inspect").result)
    await p.heartbeat()
    await p.bridge.bind("session", p.connectionId)
  }
  const host = actual ? async command => {
    const reply = actual.call(command.method, command.params)
    const status = actual.call("status").result
    p.state.project = status.project
    if (reply.error) throw Object.assign(new Error(reply.error.message), { code: reply.error.code })
    return reply.result
  } : simulatedHost
  const workflow = createWorkflow({ bridge: p.bridge, checkpoints, grants, now: () => clock })
  await p.start(async command => {
    events.push(command.method)
    if (options.handler) return options.handler(command, p, host)
    return host(command, p)
  })
  return { p, workflow, checkpoints, grants, events, manifests, actual, advance(ms) { clock += ms } }
}

test("production manual restore traverses bridge transport host source and real storage for canonical and fallback", async t => {
  for (const fallback of [false, true]) {
    const f = await restoreFixture(t)
    const { p, h, client, sessionID } = f
    const checkpoints = createCheckpoints({ dataDir: p.dataDir })
    const canonical = h.project.file.fsName
    const checkpoint = await checkpoints.create({ projectPath: canonical,
      projectId: h.call("inspect").result.project.id, planHash: "production-source", pinned: true })
    const source = await readFile(checkpoint.path)
    h.props[0].setValue(73)
    h.project.save(h.project.file)
    const original = await readFile(canonical)
    assert.notDeepEqual(original, source)
    h.props[0].setValue(42)
    // Real plugin approval tokens and /panel handler; renderer is unrelated to restore.
    const nativeSave = h.project.save.bind(h.project)
    h.project.save = file => { nativeSave(file); h.project.revision++ }
    await createRuntime({ factories: { bridge: async () => p.bridge,
      renderer: async () => ({ list: async () => [], close: async () => {} }) } })
    const review = await transport.request(client.descriptor, f.store.state.credential, "/panel",
      { action: "checkpoint.restore.propose", id: checkpoint.id }, 300000)
    assert.match(review.result.operation, /Source:/)
    assert.equal(review.result.sourceTimestamp, Date.parse(checkpoint.createdAt))
    assert.equal(h.project.dirty, true)
    assert.equal(h.closes, 0)
    const rename = fs.rename.bind(fs)
    const fault = t.mock.method(fs, "rename", async (source, destination) => {
      if (fallback && source === canonical) throw Object.assign(new Error("canonical locked"), { code: "EACCES" })
      return rename(source, destination)
    })
    const response = await transport.request(client.descriptor, f.store.state.credential, "/panel",
      { action: "checkpoint.restore.confirm", token: review.result.token }, 300000)
    fault.mock.restore()
    const result = response.result
    assert.equal(result.recoveryCopy, fallback)
    assert.equal(result.canonicalReplaced, !fallback)
    assert.equal(h.project.file.fsName, result.path)
    assert.equal(h.props[0].value, 100)
    assert.equal(h.closes, 1)
    assert.deepEqual(await readFile(canonical), fallback ? original : source)
    const backup = await checkpoints.verify(result.currentCheckpointId)
    assert.equal(JSON.parse(await readFile(backup.path)).props[0].value, 42)
    assert.equal(backup.pinned, true)
    const phases = f.commands.filter(c => c.params.phase?.startsWith("restore_"))
    assert.deepEqual(phases.map(c => c.params.phase), ["restore_prepare", "restore_finish"])
    const lock = p.bridge.binding(sessionID, { allowLocked: true }).lock
    if (fallback) {
      assert.equal(lock.state, "uncertain")
      assert.equal(lock.recoveryOriginal.path, canonical)
      assert.equal(lock.restore.phase, "finished")
      assert.equal(lock.evidence.currentCheckpointId, backup.id)
      await assert.rejects(p.bridge.unlock(sessionID), { code: "recovery_target_mismatch" })
      await assert.rejects(checkpoints.pin(backup.id, false), { code: "checkpoint_in_use" })
      await f.stop()
      await p.bridge.release(sessionID)
      await p.restart()
      await client.connect()
      await p.bridge.bind(sessionID, f.connectionId)
      assert.equal(p.bridge.binding(sessionID, { allowLocked: true }).lock.recoveryOriginal.path, canonical)
      await assert.rejects(p.bridge.unlock(sessionID), { code: "recovery_target_mismatch" })
      // A second connection to the original cannot escape the persisted recovery lock.
      await p.connect()
      await p.bridge.bind("session", p.connectionId)
      await assert.rejects(p.bridge.lock("session", { kind: "other" }), { code: "target_locked" })
    } else {
      assert.equal(lock, null)
      assert.deepEqual(await readFile(result.originalPath), original)
      assert.equal(backup.inUse, false)
    }
    await f.stop()
  }
})

test("production manual restore preserves an edit at the host close boundary and retains verified backup", async t => {
  const f = await restoreFixture(t, { evalScript(code, cb, h) {
    if (code.includes("restore_finish")) h.props[0].setValue(19)
    cb(vm.runInContext(code, h.context))
  } })
  const { p, h, sessionID } = f
  const checkpoints = createCheckpoints({ dataDir: p.dataDir })
  const workflow = createWorkflow({ bridge: p.bridge, checkpoints, grants: createGrants() })
  const canonical = h.project.file.fsName
  const checkpoint = await checkpoints.create({ projectPath: canonical,
    projectId: h.call("inspect").result.project.id, planHash: "interleaved-source", pinned: true })
  h.props[0].setValue(42)
  let failure
  await assert.rejects(workflow.restore(sessionID, checkpoint.id, async () => {}), error => {
    failure = error
    assert.equal(error.code, "outcome_uncertain")
    return true
  })
  assert.equal(h.closes, 0)
  assert.equal(h.props[0].value, 19)
  assert.equal(h.project.dirty, true)
  const backup = await checkpoints.verify(failure.details.currentCheckpointId)
  assert.equal(backup.inUse, true)
  assert.equal(JSON.parse(await readFile(backup.path)).props[0].value, 42)
  assert.equal(p.bridge.binding(sessionID, { allowLocked: true }).lock.state, "uncertain")
  assert.equal(f.commands.filter(c => c.params.phase === "restore_finish").length, 1)
  await f.stop()
})

test("production manual restore late prepare and finish preserve locks backups and reject replay", async t => {
  for (const phase of ["restore_prepare", "restore_finish"]) {
    let late
    const f = await restoreFixture(t, { hostTimeout: 200, evalScript(code, cb, h) {
      if (code.includes(phase)) late = () => cb(vm.runInContext(code, h.context))
      else cb(vm.runInContext(code, h.context))
    } })
    const { p, h, sessionID } = f
    const checkpoints = createCheckpoints({ dataDir: p.dataDir })
    const workflow = createWorkflow({ bridge: p.bridge, checkpoints, grants: createGrants() })
    const canonical = h.project.file.fsName, before = await readFile(canonical)
    const checkpoint = await checkpoints.create({ projectPath: canonical,
      projectId: h.call("inspect").result.project.id, planHash: "late-source", pinned: true })
    h.props[0].setValue(42)
    let failure
    await assert.rejects(workflow.restore(sessionID, checkpoint.id, async () => {}), error => {
      failure = error
      assert.equal(error.code, "outcome_uncertain", JSON.stringify(error.details))
      return true
    })
    assert.equal(h.closes, 0)
    assert.equal(f.host.pending, true)
    assert.equal(f.store.state.uncertain, true)
    assert.equal(JSON.parse(await readFile(f.store.file)).uncertain, true)
    const durable = JSON.parse(await readFile(path.join(p.dataDir, "bridge-state.json")))
    const lock = durable.locks.find(l => l.connectionId === f.connectionId)
    assert.equal(lock.state, "uncertain")
    assert.equal(lock.recoveryOriginal.path, canonical)
    assert.ok(lock.restore.emergencyPath)
    assert.equal(lock.restore.phase, phase === "restore_prepare" ? "preparing" : "finishing")
    late()
    assert.equal(f.host.pending, false)
    assert.equal(f.host.uncertain, true)
    assert.equal(h.closes, phase === "restore_finish" ? 1 : 0)
    assert.deepEqual(await readFile(canonical), before)
    if (failure.details.currentCheckpointId) {
      const backup = await checkpoints.verify(failure.details.currentCheckpointId)
      assert.equal(backup.inUse, true)
      assert.equal(JSON.parse(await readFile(backup.path)).props[0].value, 42)
    } else assert.equal(JSON.parse(await readFile(lock.restore.emergencyPath)).props[0].value, 42)
    const command = f.commands.find(c => c.params.phase === phase)
    await assert.rejects(f.client.send("/reply", { id: command.id, result: {} }), { code: "invalid_reply" })
    assert.equal(f.commands.filter(c => c.params.phase === phase).length, 1)
    await assert.rejects(p.bridge.call(sessionID, "execute", command.params, { allowLocked: true }),
      error => ["host_busy", "lock_required", "binding_suspended"].includes(error.code))
    assert.equal(JSON.parse(await readFile(path.join(p.dataDir, "bridge-state.json"))).locks.find(l => l.id === lock.id).state, "uncertain")
    await f.stop()
  }
})

async function manualFixture(t, realStorage = false) {
  const f = await fixture(t, { actualHost: true, realStorage })
  const bridge = manualRestoreBridge(f.p.dataDir, f.actual)
  let clock = Date.now()
  const workflow = createWorkflow({ bridge, checkpoints: f.checkpoints, grants: f.grants, now: () => clock })
  const canonical = f.actual.project.file.fsName
  const checkpoint = await f.checkpoints.create({ projectPath: canonical,
    projectId: bridge.state.project.id, planHash: "manual-source", pinned: true })
  f.actual.props[0].setValue(42)
  return { ...f, bridge, workflow, checkpoint, canonical, advance(ms) { clock += ms } }
}

test("manual canonical restore saves dirty state and verifies current backup before replacing original", async t => {
  const f = await manualFixture(t, true)
  const before = await readFile(f.canonical)
  let permissions = 0
  const result = await f.workflow.restore("session", f.checkpoint.id, async (summary, metadata) => {
    permissions++
    assert.match(summary, /Source:/)
    assert.match(summary, /Destination file:/)
    assert.equal(metadata.sourceTimestamp, Date.parse(f.checkpoint.createdAt))
    assert.equal(metadata.fingerprint, hash(f.actual.call("inspect").result))
    metadata.checkpoint.hash = "tampered callback metadata"
  })
  assert.equal(permissions, 1)
  assert.equal(result.canonicalReplaced, true)
  assert.equal(result.recoveryCopy, false)
  assert.equal(result.path, f.canonical)
  assert.equal(f.actual.project.file.fsName, f.canonical)
  assert.equal(f.actual.props[0].value, 100)
  assert.deepEqual(await readFile(f.canonical), before)
  assert.deepEqual(await readFile(result.originalPath), before)
  const backup = await f.checkpoints.verify(result.currentCheckpointId)
  assert.equal(backup.pinned, true)
  assert.equal(JSON.parse(await readFile(backup.path)).props[0].value, 42)
  assert.equal(f.bridge.state.lock, null)
  assert.equal(f.actual.closes, 1)
  assert.deepEqual(f.bridge.events.filter(e => e.method === "execute").map(e => e.params.phase),
    ["restore_prepare", "restore_finish"])
})

test("manual restore accepts only the native Save As revision increment", async t => {
  for (const delta of [1, 2]) {
    const f = await manualFixture(t)
    const save = f.actual.project.save.bind(f.actual.project)
    f.actual.project.save = file => { save(file); f.actual.project.revision += delta }
    if (delta === 1) {
      const result = await f.workflow.restore("session", f.checkpoint.id, async () => {})
      assert.equal(result.canonicalReplaced, true)
      const backup = await f.checkpoints.verify(result.currentCheckpointId)
      assert.equal(JSON.parse(await readFile(backup.path)).props[0].value, 42)
    } else {
      await assert.rejects(f.workflow.restore("session", f.checkpoint.id, async () => {}), { code: "outcome_uncertain" })
      assert.equal(f.actual.closes, 0)
      assert.equal(f.bridge.state.lock.state, "uncertain")
    }
  }
})

test("manual canonical failure opens recovery copy with original unchanged and current backup protected", async t => {
  const f = await manualFixture(t, true)
  const before = await readFile(f.canonical)
  const rename = fs.rename.bind(fs)
  const mock = t.mock.method(fs, "rename", async (source, destination) => {
    if (source === f.canonical) throw Object.assign(new Error("locked original"), { code: "EACCES" })
    return rename(source, destination)
  })
  const result = await f.workflow.restore("session", f.checkpoint.id, async () => {})
  mock.mock.restore()
  assert.equal(result.recoveryCopy, true)
  assert.equal(result.canonicalReplaced, false)
  assert.equal(result.automationSuspended, true)
  assert.match(result.warning, /automation remains locked/)
  assert.deepEqual(await readFile(f.canonical), before)
  assert.notEqual(result.path, f.checkpoint.path)
  assert.equal(f.actual.project.file.fsName, result.path)
  assert.equal(f.actual.props[0].value, 100)
  const backup = await f.checkpoints.verify(result.currentCheckpointId)
  assert.equal(JSON.parse(await readFile(backup.path)).props[0].value, 42)
  await assert.rejects(f.checkpoints.pin(backup.id, false), { code: "checkpoint_in_use" })
  assert.equal(f.bridge.state.lock.state, "uncertain")
  assert.equal(f.bridge.state.lock.recoveryOriginal.path, f.canonical)
})

test("manual restore binds approval to exact source, time, destination, session and host snapshot", async t => {
  const f = await manualFixture(t)
  await assert.rejects(f.workflow.restore("other", f.checkpoint.id, async () => {}), { code: "not_bound" })
  await assert.rejects(f.workflow.restore("session", f.checkpoint.id), { code: "permission_required" })
  await assert.rejects(f.workflow.restore("session", f.checkpoint.id, async () => false), { code: "permission_denied" })
  const reviews = []
  for (let i = 0; i < 2; i++) {
    await assert.rejects(f.workflow.restore("session", f.checkpoint.id, async (operation, metadata) => {
      reviews.push({ operation, metadata })
      return false
    }), { code: "permission_denied" })
    f.advance(1000)
  }
  assert.deepEqual(reviews[0], reviews[1], "panel propose/confirm review must not depend on wall-clock time")
  for (const mode of ["expiry", "timestamp", "scope", "snapshot", "binding", "destination"]) {
    const manifest = structuredClone(f.manifests.get(f.checkpoint.id))
    const bindingID = f.bridge.state.id
    const before = await readFile(f.canonical)
    const codes = { expiry: "proposal_expired", timestamp: "checkpoint_changed", scope: "checkpoint_changed",
      snapshot: "stale_fingerprint", binding: "stale_binding", destination: "stale_project" }
    await assert.rejects(f.workflow.restore("session", f.checkpoint.id, async () => {
      if (mode === "expiry") f.advance(PROPOSAL_TTL)
      if (mode === "timestamp") f.manifests.get(f.checkpoint.id).createdAt = new Date(0).toISOString()
      if (mode === "scope") f.manifests.get(f.checkpoint.id).projectId = "different project"
      if (mode === "snapshot") f.actual.props[0].setValue(43)
      if (mode === "binding") f.bridge.state.id = "new-binding"
      if (mode === "destination") await writeFile(f.canonical, "external disk edit")
    }), { code: codes[mode] })
    assert.equal(f.actual.closes, 0)
    assert.equal(f.bridge.state.lock, null)
    assert.equal(f.manifests.size, 1)
    assert.equal(f.bridge.events.some(e => e.method === "execute"), false)
    if (mode === "destination") assert.equal(await readFile(f.canonical, "utf8"), "external disk edit")
    else assert.deepEqual(await readFile(f.canonical), before)
    f.manifests.set(f.checkpoint.id, manifest)
    f.bridge.state.id = bindingID
  }
})

test("manual restore preserves edits and uncertain late host outcomes without retry or unlocking", async t => {
  for (const mode of ["before_replace", "before_close", "lost_prepare", "late_finish", "uncertain_lock"]) {
    const f = await manualFixture(t)
    const call = f.bridge.call.bind(f.bridge)
    let late, failure
    if (mode === "before_replace" || mode === "uncertain_lock") {
      const restore = f.checkpoints.restore
      f.checkpoints.restore = async (...args) => {
        if (mode === "before_replace") f.actual.props[0].setValue(19)
        else f.bridge.state.lock.state = "uncertain"
        return restore(...args)
      }
    }
    f.bridge.call = async (session, method, params, options) => {
      if (params?.phase === "restore_finish" && mode === "before_close") f.actual.props[0].setValue(19)
      if (params?.phase === "restore_finish" && mode === "late_finish") {
        late = () => f.actual.call(method, params)
        throw Object.assign(new Error("reply timed out"), { code: "outcome_uncertain" })
      }
      const result = await call(session, method, params, options)
      if (params?.phase === "restore_prepare" && mode === "lost_prepare")
        throw Object.assign(new Error("save reply lost"), { code: "outcome_uncertain" })
      return result
    }
    await assert.rejects(f.workflow.restore("session", f.checkpoint.id, async () => {}), error => {
      failure = error
      assert.equal(error.code, mode === "before_replace" ? "stale_fingerprint" : "outcome_uncertain", mode)
      return true
    })
    assert.equal(f.actual.closes, 0, mode)
    assert.equal(f.bridge.state.lock.state, "uncertain", mode)
    if (mode.startsWith("before_")) {
      assert.equal(f.actual.props[0].value, 19)
      assert.equal(f.actual.project.dirty, true)
    }
    if (late) {
      assert.ok(late().result)
      assert.equal(f.actual.closes, 1)
      assert.equal(f.bridge.state.lock.state, "uncertain")
    }
    if (failure.details.currentCheckpointId) {
      const backup = await f.checkpoints.verify(failure.details.currentCheckpointId)
      assert.equal(backup.inUse, true)
      assert.equal(JSON.parse(await readFile(backup.path)).props[0].value, 42)
    } else assert.equal(JSON.parse(await readFile(failure.details.emergencyPath)).props[0].value, 42)
    assert.equal(f.bridge.events.filter(e => e.params.phase === "restore_prepare").length, 1)
    assert.ok(f.bridge.events.filter(e => e.params.phase === "restore_finish").length <= 1)
  }
})

test("raw mutation followed by non-JSON result keeps a durable uncertainty lock", async t => {
  const f = await fixture(t, { actualHost: true })
  await f.workflow.enableRaw("session", async () => {})
  const plan = await f.workflow.proposeRaw("session", {
    source: "app.project.item(1).layer(1).property('ADBE Transform Group').property(1).setValue(17); (function () {})",
    purpose: "Serialization regression", risks: ["Partial mutation"],
  })
  await assert.rejects(f.workflow.executeRaw("session", plan.hash, async () => {}), { code: "outcome_uncertain" })
  assert.equal(f.actual.props[0].value, 17)
  assert.equal(f.actual.call("status").result.uncertain, true)
  const durable = JSON.parse(await readFile(path.join(f.p.dataDir, "bridge-state.json"), "utf8"))
  assert.equal(durable.locks[0].state, "uncertain")
  assert.equal(f.p.log.filter(c => c.method === "raw").length, 1)
})

test("Node-side raw response budget failure keeps the post-execution lock", async t => {
  const f = await fixture(t, { handler: async (command, p, host) =>
    command.method === "raw" ? { value: "x".repeat(3 * 1024 * 1024 + 1) } : host(command, p) })
  await f.workflow.enableRaw("session", async () => {})
  const plan = await f.workflow.proposeRaw("session", { source: "1", purpose: "Response validation", risks: ["Raw execution"] })
  await assert.rejects(f.workflow.executeRaw("session", plan.hash, async () => {}), { code: "outcome_uncertain" })
  assert.equal(f.p.bridge.binding("session", { allowLocked: true }).lock.state, "uncertain")
  assert.equal(f.p.log.filter(c => c.method === "raw").length, 1)
})

test("actual panel host through workflow saves dirty state and executes multi-property keys, easing and expression in one pinned call", async t => {
  const f = await fixture(t, { actualHost: true })
  const h = f.actual, w = f.workflow
  h.props[0].setValue(75)
  assert.equal(h.project.dirty, true)
  const before = JSON.parse(JSON.stringify(h.call("inspect").result))
  const plan = await w.propose("session", h.actions())
  const result = await w.execute("session", plan.token, async () => {})
  assert.equal(result.results.length, 6)
  assert.equal(f.p.log.filter(c => c.params.phase === "chunk").length, 1)
  assert.equal(h.begins, 1)
  assert.equal(h.ends, 1)
  assert.deepEqual(h.props[0].keys[1].inEase, [{ speed: 5, influence: 60 }])
  assert.deepEqual(h.props[0].keys[1].interpolation, [2, 2])
  assert.equal(h.props[1].expression, "value + [10, 20]")
  assert.ok(h.project.revision > before.revision)
  const checkpoint = await f.checkpoints.verify(result.checkpointId)
  assert.equal(JSON.parse(await readFile(checkpoint.path, "utf8")).props[0].value, 75)
  const canonical = h.project.file.fsName
  const restored = await w.restore("session", checkpoint.id, async () => {})
  assert.equal(restored.canonicalReplaced, true)
  assert.equal(h.project.file.fsName, canonical)
  assert.equal(h.props[0].keys.length, 0)
  const backup = await f.checkpoints.verify(restored.currentCheckpointId)
  assert.equal(JSON.parse(await readFile(backup.path, "utf8")).props[0].keys.length, 2)
  assert.equal(JSON.parse(await readFile(canonical, "utf8")).props[0].keys.length, 0)
  assert.equal(f.p.bridge.binding("session").lock, null)
})

test("manual restore refuses an older bridge before saving dirty state", async t => {
  const f = await fixture(t, { actualHost: true })
  f.p.bridge.canonicalRestore = false
  const h = f.actual, canonical = h.project.file.fsName
  const original = await readFile(canonical)
  h.props[0].setValue(42)
  await assert.rejects(f.workflow.restore("session", "checkpoint", async () => {}), { code: "restore_unavailable" })
  assert.equal(h.project.file.fsName, canonical)
  assert.equal(h.project.dirty, true)
  assert.deepEqual(await readFile(canonical), original)
  assert.equal(f.manifests.size, 0)
  assert.equal(h.closes, 0)
  assert.equal(f.p.bridge.binding("session").lock, null)
})

test("ordinary native failure rolls back earlier action chunks with real checkpoint storage", async t => {
  const f = await fixture(t, { actualHost: true, realStorage: true })
  const h = f.actual, comp = h.project.item(1), layer = comp.layer(1)
  let name = comp.name
  Object.defineProperty(comp, "name", { configurable: true,
    get() { return name },
    set(value) { name = value; h.project.revision++; h.project.dirty = true },
  })
  Object.defineProperty(layer, "name", { configurable: true,
    get() { return "Layer" },
    set() { throw new Error("Native layer setter stopped") },
  })
  const before = h.call("inspect").result
  const proposal = await f.workflow.propose("session", [
    { type: "comp.update", compId: comp.id, changes: { name: "Partial scene" } },
    { type: "layer.update", compId: comp.id, layerId: layer.id, changes: { name: "Fails" } },
  ])
  await assert.rejects(f.workflow.execute("session", proposal.token, async () => {}), error => {
    assert.equal(error.code, "action_failed", JSON.stringify(error.details))
    assert.equal(error.details.rolledBack, true)
    assert.equal(error.details.actionIndex, 1)
    return true
  })
  assert.deepEqual(h.call("inspect").result, before)
  assert.equal(f.p.log.filter(c => c.method === "execute" && c.params.actions).length, 2)
  assert.equal(h.closes, 1)
  assert.equal(f.p.bridge.binding("session").lock, null)
})

test("stopped failure recovery traverses actual panel transport, host source and checkpoint storage", async t => {
  const p = await panelFixture(t, { timeoutMs: 10000 })
  const h = hostDouble(p.state.project.path)
  const store = { state: { panelId: "recovery-panel", credential: null, uncertain: false },
    save() {}, descriptor: () => JSON.parse(store.descriptorText) }
  store.descriptorText = await readFile(path.join(p.dataDir, "descriptor.json"), "utf8")
  const host = new transport.HostRPC({ evalScript(code, cb) { cb(vm.runInContext(code, h.context)) } }, 5000)
  const client = new transport.Client({ store, host })
  await client.pair(p.bridge.pairingCode("real-panel").code)
  await client.connect()
  const connection = (await p.bridge.connections()).find(c => c.panelId === "recovery-panel")
  await p.bridge.bind("real-panel", connection.id, { expectedProject: connection.project })
  const checkpoints = createCheckpoints({ dataDir: p.dataDir })
  const workflow = createWorkflow({ bridge: p.bridge, checkpoints, grants: createGrants() })
  let stopped = false
  const pump = (async () => { while (!stopped) { await client.tick(); await delay(2) } })()
  t.after(async () => { stopped = true; await pump; client.stop() })
  const before = h.call("inspect").result
  const actions = h.actions(); actions.at(-1).source = "bad("
  const proposal = await workflow.propose("real-panel", actions)
  await assert.rejects(workflow.execute("real-panel", proposal.token, async () => {}), error => {
    assert.equal(error.code, "action_failed", JSON.stringify(error.details))
    assert.equal(error.details.rolledBack, true)
    return true
  })
  assert.deepEqual(h.call("inspect").result, before)
  assert.equal(h.closes, 1)
  assert.equal(store.state.uncertain, false)
  assert.equal(p.bridge.binding("real-panel").lock, null)
})

test("actual host stopped failure rolls back the whole plan with real storage; manual interleaving refuses close", async t => {
  for (const interleave of [false, true]) {
    const f = await fixture(t, { actualHost: true, realStorage: true })
    const h = f.actual
    h.props[0].setValue(73)
    const before = h.call("inspect").result
    const actions = h.actions()
    const many = [...Array.from({ length: 130 }, () => actions[0]), ...actions.slice(1)]
    many.at(-1).source = "bad("
    const plan = await f.workflow.propose("session", many)
    const canonicalPath = h.project.file.fsName
    const call = f.p.bridge.call.bind(f.p.bridge)
    f.p.bridge.call = async (session, method, params, options) => {
      if (interleave && params?.phase === "recovery_finish") h.props[0].setValue(19)
      return call(session, method, params, options)
    }
    let failure
    await assert.rejects(f.workflow.execute("session", plan.token, async () => {}), error => {
      failure = error
      assert.equal(error.code, interleave ? "rollback_failed" : "action_failed", JSON.stringify(error.details))
      assert.equal(error.details.rolledBack, !interleave)
      return true
    })
    assert.equal(h.closes, interleave ? 0 : 1)
    assert.equal(JSON.parse(await readFile(canonicalPath, "utf8")).props[0].value, 73)
    assert.equal(JSON.parse(await readFile(canonicalPath, "utf8")).props[0].keys.length, 0)
    if (interleave) {
      assert.equal(h.props[0].value, 19)
      assert.equal(h.project.dirty, true)
      assert.equal((await f.p.bridge.connections())[0].lock.state, "uncertain")
    } else {
      assert.deepEqual(h.call("inspect").result, before)
      assert.equal(h.project.file.fsName, canonicalPath)
      assert.equal(f.p.bridge.binding("session").lock, null)
      const emergency = await f.checkpoints.verify(failure.details.currentCheckpointId)
      assert.equal(emergency.pinned, true)
      assert.equal(JSON.parse(await readFile(emergency.path, "utf8")).props[1].expression, "bad(")
      assert.equal(f.p.log.filter(c => c.params.phase === "chunk").length, 3)
    }
  }
})

test("recovery refuses canonical edits and never reports a wrong reopened scene as rolled back", async t => {
  for (const mode of ["canonical", "wrong_scene", "close_refused", "save_failed"]) {
    const f = await fixture(t, { actualHost: true })
    const h = f.actual, canonicalPath = h.project.file.fsName
    const actions = h.actions(); actions.at(-1).source = "bad("
    if (mode === "wrong_scene") {
      const open = h.app.open.bind(h.app)
      h.app.open = file => { const result = open(file); h.props[0].setValue(12); return result }
    }
    if (mode === "close_refused") h.project.close = () => false
    if (mode === "save_failed") {
      const save = h.project.save.bind(h.project)
      h.project.save = file => {
        if (file.fsName !== canonicalPath) throw new Error("Emergency save failed")
        return save(file)
      }
    }
    if (mode === "canonical") {
      const verify = f.checkpoints.verify
      f.checkpoints.verify = async id => {
        const result = await verify(id)
        if (f.p.log.some(c => c.params.phase === "recovery_prepare"))
          await writeFile(canonicalPath, "external canonical edit")
        return result
      }
    }
    const proposal = await f.workflow.propose("session", actions)
    await assert.rejects(f.workflow.execute("session", proposal.token, async () => {}), error => {
      assert.equal(error.code, "rollback_failed", mode)
      assert.equal(error.details.rolledBack, false)
      return true
    })
    assert.ok((await f.p.bridge.connections())[0].lock, mode)
    assert.equal(h.closes, mode === "wrong_scene" ? 1 : 0, mode)
    if (mode === "canonical") assert.equal(await readFile(canonicalPath, "utf8"), "external canonical edit")
    assert.ok([...f.manifests.values()].every(c => c.pinned), mode)
  }
})

test("actual host same-name sibling replacement retains lock and never replaces canonical bytes", async t => {
  for (const swap of [true]) {
    const f = await fixture(t, { actualHost: true })
    const h = f.actual, w = f.workflow
    let actions = h.actions()
    if (swap) {
      h.props[1].name = h.props[0].name
      h.props[1].matchName = h.props[0].matchName
      h.props[1].propertyValueType = h.props[0].propertyValueType
      h.props[1].value = 100
      actions = h.actions().filter(a => a.locator.path.at(-1).index === 1)
      const set = h.props[0].setValueAtTime.bind(h.props[0])
      h.props[0].setValueAtTime = (...args) => { set(...args); h.transform.children.reverse() }
    } else actions.at(-1).source = "bad("
    const canonical = h.project.file.fsName
    const plan = await w.propose("session", actions)
    await assert.rejects(w.execute("session", plan.token, async () => {}), { code: "outcome_uncertain" })
    assert.equal(h.project.dirty, true)
    assert.equal(h.call("status").result.uncertain, true)
    assert.equal(h.ends, 1)
    assert.equal(f.events.includes("open"), false)
    assert.equal(JSON.parse(await readFile(canonical, "utf8")).props[0].keys.length, 0)
    assert.ok([...f.manifests.values()][0].pinned)
  }
})

test("approval/save edits fail closed and 135 property actions execute with identity-pinned chunks", async t => {
  const f = await fixture(t, { actualHost: true })
  const h = f.actual, w = f.workflow
  let plan = await w.propose("session", h.actions())
  await assert.rejects(w.execute("session", plan.token, async () => { h.props[0].setValue(42) }), { code: "stale_fingerprint" })
  plan = await w.propose("session", h.actions())
  const save = h.project.save.bind(h.project)
  h.project.save = file => { save(file); h.project.revision++ }
  await assert.rejects(w.execute("session", plan.token, async () => {}), { code: "stale_fingerprint" })
  assert.equal(f.events.includes("execute"), false)
  h.project.save = save
  const actions = h.actions()
  plan = await w.propose("session", [...Array.from({ length: 130 }, () => actions[0]), ...actions.slice(1)])
  const result = await w.execute("session", plan.token, async () => {})
  assert.equal(result.results.length, 135)
  assert.deepEqual(f.p.log.filter(c => c.params.phase === "chunk").map(c => c.params.count), [64, 64, 7])
  assert.deepEqual(h.props[0].keys[1].inEase, [{ speed: 5, influence: 60 }])
  assert.equal(h.props[1].expression, "value + [10, 20]")
})

test("confirmed outcome evidence survives release/restart without a durable session identifier", async t => {
  const f = await fixture(t)
  const fingerprint = (await f.workflow.inspect("session")).fingerprint
  await f.p.bridge.lock("session", { kind: "structured", planHash: hash([]) })
  await f.p.bridge.recordOutcome("session", { outcome: "confirmed", planHash: hash([]), expectedFingerprint: fingerprint })
  await f.p.stop()
  await f.p.bridge.release("session")
  const stored = JSON.parse(await readFile(path.join(f.p.dataDir, "bridge-state.json"), "utf8"))
  assert.equal(Object.hasOwn(stored.locks[0], "sessionID"), false)
  assert.equal(stored.locks[0].evidence.expectedFingerprint, fingerprint)
  await f.p.restart()
  await f.p.connect()
  await f.p.bridge.bind("session", f.p.connectionId)
  await f.p.start(simulatedHost)
  const w = createWorkflow({ bridge: f.p.bridge, checkpoints: f.checkpoints, grants: f.grants })
  const result = await w.reconcile("session")
  assert.equal(result.proof, "confirmed_outcome")
  assert.equal(f.p.bridge.binding("session").lock, null)
})

test("workflow uses real checkpoint storage and grants through native HTTP", async t => {
  const p = await panelFixture(t)
  const checkpoints = createCheckpoints({ dataDir: p.dataDir })
  const w = createWorkflow({ bridge: p.bridge, checkpoints, grants: createGrants() })
  await p.start(simulatedHost)
  const before = structuredClone(p.state)
  const plan = await w.propose("session", [{ type: "layer.create", name: "Stored" }])
  const result = await w.execute("session", plan.token, async () => {})
  assert.equal((await checkpoints.verify(result.checkpointId)).verified, true)
  const canonicalPath = p.state.project.path
  await assert.rejects(w.restore("session", result.checkpointId, async () => false), { code: "permission_denied" })
  assert.equal(p.state.items.length, before.items.length + 1)
  assert.equal(p.state.project.path, canonicalPath)
  assert.equal(JSON.parse(await readFile(canonicalPath, "utf8")).items.length, 0)
  assert.equal(p.bridge.binding("session").lock, null)
})

test("immutable plans, one permission, verified checkpoint, bounded chunks and creation references", async t => {
  const f = await fixture(t)
  const { p, workflow: w } = f
  const input = [{ type: "comp.create", ref: "newComp", name: "Comp" },
    { type: "layer.create", compId: { $ref: "newComp" }, name: "Text", text: "Approved" }]
  const proposal = await w.propose("session", input)
  input[1].text = "tampered input"
  proposal.actions[1].text = "tampered output"
  let permissions = 0
  const result = await w.execute("session", proposal.token, async (summary, metadata) => {
    permissions++
    assert.match(summary, /Approved/)
    metadata.actions[1].text = "tampered permission metadata"
    await assert.rejects(w.execute("session", proposal.token, async () => {}), { code: "invalid_token" })
  })
  assert.equal(permissions, 1)
  assert.equal(result.results.length, 2)
  assert.equal(p.state.items[1].text, "Approved")
  assert.equal(p.state.items[1].compId, result.results[0].id)
  assert.equal(p.bridge.binding("session").lock, null)
  assert.ok(f.events.indexOf("save") < f.events.indexOf("checkpoint"))
  assert.ok(f.events.indexOf("checkpoint") < f.events.indexOf("execute"))
  assert.ok(p.log.filter(c => c.method === "execute").every(c => c.params.actions.length === 1))
  assert.equal(f.manifests.get(result.checkpointId).pinned, false)
  await assert.rejects(w.execute("session", proposal.token, async () => {}), { code: "invalid_token" })
  const inspection = await w.inspect("session")
  assert.equal(inspection.fingerprint, hash(p.state))
})

test("denial, expiry, session/hash mismatch and changes during approval do not mutate", async t => {
  const f = await fixture(t)
  const { p, workflow: w } = f
  let proposal = await w.propose("session", [{ type: "layer.create", text: "a" }])
  await assert.rejects(w.execute("other", proposal.token, async () => {}), { code: "invalid_token" })
  await assert.rejects(w.execute("session", "changed", async () => {}), { code: "invalid_token" })
  await assert.rejects(w.execute("session", proposal.token, async () => false), { code: "permission_denied" })
  await assert.rejects(w.execute("session", proposal.token, async () => {}), { code: "invalid_token" })
  proposal = await w.propose("session", [{ type: "layer.create" }])
  f.advance(PROPOSAL_TTL)
  await assert.rejects(w.execute("session", proposal.token, async () => {}), { code: "proposal_expired" })
  proposal = await w.propose("session", [{ type: "layer.create" }])
  await assert.rejects(w.execute("session", proposal.token, async () => {
    p.state.selection.push({ itemId: 123 })
  }), { code: "stale_fingerprint" })
  proposal = await w.propose("session", [{ type: "layer.create" }])
  await assert.rejects(w.execute("session", proposal.token, async () => {
    await p.bridge.bind("session", p.connectionId)
  }), { code: "stale_binding" })
  assert.equal(p.log.filter(c => c.method === "execute" || c.method === "save").length, 0)
})

test("generic failure without stopped evidence keeps partial state and never claims rollback", async t => {
  const f = await fixture(t)
  const { p, workflow: w } = f
  const before = structuredClone(p.state)
  const proposal = await w.propose("session", [{ type: "layer.create" }, { type: "fail" }])
  await assert.rejects(w.execute("session", proposal.token, async () => {}), error => {
    assert.equal(error.code, "outcome_uncertain")
    assert.equal(error.details.cause, "action_failed")
    assert.equal(error.details.actionIndex, 1)
    assert.equal(error.details.rolledBack, false)
    return true
  })
  assert.equal(p.state.items.length, before.items.length + 1)
  assert.deepEqual(JSON.parse(await readFile(before.project.path, "utf8")), before)
  assert.equal(f.events.includes("restore"), false)
  assert.ok((await p.bridge.connections())[0].lock)
})

test("stale state between chunks retains recovery lock; cleanup failure never rolls back success", async t => {
  let afterFirst = 0
  const f = await fixture(t, { handler: async (command, p, host) => {
    const result = await host(command, p)
    if (command.method === "inspect" && p.state.items.length === 1 && ++afterFirst === 1)
      p.state.selection.push({ itemId: 999 })
    return result
  } })
  const proposal = await f.workflow.propose("session", [{ type: "layer.create" }, { type: "layer.create" }])
  await assert.rejects(f.workflow.execute("session", proposal.token, async () => {}), error => {
    assert.equal(error.code, "outcome_uncertain")
    assert.equal(error.details.cause, "stale_fingerprint")
    return true
  })
  assert.ok((await f.p.bridge.connections())[0].lock)
  const g = await fixture(t)
  g.checkpoints.pin = async () => { throw new Error("cleanup failed") }
  const next = await g.workflow.propose("session", [{ type: "layer.create" }])
  const result = await g.workflow.execute("session", next.token, async () => {})
  assert.match(result.cleanup, /remains pinned/)
  assert.equal(g.p.state.items.length, 1)
  assert.equal(g.events.includes("open"), false)
})

test("timeouts never retry or rollback; recovery checkpoints remain pinned until reconciliation", async t => {
  const f = await fixture(t, { bridge: { timeoutMs: 150 }, handler: (command, p, host) =>
    command.method === "execute" ? undefined : host(command, p) })
  const proposal = await f.workflow.propose("session", [{ type: "layer.create" }])
  await assert.rejects(f.workflow.execute("session", proposal.token, async () => {}), { code: "outcome_uncertain" })
  assert.equal(f.p.log.filter(c => c.method === "execute").length, 1)
  assert.equal(f.events.includes("restore"), false)
  assert.equal([...f.manifests.values()][0].pinned, true)
  assert.throws(() => f.p.bridge.binding("session"), { code: "target_locked" })
  await assert.rejects(f.workflow.reconcile("session"), { code: "permission_required" })
  await assert.rejects(f.workflow.reconcile("session", async () => false), { code: "permission_denied" })
  await assert.rejects(f.workflow.reconcile("session", async () => { f.p.state.selection.push({ itemId: 42 }) }), { code: "stale_fingerprint" })
  assert.equal((await f.workflow.reconcile("session", async (summary, metadata) => {
    assert.match(summary, /Snapshot SHA-256/)
    assert.equal(metadata.fingerprint, hash(metadata.snapshot))
    metadata.snapshot.items.push({ id: 999 })
  })).reconciled, true)
  assert.equal(f.p.bridge.binding("session").lock, null)
})

test("host execution and result failures retain durable locks without retry or rollback", async t => {
  let failure
  const f = await fixture(t, { handler: async (command, p, host) => {
    const result = await host(command, p)
    if (command.method === failure?.method)
      throw Object.assign(new Error("Host may have changed the project"), { code: failure.code })
    return result
  } })
  const { p, workflow: w } = f
  for (const method of ["execute", "raw"]) {
    for (const code of ["execution_failed", "host_error", "invalid_host_result", "response_too_large"]) {
      failure = { method, code }
      let run
      if (method === "execute") {
        const plan = await w.propose("session", [{ type: "layer.create" }])
        run = () => w.execute("session", plan.token, async () => {})
      } else {
        await w.enableRaw("session", async () => {})
        const plan = await w.proposeRaw("session", { source: "1", purpose: "Failure test", risks: ["Partial execution"] })
        run = () => w.executeRaw("session", plan.hash, async () => {})
      }
      const count = p.log.filter(c => c.method === method).length
      await assert.rejects(run(), { code: "outcome_uncertain" })
      assert.equal(p.log.filter(c => c.method === method).length, count + 1)
      assert.equal(f.events.includes("restore"), false)
      assert.ok([...f.manifests.values()].every(m => m.pinned))
      assert.equal(p.bridge.binding("session", { allowLocked: true }).lock.state, "uncertain")
      const persisted = JSON.parse(await readFile(path.join(p.dataDir, "bridge-state.json"), "utf8"))
      assert.equal(persisted.locks[0].state, "uncertain")
      await assert.rejects(p.bridge.unlock("session"), { code: "host_busy" })
      // Simulate explicit local recovery before chat reconciliation.
      failure = null
      await p.heartbeat()
      await w.reconcile("session", async () => {})
    }
  }
})

test("raw source and risks are visible, session gated, single-use, expiring and nontransactional", async t => {
  const f = await fixture(t)
  const { p, workflow: w } = f
  const input = { source: "app.project.numItems", purpose: "Read count", risks: ["Arbitrary host code"] }
  await assert.rejects(w.proposeRaw("session", input), { code: "raw_disabled" })
  await w.enableRaw("session", async () => {})
  let proposal = await w.proposeRaw("session", input)
  assert.equal(proposal.source, input.source)
  assert.deepEqual(proposal.risks, input.risks)
  assert.equal(proposal.nonTransactional, true)
  await assert.rejects(w.executeRaw("session", "tampered", async () => {}), { code: "invalid_token" })
  await assert.rejects(w.executeRaw("session", proposal.hash, async () => false), { code: "permission_denied" })
  proposal = await w.proposeRaw("session", input)
  const approvedSource = input.source
  input.source = "changed"
  let permissions = 0
  const result = await w.executeRaw("session", proposal.hash, async summary => {
    permissions++
    assert.ok(summary.includes(approvedSource))
    assert.match(summary, /NON-TRANSACTIONAL/)
  })
  assert.equal(permissions, 1)
  assert.equal(result.value, approvedSource)
  assert.equal(f.events.includes("checkpoint"), false)
  f.advance(PROPOSAL_TTL)
  await assert.rejects(w.proposeRaw("session", input), { code: "raw_disabled" })
  await w.enableRaw("session", async () => {})
  proposal = await w.proposeRaw("session", input)
  await p.bridge.release("session")
  await p.bridge.bind("session", p.connectionId)
  await assert.rejects(w.proposeRaw("session", input), { code: "raw_disabled" })
  await assert.rejects(w.executeRaw("session", proposal.hash, async () => {}), { code: "invalid_token" })
})

test("raw timeout retains lock and import grants are rechecked after permission", async t => {
  const f = await fixture(t, { bridge: { timeoutMs: 150 }, handler: (command, p, host) =>
    command.method === "raw" ? undefined : host(command, p) })
  const asset = path.join(f.p.dataDir, "asset.png")
  await writeFile(asset, "test")
  const proposal = await f.workflow.propose("session", [{ type: "asset.import", path: asset }])
  const count = f.events.filter(e => e === "grant").length
  await assert.rejects(f.workflow.execute("session", proposal.token, async () => {
    f.grants.check = async () => { throw Object.assign(new Error("revoked"), { code: "grant_denied" }) }
  }), { code: "grant_denied" })
  assert.ok(count >= 2)
  assert.equal(f.events.includes("execute"), false)
  await f.workflow.enableRaw("session", async () => {})
  const raw = await f.workflow.proposeRaw("session", { source: "while(true){}", purpose: "Timeout test", risks: ["Blocks AE"] })
  await assert.rejects(f.workflow.executeRaw("session", raw.hash, async () => {}), { code: "outcome_uncertain" })
  assert.throws(() => f.p.bridge.binding("session"), { code: "target_locked" })
  assert.equal(f.p.log.filter(c => c.method === "raw").length, 1)
})

test("explicit restore rechecks approval and failed rollback remains locked", async t => {
  let refuseOpen = false
  const f = await fixture(t, { handler: (command, p, host) => {
    if (refuseOpen && command.method === "open") throw Object.assign(new Error("dirty"), { code: "unsafe_state" })
    return host(command, p)
  } })
  const proposal = await f.workflow.propose("session", [{ type: "layer.create" }])
  const executed = await f.workflow.execute("session", proposal.token, async () => {})
  await assert.rejects(f.workflow.restore("session", executed.checkpointId, async () => false), { code: "permission_denied" })
  assert.equal(f.p.state.items.length, 1)
  refuseOpen = true
  const next = await f.workflow.propose("session", [{ type: "layer.create" }, { type: "fail" }])
  await assert.rejects(f.workflow.execute("session", next.token, async () => {}), { code: "outcome_uncertain" })
  assert.throws(() => f.p.bridge.binding("session"), { code: "target_locked" })
})
