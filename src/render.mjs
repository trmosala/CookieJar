import * as fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { fail, hash, assertString } from "./protocol.mjs"
import {
  createProcessAdapter, timestamp, sameIdentity, save, load, exists, signature,
  outputSpec, checkDestination, commandFor, readJob, checkCheckpoint, verifyFiles, recoverExited,
} from "./render-worker.mjs"

const terminal = new Set(["completed", "failed", "cancelled"])
const jobID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const plain = value => JSON.parse(JSON.stringify(value))

async function progress(job) {
  let handle
  try {
    handle = await fs.open(job.logPath, "r")
    const stat = await handle.stat()
    if (!stat.isFile()) throw new Error("Log is not a regular file")
    const size = Math.min(stat.size, 65536)
    const buffer = Buffer.alloc(size)
    await handle.read(buffer, 0, size, stat.size - size)
    // Only complete, explicit aerender frame counters; timecodes and free text
    // are not percentages. A reported last frame is not proof of completion.
    const lines = buffer.toString("utf8").split(/\r?\n/)
    if (stat.size > size) lines.shift()
    lines.pop()
    let frame = null
    for (const line of lines) {
      const match = line.match(/^PROGRESS:\s+\d+:\d{2}:\d{2}:\d{2}\s+\((\d+)\)(?:\s|$)/)
      if (!match) continue
      const value = Number(match[1])
      if (Number.isSafeInteger(value) && value >= job.startFrame && value <= job.endFrame) {
        frame = frame === null ? value : Math.max(frame, value)
      }
    }
    return {
      available: frame !== null, frame, percent: null, source: "aerender-log",
      reason: frame === null ? "No recognized frame counter; exact live progress unavailable" : "Last logged frame, not a completion guarantee",
    }
  } catch (error) {
    return { available: false, frame: null, percent: null, source: "aerender-log", reason: "Log unavailable: " + error.code }
  } finally { await handle?.close() }
}

/**
 * Await createRenderer(...) before use. processAdapter is an OS-only testing seam:
 * {platform, launch(jobDir), self(), start(command, logFd), inspect(pid),
 * discover({executable,args}), terminate(identity)}. See render-worker.mjs.
 * No Session audit or grant credentials are persisted. The caller owns retention
 * of manifests and quarantine; unknown records are never reaped.
 * New jobs lease a private verified copy and never change the source pin.
 * Terminal status releases only that copy, once the supervisor has exited.
 * templates contains host-confirmed names, not model assertions. The caller must
 * confirm compId maps to the unique compName in the selected checkpoint and that
 * templates produce exactly the requested filename/frame numbering (step 1).
 * Unexpected names, sidecars, subdirectories, missing frames or empty files fail
 * verification. No codecs, Media Encoder, or media-decoding validation is implied.
 */
export async function createRenderer({ dataDir, grants, checkpoints, aerenderPath = process.env.CM_AE_AERENDER, processAdapter } = {}) {
  if (!path.isAbsolute(dataDir || "")) fail("render_config", "dataDir must be absolute")
  if (!grants?.check || !checkpoints?.verify) fail("render_config", "Storage services are required")
  const adapter = processAdapter ?? createProcessAdapter()
  const root = path.join(dataDir, "render", "jobs")
  await fs.mkdir(root, { recursive: true, mode: 0o700 })
  if (await fs.realpath(root) !== root) fail("render_config", "Recovery directory must be canonical and not symlinked")
  let closed = false
  // ponytail: serialize mutations in this service; filesystem reservations arbitrate
  // independent services. Per-directory parallel submission can be added if needed.
  let pending = Promise.resolve()
  const serial = operation => {
    const result = pending.then(() => {
      if (closed) fail("render_closed", "Renderer is closed")
      return operation()
    })
    pending = result.catch(() => {})
    return result
  }
  function directory(id) {
    if (typeof id !== "string" || !jobID.test(id)) fail("render_job", "Invalid render job ID")
    return path.join(root, id)
  }
  async function optional(file) {
    return await exists(file) ? load(file) : null
  }
  async function release(job) {
    // Serialize release across renderer instances so a stale observation cannot
    // rename a new job's reservation after another observer has released ours.
    const lock = path.join(root, "." + job.jobId + ".release-lock")
    try { await fs.mkdir(lock, { mode: 0o700 }) } catch (error) {
      if (error.code === "EEXIST") return
      throw error
    }
    try {
      const owner = await optional(path.join(job.reservationPath, "owner.json"))
      if (owner?.jobId !== job.jobId || owner?.jobDir !== directory(job.jobId)) return
      const retired = job.reservationPath + "." + job.jobId + ".released"
      await fs.rename(job.reservationPath, retired)
      await fs.rm(retired, { recursive: true })
    } finally { await fs.rmdir(lock) }
  }
  async function releaseCheckpoint(job, worker) {
    // Inspection errors must also block legacy receipt cleanup and reservation release.
    const workerLive = worker?.identity ? await adapter.inspect(worker.identity.pid) : null
    // Version 1 used a shared boolean pin without ownership. Never guess its owner.
    if (job.version !== 2) return { ownership: "shared", state: "preserved" }
    if (sameIdentity(worker?.identity, workerLive)) {
      return { ownership: "integration", state: "held", reason: "Supervisor has not exited yet" }
    }
    const recordPath = path.join(directory(job.jobId), "checkpoint-release.json")
    let record = await optional(recordPath)
    if (record && (record.jobId !== job.jobId || record.commandHash !== job.commandHash ||
        !["releasing", "released"].includes(record.state))) fail("render_corrupt", "Invalid checkpoint release record")
    if (record?.state === "released") return { ownership: "integration", ...record }
    try {
      const actual = await signature(job.checkpoint.path)
      if (hash(actual) !== hash(job.checkpointSignature)) fail("render_unknown", "Private checkpoint was replaced; left untouched")
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "render_output") throw error
      // Another observer may chmod/unlink after our record read. Only a validated
      // durable release record can explain that race; never delete on a failed hash.
      const concurrent = await optional(recordPath)
      if (!concurrent || concurrent.jobId !== job.jobId || concurrent.commandHash !== job.commandHash ||
          !["releasing", "released"].includes(concurrent.state)) throw error
      if (error.code !== "ENOENT" || concurrent.state === "released") return { ownership: "integration", ...concurrent }
      record = concurrent
    }
    // Intent precedes deletion. Retrying this job-local path cannot unpin another
    // job or a manual pin, including a crash between deletion and the final record.
    record = { jobId: job.jobId, commandHash: job.commandHash, state: "releasing" }
    await save(recordPath, record)
    try {
      await fs.chmod(job.checkpoint.path, 0o600)
      await fs.unlink(job.checkpoint.path)
    } catch (error) { if (error.code !== "ENOENT") throw error }
    record = { ...record, state: "released", releasedAt: timestamp() }
    await save(recordPath, record)
    return { ownership: "integration", ...record }
  }
  async function observe(id) {
    const jobDir = directory(id)
    if (!await exists(jobDir)) fail("render_job", "Render job does not exist")
    let job
    try { job = await readJob(jobDir) } catch (error) {
      return { jobId: id, state: "unknown", reason: "corrupt_manifest", detail: error.message, deliverables: [], controllable: false }
    }
    const observed = {
      ...job, state: "unknown", reason: null, deliverables: [], controllable: false,
      progress: await progress(job), observedAt: timestamp(), outputState: "unverified",
      checkpointRetention: { ownership: job.version === 2 ? "integration" : "shared", state: "held" },
    }
    try {
      const receipt = await optional(path.join(jobDir, "receipt.json"))
      const worker = await optional(path.join(jobDir, "worker.json"))
      const child = await optional(path.join(jobDir, "process.json"))
      if (worker && worker.jobId !== id || child && (child.jobId !== id || child.commandHash !== job.commandHash)) {
        fail("render_corrupt", "Process receipt belongs to another job")
      }
      observed.workerIdentity = worker?.identity ?? null
      observed.processIdentity = child?.identity ?? null
      observed.cancellation = await optional(path.join(jobDir, "cancellation.json"))
      if (receipt) {
        if (receipt.jobId !== id || receipt.commandHash !== job.commandHash ||
            !["completed", "failed", "cancelled", "unknown"].includes(receipt.state) ||
            !Array.isArray(receipt.files) || !receipt.finishedAt) fail("render_corrupt", "Invalid completion receipt")
        if (receipt.state !== "unknown") {
          if (receipt.log) {
            const actual = await signature(job.logPath)
            if (actual.hash !== receipt.log.hash || actual.size !== receipt.log.size) fail("render_unknown", "Receipt log missing or changed")
          } else if (await exists(path.join(jobDir, "launch.json"))) {
            fail("render_unknown", "Launched render has no verified log")
          }
          if (receipt.state !== "completed" && receipt.quarantinePath !== job.quarantineDir) {
            fail("render_unknown", "Failed or cancelled job has no verified quarantine")
          }
        }
        observed.receipt = receipt
        observed.finishedAt = receipt.finishedAt
        observed.outputState = receipt.quarantinePath ? "quarantined_partial" : "unverified"
        if (receipt.state === "completed") {
          if (receipt.exit?.code !== 0 || receipt.exit.signal || receipt.exit.error ||
              receipt.files.length !== job.expectedOutputs.names.length ||
              new Set(receipt.files.map(file => file.name)).size !== receipt.files.length ||
              receipt.files.some(file => !job.expectedOutputs.names.includes(file.name))) {
            fail("render_corrupt", "Completion receipt does not prove the expected render")
          }
          if (!receipt.log) fail("render_unknown", "Completion log signature missing")
          const log = await signature(job.logPath)
          if (log.hash !== receipt.log.hash || log.size !== receipt.log.size) fail("render_unknown", "Completion log missing or changed")
          await verifyFiles(job.destinationDir, receipt.files)
          observed.outputState = "verified_completed"
          observed.deliverables = receipt.files.map(file => ({
            path: path.join(job.destinationDir, file.name), size: file.size, hash: file.hash,
          }))
        } else if (receipt.quarantinePath) {
          if (receipt.quarantinePath !== job.quarantineDir) fail("render_corrupt", "Invalid quarantine path")
          if (await fs.realpath(job.quarantineDir) !== job.quarantineDir ||
              hash((await fs.readdir(job.quarantineDir)).sort()) !== hash(receipt.files.map(file => file.name).sort())) {
            fail("render_unknown", "Quarantine inventory changed")
          }
          // Empty partial files are valid quarantine artifacts, not valid deliverables.
          for (const file of receipt.files) {
            if (path.basename(file.name) !== file.name) fail("render_corrupt", "Invalid quarantine filename")
            const actual = await signature(path.join(job.quarantineDir, file.name))
            if (actual.hash !== file.hash || actual.size !== file.size) fail("render_unknown", "Quarantine changed")
          }
        }
        observed.state = receipt.state
        observed.reason = receipt.uncertainty || receipt.error?.message || null
        if (terminal.has(observed.state)) {
          if (child?.identity && sameIdentity(child.identity, await adapter.inspect(child.identity.pid))) {
            fail("render_unknown", "Completion receipt conflicts with a live render process")
          }
          observed.checkpointRetention = await releaseCheckpoint(job, worker)
          if (observed.checkpointRetention.state === "released") observed.checkpoint = { ...job.checkpoint, pinned: false }
          await release(job)
        }
      } else {
        let workerLive = null, workerError = null
        try { workerLive = worker?.identity ? await adapter.inspect(worker.identity.pid) : null } catch (error) { workerError = error }
        const childLive = child?.identity ? await adapter.inspect(child.identity.pid) : null
        // Inspection failure permits only independently verified child control, never exit recovery.
        if (workerError && !sameIdentity(child?.identity, childLive)) throw workerError
        // A reused supervisor PID does not invalidate an independently verified child.
        if (workerLive && !sameIdentity(worker.identity, workerLive) && !sameIdentity(child?.identity, childLive) ||
            childLive && !sameIdentity(child.identity, childLive)) {
          observed.reason = "process_identity_mismatch"
        } else if (sameIdentity(worker?.identity, workerLive)) {
          observed.state = await exists(path.join(jobDir, "cancel.json")) ? "cancelling" :
            await exists(path.join(jobDir, "launch.json")) ? "running" : "starting"
          observed.controllable = Boolean(childLive)
          if (!childLive && child) observed.reason = "Waiting for supervisor completion receipt"
        } else if (sameIdentity(child?.identity, childLive)) {
          observed.state = await exists(path.join(jobDir, "cancel.json")) ? "cancelling" : "running"
          observed.controllable = true
          observed.reason = "Supervisor unavailable; exit status cannot be recovered without its receipt"
        } else {
          // Discovery covers a crash between spawn and the process identity write.
          // No discovery match is NOT evidence of a successful exit.
          const discovered = await adapter.discover(job.command)
          observed.discoveredProcesses = discovered
          if (!discovered.length && await exists(path.join(jobDir, "exit.json"))) {
            if (await recoverExited(jobDir, job)) return observe(id)
          }
          observed.reason = discovered.length ? "unrecorded_process_identity" : "missing_completion_receipt"
          observed.controllable = false
        }
      }
    } catch (error) {
      observed.state = "unknown"
      observed.reason = error.code || "recovery_unavailable"
      observed.detail = error.message
      observed.outputState = "unverified"
      observed.deliverables = []
      observed.controllable = false
    }
    // Last observation is useful but never treated as authoritative completion.
    await save(path.join(jobDir, "observation.json"), observed)
    return observed
  }
  async function reconcile() {
    const jobs = []
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      if (!jobID.test(entry.name)) continue
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        jobs.push({ jobId: entry.name, state: "unknown", reason: "invalid_job_directory", deliverables: [], controllable: false })
      } else jobs.push(await observe(entry.name))
    }
    return jobs
  }
  async function submit(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) fail("invalid_payload", "Render submission must be an object")
    for (const key of ["sessionID", "bindingID", "checkpointId", "compName", "renderSettings", "outputModule", "outputPath"]) {
      assertString(input[key], key)
      if (/[\0\r\n]/.test(input[key])) fail("invalid_payload", "Render arguments cannot contain NUL or newlines")
    }
    if (!(typeof input.compId === "string" && input.compId.length || Number.isSafeInteger(input.compId) && input.compId > 0)) {
      fail("invalid_payload", "A composition ID is required")
    }
    if (!Number.isSafeInteger(input.startFrame) || !Number.isSafeInteger(input.endFrame) ||
        input.startFrame < 0 || input.endFrame < input.startFrame || input.endFrame - input.startFrame >= 100000) {
      fail("invalid_payload", "Use an inclusive nonnegative frame range of at most 100000 frames")
    }
    if (!Array.isArray(input.templates?.renderSettings) || !input.templates.renderSettings.includes(input.renderSettings) ||
        !Array.isArray(input.templates?.outputModules) || !input.templates.outputModules.includes(input.outputModule)) {
      fail("render_template", "Selected templates were not confirmed installed by the host")
    }
    // aerenderPath is deployment configuration, never a submission argument.
    if (!path.isAbsolute(aerenderPath || "") || /[\0\r\n]/.test(aerenderPath)) fail("render_config", "Set an absolute trusted CM_AE_AERENDER executable")
    const executable = await fs.realpath(aerenderPath)
    if (!(await fs.stat(executable)).isFile()) fail("render_config", "aerender executable is not a file")
    const verified = await checkpoints.verify(input.checkpointId)
    if (!verified || verified.id !== input.checkpointId || verified.verified !== true ||
        !path.isAbsolute(verified.path || "") || verified.path === verified.projectPath ||
        ![".aep", ".aepx"].includes(path.extname(verified.path).toLowerCase()) ||
        !/^[0-9a-f]{64}$/.test(verified.hash || "") || !Number.isSafeInteger(verified.size) || verified.size <= 0) {
      fail("render_checkpoint", "A verified immutable checkpoint is required")
    }
    const request = {
      sessionID: input.sessionID, bindingID: input.bindingID, path: input.outputPath,
      write: true, projectPath: verified.projectPath,
    }
    const destination = await grants.check(request)
    if (typeof destination !== "string" || !path.isAbsolute(destination)) fail("render_grant", "Grant check must return an absolute canonical destination")
    const destinationDir = path.dirname(destination)
    if (await fs.realpath(destinationDir) !== destinationDir) fail("render_grant", "Grant destination is not canonical")
    const expectedOutputs = outputSpec(destination, input.startFrame, input.endFrame)
    const id = randomUUID()
    const jobDir = directory(id)
    const job = {
      version: 2, jobId: id, state: "starting", createdAt: timestamp(), updatedAt: timestamp(),
      checkpoint: plain(verified), compId: input.compId, compName: input.compName,
      startFrame: input.startFrame, endFrame: input.endFrame,
      renderSettings: input.renderSettings, outputModule: input.outputModule,
      templates: { renderSettings: input.renderSettings, outputModule: input.outputModule },
      outputPath: destination, destinationDir, expectedOutputs, aerenderPath: executable,
      stageDir: path.join(destinationDir, ".cm-ae-stage-" + id),
      quarantineDir: path.join(destinationDir, ".cm-ae-quarantine-" + id),
      reservationPath: path.join(destinationDir, ".cm-ae-render-reservation"),
      logPath: path.join(jobDir, "aerender.log"),
      note: "Renders this immutable checkpoint only; later edits to the live AE project are not included.",
    }
    // ponytail: one reservation per destination directory also prevents overlapping
    // sequence patterns. Replace with intersecting-pattern locks only if necessary.
    try { await fs.mkdir(job.reservationPath, { mode: 0o700 }) } catch (error) {
      if (error.code === "EEXIST") fail("render_collision", "Destination directory is reserved by another or unreconciled job")
      throw error
    }
    let durable = false
    let created = false
    try {
      await save(path.join(job.reservationPath, "owner.json"), { jobId: id, jobDir })
      await checkDestination(job)
      // A boolean shared pin cannot distinguish manual pins or concurrent jobs.
      // Copy the selected checkpoint, never the live project, into a private lease.
      await checkCheckpoint(job)
      await fs.mkdir(jobDir, { mode: 0o700 })
      created = true
      const checkpointPath = path.join(jobDir, "checkpoint" + path.extname(verified.path).toLowerCase())
      await fs.copyFile(verified.path, checkpointPath, fs.constants.COPYFILE_EXCL)
      await fs.chmod(checkpointPath, 0o600)
      const copied = await fs.open(checkpointPath, "r+")
      try { await copied.sync() } finally { await copied.close() }
      job.sourceCheckpoint = plain(verified)
      job.checkpoint = {
        ...plain(verified), id, path: checkpointPath, pinned: true, storageMode: "render-private",
      }
      await checkCheckpoint(job)
      job.checkpointSignature = await signature(checkpointPath)
      await fs.chmod(checkpointPath, 0o400)
      await fs.mkdir(job.stageDir, { mode: 0o700 })
      job.command = commandFor(job)
      job.commandHash = hash(job.command)
      await save(path.join(jobDir, "manifest.json"), job)
      durable = true
      await adapter.launch(jobDir)
      const deadline = Date.now() + 15000
      while (!await exists(path.join(jobDir, "worker.json"))) {
        if (Date.now() > deadline) fail("render_launch", "Supervisor identity unavailable; job retained for recovery")
        await delay(50)
      }
      const worker = await load(path.join(jobDir, "worker.json"))
      if (worker.jobId !== id || !sameIdentity(worker.identity, await adapter.inspect(worker.identity.pid))) {
        fail("render_process_identity", "Supervisor identity mismatch")
      }
      // This permission is ephemeral; only the grant-checked canonical path is durable.
      const rechecked = await grants.check(request)
      if (rechecked !== destination) fail("render_grant", "Destination grant changed before launch")
      await checkDestination(job)
      await checkCheckpoint(job)
      await save(path.join(jobDir, "permit.json"), { commandHash: job.commandHash, at: timestamp() })
      return observe(id)
    } catch (error) {
      if (durable) {
        await save(path.join(jobDir, "cancel.json"), { at: timestamp(), reason: "submission_failed" })
        error.details = { ...error.details, jobId: id }
      } else {
        // No process can exist before a durable manifest.
        if (created) await fs.rm(jobDir, { recursive: true, force: true })
        await release(job)
      }
      throw error
    }
  }
  const service = {
    submit: input => serial(() => submit(input)),
    status: id => serial(() => observe(id)),
    result: id => serial(async () => {
      const job = await observe(id)
      return {
        jobId: id, state: job.state, verified: job.state === "completed",
        outputs: job.state === "completed" ? job.deliverables : [],
        quarantinePath: job.receipt?.quarantinePath ?? null, reason: job.reason, logPath: job.logPath ?? null,
      }
    }),
    list: () => serial(reconcile),
    reconcile: () => serial(reconcile),
    cancel: id => serial(async () => {
      const job = await observe(id)
      if (terminal.has(job.state)) return job
      if (job.reason === "corrupt_manifest" || job.reason === "process_identity_mismatch" || job.state === "unknown") {
        fail("render_process_identity", "Job identity is not safely controllable", { jobId: id, reason: job.reason })
      }
      const jobDir = directory(id)
      await save(path.join(jobDir, "cancel.json"), { at: timestamp(), reason: "requested" })
      let worker = null
      try { worker = job.workerIdentity && await adapter.inspect(job.workerIdentity.pid) } catch (error) {
        // This permits only the child identity recheck below, not supervisor cleanup.
        if (!job.processIdentity) throw error
      }
      if (!sameIdentity(job.workerIdentity, worker) && job.processIdentity) {
        const live = await adapter.inspect(job.processIdentity.pid)
        if (!sameIdentity(job.processIdentity, live)) fail("render_process_identity", "Process identity changed before cancellation")
        await save(path.join(jobDir, "cancellation.json"), {
          ...await adapter.terminate(job.processIdentity), at: timestamp(),
        })
      }
      return observe(id)
    }),
    close: async () => { await pending; closed = true },
  }
  await reconcile()
  return service
}
