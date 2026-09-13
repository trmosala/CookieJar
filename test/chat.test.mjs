import test from "node:test"
import assert from "node:assert/strict"
import { createChat } from "../src/chat.mjs"
import { panelFixture } from "./bridge-panel.mjs"

async function fixture(t) {
  const p = await panelFixture(t)
  await p.bridge.release("session")
  const calls = [], statuses = {}, messages = [], inputs = [], sessions = new Map()
  let counter = 0, admitted
  const selections = {}, catalog = { all: [{ id: "test", name: "Test", models: { sol: { id: "sol", name: "Sol", variants: { high: {}, low: {} } }, fast: { id: "fast", name: "Fast" } } }], connected: ["test"] }
  const client = {
    provider: { async list() { return { data: catalog } } },
    _client: { async post(options) { calls.push(["model", options]); selections[options.path.sessionID] = options.body.model; return {} } },
    session: {
      async get(options) { const session = sessions.get(options.path.id); return session ? { data: { ...session, model: selections[options.path.id] } } : { response: { status: 404 } } },
      async create(options) { calls.push(["create", options]); const session = { id: "ses_chat" + (++counter), title: options.body.title, directory: options.query.directory, time: { updated: counter } }; sessions.set(session.id, session); return { data: session } },
      async update(options) { calls.push(["rename", options]); Object.assign(sessions.get(options.path.id), options.body); return { data: sessions.get(options.path.id) } },
      async status() { return { data: statuses } },
      async messages() { return { data: messages } },
      async abort(options) { calls.push(["abort", options]); return { data: true } },
      async promptAsync(options) { calls.push(["prompt", options]); inputs.push(options); if (admitted) await admitted(); return { data: undefined } },
    },
    async postSessionIdPermissionsPermissionId(options) { calls.push(["permission", options]); return { data: true } },
  }
  const runtime = { dataDir: p.dataDir, bridge: p.bridge, checkpoints: { async list() { return [] } }, workflow: { async inspectQuery(sessionID, query) {
    assert.equal(p.bridge.binding(sessionID).connectionId, p.connectionId)
    return { items: [{ id: query.compId || 1, kind: "comp", name: "Main" }] }
  } } }
  const chat = await createChat(runtime)
  chat.register({ client, directory: p.dataDir })
  p.bridge.setChatHandler(chat.handle)
  const send = async (body = {}) => {
    const response = await p.send("/chat", { action: "state", project: p.state.project, ...body })
    if (response.status !== 200) throw Object.assign(new Error(response.body.error.message), response.body.error)
    return response.body.result
  }
  return { p, chat, runtime, client, catalog, selections, calls, inputs, messages, statuses, sessions, send, set admitted(fn) { admitted = fn } }
}
test("target search and reference submission use fixed server-validated IDs without prompt replay",async t=>{
  const f=await fixture(t)
  let layerName="Title"
  f.runtime.workflow.inspectQuery=async()=>({projectEpoch:"e",revision:1,items:[{id:1,kind:"comp",name:"Main",layers:[{id:5,name:layerName}]}],nextCursor:null})
  const found=await f.send({action:"targets",compId:1,search:"Title",cursor:null})
  assert.equal(found.targets[0].layerId,5);assert.equal(f.inputs.length,0)
  const {selected,...ref}=found.targets[0]
  const sent=await f.send({...message({compId:1}),references:[ref]})
  assert.equal(sent.delivery,"accepted");assert.match(f.inputs[0].body.system,/"layerId":5/)
  layerName="Renamed"
  await assert.rejects(f.send({...message({compId:1,requestId:"b".repeat(40)}),references:[ref]}),{code:"stale_target"})
  assert.equal(f.inputs.length,1)
})

test("composer capture binds an idle owned session without submitting a prompt", async t => {
  const f = await fixture(t)
  const first = await f.send({ action: "captureBind", expectedSessionID: null })
  assert.equal(first.bound, true)
  assert.equal(f.inputs.length, 0)
  assert.equal(f.p.bridge.binding(first.sessionID).connectionId, f.p.connectionId)
  assert.equal((await f.send({ action: "captureBind", expectedSessionID: first.sessionID })).sessionID, first.sessionID)
  assert.equal(f.calls.filter(c => c[0] === "create").length, 1)
  f.statuses[first.sessionID] = { type: "busy" }
  await assert.rejects(f.send({ action: "captureBind", expectedSessionID: first.sessionID }), { code: "chat_busy" })
  assert.equal(f.inputs.length, 0)
})

test("project conversations reopen and rename through CM after reload without replay or target loss", async t => {
  const f = await fixture(t), first = await f.send(message({ compId: 3 }))
  const second = await f.send({ action: "new" })
  await f.send(message({ compId: 7, requestId: "b".repeat(40) }))
  const reloaded = await createChat(f.runtime)
  reloaded.register({ client: f.client, directory: f.p.dataDir })
  f.p.bridge.setChatHandler(reloaded.handle)
  for (const [session, title, target] of [[first, "Logo timing", 3], [second, "Title motion", 7]]) {
    await f.send({ action: "rename", sessionID: session.sessionID, directory: f.p.dataDir, title })
    const opened = await f.send({ action: "reopen", sessionID: session.sessionID, directory: f.p.dataDir })
    assert.equal(opened.targetCompId, target)
    assert.equal((await f.send()).title, title)
    assert.equal((await f.send()).targetCompId, target)
  }
  assert.equal(f.inputs.length, 2)
  assert.equal(f.calls.filter(c => c[0] === "rename").length, 2)
  f.client.session.update = async () => ({ data: {} })
  await assert.rejects(f.send({ action: "rename", sessionID: first.sessionID, directory: f.p.dataDir, title: "Ignored update" }), { code: "chat_backend" })
  assert.throws(() => reloaded.checkSession(first.sessionID), { code: "chat_closed" })
  // Messages and titles are obtained from CM, never copied into the ownership file.
  const { readFile } = await import("node:fs/promises")
  const stateFile = await readFile(new URL("file:///" + f.p.dataDir.replaceAll("\\", "/") + "/chat-projects.json"), "utf8")
  assert.doesNotMatch(stateFile, /Logo timing|Title motion/)
})

test("conversation search and pages exclude other projects and workspaces and expose missing sessions", async t => {
  const f = await fixture(t)
  for (let i = 0; i < 12; i++) {
    const session = await f.send({ action: "new" })
    f.sessions.get(session.sessionID).title = "Motion " + i
  }
  const page = await f.send({ action: "conversations" })
  assert.equal(page.conversations.length, 10)
  assert.equal(page.nextOffset, 10)
  assert.equal((await f.send({ action: "conversations", offset: 10 })).conversations.length, 2)
  assert.equal((await f.send({ action: "conversations", search: "Motion 11" })).total, 1)
  const old = page.conversations[1]
  f.sessions.delete(old.sessionID)
  assert.equal((await f.send({ action: "conversations", offset: 10 })).conversations.find(c => c.sessionID === old.sessionID)?.missing, true)
  await assert.rejects(f.send({ action: "reopen", sessionID: old.sessionID, directory: old.directory }), { code: "chat_missing" })
  await assert.rejects(f.send({ action: "rename", sessionID: "foreign", directory: f.p.dataDir, title: "No" }), { code: "chat_ownership" })
  await assert.rejects(f.send({ action: "reopen", sessionID: page.conversations[0].sessionID, directory: "D:\\other" }), { code: "chat_ownership" })
  f.p.state.project = { ...f.p.state.project, id: "another", path: f.p.state.project.path + ".other" }
  await f.p.heartbeat()
  assert.equal((await f.send({ action: "conversations" })).total, 0)
  await assert.rejects(f.send({ action: "reopen", sessionID: page.conversations[0].sessionID, directory: f.p.dataDir }), { code: "chat_ownership" })
})

test("conversation switching rejects busy, unresolved and stale actions without aborting or creating", async t => {
  const f = await fixture(t), first = await f.send(message())
  f.statuses[first.sessionID] = { type: "busy" }
  await assert.rejects(f.send({ action: "new" }), { code: "chat_busy" })
  assert.equal(f.calls.filter(c => c[0] === "create").length, 1)
  assert.equal(f.calls.filter(c => c[0] === "abort").length, 0)
  f.statuses[first.sessionID] = { type: "idle" }
  await f.chat.recordRestore(first.sessionID, { status: "unconfirmed" })
  await assert.rejects(f.send({ action: "new" }), { code: "chat_busy" })
  await f.chat.recordReconciliation(first.sessionID)
  const second = await f.send({ action: "new", expectedSessionID: first.sessionID })
  f.statuses[first.sessionID] = { type: "busy" }
  await assert.rejects(f.send({ action: "reopen", sessionID: first.sessionID, directory: f.p.dataDir }), { code: "chat_busy" })
  f.statuses[first.sessionID] = { type: "idle" }
  await assert.rejects(f.send({ action: "new", expectedSessionID: first.sessionID }), { code: "stale_session" })
  f.admitted = () => { throw new Error("Connection lost") }
  await f.send(message({ requestId: "b".repeat(40) }))
  await assert.rejects(f.send({ action: "reopen", sessionID: first.sessionID, directory: f.p.dataDir }), { code: "chat_busy" })
  await assert.rejects(f.send({ action: "new" }), { code: "chat_busy" })
  assert.equal((await f.send()).sessionID, second.sessionID)
})

test("late history and state responses cannot be admitted after reopening another conversation", async t => {
  const f = await fixture(t), first = await f.send({ action: "new" })
  await f.send({ action: "new" })
  let release, entered
  const ready = new Promise(resolve => { entered = resolve })
  f.client.session.messages = async () => { entered(); await new Promise(resolve => { release = resolve }); return { data: [] } }
  const pending = f.send({ action: "history", before: "cursor" })
  const rejected = assert.rejects(pending, { code: "stale_session" })
  await ready
  await f.send({ action: "reopen", sessionID: first.sessionID, directory: f.p.dataDir })
  release()
  await rejected
})

test("selected skills retain native prompt context, dedup identity, errors and truthful load metadata", async t => {
  const f = await fixture(t)
  const metadata = { name: "brand-motion", source: "b".repeat(64), revision: "c".repeat(64) }
  f.client._client.get = async options => {
    assert.equal(options.url, "/skill/catalog")
    return { data: [{ ...metadata, description: "Brand motion", content: "Must not reach picker" }] }
  }
  const post = f.client._client.post
  f.client._client.post = async options => {
    if (options.url !== "/skill/validate") return post(options)
    assert.deepEqual(options.body, metadata)
    return { data: metadata }
  }
  const catalog = await f.send({ action: "skills", directory: f.p.dataDir })
  assert.equal(catalog.skills[0].content, undefined)
  const skill = { ...metadata, directory: catalog.directory, sessionID: catalog.sessionID }
  const sent = await f.send(message({ skill, directory: catalog.directory }))
  assert.deepEqual(f.inputs[0].body.parts[0].metadata.cmSkill, metadata)
  assert.match(f.inputs[0].body.system, /After Effects chat panel/)
  assert.equal(f.inputs[0].body.tools.question, false)
  assert.equal(f.inputs[0].body.parts[1].synthetic, true)
  await f.send(message({ skill, directory: catalog.directory }))
  assert.equal(f.inputs.length, 1)
  await assert.rejects(f.send(message({ skill: { ...skill, revision: "d".repeat(64) } })), { code: "invalid_payload" })
  await assert.rejects(f.send(message({ requestId: "b".repeat(40), skill })), { code: "stale_skill" })
  f.client._client.post = async () => ({ error: { data: { message: "Skill changed" } } })
  await assert.rejects(f.send(message({ requestId: "b".repeat(40), skill: { ...skill, sessionID: sent.sessionID } })), { code: "skill_error" })
  assert.equal(f.inputs.length, 1)
  f.messages.push({ info: { id: "loaded", role: "assistant", time: { completed: 1 } }, parts: [
    { type: "text", text: "I loaded brand-motion" },
    { type: "tool", tool: "skill", state: { status: "error", metadata: { name: "failed", dir: "." } } },
    { type: "tool", tool: "skill", state: { status: "completed", metadata: { ...metadata, dir: "." } } },
  ] })
  const displayed = (await f.send()).messages[0].parts.filter(p => p.type === "skill")
  assert.equal(displayed.length, 1)
  assert.equal(displayed[0].name, metadata.name)
})

test("skill saves require exact review and never resubmit an uncertain create", async t => {
  const f = await fixture(t)
  const session = await f.send(message())
  const draft = { name: "brand-motion", description: "Brand motion", instructions: "Keep logo fixed", scope: "workspace" }
  let creates = 0
  f.client._client.get = async () => ({ data: [] })
  f.client._client.post = async options => {
    if (options.url === "/skill/review") return { data: { token: "review", digest: "d".repeat(64),
      directory: f.p.dataDir, destination: "SKILL.md", scope: draft.scope } }
    creates++
    throw new Error("Connection lost")
  }
  const body = { draft, sessionID: session.sessionID, directory: f.p.dataDir }
  await assert.rejects(f.send({ action: "skillSave", ...body, token: "review" }), { code: "stale_review" })
  await f.send({ action: "skillReview", ...body })
  await assert.rejects(f.send({ action: "skillSave", ...body, token: "review", draft: { ...draft, instructions: "Other" } }), { code: "stale_review" })
  await assert.rejects(f.send({ action: "skillSave", ...body, token: "review" }), { code: "skill_save_unknown" })
  await assert.rejects(f.send({ action: "skillSave", ...body, token: "review" }), { code: "stale_review" })
  assert.equal(creates, 1)
  await f.send({ action: "new" })
  await assert.rejects(f.send({ action: "skillReview", ...body }), { code: "stale_session" })
})

test("skills never fall back to a sole unrelated CM workspace", async t => {
  const f = await fixture(t)
  const unregister = f.chat.register({ client: f.client, directory: "Z:\\\\unrelated" })
  f.p.state.project = { ...f.p.state.project, id: "foreign", path: "Z:\\\\another\\\\scene.aep" }
  await f.p.send("/heartbeat", { project: f.p.state.project, capabilities: f.p.state.capabilities, busy: false })
  f.client._client.get = async () => ({ data: [] })
  await assert.rejects(f.send({ action: "skills" }), { code: "chat_workspace" })
  assert.equal((await f.send({ action: "skills", directory: "Z:\\\\unrelated" })).directory, "Z:\\\\unrelated")
  unregister()
})

const message = (extra = {}) => ({ action: "send", text: "Make this title blue", compId: 1, requestId: "a".repeat(40), ...extra })

test("history uses the server cursor and the current scoped session, returning bounded formatted pages", async t => {
  const f = await fixture(t)
  await f.send(message())
  f.client.session.messages = async options => {
    assert.equal(options.path.id, "ses_chat1")
    assert.equal(options.query.limit, 60)
    const older = options.query.before === "cursor-next"
    return { data: [{ info: { id: older ? "old" : "new", role: "assistant" }, parts: [{ id: "text", type: "text", text: "**formatted**" }] }],
      response: { headers: { get: () => older ? null : "cursor-next" } } }
  }
  const state = await f.send()
  assert.equal(state.nextCursor, "cursor-next")
  assert.equal(state.messages[0].parts[0].markdown[0].children[0].tag, "strong")
  const page = await f.send({ action: "history", before: state.nextCursor })
  assert.equal(page.messages[0].id, "old")
  assert.equal(page.nextCursor, null)
  await assert.rejects(f.send({ action: "history", before: "" }), { code: "invalid_payload" })
})

test("temporary restore project polls never release the pending conversation", async t => {
  const f = await fixture(t)
  const sent = await f.send(message())
  await f.chat.recordRestore(sent.sessionID, { status: "pending", checkpointId: "cp-source" })
  const before = f.calls.filter(c => c[0] === "abort").length
  await assert.rejects(f.chat.handle({ body: { action: "state" },
    project: { ...f.p.state.project, path: f.p.state.project.path + ".emergency.aep" },
    panelId: "test-panel", connectionId: f.p.connectionId, check() {} }), { code: "restore_in_progress" })
  assert.equal(f.calls.filter(c => c[0] === "abort").length, before)
  assert.equal(f.p.bridge.binding(sent.sessionID).state, "active")
  assert.equal((await f.send()).restore.status, "pending")
})

test("model selection uses CM session configuration, survives reopening and reaches prompts", async t => {
  const f = await fixture(t)
  assert.equal((await f.send({ action: "models" })).models.length, 2)
  const model = { providerID: "test", id: "sol", variant: "high" }
  assert.deepEqual((await f.send({ action: "model", model })).model, model)
  const state = await f.send()
  assert.deepEqual(state.model, model)
  const reopened = await createChat(f.runtime)
  reopened.register({ client: f.client, directory: f.p.dataDir })
  f.p.bridge.setChatHandler(reopened.handle)
  assert.deepEqual((await f.send()).model, model)
  await f.send(message())
  assert.deepEqual(f.inputs[0].body.model, { providerID: "test", modelID: "sol" })
  assert.equal(f.inputs[0].body.variant, "high")
  assert.equal(f.calls.find(c => c[0] === "model")[1].url, "/api/session/{sessionID}/model")
})

test("unavailable and busy model changes are rejected without modifying the selection", async t => {
  const f = await fixture(t), model = { providerID: "test", id: "sol", variant: "high" }
  await assert.rejects(f.send({ action: "model", model: { ...model, variant: "ultra" } }), { code: "reasoning_unavailable" })
  assert.equal(f.calls.length, 0)
  await f.send({ action: "model", model })
  const state = await f.send()
  f.statuses[state.sessionID] = { type: "busy" }
  await assert.rejects(f.send({ action: "model", model: { ...model, variant: "low" } }), { code: "chat_busy" })
  f.statuses[state.sessionID] = { type: "idle" }
  f.catalog.connected = []
  assert.deepEqual((await f.send({ action: "models" })).models, [])
  await assert.rejects(f.send(message()), { code: "model_unavailable" })
  assert.equal(f.inputs.length, 0)
  assert.deepEqual((await f.send()).model, model)
  f.catalog.connected = ["test"]
  delete f.catalog.all[0].models.sol.variants.high
  await assert.rejects(f.send(message()), { code: "reasoning_unavailable" })
  await f.send({ action: "model", model: { providerID: "test", id: "fast" } })
  assert.equal((await f.send()).model.variant, "default")
})

test("panel chat uses CM sessions, fixes the message target, avoids duplicate admission and restores project history", async t => {
  const f = await fixture(t)
  assert.equal((await f.send()).sessionID, null)
  const sent = await f.send(message())
  assert.equal(sent.delivery, "accepted")
  assert.equal(f.inputs.length, 1)
  assert.match(f.inputs[0].body.system, /"id":1,"name":"Main"/)
  assert.equal(f.inputs[0].body.parts[0].text, "Make this title blue")
  assert.equal(f.inputs[0].body.tools.question, false)
  await f.send(message())
  assert.equal(f.inputs.length, 1)
  await assert.rejects(f.send(message({ text: "Different" })), { code: "invalid_payload" })
  f.messages.push({ info: { id: "msg_assistant", role: "assistant" }, parts: [{ type: "text", text: "Here is the frame" },
    { type: "tool", tool: "ae_capture", state: { status: "completed", output: JSON.stringify({compId:1,time:2.5}), attachments: [{ url: "data:image/png;base64,AAAA", filename: "frame.png" }] } }] })
  const state = await f.send()
  assert.equal(state.messages[0].parts[2].type, "image")
  assert.equal(state.messages[0].parts[2].compId, 1)
  assert.equal(state.messages[0].parts[2].time, 2.5)
  const reopened = await createChat(f.runtime)
  reopened.register({ client: f.client, directory: f.p.dataDir })
  f.p.bridge.setChatHandler(reopened.handle)
  assert.equal((await f.send()).sessionID, sent.sessionID)
  assert.equal(f.calls.filter(c => c[0] === "create").length, 1)
})

test("new chat retires the old tool scope, and deleted CM sessions can be recreated", async t => {
  const f = await fixture(t), first = await f.send(message())
  f.chat.checkSession(first.sessionID)
  const fresh = await f.send({ action: "new" })
  assert.notEqual(first.sessionID, fresh.sessionID)
  assert.throws(() => f.chat.checkSession(first.sessionID), { code: "chat_closed" })
  await f.chat.event({ type: "session.deleted", properties: { info: { id: fresh.sessionID } } })
  assert.equal((await f.send()).missing, true)
  await assert.rejects(f.send(message({ requestId: "c".repeat(40) })), { code: "chat_missing" })
  const next = await f.send({ action: "new" })
  assert.notEqual(next.sessionID, fresh.sessionID)
})

test("inline permissions are scoped, exact, once-only and disappear after reply", async t => {
  const f = await fixture(t), sent = await f.send(message())
  f.chat.event({ type: "permission.asked", properties: { id: "per_one", sessionID: sent.sessionID, permission: "ae_execute", metadata: { source: "return 1;", project: f.p.state.project } } })
  f.chat.event({ type: "permission.asked", properties: { id: "per_foreign", sessionID: "elsewhere", metadata: { secret: true } } })
  const state = await f.send()
  assert.equal(state.permissions.length, 1)
  assert.match(state.permissions[0].details, /return 1;/)
  await assert.rejects(f.send({ action: "permission", permissionId: "per_foreign", response: "once" }), { code: "stale_permission" })
  await assert.rejects(f.send({ action: "permission", permissionId: "per_one", response: "always" }), { code: "invalid_payload" })
  await f.send({ action: "permission", permissionId: "per_one", response: "once" })
  assert.equal((await f.send()).permissions.length, 0)
  assert.equal(f.calls.find(c => c[0] === "permission")[1].path.id, sent.sessionID)
})

test("native skill permission events expose the requested name even with empty metadata", async t => {
  const f = await fixture(t), sent = await f.send(message())
  for (const metadata of [{}, { name: "brand-motion", source: "b".repeat(64), revision: "c".repeat(64) }]) {
    f.chat.event({ type: "permission.asked", properties: {
      id: "per_skill", sessionID: sent.sessionID, permission: "skill",
      patterns: ["brand-motion"], always: ["brand-motion"], metadata,
    } })
    const approval = (await f.send()).permissions[0]
    assert.equal(approval.title, "skill")
    assert.equal(approval.reviewable, true)
    assert.match(approval.details, /brand-motion/)
    if (metadata.revision) assert.match(approval.details, new RegExp(metadata.revision))
    f.chat.event({ type: "permission.replied", properties: { sessionID: sent.sessionID, requestID: "per_skill" } })
  }
})

test("chat never silently takes another conversation and project switches select separate sessions", async t => {
  const f = await fixture(t)
  await f.p.bridge.bind("elsewhere", f.p.connectionId)
  await assert.rejects(f.send(message()), { code: "binding_owned" })
  assert.equal(f.inputs.length, 0)
  const first = await f.send(message({ takeover: true }))
  const original = f.p.state.project
  f.p.state.project = { ...original, id: "second", path: original.path + ".second.aep" }
  await f.p.send("/heartbeat", { project: f.p.state.project, capabilities: f.p.state.capabilities, busy: false })
  assert.equal((await f.send()).sessionID, null)
  assert.throws(() => f.chat.checkSession(first.sessionID), { code: "not_bound" })
  const second = await f.send(message({ requestId: "b".repeat(40) }))
  assert.notEqual(first.sessionID, second.sessionID)
  assert.ok(f.calls.some(c => c[0] === "abort" && c[1].path.id === first.sessionID))
})

test("unknown prompt delivery is not resent; invalid payload and foreign project are rejected", async t => {
  const f = await fixture(t)
  f.admitted = () => { throw new Error("Connection lost after dispatch") }
  assert.equal((await f.send(message())).delivery, "unknown")
  assert.equal((await f.send(message())).delivery, "unknown")
  assert.equal(f.inputs.length, 1)
  await assert.rejects(f.send(message({ requestId: "x", compId: -1 })), { code: "invalid_payload" })
  await assert.rejects(f.send({ project: { ...f.p.state.project, id: "foreign" } }), { code: "stale_project" })
})

test("Stop also aborts a prompt whose admission finishes after cancellation", async t => {
  const f = await fixture(t)
  let entered, finish
  const ready = new Promise(resolve => { entered = resolve })
  f.admitted = () => { entered(); return new Promise(resolve => { finish = resolve }) }
  const sending = f.send(message())
  await ready
  const stopping = f.send({ action: "stop" })
  finish()
  await Promise.all([sending, stopping])
  assert.ok(f.calls.filter(c => c[0] === "abort").length >= 2)
})

test("oversized approval cannot be accepted from an incomplete panel preview", async t => {
  const f = await fixture(t), sent = await f.send(message())
  f.chat.event({ type: "permission.asked", properties: { id: "large", sessionID: sent.sessionID, metadata: { source: "x".repeat(300001) } } })
  assert.equal((await f.send()).permissions[0].reviewable, false)
  await assert.rejects(f.send({ action: "permission", permissionId: "large", response: "once" }), { code: "approval_too_large" })
  await f.send({ action: "permission", permissionId: "large", response: "reject" })
})


test("references arrive as CM file parts and are included in delivery identity", async t => {
  const f = await fixture(t)
  const attachments = [{filename:"brief.txt", mime:"text/plain", url:"data:text/plain;base64,SGVsbG8="}]
  await f.send(message({attachments}))
  assert.deepEqual(f.inputs[0].body.parts[1], {type:"file", ...attachments[0]})
  await f.send(message({attachments}))
  assert.equal(f.inputs.length, 1)
  await assert.rejects(f.send(message({attachments:[{...attachments[0],filename:"other.txt"}]})), {code:"invalid_payload"})
  await assert.rejects(f.send(message()), {code:"invalid_payload"})
})

test("invalid references are rejected before creating or submitting a conversation", async t => {
  const f = await fixture(t)
  const file = {filename:"brief.txt", mime:"text/plain", url:"data:text/plain;base64,SGVsbG8="}
  for (const attachments of [{}, Array(5).fill(file), [{...file,mime:"text/html"}], [{...file,url:"file:///private"}],
    [{...file,filename:"../brief.txt"}], [{...file,url:"data:text/plain;base64,????"}]]) {
    await assert.rejects(f.send(message({attachments})), {code:"invalid_payload"})
  }
  const large={...file,url:"data:text/plain;base64,"+Buffer.alloc(5500000).toString("base64")}
  await assert.rejects(f.send(message({attachments:[large,large]})), {code:"payload_too_large"})
  assert.equal(f.calls.length,0)
})


test("completed edits expose only their actual pre-edit checkpoint and restore state survives reopening", async t => {
  const f = await fixture(t), sent = await f.send(message())
  const queries = []
  const inspectQuery = f.runtime.workflow.inspectQuery
  f.runtime.workflow.inspect = () => assert.fail("Chat context must not read a full scene")
  f.runtime.workflow.inspectRestore = () => assert.fail("Chat context is separate from restore guards")
  f.runtime.workflow.inspectQuery = (sessionID, query) => {
    queries.push(query); return inspectQuery(sessionID, query)
  }
  f.messages.push({ info: {id:"edit",role:"assistant"}, parts:[
    {type:"tool",tool:"ae_execute",state:{status:"completed",output:JSON.stringify({checkpointId:"cp-before",result:"done"})}},
    {type:"text",text:"checkpointId: fake"},
    {type:"tool",tool:"ae_inspect",state:{status:"completed",output:JSON.stringify({checkpointId:"fake"})}},
    {type:"tool",tool:"ae_execute",state:{status:"completed",output:"not JSON"}}
  ]})
  const cards=(await f.send()).messages[0].parts.filter(p=>p.type==="checkpoint")
  assert.deepEqual(cards,[{type:"checkpoint",id:"cp-before",label:"Before this edit"}])
  await f.chat.recordRestore(sent.sessionID,{status:"pending",checkpointId:"cp-before"})
  await assert.rejects(f.send(message({requestId:"b".repeat(40)})),{code:"restore_unconfirmed"})
  await f.chat.recordRestore(sent.sessionID,{status:"completed",checkpointId:"cp-before",currentCheckpointId:"cp-current",recoveryCopy:false})
  const reopened=await createChat(f.runtime);reopened.register({client:f.client,directory:f.p.dataDir});f.p.bridge.setChatHandler(reopened.handle)
  assert.equal((await f.send()).restore.currentCheckpointId,"cp-current")
  assert.deepEqual(queries, [], "restore audit and reopening do not refresh scene context")
  await f.send(message({requestId:"b".repeat(40)}))
  assert.deepEqual(queries, [{ compId: 1, depth: 0 }])
  assert.match(f.inputs.at(-1).body.system,/cp-before/)
  assert.match(f.inputs.at(-1).body.system,/never replay previous edits/)
  f.statuses[sent.sessionID]={type:"busy"}
  await assert.rejects(reopened.assertRestorable(sent.sessionID),{code:"chat_busy"})
})


test("restore reconnects the existing chat without sending or taking another owner", async t => {
  const f=await fixture(t),sent=await f.send(message())
  await f.p.bridge.release(sent.sessionID)
  await f.send({action:"bind"})
  assert.equal(f.p.bridge.binding(sent.sessionID).connectionId,f.p.connectionId)
  assert.equal(f.inputs.length,1)
  await f.p.bridge.release(sent.sessionID)
  await f.p.bridge.bind("other",f.p.connectionId)
  await assert.rejects(f.send({action:"bind"}),{code:"binding_owned"})
})

test("reviewed recovery releases the chat hold without claiming a successful restore", async t => {
  const f=await fixture(t),sent=await f.send(message())
  await f.chat.recordRestore(sent.sessionID,{status:"unconfirmed",checkpointId:"cp-before",emergencyPath:"C:/backup.aep"})
  await assert.rejects(f.send(message({requestId:"c".repeat(40)})),{code:"restore_unconfirmed"})
  await f.chat.recordReconciliation(sent.sessionID)
  const state=await f.send()
  assert.equal(state.restore.status,"reconciled")
  assert.equal(state.restore.emergencyPath,"C:/backup.aep")
  await f.send(message({requestId:"c".repeat(40)}))
  assert.match(f.inputs.at(-1).body.system,/reconciled/)
  assert.match(f.inputs.at(-1).body.system,/never replay previous edits/)
})


test("retry drafts use complete CM messages and send a reviewed new attempt once", async t => {
  const f = await fixture(t)
  const opened = await f.send(message())
  const source = {info:{id:"msg_original",role:"user",sessionID:opened.sessionID},parts:[
    {type:"text",text:"Try this title"},{type:"text",text:"Private synthetic context",synthetic:true},
    {type:"file",filename:"notes.txt",mime:"text/plain",url:"data:text/plain;base64,SGVsbG8="}]}
  f.client.session.message = async options => {assert.equal(options.path.id,opened.sessionID);return {data:source}}
  const draft = await f.send({action:"retryDraft",messageID:source.info.id,expectedSessionID:opened.sessionID})
  assert.equal(draft.text,"Try this title");assert.equal(draft.attachments[0].filename,"notes.txt")
  assert.equal(f.inputs.length,1)
  const retry = message({requestId:"b".repeat(40),text:"Try a smaller title",retryMessageID:source.info.id,expectedSessionID:opened.sessionID,attachments:draft.attachments})
  await f.send(retry);await f.send(retry)
  assert.equal(f.inputs.length,2);assert.match(f.inputs[1].body.system,/never blindly repeat/)
  await assert.rejects(f.send({...retry,retryMessageID:"different"}),{code:"invalid_payload"})
  f.statuses[opened.sessionID]={type:"busy"}
  await assert.rejects(f.send({action:"retryDraft",messageID:source.info.id,expectedSessionID:opened.sessionID}),{code:"chat_busy"})
  f.statuses[opened.sessionID]={type:"idle"}
  source.info.role="assistant"
  await assert.rejects(f.send({action:"retryDraft",messageID:source.info.id,expectedSessionID:opened.sessionID}),{code:"chat_missing"})
  source.info.role="user";source.parts[2].url="file:///missing.txt"
  await assert.rejects(f.send({action:"retryDraft",messageID:source.info.id,expectedSessionID:opened.sessionID}),{code:"invalid_payload"})
  await assert.rejects(f.send({action:"retryDraft",messageID:source.info.id,expectedSessionID:"another"}),{code:"stale_session"})
  assert.equal(f.inputs.length,2)
  source.parts.pop()
  f.admitted=async()=>{throw new Error("Lost acknowledgement")}
  const uncertain=await f.send({...retry,requestId:"c".repeat(40)})
  assert.equal(uncertain.delivery,"unknown")
  await assert.rejects(f.send({action:"retryDraft",messageID:source.info.id,expectedSessionID:opened.sessionID}),{code:"chat_busy"})
})


test("skill management pins exact reviews and never reapplies an uncertain change",async t=>{
 const f=await fixture(t);const opened=await f.send(message())
 const selected={name:"brand",source:"a".repeat(64),revision:"b".repeat(64)}
 const draft={name:"brand",description:"Brand",instructions:"New instructions",scope:"workspace"}
 let applies=0,uncertain=false
 f.client._client.post=async o=>{
   assert.equal(o.url,"/skill/manage")
   if(o.body.action==="apply"){applies++;if(uncertain)throw new Error("Disconnected")}
   return {data:{...selected,content:"Original instructions",location:"skill.md",editable:true,scope:"workspace",token:"c".repeat(64),digest:"d".repeat(64),backup:"backup.bak",deleted:false}}
 }
 f.client._client.get=async()=>({data:[]})
 const call=management=>f.send({action:"skillManage",sessionID:opened.sessionID,management})
 await call({action:"read",selected})
 const review=await call({action:"review",selected,operation:"edit",draft})
 await assert.rejects(call({action:"apply",selected,operation:"edit",draft:{...draft,instructions:"Other"},token:review.token}),{code:"stale_review"})
 await call({action:"apply",selected,operation:"edit",draft,token:review.token})
 await assert.rejects(call({action:"apply",selected,operation:"edit",draft,token:review.token}),{code:"stale_review"})
 await call({action:"review",selected,operation:"edit",draft});uncertain=true
 await assert.rejects(call({action:"apply",selected,operation:"edit",draft,token:review.token}),{code:"skill_save_unknown"})
 await assert.rejects(call({action:"apply",selected,operation:"edit",draft,token:review.token}),{code:"stale_review"})
 assert.equal(applies,2)
})

test("chat admits larger supported attachments without increasing host command limits",async t=>{
 const f=await fixture(t)
 const file={filename:"reference.gif",mime:"image/gif",url:"data:image/gif;base64,"+Buffer.alloc(3*1024*1024,65).toString("base64")}
 assert.equal((await f.send(message({attachments:[file]}))).delivery,"accepted")
 assert.equal(f.inputs[0].body.parts[1].mime,"image/gif")
})
