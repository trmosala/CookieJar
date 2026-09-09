import fs from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { AEError, fail, hash, assertString } from "./protocol.mjs"
import { MAX_BYTES, retention } from "./storage-retention.mjs"

const windows = process.platform === "win32"
const exec = promisify(execFile)
const OWNER_FILE = ".cookiemonster-storage-owner.json"
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
// ponytail: a process-wide FIFO avoids alias-dependent ordering; use per-store
// queues only if unrelated checkpoint stores need parallel throughput.
let checkpointQueue = Promise.resolve()
let ownerPromise

function typed(error, code = "storage_unavailable") {
  if (error instanceof AEError) return error
  return new AEError(code, "Filesystem operation failed", { cause: error.code || error.name })
}

function absolute(input) {
  assertString(input, "path", 32767)
  if (/^[\\/]{2}/.test(input)) fail("path_unsupported", "Network and device paths are unsupported")
  if (input.includes("\0") || input.split(/[\\/]/).includes("..")) fail("invalid_path", "Traversal and NUL are forbidden")
  if (!path.isAbsolute(input) || (windows && !/^[a-z]:[\\/]/i.test(input))) fail("invalid_path", "An absolute local path is required")
  if (windows) {
    for (const part of input.slice(3).split(/[\\/]/).filter(Boolean)) {
      if (part === ".") continue
      if (/[\x3c\x3e]/.test(part)) fail("invalid_path", "Windows angle brackets are forbidden")
      if (/[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) ||
          /^(con|prn|aux|nul|conin\$|conout\$|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/i.test(part)) {
        fail("invalid_path", "Windows device names, streams and ambiguous names are forbidden")
      }
    }
  }
  return path.resolve(input)
}

async function optionalStat(file) {
  try { return await fs.lstat(file) } catch (error) {
    if (error.code === "ENOENT") return null
    throw error
  }
}

async function canonical(input, missing = false) {
  const file = absolute(input)
  try {
    const stat = await optionalStat(file)
    if (stat || !missing) return absolute(await fs.realpath(file))
    const parent = await fs.realpath(path.dirname(file))
    if (!(await fs.stat(parent)).isDirectory()) fail("invalid_path", "Parent must be an existing directory")
    return path.join(absolute(parent), path.basename(file))
  } catch (error) { throw typed(error, "path_unavailable") }
}

// Compare real filesystem spelling, not lowercased paths: NTFS can be case-sensitive.
function inside(root, file, recursive = true) {
  return file === root || (recursive && file.startsWith(root.endsWith(path.sep) ? root : root + path.sep))
}

function scope(sessionID, bindingID) {
  assertString(sessionID, "sessionID")
  assertString(bindingID, "bindingID")
  return JSON.stringify([sessionID, bindingID])
}

async function pathKind(file, write) {
  try {
    const stat = await optionalStat(file)
    if (!stat) {
      if (write) return "file"
      fail("path_unavailable", "Path disappeared during permission evaluation")
    }
    if (stat.isFile()) return "file"
    if (stat.isDirectory()) return "directory"
    fail("invalid_path", "Grants require a regular file or directory, not a replaced link or special file")
  } catch (error) { throw typed(error, "path_unavailable") }
}

export function createGrants() {
  const grants = new Map()
  const expiredSessions = new Set()
  const expiredBindings = new Set()
  function active(sessionID, bindingID) {
    const key = scope(sessionID, bindingID)
    if (expiredSessions.has(sessionID) || expiredBindings.has(key)) fail("binding_expired", "The filesystem grant binding has expired")
    return key
  }
  return {
    async grant({ sessionID, bindingID, path: input, recursive = false, write = false }) {
      const key = active(sessionID, bindingID)
      if (typeof recursive !== "boolean" || typeof write !== "boolean") fail("invalid_payload", "Grant flags must be booleans")
      const file = await canonical(input, write)
      const kind = await pathKind(file, write)
      if (recursive && kind !== "directory") fail("invalid_path", "Recursive grants require a directory")
      active(sessionID, bindingID)
      const entry = { path: file, kind, recursive, write }
      grants.set(key, [...(grants.get(key) || []), entry])
      return { ...entry }
    },
    async check({ sessionID, bindingID, path: input, write = false, projectPath }) {
      const key = active(sessionID, bindingID)
      if (typeof write !== "boolean") fail("invalid_payload", "write must be boolean")
      const file = await canonical(input, write)
      const kind = await pathKind(file, write)
      let allowed = (grants.get(key) || []).some(grant => {
        if (write && !grant.write) return false
        if (grant.path === file) return grant.kind === kind
        if (grant.kind !== "directory") return false
        // A folder grant is not a subtree grant unless explicitly recursive.
        return grant.recursive ? inside(grant.path, file) :
          kind === "file" && path.dirname(file) === grant.path
      })
      if (!allowed && !write && projectPath) {
        const project = await canonical(projectPath)
        if (!(await fs.stat(project)).isFile()) fail("invalid_path", "projectPath must be a file")
        allowed = inside(path.dirname(project), file)
      }
      active(sessionID, bindingID)
      if (!allowed) fail("path_denied", "Path is outside the binding's approved filesystem grants")
      return file
    },
    release(sessionID, bindingID) {
      assertString(sessionID, "sessionID")
      if (bindingID !== undefined) {
        const key = scope(sessionID, bindingID)
        expiredBindings.add(key)
        grants.delete(key)
      } else {
        expiredSessions.add(sessionID)
        for (const key of grants.keys()) if (JSON.parse(key)[0] === sessionID) grants.delete(key)
      }
    },
  }
}

async function powershell(script, file) {
  const executable = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  const result = await exec(executable, ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop';" + script], {
    windowsHide: true, timeout: 15000,
    env: { ...process.env, PSModulePath: path.join(path.dirname(executable), "Modules"), CM_STORAGE_PATH: file || "" },
  })
  return result.stdout.trim()
}

async function owner() {
  ownerPromise ||= windows
    ? powershell("[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value")
    : Promise.resolve(String(process.getuid()))
  return ownerPromise
}

async function permissions(file, directory, newlyCreated = false) {
  const stat = await fs.lstat(file)
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) {
    fail("storage_unsafe", "Storage must not be a link or special file")
  }
  if (!windows) {
    if (String(stat.uid) !== await owner()) fail("storage_unsafe", "Storage is not owned by the current user")
    if (newlyCreated) await fs.chmod(file, directory ? 0o700 : 0o600)
    else if (stat.mode & 0o077) fail("storage_unsafe", "Storage is accessible to another user")
    return
  }
  const sid = await owner()
  if (newlyCreated) {
    const icacls = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "icacls.exe")
    await exec(icacls, [file, "/setowner", "*" + sid], { windowsHide: true, timeout: 15000 })
    await exec(icacls, [file, "/inheritance:r", "/grant:r", "*" + sid + (directory ? ":(OI)(CI)F" : ":F")], {
      windowsHide: true, timeout: 15000,
    })
  }
  const acl = JSON.parse(await powershell(
    "$a=Get-Acl -LiteralPath $env:CM_STORAGE_PATH;" +
    "$r=@($a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | ForEach-Object {" +
    "@{sid=$_.IdentityReference.Value;allow=($_.AccessControlType -eq 'Allow');rights=[int64]$_.FileSystemRights;inherit=[int]$_.InheritanceFlags}});" +
    "@{owner=$a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;protected=$a.AreAccessRulesProtected;rules=$r}|ConvertTo-Json -Depth 4 -Compress", file))
  if (acl.owner !== sid || !acl.protected || !acl.rules.length ||
      acl.rules.some(rule => rule.sid !== sid || !rule.allow) ||
      !acl.rules.some(rule => (rule.rights & 2032127) === 2032127 && (!directory || (rule.inherit & 3) === 3))) {
    fail("storage_unsafe", "Storage requires a protected current-user-only Windows ACL and owner")
  }
}

async function regular(file) {
  const stat = await fs.lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail("storage_unsafe", "Expected an unlinked regular storage file")
  return stat
}

async function readJSON(file) {
  const stat = await regular(file)
  if (stat.size > 65536) fail("checkpoint_corrupt", "Metadata is too large")
  return JSON.parse(await fs.readFile(file, "utf8"))
}

// Only a newly created directory or an already marked, private directory is eligible.
// Existing parents are never chmod'ed or ACL'ed.
export async function secureDirectory(input) {
  const file = absolute(input)
  try {
    const parent = await canonical(path.dirname(file))
    if (parent !== path.dirname(file)) fail("storage_unsafe", "Storage parent must already be canonical, without aliases")
    const target = path.join(parent, path.basename(file))
    let created = false
    try { await fs.mkdir(target, { mode: 0o700 }); created = true } catch (error) {
      if (error.code !== "EEXIST") throw error
    }
    if (!created) {
      const stat = await fs.lstat(target)
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail("storage_unsafe", "Storage directory cannot be a link")
      const marker = await readJSON(path.join(target, OWNER_FILE))
      if (marker.format !== 1 || marker.owner !== await owner()) fail("storage_unsafe", "Directory is not integration-owned")
    }
    await permissions(target, true, created)
    if (created) {
      await fs.writeFile(path.join(target, OWNER_FILE), JSON.stringify({ format: 1, owner: await owner() }), { flag: "wx", mode: 0o600 })
    }
    return target
  } catch (error) { throw typed(error, "storage_unsafe") }
}

async function unchangedParent(parent) {
  if (await canonical(parent) !== parent) fail("storage_unsafe", "Storage parent changed")
}

async function atomicWrite(file, data) {
  const parent = path.dirname(file)
  await unchangedParent(parent)
  const existing = await optionalStat(file)
  if (existing) await regular(file)
  const temp = path.join(parent, "." + randomUUID() + ".tmp")
  let handle
  try {
    handle = await fs.open(temp, "wx", 0o600)
    await handle.writeFile(data)
    await handle.sync()
    await handle.close()
    handle = null
    await unchangedParent(parent)
    if (!(await fs.readFile(temp)).equals(Buffer.from(data))) fail("storage_unavailable", "Persisted data failed read-back verification")
    if (await optionalStat(file)) await regular(file)
    await fs.rename(temp, file)
  } finally {
    await handle?.close()
    await unchangedParent(parent)
    await fs.unlink(temp).catch(error => { if (error.code !== "ENOENT") throw error })
  }
}

export async function secureWrite(input, data) {
  try {
    const file = absolute(input)
    if (path.basename(file).toLowerCase() === OWNER_FILE) fail("storage_unsafe", "Ownership marker is reserved")
    const parent = await secureDirectory(path.dirname(file))
    await atomicWrite(path.join(parent, path.basename(file)), data)
    return path.join(parent, path.basename(file))
  } catch (error) { throw typed(error) }
}

function sameStat(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
}

async function digest(handle, output) {
  const result = createHash("sha256")
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  let size = 0
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, size)
    if (!bytesRead) break
    if (size + bytesRead > MAX_BYTES) fail("checkpoint_capacity", "Project exceeds the 5 GB checkpoint cap")
    result.update(buffer.subarray(0, bytesRead))
    if (output) {
      let written = 0
      while (written < bytesRead) {
        const result = await output.write(buffer, written, bytesRead - written, size + written)
        if (!result.bytesWritten) fail("storage_unavailable", "Checkpoint write made no progress")
        written += result.bytesWritten
      }
    }
    size += bytesRead
  }
  return { size, hash: result.digest("hex") }
}

async function verifiedFile(file, output) {
  const before = await regular(file)
  if (before.size > MAX_BYTES) fail("checkpoint_capacity", "Project exceeds the 5 GB checkpoint cap")
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
  try {
    if (!sameStat(before, await handle.stat())) fail("checkpoint_changed", "Source changed before reading")
    const info = await digest(handle, output)
    const again = output ? await digest(handle) : info
    if (info.size !== before.size || info.hash !== again.hash || info.size !== again.size ||
        !sameStat(before, await handle.stat()) || !sameStat(before, await regular(file))) {
      fail("checkpoint_changed", "Source changed while reading")
    }
    return info
  } finally { await handle.close() }
}

async function copyVerified(source, temp, expected) {
  let output
  try {
    output = await fs.open(temp, "wx", 0o600)
    const info = await verifiedFile(source, output)
    await output.sync()
    await output.close()
    output = null
    const copied = await verifiedFile(temp)
    if (copied.hash !== info.hash || copied.size !== info.size ||
        (expected && (info.hash !== expected.hash || info.size !== expected.size))) {
      fail("checkpoint_corrupt", "Checkpoint copy did not verify")
    }
    return info
  } finally { await output?.close() }
}

function manifestData(manifest) {
  return JSON.stringify({ ...manifest, manifestHash: hash(manifest) }, null, 2) + "\n"
}

function validateManifest(record, id, indexRoot) {
  const { manifestHash, ...manifest } = record || {}
  if (!UUID.test(id) || manifest.id !== id || manifestHash !== hash(manifest) ||
      typeof manifest.projectId !== "string" || !manifest.projectId ||
      typeof manifest.planHash !== "string" || !manifest.planHash ||
      !Number.isSafeInteger(manifest.size) || manifest.size < 0 || manifest.size > MAX_BYTES ||
      !/^[0-9a-f]{64}$/.test(manifest.hash) || typeof manifest.pinned !== "boolean" ||
      typeof manifest.verified !== "boolean" || !Number.isFinite(Date.parse(manifest.createdAt)) ||
      (manifest.inUse !== undefined && typeof manifest.inUse !== "boolean") ||
      !["project", "fallback"].includes(manifest.storageMode)) fail("checkpoint_corrupt", "Invalid checkpoint manifest")
  if (manifest.protectionOwners !== undefined &&
      (!Array.isArray(manifest.protectionOwners) || manifest.protectionOwners.length > 100 ||
       manifest.protectionOwners.some(value => typeof value !== "string" || !value.length || value.length > 256) ||
       new Set(manifest.protectionOwners).size !== manifest.protectionOwners.length ||
       manifest.inUse !== (manifest.protectionOwners.length > 0))) {
    fail("checkpoint_corrupt", "Invalid checkpoint protection owners")
  }
  const project = absolute(manifest.projectPath)
  const root = manifest.storageMode === "fallback" ? indexRoot : path.join(path.dirname(project), "CookieMonster Checkpoints")
  const extension = path.extname(project).toLowerCase() === ".aepx" ? ".aepx" : ".aep"
  if (manifest.path !== path.join(root, id + extension) || inside(root, project)) fail("checkpoint_corrupt", "Checkpoint path is outside its owned location")
  return manifest
}

export function createCheckpoints({ dataDir }) {
  const dataPath = absolute(dataDir)
  function run(operation) {
    const next = checkpointQueue.then(async () => {
      try {
        const data = await canonical(dataPath)
        const root = path.join(data, "checkpoints")
        await secureDirectory(root)
        return await operation(root)
      } catch (error) { throw typed(error) }
    })
    // Reserve synchronously, before realpath can let a later pin/delete overtake.
    checkpointQueue = next.catch(() => {})
    return next
  }

  function metadata(manifest) { return path.join(path.dirname(manifest.path), manifest.id + ".json") }

  // Older manifests used inUse only for a recovery copy. Never silently release it.
  function protectionOwners(manifest) {
    return manifest.protectionOwners ?? (manifest.inUse ? ["recovery"] : [])
  }

  async function load(root, id) {
    if (typeof id !== "string" || !UUID.test(id)) fail("invalid_payload", "Invalid checkpoint id")
    const index = path.join(root, id + ".json")
    if (!await optionalStat(index)) fail("checkpoint_not_found", "Checkpoint does not exist")
    try {
      const locator = validateManifest(await readJSON(index), id, root)
      const directory = path.dirname(locator.path)
      if (await secureDirectory(directory) !== directory) fail("checkpoint_corrupt", "Checkpoint directory changed")
      const manifest = validateManifest(await readJSON(metadata(locator)), id, root)
      for (const key of ["path", "projectId", "projectPath", "planHash", "createdAt", "size", "hash", "storageMode"]) {
        if (manifest[key] !== locator[key]) fail("checkpoint_corrupt", "Checkpoint locator disagrees with its manifest")
      }
      return manifest
    } catch (error) {
      throw new AEError("checkpoint_corrupt", "Checkpoint metadata is corrupt or unavailable", { id, cause: error.code || error.name })
    }
  }

  async function scan(root, strict = false) {
    const entries = []
    for (const name of await fs.readdir(root)) {
      if (!UUID.test(name.slice(0, -5)) || !name.endsWith(".json")) continue
      try { entries.push(await load(root, name.slice(0, -5))) } catch (error) {
        if (strict) throw error
        process.emitWarning("Ignored unsafe checkpoint metadata: " + name, { code: "checkpoint_corrupt" })
      }
    }
    return entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  }

  async function verifyManifest(manifest) {
    const info = await verifiedFile(manifest.path)
    if (info.size !== manifest.size || info.hash !== manifest.hash) fail("checkpoint_corrupt", "Checkpoint bytes do not match the manifest", { id: manifest.id })
    return { ...manifest, verified: true }
  }

  async function discard(root, manifest) {
    if (manifest.pinned || manifest.inUse) fail("checkpoint_in_use", "Pinned or in-use checkpoints cannot be deleted")
    await secureDirectory(path.dirname(manifest.path))
    await regular(manifest.path)
    await fs.unlink(manifest.path)
    await fs.unlink(metadata(manifest))
    if (path.dirname(manifest.path) !== root) await fs.unlink(path.join(root, manifest.id + ".json"))
  }

  return {
    create({ projectPath, projectId, planHash, pinned = false }) {
      return run(async root => {
        assertString(projectId, "projectId")
        assertString(planHash, "planHash")
        if (typeof pinned !== "boolean") fail("invalid_payload", "pinned must be boolean")
        const project = await canonical(projectPath)
        if (inside(root, project) || path.basename(path.dirname(project)) === "CookieMonster Checkpoints") fail("invalid_path", "A checkpoint cannot be used as a canonical source project")
        const source = await regular(project)
        if (source.size > MAX_BYTES) fail("checkpoint_capacity", "Project exceeds the 5 GB checkpoint cap")
        const entries = (await scan(root, true)).filter(entry => entry.projectId === projectId)
        for (const entry of entries) {
          if ((await regular(entry.path)).size !== entry.size) fail("checkpoint_corrupt", "Retention cannot use corrupt checkpoint sizes")
        }
        const victims = retention(entries, { size: source.size, pinned })
        let directory
        let storageMode = "project"
        let warning
        try { directory = await secureDirectory(path.join(path.dirname(project), "CookieMonster Checkpoints")) } catch {
          directory = root
          storageMode = "fallback"
          warning = "Project-side checkpoint storage is unavailable. This recovery copy will not travel with the project."
        }
        const id = randomUUID()
        const extension = path.extname(project).toLowerCase() === ".aepx" ? ".aepx" : ".aep"
        for (;;) {
          const file = path.join(directory, id + extension)
          const temp = path.join(directory, "." + id + ".tmp")
          let manifest
          let published = false
          let committed = false
          let retry = false
          try {
            const info = await copyVerified(project, temp)
            if (!sameStat(source, await regular(project))) fail("checkpoint_changed", "Project changed during checkpoint creation")
            manifest = { id, path: file, projectId, projectPath: project, planHash, createdAt: new Date().toISOString(),
              size: info.size, hash: info.hash, verified: true, pinned, storageMode }
            if (warning) manifest.warning = warning
            await unchangedParent(directory)
            await fs.rename(temp, file)
            published = true
            await atomicWrite(metadata(manifest), manifestData(manifest))
            if (directory !== root) await atomicWrite(path.join(root, id + ".json"), manifestData(manifest))
            committed = true
            for (const victim of victims) await discard(root, victim)
            if (warning) process.emitWarning(warning, { code: "checkpoint_fallback" })
            return manifest
          } catch (error) {
            if (committed) throw new AEError("checkpoint_retention_failed", "Checkpoint saved, but retention failed", { id, cause: error.code })
            if (storageMode === "fallback" || error instanceof AEError) throw error
            retry = true
          } finally {
            await unchangedParent(directory)
            await fs.unlink(temp).catch(error => { if (error.code !== "ENOENT") throw error })
            if (!committed && published) {
              await fs.unlink(file).catch(error => { if (error.code !== "ENOENT") throw error })
              await fs.unlink(metadata(manifest)).catch(error => { if (error.code !== "ENOENT") throw error })
            }
          }
          if (retry) {
            directory = root
            storageMode = "fallback"
            warning = "Project-side checkpoint storage is unavailable. This recovery copy will not travel with the project."
          }
        }
      })
    },
    list(projectId) {
      return run(async root => {
        assertString(projectId, "projectId")
        return (await scan(root)).filter(entry => entry.projectId === projectId)
      })
    },
    pin(id, pinned) {
      return run(async root => {
        if (typeof pinned !== "boolean") fail("invalid_payload", "pinned must be boolean")
        const manifest = await load(root, id)
        if (!pinned && manifest.inUse) fail("checkpoint_in_use", "Recovery copy is in use")
        const updated = { ...manifest, pinned }
        const entries = (await scan(root, true)).filter(entry => entry.projectId === manifest.projectId && entry.id !== id)
        const victims = retention(entries, updated)
        await atomicWrite(metadata(updated), manifestData(updated))
        for (const victim of victims) await discard(root, victim)
        return updated
      })
    },
    // Use a stable job ID; acquire/release retries are idempotent across instances.
    // Release only once the owner is confirmed stopped, not merely disconnected.
    // This never changes the user's pin. A release returns null if retention prunes it.
    protect(id, ownerID, active = true) {
      return run(async root => {
        assertString(ownerID, "protection owner", 256)
        if (typeof active !== "boolean") fail("invalid_payload", "active must be boolean")
        let manifest
        try { manifest = await load(root, id) } catch (error) {
          if (!active && error.code === "checkpoint_not_found") return null
          throw error
        }
        if (active) manifest = await verifyManifest(manifest)
        const owners = new Set(protectionOwners(manifest))
        if (active) owners.add(ownerID)
        else owners.delete(ownerID)
        if (owners.size > 100) fail("checkpoint_capacity", "Too many checkpoint protection owners")
        const updated = { ...manifest, inUse: owners.size > 0, protectionOwners: [...owners] }
        const entries = (await scan(root, true)).filter(entry => entry.projectId === manifest.projectId)
        const victims = retention(entries.map(entry => entry.id === id ? updated : entry))
        await atomicWrite(metadata(updated), manifestData(updated))
        for (const victim of victims) await discard(root, victim)
        return victims.some(entry => entry.id === id) ? null : updated
      })
    },
    remove(id) {
      return run(async root => { await discard(root, await load(root, id)) })
    },
    verify(id) {
      return run(async root => verifyManifest(await load(root, id)))
    },
    restore(id, { canonicalPath }) {
      return run(async root => {
        const manifest = await verifyManifest(await load(root, id))
        // Persist protection before handing a recovery path to a host that may outlive this process.
        // The workflow releases "recovery" only after AE has closed that copy.
        const held = { ...manifest, inUse: true,
          protectionOwners: [...new Set([...protectionOwners(manifest), "recovery"])] }
        if (held.protectionOwners.length > 100) fail("checkpoint_capacity", "Too many checkpoint protection owners")
        await atomicWrite(metadata(held), manifestData(held))
        let temp
        let parent
        let restored = false
        try {
          const destination = absolute(canonicalPath)
          if (destination !== manifest.projectPath || await canonical(destination, true) !== destination) fail("path_denied", "Restore destination must be the original canonical project")
          const before = await optionalStat(destination)
          if (before) await regular(destination)
          parent = path.dirname(destination)
          const parentStat = await fs.stat(parent)
          temp = path.join(parent, ".cookiemonster-restore-" + randomUUID() + ".tmp")
          await copyVerified(manifest.path, temp, manifest)
          await unchangedParent(parent)
          const afterParent = await fs.stat(parent)
          const after = await optionalStat(destination)
          if (parentStat.dev !== afterParent.dev || parentStat.ino !== afterParent.ino ||
              (before ? !after || !sameStat(before, after) : after)) fail("checkpoint_changed", "Restore destination changed")
          await fs.rename(temp, destination)
          restored = true
        } catch {
          await verifyManifest(manifest)
          return { path: manifest.path, recoveryCopy: true, automationSuspended: true }
        } finally {
          try {
            if (temp) {
              await unchangedParent(parent)
              await fs.unlink(temp).catch(error => { if (error.code !== "ENOENT") throw error })
            }
            if (restored) await atomicWrite(metadata(manifest), manifestData(manifest))
          } catch {
            // Never report a failed restore after the atomic replacement committed.
            process.emitWarning("Restore cleanup failed; the checkpoint remains protected. Inspect storage before resuming automation.", { code: "checkpoint_cleanup_failed" })
          }
        }
        return { path: manifest.projectPath, recoveryCopy: false }
      })
    },
  }
}
