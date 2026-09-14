import test from "node:test"
import assert from "node:assert/strict"
import { createChat } from "../src/chat.mjs"
import { panelFixture } from "./bridge-panel.mjs"

async function fixture(t) {
  const p = await panelFixture(t)
  await p.bridge.release("session")
  const calls = [], statuses = {}, messages = [], inputs = []
  let counter = 0, admitted
  const selections = {}, catalog = { all: [{ id: "test", name: "Test", models: { sol: { id: "sol", name: "Sol", variants: { high: {}, low: {} } }, fast: { id: "fast", name: "Fast" } } }], connected: ["test"] }
  const client = {
    provider: { async list() { return { data: catalog } } },
    _client: { async post(options) { calls.push(["model", options]); selections[options.path.sessionID] = options.body.model; return {} } },
    session: {
      async get(options) { return { data: { model: selections[options.path.id] } } },
      async create(options) { calls.push(["create", options]); return { data: { id: "ses_chat" + (++counter) } } },
      async status() { return { data: statuses } },
      async messages() { return { data: messages } },
      async abort(options) { calls.push(["abort", options]); return { data: true } },
      async promptAsync(options) { calls.push(["prompt", options]); inputs.push(options); if (admitted) await admitted(); return { data: undefined } },
    },
    async postSessionIdPermissionsPermissionId(options) { calls.push(["permission", options]); return { data: true } },
  }
  const runtime = { dataDir: p.dataDir, bridge: p.bridge, workflow: { async inspectQuery(sessionID, query) {
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
  return { p, chat, runtime, client, catalog, selections, calls, inputs, messages, statuses, send, set admitted(fn) { admitted = fn } }
}
const message = (extra = {}) => ({ action: "send", text: "Make this title blue", compId: 1, requestId: "a".repeat(40), ...extra })

test("workspace defaults require the exact saved project parent, never an ancestor or sole client", async t => {
  const f = await fixture(t)
  f.p.state.project = { id: "nested", path: f.p.dataDir + "/Campaign/title.aep", saved: true }
  await f.p.heartbeat()
  const directory = f.p.dataDir + "/Campaign"
  const state = await f.send()
  assert.equal(state.directory, directory)
  assert.equal(state.suggestedDirectory, directory)
  assert.equal(state.needsWorkspace, true)
  assert.match(state.error, /Open folder .*Campaign.* in CookieMonster/)
  assert.deepEqual((await f.send({ action: "models" })).models, [])
  for (const body of [message(), { action: "new" }, { action: "model", model: { id: "sol", providerID: "test" } }])
    await assert.rejects(f.send(body), { code: "chat_workspace" })
  assert.equal(f.calls.length, 0)
  const queries = []
  f.chat.register({ directory, client: { ...f.client, provider: { async list(options) {
    queries.push(options.query.directory); return { data: f.catalog }
  } } } })
  assert.equal((await f.send()).needsWorkspace, false)
  assert.equal((await f.send({ action: "models" })).models.length, 2)
  await f.send({ action: "model", model: { id: "sol", providerID: "test" } })
  await f.send(message())
  assert.ok(queries.every(dir => dir === directory))
  assert.ok(f.calls.filter(c => ["create", "model", "prompt"].includes(c[0])).every(c => c[1].query.directory === directory))
})

test("unsaved projects require save or explicit selection, which persists for the conversation", async t => {
  const f = await fixture(t)
  f.p.state.project = { id: "unsaved", path: null, saved: false }
  await f.p.heartbeat()
  const state = await f.send()
  assert.equal(state.directory, null)
  assert.match(state.error, /Save.*project or select a workspace/)
  assert.equal((await f.send({ action: "models" })).needsWorkspace, true)
  await assert.rejects(f.send(message()), { code: "chat_workspace" })
  assert.equal(f.calls.length, 0)
  await f.send(message({ directory: f.p.dataDir }))
  assert.equal((await f.send()).directory, f.p.dataDir)
  await f.send({ action: "new" })
  assert.equal((await f.send()).directory, f.p.dataDir)
})

test("explicit selection wins over project defaults and survives new chats and reopening", async t => {
  const f = await fixture(t), directory = f.p.dataDir + "/chosen"
  f.chat.register({ client: f.client, directory })
  assert.equal((await f.send({ directory })).directory, directory)
  await f.send(message({ directory }))
  assert.equal((await f.send({ directory: f.p.dataDir })).directory, directory)
  await assert.rejects(f.send({ action: "new", directory: "/not-open" }), { code: "chat_workspace" })
  assert.equal(f.calls.filter(c => c[0] === "abort").length, 0)
  await f.send({ action: "new" })
  const reopened = await createChat(f.runtime)
  reopened.register({ client: f.client, directory })
  f.p.bridge.setChatHandler(reopened.handle)
  assert.equal((await f.send()).directory, directory)
  assert.equal((await f.send({ action: "models" })).needsWorkspace, false)
})

test("closed workspaces expose recovery state and do not block switching projects", async t => {
  const f = await fixture(t), directory = f.p.dataDir + "/chosen"
  const unregister = f.chat.register({ client: f.client, directory })
  const sent = await f.send(message({ directory }))
  unregister()
  const state = await f.send()
  assert.equal(state.sessionID, sent.sessionID)
  assert.equal(state.directory, directory)
  assert.equal(state.needsWorkspace, true)
  assert.deepEqual((await f.send({ action: "models" })).models, [])
  await assert.rejects(f.send(message({ requestId: "b".repeat(40) })), { code: "chat_workspace" })
  f.p.state.project = { id: "other", path: f.p.dataDir + "/other.aep", saved: true }
  await f.p.heartbeat()
  assert.equal((await f.send()).directory, f.p.dataDir)
  assert.equal((await f.send(message())).delivery, "accepted")
})

test("project folders and titles support macOS, Windows drive paths and UNC paths", async t => {
  const f = await fixture(t)
  for (const [filename, directory] of [
    ["/Users/artist/My Project/title.aep", "/Users/artist/My Project"],
    [String.raw`C:\Projects\My Project\title.aep`, String.raw`C:\Projects\My Project`],
    ["D:/Projects/My Project/title.aep", "D:/Projects/My Project"],
    [String.raw`\\server\share\My Project\title.aep`, String.raw`\\server\share\My Project`],
    ["/title.aep", "/"],
    [String.raw`C:\title.aep`, "C:\\"],
  ]) {
    // Exercise foreign path syntax below the bridge's native-platform validation.
    const project = { id: filename, path: filename, saved: true }
    const send = body => f.chat.handle({ body, project, panelId: filename, connectionId: f.p.connectionId, check() {} })
    f.chat.register({ client: f.client, directory })
    assert.equal((await send({ action: "state" })).directory, directory)
    assert.equal((await send({ action: "models" })).needsWorkspace, false)
    await send({ action: "new" })
    const create = f.calls.filter(c => c[0] === "create").at(-1)[1]
    assert.equal(create.query.directory, directory)
    assert.match(create.body.title, /title\.aep$/)
  }
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
    { type: "tool", tool: "ae_capture", state: { status: "completed", attachments: [{ url: "data:image/png;base64,AAAA", filename: "frame.png" }] } }] })
  const state = await f.send()
  assert.equal(state.messages[0].parts[2].type, "image")
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
  assert.equal((await f.send()).sessionID, null)
  const next = await f.send(message({ requestId: "c".repeat(40) }))
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
  const large={...file,url:"data:text/plain;base64,"+Buffer.alloc(1100000).toString("base64")}
  await assert.rejects(f.send(message({attachments:[large,large]})), {code:"payload_too_large"})
  assert.equal(f.calls.length,0)
})
