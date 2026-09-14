import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { spawn } from "node:child_process"
import { once } from "node:events"
import vm from "node:vm"
import transport from "../panel/transport.cjs"
import { restoreFixture } from "./bridge-panel.mjs"
import { createRuntime } from "../src/plugin.mjs"
import { createCheckpoints } from "../src/storage.mjs"

test("failed recovery latch publication retains in-memory uncertainty", () => {
  const store = { state: { uncertain: true }, save() { throw Object.assign(new Error("publication failed"), { code: "EIO" }) } }
  const client = new transport.Client({ store, host: {} })
  assert.throws(() => client.mark(false), { code: "EIO" })
  assert.equal(store.state.uncertain, true)
  assert.equal(client.state.uncertain, true)
})

function commandFixture(failOn) {
  const project = { id: "project", path: "c:/project.aep", saved: true }
  const binding = { id: "binding", state: "active", sessionID: "session", project }
  let hostCalls = 0, replies = 0
  const store = { state: { uncertain: false }, save() {
    if (this.state.uncertain === failOn) throw Object.assign(new Error("disk failed"), { code: "EIO" })
  } }
  const client = new transport.Client({ store, host: { call: async () => { hostCalls++; return { ok: true } } },
    request: async (d, credential, endpoint) => {
      if (endpoint === "/reply") { replies++; return { ok: true } }
      assert.equal(endpoint, "/heartbeat")
      return { binding, lock: { state: "executing" } }
    } })
  Object.assign(client.state, { connection: "connected", project, binding, lock: { state: "executing" } })
  return { client, store, counts: () => ({ hostCalls, replies }) }
}

test("latch publication failure before dispatch sends no host command", async () => {
  const f = commandFixture(true)
  await assert.rejects(async () => f.client.command({ id: "cmd", method: "execute", params: {}, sessionID: "session" }), { code: "EIO" })
  await f.client.tick()
  assert.deepEqual(f.counts(), { hostCalls: 0, replies: 0 })
  assert.equal(f.client.state.uncertain, true)
})

test("latch clear failure after acknowledgement never reconnects or repeats the host command", async () => {
  const f = commandFixture(false)
  await assert.rejects(f.client.command({ id: "cmd", method: "execute", params: {}, sessionID: "session" }), { code: "EIO" })
  await f.client.tick()
  assert.deepEqual(f.counts(), { hostCalls: 1, replies: 1 })
  assert.equal(f.store.state.uncertain, true)
  assert.equal(f.client.state.uncertain, true)
})

test("Windows latch retries finish publication before one host dispatch", { skip: process.platform !== "win32" }, async () => {
  const f = commandFixture(null)
  let failures = 2, published = false
  f.store.save = () => {
    if (f.store.state.uncertain && failures-- > 0) throw Object.assign(new Error("sharing violation"), { code: "EPERM" })
    published = f.store.state.uncertain
  }
  const call = f.client.host.call
  f.client.host.call = async (...args) => { assert.equal(published, true); return call(...args) }
  await f.client.command({ id: "cmd", method: "execute", params: {}, sessionID: "session" })
  assert.deepEqual(f.counts(), { hostCalls: 1, replies: 1 })
  assert.equal(f.client.state.uncertain, false)
})

test("exhausted Windows latch retries stay locked after one acknowledged command", { skip: process.platform !== "win32" }, async () => {
  const f = commandFixture(null)
  let attempts = 0
  f.store.save = () => {
    if (!f.store.state.uncertain) { attempts++; throw Object.assign(new Error("sharing violation"), { code: "EPERM" }) }
  }
  await assert.rejects(f.client.command({ id: "cmd", method: "execute", params: {}, sessionID: "session" }), { code: "EPERM" })
  assert.equal(attempts, 10)
  await f.client.tick()
  assert.deepEqual(f.counts(), { hostCalls: 1, replies: 1 })
  assert.equal(f.store.state.uncertain, true)
  assert.equal(f.client.state.uncertain, true)
})

test("a newer recovery latch cannot be cleared by a delayed publication retry", { skip: process.platform !== "win32" }, async () => {
  let clearAttempts = 0, disk = true
  const store = { state: { uncertain: true }, save() {
    if (!this.state.uncertain && ++clearAttempts === 1) throw Object.assign(new Error("sharing violation"), { code: "EPERM" })
    disk = this.state.uncertain
  } }
  const client = new transport.Client({ store, host: {} })
  const clearing = client.persistMark(false)
  client.mark(true)
  await assert.rejects(clearing, { code: "outcome_uncertain" })
  assert.equal(clearAttempts, 1)
  assert.equal(disk, true)
  assert.equal(store.state.uncertain, true)
  assert.equal(client.state.uncertain, true)
})

test("Windows recovery latch sharing violation preserves a production restore review", { skip: process.platform !== "win32" }, async t => {
  let armed = false, store, locker, released = false, inspections = 0
  const f = await restoreFixture(t, { evalScript(code, cb, h) {
    const envelope = JSON.parse(JSON.parse(code.slice("CookieMonsterAE.dispatch(".length, -1)))
    if (!armed || envelope.method !== "inspect" || ++inspections < 2) { cb(vm.runInContext(code, h.context)); return }
    armed = false
    const encoded = Buffer.from(store.file).toString("base64")
    const script = "$ErrorActionPreference='Stop';$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + encoded + "'));$f=[IO.File]::Open($p,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None);[Console]::WriteLine('locked');[Console]::ReadLine();$f.Dispose()"
    locker = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true })
    once(locker.stdout, "data").then(([data]) => {
      assert.match(String(data), /locked/)
      setTimeout(() => { released = true; locker.stdin.end("\n") }, 500)
      cb(vm.runInContext(code, h.context))
    }).catch(error => { throw error })
  } })
  store = f.store
  t.after(() => { if (locker && locker.exitCode === null && locker.signalCode === null) locker.kill() })
  const { p, h, client } = f
  await createRuntime({ factories: { bridge: async () => p.bridge, renderer: async () => ({ list: async () => [], close: async () => {} }) } })
  const checkpoints = createCheckpoints({ dataDir: p.dataDir })
  const checkpoint = await checkpoints.create({ projectPath: h.project.file.fsName, projectId: h.call("inspect").result.project.id, planHash: "latch-lock" })
  await client.heartbeat()
  const scope = client.scope(), errors = [], rename = fs.renameSync
  t.mock.method(fs, "renameSync", (source, target) => {
    try { return rename(source, target) } catch (error) {
      if (target === store.file) errors.push(error.code)
      throw error
    }
  })
  armed = true
  const review = await client.panel("checkpoint.restore.propose", { id: checkpoint.id })
  await f.stop()
  assert.equal(client.inFlight, false)
  assert.ok(errors.includes("EPERM"))
  assert.equal(released, true)
  assert.equal(client.scope(), scope)
  assert.equal(store.state.uncertain, false)
  assert.equal(JSON.parse(fs.readFileSync(store.file, "utf8")).uncertain, false)
  assert.ok(client.restoreApproval, "the completed review remains confirmable after metadata publication")
  assert.match(review.operation, /private emergency copy/)
  assert.equal(h.closes, 0)
  assert.equal(p.bridge.binding(f.sessionID).lock, null)
})
