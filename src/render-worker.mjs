import * as fs from "node:fs/promises"
import { createReadStream } from "node:fs"
import { createHash, randomUUID } from "node:crypto"
import { spawn, execFile } from "node:child_process"
import { promisify } from "node:util"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { fail, hash } from "./protocol.mjs"

const exec = promisify(execFile)
// Resolve the sibling even when this module is inlined into plugin.mjs.
const workerPath = fileURLToPath(new URL("./render-worker.mjs", import.meta.url))
export const timestamp = () => new Date().toISOString()
export const sameIdentity = (a, b) => Boolean(a && b && Number.isSafeInteger(a.pid) && a.pid > 0 &&
  a.pid === b.pid && a.startTime && a.startTime === b.startTime &&
  a.command && a.command === b.command && a.executable && a.executable === b.executable)

export async function exists(file) {
  try { await fs.lstat(file); return true } catch (error) {
    if (error.code === "ENOENT") return false
    throw error
  }
}

// Atomic replacement plus fsync: an interrupted write never becomes valid JSON.
export async function save(file, value) {
  const temp = file + "." + randomUUID() + ".tmp"
  const handle = await fs.open(temp, "wx", 0o600)
  try {
    await handle.writeFile(JSON.stringify({ value, checksum: hash(value) }) + "\n")
    await handle.sync()
  } finally { await handle.close() }
  try {
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(temp, file); break } catch (error) {
        // Concurrent readers/replacers can briefly deny rename on Windows.
        // Never unlink the destination: that would destroy atomic replacement.
        if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt === 9) throw error
        await delay(20 * (attempt + 1))
      }
    }
  } finally {
    await fs.unlink(temp).catch(error => { if (error.code !== "ENOENT") throw error })
  }
  // Windows does not support opening directories for fsync through Node.
  if (process.platform !== "win32") {
    const directory = await fs.open(path.dirname(file), "r")
    try { await directory.sync() } finally { await directory.close() }
  }
}

export async function load(file) {
  const stat = await fs.lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024) fail("render_corrupt", "Invalid recovery record")
  const record = JSON.parse(await fs.readFile(file, "utf8"))
  if (!record || record.checksum !== hash(record.value)) fail("render_corrupt", "Recovery checksum mismatch")
  return record.value
}

export async function signature(file) {
  const before = await fs.lstat(file, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail("render_output", "Expected a bounded regular file", { file })
  }
  const digest = createHash("sha256")
  for await (const chunk of createReadStream(file)) digest.update(chunk)
  const after = await fs.lstat(file, { bigint: true })
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
    fail("render_output", "File changed during verification", { file })
  }
  return { size: Number(after.size), hash: digest.digest("hex"), dev: String(after.dev), ino: String(after.ino) }
}

export function outputSpec(outputPath, startFrame, endFrame) {
  const name = path.basename(outputPath)
  const matches = [...name.matchAll(/\[(#{1,12})\]/g)]
  const remainder = name.replace(/\[(#{1,12})\]/g, "")
  if (matches.length > 1 || /[\[\]#%*?<>:"|\\\x00-\x1f]/.test(remainder) ||
      /[\x3c\x3e]/.test(name) || !name || /[. ]$/.test(name) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) || name.startsWith(".cm-ae-")) {
    fail("render_output", "Use a filename or one explicit [####] image-sequence token")
  }
  const image = /\.(png|jpe?g|tiff?|exr|dpx|cin|tga|psd|bmp|iff|rla|rpf|sgi|hdr)$/i.test(name)
  if (matches.length && !image) fail("render_output", "Sequence output requires a supported still-image extension")
  if (!matches.length && image && startFrame !== endFrame) {
    fail("render_output", "Multi-frame still-image output requires an explicit [####] token")
  }
  if (!matches.length) return { kind: "file", name, names: [name] }
  const token = matches[0][0]
  const width = matches[0][1].length
  const prefix = name.slice(0, matches[0].index)
  const suffix = name.slice(matches[0].index + token.length)
  const names = Array.from({ length: endFrame - startFrame + 1 }, (_, index) =>
    prefix + String(startFrame + index).padStart(width, "0") + suffix)
  return { kind: "sequence", name, prefix, suffix, width, names }
}

const escapeRE = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
export function collides(spec, name) {
  if (spec.kind === "file") return spec.name.toLowerCase() === name.toLowerCase()
  return spec.name.toLowerCase() === name.toLowerCase() ||
    new RegExp("^" + escapeRE(spec.prefix) + "-?\\d+" + escapeRE(spec.suffix) + "$", "i").test(name)
}

export async function checkDestination(job) {
  if (await fs.realpath(job.destinationDir) !== job.destinationDir) fail("render_output", "Destination directory changed")
  for (const name of await fs.readdir(job.destinationDir)) {
    if (collides(job.expectedOutputs, name)) fail("render_collision", "Output already exists", { name })
  }
}

export function commandFor(job) {
  return {
    executable: job.aerenderPath,
    args: ["-project", job.checkpoint.path, "-comp", job.compName,
      "-s", String(job.startFrame), "-e", String(job.endFrame),
      "-RStemplate", job.renderSettings, "-OMtemplate", job.outputModule,
      "-output", path.join(job.stageDir, job.expectedOutputs.name), "-v", "ERRORS_AND_PROGRESS"],
  }
}

export async function readJob(jobDir) {
  if (await fs.realpath(jobDir) !== jobDir) fail("render_corrupt", "Job directory is not canonical")
  const job = await load(path.join(jobDir, "manifest.json"))
  const id = path.basename(jobDir)
  if (![1, 2].includes(job.version) || job.jobId !== id || !/^[0-9a-f-]{36}$/.test(id) ||
      job.version === 2 && (job.checkpoint?.id !== id || job.checkpoint?.storageMode !== "render-private" ||
        ![".aep", ".aepx"].includes(path.extname(job.sourceCheckpoint?.path || "").toLowerCase()) ||
        job.checkpoint.path !== path.join(jobDir, "checkpoint" + path.extname(job.sourceCheckpoint.path).toLowerCase()) ||
        job.sourceCheckpoint.hash !== job.checkpoint.hash || job.sourceCheckpoint.size !== job.checkpoint.size ||
        job.checkpointSignature?.hash !== job.checkpoint.hash || job.checkpointSignature?.size !== job.checkpoint.size ||
        !/^\d+$/.test(job.checkpointSignature?.ino) || !/^\d+$/.test(job.checkpointSignature?.dev)) ||
      !path.isAbsolute(job.outputPath) || !path.isAbsolute(job.aerenderPath) ||
      job.destinationDir !== path.dirname(job.outputPath) ||
      job.stageDir !== path.join(job.destinationDir, ".cm-ae-stage-" + id) ||
      job.quarantineDir !== path.join(job.destinationDir, ".cm-ae-quarantine-" + id) ||
      job.logPath !== path.join(jobDir, "aerender.log") ||
      job.reservationPath !== path.join(job.destinationDir, ".cm-ae-render-reservation") ||
      !Number.isSafeInteger(job.startFrame) || !Number.isSafeInteger(job.endFrame) ||
      job.startFrame < 0 || job.endFrame < job.startFrame || job.endFrame - job.startFrame >= 100000 ||
      !job.checkpoint?.verified || !job.checkpoint?.pinned || !path.isAbsolute(job.checkpoint.path) ||
      !/^[0-9a-f]{64}$/.test(job.checkpoint.hash) ||
      hash(job.expectedOutputs) !== hash(outputSpec(job.outputPath, job.startFrame, job.endFrame)) ||
      hash(job.command) !== hash(commandFor(job)) || job.commandHash !== hash(job.command)) {
    fail("render_corrupt", "Invalid job manifest")
  }
  return job
}

export async function checkCheckpoint(job) {
  const actual = await signature(job.checkpoint.path)
  if (actual.hash !== job.checkpoint.hash || actual.size !== job.checkpoint.size) {
    fail("render_checkpoint", "Immutable checkpoint no longer matches its verified hash")
  }
}

export async function stageFiles(job) {
  if (await fs.realpath(job.stageDir) !== job.stageDir) fail("render_output", "Staging directory changed")
  const names = await fs.readdir(job.stageDir)
  const files = []
  for (const name of names.sort()) files.push({ name, ...await signature(path.join(job.stageDir, name)) })
  return files
}

export async function verifyFiles(directory, files) {
  if (await fs.realpath(directory) !== directory) fail("render_output", "Output directory changed")
  for (const expected of files) {
    if (path.basename(expected.name) !== expected.name) fail("render_corrupt", "Invalid output filename")
    const actual = await signature(path.join(directory, expected.name))
    if (actual.hash !== expected.hash || actual.size !== expected.size || actual.size === 0) {
      fail("render_output", "Output signature mismatch", { name: expected.name })
    }
  }
}

// Only unlink hard links that still identify our unchanged staging files.
export async function rollback(job, files) {
  if (await fs.realpath(job.destinationDir) !== job.destinationDir) fail("render_unknown", "Destination directory changed")
  for (const file of files) {
    const destination = path.join(job.destinationDir, file.name)
    if (!await exists(destination)) continue
    const actual = await signature(destination)
    if (actual.dev === file.dev && actual.ino === file.ino &&
        actual.hash === file.hash && actual.size === file.size) await fs.unlink(destination)
    else fail("render_unknown", "A published path was replaced or modified; it was left untouched")
  }
}

export async function quarantine(job) {
  if (await exists(job.quarantineDir)) {
    if (await exists(job.stageDir)) fail("render_unknown", "Ambiguous quarantine")
    return job.quarantineDir
  }
  if (await fs.realpath(job.stageDir) !== job.stageDir) fail("render_unknown", "Unsafe staging directory")
  await fs.rename(job.stageDir, job.quarantineDir)
  return job.quarantineDir
}

// Called only after both recorded processes are absent. Never resumes publication:
// recovery has no active Session grant. It may verify published files or roll back.
export async function recoverExited(jobDir, job) {
  const receiptPath = path.join(jobDir, "receipt.json")
  const lock = path.join(jobDir, "recovery-lock")
  try { await fs.mkdir(lock, { mode: 0o700 }) } catch (error) {
    if (error.code === "EEXIST") return false
    throw error
  }
  try {
    if (await exists(receiptPath)) return true
    const record = await load(path.join(jobDir, "exit.json"))
    if (record.jobId !== job.jobId || record.commandHash !== job.commandHash ||
        !record.exit || !record.log || !Number.isFinite(Date.parse(record.finishedAt))) {
      fail("render_corrupt", "Invalid durable exit record")
    }
    const log = await signature(job.logPath)
    if (log.hash !== record.log.hash || log.size !== record.log.size) fail("render_unknown", "Exit log missing or changed")
    const publication = await exists(path.join(jobDir, "publication.json"))
      ? await load(path.join(jobDir, "publication.json")) : null
    const files = publication?.files ?? []
    const names = new Set(job.expectedOutputs.names)
    if (publication && (publication.jobId !== job.jobId || !Array.isArray(files) ||
        files.length !== names.size || new Set(files.map(file => file.name)).size !== names.size ||
        files.some(file => !names.has(file.name) || !/^[a-f0-9]{64}$/.test(file.hash) ||
          !Number.isSafeInteger(file.size) || file.size <= 0 || !/^\d+$/.test(file.ino) || !/^\d+$/.test(file.dev)))) {
      fail("render_corrupt", "Invalid publication journal")
    }
    const cancelled = await exists(path.join(jobDir, "cancel.json"))
    let complete = Boolean(publication && !cancelled &&
      record.exit.code === 0 && !record.exit.signal && !record.exit.error)
    if (complete) {
      try {
        await checkCheckpoint(job)
        await verifyFiles(job.destinationDir, files)
        for (const file of files) {
          const actual = await signature(path.join(job.destinationDir, file.name))
          if (actual.dev !== file.dev || actual.ino !== file.ino) fail("render_output", "Published file was replaced")
        }
      } catch { complete = false }
    }
    if (complete) {
      await save(receiptPath, { ...record, state: "completed", files, recoveredAt: timestamp() })
      return true
    }
    let quarantinePath = null
    let state = cancelled ? "cancelled" : "failed"
    let uncertainty = null
    const partials = []
    try {
      await rollback(job, files)
      quarantinePath = await quarantine(job)
      for (const name of (await fs.readdir(quarantinePath)).sort()) {
        partials.push({ name, ...await signature(path.join(quarantinePath, name)) })
      }
      if ((record.cancellation?.requested || record.exit.signal) && record.exit.quiescent !== true) {
        fail("render_unknown", "Partial files quarantined, but descendant shutdown is not certified")
      }
    } catch (error) { state = "unknown"; uncertainty = error.message }
    await save(receiptPath, {
      ...record, state, files: partials, quarantinePath, uncertainty, recoveredAt: timestamp(),
      error: { code: "render_interrupted", message: "Supervisor exited before completing publication" },
    })
    return true
  } finally { await fs.rmdir(lock) }
}

// The adapter is exclusively an OS boundary. launch starts the durable supervisor;
// start returns a child identity and an exit promise resolved only after logs close.
export function createProcessAdapter() {
  const platform = process.platform
  async function windows(action, value) {
    const script = `
$d = $env:CM_AE_PROCESS_QUERY | ConvertFrom-Json
if ($d.action -eq 'inspect' -or $d.action -eq 'discover') {
  $rows = if ($d.action -eq 'inspect') { @(Get-CimInstance Win32_Process -Filter ("ProcessId = " + [int]$d.value) -ErrorAction Stop) } else { @(Get-CimInstance Win32_Process -ErrorAction Stop) }
  @($rows | ForEach-Object {
    $row = $_
    $p = $false
    try {
      $p = [System.Diagnostics.Process]::GetProcessById([int]$row.ProcessId)
      [void]$p.Handle
      $start = $p.StartTime.ToUniversalTime().Ticks
      if ([Math]::Abs($start - $row.CreationDate.ToUniversalTime().Ticks) -gt 10000) { throw 'Process changed during inspection' }
      @{ pid=[int]$row.ProcessId; startTime=$start.ToString(); executable=$row.ExecutablePath; command=$row.CommandLine }
    } catch { if ($d.action -eq 'inspect') { throw } }
    finally { if ($p) { $p.Dispose() } }
  }) | ConvertTo-Json -Compress -Depth 4
} elseif ($d.action -eq 'terminate') {
  $p = [System.Diagnostics.Process]::GetProcessById([int]$d.value.pid)
  try {
    [void]$p.Handle
    $row = Get-CimInstance Win32_Process -Filter ("ProcessId = " + [int]$d.value.pid) -ErrorAction Stop
    if (!$row -or $p.StartTime.ToUniversalTime().Ticks.ToString() -ne $d.value.startTime -or $row.CommandLine -cne $d.value.command -or $row.ExecutablePath -cne $d.value.executable) { throw 'Process identity mismatch' }
    if ($p.CloseMainWindow()) { '{"requested":true,"method":"close-window"}' }
    else { $p.Kill(); '{"requested":true,"method":"process-handle"}' }
  } finally { $p.Dispose() }
}`
    const { stdout } = await exec("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true, timeout: 15000, maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, CM_AE_PROCESS_QUERY: JSON.stringify({ action, value }) },
    })
    return stdout.trim() ? JSON.parse(stdout) : []
  }
  async function inspect(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) fail("render_process", "Invalid process ID")
    if (platform === "win32") {
      const result = await windows("inspect", pid)
      const rows = Array.isArray(result) ? result : [result]
      if (!rows.length) return null
      if (!rows[0].startTime || !rows[0].command || !rows[0].executable) fail("render_process", "Process identity inaccessible")
      return rows[0]
    }
    if (platform === "darwin") {
      // macOS ships JXA and libproc. Read PROC_PIDTBSDINFO's microsecond start
      // time and proc_pidpath, rather than trusting ps's rounded lstart or comm.
      const script = `
ObjC.import('Foundation');
ObjC.import('stdlib');
ObjC.bindFunction('dlopen', ['void *', ['char *', 'int']]);
$.dlopen('/usr/lib/libproc.dylib', 2);
ObjC.bindFunction('proc_pidinfo', ['int', ['int', 'int', 'unsigned long long', 'void *', 'int']]);
ObjC.bindFunction('proc_pidpath', ['int', ['int', 'void *', 'unsigned int']]);
function run(args) {
  const pid = Number(args[0]), info = $.malloc(136), name = $.malloc(4096);
  try {
    if ($.proc_pidinfo(pid, 3, 0, info, 136) !== 136) throw Error('Process identity unavailable');
    const length = $.proc_pidpath(pid, name, 4096);
    if (length <= 0) throw Error('Process executable unavailable');
    return JSON.stringify({
      info: ObjC.unwrap($.NSData.dataWithBytesLength(info, 136).base64EncodedStringWithOptions(0)),
      executable: ObjC.unwrap($.NSString.alloc.initWithBytesLengthEncoding(name, length, 4))
    });
  } finally { $.free(info); $.free(name); }
}`
      async function native() {
        const { stdout } = await exec("/usr/bin/osascript", ["-l", "JavaScript", "-e", script, String(pid)], {
          timeout: 10000, maxBuffer: 1024 * 1024,
        })
        const value = JSON.parse(stdout)
        const info = Buffer.from(value.info, "base64")
        if (info.length !== 136 || info.readUInt32LE(12) !== pid || !value.executable) {
          fail("render_process", "Invalid native process identity")
        }
        return {
          pid, executable: value.executable.replace(/\0+$/, ""),
          startTime: info.readBigUInt64LE(120).toString() + ":" + info.readBigUInt64LE(128).toString(),
        }
      }
      try {
        const before = await native()
        const { stdout } = await exec("/bin/ps", ["-ww", "-p", String(pid), "-o", "command="], {
          env: { ...process.env, LC_ALL: "C" }, timeout: 5000, maxBuffer: 1024 * 1024,
        })
        const after = await native()
        if (before.startTime !== after.startTime || before.executable !== after.executable || !stdout.trim()) {
          fail("render_process", "Process changed during inspection")
        }
        return { ...after, command: stdout.trim() }
      } catch (error) {
        try { await exec("/bin/ps", ["-p", String(pid), "-o", "pid="], { timeout: 5000 }) } catch (probe) {
          if (probe.code === 1 && !probe.stdout?.trim()) return null
        }
        throw error
      }
    }
    fail("render_platform", "Production rendering supports Windows and macOS only")
  }
  const quoteWindows = value => /[\s"]/.test(value) || !value
    ? '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/, "$&$&") + '"' : value
  async function discover(command) {
    const expected = platform === "win32"
      ? [command.executable, ...command.args].map(quoteWindows).join(" ")
      : [command.executable, ...command.args].join(" ")
    if (platform === "win32") {
      const result = await windows("discover", null)
      return (Array.isArray(result) ? result : [result]).filter(item => item.command === expected &&
        item.executable?.toLowerCase() === command.executable.toLowerCase())
    }
    if (platform === "darwin") {
      const { stdout } = await exec("/bin/ps", ["-ww", "-axo", "pid=,command="], { maxBuffer: 32 * 1024 * 1024 })
      const found = []
      for (const line of stdout.split("\n")) {
        const match = line.trim().match(/^(\d+)\s+(.+)$/)
        if (match && match[2] === expected) {
          const item = await inspect(Number(match[1]))
          if (item?.command === expected) found.push(item)
        }
      }
      return found
    }
    fail("render_platform", "Production rendering supports Windows and macOS only")
  }
  return {
    platform,
    inspect,
    discover,
    self: () => inspect(process.pid),
    async launch(jobDir) {
      const child = spawn(process.execPath, [workerPath, jobDir], {
        detached: true, windowsHide: true, stdio: "ignore", shell: false,
      })
      await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject) })
      child.unref()
    },
    async start(command, logFd) {
      const child = spawn(command.executable, command.args, {
        detached: true, windowsHide: true, shell: false, stdio: ["ignore", logFd, logFd],
      })
      const exited = new Promise(resolve => {
        child.once("error", error => resolve({ code: null, signal: null, error: error.message }))
        child.once("close", (code, signal) => resolve({ code, signal, error: null }))
      })
      await new Promise(resolve => { child.once("spawn", resolve); child.once("error", resolve) })
      let identity = null
      if (child.pid) {
        try {
          const candidate = await inspect(child.pid)
          const expected = platform === "win32"
            ? [command.executable, ...command.args].map(quoteWindows).join(" ")
            : [command.executable, ...command.args].join(" ")
          if (candidate?.command === expected &&
              (platform === "win32" ? candidate.executable.toLowerCase() === command.executable.toLowerCase() :
                candidate.executable === command.executable)) identity = candidate
        } catch {}
      }
      return { pid: child.pid ?? null, identity, exited }
    },
    async terminate(identity) {
      if (!sameIdentity(identity, await inspect(identity.pid))) fail("render_process_identity", "Refusing to control a different process")
      if (platform === "win32") return windows("terminate", identity)
      // No tree-wide or forced kill: an orphaned AE engine must not be assumed dead.
      process.kill(identity.pid, "SIGTERM")
      return { requested: true, method: "SIGTERM" }
    },
  }
}

export async function runWorker(jobDir, adapter = createProcessAdapter()) {
  const job = await readJob(jobDir)
  const receiptPath = path.join(jobDir, "receipt.json")
  if (await exists(receiptPath)) return
  // A second supervisor must never launch another render for this job.
  await fs.mkdir(path.join(jobDir, "worker-lock"), { mode: 0o700 })
  const worker = await adapter.self()
  if (!sameIdentity(worker, worker)) fail("render_process", "Cannot identify render supervisor")
  await save(path.join(jobDir, "worker.json"), { jobId: job.jobId, identity: worker, at: timestamp() })
  let launched = false
  let log
  let journal = []
  let exit = null
  let processIdentity = null
  let cancellation = null
  try {
    const deadline = Date.now() + 30000
    while (!await exists(path.join(jobDir, "permit.json"))) {
      if (await exists(path.join(jobDir, "cancel.json"))) fail("render_cancelled", "Cancelled before launch")
      if (Date.now() > deadline) fail("render_launch", "Launch permission expired")
      await delay(50)
    }
    const permit = await load(path.join(jobDir, "permit.json"))
    if (permit.commandHash !== job.commandHash || !Number.isFinite(Date.parse(permit.at)) ||
        Date.parse(permit.at) > Date.now() || Date.now() - Date.parse(permit.at) > 30000) {
      fail("render_launch", "Invalid launch permission")
    }
    await checkCheckpoint(job)
    await checkDestination(job)
    if (await fs.realpath(job.stageDir) !== job.stageDir || (await fs.readdir(job.stageDir)).length) {
      fail("render_collision", "Staging folder is changed or not empty")
    }
    if (await exists(path.join(jobDir, "cancel.json"))) fail("render_cancelled", "Cancelled before launch")
    log = await fs.open(job.logPath, "wx", 0o600)
    await save(path.join(jobDir, "launch.json"), { jobId: job.jobId, commandHash: job.commandHash, at: timestamp() })
    const child = await adapter.start(job.command, log.fd)
    launched = true
    processIdentity = child.identity
    await save(path.join(jobDir, "process.json"), {
      jobId: job.jobId, commandHash: job.commandHash, pid: child.pid, identity: child.identity, at: timestamp(),
    })
    let finished = false
    let cancellationRequest = null
    const exited = child.exited.then(value => { finished = true; return value })
    while (!finished) {
      // Retry failed control only for a new explicit request, never on every poll.
      const request = !cancellation?.requested && await exists(path.join(jobDir, "cancel.json"))
        ? await load(path.join(jobDir, "cancel.json")) : null
      if (request && hash(request) !== cancellationRequest) {
        cancellationRequest = hash(request)
        cancellation = { requested: false, method: "identity-unavailable" }
        if (child.identity) {
          try {
            if (sameIdentity(child.identity, await adapter.inspect(child.identity.pid))) {
              cancellation = await adapter.terminate(child.identity)
            } else cancellation = { requested: false, method: "identity-mismatch" }
          } catch (error) { cancellation = { requested: false, method: "control-unavailable", error: error.message } }
        }
        await save(path.join(jobDir, "cancellation.json"), { ...cancellation, at: timestamp() })
      }
      if (!finished) await Promise.race([exited, delay(100)])
    }
    exit = await exited
    await log.sync()
    await log.close()
    log = null
    await save(path.join(jobDir, "exit.json"), {
      jobId: job.jobId, commandHash: job.commandHash, exit, processIdentity,
      log: await signature(job.logPath), finishedAt: timestamp(), cancellation,
    })
    if (await exists(path.join(jobDir, "cancel.json"))) fail("render_cancelled", "Render cancellation requested")
    if (exit.code !== 0 || exit.signal || exit.error) fail("render_failed", exit.error || "aerender did not exit successfully")
    await checkCheckpoint(job)
    const files = await stageFiles(job)
    const expectedNames = new Set(job.expectedOutputs.names)
    if (files.length !== expectedNames.size ||
        files.some(file => !expectedNames.has(file.name) || file.size === 0)) {
      fail("render_output", "aerender did not produce exactly the expected nonempty outputs")
    }
    await checkDestination(job)
    // The journal precedes publication so a supervisor crash can be rolled back.
    await save(path.join(jobDir, "publication.json"), { jobId: job.jobId, files, at: timestamp() })
    for (const file of files) {
      await fs.link(path.join(job.stageDir, file.name), path.join(job.destinationDir, file.name))
      journal.push(file)
    }
    await verifyFiles(job.destinationDir, files)
    if (await exists(path.join(jobDir, "cancel.json"))) fail("render_cancelled", "Cancelled during publication")
    await save(receiptPath, {
      jobId: job.jobId, commandHash: job.commandHash, state: "completed", exit, processIdentity,
      files, log: await signature(job.logPath), finishedAt: timestamp(), cancellation,
    })
  } catch (error) {
    if (log) { try { await log.sync(); await log.close() } catch {} }
    // A lost supervisor cannot infer child death, and cancellation can leave an AE
    // engine behind. Preserve staging/reservations until that uncertainty is resolved.
    if (launched && !exit) throw error
    let state = error.code === "render_cancelled" ? "cancelled" : "failed"
    let quarantinePath = null
    let files = []
    let uncertainty = null
    try {
      await rollback(job, journal)
      quarantinePath = await quarantine(job)
      for (const name of (await fs.readdir(quarantinePath)).sort()) {
        files.push({ name, ...await signature(path.join(quarantinePath, name)) })
      }
      if ((cancellation?.requested || exit?.signal) && exit?.quiescent !== true) {
        fail("render_unknown", "Partial files quarantined, but descendant shutdown is not certified")
      }
    } catch (quarantineError) {
      state = "unknown"
      uncertainty = quarantineError.message
    }
    await save(receiptPath, {
      jobId: job.jobId, commandHash: job.commandHash, state, exit, processIdentity, files, quarantinePath,
      error: { code: error.code || "render_failed", message: error.message },
      uncertainty, log: await exists(job.logPath) ? await signature(job.logPath) : null,
      finishedAt: timestamp(), cancellation,
    })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === workerPath) {
  runWorker(path.resolve(process.argv[2])).catch(error => {
    process.stderr.write("Render supervisor stopped: " + error.message + "\n")
    process.exitCode = 1
  })
}
