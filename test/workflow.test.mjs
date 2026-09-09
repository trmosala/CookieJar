import test from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { createHash } from "node:crypto"
import { readFile, writeFile, copyFile } from "node:fs/promises"
import { createWorkflow } from "../src/workflow.mjs"
import { createCheckpoints, createGrants } from "../src/storage.mjs"
import { hash, PROPOSAL_TTL } from "../src/protocol.mjs"
import { panelFixture, simulatedHost } from "./bridge-panel.mjs"
import { hostDouble } from "./workflow-host.mjs"
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
      const m = { ...input, id, path: file, hash: createHash("sha256").update(await readFile(file)).digest("hex"), createdAt: new Date().toISOString(), verified: true }
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
    async restore(id, { canonicalPath }) {
      const m = await checkpoints.verify(id)
      await copyFile(m.path, canonicalPath)
      events.push("restore")
      return { path: canonicalPath }
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
  assert.equal(restored.canonicalReplaced, false)
  assert.equal(h.project.file.fsName, restored.path)
  assert.equal(h.props[0].keys.length, 0)
  assert.equal(JSON.parse(await readFile(canonical, "utf8")).props[0].keys.length, 2)
  assert.equal(JSON.parse(await readFile(f.manifests.get(restored.currentCheckpointId).path, "utf8")).props[0].keys.length, 2)
  assert.ok((await f.p.bridge.connections())[0].lock)
})

test("actual host dirty-open guard prevents canonical replacement and preserves current-state checkpoint", async t => {
  const f = await fixture(t, { actualHost: true })
  const h = f.actual, w = f.workflow
  const plan = await w.propose("session", h.actions())
  const executed = await w.execute("session", plan.token, async () => {})
  const canonical = h.project.file.fsName
  const verify = f.checkpoints.verify
  f.checkpoints.verify = async id => {
    const result = await verify(id)
    if (f.manifests.size === 2 && id === executed.checkpointId) h.project.dirty = true
    return result
  }
  await assert.rejects(w.restore("session", executed.checkpointId, async () => {}), { code: "unsafe_state" })
  assert.equal(h.project.file.fsName, canonical)
  assert.equal(h.project.dirty, true)
  assert.equal(h.props[0].keys.length, 2)
  assert.equal(JSON.parse(await readFile(canonical, "utf8")).props[0].keys.length, 2)
  assert.equal(f.manifests.size, 2)
  assert.ok([...f.manifests.values()].every(c => c.pinned))
  assert.throws(() => f.p.bridge.binding("session"), { code: "target_locked" })
  assert.equal(f.events.includes("restore"), false)
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
  const restored = await w.restore("session", result.checkpointId, async () => {})
  assert.equal(restored.canonicalReplaced, false)
  assert.equal(restored.rebindRequired, true)
  assert.deepEqual(p.state.items, before.items)
  assert.equal(p.state.project.path, restored.path)
  assert.equal(JSON.parse(await readFile(canonicalPath, "utf8")).items.length, 1)
  assert.equal((await checkpoints.verify(restored.currentCheckpointId)).pinned, true)
  assert.ok((await p.bridge.connections())[0].lock)
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
  let permissions = 0
  const canonical = structuredClone(f.p.state.project)
  const restored = await f.workflow.restore("session", executed.checkpointId, async (summary, metadata) => {
    permissions++
    assert.match(summary, /Source:/)
    assert.match(summary, /Destination file:/)
    assert.equal(typeof metadata.sourceTimestamp, "number")
    assert.equal(typeof metadata.destinationTimestamp, "number")
  })
  assert.equal(permissions, 1)
  assert.equal(f.p.state.items.length, 0)
  assert.ok(f.manifests.get(restored.currentCheckpointId).pinned)
  // Explicitly return to the original project and review its durable lock.
  f.p.state.project = canonical
  await f.p.heartbeat()
  await f.workflow.reconcile("session", async () => {})
  refuseOpen = true
  const next = await f.workflow.propose("session", [{ type: "layer.create" }, { type: "fail" }])
  await assert.rejects(f.workflow.execute("session", next.token, async () => {}), { code: "outcome_uncertain" })
  assert.throws(() => f.p.bridge.binding("session"), { code: "target_locked" })
})
