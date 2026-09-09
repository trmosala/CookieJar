import test from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as syncFS from "node:fs"
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
  createProcessAdapter, outputSpec, collides, withJobLock,
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
      if (await exists(context.jobDir)) {
        await save(path.join(context.jobDir, "cancel.json"), { at: new Date().toISOString(), reason: "test cleanup" })
      }
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

for (const state of ["completed", "failed", "cancelled"]) {
  test(`retirement: explicit approval expires ${state} records and preserves outputs/source`, async t => {
    const f = await setup(t)
    f.checkpoint.pinned = true
    const job = await f.service.submit(f.input)
    await f.started(job.jobId)
    if (state === "cancelled") {
      await fs.writeFile(path.join(job.stageDir, "movie.mov"), "partial")
      await f.service.cancel(job.jobId)
      await f.workers.get(job.jobId).task
    } else await f.finish(job.jobId, { code: state === "failed" ? 7 : 0 })
    const preview = await f.service.retire(job.jobId)
    assert.equal(preview.state, state)
    assert.equal(preview.retired, false)
    assert.equal(preview.approvalRequired, true)
    assert.match(preview.warning, /Permanently remove/)
    assert.match(preview.approval, /^[a-f0-9]{64}$/)
    assert.equal(await exists(job.checkpoint.path), true, "Preview must not release anything")
    assert.equal(await exists(job.reservationPath), true)
    await assert.rejects(f.service.retire(job.jobId, { approval: true }), { code: "render_retire_refused" })
    const result = await f.service.retire(job.jobId, { approval: preview.approval })
    assert.equal(result.retired, true)
    for (const target of [f.jobDir(job.jobId), job.stageDir, job.quarantineDir, job.reservationPath]) {
      assert.equal(await exists(target), false, target)
    }
    assert.equal(await fs.readFile(f.checkpoint.path, "utf8"), "immutable test checkpoint")
    assert.equal(f.checkpoint.pinned, true)
    assert.equal(await exists(f.input.outputPath), state === "completed")
    if (state === "completed") assert.equal(await fs.readFile(f.input.outputPath, "utf8"), "rendered bytes")
    assert.deepEqual(await f.service.list(), [])
    await assert.rejects(f.service.status(job.jobId), { code: "render_job" })
    await assert.rejects(f.service.retire(job.jobId, { approval: preview.approval }), { code: "render_job" })
    await f.service.close()
    assert.deepEqual(await (await f.open()).reconcile(), [])
    await assert.rejects(runWorker(f.jobDir(job.jobId), f.adapter))
    assert.equal(await exists(f.jobDir(job.jobId)), false, "Delayed supervisors cannot resurrect jobs")
  })
}

test("retirement: prelaunch cancellation can expire without inventing a child identity", async t => {
  const f = await setup(t)
  f.onCheck(count => { if (count === 2) f.revoke() })
  await assert.rejects(f.service.submit(f.input), { code: "grant_denied" })
  const [worker] = f.workers.values()
  await worker.task
  const id = path.basename(worker.jobDir)
  const preview = await f.service.retire(id)
  assert.equal(preview.state, "cancelled")
  assert.equal((await f.service.retire(id, { approval: preview.approval })).retired, true)
  assert.equal(await exists(f.checkpoint.path), true)
})

test("retirement: live sibling shares only the preserved source and keeps its reservation", async t => {
  const f = await setup(t)
  f.checkpoint.pinned = true
  const first = await f.service.submit(f.input)
  await f.finish(first.jobId)
  await f.service.status(first.jobId)
  const second = await f.service.submit({ ...f.input, outputPath: path.join(f.output, "second.mov") })
  await f.started(second.jobId)
  const checkpoint = await signature(second.checkpoint.path)
  const owner = await load(path.join(second.reservationPath, "owner.json"))
  const preview = await f.service.retire(first.jobId)
  assert.equal((await f.service.retire(first.jobId, { approval: preview.approval })).retired, true)
  assert.deepEqual(await signature(second.checkpoint.path), checkpoint)
  assert.deepEqual(await load(path.join(second.reservationPath, "owner.json")), owner)
  assert.equal((await f.service.status(second.jobId)).state, "running")
  assert.equal(await fs.readFile(first.outputPath, "utf8"), "rendered bytes")
  assert.equal(f.checkpoint.pinned, true)
  assert.equal(await exists(f.checkpoint.path), true)
})

test("retirement: refuses live, unknown, reused and uninspectable process identities without cleanup", async t => {
  const f = await setup(t)
  const job = await f.service.submit(f.input)
  const child = await f.started(job.jobId)
  const refuse = async () => {
    await assert.rejects(f.service.retire(job.jobId), { code: "render_retire_refused" })
    assert.equal(await exists(job.checkpoint.path), true)
    assert.equal(await exists(job.reservationPath), true)
    assert.equal(await exists(f.jobDir(job.jobId)), true)
  }
  await refuse()
  await f.finish(job.jobId)
  const worker = f.workers.get(job.jobId)
  for (const identity of [worker.identity, child.identity]) {
    for (const live of [identity, { ...identity, startTime: "reused" }]) {
      f.live.set(identity.pid, live)
      await refuse()
    }
    f.live.delete(identity.pid)
    const inspect = f.adapter.inspect
    f.adapter.inspect = async pid => { if (pid === identity.pid) throw new Error("Inspection denied"); return inspect(pid) }
    await refuse()
    f.adapter.inspect = inspect
  }
  const discover = f.adapter.discover
  f.adapter.discover = async () => [child.identity]
  await refuse()
  f.adapter.discover = async () => { throw new Error("Discovery unavailable") }
  await refuse()
  f.adapter.discover = discover
  const receiptPath = path.join(f.jobDir(job.jobId), "receipt.json")
  const receipt = await load(receiptPath)
  for (const changed of [
    { ...receipt, state: "unknown" },
    { ...receipt, exit: { ...receipt.exit, quiescent: false } },
    { ...receipt, exit: { ...receipt.exit, signal: "SIGTERM", quiescent: undefined } },
  ]) {
    await save(receiptPath, JSON.parse(JSON.stringify(changed)))
    await refuse()
  }
  await save(receiptPath, receipt)
  await fs.unlink(path.join(f.jobDir(job.jobId), "process.json"))
  await refuse()
  assert.deepEqual(f.killed, [])
})

test("retirement: preserves legacy records, corruption, unknown files and replaced private artifacts", async t => {
  const f = await setup(t)
  const job = await f.service.submit(f.input)
  await f.finish(job.jobId, { code: 7 })
  const jobDir = f.jobDir(job.jobId)
  const refuse = async () => {
    await assert.rejects(f.service.retire(job.jobId), { code: "render_retire_refused" })
    assert.equal(await exists(job.checkpoint.path), true)
    assert.equal(await exists(job.reservationPath), true)
    assert.equal(await exists(jobDir), true)
  }
  const manifestPath = path.join(jobDir, "manifest.json")
  const manifest = await load(manifestPath)
  for (const legacy of [{ ...manifest, version: 1 }, { ...manifest, ownership: undefined }]) {
    await save(manifestPath, JSON.parse(JSON.stringify(legacy)))
    await refuse()
  }
  await fs.writeFile(manifestPath, "{broken")
  await refuse()
  await save(manifestPath, manifest)
  for (const name of ["foreign.txt", "manifest.json.inflight.tmp", "recovery-lock"]) {
    const target = path.join(jobDir, name)
    await fs.writeFile(target, "leave this alone")
    await refuse()
    assert.equal(await fs.readFile(target, "utf8"), "leave this alone")
    await fs.unlink(target)
  }
  for (const target of [job.logPath, job.checkpoint.path, path.join(job.quarantineDir, "movie.mov")]) {
    const moved = path.join(f.base, path.basename(target) + ".original")
    await fs.rename(target, moved)
    await fs.copyFile(moved, target)
    await refuse()
    await fs.chmod(target, 0o600)
    await fs.unlink(target)
    await fs.rename(moved, target)
  }
  const moved = job.quarantineDir + ".original"
  await fs.rename(job.quarantineDir, moved)
  await fs.mkdir(job.quarantineDir)
  await refuse()
  await fs.rmdir(job.quarantineDir)
  await fs.symlink(moved, job.quarantineDir, process.platform === "win32" ? "junction" : "dir")
  await refuse()
  await fs.unlink(job.quarantineDir)
  await fs.rename(moved, job.quarantineDir)
  const shared = path.join(f.base, "shared-private.aep")
  await fs.link(job.checkpoint.path, shared)
  await refuse()
  assert.equal(await fs.readFile(shared, "utf8"), "immutable test checkpoint")
  await fs.unlink(shared)
  const ownerPath = path.join(job.reservationPath, "owner.json")
  await fs.writeFile(ownerPath, "{broken")
  await refuse()
})

test("retirement: status changes invalidate artifact scope, but subsequent observations do not", async t => {
  const f = await setup(t)
  const job = await f.service.submit(f.input)
  await f.finish(job.jobId)
  const preview = await f.service.retire(job.jobId)
  await f.service.status(job.jobId)
  await assert.rejects(f.service.retire(job.jobId, { approval: preview.approval }), { code: "render_retire_refused" })
  const fresh = await f.service.retire(job.jobId)
  await f.service.status(job.jobId)
  assert.equal((await f.service.retire(job.jobId, { approval: fresh.approval })).retired, true)
})

test("retirement: observers, cancellation, list, restart and duplicate retire cannot resurrect metadata", async t => {
  const f = await setup(t)
  const services = await Promise.all(Array.from({ length: 5 }, () => f.open()))
  const job = await f.service.submit(f.input)
  await f.finish(job.jobId)
  await f.service.status(job.jobId)
  const preview = await f.service.retire(job.jobId)
  let entered, resume
  const paused = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { resume = resolve })
  const inspect = f.adapter.inspect
  let held = false
  f.adapter.inspect = async pid => {
    if (!held) { held = true; entered(); await gate }
    return inspect(pid)
  }
  const retired = f.service.retire(job.jobId, { approval: preview.approval })
  await paused
  const outcomes = Promise.allSettled([
    services[0].status(job.jobId), services[1].cancel(job.jobId),
    services[2].list(), services[3].reconcile(),
    services[4].retire(job.jobId, { approval: preview.approval }), f.open(),
  ])
  await delay(50)
  resume()
  assert.equal((await retired).retired, true)
  const results = await outcomes
  for (const index of [0, 1, 4]) {
    assert.equal(results[index].status, "rejected")
    assert.equal(results[index].reason.code, "render_job")
  }
  for (const index of [2, 3]) assert.deepEqual(results[index].value, [])
  assert.equal(results[5].status, "fulfilled")
  assert.equal(await exists(f.jobDir(job.jobId)), false)
  assert.deepEqual(await fs.readdir(path.dirname(f.jobDir(job.jobId))), [])
})

test("retirement: revalidates process identity and replacements after approval", async t => {
  const f = await setup(t)
  const job = await f.service.submit(f.input)
  await f.finish(job.jobId, { code: 7 })
  const preview = await f.service.retire(job.jobId)
  const inspect = f.adapter.inspect
  const worker = f.workers.get(job.jobId).identity
  let inspections = 0
  f.adapter.inspect = async pid => {
    if (pid === worker.pid && ++inspections === 2) return { ...worker, startTime: "reused" }
    return inspect(pid)
  }
  await assert.rejects(f.service.retire(job.jobId, { approval: preview.approval }), { code: "render_retire_refused" })
  assert.equal(await exists(job.checkpoint.path), true)
  f.adapter.inspect = inspect
  const discover = f.adapter.discover
  let discoveries = 0
  f.adapter.discover = async command => {
    if (++discoveries === 2) {
      await fs.rename(job.quarantineDir, job.quarantineDir + ".original")
      await fs.mkdir(job.quarantineDir)
      await fs.writeFile(path.join(job.quarantineDir, "foreign"), "replacement")
    }
    return discover(command)
  }
  await assert.rejects(f.service.retire(job.jobId, { approval: preview.approval }), { code: "render_retire_refused" })
  assert.equal(await fs.readFile(path.join(job.quarantineDir, "foreign"), "utf8"), "replacement")
  assert.equal(await exists(job.checkpoint.path), true)
})

test("retirement: inspected receipts cannot be swapped or removed during inventory capture", async t => {
  const f = await setup(t)
  const job = await f.service.submit(f.input)
  await f.finish(job.jobId)
  const jobDir = f.jobDir(job.jobId)
  const workerPath = path.join(jobDir, "worker.json")
  const launchPath = path.join(jobDir, "launch.json")
  const worker = await load(workerPath)
  const launch = await load(launchPath)
  const discover = f.adapter.discover
  for (const mutate of [
    () => save(workerPath, { ...worker, identity: { ...worker.identity, pid: worker.identity.pid + 100 } }),
    () => fs.unlink(launchPath),
  ]) {
    f.adapter.discover = async command => { await mutate(); return discover(command) }
    await assert.rejects(f.service.retire(job.jobId), { code: "render_retire_refused" })
    assert.equal(await exists(job.checkpoint.path), true)
    assert.equal(await exists(job.reservationPath), true)
    await save(workerPath, worker)
    await save(launchPath, launch)
  }
  f.adapter.discover = discover
})

test("retirement: replaced job/destination/reservation directories and foreign reservation entries survive", async t => {
  const f = await setup(t)
  const job = await f.service.submit(f.input)
  await f.finish(job.jobId, { code: 7 })
  const jobDir = f.jobDir(job.jobId)
  for (const target of [jobDir, job.destinationDir, job.reservationPath]) {
    const moved = target + ".original"
    await fs.rename(target, moved)
    await fs.cp(moved, target, { recursive: true })
    await assert.rejects(f.service.retire(job.jobId), { code: "render_retire_refused" })
    assert.equal(await exists(target), true)
    await fs.rm(target, { recursive: true, force: true })
    await fs.rename(moved, target)
  }
  const foreign = path.join(job.reservationPath, "foreign.txt")
  await fs.writeFile(foreign, "preserve")
  await assert.rejects(f.service.retire(job.jobId), { code: "render_retire_refused" })
  assert.equal((await f.service.status(job.jobId)).state, "unknown")
  assert.equal(await fs.readFile(foreign, "utf8"), "preserve")
  assert.equal(await exists(path.join(job.reservationPath, "owner.json")), true)
})

test("retirement: durable terminal records survive shutdown until a restarted service explicitly expires them", async t => {
  const f = await setup(t)
  const job = await f.service.submit(f.input)
  await f.finish(job.jobId)
  await f.service.close()
  assert.equal(await exists(path.join(f.jobDir(job.jobId), "receipt.json")), true)
  assert.equal(await exists(job.logPath), true)
  const recovered = await f.open()
  const preview = await recovered.retire(job.jobId)
  await recovered.close()
  const next = await f.open()
  assert.equal((await next.retire(job.jobId, { approval: preview.approval })).retired, true)
  assert.equal(await exists(f.input.outputPath), true)
})

test("retirement: lifetime guard reports partial deletion honestly and preserves remaining records", async t => {
  const f = await setup(t)
  const job = await f.service.submit(f.input)
  await f.finish(job.jobId)
  const preview = await f.service.retire(job.jobId)
  let checks = 0
  await assert.rejects(f.service.retire(job.jobId, {
    approval: preview.approval,
    check() {
      if (++checks === 4) throw Object.assign(new Error("Session released"), { code: "aborted" })
    },
  }), error => {
    assert.equal(error.code, "render_retire_partial")
    assert.equal(error.details.retired, false)
    assert.equal(error.details.cause, "aborted")
    assert.deepEqual(error.details.removed, [path.join(job.stageDir, "movie.mov")])
    return true
  })
  assert.equal(await exists(path.join(f.jobDir(job.jobId), "manifest.json")), true)
  assert.equal(await exists(job.logPath), true)
  assert.equal(await exists(job.checkpoint.path), true)
  assert.equal(await exists(job.reservationPath), true)
  assert.equal(await fs.readFile(job.outputPath, "utf8"), "rendered bytes")
  assert.equal(await fs.readFile(f.checkpoint.path, "utf8"), "immutable test checkpoint")
  await assert.rejects(f.service.retire(job.jobId, { approval: preview.approval }), { code: "render_retire_refused" })
})

test("retirement: real process exit leaves a non-replayable plan and restart never deletes remnants", async t => {
  const f = await setup(t)
  const job = await f.service.submit(f.input)
  await f.finish(job.jobId)
  await f.service.close()
  const rendererURL = new URL("../src/render.mjs", import.meta.url).href
  const script = `import { createRenderer } from ${JSON.stringify(rendererURL)};
    const service = await createRenderer({
      dataDir: ${JSON.stringify(f.base)},
      grants: { check() { throw Error("unused"); } },
      checkpoints: { verify() { throw Error("unused"); } },
      processAdapter: { inspect: async () => null, discover: async () => [] }
    });
    const preview = await service.retire(${JSON.stringify(job.jobId)});
    let checks = 0;
    await service.retire(preview.jobId, { approval: preview.approval, check() {
      if (++checks === 4) { process.stdout.write("partial"); process.exit(0); }
    }});`
  const child = await exec(process.execPath, ["--input-type=module", "-e", script], { timeout: 30000 })
  assert.equal(child.stdout, "partial")
  const recoveryPath = path.join(path.dirname(f.jobDir(job.jobId)), "." + job.jobId + ".retirement")
  const planPath = path.join(recoveryPath, "plan.json")
  const plan = await load(planPath)
  assert.match(plan.remediation, /Never replay/)
  const first = plan.entries[0]
  assert.equal(first.path, path.join(job.stageDir, "movie.mov"))
  assert.equal(await exists(first.path), false)
  assert.equal(await exists(first.claim), false)
  const receipt = await signature(path.join(f.jobDir(job.jobId), "receipt.json"))
  const log = await signature(job.logPath)
  const before = await fs.readFile(planPath, "utf8")
  for (let restart = 0; restart < 2; restart++) {
    const service = await f.open()
    assert.equal((await service.status(job.jobId)).reason, "render_retire_partial")
    assert.equal((await service.result(job.jobId)).verified, false)
    assert.equal((await service.list())[0].remediation, "manual_retirement_recovery_required")
    await assert.rejects(service.retire(job.jobId), { code: "render_retire_refused" })
    await assert.rejects(service.cancel(job.jobId), { code: "render_process_identity" })
    await assert.rejects(runWorker(f.jobDir(job.jobId), f.adapter), { code: "render_retire_refused" })
    assert.deepEqual(await signature(path.join(f.jobDir(job.jobId), "receipt.json")), receipt)
    assert.deepEqual(await signature(job.logPath), log)
    assert.equal(await fs.readFile(planPath, "utf8"), before)
    await service.close()
  }
  // Manual remediation in a stopped fixture: reconstruct this one known hard
  // link from the preserved output, verifying the original identity, not copying.
  await fs.link(job.outputPath, first.path)
  assert.deepEqual(await signature(first.path), first.signature)
  assert.deepEqual((await fs.readdir(recoveryPath)).sort(), [".cookiemonster-storage-owner.json", "plan.json"])
  await fs.unlink(planPath)
  await fs.unlink(path.join(recoveryPath, ".cookiemonster-storage-owner.json"))
  await fs.rmdir(recoveryPath)
  const remediated = await f.open()
  const fresh = await remediated.retire(job.jobId)
  assert.equal((await remediated.retire(job.jobId, { approval: fresh.approval })).retired, true)
  assert.equal(await fs.readFile(job.outputPath, "utf8"), "rendered bytes")
})

test("retirement: corrupt plan without a job directory is visible and never interpreted as deletion authority", async t => {
  const f = await setup(t)
  const id = randomUUID(), jobDir = f.jobDir(id)
  const pending = path.join(path.dirname(jobDir), "." + id + ".retirement")
  await fs.mkdir(pending)
  await fs.writeFile(path.join(pending, "plan.json"), "{broken")
  await fs.writeFile(path.join(pending, "foreign"), "preserve")
  const service = await f.open()
  assert.equal((await service.status(id)).reason, "render_retire_partial")
  assert.equal((await service.list())[0].jobId, id)
  await assert.rejects(service.retire(id), { code: "render_retire_refused" })
  assert.equal(await fs.readFile(path.join(pending, "foreign"), "utf8"), "preserve")
  assert.equal(await fs.readFile(path.join(pending, "plan.json"), "utf8"), "{broken")
  assert.equal(await exists(jobDir), false)
})

test("retirement: marker-present socket contention isolates busy job during startup and list", { timeout: 120000 }, async t => {
  const f = await setup(t)
  const blocked = await f.service.submit(f.input)
  await f.finish(blocked.jobId)
  const healthyOutput = path.join(f.output, "healthy")
  await fs.mkdir(healthyOutput)
  const healthy = await f.service.submit({ ...f.input, outputPath: path.join(healthyOutput, "movie.mov") })
  await f.started(healthy.jobId)
  await f.service.close()
  const jobDir = f.jobDir(blocked.jobId)
  const marker = path.join(path.dirname(jobDir), "." + blocked.jobId + ".retirement")
  await fs.mkdir(marker)
  await fs.writeFile(path.join(marker, "plan.json"), "{broken")
  await fs.writeFile(path.join(marker, "claim-0"), "preserve")
  const preserved = [
    path.join(marker, "plan.json"), path.join(marker, "claim-0"),
    path.join(jobDir, "manifest.json"), path.join(jobDir, "observation.json"),
    path.join(jobDir, "receipt.json"), blocked.logPath, blocked.checkpoint.path,
    path.join(blocked.reservationPath, "owner.json"), path.join(blocked.stageDir, "movie.mov"),
    blocked.outputPath, f.checkpoint.path,
  ]
  const before = await Promise.all(preserved.map(signature))
  let restarted
  // Exercise the real 30-second socket timeout twice, without bypassing the gate.
  await withJobLock(jobDir, async () => {
    restarted = await f.open()
    const jobs = await restarted.list()
    assert.equal(jobs.length, 2)
    assert.deepEqual(jobs.find(job => job.jobId === blocked.jobId), {
      jobId: blocked.jobId, state: "unknown", reason: "render_busy", deliverables: [], controllable: false,
    })
    assert.equal(jobs.find(job => job.jobId === healthy.jobId).state, "running")
    assert.deepEqual(await Promise.all(preserved.map(signature)), before)
    assert.deepEqual((await fs.readdir(marker)).sort(), ["claim-0", "plan.json"])
    assert.equal(f.killed.length, 0)
  })
  const jobs = await restarted.list()
  assert.equal(jobs.length, 2)
  assert.deepEqual(jobs.find(job => job.jobId === blocked.jobId), {
    jobId: blocked.jobId, state: "unknown", reason: "render_retire_partial",
    controllable: false, deliverables: [], remediation: "manual_retirement_recovery_required",
  })
  await assert.rejects(restarted.cancel(blocked.jobId), { code: "render_process_identity" })
  await assert.rejects(restarted.retire(blocked.jobId), { code: "render_retire_refused" })
  assert.deepEqual(await Promise.all(preserved.map(signature)), before)
  assert.equal(f.killed.length, 0)
  await f.finish(healthy.jobId)
  assert.equal((await restarted.result(healthy.jobId)).verified, true)
})

test("access gate: real child exit releases the gate and restart recovers a healthy render", async t => {
  const f = await setup(t)
  const job = await f.service.submit(f.input)
  await f.started(job.jobId)
  const moduleURL = new URL("../src/render-worker.mjs", import.meta.url).href
  const script = `import { withJobLock } from ${JSON.stringify(moduleURL)};
    await withJobLock(${JSON.stringify(f.jobDir(job.jobId))}, async () => {
      process.stdout.write("gate-held");
      process.exit(0);
    });`
  const child = await exec(process.execPath, ["--input-type=module", "-e", script])
  assert.equal(child.stdout, "gate-held")
  await f.service.close()
  const restarted = await f.open()
  assert.equal((await restarted.status(job.jobId)).state, "running")
  await f.finish(job.jobId)
  assert.equal((await restarted.status(job.jobId)).state, "completed")
})

test("access gate: concurrent holders serialize; legacy unknown ownership is never reaped", async t => {
  const f = await setup(t)
  const jobDir = f.jobDir(randomUUID())
  let inside = 0, peak = 0
  await Promise.all(Array.from({ length: 8 }, () => withJobLock(jobDir, async () => {
    inside++; peak = Math.max(peak, inside)
    await delay(15)
    inside--
  })))
  assert.equal(peak, 1)
  const legacy = path.join(path.dirname(jobDir), "." + path.basename(jobDir) + ".access-lock")
  await fs.mkdir(legacy)
  await fs.writeFile(path.join(legacy, "foreign"), "preserve")
  await assert.rejects(withJobLock(jobDir, () => assert.fail("unknown holder admitted")), { code: "render_busy" })
  assert.equal(await fs.readFile(path.join(legacy, "foreign"), "utf8"), "preserve")
})

for (const swap of ["file", "parent"]) {
  test(`retirement: final guard replacement of ${swap} preserves both objects`, async t => {
    const f = await setup(t)
    const job = await f.service.submit(f.input)
    await f.finish(job.jobId, { code: 7 })
    const preview = await f.service.retire(job.jobId)
    const target = path.join(job.quarantineDir, "movie.mov")
    const moved = path.join(f.base, "original")
    let checks = 0
    await assert.rejects(f.service.retire(job.jobId, {
      approval: preview.approval,
      check() {
        if (++checks !== 3) return
        if (swap === "parent") {
          syncFS.renameSync(job.quarantineDir, moved)
          syncFS.mkdirSync(job.quarantineDir)
        } else syncFS.renameSync(target, moved)
        syncFS.writeFileSync(target, "foreign replacement")
      },
    }), error => ["render_retire_refused", "render_retire_partial"].includes(error.code))
    assert.equal(await fs.readFile(swap === "parent" ? path.join(moved, "movie.mov") : moved, "utf8"), "rendered bytes")
    // A protected claim may relocate the replacement, but must never erase it.
    const pending = path.join(path.dirname(f.jobDir(job.jobId)), "." + job.jobId + ".retirement")
    if (await exists(target)) assert.equal(await fs.readFile(target, "utf8"), "foreign replacement")
    else {
      const plan = await load(path.join(pending, "plan.json"))
      const entry = plan.entries.find(entry => entry.path === target)
      assert.equal(await fs.readFile(entry.claim, "utf8"), "foreign replacement")
    }
  })
}

test("native OS identity smoke check, not aerender certification", { skip: !["win32", "darwin"].includes(process.platform) }, async () => {
  const adapter = createProcessAdapter()
  const identity = await adapter.self()
  assert.equal(identity.pid, process.pid)
  assert.ok(sameIdentity(identity, await adapter.inspect(process.pid)))
  await assert.rejects(adapter.terminate({ ...identity, startTime: "stale" }), { code: "render_process_identity" })
})
