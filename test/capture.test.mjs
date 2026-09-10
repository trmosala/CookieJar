import test from "node:test"
import assert from "node:assert/strict"
import { imageAttachment, capture } from "../src/capture.mjs"
import { createWorkflow } from "../src/workflow.mjs"
import { createCheckpoints, createGrants } from "../src/storage.mjs"
import { panelFixture, simulatedHost } from "./bridge-panel.mjs"
import { hostDouble } from "./workflow-host.mjs"

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg=="
const result = () => ({ mime: "image/png", data: png, width: 1, height: 1 })

test("capture attachment validates actual PNG/JPEG headers, canonical base64, dimensions and alpha", () => {
  assert.deepEqual(imageAttachment(result()), { type: "file", mime: "image/png", url: "data:image/png;base64," + png, filename: "ae-frame.png" })
  for (const bad of [{ ...result(), path: "C:/secret.png" }, { ...result(), data: png + "\n" },
    { ...result(), width: 2 }, { ...result(), data: Buffer.from("not an image").toString("base64") },
    { ...result(), data: "A".repeat(4 * Math.ceil(5 * 1024 * 1024 / 3) + 4) }])
    assert.throws(() => imageAttachment(bad), { code: "invalid_capture" })
  const huge = Buffer.from(png, "base64"); huge.writeUInt32BE(2001, 16)
  assert.throws(() => imageAttachment({ ...result(), data: huge.toString("base64") }), { code: "invalid_capture" })
  const jpeg = Buffer.from([0xff,0xd8,0xff,0xc0,0,11,8,0,1,0,1,1,1,0x11,0,0xff,0xda,0,8,1,1,0,0,63,0,1,0xff,0xd9])
  const jpg = { mime: "image/jpeg", data: jpeg.toString("base64"), width: 1, height: 1 }
  assert.equal(imageAttachment(jpg, false).mime, "image/jpeg")
  assert.throws(() => imageAttachment(jpg), { code: "invalid_capture" })
  jpeg.writeUInt16BE(2500, 7)
  assert.throws(() => imageAttachment({ ...jpg, data: jpeg.toString("base64") }, false), { code: "invalid_capture" })
})

test("capture adapter refuses missing native capability without touching the queue or retaining a lock", async t => {
  const p = await panelFixture(t), host = hostDouble(p.state.project.path)
  Object.assign(p.state, host.call("inspect").result)
  await p.heartbeat()
  await p.bridge.bind("session", p.connectionId)
  const workflow = createWorkflow({ bridge: p.bridge, checkpoints: createCheckpoints({ dataDir: p.dataDir }), grants: createGrants() })
  let queueTouches = 0
  host.project.renderQueue.items = { add() { queueTouches++; throw Error("Queue must not be touched") } }
  await p.start(command => {
    const response = host.call(command.method, command.params)
    if (response.error) throw Object.assign(new Error(response.error.message), { code: response.error.code })
    return response.result
  })
  await assert.rejects(capture({ bridge: p.bridge, workflow }, "session", { compId: 1, time: 0 }, async () => {}),
    error => error.code === "unsupported_capability")
  assert.equal(queueTouches, 0)
  assert.equal(p.log.filter(command => command.method === "capture").length, 1)
  assert.equal(p.bridge.binding("session").lock, null)
})

test("real bridge capture locks before dispatch, refuses stale approval, and retains ambiguous outcomes", async t => {
  const p = await panelFixture(t, { timeoutMs: 300 })
  p.state.items = [{ id: 1, kind: "comp", name: "Frame", duration: 2, frameRate: 25 }]
  Object.assign(p.state, { revision: 1, projectEpoch: "capture-project", aeVersion: "26.0", fingerprint: "capture", nextCursor: null })
  const workflow = createWorkflow({ bridge: p.bridge, checkpoints: createCheckpoints({ dataDir: p.dataDir }), grants: createGrants() })
  let mode = "ok", dispatched = 0
  await p.start(async command => {
    if (command.method !== "capture") {
      if (command.method === "inspect") assert.deepEqual(command.params, { query: { compId: 1, depth: 0 } })
      return simulatedHost(command, p)
    }
    dispatched++
    assert.equal(p.bridge.binding("session", { allowLocked: true }).lock.state, "executing")
    if (mode === "timeout") return undefined
    if (mode === "bad") return { ...result(), width: 2 }
    if (mode === "drift") { p.state.revision++; return result() }
    if (mode !== "ok") throw Object.assign(new Error("Capture unavailable"), { code: mode })
    assert.deepEqual(command.params, { compId: 1, time: 0, alpha: true, maxWidth: 2000,
      expectedRevision: p.state.revision, expectedEpoch: p.state.projectEpoch,
      expectedProject: { id: p.state.project.id, path: p.state.project.path } })
    return result()
  })
  const run = ask => capture({ bridge: p.bridge, workflow }, "session", { compId: 1, time: 0 }, ask)
  await assert.rejects(run(), { code: "permission_required" })
  await assert.rejects(run(async () => false), { code: "permission_denied" })
  for (const maxWidth of [0, 2001, 1.5])
    await assert.rejects(capture({ bridge: p.bridge, workflow }, "session", { compId: 1, time: 0, maxWidth }, async () => {}), { name: "ZodError" })
  await assert.rejects(run(async () => { p.state.revision++ }), { code: "stale_fingerprint" })
  await assert.rejects(run(async () => { p.state.projectEpoch = "reopened" }), { code: "stale_fingerprint" })
  assert.equal(dispatched, 0)
  const output = await run(async () => {})
  assert.equal(output.attachments[0].type, "file")
  assert.equal(p.bridge.binding("session").lock, null)
  for (const code of ["unsafe_state", "busy", "unsupported_capability"]) {
    mode = code
    await assert.rejects(run(async () => {}), { code })
    assert.equal(p.bridge.binding("session").lock, null)
  }
  p.state.capabilities.fileNetwork = false
  await p.heartbeat()
  await assert.rejects(run(async () => {}), { code: "capability_missing" })
  p.state.capabilities.fileNetwork = true
  await p.heartbeat()
  mode = "bad"
  await assert.rejects(run(async () => {}), { code: "invalid_capture" })
  assert.ok(p.bridge.binding("session", { allowLocked: true }).lock)
  await p.bridge.unlock("session")
  mode = "drift"
  await assert.rejects(run(async () => {}), { code: "stale_fingerprint" })
  assert.equal(p.bridge.binding("session", { allowLocked: true }).lock.state, "uncertain")
  await p.bridge.unlock("session")
  mode = "timeout"
  await assert.rejects(run(async () => {}), { code: "outcome_uncertain" })
  assert.equal(p.bridge.binding("session", { allowLocked: true }).lock.state, "uncertain")
})
