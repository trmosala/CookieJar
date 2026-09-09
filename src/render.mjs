import * as fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { fail, hash, assertString } from "./protocol.mjs"
import { secureDirectory } from "./storage.mjs"
import {
  createProcessAdapter, timestamp, sameIdentity, save, load, exists, signature,
  outputSpec, checkDestination, commandFor, readJob, checkCheckpoint, verifyFiles, recoverExited,
  directoryIdentity, withJobLock,
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
 * No Session audit or grant credentials are persisted. retire(id) previews explicit
 * expiry; retire(id, {approval: preview.approval}) requires caller-confirmed warning.
 * Unknown/legacy records are never reaped. Approval is an inventory digest, not a grant.
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
  const rootIdentity = await directoryIdentity(root)
  const retirementPath = id => path.join(root, "." + id + ".retirement")
  const interrupted = id => ({
    jobId: id, state: "unknown", reason: "render_retire_partial", controllable: false, deliverables: [],
    remediation: "manual_retirement_recovery_required",
  })
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
    // Serialize release across renderer instances; never recursively erase a
    // replacement reservation or foreign entries added to an owned reservation.
    const lock = path.join(root, "." + job.jobId + ".release-lock")
    try { await fs.mkdir(lock, { mode: 0o700 }) } catch (error) {
      if (error.code === "EEXIST") return
      throw error
    }
    try {
      if (!await exists(job.reservationPath)) return
      const identity = await directoryIdentity(job.reservationPath)
      const ownerPath = path.join(job.reservationPath, "owner.json")
      const before = await signature(ownerPath)
      const owner = await load(ownerPath)
      if (owner?.jobId !== job.jobId || owner?.jobDir !== directory(job.jobId)) return
      if (job.ownership && hash(identity) !== hash(job.ownership.reservation) ||
          hash((await fs.readdir(job.reservationPath)).sort()) !== hash(["owner.json"]) ||
          hash(await signature(ownerPath)) !== hash(before) ||
          hash(await directoryIdentity(job.reservationPath)) !== hash(identity)) {
        fail("render_unknown", "Reservation changed; left untouched")
      }
      await fs.unlink(ownerPath)
      await fs.rmdir(job.reservationPath)
    } finally { await fs.rmdir(lock) }
  }
  async function releaseCheckpoint(job, worker) {
    // Inspection errors must also block legacy receipt cleanup and reservation release.
    const workerLive = worker?.identity ? await adapter.inspect(worker.identity.pid) : null
    if (!sameIdentity(worker?.identity, worker?.identity) || workerLive && !sameIdentity(worker.identity, workerLive)) {
      fail("render_unknown", "Supervisor identity is missing or reused; cleanup refused")
    }
    if (workerLive) return { ownership: "integration", state: "held", reason: "Supervisor has not exited yet" }
    // Version 1 used a shared boolean pin without ownership. Never guess its owner.
    if (job.version !== 2) return { ownership: "shared", state: "preserved" }
    const recordPath = path.join(directory(job.jobId), "checkpoint-release.json")
    let record = await optional(recordPath)
    if (record && (record.jobId !== job.jobId || record.commandHash !== job.commandHash ||
        !["releasing", "released"].includes(record.state))) fail("render_corrupt", "Invalid checkpoint release record")
    if (record?.state === "released") return { ownership: "integration", ...record }
    try {
      const actual = await signature(job.checkpoint.path)
      if (hash(actual) !== hash(job.checkpointSignature)) fail("render_unknown", "Private checkpoint was replaced; left untouched")
      if ((await fs.lstat(job.checkpoint.path)).nlink !== 1) fail("render_unknown", "Private checkpoint became shared; left untouched")
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
  const observe = id => withJobLock(directory(id), () => observeUnlocked(id))
  async function observeUnlocked(id, mutate = true) {
    const jobDir = directory(id)
    // Presence alone blocks recovery, even for a corrupt plan or missing manifest.
    // Never infer which deletions completed, or resume them on a restart.
    if (await exists(retirementPath(id))) return interrupted(id)
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
        if (mutate && terminal.has(observed.state)) {
          if (child?.identity && await adapter.inspect(child.identity.pid)) {
            fail("render_unknown", "Completion receipt conflicts with a live or reused render PID")
          }
          observed.checkpointRetention = await releaseCheckpoint(job, worker)
          if (observed.checkpointRetention.state === "released") observed.checkpoint = { ...job.checkpoint, pinned: false }
          if (observed.checkpointRetention.state !== "held") await release(job)
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
          if (mutate && !discovered.length && await exists(path.join(jobDir, "exit.json"))) {
            if (await recoverExited(jobDir, job)) return observeUnlocked(id)
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
    if (mutate) await save(path.join(jobDir, "observation.json"), observed)
    return observed
  }
  async function reconcile() {
    const jobs = []
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      const retired = entry.name.match(/^\.(.+)\.retirement$/)?.[1]
      if (retired && jobID.test(retired)) {
        if (!jobs.some(job => job.jobId === retired)) {
          try { jobs.push(await observe(retired)) } catch (error) {
            if (error.code === "render_busy") {
              jobs.push({ jobId: retired, state: "unknown", reason: "render_busy", deliverables: [], controllable: false })
            } else if (error.code !== "render_job") throw error
          }
        }
        continue
      }
      if (!jobID.test(entry.name) || jobs.some(job => job.jobId === entry.name)) continue
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        jobs.push({ jobId: entry.name, state: "unknown", reason: "invalid_job_directory", deliverables: [], controllable: false })
      } else {
        try { jobs.push(await observe(entry.name)) } catch (error) {
          // A retirement may finish after readdir but before we acquire the job gate.
          // Missing is not evidence of completion; never recreate its observation.
          if (error.code === "render_busy") {
            jobs.push({ jobId: entry.name, state: "unknown", reason: "render_busy", deliverables: [], controllable: false })
          } else if (error.code !== "render_job") throw error
        }
      }
    }
    return jobs
  }
  async function retire(id, { approval, check = () => {} } = {}) {
    // Caller-owned synchronous lifetime/scope guard; never persisted as approval.
    check()
    const jobDir = directory(id)
    const removed = [], claimed = []
    const recoveryPath = retirementPath(id)
    if (!await exists(recoveryPath) && !await exists(jobDir)) fail("render_job", "Render job does not exist")
    try {
      if (await exists(recoveryPath)) fail("render_retire_refused", "Interrupted retirement requires manual recovery; plan and claims preserved")
      const job = await readJob(jobDir)
      const refuse = message => fail("render_retire_refused", message)
      if (job.version !== 2 || !job.ownership) refuse("Legacy artifact ownership is unproven; records preserved")
      const worker = await optional(path.join(jobDir, "worker.json"))
      const child = await optional(path.join(jobDir, "process.json"))
      const receipt = await optional(path.join(jobDir, "receipt.json"))
      const launch = await optional(path.join(jobDir, "launch.json"))
      if (!receipt || !terminal.has(receipt.state) || receipt.uncertainty) refuse("No certain terminal receipt")
      if (worker?.jobId !== id || !sameIdentity(worker.identity, worker.identity)) refuse("Supervisor identity is unproven")
      if (launch && (launch.jobId !== id || launch.commandHash !== job.commandHash ||
          child?.jobId !== id || child.commandHash !== job.commandHash ||
          !sameIdentity(child.identity, child.identity) || child.pid !== child.identity.pid ||
          !sameIdentity(receipt.processIdentity, child.identity))) refuse("Launched child identity is unproven")
      if (!launch && (child || receipt.exit || receipt.processIdentity || receipt.state === "completed")) {
        refuse("Launch history is inconsistent")
      }
      if (launch && (!receipt.exit || receipt.exit.quiescent === false ||
          (receipt.cancellation?.requested || receipt.exit.signal || receipt.exit.error ||
            !Number.isInteger(receipt.exit.code)) && receipt.exit.quiescent !== true)) {
        refuse("Descendant shutdown is not certified")
      }
      async function quiescent() {
        for (const identity of [worker.identity, child?.identity].filter(Boolean)) {
          // A reused or inaccessible PID is not proof that this job is safe to erase.
          if (await adapter.inspect(identity.pid) !== null) refuse("Recorded process is live or its PID was reused")
        }
        const discovered = await adapter.discover(job.command)
        if (!Array.isArray(discovered) || discovered.length) refuse("Unrecorded render processes may still exist")
      }
      await quiescent()
      const observed = await observeUnlocked(id, false)
      if (!terminal.has(observed.state)) refuse("Terminal artifacts cannot be verified: " + (observed.detail || observed.reason))
      const directories = []
      const files = []
      async function ownedDirectory(target, expected) {
        if (!expected || hash(await directoryIdentity(target)) !== hash(expected)) refuse("Directory ownership changed: " + target)
        const names = (await fs.readdir(target)).sort()
        directories.push({ path: target, identity: expected, names })
        return names
      }
      async function ownedFile(target, expected) {
        const actual = await signature(target)
        if (expected && hash(actual) !== hash(expected)) refuse("Artifact was replaced or modified: " + target)
        files.push({ path: target, signature: actual })
      }
      const names = await ownedDirectory(jobDir, job.ownership.job)
      if (hash(await directoryIdentity(job.destinationDir)) !== hash(job.ownership.destination)) {
        refuse("Destination directory was replaced")
      }
      const artifactDir = receipt.state === "completed" ? job.stageDir : job.quarantineDir
      if (await exists(receipt.state === "completed" ? job.quarantineDir : job.stageDir)) refuse("Ambiguous staging/quarantine")
      const artifactNames = await ownedDirectory(artifactDir, job.ownership.stage)
      if (hash(artifactNames) !== hash(receipt.files.map(file => file.name).sort())) refuse("Artifact inventory changed")
      for (const file of receipt.files) {
        if (path.basename(file.name) !== file.name) refuse("Invalid artifact filename")
        await ownedFile(path.join(artifactDir, file.name), {
          size: file.size, hash: file.hash, dev: file.dev, ino: file.ino,
        })
      }
      const records = new Set(["manifest.json", "worker.json", "process.json", "permit.json",
        "launch.json", "exit.json", "publication.json", "receipt.json", "cancel.json",
        "cancellation.json", "checkpoint-release.json", "observation.json"])
      const inspected = { "manifest.json": job, "worker.json": worker, "process.json": child,
        "receipt.json": receipt, "launch.json": launch }
      if (Object.entries(inspected).some(([name, value]) => value !== null && !names.includes(name))) {
        refuse("Inspected recovery record disappeared")
      }
      const checkpointName = path.basename(job.checkpoint.path)
      const releaseRecord = await optional(path.join(jobDir, "checkpoint-release.json"))
      if (releaseRecord && (releaseRecord.jobId !== id || releaseRecord.commandHash !== job.commandHash ||
          !["releasing", "released"].includes(releaseRecord.state))) refuse("Invalid checkpoint release record")
      if (!names.includes(checkpointName) && !releaseRecord) refuse("Private checkpoint disappeared without a release record")
      for (const name of names) {
        const target = path.join(jobDir, name)
        if (name === "worker-lock") {
          if ((await ownedDirectory(target, worker.lockIdentity)).length) refuse("Worker lock is not empty")
        } else if (name === checkpointName) {
          if (releaseRecord?.state === "released") refuse("Released checkpoint path was recreated")
          await ownedFile(target, job.checkpointSignature)
          if ((await fs.lstat(target)).nlink !== 1) refuse("Private checkpoint has shared hard links")
        } else if (name === "aerender.log") {
          if (!receipt.log) refuse("Log ownership is unproven")
          await ownedFile(target, receipt.log)
        } else if (records.has(name)) {
          const before = await signature(target)
          const value = await load(target)
          if (Object.hasOwn(inspected, name) && hash(value) !== hash(inspected[name])) refuse("Inspected record changed: " + name)
          if (!value || typeof value !== "object" || Array.isArray(value) ||
              !["permit.json", "cancel.json", "cancellation.json"].includes(name) && value.jobId !== id ||
              value.jobId !== undefined && value.jobId !== id ||
              value.commandHash !== undefined && value.commandHash !== job.commandHash) refuse("Foreign recovery record: " + name)
          if (name === "exit.json" && (hash(value.exit) !== hash(receipt.exit) ||
              hash(value.log) !== hash(receipt.log))) refuse("Conflicting exit record")
          if (name === "cancellation.json" && value.requested && receipt.exit?.quiescent !== true) {
            refuse("Cancellation has uncertain descendants")
          }
          await ownedFile(target, before)
        } else refuse("Unowned or in-flight job entry: " + name)
      }
      if (!names.includes("worker-lock")) refuse("Supervisor admission lock is missing")
      // Another job may now reserve this destination. Never touch its reservation.
      const preserved = [job.sourceCheckpoint.path, ...job.expectedOutputs.names.map(name => path.join(job.destinationDir, name))]
      if (await exists(job.reservationPath)) {
        const ownerPath = path.join(job.reservationPath, "owner.json")
        await directoryIdentity(job.reservationPath)
        const owner = await load(ownerPath)
        if (owner.jobId === id) {
          if (owner.jobDir !== jobDir) refuse("Reservation ownership changed")
          if (hash(await ownedDirectory(job.reservationPath, job.ownership.reservation)) !== hash(["owner.json"])) {
            refuse("Reservation inventory changed")
          }
          await ownedFile(ownerPath)
        } else preserved.push(job.reservationPath)
      }
      if (await exists(path.join(root, "." + id + ".release-lock"))) refuse("Checkpoint/reservation release is in flight")
      for (const target of preserved) {
        if (!path.isAbsolute(target) || directories.some(dir => target === dir.path || target.startsWith(dir.path + path.sep))) {
          refuse("Deletion would overlap a protected path")
        }
      }
      const warning = "Permanently remove this job's recovery records, log, private checkpoint and staging/quarantined partials. " +
        "Status, cancellation and recovery will no longer be available. Published outputs and the source checkpoint are preserved."
      // Observations are disposable and change on every status poll, not approval scope.
      const digest = hash({ jobId: id, commandHash: job.commandHash, warning,
        directories: directories.map(dir => ({ ...dir, names: dir.names.filter(name => name !== "observation.json") })),
        files: files.filter(file => path.basename(file.path) !== "observation.json"), preserved })
      const preview = { jobId: id, state: observed.state, retired: false, approval: digest, warning,
        remove: directories.map(dir => dir.path), preserve: preserved }
      check()
      if (approval === undefined) return { ...preview, approvalRequired: true }
      if (typeof approval !== "string" || approval !== digest) refuse("Approval is stale or does not match this inventory; preview and ask again")
      await quiescent()
      async function checkDirectories() {
        if (hash(await directoryIdentity(job.destinationDir)) !== hash(job.ownership.destination)) refuse("Destination changed during retirement")
        for (const dir of directories) {
          if (hash(await directoryIdentity(dir.path)) !== hash(dir.identity)) refuse("Directory replaced during retirement: " + dir.path)
        }
      }
      await checkDirectories()
      for (const dir of directories) {
        if (hash((await fs.readdir(dir.path)).sort()) !== hash(dir.names)) refuse("Inventory changed during retirement")
      }
      for (const file of files) {
        if (hash(await signature(file.path)) !== hash(file.signature)) refuse("File changed during retirement: " + file.path)
      }
      // Claim storage is outside all source directories, protected by the storage
      // service's current-user-only ACL/mode. Cross-volume rename fails closed:
      // copying would not claim the source name. No callback runs inside a claim.
      if (directories.some(dir => dir.identity.dev !== rootIdentity.dev)) refuse("Retirement requires same-volume protected claim storage")
      if (hash(await directoryIdentity(root)) !== hash(rootIdentity)) refuse("Recovery root changed")
      await secureDirectory(recoveryPath)
      const recoveryIdentity = await directoryIdentity(recoveryPath)
      const marker = ".cookiemonster-storage-owner.json"
      if (hash((await fs.readdir(recoveryPath)).sort()) !== hash([marker])) refuse("Unexpected claim-area entry; preserved")
      const markerPath = path.join(recoveryPath, marker)
      const housekeeping = [{ path: markerPath, signature: await signature(markerPath) }]
      files.sort((a, b) => Number(a.path === path.join(jobDir, "manifest.json")) - Number(b.path === path.join(jobDir, "manifest.json")))
      const entries = [...files, ...directories.filter(dir => dir.path !== jobDir), directories[0]].map((entry, index) => ({
        ...entry, claim: path.join(recoveryPath, "claim-" + index),
        parent: directories.find(dir => dir.path === path.dirname(entry.path))?.identity ??
          (path.dirname(entry.path) === root ? rootIdentity : job.ownership.destination),
      }))
      const planPath = path.join(recoveryPath, "plan.json")
      // Intent precedes the first rename. Missing claims after a crash do NOT prove
      // deletion; manual recovery must inspect originals and claims without overwrite.
      await save(planPath, { jobId: id, commandHash: job.commandHash, entries, preserved,
        remediation: "Stop render services; inspect original and claim identities against this plan. Preserve mismatches. Restore only to vacant verified parents, or explicitly remove proven owned remnants. Never replay this plan as authorization." })
      housekeeping.push({ path: planPath, signature: await signature(planPath) })
      for (const entry of entries) {
        if (entry.signature) {
          await checkDirectories()
          if (hash(await signature(entry.path)) !== hash(entry.signature)) refuse("File changed before claim")
        }
        check()
        if (hash(await directoryIdentity(root)) !== hash(rootIdentity) ||
            hash(await directoryIdentity(recoveryPath)) !== hash(recoveryIdentity)) refuse("Claim storage changed")
        if (await exists(entry.claim)) refuse("Claim path is occupied")
        await fs.rename(entry.path, entry.claim)
        claimed.push({ path: entry.path, claim: entry.claim })
        // Verification is of the object actually removed from the source namespace,
        // not the pathname we inspected before rename. A swapped parent also refuses.
        if (hash(await directoryIdentity(path.dirname(entry.path))) !== hash(entry.parent) ||
            await exists(entry.path)) refuse("Source parent or pathname changed during claim; claim preserved")
        if (entry.signature) {
          if (hash(await signature(entry.claim)) !== hash(entry.signature)) refuse("Claimed file was replaced; claim preserved")
          if (entry.path === job.checkpoint.path) {
            if ((await fs.lstat(entry.claim)).nlink !== 1) refuse("Private checkpoint became shared; claim preserved")
            await fs.chmod(entry.claim, 0o600)
          }
          await fs.unlink(entry.claim)
        } else {
          if (hash(await directoryIdentity(entry.claim)) !== hash(entry.identity)) refuse("Claimed directory was replaced; claim preserved")
          // Never recursive: unexpected children remain in the claim for recovery.
          await fs.rmdir(entry.claim)
        }
        removed.push(entry.path)
      }
      if (hash((await fs.readdir(recoveryPath)).sort()) !== hash(housekeeping.map(file => path.basename(file.path)).sort())) {
        refuse("Unexpected claim-area entry; plan preserved")
      }
      for (const file of housekeeping) {
        if (hash(await directoryIdentity(recoveryPath)) !== hash(recoveryIdentity) ||
            hash(await signature(file.path)) !== hash(file.signature)) refuse("Retirement plan changed; preserved")
        await fs.unlink(file.path)
      }
      await fs.rmdir(recoveryPath)
      return { jobId: id, state: "retired", retired: true, removed, preserved }
    } catch (error) {
      fail(removed.length || claimed.length ? "render_retire_partial" : "render_retire_refused", error.message, {
        jobId: id, retired: false, cause: error.code || "verification_failed", removed, claimed,
        recoveryPath: await exists(recoveryPath) ? recoveryPath : null,
        remediation: "manual_retirement_recovery_required",
      })
    }
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
      job.ownership = {
        job: await directoryIdentity(jobDir), stage: await directoryIdentity(job.stageDir),
        destination: await directoryIdentity(destinationDir), reservation: await directoryIdentity(job.reservationPath),
      }
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
      return await withJobLock(jobDir, async () => {
        // This permission is ephemeral; only the grant-checked canonical path is durable.
        const rechecked = await grants.check(request)
        if (rechecked !== destination) fail("render_grant", "Destination grant changed before launch")
        if (await exists(path.join(jobDir, "receipt.json"))) fail("render_launch", "Supervisor already finished before permission")
        await checkDestination(job)
        await checkCheckpoint(job)
        await save(path.join(jobDir, "permit.json"), { commandHash: job.commandHash, at: timestamp() })
        return observeUnlocked(id)
      })
    } catch (error) {
      if (durable) {
        await withJobLock(jobDir, async () => {
          if (await exists(jobDir)) await save(path.join(jobDir, "cancel.json"), { at: timestamp(), reason: "submission_failed" })
        })
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
    cancel: id => serial(() => withJobLock(directory(id), async () => {
      const job = await observeUnlocked(id)
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
      return observeUnlocked(id)
    })),
    retire: (id, options) => serial(() => withJobLock(directory(id), () => retire(id, options))),
    close: async () => { await pending; closed = true },
  }
  await reconcile()
  return service
}
