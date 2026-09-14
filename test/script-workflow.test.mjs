import test from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { readFile } from "node:fs/promises"
import fs from "node:fs/promises"
import { createWorkflow } from "../src/workflow.mjs"
import { createCheckpoints, createGrants } from "../src/storage.mjs"
import { hash, PROPOSAL_TTL } from "../src/protocol.mjs"
import { panelFixture, simulatedHost, restoreFixture } from "./bridge-panel.mjs"

async function fixture(t, options = {}) {
  const p = await panelFixture(t, options.bridge)
  Object.assign(p.state, { revision: 1, projectEpoch: "project-instance-1", aeVersion: "26.0", fingerprint: "host-fingerprint", nextCursor: null })
  const checkpoints = createCheckpoints({ dataDir: p.dataDir })
  const events = []
  const create = checkpoints.create.bind(checkpoints)
  checkpoints.create = async input => { events.push("checkpoint"); return create(input) }
  const verify = checkpoints.verify.bind(checkpoints)
  checkpoints.verify = async id => { events.push("verify"); return verify(id) }
  let clock = Date.now()
  const workflow = createWorkflow({ bridge: p.bridge, checkpoints, grants: createGrants(), now: () => clock })
  const host = async command => {
    if (command.method === "raw") {
      assert.equal(command.params.expectedRevision, p.state.revision)
      assert.equal(command.params.expectedEpoch, p.state.projectEpoch)
      assert.deepEqual(command.params.expectedProject, { id: p.state.project.id, path: p.state.project.path })
      p.state.revision++
      p.state.items.push({ id: 1, name: command.params.label })
      return { value: { changed: true }, revision: p.state.revision, project: structuredClone(p.state.project) }
    }
    const result = await simulatedHost(command, p)
    if (command.method === "inspect" && command.params.query?.compId)
      Object.assign(result, { items: [{ id: command.params.query.compId }], fingerprint: "targeted-fingerprint", nextCursor: "page-2" })
    return result
  }
  await p.start(async command => {
    events.push(command.method)
    return options.handler ? options.handler(command, p, host) : host(command)
  })
  return { p, workflow, checkpoints, events, advance(ms) { clock += ms } }
}

const input = expectedRevision => ({ source: "return { changed: true };", label: "Script change", expectedRevision })

test("insufficient free space refuses a script before saving or changing the project", async t => {
  const f = await fixture(t)
  const before = await readFile(f.p.state.project.path)
  const inspected = await f.workflow.inspectQuery("session")
  t.mock.method(fs, "statfs", async () => ({ bsize: 4096n, bavail: 0n }))
  await assert.rejects(f.workflow.executeScript("session", input(inspected.expectedRevision), async () => {}), { code: "storage_space" })
  assert.equal(f.events.includes("save"), false)
  assert.equal(f.events.includes("raw"), false)
  assert.deepEqual(await readFile(f.p.state.project.path), before)
  assert.equal(f.p.bridge.binding("session").lock, null)
})

test("script protection survives uncertainty and does not erase an explicit user pin", async t => {
  for (const outcome of ["confirmed", "uncertain"]) await t.test(outcome, async t => {
    const f = await fixture(t, { handler: async (command, p, host) => {
      if (command.method === "raw" && outcome === "uncertain") throw new Error("Partial script failure")
      return host(command)
    } })
    const create = f.checkpoints.create
    let id
    f.checkpoints.create = async args => {
      const record = await create(args); id = record.id
      await assert.rejects(f.checkpoints.remove(id), { code: "checkpoint_in_use" })
      if (outcome === "confirmed") await f.checkpoints.pin(id, true)
      return record
    }
    const inspected = await f.workflow.inspectQuery("session")
    const running = f.workflow.executeScript("session", input(inspected.expectedRevision), async () => {})
    if (outcome === "uncertain") await assert.rejects(running, { code: "outcome_uncertain" })
    else await running
    const restarted = createCheckpoints({ dataDir: f.p.dataDir })
    const record = await restarted.verify(id)
    assert.equal(record.pinned, outcome === "confirmed")
    assert.equal(record.inUse, outcome === "uncertain")
    await assert.rejects(restarted.remove(id), { code: "checkpoint_in_use" })
  })
})

test("safe pre-dispatch expiry and explicit reconciliation release only script protection", async t => {
  for (const mode of ["expiry", "verification", "reconcile"]) await t.test(mode, async t => {
    const f = await fixture(t, { handler: async (command, p, host) => {
      if (mode === "reconcile" && command.method === "raw") throw new Error("Unknown partial outcome")
      return host(command)
    } })
    const create = f.checkpoints.create
    let id
    f.checkpoints.create = async args => {
      const record = await create(args); id = record.id
      if (mode === "expiry") f.advance(PROPOSAL_TTL + 1)
      else if (mode === "reconcile") { await f.checkpoints.pin(id, true); await f.checkpoints.protect(id, "other-owner", true) }
      return record
    }
    const verify = f.checkpoints.verify
    if (mode === "verification") f.checkpoints.verify = async () => ({ verified: false })
    const before = await f.workflow.inspectQuery("session")
    await assert.rejects(f.workflow.executeScript("session", input(before.expectedRevision), async () => {}))
    if (mode === "reconcile") {
      await assert.rejects(f.workflow.reconcile("session", async () => { throw new Error("Denied") }))
      assert.equal((await f.checkpoints.verify(id)).protectionOwners.length, 2)
      let reviews = 0
      await f.workflow.reconcile("session", async () => { reviews++ })
      assert.equal(reviews, 1)
    }
    f.checkpoints.verify = verify
    const record = await f.checkpoints.verify(id)
    assert.deepEqual(record.protectionOwners, mode === "reconcile" ? ["other-owner"] : [])
    assert.equal(record.pinned, mode === "reconcile")
    assert.equal(f.p.bridge.binding("session").lock, null)
  })
})

test("low disk space stops restore before saving dirty work or opening a project", async t => {
  const f = await restoreFixture(t)
  const checkpoints = createCheckpoints({ dataDir: f.p.dataDir })
  const workflow = createWorkflow({ bridge: f.p.bridge, checkpoints, grants: createGrants() })
  const inspected = await workflow.inspectRestore(f.sessionID)
  const saved = await checkpoints.create({ projectPath: inspected.project.path, projectId: inspected.project.id, planHash: "low-space-restore" })
  f.h.props[0].setValue(42)
  const before = await readFile(inspected.project.path)
  t.mock.method(fs, "statfs", async () => ({ bsize: 4096n, bavail: 0n }))
  await assert.rejects(workflow.restore(f.sessionID, saved.id, async () => {}), { code: "storage_space" })
  assert.equal(f.h.props[0].value, 42)
  assert.equal(f.h.project.dirty, true)
  assert.equal(f.h.closes, 0)
  assert.deepEqual(await readFile(inspected.project.path), before)
  assert.equal(f.commands.some(c => c.params.phase?.startsWith("restore_")), false)
  assert.equal(f.p.bridge.binding(f.sessionID).lock, null)
  await f.stop()
})

test("query inspection dispatches only the query and tokens are independent of target and page", async t => {
  const f = await fixture(t)
  const overview = await f.workflow.inspectQuery("session")
  const query = { compId: 1, layerId: 2, propertyPath: [{ index: 0, matchName: "ADBE Transform Group", name: "" }], depth: 8, cursor: "page-1" }
  const targeted = await f.workflow.inspectQuery("session", query)
  assert.deepEqual(f.p.log.map(c => c.params), [{ query: {} }, { query }])
  assert.match(overview.expectedRevision, /^[a-f0-9]{64}$/)
  assert.equal(targeted.expectedRevision, overview.expectedRevision)
  assert.notEqual(targeted.fingerprint, overview.fingerprint)
  assert.equal(targeted.nextCursor, "page-2")
  assert.equal(targeted.binding.id, f.p.bridge.binding("session").id)
  f.p.state.revision++
  assert.notEqual((await f.workflow.inspectQuery("session")).expectedRevision, overview.expectedRevision)
  f.p.state.revision = 1
  const reopened = await f.workflow.inspectQuery("session")
  assert.notEqual(reopened.expectedRevision, overview.expectedRevision, "observed reset must not resurrect a token")
  await f.p.bridge.bind("session", f.p.connectionId)
  assert.notEqual((await f.workflow.inspectQuery("session")).expectedRevision, reopened.expectedRevision)
})

test("query input validation rejects invalid combinations before dispatch", async t => {
  const f = await fixture(t)
  for (const query of [false, [], { unknown: true }, { compId: 0 }, { compId: 1.1 }, { compId: 2147483648 },
    { layerId: 2 }, { propertyPath: [] }, { compId: 1, propertyPath: [] }, { depth: -1 }, { depth: 9 },
    { depth: 0.5 }, { cursor: "" }, { cursor: 1 }, { cursor: "\u0000" },
    ...[{ index: -1, matchName: "x" }, { index: 0 }, { index: 0, matchName: "" },
      { index: 100001, matchName: "x" }, { index: 0, matchName: "\u0000" },
      { index: 0, matchName: "x", name: 1 }, { index: 0, matchName: "x", unknown: true }]
      .map(part => ({ compId: 1, layerId: 2, propertyPath: [part] }))]) {
    await assert.rejects(f.workflow.inspectQuery("session", query), { code: "invalid_payload" })
  }
  assert.equal(f.p.log.length, 0)
})

test("script exact approval precedes verified checkpoint and raw, then returns fresh overview and durable proof", async t => {
  const f = await fixture(t)
  const inspected = await f.workflow.inspectQuery("session", { compId: 1 })
  const payload = input(inspected.expectedRevision), source = payload.source
  let approvals = 0, evidence
  const record = f.p.bridge.recordOutcome.bind(f.p.bridge)
  f.p.bridge.recordOutcome = async (session, value) => { evidence = value; return record(session, value) }
  const result = await f.workflow.executeScript("session", payload, async (summary, metadata) => {
    approvals++
    f.events.push("approval")
    assert.ok(summary.endsWith(source))
    assert.match(summary, /UNSANDBOXED/)
    assert.match(summary, /external effects cannot be rolled back/)
    assert.equal(metadata.source, source)
    metadata.source = payload.source = "do not execute this"
    await assert.rejects(f.workflow.inspectQuery("session"), { code: "workflow_busy" })
  })
  assert.equal(approvals, 1)
  assert.deepEqual(result.result, { changed: true })
  assert.deepEqual(Object.keys(result).sort(), ["checkpointId", "expectedRevision", "overview", "result"])
  assert.deepEqual(result.overview.items, [{ id: 1, name: "Script change" }])
  assert.equal(result.overview.expectedRevision, result.expectedRevision)
  assert.notEqual(result.expectedRevision, inspected.expectedRevision)
  assert.equal(result.overview.binding.lock, null)
  assert.equal(evidence.outcome, "confirmed")
  const { fingerprint, nextCursor, ...data } = f.p.state
  assert.equal(evidence.expectedFingerprint, hash({ kind: "script-overview-v1",
    connectionId: f.p.connectionId, data, hasMore: nextCursor !== null }))
  const checkpoint = await f.checkpoints.verify(result.checkpointId)
  assert.equal(checkpoint.pinned, false, "successful scripts must not create permanent user pins")
  assert.equal(checkpoint.inUse, false, "confirmed execution releases temporary protection")
  assert.equal(JSON.parse(await readFile(checkpoint.path)).revision, 1)
  for (const [before, after] of [["approval", "save"], ["save", "checkpoint"], ["checkpoint", "verify"], ["verify", "raw"]])
    assert.ok(f.events.indexOf(before) < f.events.indexOf(after), `${before} before ${after}`)
  const raw = f.p.log.find(c => c.method === "raw")
  assert.deepEqual(raw.params, { source, label: "Script change", expectedRevision: 1, expectedEpoch: inspected.projectEpoch,
    expectedProject: { id: f.p.state.project.id, path: f.p.state.project.path } })
  const rawIndex = f.p.log.indexOf(raw)
  assert.ok(f.p.log.slice(0, rawIndex).filter(c => c.method === "inspect").every(c => Object.hasOwn(c.params, "query")))
  assert.deepEqual(f.p.log.slice(rawIndex + 1).map(c => c.params), [{ query: {} }])
  assert.equal(f.p.bridge.binding("session").lock, null)
})

test("script denial, stale approval, expiry and rebind perform no writes", async t => {
  for (const mode of ["denied", "missing", "stale", "expiry", "rebind"]) {
    const f = await fixture(t)
    const { expectedRevision } = await f.workflow.inspectQuery("session")
    const codes = { denied: "permission_denied", missing: "permission_required", stale: "stale_revision",
      expiry: "proposal_expired", rebind: "stale_binding" }
    const ask = mode === "missing" ? undefined : async () => {
      if (mode === "denied") return false
      if (mode === "stale") f.p.state.revision++
      if (mode === "expiry") f.advance(PROPOSAL_TTL)
      if (mode === "rebind") await f.p.bridge.bind("session", f.p.connectionId)
    }
    await assert.rejects(f.workflow.executeScript("session", input(expectedRevision), ask), { code: codes[mode] })
    assert.ok(f.p.log.every(c => c.method === "inspect"), mode)
    assert.equal(f.p.bridge.binding("session").lock, null)
  }
})

test("checkpoint verification failure prevents raw execution", async t => {
  const f = await fixture(t)
  const { expectedRevision } = await f.workflow.inspectQuery("session")
  f.checkpoints.verify = async () => ({ verified: false })
  await assert.rejects(f.workflow.executeScript("session", input(expectedRevision), async () => {}), error => {
    assert.equal(error.code, "checkpoint_invalid")
    assert.ok(error.details.checkpointId)
    return true
  })
  assert.ok(f.events.includes("save"))
  assert.ok(f.events.includes("checkpoint"))
  assert.equal(f.events.includes("raw"), false)
  assert.equal(f.p.bridge.binding("session").lock, null)
})

test("script body executes through production transport and host, and exposes queried properties afterward", async t => {
  const f = await restoreFixture(t)
  const checkpoints = createCheckpoints({ dataDir: f.p.dataDir })
  const w = createWorkflow({ bridge: f.p.bridge, checkpoints, grants: createGrants() })
  const before = await w.inspectQuery(f.sessionID, { compId: 1, layerId: 2, depth: 2 })
  assert.equal(before.propertyLayout, "preorder")
  assert.ok(before.items[0].layers[0].properties.some(p => p.matchName === "ADBE Opacity"))
  let approvals = 0
  const result = await w.executeScript(f.sessionID, {
    source: "app.project.item(1).layer(1).property('ADBE Transform Group').property(1).setValue(17); return { opacity: 17 };",
    label: "Opacity change", expectedRevision: before.expectedRevision,
  }, async () => { approvals++ })
  assert.equal(approvals, 1)
  assert.deepEqual(result.result, { opacity: 17 })
  assert.equal(f.h.props[0].value, 17)
  assert.equal(f.h.begins, 1)
  assert.equal(f.h.ends, 1)
  assert.equal(f.h.closes, 0)
  assert.equal(f.commands.filter(c => c.method === "raw").length, 1)
  assert.equal(result.overview.items[0].name, "Comp")
  assert.equal(Object.hasOwn(result.overview.items[0], "layers"), false)
  assert.equal(result.overview.nextCursor, null)
  const checkpoint = await checkpoints.verify(result.checkpointId)
  assert.equal(JSON.parse(await readFile(checkpoint.path)).props[0].value, 100)
  const after = await w.inspectQuery(f.sessionID, { compId: 1, layerId: 2,
    propertyPath: [{ index: 0, matchName: "ADBE Transform Group" }, { index: 1, matchName: "ADBE Opacity" }] })
  assert.equal(after.items[0].layers[0].properties[0].value, 17)
  assert.equal(after.expectedRevision, result.expectedRevision)
  assert.equal(f.p.bridge.binding(f.sessionID).lock, null)
  await f.stop()
})

test("native same-path same-revision replacement invalidates workflow approval and raw boundary guard", async t => {
  for (const boundary of ["before", "approval", "raw"]) {
    const f = await restoreFixture(t)
    const w = createWorkflow({ bridge: f.p.bridge, checkpoints: createCheckpoints({ dataDir: f.p.dataDir }), grants: createGrants() })
    const before = await w.inspectQuery(f.sessionID)
    const replace = () => { f.h.app.project = { ...f.h.project } }
    if (boundary === "before") replace()
    if (boundary === "raw") {
      const call = f.p.bridge.call.bind(f.p.bridge)
      f.p.bridge.call = async (session, method, params, options) => {
        if (method === "raw") replace()
        return call(session, method, params, options)
      }
    }
    await assert.rejects(w.executeScript(f.sessionID, input(before.expectedRevision), async () => {
      if (boundary === "approval") replace()
    }), error => {
      assert.equal(error.code, boundary === "raw" ? "outcome_uncertain" : "stale_revision")
      if (boundary === "raw") {
        assert.ok(error.details.checkpointId)
        assert.match(error.details.hostMessage, /project instance/)
      }
      return true
    })
    const after = await w.inspectQuery(f.sessionID)
    assert.deepEqual(after.project, before.project)
    assert.equal(after.revision, before.revision)
    assert.notEqual(after.projectEpoch, before.projectEpoch)
    assert.notEqual(after.expectedRevision, before.expectedRevision)
    assert.equal(f.h.begins, 0)
    assert.equal(f.commands.filter(c => c.method === "raw").length, boundary === "raw" ? 1 : 0)
    if (boundary === "raw") assert.equal(f.p.bridge.binding(f.sessionID, { allowLocked: true }).lock.state, "uncertain")
    await f.stop()
  }
})

test("large project script succeeds without full inspection and explicit reconciliation survives runtime restart", async t => {
  const f = await restoreFixture(t)
  const checkpoints = createCheckpoints({ dataDir: f.p.dataDir }), grants = createGrants()
  let w = createWorkflow({ bridge: f.p.bridge, checkpoints, grants })
  // The host's full property traversal exceeds its record budget; overview queries remain small.
  f.h.transform.children = Array.from({ length: 10001 }, () => f.h.props[0])
  assert.ok(f.h.call("inspect").error, "large full snapshot must fail")
  const before = await w.inspectQuery(f.sessionID)
  const result = await w.executeScript(f.sessionID, input(before.expectedRevision), async () => {})
  assert.deepEqual(result.result, { changed: true })
  assert.equal(f.p.bridge.binding(f.sessionID).lock, null)
  assert.ok(f.commands.filter(c => c.method === "inspect").every(c => c.params.query))

  // Simulate an unlock failure after durable confirmation, without rerunning the body.
  const unlock = f.p.bridge.unlock.bind(f.p.bridge)
  f.p.bridge.unlock = async () => { throw Object.assign(new Error("Unlock unavailable"), { code: "storage_failed" }) }
  await assert.rejects(w.executeScript(f.sessionID, input(result.expectedRevision), async () => {}), { code: "outcome_uncertain" })
  f.p.bridge.unlock = unlock
  const lock = f.p.bridge.binding(f.sessionID, { allowLocked: true }).lock
  assert.equal(lock.reason.proof, "script-overview-v1")
  assert.equal(lock.evidence.outcome, "confirmed")
  await f.stop()
  await f.p.bridge.release(f.sessionID)
  await f.p.restart()
  await f.client.connect()
  await f.p.bridge.bind(f.sessionID, f.connectionId)
  // Resume the original client against the restarted bridge.
  let stopped = false
  const pump = (async () => { while (!stopped) { await f.client.tick(); await new Promise(resolve => setTimeout(resolve, 5)) } })()
  t.after(async () => { stopped = true; await pump; f.client.stop() })
  w = createWorkflow({ bridge: f.p.bridge, checkpoints, grants })
  await assert.rejects(w.reconcile(f.sessionID), { code: "permission_required" })
  await assert.rejects(w.reconcile(f.sessionID, async () => false), { code: "permission_denied" })
  await assert.rejects(w.reconcile(f.sessionID, async () => {
    f.h.app.project = { ...f.h.app.project }
  }), { code: "stale_revision" })
  const recovered = await w.reconcile(f.sessionID, async (summary, metadata) => {
    assert.match(summary, /Bounded overview only/)
    assert.match(summary, /properties and later pages are omitted/)
    assert.equal(metadata.binding.lock.reason.proof, "script-overview-v1")
  })
  assert.equal(recovered.proof, "explicit_review")
  assert.equal(f.commands.filter(c => c.method === "raw").length, 2)
  assert.equal(f.p.bridge.binding(f.sessionID).lock, null)
  stopped = true
  await pump
  f.client.stop()
})

test("raw partial errors, timeouts, stale host checks and invalid results retain durable lock and checkpoint", async t => {
  for (const mode of ["partial", "timeout", "invalid", "oversize", "stale", "reinspect"]) {
    const f = await fixture(t, { handler: async (command, p, host) => {
      if (mode === "reinspect" && command.method === "inspect" && p.state.revision > 1)
        return { invalid: true }
      if (command.method !== "raw") return host(command)
      if (mode === "timeout") return undefined
      if (mode === "stale") throw Object.assign(new Error("Host preexecution stale check"), { code: "stale_revision" })
      const result = await host(command)
      if (mode === "partial") throw Object.assign(new Error("Failed after mutation"), { code: "script_failed" })
      if (mode === "invalid") return { value: 1 }
      if (mode === "oversize") result.value = "x".repeat(3 * 1024 * 1024 + 1)
      return result
    } })
    const { expectedRevision } = await f.workflow.inspectQuery("session")
    let failure
    await assert.rejects(f.workflow.executeScript("session", input(expectedRevision), async () => {}), error => {
      failure = error
      assert.equal(error.code, "outcome_uncertain", mode)
      assert.match(error.details.warning, /Partial changes/)
      assert.equal(error.details.rolledBack, false)
      return true
    })
    assert.equal((await f.checkpoints.verify(failure.details.checkpointId)).inUse, true)
    assert.equal(f.p.log.filter(c => c.method === "raw").length, 1)
    assert.equal(f.p.log.some(c => ["execute", "open"].includes(c.method)), false)
    assert.equal(f.p.bridge.binding("session", { allowLocked: true }).lock.state, "uncertain")
    const durable = JSON.parse(await readFile(path.join(f.p.dataDir, "bridge-state.json")))
    assert.equal(durable.locks[0].state, "uncertain")
    assert.equal(durable.locks[0].evidence.checkpointId, failure.details.checkpointId)
  }
})
