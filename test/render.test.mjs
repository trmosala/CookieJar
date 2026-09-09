import test from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { fileURLToPath, pathToFileURL } from "node:url"

const exec = promisify(execFile)
import { setTimeout as delay } from "node:timers/promises"
import { createRenderer } from "../src/render.mjs"
import {
  runWorker, readJob, signature, load, save, exists, sameIdentity,
  createProcessAdapter, outputSpec, collides,
} from "../src/render-worker.mjs"

async function until(check) {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    const result = await check()
    if (result) return result
    await delay(20)
  }
  assert.fail("Timed out waiting for render state")
}

async function setup(t, platform = "win32") {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "cm-ae-render-"))
  const base = await fs.realpath(temporary)
  const output = path.join(base, "output")
  await fs.mkdir(output)
  const cpPath = path.join(base, "checkpoint.aep")
  await fs.writeFile(cpPath, "immutable test checkpoint")
  const cpSignature = await signature(cpPath)
  const checkpoint = {
    id: "cp-1", path: cpPath, projectId: "project-1", projectPath: path.join(base, "live.aep"),
    planHash: "1".repeat(64), createdAt: new Date().toISOString(), size: cpSignature.size,
    hash: cpSignature.hash, verified: true, pinned: false, storageMode: "copy",
  }
  const grantCalls = []
  let allowed = true
  let onCheck = null
  const grants = {
    async check(request) {
      grantCalls.push({ ...request })
      if (onCheck) await onCheck(grantCalls.length)
      if (!allowed || request.sessionID !== "session-secret" || request.bindingID !== "binding-secret" ||
          !(path.dirname(request.path) === output || path.dirname(request.path).startsWith(output + path.sep)) || request.write !== true) {
        const error = new Error("Destination is not granted")
        error.code = "grant_denied"
        throw error
      }
      return request.path
    },
  }
  const checkpoints = {
    async verify(id) {
      assert.equal(id, checkpoint.id)
      return { ...checkpoint }
    },
    async pin() { assert.fail("Renderer must not mutate a shared checkpoint pin") },
  }
  let nextPID = 1000
  const live = new Map()
  const workers = new Map()
  const children = new Map()
  const killed = []
  const adapter = {
    platform,
    async inspect(pid) { return live.get(pid) ?? null },
    async discover(command) {
      return [...live.values()].filter(item => item.command === JSON.stringify(command))
    },
    async launch(jobDir) {
      const identity = { pid: nextPID++, startTime: randomUUID(), executable: "node", command: "worker " + jobDir }
      live.set(identity.pid, identity)
      const context = { identity, jobDir, error: null }
      workers.set(path.basename(jobDir), context)
      const workerAdapter = {
        ...adapter,
        self: async () => identity,
        async start(command) {
          const childIdentity = { pid: nextPID++, startTime: randomUUID(), executable: command.executable, command: JSON.stringify(command) }
          live.set(childIdentity.pid, childIdentity)
          let finish, crash
          const exited = new Promise((resolve, reject) => { finish = resolve; crash = reject })
          children.set(path.basename(jobDir), { identity: childIdentity, finish, crash, command, jobDir, done: false })
          return { pid: childIdentity.pid, identity: childIdentity, exited }
        },
      }
      context.task = runWorker(jobDir, workerAdapter).catch(error => { context.error = error }).finally(() => live.delete(identity.pid))
    },
    async terminate(identity) {
      assert.ok(sameIdentity(identity, await adapter.inspect(identity.pid)), "Never terminate a reused PID")
      killed.push(identity)
      const child = [...children.values()].find(item => item.identity.pid === identity.pid)
      live.delete(identity.pid)
      child.done = true
      child.finish({ code: null, signal: "SIGTERM", error: null, quiescent: true })
      return { requested: true, method: platform === "win32" ? "test-handle" : "test-signal" }
    },
  }
  const options = { dataDir: base, grants, checkpoints, aerenderPath: process.execPath, processAdapter: adapter }
  const services = []
  async function open(overrides = {}) {
    const service = await createRenderer({ ...options, ...overrides })
    services.push(service)
    return service
  }
  const service = await open()
  const input = {
    sessionID: "session-secret", bindingID: "binding-secret", checkpointId: checkpoint.id,
    compId: 42, compName: 'Main "comp"; no shell', startFrame: 1, endFrame: 3,
    renderSettings: "Custom Best", outputModule: "Custom Lossless",
    outputPath: path.join(output, "movie.mov"),
    templates: { renderSettings: ["Custom Best"], outputModules: ["Custom Lossless"] },
  }
  async function started(id) { return until(() => children.get(id)) }
  async function finish(id, { code = 0, names, contents = "rendered bytes", log = "PROGRESS:  0:00:00:03 (3)\n", quiescent = true } = {}) {
    const child = await started(id)
    const job = await readJob(child.jobDir)
    for (const name of names ?? job.expectedOutputs.names) await fs.writeFile(path.join(job.stageDir, name), contents)
    if (log) await fs.appendFile(job.logPath, log)
    if (!child.done) {
      child.done = true
      live.delete(child.identity.pid)
      child.finish({ code, signal: null, error: null, quiescent })
    }
    await workers.get(id).task
    assert.equal(workers.get(id).error, null)
    return job
  }
  t.after(async () => {
    for (const context of workers.values()) {
      await save(path.join(context.jobDir, "cancel.json"), { at: new Date().toISOString(), reason: "test cleanup" })
    }
    for (const child of children.values()) {
      if (!child.done) {
        child.done = true
        live.delete(child.identity.pid)
        child.finish({ code: 1, signal: null, error: null, quiescent: true })
      }
    }
    await Promise.all([...workers.values()].map(item => item.task))
    await Promise.all(services.map(item => item.close()))
    await fs.rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  return {
    base, output, checkpoint, grantCalls, adapter, live, workers, children, killed,
    service, input, open, started, finish,
    revoke() { allowed = false },
    onCheck(callback) { onCheck = callback },
    jobDir(id) { return path.join(base, "render", "jobs", id) },
  }
}

for (const platform of ["win32", "darwin"]) {
  test(`${platform} adapter: immutable launch, close/restart, offline completion and session-free recovery`, async t => {
    const f = await setup(t, platform)
    const job = await f.service.submit(f.input)
    const child = await f.started(job.jobId)
    assert.equal(child.command.executable, await fs.realpath(process.execPath))
    assert.ok(!child.command.args.includes("-reuse"))
    assert.equal(child.command.args[child.command.args.indexOf("-project") + 1], job.checkpoint.path)
    assert.notEqual(job.checkpoint.path, f.checkpoint.path)
    assert.equal(child.command.args[child.command.args.indexOf("-comp") + 1], f.input.compName)
    assert.equal(f.checkpoint.pinned, false)
    assert.equal(job.checkpoint.pinned, true)
    assert.equal(f.grantCalls.length, 2)
    assert.match(job.note, /later edits/)
    const durable = await fs.readFile(path.join(f.jobDir(job.jobId), "manifest.json"), "utf8")
    assert.ok(!durable.includes("session-secret") && !durable.includes("binding-secret"))
    await f.service.close()
    assert.equal(f.killed.length, 0)
    f.revoke()
    const recovered = await f.open()
    assert.equal((await recovered.status(job.jobId)).state, "running")
    await recovered.close()
    await f.finish(job.jobId)
    const offline = await f.open()
    const result = await offline.result(job.jobId)
    assert.equal(result.state, "completed")
    assert.equal(result.verified, true)
    assert.equal(result.outputs.length, 1)
    assert.match(result.outputs[0].hash, /^[a-f0-9]{64}$/)
    assert.equal(await exists(job.reservationPath), false)
    assert.equal((await offline.list()).length, 1)
    await fs.writeFile(result.outputs[0].path, "tampered")
    assert.equal((await offline.result(job.jobId)).verified, false)
  })

  test(`${platform} adapter: installed templates, grants, ranges and collisions are enforced`, async t => {
    const f = await setup(t, platform)
    await assert.rejects(f.service.submit({ ...f.input, outputModule: "Not installed" }), { code: "render_template" })
    await assert.rejects(f.service.submit({ ...f.input, startFrame: 4 }), { code: "invalid_payload" })
    await fs.writeFile(f.input.outputPath, "existing")
    await assert.rejects(f.service.submit(f.input), { code: "render_collision" })
    assert.equal(await fs.readFile(f.input.outputPath, "utf8"), "existing")
    const sequence = { ...f.input, outputPath: path.join(f.output, "frame.[####].png") }
    await fs.writeFile(path.join(f.output, "FRAME.0099.PNG"), "existing frame outside range")
    await assert.rejects(f.service.submit(sequence), { code: "render_collision" })
    f.revoke()
    await assert.rejects(f.service.submit({ ...f.input, outputPath: path.join(f.output, "other.mov") }), { code: "grant_denied" })
    assert.equal(f.workers.size, 0)
  })

  test(`${platform} adapter: recheck grant and collision before launch`, async t => {
    const f = await setup(t, platform)
    f.onCheck(count => { if (count === 2) f.revoke() })
    await assert.rejects(f.service.submit(f.input), { code: "grant_denied" })
    await Promise.all([...f.workers.values()].map(item => item.task))
    assert.equal(f.children.size, 0)
    assert.equal((await f.service.list())[0].state, "cancelled")
  })

  test(`${platform} adapter: concurrent services reserve overlapping destinations`, async t => {
    const f = await setup(t, platform)
    const other = await f.open()
    const results = await Promise.allSettled([
      f.service.submit({ ...f.input, outputPath: path.join(f.output, "a.[##].png") }),
      other.submit({ ...f.input, outputPath: path.join(f.output, "b.mov") }),
    ])
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1)
    assert.equal(results.find(result => result.status === "rejected").reason.code, "render_collision")
    const job = results.find(result => result.status === "fulfilled").value
    await f.finish(job.jobId)
    const statuses = await Promise.all([f.service.status(job.jobId), other.status(job.jobId)])
    assert.ok(statuses.every(status => status.state === "completed"))
  })

  test(`${platform} adapter: defensive progress and sequence verification`, async t => {
    const f = await setup(t, platform)
    const job = await f.service.submit({ ...f.input, outputPath: path.join(f.output, "frame.[####].png") })
    await f.started(job.jobId)
    await fs.appendFile(job.logPath, "100% COMPLETE SUCCESS\nPROGRESS:  0:00:00:99 (999)\nPROGRESS:  0:00:00:02 (2)\nPROGRESS:  0:00:00:03 (3)")
    const status = await f.service.status(job.jobId)
    assert.equal(status.state, "running")
    assert.equal(status.progress.frame, 2)
    assert.equal(status.progress.percent, null)
    assert.equal((await f.service.result(job.jobId)).verified, false)
    await f.finish(job.jobId, { names: ["frame.0001.png", "frame.0003.png"] })
    const failed = await f.service.status(job.jobId)
    assert.equal(failed.state, "failed")
    assert.equal(failed.outputState, "quarantined_partial")
    assert.equal(await exists(path.join(f.output, "frame.0001.png")), false)
    assert.equal(await exists(path.join(job.quarantineDir, "frame.0001.png")), true)
  })

  test(`${platform} adapter: nonzero exit and zero-byte output never succeed`, async t => {
    const f = await setup(t, platform)
    const first = await f.service.submit(f.input)
    await f.finish(first.jobId, { code: 7 })
    assert.equal((await f.service.status(first.jobId)).state, "failed")
    assert.equal(await exists(f.input.outputPath), false)
    const second = await f.service.submit(f.input)
    await f.finish(second.jobId, { contents: "" })
    assert.equal((await f.service.result(second.jobId)).verified, false)
    assert.equal((await f.service.status(second.jobId)).state, "failed")
  })

  test(`${platform} adapter: cancellation after reconnect quarantines confirmed stopped work`, async t => {
    const f = await setup(t, platform)
    const job = await f.service.submit(f.input)
    await f.started(job.jobId)
    await fs.writeFile(path.join(job.stageDir, "movie.mov"), "partial")
    await f.service.close()
    const recovered = await f.open()
    await recovered.cancel(job.jobId)
    const status = await until(async () => {
      const current = await recovered.status(job.jobId)
      return current.state === "cancelled" ? current : null
    })
    assert.equal(f.killed.length, 1)
    assert.equal(status.outputState, "quarantined_partial")
    assert.equal(await exists(f.input.outputPath), false)
    assert.equal(await fs.readFile(path.join(job.quarantineDir, "movie.mov"), "utf8"), "partial")
  })

  test(`${platform} adapter: reused PID cannot be cancelled`, async t => {
    const f = await setup(t, platform)
    const job = await f.service.submit(f.input)
    const child = await f.started(job.jobId)
    await until(() => exists(path.join(f.jobDir(job.jobId), "process.json")))
    f.live.set(child.identity.pid, { ...child.identity, startTime: "new-start", command: "unrelated application" })
    const recovered = await f.open()
    const status = await recovered.status(job.jobId)
    assert.equal(status.state, "unknown")
    assert.equal(status.reason, "process_identity_mismatch")
    await assert.rejects(recovered.cancel(job.jobId), { code: "render_process_identity" })
    assert.equal(f.killed.length, 0)
    assert.equal(await exists(job.reservationPath), true)
  })

  test(`${platform} adapter: missing logs and corrupt manifests remain recoverable unknown records`, async t => {
    const f = await setup(t, platform)
    const job = await f.service.submit(f.input)
    await f.finish(job.jobId)
    await fs.unlink(job.logPath)
    const recovered = await f.open()
    assert.equal((await recovered.result(job.jobId)).state, "unknown")
    await fs.writeFile(path.join(f.jobDir(job.jobId), "manifest.json"), "{broken")
    const corrupted = await f.open()
    const status = (await corrupted.reconcile())[0]
    assert.equal(status.reason, "corrupt_manifest")
    await assert.rejects(corrupted.cancel(job.jobId), { code: "render_process_identity" })
    assert.deepEqual((await corrupted.result(job.jobId)).outputs, [])
  })

  test(`${platform} adapter: missing receipt is not success even with nonempty outputs`, async t => {
    const f = await setup(t, platform)
    const job = await f.service.submit(f.input)
    await f.finish(job.jobId)
    await fs.unlink(path.join(f.jobDir(job.jobId), "receipt.json"))
    if (await exists(path.join(f.jobDir(job.jobId), "exit.json"))) await fs.unlink(path.join(f.jobDir(job.jobId), "exit.json"))
    const recovered = await f.open()
    const status = await recovered.status(job.jobId)
    assert.equal(status.state, "unknown")
    assert.equal((await recovered.result(job.jobId)).verified, false)
    assert.equal(await exists(job.reservationPath), true)
  })
}

test("reused supervisor PID does not hide a matching orphan child after restart", async t => {
  const f = await setup(t)
  const job = await f.service.submit(f.input)
  const child = await f.started(job.jobId)
  await until(() => exists(path.join(f.jobDir(job.jobId), "process.json")))
  await fs.writeFile(path.join(job.stageDir, "movie.mov"), "partial")
  child.crash(new Error("Supervisor lost its exit channel"))
  const worker = f.workers.get(job.jobId)
  await worker.task
  assert.match(worker.error.message, /exit channel/)
  const unrelated = { ...worker.identity, startTime: "reused", command: "unrelated application" }
  f.live.set(unrelated.pid, unrelated)
  await fs.unlink(job.logPath)
  await f.service.close()
  let recovered = await f.open()
  const status = await recovered.status(job.jobId)
  assert.equal(status.state, "running")
  assert.equal(status.controllable, true)
  assert.equal(status.progress.available, false)
  assert.equal(status.progress.percent, null)
  const inspect = f.adapter.inspect
  let childInspection = "matching"
  f.adapter.inspect = async pid => {
    if (pid === unrelated.pid || pid === child.identity.pid && childInspection === "inaccessible") {
      throw Object.assign(new Error("Process identity inaccessible"), { code: "render_process" })
    }
    if (pid === child.identity.pid && childInspection === "absent") return null
    if (pid === child.identity.pid && childInspection === "reused") {
      return { ...child.identity, startTime: "reused-child", command: "unrelated child" }
    }
    return inspect(pid)
  }
  await recovered.close()
  recovered = await f.open()
  assert.equal((await recovered.status(job.jobId)).state, "running")
  assert.equal((await recovered.status(job.jobId)).controllable, true)
  for (const outcome of ["inaccessible", "reused", "absent"]) {
    childInspection = outcome
    const blocked = await recovered.status(job.jobId)
    assert.equal(blocked.state, "unknown", outcome)
    assert.equal(blocked.controllable, false)
    assert.deepEqual(blocked.deliverables, [])
    await assert.rejects(recovered.cancel(job.jobId), { code: "render_process_identity" })
    assert.equal(await exists(path.join(f.jobDir(job.jobId), "cancel.json")), false)
    assert.equal(await exists(job.checkpoint.path), true)
    assert.equal(await exists(job.reservationPath), true)
    assert.deepEqual(f.killed, [])
  }
  childInspection = "matching"
  await recovered.cancel(job.jobId)
  assert.deepEqual(f.killed, [child.identity])
  assert.deepEqual(f.live.get(unrelated.pid), unrelated)
  const final = await recovered.status(job.jobId)
  assert.equal(final.state, "unknown")
  assert.deepEqual(final.deliverables, [])
  assert.equal(await exists(job.checkpoint.path), true)
  assert.equal(await exists(job.reservationPath), true)
  assert.equal(await fs.readFile(path.join(job.stageDir, "movie.mov"), "utf8"), "partial")
})

test("unavailable supervisor inspection cannot authorize receipt cleanup or exit recovery", async t => {
  const f = await setup(t)
  const job = await f.service.submit(f.input)
  await f.finish(job.jobId)
  const jobDir = f.jobDir(job.jobId)
  const manifest = await load(path.join(jobDir, "manifest.json"))
  const receiptPath = path.join(jobDir, "receipt.json")
  const receipt = await load(receiptPath)
  const worker = f.workers.get(job.jobId)
  const inspect = f.adapter.inspect
  f.adapter.inspect = async pid => {
    if (pid === worker.identity.pid) {
      throw Object.assign(new Error("Supervisor identity inaccessible"), { code: "render_process" })
    }
    return inspect(pid)
  }
  await f.service.close()
  const recovered = await f.open()
  for (const version of [2, 1]) {
    await save(path.join(jobDir, "manifest.json"), { ...manifest, version })
    const result = await recovered.result(job.jobId)
    assert.equal(result.state, "unknown")
    assert.equal(result.verified, false)
    assert.deepEqual(result.outputs, [])
    await fs.unlink(receiptPath)
    const status = await recovered.status(job.jobId)
    assert.equal(status.state, "unknown")
    assert.equal(status.controllable, false)
    assert.equal(await exists(receiptPath), false, "Do not finalize an exit with an uninspectable supervisor")
    assert.equal(await exists(path.join(jobDir, "checkpoint-release.json")), false)
    assert.equal(await exists(job.checkpoint.path), true)
    assert.equal(await exists(job.reservationPath), true)
    assert.equal(await exists(job.stageDir), true)
    assert.equal(await exists(job.quarantineDir), false)
    assert.equal(await fs.readFile(f.input.outputPath, "utf8"), "rendered bytes")
    assert.deepEqual(f.killed, [])
    await save(receiptPath, receipt)
  }
})

test("failed cancellation retries only on a fresh explicit request after reconnect", async t => {
  const f = await setup(t)
  let attempts = 0
  f.adapter.terminate = async identity => {
    assert.ok(sameIdentity(identity, await f.adapter.inspect(identity.pid)))
    attempts++
    if (attempts === 1) throw new Error("Temporary process control failure")
    return { requested: true, method: "test-close-window" }
  }
  const job = await f.service.submit(f.input)
  await f.started(job.jobId)
  await f.service.cancel(job.jobId)
  await until(async () => (await f.service.status(job.jobId)).cancellation?.method === "control-unavailable")
  await delay(250)
  assert.equal(attempts, 1, "A failed request must not become an automatic retry loop")
  await f.service.close()
  const recovered = await f.open()
  await recovered.cancel(job.jobId)
  await until(() => attempts === 2)
  await until(async () => (await recovered.status(job.jobId)).cancellation?.requested)
  await recovered.cancel(job.jobId)
  await delay(250)
  assert.equal(attempts, 2, "A successful termination request must not be repeated")
  await f.finish(job.jobId, { code: 1, quiescent: false })
  const status = await recovered.status(job.jobId)
  assert.equal(status.state, "unknown", "A request is not proof of descendant shutdown")
  assert.equal(await exists(job.reservationPath), true)
})

test("checkpoint hash is rechecked and modified checkpoints are refused", async t => {
  const f = await setup(t)
  await fs.writeFile(f.checkpoint.path, "changed checkpoint")
  await assert.rejects(f.service.submit(f.input), { code: "render_checkpoint" })
  assert.equal(f.workers.size, 0)
})

test("late external output is preserved and only private output is quarantined", async t => {
  const f = await setup(t)
  const job = await f.service.submit(f.input)
  await f.started(job.jobId)
  await fs.writeFile(f.input.outputPath, "external writer")
  await f.finish(job.jobId)
  assert.equal((await f.service.status(job.jobId)).state, "failed")
  assert.equal(await fs.readFile(f.input.outputPath, "utf8"), "external writer")
  assert.equal(await fs.readFile(path.join(job.quarantineDir, "movie.mov"), "utf8"), "rendered bytes")
})

test("sequence syntax is explicit and matching is literal and case-conservative", () => {
  const spec = outputSpec(path.resolve("a+b.[##].png"), 1, 2)
  assert.deepEqual(spec.names, ["a+b.01.png", "a+b.02.png"])
  assert.equal(collides(spec, "A+B.123456.PNG"), true)
  assert.equal(collides(spec, "aaab.01.png"), false)
  for (const name of ["bad.%04d.png", "bad.[##].[##].png", "bad.#.png", "NUL.mov", "bad?.mov"]) {
    assert.throws(() => outputSpec(path.resolve(name), 1, 2), { code: "render_output" })
  }
})

test("durable exit and journal recover completion after supervisor exit", async t => {
  const f = await setup(t)
  const job = await f.service.submit(f.input)
  await f.finish(job.jobId)
  await fs.unlink(path.join(f.jobDir(job.jobId), "receipt.json"))
  f.revoke()
  const recovered = await f.open()
  const result = await recovered.result(job.jobId)
  assert.equal(result.state, "completed")
  assert.equal(result.outputs.length, 1)
  assert.equal(await exists(job.reservationPath), false)
})

test("interrupted sequence publication rolls back only owned links and quarantines", async t => {
  const f = await setup(t)
  const job = await f.service.submit({ ...f.input, outputPath: path.join(f.output, "frame.[##].png") })
  await f.finish(job.jobId)
  await fs.unlink(path.join(f.jobDir(job.jobId), "receipt.json"))
  await fs.unlink(path.join(f.output, "frame.03.png"))
  const recovered = await f.open()
  const status = await recovered.status(job.jobId)
  assert.equal(status.state, "failed")
  assert.equal(status.outputState, "quarantined_partial")
  assert.equal(await exists(path.join(f.output, "frame.01.png")), false)
  assert.equal(await exists(path.join(job.quarantineDir, "frame.03.png")), true)
})

test("recovery never removes a replacement file", async t => {
  const f = await setup(t)
  const job = await f.service.submit(f.input)
  await f.finish(job.jobId)
  await fs.unlink(path.join(f.jobDir(job.jobId), "receipt.json"))
  await fs.unlink(f.input.outputPath)
  await fs.writeFile(f.input.outputPath, "replacement")
  const recovered = await f.open()
  assert.equal((await recovered.status(job.jobId)).state, "unknown")
  assert.equal(await fs.readFile(f.input.outputPath, "utf8"), "replacement")
  assert.equal(await exists(job.reservationPath), true)
})

test("uncertain termination quarantines partials but retains reservation", async t => {
  const f = await setup(t)
  const job = await f.service.submit(f.input)
  const child = await f.started(job.jobId)
  await fs.writeFile(path.join(job.stageDir, "movie.mov"), "partial")
  child.done = true
  f.live.delete(child.identity.pid)
  child.finish({ code: null, signal: "SIGTERM", error: null })
  await f.workers.get(job.jobId).task
  const status = await f.service.status(job.jobId)
  assert.equal(status.state, "unknown")
  assert.equal(status.outputState, "quarantined_partial")
  assert.equal(await exists(job.reservationPath), true)
})

test("collision introduced by prelaunch grant recheck never launches aerender", async t => {
  const f = await setup(t)
  f.onCheck(async count => {
    if (count === 2) await fs.writeFile(f.input.outputPath, "external")
  })
  await assert.rejects(f.service.submit(f.input), { code: "render_collision" })
  await Promise.all([...f.workers.values()].map(item => item.task))
  assert.equal(f.children.size, 0)
  assert.equal(await fs.readFile(f.input.outputPath, "utf8"), "external")
})

test("native child launch, discovery, identity guard and cancellation (not AE)", {
  skip: !["win32", "darwin"].includes(process.platform), timeout: 30000,
}, async t => {
  const f = await setup(t)
  const adapter = createProcessAdapter()
  const log = await fs.open(path.join(f.base, "native.log"), "wx")
  const command = {
    executable: await fs.realpath(process.execPath),
    args: ["-e", "setTimeout(() => {}, 20000)", "--", 'quoted "argument"', randomUUID()],
  }
  const child = await adapter.start(command, log.fd)
  t.after(async () => {
    try {
      if (child.identity && sameIdentity(child.identity, await adapter.inspect(child.pid))) {
        await adapter.terminate(child.identity)
      }
    } finally { await log.close() }
  })
  assert.ok(child.identity, "Native spawn must capture the exact command identity")
  assert.ok((await adapter.discover(command)).some(item => sameIdentity(item, child.identity)))
  await assert.rejects(adapter.terminate({ ...child.identity, command: "not this process" }), { code: "render_process_identity" })
  assert.ok(sameIdentity(child.identity, await adapter.inspect(child.pid)))
  assert.equal((await adapter.terminate(child.identity)).requested, true)
  const exit = await child.exited
  assert.ok(exit.code !== 0 || exit.signal)
})

test("native detached supervisor writes a durable failure receipt (not AE)", {
  skip: !["win32", "darwin"].includes(process.platform), timeout: 30000,
}, async t => {
  const f = await setup(t)
  const native = await f.open({ processAdapter: createProcessAdapter() })
  // Node rejects aerender flags. This exercises the real detached supervisor and
  // spawn-error/exit path without invoking or pretending to certify After Effects.
  const job = await native.submit(f.input)
  await native.close()
  await until(() => exists(path.join(f.jobDir(job.jobId), "receipt.json")))
  const recovered = await f.open({ processAdapter: createProcessAdapter() })
  const result = await recovered.result(job.jobId)
  assert.equal(result.state, "failed")
  assert.deepEqual(result.outputs, [])
  const receipt = await load(path.join(f.jobDir(job.jobId), "receipt.json"))
  assert.notEqual(receipt.exit.code, 0)
})

for (const pinned of [false, true]) {
  test(`private checkpoint lifecycle preserves source pinned=${pinned}, even after restart`, async t => {
    const f = await setup(t)
    f.checkpoint.pinned = pinned
    const job = await f.service.submit(f.input)
    await f.started(job.jobId)
    assert.equal(job.version, 2)
    assert.equal(job.sourceCheckpoint.pinned, pinned)
    assert.equal(f.checkpoint.pinned, pinned)
    assert.notEqual(job.checkpoint.path, f.checkpoint.path)
    assert.equal(await fs.readFile(job.checkpoint.path, "utf8"), "immutable test checkpoint")
    await f.service.close()
    // Neither source retention nor manual repinning can invalidate the private lease.
    f.checkpoint.pinned = true
    await fs.unlink(f.checkpoint.path)
    const recovered = await f.open()
    assert.equal((await recovered.status(job.jobId)).checkpointRetention.state, "held")
    await f.finish(job.jobId)
    await recovered.close()
    const final = await f.open()
    const status = await final.status(job.jobId)
    assert.equal(status.state, "completed")
    assert.equal(status.checkpointRetention.state, "released")
    assert.equal(status.checkpoint.pinned, false)
    assert.equal(await exists(job.checkpoint.path), false)
    assert.equal(f.checkpoint.pinned, true)
    assert.equal((await final.result(job.jobId)).verified, true)
  })
}

test("private copies are independent for concurrent jobs using the same source", async t => {
  const f = await setup(t)
  await fs.mkdir(path.join(f.output, "second"))
  const first = await f.service.submit(f.input)
  const second = await f.service.submit({ ...f.input, outputPath: path.join(f.output, "second", "movie.mov") })
  await f.started(second.jobId)
  assert.notEqual(first.checkpoint.path, second.checkpoint.path)
  await f.finish(first.jobId)
  assert.equal((await f.service.status(first.jobId)).checkpointRetention.state, "released")
  assert.equal((await f.service.status(second.jobId)).state, "running")
  assert.equal(await exists(second.checkpoint.path), true)
  await f.finish(second.jobId, { code: 1 })
  assert.equal((await f.service.status(second.jobId)).checkpointRetention.state, "released")
  assert.equal(f.checkpoint.pinned, false)
})

test("nonempty pending files and unknown receipts never release the private lease", async t => {
  const f = await setup(t)
  const job = await f.service.submit(f.input)
  await f.started(job.jobId)
  await fs.writeFile(path.join(job.stageDir, "movie.mov"), "nonempty pending output")
  assert.equal((await f.service.result(job.jobId)).verified, false)
  assert.equal(await exists(job.checkpoint.path), true)
  await f.finish(job.jobId)
  await fs.unlink(job.logPath)
  const recovered = await f.open()
  assert.equal((await recovered.status(job.jobId)).state, "unknown")
  assert.equal(await exists(job.checkpoint.path), true)
  assert.equal(await exists(job.reservationPath), true)
})

test("confirmed cancellation releases only the private copy", async t => {
  const f = await setup(t)
  f.checkpoint.pinned = true
  const job = await f.service.submit(f.input)
  await f.started(job.jobId)
  await f.service.cancel(job.jobId)
  await f.workers.get(job.jobId).task
  const status = await f.service.status(job.jobId)
  assert.equal(status.state, "cancelled")
  assert.equal(status.checkpointRetention.state, "released")
  assert.equal(f.checkpoint.pinned, true)
  assert.equal(await exists(f.checkpoint.path), true)
})

test("startup completes checkpoint release interrupted after unlink", async t => {
  const f = await setup(t)
  const job = await f.service.submit(f.input)
  await f.finish(job.jobId)
  await save(path.join(f.jobDir(job.jobId), "checkpoint-release.json"), {
    jobId: job.jobId, commandHash: job.commandHash, state: "releasing",
  })
  await fs.chmod(job.checkpoint.path, 0o600)
  await fs.unlink(job.checkpoint.path)
  const recovered = await f.open()
  assert.equal((await recovered.status(job.jobId)).checkpointRetention.state, "released")
  assert.equal((await recovered.result(job.jobId)).verified, true)
})

test("legacy shared checkpoints survive terminal recovery without guessing pin ownership", async t => {
  const f = await setup(t)
  const job = await f.service.submit(f.input)
  const manifest = await load(path.join(f.jobDir(job.jobId), "manifest.json"))
  // Persisted v1 manifests have no private-lease ownership proof.
  manifest.version = 1
  await save(path.join(f.jobDir(job.jobId), "manifest.json"), manifest)
  await f.finish(job.jobId)
  const recovered = await f.open()
  assert.equal((await recovered.status(job.jobId)).checkpointRetention.state, "preserved")
  assert.equal(await exists(job.checkpoint.path), true)
})

test("template output must exactly match explicit file or sequence specification", async t => {
  const f = await setup(t)
  for (const name of ["frames.[##].mov", "frames.[##].mp4", "frames.[##].unknown", "frame.png"]) {
    await assert.rejects(f.service.submit({ ...f.input, outputPath: path.join(f.output, name) }), { code: "render_output" })
  }
  const job = await f.service.submit({ ...f.input, outputPath: path.join(f.output, "frames.[##].png") })
  await f.finish(job.jobId, { names: ["frames.[##].png"] })
  assert.equal((await f.service.status(job.jobId)).state, "failed")
  assert.deepEqual((await f.service.result(job.jobId)).outputs, [])
  const other = await f.service.submit(f.input)
  await f.finish(other.jobId, { names: ["movie.mov", "movie.mov.tmp"] })
  assert.equal((await f.service.status(other.jobId)).state, "failed")
  assert.equal(await exists(f.input.outputPath), false)
})

for (const external of [true, false]) {
  test(`Bun packaged plugin and bundled worker launch independently (external=${external}, not AE)`, {
    skip: !["win32", "darwin"].includes(process.platform),
  }, async t => {
    try { await exec("bun", ["--version"]) } catch { t.skip("Bun is not installed"); return }
    const f = await setup(t)
    const dist = path.join(f.base, "cm-ae")
    await fs.mkdir(dist)
    const sourceRoot = fileURLToPath(new URL("../", import.meta.url))
    for (const [entry, outfile] of [["render.mjs", "plugin.mjs"], ["render-worker.mjs", "render-worker.mjs"]]) {
      await exec("bun", [
        "build", "./src/" + entry, "--target=node", "--format=esm", "--packages=bundle",
        "--env=disable", "--reject-unresolved",
        ...(external && entry === "render.mjs" ? ["--external=./render-worker.mjs"] : []),
        "--outfile", path.join(dist, outfile),
      ], { cwd: sourceRoot })
    }
    // Executing an inlined plugin entry must not accidentally enter the supervisor.
    await exec(process.execPath, [path.join(dist, "plugin.mjs")])
    const packed = await import(pathToFileURL(path.join(dist, "plugin.mjs")).href)
    const renderer = await packed.createRenderer({
      dataDir: f.base, aerenderPath: process.execPath,
      grants: { check: async () => f.input.outputPath },
      checkpoints: { verify: async () => ({ ...f.checkpoint }) },
    })
    t.after(() => renderer.close())
    const job = await renderer.submit(f.input)
    await renderer.close()
    await until(() => exists(path.join(f.jobDir(job.jobId), "receipt.json")))
    const worker = await load(path.join(f.jobDir(job.jobId), "worker.json"))
    assert.ok(worker.identity.command.includes(path.join(dist, "render-worker.mjs")))
    assert.ok(!worker.identity.command.includes(path.join(dist, "plugin.mjs")))
    const recovered = await f.open()
    assert.equal((await recovered.result(job.jobId)).state, "failed")
  })
}

test("concurrent terminal observers release one private checkpoint idempotently", async t => {
  const f = await setup(t)
  const services = await Promise.all(Array.from({ length: 8 }, () => f.open()))
  const job = await f.service.submit(f.input)
  await f.finish(job.jobId)
  const statuses = await Promise.all(services.map(service => service.status(job.jobId)))
  assert.ok(statuses.every(status => status.state === "completed"))
  assert.equal((await f.service.status(job.jobId)).checkpointRetention.state, "released")
  assert.equal(await exists(job.checkpoint.path), false)
  assert.equal(await exists(f.checkpoint.path), true)
})

test("terminal cleanup never deletes a replaced private checkpoint or releases an unknown job", async t => {
  const f = await setup(t)
  const job = await f.service.submit(f.input)
  await f.finish(job.jobId)
  await fs.chmod(job.checkpoint.path, 0o600)
  await fs.unlink(job.checkpoint.path)
  await fs.writeFile(job.checkpoint.path, "replacement private file")
  const status = await f.service.status(job.jobId)
  assert.equal(status.state, "unknown")
  assert.equal(status.outputState, "unverified")
  assert.deepEqual(status.deliverables, [])
  assert.equal(await exists(job.reservationPath), true)
  assert.equal(await fs.readFile(job.checkpoint.path, "utf8"), "replacement private file")
  assert.equal(await exists(path.join(f.jobDir(job.jobId), "checkpoint-release.json")), false)
})

test("native OS identity smoke check, not aerender certification", { skip: !["win32", "darwin"].includes(process.platform) }, async () => {
  const adapter = createProcessAdapter()
  const identity = await adapter.self()
  assert.equal(identity.pid, process.pid)
  assert.ok(sameIdentity(identity, await adapter.inspect(process.pid)))
  await assert.rejects(adapter.terminate({ ...identity, startTime: "stale" }), { code: "render_process_identity" })
})
