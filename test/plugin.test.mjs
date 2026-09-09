import test from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import os from "node:os"
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { randomUUID } from "node:crypto"
import plugin, { createRuntime, createTools, server, checkPermissionConfig } from "../src/plugin.mjs"
import { createBridge } from "../src/bridge.mjs"
import { hash } from "../src/protocol.mjs"
import { AE_PERMISSIONS } from "../src/config.mjs"
import { panelFixture, simulatedHost } from "./bridge-panel.mjs"
import transport from "../panel/transport.cjs"

const exec = promisify(execFile)
const context = (ask = async () => {}, sessionID = "session") => ({ sessionID, ask, abort: new AbortController().signal })
const permissionConfig = { permission: "ask" }

async function fixture(t, options = {}) {
  let p, r, cleanup
  t.after(async () => {
    await p?.stop()
    try { await r?.close() } finally { await cleanup?.() }
  })
  p = await panelFixture({ after: callback => { cleanup = callback } })
  let clock = Date.now()
  r = await createRuntime({ factories: { bridge: async () => p.bridge,
    ...(options.renderer ? { renderer: async () => options.renderer } : {}) },
    permissionConfig: options.permissionConfig || permissionConfig, now: () => clock })
  p.state.items = [{ id: 1, kind: "comp", name: "Main", duration: 2, frameRate: 25 }]
  await writeFile(p.state.project.path, JSON.stringify(p.state))
  await p.start(async command => {
    if (options.handler) {
      const result = await options.handler(command, p)
      if (result !== undefined) return result
    }
    if (command.method === "templates") return { renderSettings: ["Best"], outputModules: ["PNG"] }
    if (command.method === "open") {
      Object.assign(p.state, JSON.parse(await readFile(command.params.path, "utf8")))
      p.state.project.path = command.params.path
      return { project: structuredClone(p.state.project) }
    }
    return simulatedHost(command, p)
  })
  return { p, r, tools: createTools(r), advance(ms) { clock += ms } }
}

test("object module export is import-safe and exposes all strict raw-shape tools", async () => {
  assert.equal(plugin.id, "cm-ae")
  assert.equal(plugin.server, server)
  const result = await exec(process.execPath, ["--input-type=module", "-e",
    "import net from 'node:net'; net.Server.prototype.listen=()=>{throw Error('listener at import')}; const m=await import('./src/plugin.mjs'); if(m.default.server!==m.server)throw Error('export');"])
  assert.equal(result.stderr, "")
  const tools = createTools({})
  const names = ["pair","connections","bind","release","inspect","propose","execute","grant","capture","raw_enable","raw_propose",
    "raw_execute","checkpoints","restore","render_submit","render_status","render_cancel","render_result","render_recover","render_list","diagnostics","reconcile"]
  for (const name of names) {
    const tool = tools["ae_" + name]
    assert.equal(typeof tool.execute, "function")
    assert.equal(typeof tool.args, "object")
    await assert.rejects(tool.execute({ sessionID: "forged", executable: "evil", templates: [] }, context()), { name: "ZodError" })
  }
})

test("permission policy fails closed on global, wildcard, pattern and agent auto-allow", () => {
  for (const config of [
    { permission: "allow" }, { permission: { "*": "allow", ae_execute: "ask" } },
    { permission: { "ae_?xecute": "allow" } }, { permission: { ae_execute: { "*": "ask", "specific*": "allow" } } },
    { permission: "ask", agent: { build: { permission: { "ae_*": "allow" } } } },
    { permission: "ask", mode: { legacy: { permission: "allow" } } },
  ]) assert.throws(() => checkPermissionConfig(config, null, { configure: true }), { code: "unsafe_permission_config" })
  checkPermissionConfig({ permission: { read: "allow", ae_execute: "ask" } }, "ae_execute")
  assert.throws(() => checkPermissionConfig(undefined, "ae_execute"), { code: "permission_policy_required" })
  assert.throws(() => checkPermissionConfig({}, "ae_raw_enable"), { code: "permission_denied" })
  checkPermissionConfig({ permission: { ae_raw_enable: "ask" } }, "ae_raw_enable")
})

test("real workflow adapters enforce one-time asks, context session, abort and stale binding/grant checks", async t => {
  const { p, r, tools } = await fixture(t)
  const propose = () => tools.ae_propose.execute({ actions: [{ type: "layer.create", name: "Reviewed" }] }, context()).then(JSON.parse)
  let plan = await propose()
  await assert.rejects(tools.ae_execute.execute({ token: plan.token }, { sessionID: "session" }), { code: "permission_required" })
  plan = await propose()
  const controller = new AbortController()
  await assert.rejects(tools.ae_execute.execute({ token: plan.token }, {
    ...context(async request => {
      assert.equal(request.permission, "ae_execute"); assert.deepEqual(request.always, [])
      assert.match(request.patterns[0], /Reviewed/); controller.abort()
    }), abort: controller.signal,
  }), { code: "aborted" })
  assert.equal(p.log.some(command => command.method === "execute"), false)
  plan = await propose()
  await assert.rejects(tools.ae_execute.execute({ token: plan.token }, context(async () => {
    await p.bridge.bind("session", p.connectionId)
  })), error => ["aborted", "stale_binding", "invalid_token"].includes(error.code))
  plan = await propose()
  const result = JSON.parse(await tools.ae_execute.execute({ token: plan.token }, context()))
  assert.equal(result.results.length, 1)
  assert.ok((await r.checkpoints.verify(result.checkpointId)).verified)
  await assert.rejects(tools.ae_execute.execute({ token: plan.token }, context()), { code: "invalid_token" })
  await assert.rejects(tools.ae_grant.execute({ path: p.dataDir, write: true, recursive: true }, context(async () => {
    p.state.selection.push({ itemId: 1 })
  })), { code: "stale_fingerprint" })
  const b = p.bridge.binding("session")
  await assert.rejects(r.grants.check({ sessionID: "session", bindingID: b.id, path: path.join(p.dataDir, "out.png"), write: true }), { code: "path_denied" })
  await tools.ae_grant.execute({ path: p.dataDir, write: true, recursive: true }, context(request => {
    assert.equal(request.metadata.binding.id, b.id)
  }))
  assert.equal(await r.grants.check({ sessionID: "session", bindingID: b.id, path: path.join(p.dataDir, "out.png"), write: true }), path.join(p.dataDir, "out.png"))
  await tools.ae_release.execute({}, context())
  assert.equal(r.diagnostics.export({ sessionID: "session" }).events.length, 0)
  await tools.ae_bind.execute({ connectionId: p.connectionId }, context())
  assert.notEqual(p.bridge.binding("session").id, b.id)
  await assert.rejects(r.grants.check({ sessionID: "session", bindingID: b.id, path: path.join(p.dataDir, "out.png"), write: true }), { code: "binding_expired" })
})

test("runtime registers authenticated panel services; scope, token expiry/replay/drift and restore use real storage", async t => {
  const { p, r, tools, advance } = await fixture(t)
  const checkpoint = await r.checkpoints.create({ projectPath: p.state.project.path, projectId: p.state.project.id, planHash: hash("test") })
  const foreign = await r.checkpoints.create({ projectPath: p.state.project.path, projectId: "other-project", planHash: hash("other") })
  const descriptor = JSON.parse(await readFile(path.join(p.dataDir, "descriptor.json"), "utf8"))
  const client = new transport.Client({ store: { state: { credential: p.credential }, save() {}, descriptor: () => descriptor }, host: {} })
  client.descriptor = descriptor
  Object.assign(client.state, { connection: "connected", project: structuredClone(p.state.project), binding: p.bridge.binding("session") })
  const list = await client.panel("checkpoints", {})
  assert.equal(list.length, 1); assert.equal(list[0].id, checkpoint.id)
  assert.equal(typeof list[0].createdAt, "number")
  await assert.rejects(tools.ae_checkpoints.execute({ action: "pin", id: foreign.id, pinned: true }, context()), { code: "checkpoint_scope" })
  const injected = await p.send("/panel", { action: "diagnostics", sessionID: "other" })
  assert.notEqual(injected.status, 200)
  await client.panel("checkpoint.pin", { id: checkpoint.id, pinned: true })
  assert.equal((await r.checkpoints.verify(checkpoint.id)).pinned, true)
  const exported = await client.panel("diagnostics", {})
  assert.ok(!JSON.stringify(exported).includes(p.state.project.path))
  assert.equal(exported.storage.checkpointCount, 1)
  assert.equal(exported.storage.pinnedCount, 1)
  assert.equal(JSON.parse(await tools.ae_diagnostics.execute({}, context())).storage.checkpointCount, 1)
  let proposed = await p.send("/panel", { action: "checkpoint.restore.propose", id: checkpoint.id })
  assert.equal(proposed.status, 200)
  assert.match(proposed.body.result.operation, /save.*checkpoint.*current state/i)
  assert.match(proposed.body.result.operation, /recovery copy/i)
  assert.equal(p.log.some(command => ["save", "open"].includes(command.method)), false)
  advance(300001)
  assert.equal((await p.send("/panel", { action: "checkpoint.restore.confirm", token: proposed.body.result.token })).body.error.code, "invalid_token")
  proposed = await p.send("/panel", { action: "checkpoint.restore.propose", id: checkpoint.id })
  p.state.selection.push({ itemId: 1 })
  assert.equal((await p.send("/panel", { action: "checkpoint.restore.confirm", token: proposed.body.result.token })).body.error.code, "stale_fingerprint")
  assert.equal((await p.send("/panel", { action: "checkpoint.restore.confirm", token: proposed.body.result.token })).body.error.code, "invalid_token")
  proposed = await p.send("/panel", { action: "checkpoint.restore.propose", id: checkpoint.id })
  r.tokens.get("session").operation += " Unreviewed change."
  assert.equal((await p.send("/panel", { action: "checkpoint.restore.confirm", token: proposed.body.result.token })).body.error.code, "stale_fingerprint")
  assert.equal(p.log.some(command => ["save", "open"].includes(command.method)), false)
  await client.panel("checkpoint.restore.propose", { id: checkpoint.id })
  const canonicalPath = p.state.project.path
  const restored = await client.confirmRestore()
  assert.equal(restored.recoveryCopy, true)
  assert.equal(restored.canonicalReplaced, false)
  assert.notEqual(restored.path, canonicalPath)
  assert.ok(restored.currentCheckpointId)
  assert.equal((await r.checkpoints.verify(restored.currentCheckpointId)).verified, true)
  assert.equal(r.tokens.size, 0)
  assert.equal(p.log.filter(command => command.method === "open").length, 1)
})

test("render adapter derives live comp/templates, rejects untrusted submit fields, and scopes recovered access", async t => {
  const { p, r, tools } = await fixture(t)
  const a = { compId: 1, startFrame: 0, endFrame: 49, renderSettings: "Best", outputModule: "PNG", outputPath: path.join(p.dataDir, "out_[#####].png") }
  for (const extra of [{ compName: "Injected" }, { templates: { renderSettings: ["Best"] } }, { checkpointId: "old" }, { aerenderPath: "evil" }])
    await assert.rejects(tools.ae_render_submit.execute({ ...a, ...extra }, context()), { name: "ZodError" })
  await tools.ae_grant.execute({ path: a.outputPath, write: true }, context())
  await assert.rejects(tools.ae_render_submit.execute(a, context()), { code: "path_denied" })
  assert.equal(p.log.some(command => command.method === "save"), false)
  await tools.ae_grant.execute({ path: p.dataDir, write: true, recursive: true }, context())
  let submitted
  const jobId = randomUUID()
  const renderer = {
    async submit(input) {
      submitted = input
      assert.equal(p.bridge.binding("session").lock, null)
      const record = await r.checkpoints.verify(input.checkpointId)
      const saved = JSON.parse(await readFile(record.path, "utf8"))
      assert.equal(saved.items[0].id, input.compId)
      return { jobId, sourceCheckpoint: record, state: "running" }
    },
    async status(requested) { return { jobId: requested, sourceCheckpoint: await r.checkpoints.verify(submitted.checkpointId), state: "running" } },
    async cancel() { throw Object.assign(new Error("identity mismatch"), { code: "render_process_identity" }) },
  }
  const renderTools = createTools({ ...r, renderer })
  await assert.rejects(renderTools.ae_render_submit.execute({ ...a, endFrame: 50 }, context()), { code: "render_range" })
  p.state.items.push({ ...p.state.items[0], id: 2 })
  await assert.rejects(renderTools.ae_render_submit.execute(a, context()), { code: "render_comp" })
  p.state.items.pop()
  const output = JSON.parse(await renderTools.ae_render_submit.execute(a, context()))
  assert.equal(output.jobId, jobId)
  assert.equal(submitted.compName, "Main")
  assert.deepEqual(submitted.templates, { renderSettings: ["Best"], outputModules: ["PNG"] })
  assert.equal(submitted.sessionID, "session")
  assert.equal((await r.checkpoints.verify(submitted.checkpointId)).pinned, false)
  assert.deepEqual(r.jobScopes.get(jobId), { projectId: p.state.project.id, projectPath: p.state.project.path })
  const status = renderer.status
  renderer.status = async () => ({ jobId, state: "unknown", reason: "corrupt_manifest" })
  const corrupt = JSON.parse(await renderTools.ae_render_status.execute({ jobId }, context(() => assert.fail("owned review"))))
  assert.equal(corrupt.metadataOnly, true)
  assert.equal(corrupt.verified, false)
  assert.equal(corrupt.reason, "corrupt_manifest")
  await assert.rejects(renderTools.ae_render_cancel.execute({ jobId }, context(() => assert.fail("corrupt cancellation"))),
    { code: "render_process_identity" })
  renderer.status = status
  r.jobs.set(jobId, { sessionID: "other", bindingID: "other" })
  await assert.rejects(renderTools.ae_render_status.execute({ jobId }, context()), { code: "render_scope" })
  r.jobs.delete(jobId); r.recovered.add(jobId)
  await assert.rejects(renderTools.ae_render_status.execute({ jobId }, context(async () => false)), { code: "permission_denied" })
  const recovered = JSON.parse(await renderTools.ae_render_status.execute({ jobId }, context(request => {
    assert.equal(request.permission, "ae_render_recover")
    assert.deepEqual(request.always, [])
  })))
  assert.equal(recovered.jobId, jobId)
  await assert.rejects(renderTools.ae_render_cancel.execute({ jobId }, context()), { code: "render_process_identity" })
})

test("detached renders remain discoverable only in their project and require one recovery claim under shipped read policies", async t => {
  const { p, r } = await fixture(t, { permissionConfig: { permission: AE_PERMISSIONS } })
  const sourceCheckpoint = { projectId: p.state.project.id, projectPath: p.state.project.path }
  const jobs = [
    { jobId: "detached", state: "running", sourceCheckpoint, outputPath: "PRIVATE OUTPUT" },
    { jobId: "foreign-id", sourceCheckpoint: { ...sourceCheckpoint, projectId: "foreign" } },
    { jobId: "foreign-path", sourceCheckpoint: { ...sourceCheckpoint, projectPath: path.join(p.dataDir, "foreign.aep") } },
    { jobId: "another-owner", sourceCheckpoint },
  ]
  const calls = []
  const tools = createTools({ ...r, renderer: {
    list: async () => jobs,
    status: async jobId => jobs.find(job => job.jobId === jobId),
    result: async jobId => ({ jobId, complete: true }),
    cancel: async jobId => { calls.push("cancelled"); return { jobId, state: "cancelled" } },
  } })
  r.jobs.set("detached", { sessionID: "session", bindingID: p.bridge.binding("session").id })
  r.jobs.set("another-owner", { sessionID: "unrelated", bindingID: "unrelated" })
  r.recovered.add("foreign-id"); r.recovered.add("foreign-path")
  await tools.ae_release.execute({}, context())
  assert.equal(r.recovered.has("detached"), true)
  assert.equal(r.jobs.has("detached"), false)
  await tools.ae_bind.execute({ connectionId: p.connectionId }, context())
  const list = JSON.parse(await tools.ae_render_list.execute({}, context()))
  assert.deepEqual(list.map(job => [job.jobId, job.recoverable]), [["detached", true]])
  assert.ok(!JSON.stringify(list).includes("PRIVATE OUTPUT"))
  assert.equal(r.jobs.has("detached"), false)
  for (const jobId of ["foreign-id", "foreign-path", "another-owner"])
    await assert.rejects(tools.ae_render_recover.execute({ jobId }, context(() => assert.fail("foreign approval"))), { code: "render_scope" })
  await assert.rejects(tools.ae_render_status.execute({ jobId: "detached" }, context(() => false)), { code: "permission_denied" })
  assert.equal(r.jobs.has("detached"), false)
  const review = request => { calls.push(request.permission); assert.deepEqual(request.always, []) }
  await tools.ae_render_status.execute({ jobId: "detached" }, context(review))
  await tools.ae_render_status.execute({ jobId: "detached" }, context(() => assert.fail("repeat approval")))
  await tools.ae_render_result.execute({ jobId: "detached" }, context(() => assert.fail("result approval")))
  assert.deepEqual(calls, ["ae_render_recover"])
  await p.stop()
  await p.send("/disconnect", {})
  assert.equal(r.recovered.has("detached"), true)
  assert.equal(r.jobs.has("detached"), false)
  await p.connect()
  await tools.ae_bind.execute({ connectionId: p.connectionId, takeover: true }, context(undefined, "next"))
  await p.start(command => simulatedHost(command, p))
  await tools.ae_render_result.execute({ jobId: "detached" }, context(review, "next"))
  assert.equal(r.jobs.get("detached").sessionID, "next")
  await tools.ae_release.execute({}, context(undefined, "next"))
  await tools.ae_bind.execute({ connectionId: p.connectionId }, context())
  await tools.ae_render_cancel.execute({ jobId: "detached" }, context(review))
  assert.deepEqual(calls, ["ae_render_recover", "ae_render_recover", "ae_render_recover", "ae_render_cancel", "cancelled"])
})

test("corrupt claimed renders keep trusted project scope but only expose reviewed safe metadata", async t => {
  const jobId = randomUUID(), secret = "SECRET C:/private/project.aep source credentials"
  let job = { jobId, state: "running" }, resultCalls = 0, cancelCalls = 0
  const { p, r, tools } = await fixture(t, { permissionConfig: { permission: AE_PERMISSIONS }, renderer: {
    list: async () => [job], status: async () => structuredClone(job), close: async () => {},
    result: async () => { resultCalls++; return { verified: true, outputs: [secret] } },
    cancel: async () => { cancelCalls++; return { state: "cancelled" } },
  } })
  const source = { projectId: p.state.project.id, projectPath: p.state.project.path }
  job.sourceCheckpoint = { ...source, verified: true }
  await tools.ae_render_recover.execute({ jobId }, context())
  job = { jobId, state: "unknown", reason: "corrupt_manifest", detail: secret,
    controllable: true, outputState: "verified_completed", deliverables: [secret], logPath: secret }
  const expected = { jobId, state: "unknown", reason: "corrupt_manifest", metadataOnly: true,
    controllable: false, verified: false, outputs: [], remediation: "manual_manifest_recovery_required" }
  const noAsk = context(() => assert.fail("current owner should not need another review"))
  assert.deepEqual(JSON.parse(await tools.ae_render_status.execute({ jobId }, noAsk)), expected)
  assert.deepEqual(r.jobScopes.get(jobId), source)
  assert.deepEqual(JSON.parse(await tools.ae_render_list.execute({}, noAsk)), [{ ...expected, recoverable: false }])
  assert.deepEqual(JSON.parse(await tools.ae_render_result.execute({ jobId }, noAsk)), expected)
  await assert.rejects(tools.ae_render_cancel.execute({ jobId }, noAsk), { code: "render_process_identity" })
  assert.equal(resultCalls, 0); assert.equal(cancelCalls, 0)
  const diagnostics = JSON.parse(await tools.ae_diagnostics.execute({}, noAsk))
  assert.equal(diagnostics.renders[0].reason, "corrupt_manifest")
  assert.equal(diagnostics.renders[0].verified, false)
  assert.equal(diagnostics.renders[0].controllable, false)
  assert.ok(!JSON.stringify(diagnostics).includes(secret))

  await tools.ae_release.execute({}, context())
  assert.equal(r.jobs.has(jobId), false)
  assert.deepEqual(r.jobScopes.get(jobId), source)
  assert.equal(r.diagnostics.export({ sessionID: "session" }).events.length, 0)
  const project = structuredClone(p.state.project)
  p.state.project.id = "foreign-project"
  await p.heartbeat()
  await tools.ae_bind.execute({ connectionId: p.connectionId }, context(undefined, "foreign"))
  assert.deepEqual(JSON.parse(await tools.ae_render_list.execute({}, context(undefined, "foreign"))), [])
  await assert.rejects(tools.ae_render_status.execute({ jobId }, context(() => assert.fail("foreign review"), "foreign")),
    { code: "render_scope" })
  await tools.ae_release.execute({}, context(undefined, "foreign"))
  p.state.project = project
  await p.heartbeat()
  await tools.ae_bind.execute({ connectionId: p.connectionId }, context(undefined, "next"))
  assert.deepEqual(JSON.parse(await tools.ae_render_list.execute({}, context(undefined, "next"))), [{ ...expected, recoverable: true }])
  assert.equal(r.jobs.has(jobId), false)
  await assert.rejects(tools.ae_render_status.execute({ jobId }, context(() => false, "next")), { code: "permission_denied" })
  const reviews = []
  assert.deepEqual(JSON.parse(await tools.ae_render_status.execute({ jobId }, context(request => {
    reviews.push(request.permission)
    assert.match(request.patterns[0], /metadata.only/i)
  }, "next"))), expected)
  await tools.ae_render_result.execute({ jobId }, context(() => assert.fail("repeat review"), "next"))
  await assert.rejects(tools.ae_render_cancel.execute({ jobId }, context(() => assert.fail("cancel review"), "next")),
    { code: "render_process_identity" })
  assert.deepEqual(reviews, ["ae_render_recover"])
  assert.equal(resultCalls, 0); assert.equal(cancelCalls, 0)
  // Observe and drain the panel pump before closing its listener.
  await p.stop()
  await r.close()
  assert.equal(r.jobScopes.size, 0)
})

test("real corrupt manifests remain unscopable after restart and expose only aggregate diagnostics", async t => {
  let r, cleanup
  const p = await panelFixture({ after: callback => { cleanup = callback } })
  t.after(async () => { await p.stop(); try { await r?.close() } finally { await cleanup() } })
  const jobId = randomUUID(), secret = "SECRET PRIVATE MANIFEST DETAILS"
  const directory = path.join(p.dataDir, "render", "jobs", jobId)
  await mkdir(directory, { recursive: true })
  // An invalid manifest must not provide scope even if it names the current project.
  await writeFile(path.join(directory, "manifest.json"), JSON.stringify({
    jobId, sourceCheckpoint: { projectId: p.state.project.id, projectPath: p.state.project.path }, detail: secret,
  }))
  for (let restart = 0; restart < 2; restart++) {
    if (restart) {
      await r.close()
      await p.restart()
      await p.connect()
      await p.bridge.bind("session", p.connectionId)
    }
    r = await createRuntime({ factories: { bridge: async () => p.bridge }, permissionConfig: { permission: AE_PERMISSIONS } })
    const tools = createTools(r), c = context(() => assert.fail("unscopable jobs must not request project approval"))
    assert.equal((await r.renderer.status(jobId)).reason, "corrupt_manifest")
    assert.equal(r.recovered.has(jobId), true)
    assert.equal(r.jobScopes.size, 0)
    assert.deepEqual(JSON.parse(await tools.ae_render_list.execute({}, c)), [])
    for (const name of ["ae_render_status", "ae_render_result", "ae_render_cancel", "ae_render_recover"])
      await assert.rejects(tools[name].execute({ jobId }, c), { code: "render_scope" })
    const diagnostics = JSON.parse(await tools.ae_diagnostics.execute({}, c))
    assert.deepEqual(diagnostics.recovery, { unscopableCount: 1, remediation: "manual_manifest_recovery_required" })
    assert.deepEqual(diagnostics.renders, [])
    const panel = await p.send("/panel", { action: "diagnostics" })
    assert.equal(panel.status, 200)
    assert.deepEqual(panel.body.result.recovery, diagnostics.recovery)
    for (const exported of [diagnostics, panel.body.result]) {
      const serialized = JSON.stringify(exported)
      assert.ok(!serialized.includes(jobId))
      assert.ok(!serialized.includes(secret))
      assert.ok(!serialized.includes(p.state.project.path))
    }
    assert.equal(r.jobs.size, 0)
    assert.equal(r.jobScopes.size, 0)
  }
})

test("chat discovery retains active composition and reports unsaved mutation eligibility without leaking ownership", async t => {
  const { p, tools } = await fixture(t)
  p.state.activeCompId = 1
  await tools.ae_inspect.execute({}, context())
  const list = async sessionID => JSON.parse(await tools.ae_connections.execute({}, context(() => assert.fail("read-only discovery"), sessionID)))
  const [owned] = await list("session")
  assert.equal(owned.activeCompId, 1)
  assert.equal(owned.mutationEligible, true)
  assert.equal(owned.aeVersion, "26.0-test")
  assert.deepEqual(owned.project, p.state.project)
  assert.deepEqual(owned.capabilities, p.state.capabilities)
  const [foreign] = await list("other")
  assert.equal(foreign.activeCompId, 1)
  assert.equal(foreign.owned, true)
  assert.equal(foreign.binding, null)
  assert.ok(!JSON.stringify(foreign).includes(p.bridge.binding("session").id))
  await p.stop()
  p.state.project = { id: "unsaved", path: null, saved: false }
  await p.heartbeat()
  await tools.ae_bind.execute({ connectionId: p.connectionId }, context(request => {
    assert.match(request.patterns[0], /inspection.only/i)
  }))
  await p.start(command => simulatedHost(command, p))
  const inspected = JSON.parse(await tools.ae_inspect.execute({}, context()))
  assert.equal(inspected.project.saved, false)
  assert.equal((await list("session"))[0].mutationEligible, false)
  await assert.rejects(tools.ae_propose.execute({ actions: [{ type: "layer.create", name: "No write" }] }, context()), { code: "unsaved_project" })
  assert.equal(p.log.some(command => ["save", "execute", "preflight"].includes(command.method)), false)
})

test("chat release works while suspended, retains recovery locks, and refuses a replacement binding during approval", async t => {
  const { p, tools } = await fixture(t)
  await p.stop()
  await p.bridge.lock("session", "retain recovery")
  await p.send("/disconnect", {})
  await assert.rejects(tools.ae_release.execute({}, context(() => false)), { code: "permission_denied" })
  let reviewed
  assert.deepEqual(JSON.parse(await tools.ae_release.execute({}, context(request => {
    reviewed = request.metadata.binding
    assert.equal(reviewed.state, "suspended")
    assert.equal(request.permission, "ae_release")
  }))), { released: true })
  assert.equal((await p.bridge.connections())[0].binding, null)
  assert.equal((await p.bridge.connections())[0].lock.id, reviewed.lock.id)
  await p.connect()
  await tools.ae_bind.execute({ connectionId: p.connectionId }, context())
  const before = p.bridge.binding("session", { allowLocked: true })
  await assert.rejects(tools.ae_release.execute({}, context(async () => {
    await p.bridge.bind("session", p.connectionId)
  })), error => ["aborted", "stale_binding"].includes(error.code))
  assert.notEqual(p.bridge.binding("session", { allowLocked: true }).id, before.id)
})

test("bind passes the reviewed project and owner through the bridge await boundary", async t => {
  const { p, r, tools } = await fixture(t)
  const original = p.bridge.bind, reviewed = p.bridge.binding("session")
  p.bridge.bind = async (sessionID, connectionId, options) => {
    assert.deepEqual(options.expectedProject, reviewed.project)
    assert.equal(options.expectedOwner, reviewed.id)
    assert.equal(options.expectedConnection, (await p.bridge.connections())[0].epoch)
    return original(sessionID, connectionId, options)
  }
  p.bridge.onRelease(async () => {
    p.state.project = { ...p.state.project, id: "changed-after-review" }
    await p.heartbeat()
  })
  await assert.rejects(tools.ae_bind.execute({ connectionId: p.connectionId }, context()),
    error => ["stale_binding", "stale_project", "binding_suspended"].includes(error.code))
  assert.throws(() => r.bridge.binding("session"), { code: "not_bound" })
})

test("propose accepts more than 1000 actions but retains the workflow JSON byte bound", async t => {
  const { tools, p } = await fixture(t)
  const actions = Array.from({ length: 1001 }, () => ({ type: "property.set", value: 1 }))
  const proposed = JSON.parse(await tools.ae_propose.execute({ actions }, context()))
  assert.ok(proposed.token)
  assert.ok(p.log.some(command => command.method === "preflight"))
  await assert.rejects(tools.ae_propose.execute({ actions: [{ type: "property.set", value: "x".repeat(4 * 1024 * 1024) }] }, context()),
    { code: "payload_too_large" })
})

test("initialization failure closes the real listener and releases ownership", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cm-ae-init-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dataDir = path.join(root, "private")
  await assert.rejects(createRuntime({ dataDir, factories: { renderer: async () => { throw Error("init failure") } } }), /init failure/)
  const reopened = await createBridge({ dataDir })
  await reopened.close()
})

test("directory instances share one listener; disposal waits owned work, aborts approvals and leaves other instance alive", async t => {
  const { p } = await fixture(t)
  // A separate data directory exercises the actual singleton without sharing fixture hooks.
  const dataDir = path.join(p.dataDir, "singleton")
  const [one, two] = await Promise.all([server({ directory: "one" }, { dataDir }), server({ directory: "two" }, { dataDir })])
  t.after(async () => { await one.dispose(); await two.dispose() })
  await one.config({}); await two.config({})
  const first = JSON.parse(await one.tool.ae_pair.execute({}, context(undefined, "one")))
  assert.ok(first.code)
  await two.tool.ae_pair.execute({}, context(undefined, "two"))
  assert.throws(() => two.tool.ae_pair.execute({}, context(undefined, "one")), { code: "session_scope" })
  await one.event({ event: { type: "session.deleted", properties: { info: { id: "two" } } } })
  await one.dispose()
  assert.ok(JSON.parse(await two.tool.ae_pair.execute({}, context(undefined, "two"))).code)
  await two.dispose()
  const reopened = await createBridge({ dataDir })
  await reopened.close()
})

test("release and close abort pending permission callbacks without waiting for UI resolution", async t => {
  const { p, r, tools } = await fixture(t)
  const plan = JSON.parse(await tools.ae_propose.execute({ actions: [{ type: "layer.create", name: "No write" }] }, context()))
  let entered
  const ready = new Promise(resolve => { entered = resolve })
  const pending = tools.ae_execute.execute({ token: plan.token }, context(() => { entered(); return new Promise(() => {}) }))
  const rejected = assert.rejects(pending, { code: "aborted" })
  await ready
  await r.drain("session")
  await rejected
  assert.equal(p.log.some(command => command.method === "execute"), false)
  assert.equal(r.diagnostics.export({ sessionID: "session" }).events.length, 0)
})

test("abort during post-approval inspection stops workflow before any save or execution", async t => {
  const controller = new AbortController()
  let approved = false
  const { p, tools } = await fixture(t, { handler(command) {
    if (approved && command.method === "inspect") controller.abort()
  } })
  const plan = JSON.parse(await tools.ae_propose.execute({ actions: [{ type: "layer.create", name: "No write" }] }, context()))
  await assert.rejects(tools.ae_execute.execute({ token: plan.token }, {
    ...context(() => { approved = true }), abort: controller.signal,
  }), { code: "aborted" })
  assert.equal(p.log.some(command => ["save", "execute"].includes(command.method)), false)
})

test("drain waits a late bind and releases it before returning", async t => {
  const { p, r } = await fixture(t)
  let entered, proceed
  const ready = new Promise(resolve => { entered = resolve })
  const held = new Promise(resolve => { proceed = resolve })
  const pending = r.run(context(), async () => {
    entered()
    await held
    return p.bridge.bind("session", p.connectionId)
  })
  await ready
  const draining = r.drain("session")
  assert.throws(() => r.run(context(), async () => {}), { code: "aborted" })
  proceed()
  await pending
  await draining
  assert.throws(() => p.bridge.binding("session"), { code: "not_bound" })
})
