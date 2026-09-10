import test from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import os from "node:os"
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises"
import { runWorker, readJob, save, load, exists } from "../src/render-worker.mjs"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { randomUUID } from "node:crypto"
import plugin, { createRuntime, createTools, server, checkPermissionConfig } from "../src/plugin.mjs"
import { createBridge } from "../src/bridge.mjs"
import { hash } from "../src/protocol.mjs"
import { AE_PERMISSIONS } from "../src/config.mjs"
import { panelFixture, simulatedHost, request, restoreFixture } from "./bridge-panel.mjs"
import transport from "../panel/transport.cjs"

const exec = promisify(execFile)
const context = (ask = async () => {}, sessionID = "session") => ({ sessionID, ask, abort: new AbortController().signal })
const permissionConfig = { permission: "ask" }

test("first inspection automatically binds the single AE target without an approval prompt", async t => {
  const { p, tools } = await fixture(t)
  await p.bridge.release("session")
  const result = JSON.parse(await tools.ae_inspect.execute({}, context(() => assert.fail("connection must not ask"), "automatic-chat")))
  assert.ok(result.expectedRevision)
  assert.equal(p.bridge.binding("automatic-chat").connectionId, p.connectionId)
  await assert.rejects(tools.ae_inspect.execute({}, context(undefined, "other-chat")), { code: "binding_owned" })
})

async function pluginHost(command, p) {
  if (command.method === "inspect") return {
    ...structuredClone(p.state),
    ...(command.params.query === undefined ? {} : { fingerprint: hash(p.state), nextCursor: null }),
  }
  if (command.method === "raw") {
    assert.equal(command.params.expectedRevision, p.state.revision)
    assert.deepEqual(command.params.expectedProject, { id: p.state.project.id, path: p.state.project.path })
    p.state.revision++
    return { value: command.params.source, revision: p.state.revision, project: structuredClone(p.state.project) }
  }
  return simulatedHost(command, p)
}

async function scriptArgs(tools, c = context()) {
  const { expectedRevision } = JSON.parse(await tools.ae_inspect.execute({}, c))
  return { source: 'return "Reviewed";\n', expectedRevision, label: "Reviewed script" }
}

async function fixture(t, options = {}) {
  let p, r, cleanup
  t.after(async () => {
    try { await p?.stop() } finally {
      try { await r?.close() } finally { await cleanup?.() }
    }
  })
  p = await panelFixture({ after: callback => { cleanup = callback } })
  let clock = Date.now()
  r = await createRuntime({ factories: { bridge: async () => p.bridge,
    ...(options.renderer ? { renderer: async () => options.renderer } : {}) },
    permissionConfig: options.permissionConfig || permissionConfig, now: () => clock,
    processAdapter: options.processAdapter, aerenderPath: options.aerenderPath })
  p.state.items = [{ id: 1, kind: "comp", name: "Main", duration: 2, frameRate: 25 }]
  p.state.revision = 1
  p.state.projectEpoch = "test-project-instance"
  p.state.aeVersion = "26.0-test"
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
    return pluginHost(command, p)
  })
  return { p, r, tools: createTools(r), advance(ms) { clock += ms } }
}

async function retirementFixture(t) {
  const live = new Map(), workers = new Map()
  let pid = 31000
  const adapter = {
    async inspect(pid) { return live.get(pid) ?? null },
    async discover() { return [] },
    async launch(jobDir) {
      const identity = { pid: pid++, startTime: randomUUID(), executable: "node", command: "worker " + jobDir }
      live.set(identity.pid, identity)
      const task = runWorker(jobDir, {
        ...adapter, self: async () => identity,
        async start(command) {
          const child = { pid: pid++, startTime: randomUUID(), executable: command.executable, command: JSON.stringify(command) }
          await writeFile(command.args[command.args.indexOf("-output") + 1], "completed render")
          return { pid: child.pid, identity: child, exited: Promise.resolve({ code: 0, signal: null, error: null }) }
        },
      }).finally(() => live.delete(identity.pid))
      workers.set(path.basename(jobDir), task)
    },
  }
  const f = await fixture(t, { processAdapter: adapter, aerenderPath: process.execPath,
    permissionConfig: { permission: AE_PERMISSIONS } })
  const outputDir = path.join(f.p.dataDir, "output")
  await mkdir(outputDir)
  await f.tools.ae_grant.execute({ path: outputDir, write: true, recursive: true }, context())
  const submitted = JSON.parse(await f.tools.ae_render_submit.execute({
    compId: 1, startFrame: 0, endFrame: 0, renderSettings: "Best", outputModule: "PNG",
    outputPath: path.join(outputDir, "frame.png"),
  }, context()))
  await workers.get(submitted.jobId)
  const jobDir = path.join(f.p.dataDir, "render", "jobs", submitted.jobId)
  const job = await readJob(jobDir)
  assert.equal((await f.r.renderer.status(job.jobId)).state, "completed")
  await f.r.checkpoints.pin(job.sourceCheckpoint.id, true)
  return { ...f, adapter, job, jobDir }
}

test("object module export is import-safe and exposes only the simplified strict tool surface", async () => {
  assert.equal(plugin.id, "cm-ae")
  assert.equal(plugin.server, server)
  const result = await exec(process.execPath, ["--input-type=module", "-e",
    "import net from 'node:net'; net.Server.prototype.listen=()=>{throw Error('listener at import')}; const m=await import('./src/plugin.mjs'); if(m.default.server!==m.server)throw Error('export');"])
  assert.equal(result.stderr, "")
  const tools = createTools({})
  const names = ["pair","connections","bind","release","inspect","execute","grant","capture",
    "checkpoints","restore","templates","render_submit","render_status","render_cancel","render_retire","render_result","render_recover","render_list","diagnostics","reconcile"]
  assert.deepEqual(Object.keys(tools).sort(), names.map(name => "ae_" + name).sort())
  assert.deepEqual(Object.keys(AE_PERMISSIONS).sort(), Object.keys(tools).sort())
  for (const name of names) {
    const tool = tools["ae_" + name]
    assert.equal(typeof tool.execute, "function")
    assert.equal(typeof tool.args, "object")
    await assert.rejects(tool.execute({ sessionID: "forged", executable: "evil", templates: [] }, context()), { name: "ZodError" })
  }
})

test("compatibility chat discovery preserves legacy arrays and exposes mismatches without binding or diagnostic leaks", async t => {
  const { p, tools } = await fixture(t)
  await p.stop()
  const readOnly = context(() => assert.fail("discovery must not ask"))
  const list = JSON.parse(await tools.ae_connections.execute({}, readOnly))
  assert.ok(Array.isArray(list))
  assert.equal(list[0].compatibility.panelVersion, "0.2.2")
  const overview = JSON.parse(await tools.ae_connections.execute({ includeCompatibility: true }, readOnly))
  assert.equal(overview.compatibility.cookieMonsterVersionStatus, "not_configured")
  assert.equal(overview.compatibility.updates.cookieMonster.url, null)
  await assert.rejects(tools.ae_connections.execute({ updateUrl: "https://evil.test" }, readOnly), { name: "ZodError" })
  await p.send("/compatibility", { panelId: "test-panel", version: "0.2.2-SECRET", protocol: 2 })
  const mismatch = JSON.parse(await tools.ae_connections.execute({ includeCompatibility: true }, readOnly))
  assert.equal(mismatch.connections[0].compatibility.panelVersion, "0.2.2-SECRET")
  assert.equal(mismatch.connections[0].compatibility.status, "incompatible")
  assert.equal(mismatch.connections[0].mutationEligible, false)
  await assert.rejects(tools.ae_bind.execute({ connectionId: p.connectionId }, readOnly), { code: "disconnected" })
  await assert.rejects(tools.ae_inspect.execute({}, readOnly), { code: "binding_suspended" })
  const diagnostic = JSON.parse(await tools.ae_diagnostics.execute({}, readOnly))
  assert.equal(diagnostic.connections[0].compatibility.panelVersion, "0.2.2")
  assert.equal(diagnostic.connections[0].compatibility.status, "incompatible")
  assert.ok(!/SECRET|https:/.test(JSON.stringify(diagnostic)))
  assert.ok(!JSON.stringify(diagnostic).includes(p.state.project.path))
  const other = JSON.parse(await tools.ae_connections.execute({}, context(undefined, "other")))
  assert.equal(other[0].binding, null)
  await tools.ae_release.execute({}, context())
  assert.deepEqual(JSON.parse(await tools.ae_diagnostics.execute({}, readOnly)).connections, [])
})

test("compatibility chat overview works before connection and removes pending reports on session deletion", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cm-ae-compat-"))
  const dataDir = path.join(root, "private")
  let instance
  t.after(async () => { try { await instance?.dispose() } finally { await rm(root, { recursive: true, force: true }) } })
  const releases = { cookieMonsterVersion: "2.4.1",
    updates: { cookieMonster: { version: "2.4.1", protocol: 1, url: "https://releases.example.test/desktop/2.4.1" } } }
  instance = await server({}, { dataDir, releaseMetadata: releases })
  const tools = instance.tool, readOnly = context(() => assert.fail("discovery must not ask"))
  const discovery = async c => JSON.parse(await tools.ae_connections.execute({ includeCompatibility: true }, c))
  const empty = await discovery(readOnly)
  assert.deepEqual(empty.connections, [])
  assert.equal(empty.compatibility.cookieMonsterVersion, "2.4.1")
  assert.equal(empty.compatibility.updates.cookieMonster.url, releases.updates.cookieMonster.url)
  await assert.rejects(server({}, { dataDir, releaseMetadata: { cookieMonsterVersion: "9.9.9" } }),
    { code: "runtime_config" })
  const descriptor = JSON.parse(await readFile(path.join(dataDir, "descriptor.json"), "utf8"))
  const pairing = JSON.parse(await tools.ae_pair.execute({}, readOnly))
  assert.equal(pairing.compatibility.cookieMonsterVersion, "2.4.1")
  const response = await request(descriptor.port, "/pair", { code: pairing.code, panelId: "peer-SECRET",
    protocol: 2, version: "0.2.2-SECRET" })
  assert.equal(response.body.error.code, "incompatible_version")
  const pending = await discovery(readOnly)
  assert.deepEqual(pending.connections, [])
  assert.equal(pending.compatibility.pendingPanels[0].panelVersion, "0.2.2-SECRET")
  assert.deepEqual((await discovery(context(undefined, "other"))).compatibility.pendingPanels, [])
  const diagnostic = JSON.parse(await tools.ae_diagnostics.execute({}, readOnly))
  assert.equal(diagnostic.compatibility.pendingPanels[0].panelVersion, "0.2.2")
  assert.ok(!/SECRET|https:/.test(JSON.stringify(diagnostic)))
  await instance.event({ event: { type: "session.deleted", properties: { info: { id: "session" } } } })
  assert.deepEqual((await discovery(readOnly)).compatibility.pendingPanels, [])
  assert.equal((await request(descriptor.port, "/pair", { code: pairing.code, panelId: "peer",
    protocol: 1, version: "0.2.2" })).body.error.code, "invalid_pairing_code")
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
  assert.throws(() => checkPermissionConfig({}, "ae_execute"), { code: "permission_denied" })
  checkPermissionConfig({ permission: AE_PERMISSIONS }, "ae_execute")
  checkPermissionConfig({ permission: { ...AE_PERMISSIONS, ae_propose: "allow",
    ae_raw_enable: "allow", ae_raw_propose: "allow", ae_raw_execute: "allow" } }, null, { configure: true })
})

test("script adapter enforces exact-source approval, denial, abort, binding and checkpoint checks", async t => {
  const { p, r, tools } = await fixture(t)
  let args = await scriptArgs(tools)
  await assert.rejects(tools.ae_execute.execute(args, { sessionID: "session" }), { code: "permission_required" })
  await assert.rejects(tools.ae_execute.execute(args, context(request => {
    assert.equal(request.metadata.source, args.source)
    return false
  })), { code: "permission_denied" })
  const denied = createTools({ ...r, permissionPolicy: name => checkPermissionConfig({
    permission: { ...AE_PERMISSIONS, ae_execute: "deny" },
  }, name) })
  await assert.rejects(denied.ae_execute.execute(args, context(() => assert.fail("denied policy asked"))),
    { code: "permission_denied" })
  const controller = new AbortController()
  await assert.rejects(tools.ae_execute.execute(args, {
    ...context(async request => {
      assert.equal(request.permission, "ae_execute"); assert.deepEqual(request.always, [])
      assert.ok(request.patterns[0].endsWith(args.source)); controller.abort()
    }), abort: controller.signal,
  }), { code: "aborted" })
  assert.equal(p.log.some(command => ["save", "raw", "execute"].includes(command.method)), false)
  assert.deepEqual(await r.checkpoints.list(p.state.project.id), [])
  await assert.rejects(tools.ae_execute.execute(args, context(async () => {
    await p.bridge.bind("session", p.connectionId)
  })), error => ["aborted", "stale_binding", "stale_revision"].includes(error.code))
  await assert.rejects(tools.ae_execute.execute(args, context(() => assert.fail("stale binding token asked"))),
    { code: "stale_revision" })
  args = await scriptArgs(tools)
  let reviews = 0
  const result = JSON.parse(await tools.ae_execute.execute(args, context(request => {
    reviews++
    assert.equal(request.permission, "ae_execute")
    assert.deepEqual(request.always, [])
    assert.ok(request.patterns[0].endsWith(args.source))
    assert.equal(request.metadata.source, args.source)
    assert.equal(request.metadata.expectedRevision, args.expectedRevision)
    assert.equal(request.metadata.label, args.label)
    assert.equal(request.metadata.nonTransactional, true)
    assert.equal(p.log.some(command => ["save", "raw", "execute"].includes(command.method)), false)
    request.metadata.source = "unapproved callback mutation"
  })))
  assert.equal(reviews, 1)
  assert.equal(result.result, args.source)
  const checkpoint = await r.checkpoints.verify(result.checkpointId)
  assert.equal(checkpoint.verified, true)
  assert.equal(checkpoint.pinned, true)
  assert.equal(JSON.parse(await readFile(checkpoint.path, "utf8")).revision, 1)
  assert.equal(p.log.filter(command => command.method === "raw").length, 1)
  assert.equal(p.log.find(command => command.method === "raw").params.source, args.source)
  assert.notEqual(result.expectedRevision, args.expectedRevision)
  await assert.rejects(tools.ae_execute.execute(args, context(() => assert.fail("stale revision asked"))),
    { code: "stale_revision" })
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
  const cleanup = []
  let f, r, clock = Date.now()
  t.after(async () => {
    await f?.stop()
    try { await r?.close() } finally { for (const close of cleanup.reverse()) await close() }
  })
  f = await restoreFixture({ after: close => cleanup.push(close) })
  const { p, h, client, sessionID, commands } = f
  r = await createRuntime({ factories: { bridge: async () => p.bridge,
    renderer: async () => ({ list: async () => [], close: async () => {} }) },
    permissionConfig, now: () => clock })
  const tools = createTools(r), c = context(undefined, sessionID)
  const canonicalPath = h.project.file.fsName
  const checkpoint = await r.checkpoints.create({ projectPath: canonicalPath,
    projectId: h.call("inspect").result.project.id, planHash: hash("test") })
  const foreign = await r.checkpoints.create({ projectPath: canonicalPath, projectId: "other-project", planHash: hash("other") })
  const source = await readFile(checkpoint.path)
  h.props[0].setValue(73)
  h.project.save(h.project.file)
  const original = await readFile(canonicalPath)
  assert.notDeepEqual(original, source)
  h.props[0].setValue(42)
  const send = body => transport.request(client.descriptor, f.store.state.credential, "/panel", body, 300000)
  const list = await client.panel("checkpoints", {})
  assert.equal(list.length, 1); assert.equal(list[0].id, checkpoint.id)
  assert.equal(typeof list[0].createdAt, "number")
  await assert.rejects(tools.ae_checkpoints.execute({ action: "pin", id: foreign.id, pinned: true }, c), { code: "checkpoint_scope" })
  await assert.rejects(send({ action: "diagnostics", sessionID: "other" }))
  await client.panel("checkpoint.pin", { id: checkpoint.id, pinned: true })
  assert.equal((await r.checkpoints.verify(checkpoint.id)).pinned, true)
  const exported = await client.panel("diagnostics", {})
  assert.ok(!JSON.stringify(exported).includes(canonicalPath))
  assert.equal(exported.storage.checkpointCount, 1)
  assert.equal(exported.storage.pinnedCount, 1)
  assert.equal(JSON.parse(await tools.ae_diagnostics.execute({}, c)).storage.checkpointCount, 1)
  let proposed = await send({ action: "checkpoint.restore.propose", id: checkpoint.id })
  assert.match(proposed.result.operation, /save current unsaved edits.*private emergency project.*verify a protected checkpoint/i)
  assert.match(proposed.result.operation, /recovery copy/i)
  assert.equal(commands.some(command => ["save", "open", "execute"].includes(command.method)), false)
  clock += 300001
  await assert.rejects(send({ action: "checkpoint.restore.confirm", token: proposed.result.token }), { code: "invalid_token" })
  proposed = await send({ action: "checkpoint.restore.propose", id: checkpoint.id })
  h.project.item(1).selected = true
  await assert.rejects(send({ action: "checkpoint.restore.confirm", token: proposed.result.token }), { code: "stale_fingerprint" })
  await assert.rejects(send({ action: "checkpoint.restore.confirm", token: proposed.result.token }), { code: "invalid_token" })
  proposed = await send({ action: "checkpoint.restore.propose", id: checkpoint.id })
  r.tokens.get(sessionID).operation += " Unreviewed change."
  await assert.rejects(send({ action: "checkpoint.restore.confirm", token: proposed.result.token }), { code: "stale_fingerprint" })
  assert.equal(commands.some(command => ["save", "open", "execute"].includes(command.method)), false)
  assert.equal(h.project.dirty, true)
  assert.equal(h.closes, 0)
  await client.panel("checkpoint.restore.propose", { id: checkpoint.id })
  const restored = await client.confirmRestore()
  assert.equal(restored.recoveryCopy, false)
  assert.equal(restored.canonicalReplaced, true)
  assert.equal(restored.path, canonicalPath)
  assert.equal(h.project.file.fsName, canonicalPath)
  assert.equal(h.props[0].value, 100)
  assert.deepEqual(await readFile(canonicalPath), source)
  assert.deepEqual(await readFile(restored.originalPath), original)
  const backup = await r.checkpoints.verify(restored.currentCheckpointId)
  assert.equal(backup.verified, true)
  assert.equal(backup.pinned, true)
  assert.equal(JSON.parse(await readFile(backup.path)).props[0].value, 42)
  assert.equal(JSON.parse(await readFile(restored.emergencyPath)).props[0].value, 42)
  assert.equal(r.tokens.size, 0)
  assert.equal(h.closes, 1)
  assert.deepEqual(commands.filter(command => command.params.phase?.startsWith("restore_")).map(command => command.params.phase),
    ["restore_prepare", "restore_finish"])
  assert.equal(p.bridge.binding(sessionID).lock, null)
  await assert.rejects(client.confirmRestore(), { code: "invalid_token" })
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

test("retirement policy rejects auto-allow, missing ask, deny and legacy overrides", () => {
  for (const config of [
    { permission: "allow" }, { permission: { ae_render_retire: "allow" } },
    { permission: { "ae_render_*": "allow", ae_render_retire: "ask" } },
    { permission: "ask", agent: { build: { permission: { ae_render_retire: "allow" } } } },
    { permission: "ask", tools: { ae_render_retire: true } },
  ]) assert.throws(() => checkPermissionConfig(config, null, { configure: true }), { code: "unsafe_permission_config" })
  for (const permission of [{}, { ae_render_retire: "deny" }])
    assert.throws(() => checkPermissionConfig({ permission }, "ae_render_retire"), { code: "permission_denied" })
  checkPermissionConfig({ permission: AE_PERMISSIONS }, "ae_render_retire")
})

test("retirement adapter uses real inventory approval, refuses denial/staleness, and expires recovered ownership", async t => {
  const { p, r, tools, job, jobDir } = await retirementFixture(t)
  const args = { jobId: job.jobId }, receiptPath = path.join(jobDir, "receipt.json")
  for (const extra of [{ approval: "forged" }, { metadataOnly: false }, { check: true }])
    await assert.rejects(tools.ae_render_retire.execute({ ...args, ...extra }, context()), { name: "ZodError" })
  await assert.rejects(tools.ae_render_retire.execute(args, { sessionID: "session" }), { code: "permission_required" })
  await assert.rejects(tools.ae_render_retire.execute(args, context(request => {
    assert.equal(request.permission, "ae_render_retire")
    assert.deepEqual(request.always, [])
    assert.match(request.patterns[0], /Permanently remove/)
    assert.equal(request.metadata.jobId, job.jobId)
    assert.ok(request.metadata.remove.includes(jobDir))
    assert.ok(request.metadata.preserve.includes(job.sourceCheckpoint.path))
    return false
  })), { code: "permission_denied" })
  assert.equal(await exists(receiptPath), true)
  await assert.rejects(tools.ae_render_retire.execute(args, context(async () => {
    const receipt = await load(receiptPath)
    await save(receiptPath, { ...receipt, finishedAt: "2026-01-01T00:00:00.000Z" })
  })), error => error.code === "render_retire_refused" && /Approval is stale/.test(error.message))
  assert.equal(await exists(receiptPath), true)
  const denied = createTools({ ...r, permissionPolicy: name => checkPermissionConfig({
    permission: { ...AE_PERMISSIONS, ae_render_retire: "deny" },
  }, name) })
  await assert.rejects(denied.ae_render_retire.execute(args, context(() => assert.fail("denied policy asked"))),
    { code: "permission_denied" })
  await tools.ae_release.execute({}, context())
  await tools.ae_bind.execute({ connectionId: p.connectionId }, context())
  const reviews = []
  const result = JSON.parse(await tools.ae_render_retire.execute(args, context(request => {
    reviews.push(request.permission)
    if (request.permission === "ae_render_retire") {
      assert.match(request.metadata.approval, /^[a-f0-9]{64}$/)
      request.metadata.approval = "callback mutation must not alter the reviewed digest"
    }
  })))
  assert.deepEqual(reviews, ["ae_render_recover", "ae_render_retire"])
  assert.equal(result.retired, true)
  for (const target of [jobDir, job.stageDir, job.quarantineDir]) assert.equal(await exists(target), false)
  assert.equal(await readFile(job.outputPath, "utf8"), "completed render")
  assert.equal((await r.checkpoints.verify(job.sourceCheckpoint.id)).pinned, true)
  assert.equal(r.jobs.has(job.jobId), false)
  assert.equal(r.jobScopes.has(job.jobId), false)
  assert.equal(r.recovered.has(job.jobId), false)
  assert.deepEqual(JSON.parse(await tools.ae_render_list.execute({}, context())), [])
  await assert.rejects(tools.ae_render_status.execute(args, context()), { code: "render_scope" })
  const diagnostic = JSON.parse(await tools.ae_diagnostics.execute({}, context()))
  assert.deepEqual(diagnostic.renders, [])
  assert.ok(!JSON.stringify(diagnostic).includes(jobDir))
  assert.ok(!JSON.stringify(diagnostic).includes(job.jobId))
  await tools.ae_release.execute({}, context())
  assert.deepEqual(r.diagnostics.export({ sessionID: "session" }).events, [])
  assert.equal(r.recovered.has(job.jobId), false)
  assert.equal(r.jobScopes.has(job.jobId), false)
})

test("retirement adapter rejects foreign session/project, metadata-only jobs and scope changes during approval", async t => {
  const { p, r, tools, job, jobDir } = await retirementFixture(t)
  const args = { jobId: job.jobId }, manifestPath = path.join(jobDir, "manifest.json")
  const manifest = await load(manifestPath), owner = r.jobs.get(job.jobId)
  const noAsk = context(() => assert.fail("unsafe retirement must not ask"))
  r.jobs.set(job.jobId, { sessionID: "other", bindingID: "other" })
  await assert.rejects(tools.ae_render_retire.execute(args, noAsk), { code: "render_scope" })
  r.jobs.set(job.jobId, owner)
  await writeFile(manifestPath, "{broken")
  await assert.rejects(tools.ae_render_retire.execute(args, noAsk), { code: "render_retire_refused" })
  const foreign = { ...manifest, sourceCheckpoint: { ...manifest.sourceCheckpoint, projectId: "foreign" } }
  await save(manifestPath, foreign)
  await assert.rejects(tools.ae_render_retire.execute(args, noAsk), { code: "render_scope" })
  await save(manifestPath, manifest)
  await assert.rejects(tools.ae_render_retire.execute(args, context(() => save(manifestPath, foreign))),
    { code: "render_scope" })
  await save(manifestPath, manifest)
  assert.equal(await exists(jobDir), true)
  assert.equal(await readFile(job.outputPath, "utf8"), "completed render")
  p.state.project.id = "different-bound-project"
  await p.heartbeat()
  await tools.ae_bind.execute({ connectionId: p.connectionId }, context())
  await assert.rejects(tools.ae_render_retire.execute(args, noAsk), { code: "render_scope" })
})

for (const action of ["abort", "release", "rebind"]) {
  test(`retirement adapter stops a pending approval on ${action}`, async t => {
    const { p, r, tools, job, jobDir } = await retirementFixture(t)
    const controller = new AbortController()
    let entered
    const ready = new Promise(resolve => { entered = resolve })
    const pending = tools.ae_render_retire.execute({ jobId: job.jobId }, {
      ...context(() => { entered(); return new Promise(() => {}) }), abort: controller.signal,
    })
    const rejected = assert.rejects(pending, { code: "aborted" })
    await ready
    if (action === "abort") controller.abort()
    else if (action === "release") await r.release("session")
    else await p.bridge.bind("session", p.connectionId)
    await rejected
    assert.equal(await exists(jobDir), true)
    assert.equal(await exists(job.logPath), true)
    assert.equal(await readFile(job.outputPath, "utf8"), "completed render")
    if (action !== "abort") assert.deepEqual(r.diagnostics.export({ sessionID: "session" }).events, [])
  })
}

test("retirement adapter rechecks lifetime after waiting inside renderer verification", async t => {
  const { r, tools, job, jobDir, adapter } = await retirementFixture(t)
  let approved = false
  adapter.discover = async () => {
    if (approved) { approved = false; await r.release("session") }
    return []
  }
  await assert.rejects(tools.ae_render_retire.execute({ jobId: job.jobId }, context(() => { approved = true })),
    error => error.code === "render_retire_refused" && error.details.cause === "aborted" && error.details.removed.length === 0)
  assert.equal(await exists(jobDir), true)
  assert.equal(await exists(job.logPath), true)
  assert.equal(await exists(job.stageDir), true)
  assert.deepEqual(r.diagnostics.export({ sessionID: "session" }).events, [])
})

test("retirement adapter does not resurrect scope from an earlier in-flight status", async t => {
  const { r, tools, job } = await retirementFixture(t)
  const status = r.renderer.status
  let entered, resume, held = false
  const ready = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { resume = resolve })
  r.renderer.status = async id => {
    const result = await status(id)
    if (!held) { held = true; entered(); await gate }
    return result
  }
  const pending = tools.ae_render_status.execute({ jobId: job.jobId }, context())
  const rejected = assert.rejects(pending, { code: "render_scope" })
  await ready
  assert.equal(JSON.parse(await tools.ae_render_retire.execute({ jobId: job.jobId }, context())).retired, true)
  resume()
  await rejected
  assert.equal(r.jobs.has(job.jobId), false)
  assert.equal(r.jobScopes.has(job.jobId), false)
  assert.equal(r.recovered.has(job.jobId), false)
})

test("retirement adapter clears ownership even when release arrives after the final deletion", async t => {
  const { r, tools, job, jobDir } = await retirementFixture(t)
  const retire = r.renderer.retire
  r.renderer.retire = async (id, options) => {
    const result = await retire(id, options)
    if (result.retired) await r.release("session")
    return result
  }
  await assert.rejects(tools.ae_render_retire.execute({ jobId: job.jobId }, context()), { code: "aborted" })
  assert.equal(await exists(jobDir), false)
  assert.equal(r.jobs.has(job.jobId), false)
  assert.equal(r.jobScopes.has(job.jobId), false)
  assert.equal(r.recovered.has(job.jobId), false)
  assert.deepEqual(r.diagnostics.export({ sessionID: "session" }).events, [])
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
  await p.start(command => pluginHost(command, p))
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
    for (const name of ["ae_render_status", "ae_render_result", "ae_render_cancel", "ae_render_recover", "ae_render_retire"])
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
  await p.start(command => pluginHost(command, p))
  const inspected = JSON.parse(await tools.ae_inspect.execute({}, context()))
  assert.equal(inspected.project.saved, false)
  assert.equal((await list("session"))[0].mutationEligible, false)
  await assert.rejects(tools.ae_execute.execute({
    source: "return 1;", expectedRevision: inspected.expectedRevision, label: "No write",
  }, context()), { code: "unsaved_project" })
  assert.equal(p.log.some(command => ["save", "raw", "execute", "preflight"].includes(command.method)), false)
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

test("inspect and execute validate strict query/script schemas and forward only context session", async () => {
  const calls = []
  const tools = createTools({ bridge: { async ensureBound(sessionID) { assert.ok(["query-session", "session"].includes(sessionID)) } }, workflow: {
    async inspectQuery(sessionID, args) { calls.push({ sessionID, args }); return { expectedRevision: hash("revision") } },
    async executeScript(sessionID, args, ask) { calls.push({ sessionID, args }); assert.equal(typeof ask, "function"); return { result: true } },
  } })
  const query = { compId: 1, layerId: 2, propertyPath: [
    { index: 0, matchName: "ADBE Transform Group", name: "" },
    { index: 100000, matchName: "ADBE Position" },
  ], depth: 8, cursor: "next-page" }
  await tools.ae_inspect.execute(query, context(undefined, "query-session"))
  assert.deepEqual(calls.pop(), { sessionID: "query-session", args: query })
  const args = await scriptArgs(tools)
  args.source = "x".repeat(262144)
  args.label = "x".repeat(128)
  await tools.ae_execute.execute(args, context(undefined, "script-session"))
  assert.deepEqual(calls.pop(), { sessionID: "script-session", args })
  const beforeInvalid = calls.length
  for (const invalid of [
    { compId: 0 }, { layerId: 1.5 }, { depth: -1 }, { depth: 9 }, { depth: 1.5 }, { cursor: "" },
    ...[{ index: -1, matchName: "x" }, { index: 100001, matchName: "x" },
      { index: 0.5, matchName: "x" }, { index: 0, matchName: "" },
      { index: 0, matchName: "x", extra: true }].map(part => ({ ...query, propertyPath: [part] })),
  ]) await assert.rejects(tools.ae_inspect.execute(invalid, context()), { name: "ZodError" })
  for (const invalid of [
    { token: "old-proposal" }, { ...args, source: "" }, { ...args, source: "x".repeat(262145) },
    { ...args, source: "return 1;\u0000" },
    { ...args, expectedRevision: "forged" }, { ...args, expectedRevision: 1 },
    { ...args, label: "" }, { ...args, label: "x".repeat(129) }, { ...args, actions: [] },
    ...Array.from({ length: 32 }, (_, code) => ({ ...args, label: "Label" + String.fromCharCode(code) })),
  ]) await assert.rejects(tools.ae_execute.execute(invalid, context()), { name: "ZodError" })
  assert.equal(calls.length, beforeInvalid, "invalid input must be rejected before workflow dispatch")
})

test("query inspection forwards scope and stale native revisions prevent saves and scripts", async t => {
  const { tools, p } = await fixture(t)
  const query = { compId: 1, layerId: 2, propertyPath: [{ index: 1, matchName: "ADBE Position" }], depth: 0 }
  const inspected = JSON.parse(await tools.ae_inspect.execute(query, context(() => assert.fail("inspect asked"))))
  assert.deepEqual(p.log.at(-1).params, { query })
  assert.equal(inspected.revision, 1)
  assert.equal(inspected.nextCursor, null)
  assert.match(inspected.expectedRevision, /^[a-f0-9]{64}$/)
  const args = { source: "return 1;", expectedRevision: inspected.expectedRevision, label: "Stale native edit" }
  p.state.revision++
  await assert.rejects(tools.ae_execute.execute(args, context(() => assert.fail("stale revision asked"))),
    { code: "stale_revision" })
  const fresh = await scriptArgs(tools)
  await assert.rejects(tools.ae_execute.execute(fresh, context(() => { p.state.revision++ })),
    { code: "stale_revision" })
  assert.equal(p.log.some(command => ["save", "raw", "execute"].includes(command.method)), false)
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
  const args = await scriptArgs(tools)
  let entered
  const ready = new Promise(resolve => { entered = resolve })
  const pending = tools.ae_execute.execute(args, context(() => { entered(); return new Promise(() => {}) }))
  const rejected = assert.rejects(pending, { code: "aborted" })
  await ready
  await r.drain("session")
  await rejected
  assert.equal(p.log.some(command => ["save", "raw", "execute"].includes(command.method)), false)
  assert.equal(r.diagnostics.export({ sessionID: "session" }).events.length, 0)
})

test("abort during post-approval inspection stops workflow before any save or execution", async t => {
  const controller = new AbortController()
  let approved = false
  const { p, tools } = await fixture(t, { handler(command) {
    if (approved && command.method === "inspect") controller.abort()
  } })
  const args = await scriptArgs(tools)
  await assert.rejects(tools.ae_execute.execute(args, {
    ...context(() => { approved = true }), abort: controller.signal,
  }), { code: "aborted" })
  assert.equal(p.log.some(command => ["save", "raw", "execute"].includes(command.method)), false)
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
