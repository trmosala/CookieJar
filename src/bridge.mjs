import http from "node:http"
import os from "node:os"
import path from "node:path"
import { randomBytes, randomUUID, createHash } from "node:crypto"
import net from "node:net"
import { lstat, readFile, open, rename, unlink } from "node:fs/promises"
import { setTimeout as delay } from "node:timers/promises"
import { secureDirectory } from "./storage.mjs"
import { AEError, fail, canonical, assertObject, assertString, PROTOCOL, VERSION, UPDATE_URL,
  validVersion, validProtocol, releaseMetadata } from "./protocol.mjs"

const MAX_BYTES = 4 * 1024 * 1024
const digest = value => createHash("sha256").update(value).digest("hex")
const clone = value => JSON.parse(canonical(value))
const writes = new Set(["save", "execute", "open", "raw", "capture"])
const CAPTURE_BYTES = 7 * 1024 * 1024
const panelActions = {
  checkpoints: [], "checkpoint.pin": ["id", "pinned"], "checkpoint.delete": ["id"],
  "checkpoint.restore.propose": ["id"], "checkpoint.restore.confirm": ["token"],
  renders: [], diagnostics: [], "frame.capture": ["compId", "time"],
  "render.start": ["tool", "args"], "render.poll": ["token"], "render.reply": ["token", "approvalID", "allow"],
}

function schema(value, required, optional = []) {
  assertObject(value)
  if (required.some(key => !Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => !required.includes(key) && !optional.includes(key)))
    fail("invalid_payload", "Unexpected or missing fields")
  return value
}

function project(value) {
  schema(value, ["id", "path", "saved"])
  if (!(typeof value.id === "string" && value.id.length && value.id.length <= 32768) &&
      !(Number.isSafeInteger(value.id) && value.id >= 0)) fail("invalid_payload", "Invalid project identity")
  if (typeof value.saved !== "boolean" ||
      !(value.path === null || typeof value.path === "string" && value.path.length <= 32768) ||
      value.saved && (!value.path || !path.isAbsolute(value.path)))
    fail("invalid_payload", "Invalid project path or saved state")
  return clone(value)
}

function capabilities(value) {
  schema(value, ["fileNetwork"])
  if (typeof value.fileNetwork !== "boolean") fail("invalid_payload", "Invalid file/network capability")
  return clone(value)
}

function activeComp(value = null) {
  if (value !== null && (!Number.isSafeInteger(value) || value <= 0))
    fail("invalid_payload", "Invalid active composition ID")
  return value
}

export const RESTORE_PROOF = "compact-restore-v2"

export function restoreReceipt(value, expectedProject) {
  if (value?.protocol !== RESTORE_PROOF)
    fail("restore_unsupported", "A matching compact restore host is required; scene snapshots are not restore proofs")
  schema(value, ["protocol", "project", "projectEpoch", "revision", "dirty", "busy", "callbacksClear", "capabilities"])
  const identity = project(value.project)
  if (!identity.saved || !sameProject(identity, expectedProject) ||
      typeof value.projectEpoch !== "string" || !value.projectEpoch.length || value.projectEpoch.length > 256 ||
      value.projectEpoch.includes("\u0000") || !Number.isSafeInteger(value.revision) || value.revision < 1 ||
      typeof value.dirty !== "boolean" || value.busy !== false || value.callbacksClear !== true)
    fail("invalid_host_result", "Invalid compact restore identity, epoch, revision, dirty or idle guards")
  capabilities(value.capabilities)
  if (!value.capabilities.fileNetwork) fail("capability_missing", "Restore requires file access")
  return value
}

export function restoreFingerprint(value, connectionId) {
  return digest(canonical({ kind: RESTORE_PROOF, connectionId, receipt: value }))
}

function sameProject(a, b) {
  return a?.id === b?.id && a?.path === b?.path && a?.saved === b?.saved
}

export async function createBridge(options = {}) {
  const dataDir = await secureDirectory(options.dataDir || process.env.CM_AE_DATA_DIR || path.join(os.homedir(), ".cookiemonster-ae"))
  const owner = net.createServer(socket => socket.destroy())
  const key = digest(process.platform === "win32" ? dataDir.toLowerCase() : dataDir)
  // OS-held ownership disappears on crashes; no stale PID file can race a new owner.
  // ponytail: non-Windows port collisions fail closed rather than risking two writers.
  const address = process.platform === "win32" ? String.raw`\\.\pipe\cookiemonster-ae-${key}`
    : { host: "127.0.0.1", port: 49152 + parseInt(key.slice(0, 4), 16) % 16384, exclusive: true }
  try {
    await new Promise((resolve, reject) => {
      owner.once("error", reject)
      owner.listen(address, resolve)
    })
  } catch (error) {
    throw new AEError("bridge_in_use", "Bridge ownership endpoint is already held or unavailable", { cause: error.code })
  }
  try {
    const bridge = await startBridge({ ...options, dataDir })
    const close = bridge.close
    bridge.close = async () => {
      try { await close() } finally {
        if (owner.listening) await new Promise(resolve => owner.close(resolve))
      }
    }
    return bridge
  } catch (error) {
    await new Promise(resolve => owner.close(resolve))
    throw error
  }
}

async function startBridge({
  dataDir = process.env.CM_AE_DATA_DIR || path.join(os.homedir(), ".cookiemonster-ae"),
  timeoutMs = 30000,
  heartbeatMs = 15000,
  pairingTtlMs = 120000,
  now = Date.now,
  releaseMetadata: suppliedReleases,
} = {}) {
  const releases = releaseMetadata(suppliedReleases)
  function compatibility(peer = null) {
    return clone({
      status: !peer ? "unknown" : peer.panelProtocol === PROTOCOL && peer.panelVersion === VERSION ? "compatible" : "incompatible",
      pluginVersion: VERSION, protocol: PROTOCOL,
      panelVersion: peer?.panelVersion ?? null, panelProtocol: peer?.panelProtocol ?? null,
      ...releases,
    })
  }
  for (const value of [timeoutMs, heartbeatMs, pairingTtlMs])
    if (!Number.isFinite(value) || value <= 0) fail("invalid_payload", "Timeouts must be positive")
  dataDir = path.resolve(dataDir)
  const statePath = path.join(dataDir, "bridge-state.json")
  const descriptorPath = path.join(dataDir, "descriptor.json")
  const instanceId = randomUUID()
  const automaticCode = randomBytes(32).toString("base64url")
  const automaticCredentials = new Map()
  let state = { credentials: [], locks: [] }
  try {
    const stat = await lstat(statePath)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_BYTES)
      fail("unsafe_storage", "Bridge state must be a bounded regular unlinked file")
    state = JSON.parse(await readFile(statePath, "utf8"))
    schema(state, ["credentials", "locks"])
    if (!Array.isArray(state.credentials) || !Array.isArray(state.locks)) throw new Error("Invalid state")
    for (const c of state.credentials) {
      schema(c, ["panelId", "connectionId", "hash"])
      assertString(c.panelId, "panelId", 256)
      assertString(c.connectionId, "connectionId", 256)
      if (c.hash !== null && !/^[a-f0-9]{64}$/.test(c.hash)) throw new Error("Invalid credential digest")
    }
    for (const lock of state.locks) {
      assertString(lock.id, "lock id", 256)
      assertString(lock.connectionId, "connectionId", 256)
      project(lock.project)
      if (lock.recoveryOriginal) project(lock.recoveryOriginal)
      if (lock.restore) {
        schema(lock.restore, ["id", "phase", "emergencyPath"], ["openPath"])
        assertString(lock.restore.id, "restore id", 256)
        if (!["preparing", "saved", "finishing", "finished"].includes(lock.restore.phase))
          fail("unsafe_storage", "Invalid persisted restore phase")
        for (const field of ["emergencyPath", "openPath"]) {
          const file = lock.restore[field]
          if (file !== undefined && (typeof file !== "string" || !path.isAbsolute(file) || path.resolve(file) !== file))
            fail("unsafe_storage", "Invalid persisted restore path")
        }
      }
      delete lock.sessionID
      lock.state = "uncertain"
      lock.recoveryReason = "Bridge restarted; reconcile before writing"
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
  let diskError = null
  let saving = Promise.resolve()
  async function atomic(file, value) {
    const temporary = file + "." + randomUUID() + ".tmp"
    let handle
    try {
      handle = await open(temporary, "wx", 0o600)
      await handle.writeFile(JSON.stringify(value))
      await handle.sync()
      await handle.close()
      handle = null
      for (let attempt = 0; ; attempt++) {
        try { await rename(temporary, file); break } catch (error) {
          // Match the render journal's bounded Windows replacement retry. Keep
          // the original destination intact; exhausted writes still fail closed.
          if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt === 9) throw error
          await delay(20 * (attempt + 1))
        }
      }
    } finally {
      await handle?.close()
      await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error })
    }
  }
  function persist() {
    const snapshot = clone(state)
    const next = saving.then(() => atomic(statePath, snapshot))
    saving = next.catch(error => { diskError = error })
    return next
  }
  await persist()
  const live = new Map()
  const bindings = new Map()
  const projectChangedBindings = new Set()
  const pairing = new Map()
  const releaseListeners = new Set()
  let attempts = []
  let closed = false
  let bindingChange = false
  let panelHandler = null
  let chatHandler = null
  let closing = null

  function healthy() {
    if (closed) fail("disconnected", "Bridge is closed")
    if (diskError) fail("storage_failed", "Bridge persistence failed; writes are disabled")
  }
  function targetLock(connectionId, p) {
    return state.locks.find(lock => lock.connectionId === connectionId ||
      p?.path && (lock.project.path === p.path || lock.recoveryOriginal?.path === p.path ||
        lock.restore?.emergencyPath === p.path || lock.restore?.openPath === p.path))
  }
  function view(binding) {
    return clone({ ...binding, lock: targetLock(binding.connectionId, binding.project) || null })
  }
  async function notify(binding) {
    for (const callback of releaseListeners) await callback(binding.sessionID, binding.id)
  }
  async function uncertain(connection, reason) {
    const binding = [...bindings.values()].find(b => b.connectionId === connection.id)
    const existing = targetLock(connection.id, binding?.project || connection.project)
    if (existing) {
      existing.state = "uncertain"
      existing.recoveryReason = reason
    } else if (binding || connection.project) {
      state.locks.push({
        id: randomUUID(), connectionId: connection.id, sessionID: binding?.sessionID || null,
        project: clone(binding?.project || connection.project), state: "uncertain", reason, createdAt: now(),
      })
    }
    await persist()
  }
  async function suspend(connection, reason) {
    connection.connected = false
    connection.activeCompId = null
    const pending = connection.pending
    if (pending) {
      connection.pending = null
      clearTimeout(pending.timer)
      try {
        await uncertain(connection, reason)
      } finally {
        pending.reject(new AEError("outcome_uncertain", reason))
      }
    }
    for (const binding of bindings.values()) {
      if (binding.connectionId !== connection.id) continue
      binding.state = "suspended"
      await notify(binding)
    }
  }
  async function expire() {
    for (const connection of live.values())
      if (connection.connected && now() - connection.seen > heartbeatMs)
        await suspend(connection, "Heartbeat expired; command outcome may be uncertain")
    for (const [code, entry] of pairing) if (entry.expiresAt <= now()) pairing.delete(code)
  }
  function binding(sessionID, { write = false, allowLocked = false, allowSuspended = false } = {}) {
    healthy()
    const b = bindings.get(sessionID)
    if (!b) fail("not_bound", "Bind this session to an AE connection first")
    const c = live.get(b.connectionId)
    if (b.state !== "active" || !c?.connected || now() - c.seen > heartbeatMs || !sameProject(b.project, c.project)) {
      // Metadata for release only; host calls never opt out of suspension.
      if (allowSuspended && !write) return view({ ...b, state: "suspended" })
      fail("binding_suspended", "Connection or project changed; explicitly rebind")
    }
    const lock = targetLock(c.id, c.project)
    if (lock && !allowLocked) fail("target_locked", "Target is locked pending reconciliation", { lock: clone(lock) })
    if (write && (!c.project.saved || !c.project.path)) fail("unsaved_project", "Save the project before writing")
    if (write && !c.capabilities.fileNetwork) fail("capability_missing", "Enable AE Allow Scripts to Write Files and Access Network explicitly")
    if (write && c.busy) fail("host_busy", "After Effects is busy")
    return view(b)
  }
  const bridge = {
    dataDir, canonicalRestore: true, compactRestore: RESTORE_PROOF,
    compatibility(sessionID) {
      return { ...compatibility(), pendingPanels: [...pairing.values()]
        .filter(entry => entry.sessionID === sessionID && entry.expiresAt > now() && entry.peer)
        .map(entry => compatibility(entry.peer)) }
    },
    pairingCode(sessionID) {
      healthy()
      assertString(sessionID, "sessionID", 256)
      for (const [code, p] of pairing) if (p.sessionID === sessionID || p.expiresAt <= now()) pairing.delete(code)
      if (pairing.size >= 100) fail("rate_limited", "Too many outstanding pairing codes")
      const code = randomBytes(6).toString("hex").toUpperCase()
      const expiresAt = now() + pairingTtlMs
      pairing.set(digest(code), { sessionID, expiresAt })
      return { code, expiresAt, protocol: PROTOCOL, version: VERSION, updateUrl: UPDATE_URL, compatibility: compatibility() }
    },
    async connections() {
      await expire()
      return [...live.values()].map(c => ({
        id: c.id, connectionId: c.id, epoch: c.epoch, panelId: c.panelId, aeVersion: c.aeVersion,
        compatibility: compatibility(c.peer),
        project: clone(c.project), capabilities: clone(c.capabilities), activeCompId: c.activeCompId ?? null,
        connected: c.connected, busy: c.busy, binding: [...bindings.values()].filter(b => b.connectionId === c.id).map(view)[0] || null,
        lock: clone(targetLock(c.id, c.project) || null),
      }))
    },
    async ensureBound(sessionID) {
      await expire()
      const existing = bindings.get(sessionID)
      if (existing) {
        const c = live.get(existing.connectionId)
        if (projectChangedBindings.has(existing.id)) fail("binding_suspended", "Project changed; explicitly select the project again with ae_bind")
        // Resume only the same project, never redirect a conversation after a project switch.
        if (c?.connected && sameProject(existing.project, c.project) && !c.busy && !c.pending &&
            !targetLock(c.id, c.project)) existing.state = "active"
        return binding(sessionID)
      }
      const available = (await bridge.connections()).filter(c => c.connected)
      if (!available.length) fail("disconnected", "Open the CookieMonster panel in After Effects; it connects automatically")
      if (available.length !== 1) fail("target_ambiguous", "Multiple AE instances are connected; select one with ae_connections and ae_bind")
      const c = available[0]
      if (c.binding) fail("binding_owned", "Another conversation owns this AE instance; explicitly take control with ae_bind")
      if (c.lock || c.busy) fail("target_locked", "Inspect and reconcile the AE target before continuing")
      return bridge.bind(sessionID, c.id, { expectedProject: c.project, expectedOwner: null, expectedConnection: c.epoch })
    },
    async bind(sessionID, connectionId, { takeover = false, expectedProject, expectedOwner, expectedConnection } = {}) {
      healthy()
      assertString(sessionID, "sessionID", 256)
      assertString(connectionId, "connectionId", 256)
      const c = live.get(connectionId)
      if (!c?.connected) fail("disconnected", "AE connection is not connected")
      const reviewed = expectedProject === undefined ? clone(c.project) : project(expectedProject)
      const owner = [...bindings.values()].find(b => b.connectionId === connectionId)
      const reviewedOwner = expectedOwner === undefined ? owner?.id || null : expectedOwner
      let expectedActive = owner
      if (expectedConnection !== undefined && expectedConnection !== c.epoch)
        fail("stale_binding", "Connection changed since review")
      const recheck = () => {
        healthy()
        if (live.get(connectionId) !== c || !c.connected || c.pending ||
            now() - c.seen > heartbeatMs || canonical(c.project) !== canonical(reviewed))
          fail("stale_binding", "Connection or reviewed project changed during binding")
        const active = [...bindings.values()].find(b => b.connectionId === connectionId)
        if (active !== expectedActive || active && active.id !== reviewedOwner)
          fail("stale_binding", "Reviewed target owner changed")
      }
      if ((owner?.id || null) !== reviewedOwner) fail("stale_binding", "Target owner changed since review")
      if (bindingChange) fail("binding_busy", "Another binding transition is in progress")
      bindingChange = true
      try {
      await expire()
      recheck()
      const old = owner?.sessionID !== sessionID ? owner : null
      if (old && !takeover) fail("binding_owned", "Another session owns this target; confirm takeover")
      if (old) { expectedActive = undefined; await bridge.release(old.sessionID); recheck() }
      if (bindings.has(sessionID)) {
        if (owner?.sessionID === sessionID) expectedActive = undefined
        await bridge.release(sessionID); recheck()
      }
      recheck()
      const b = { id: randomUUID(), sessionID, connectionId, project: clone(reviewed), state: "active" }
      bindings.set(sessionID, b)
      return view(b)
      } finally { bindingChange = false }
    },
    async release(sessionID) {
      const b = bindings.get(sessionID)
      for (const [code, p] of pairing) if (p.sessionID === sessionID) pairing.delete(code)
      if (!b) return { released: false }
      b.state = "suspended"
      const c = live.get(b.connectionId)
      if (c?.pending) await suspend(c, "Session released during a host call")
      else if (c && targetLock(c.id, b.project)?.state === "executing")
        await uncertain(c, "Session released during a transaction")
      bindings.delete(sessionID)
      if (b) projectChangedBindings.delete(b.id)
      for (const lock of state.locks) if (lock.sessionID === sessionID) delete lock.sessionID
      await persist()
      await notify(b)
      return { released: true }
    },
    binding,
    async lock(sessionID, reason) {
      const b = binding(sessionID, { write: true })
      const lock = { id: randomUUID(), connectionId: b.connectionId, sessionID, project: b.project,
        state: "executing", reason: clone(reason), createdAt: now() }
      state.locks.push(lock)
      await persist()
      return clone(lock)
    },
    async unlock(sessionID, { restoreReview, authorizeRestoreReview } = {}) {
      const b = binding(sessionID, { allowLocked: true })
      const c = live.get(b.connectionId)
      if (c.pending || c.busy) fail("host_busy", "Cannot unlock while AE is busy")
      const lock = targetLock(b.connectionId, b.project)
      if (!lock) return
      if (lock.connectionId !== b.connectionId || !sameProject(lock.recoveryOriginal || lock.project, b.project))
        fail("recovery_target_mismatch", "Rebind the original connection and project before clearing its lock")
      if (lock.restore && lock.state === "executing" &&
          (lock.restore.phase !== "finished" || lock.evidence?.outcome !== "confirmed"))
        fail("restore_in_progress", "Manual restore is not confirmed; retain its lock")
      if (lock.reason?.kind === "restore" && lock.reason.proof === RESTORE_PROOF) {
        const reviewedLock = canonical(lock)
        const expected = lock.state === "executing" ? lock.evidence?.expectedFingerprint : restoreReview
        if (!expected || lock.state !== "executing" && restoreReview !== c.restoreObserved)
          fail("permission_required", "Compact restore uncertainty requires explicit actual-project review")
        const reviewed = lock.state !== "executing" || restoreReview !== undefined
        if (reviewed && typeof authorizeRestoreReview !== "function")
          fail("permission_required", "Compact restore review requires final synchronous authorization")
        const receipt = await bridge.call(sessionID, "inspect", { restore: RESTORE_PROOF }, { allowLocked: true })
        const latest = binding(sessionID, { allowLocked: true })
        if (latest.id !== b.id || live.get(b.connectionId) !== c || !sameProject(latest.project, b.project) ||
            canonical(lock) !== reviewedLock || targetLock(c.id, b.project) !== lock ||
            restoreFingerprint(receipt, c.id) !== expected)
          fail("stale_fingerprint", "Compact restore state or recovery lock changed before unlock")
        // Use the review owner's deadline/clock after the last await, before removing the lock.
        if (reviewed && authorizeRestoreReview() !== true)
          fail("permission_required", "Compact restore review authorization was not confirmed synchronously")
      }
      c.restore = null
      state.locks = state.locks.filter(value => value !== lock)
      await persist()
    },
    async markUncertain(sessionID, reason) {
      const b = binding(sessionID, { allowLocked: true })
      await uncertain(live.get(b.connectionId), reason)
    },
    // Functional recovery evidence only: no source, actions, or ordinary session history.
    async recordOutcome(sessionID, evidence) {
      schema(evidence, ["outcome"], ["planHash", "checkpointId", "currentCheckpointId", "expectedFingerprint"])
      if (!["prepared", "dispatched", "confirmed", "recovery_copy"].includes(evidence.outcome))
        fail("invalid_payload", "Invalid outcome evidence")
      for (const key of ["planHash", "expectedFingerprint"])
        if (evidence[key] !== undefined && !/^[a-f0-9]{64}$/.test(evidence[key])) fail("invalid_payload", "Invalid evidence hash")
      for (const key of ["checkpointId", "currentCheckpointId"])
        if (evidence[key] !== undefined) assertString(evidence[key], key, 256)
      const b = binding(sessionID, { allowLocked: true })
      const lock = targetLock(b.connectionId, b.project)
      if (!lock || lock.state !== "executing" || lock.sessionID !== sessionID ||
          lock.connectionId !== b.connectionId || !sameProject(lock.project, b.project) ||
          live.get(b.connectionId)?.pending)
        fail("lock_required", "Only the idle executing owner may record outcome evidence")
      if (lock.reason?.proof === RESTORE_PROOF && ["confirmed", "recovery_copy"].includes(evidence.outcome)) {
        const c = live.get(b.connectionId)
        if (lock.restore?.phase !== "finished" || !c.restore?.finishedFingerprint ||
            evidence.expectedFingerprint !== c.restore.finishedFingerprint ||
            evidence.expectedFingerprint !== c.restoreObserved)
          fail("unsafe_state", "Compact restore outcome requires a matching opened receipt and fresh read")
      }
      lock.evidence = clone(evidence)
      await persist()
    },
    // Single runtime hook. Adapter owns checkpoint authorization and confirmation tokens.
    setPanelHandler(callback) {
      healthy()
      if (typeof callback !== "function") fail("invalid_payload", "Panel handler must be a function")
      if (panelHandler) fail("handler_registered", "Panel handler is already registered")
      panelHandler = callback
    },
    setChatHandler(callback) { chatHandler = callback },
    onRelease(callback) {
      releaseListeners.add(callback)
      return () => releaseListeners.delete(callback)
    },
    async call(sessionID, method, params = {}, { timeoutMs: wait = timeoutMs, allowLocked = false } = {}) {
      healthy()
      if (!["inspect", "preflight", "save", "execute", "open", "raw", "capture", "templates"].includes(method))
        fail("invalid_method", "Unknown AE method")
      assertObject(params)
      const payload = clone(params)
      if (Buffer.byteLength(canonical(payload)) > MAX_BYTES) fail("payload_too_large", "Command exceeds transport limit")
      if (!Number.isFinite(wait) || wait <= 0 || wait > 300000) fail("invalid_payload", "Invalid command timeout")
      if (writes.has(method)) await saving
      const b = binding(sessionID, { write: writes.has(method), allowLocked })
      const c = live.get(b.connectionId)
      if (c.pending) fail("host_busy", "Only one host command may be in flight")
      const lock = targetLock(c.id, b.project)
      if (writes.has(method) && (!lock || lock.state !== "executing" || lock.sessionID !== sessionID ||
          lock.connectionId !== b.connectionId || !sameProject(lock.project, b.project)))
        fail("lock_required", "Acquire this session's durable executing lock before changing AE state")
      const manual = method === "execute" && ["restore_prepare", "restore_finish"].includes(payload.phase)
      if (method === "inspect" && Object.hasOwn(payload, "restore")) {
        schema(payload, ["restore"])
        if (payload.restore !== RESTORE_PROOF) fail("restore_unsupported", "Unsupported compact restore protocol")
        c.restoreObserved = null
      }
      if (lock?.restore && method !== "inspect" && !manual)
        fail("restore_in_progress", "Only inspection and the authorized manual restore may run")
      if (method === "execute" && payload.phase) {
        const fields = {
          begin: ["actions"], chunk: ["offset", "count", "expected"],
          recovery_prepare: ["recoveryId", "expected", "path"],
          recovery_finish: ["recoveryId", "expected", "verifiedCheckpoint"],
          restore_prepare: ["recoveryId", "expected", "path"],
          restore_finish: ["recoveryId", "expected", "path", "verifiedCheckpoint"],
        }
        if (!Object.hasOwn(fields, payload.phase)) fail("invalid_payload", "Unknown execution phase")
        schema(payload, ["phase", "transaction", ...fields[payload.phase]])
        if (payload.phase === "chunk" && (!Number.isSafeInteger(payload.offset) || payload.offset < 0 ||
            !Number.isSafeInteger(payload.count) || payload.count < 1 || payload.count > 64))
          fail("invalid_payload", "Invalid execution chunk bounds")
        schema(payload.transaction, ["id", "sessionID", "bindingID"])
        assertString(payload.transaction.id, "transaction id", 256)
        if (payload.transaction.sessionID !== sessionID || payload.transaction.bindingID !== b.id)
          fail("stale_binding", "Transaction belongs to another session or binding")
        if (payload.phase === "recovery_prepare") {
          if (!c.stopped || c.stopped.id !== payload.recoveryId || canonical(c.stopped.snapshot) !== canonical(payload.expected))
            fail("unsafe_state", "No matching acknowledged stopped outcome")
          if (!path.isAbsolute(payload.path) || path.dirname(payload.path) !== dataDir ||
              !/^workflow-emergency-[a-f0-9-]+[.]aepx?$/.test(path.basename(payload.path)))
            fail("invalid_path", "Emergency recovery must use a new private project path")
        }
        if (payload.phase === "recovery_finish" &&
            (!c.stopped || c.stopped.id !== payload.recoveryId || !c.stopped.original))
          fail("unsafe_state", "No prepared recovery transition")
        if (manual) {
          assertString(payload.recoveryId, "restore id", 256)
          restoreReceipt(payload.expected, b.project)
          assertString(payload.path, "restore path", 32768)
          const privatePath = prefix => path.isAbsolute(payload.path) && path.resolve(payload.path) === payload.path &&
            path.dirname(payload.path) === dataDir &&
            new RegExp("^workflow-" + prefix + "-[a-f0-9-]+[.]aepx?$").test(path.basename(payload.path))
          if (payload.phase === "restore_prepare") {
            if (c.stopped || c.restore || lock.restore || lock.recoveryOriginal || lock.reason?.kind !== "restore" ||
                lock.reason.proof !== RESTORE_PROOF)
              fail("unsafe_state", "Manual restore requires a fresh restore lock without stopped or uncertain execution")
            assertString(lock.reason.checkpointId, "checkpoint id", 256)
            if (!/^[a-f0-9]{64}$/.test(lock.reason.planHash) ||
                restoreFingerprint(payload.expected, c.id) !== lock.reason.fingerprint)
              fail("unsafe_state", "Restore snapshot does not match the approved lock")
            if (!privatePath("emergency")) fail("invalid_path", "Restore save must use a private emergency project")
          } else {
            const rec = c.restore
            if (!rec || rec.phase !== "saved" || lock.restore?.phase !== "saved" ||
                rec.id !== payload.recoveryId || rec.owner !== canonical(payload.transaction) ||
                rec.snapshot !== canonical(payload.expected))
              fail("unsafe_state", "No matching single-use manual restore preparation")
            schema(payload.verifiedCheckpoint, ["id", "hash", "size"])
            const proof = payload.verifiedCheckpoint, evidence = lock.evidence
            assertString(proof.id, "current checkpoint", 256)
            if (!/^[a-f0-9]{64}$/.test(proof.hash) || !Number.isSafeInteger(proof.size) ||
                proof.size < 1 || proof.size > 5 * 1024 ** 3)
              fail("invalid_payload", "Invalid verified current-state checkpoint")
            if (evidence?.outcome !== "dispatched" || evidence.currentCheckpointId !== proof.id ||
                evidence.checkpointId !== lock.reason.checkpointId || evidence.planHash !== lock.reason.planHash)
              fail("unsafe_state", "Restore finish requires matching durable current-backup evidence")
            if (payload.path !== rec.original.path && !privatePath("recovery"))
              fail("invalid_path", "Restore may open only the original path or a private recovery copy")
          }
        }
      }
      return new Promise((resolve, reject) => {
        const pending = { command: { id: randomUUID(), method, params: payload, sessionID }, bindingID: b.id, project: clone(b.project), resolve, reject, delivered: false }
        c.pending = pending
        pending.ready = !manual
        if (manual) {
          if (payload.phase === "restore_prepare") {
            c.restore = { id: payload.recoveryId, owner: canonical(payload.transaction), bindingID: b.id,
              original: clone(b.project), phase: "preparing" }
            lock.recoveryOriginal = clone(b.project)
            lock.restore = { id: payload.recoveryId, phase: "preparing", emergencyPath: payload.path }
          } else {
            c.restore.phase = "finishing"
            lock.restore.phase = "finishing"
            lock.restore.openPath = payload.path
          }
          // Reserve in-flight state before awaiting persistence. Nothing is pollable yet.
          persist().then(() => {
            if (c.pending !== pending) return
            const latest = binding(sessionID, { write: true, allowLocked: true })
            if (latest.id !== b.id || latest.lock?.id !== lock.id || lock.state !== "executing" ||
                !sameProject(latest.project, b.project)) fail("stale_binding", "Restore owner changed before dispatch")
            pending.ready = true
          }).catch(async error => {
            if (c.pending !== pending) return
            c.pending = null
            clearTimeout(pending.timer)
            await uncertain(c, "Restore dispatch could not be durably confirmed").catch(() => {})
            reject(new AEError("outcome_uncertain", "Restore remains locked; no host retry", { cause: error.code }))
          })
        }
        pending.timer = setTimeout(async () => {
          if (c.pending !== pending) return
          c.pending = null
          try {
            await uncertain(c, "Host call timed out; do not retry automatically")
          } catch {
            // Persistence failure is fail-closed through healthy().
          }
          reject(new AEError("outcome_uncertain", "Host call timed out; target remains locked", { method }))
        }, wait)
      })
    },
    close() {
      if (closing) return closing
      closed = true
      clearInterval(sweeper)
      closing = (async () => {
        const stopped = new Promise(resolve => server.close(resolve))
        server.closeAllConnections()
        try {
          await requests
          for (const c of live.values()) await suspend(c, "Bridge closed during a host call")
          await saving
        } finally {
          await stopped
          try {
            const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"))
            if (descriptor.instanceId === instanceId) await unlink(descriptorPath)
          } catch (error) { if (error.code !== "ENOENT") throw error }
        }
      })()
      return closing
    },
  }

  function peerVersion(body) {
    if (!validProtocol(body.protocol) || !validVersion(body.version))
      fail("invalid_payload", "Invalid panel version or protocol")
    return { panelProtocol: body.protocol, panelVersion: body.version }
  }
  function negotiate(peer) {
    const metadata = compatibility(peer)
    if (metadata.status === "incompatible")
      fail("incompatible_version", "Panel and plugin versions must match", {
        protocol: PROTOCOL, version: VERSION, ...peer, updateUrl: UPDATE_URL, compatibility: metadata,
      })
  }
  async function route(req) {
    healthy()
    if (req.socket.remoteAddress !== "127.0.0.1" || Object.hasOwn(req.headers, "origin") ||
        req.headers.host !== `127.0.0.1:${server.address().port}` ||
        req.headers["sec-fetch-site"] || req.headers["content-encoding"])
      fail("forbidden", "Only native loopback requests are accepted")
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers["content-type"] || ""))
      fail("invalid_payload", "Content-Type must be application/json")
    const endpoint = req.url
    if ((endpoint === "/poll" ? "GET" : "POST") !== req.method) fail("invalid_method", "Wrong HTTP method")
    if (!["/pair", "/connect", "/compatibility", "/heartbeat", "/poll", "/reply", "/disconnect", "/unpair", "/rotate", "/panel", "/chat"].includes(endpoint))
      fail("not_found", "Unknown endpoint")
    let credential
    if (endpoint !== "/pair") {
      const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || "")
      credential = match && state.credentials.find(c => c.hash === digest(match[1]))
      if (!credential) fail("unauthorized", "Invalid credential")
    } else {
      attempts = attempts.filter(time => now() - time < 60000)
      if (attempts.length >= 10) fail("rate_limited", "Pairing attempt limit reached")
      attempts.push(now())
    }
    const captureReply = endpoint === "/reply" &&
      live.get(credential?.connectionId)?.pending?.command.method === "capture"
    const limit = endpoint === "/chat" ? 16 * 1024 * 1024 : endpoint === "/panel" ? 65536 : captureReply ? CAPTURE_BYTES : MAX_BYTES
    const chunks = []
    let bytes = 0
    for await (const chunk of req) {
      bytes += chunk.length
      if (bytes > limit) fail("payload_too_large", "Request exceeds method transport limit")
      chunks.push(chunk)
    }
    let body = {}
    if (bytes) {
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")) } catch { fail("invalid_payload", "Invalid JSON") }
    } else if (endpoint !== "/poll") fail("invalid_payload", "JSON body required")
    if (endpoint === "/poll" && bytes) fail("invalid_payload", "Poll must not have a body")
    const info = { protocol: PROTOCOL, version: VERSION, updateUrl: UPDATE_URL, compatibility: compatibility() }
    if (endpoint === "/pair") {
      schema(body, ["code", "protocol", "version", "panelId"])
      assertString(body.code, "code", 64)
      assertString(body.panelId, "panelId", 256)
      const codeHash = digest(body.code)
      const automatic = codeHash === digest(automaticCode)
      const code = automatic ? { expiresAt: Infinity } : pairing.get(codeHash)
      if (!code || code.expiresAt <= now()) fail("invalid_pairing_code", "Pairing code is invalid, used, or expired")
      // Bounded by the existing one-code-per-session TTL; never persisted or linked to a credential.
      code.peer = peerVersion(body)
      negotiate(code.peer)
      info.compatibility = compatibility(code.peer)
      pairing.delete(codeHash)
      let record = state.credentials.find(c => c.panelId === body.panelId)
      if (record) {
        if (automatic) {
          const secret = automaticCredentials.get(body.panelId)
          if (secret && record.hash === digest(secret)) return { credential: secret, connectionId: record.connectionId, ...info }
          fail("already_paired", "Existing identity requires its saved credential or explicit credential recovery")
        }
        const c = live.get(record.connectionId)
        if (c) await suspend(c, "Panel paired again; explicitly rebind")
      } else {
        if (state.credentials.length >= 1000) fail("rate_limited", "Too many paired panels")
        record = { panelId: body.panelId, connectionId: randomUUID(), hash: null }
        state.credentials.push(record)
      }
      const secret = randomBytes(32).toString("base64url")
      record.hash = digest(secret)
      await persist()
      if (automatic) automaticCredentials.set(body.panelId, secret)
      return { credential: secret, connectionId: record.connectionId, ...info }
    }
    let c = live.get(credential.connectionId)
    if (endpoint === "/connect" || endpoint === "/compatibility") {
      schema(body, endpoint === "/connect"
        ? ["protocol", "version", "panelId", "project", "aeVersion", "capabilities"]
        : ["protocol", "version", "panelId"], endpoint === "/connect" ? ["activeCompId"] : [])
      if (body.panelId !== credential.panelId) fail("unauthorized", "Credential belongs to a different panel")
      const peer = peerVersion(body), metadata = compatibility(peer)
      const p = endpoint === "/connect" ? project(body.project) : null
      const caps = endpoint === "/connect" ? capabilities(body.capabilities) : null
      const activeCompId = endpoint === "/connect" ? activeComp(body.activeCompId) : null
      if (endpoint === "/connect") assertString(body.aeVersion, "aeVersion", 128)
      if (c && (endpoint === "/connect" || metadata.status === "incompatible"))
        await suspend(c, "Panel negotiation changed; explicitly rebind")
      if (!c) {
        c = { id: credential.connectionId, epoch: randomUUID(), panelId: credential.panelId,
          project: null, capabilities: null, aeVersion: null, activeCompId: null,
          connected: false, seen: now(), busy: false, pending: null }
        live.set(c.id, c)
      }
      c.peer = peer
      info.compatibility = metadata
      // Discovery never connects, binds, dispatches tools or clears recovery state.
      if (endpoint === "/compatibility") return { connectionId: c.id, ...info }
      negotiate(peer)
      c = { id: credential.connectionId, epoch: randomUUID(), panelId: credential.panelId, project: p, capabilities: caps,
        peer, aeVersion: body.aeVersion, activeCompId, connected: true, seen: now(), busy: false, pending: null }
      live.set(c.id, c)
      return { connectionId: c.id, ...info }
    }
    if (endpoint === "/disconnect" || endpoint === "/unpair" || endpoint === "/rotate") {
      schema(body, [])
      if (c) await suspend(c, "Panel disconnected or credential changed")
      if (endpoint === "/unpair") {
        credential.hash = null
        if (c) delete c.peer
      }
      const secret = endpoint === "/rotate" ? randomBytes(32).toString("base64url") : null
      if (secret) credential.hash = digest(secret)
      await persist()
      return secret ? { credential: secret, connectionId: credential.connectionId, ...info } : { ok: true }
    }
    if (!c?.connected) fail("disconnected", "Connect before sending requests")
    if (now() - c.seen > heartbeatMs) {
      await suspend(c, "Heartbeat expired")
      fail("disconnected", "Heartbeat expired; reconnect and explicitly rebind")
    }
    if (endpoint === "/chat") {
      schema(body, ["action", "project"], ["text", "requestId", "compId", "directory", "permissionId", "response", "takeover", "attachments", "model", "before", "skill", "draft", "token", "sessionID", "expectedSessionID", "search", "offset", "title", "references", "cursor", "messageID", "retryMessageID", "management"])
      if (!["skillManage", "state", "history", "retryDraft", "send", "new", "stop", "permission", "models", "model", "checkpoints", "bind", "captureBind", "targets", "skills", "skillReview", "skillSave", "conversations", "reopen", "rename"].includes(body.action)) fail("invalid_payload", "Unknown chat action")
      const expected = project(body.project), credentialHash = credential.hash
      const check = () => {
        if (live.get(c.id) !== c || !c.connected || credential.hash !== credentialHash || !sameProject(c.project, expected))
          fail("stale_project", "Project or connection changed; message was not redirected")
      }
      check()
      if (!chatHandler) fail("chat_unavailable", "Reload CookieMonster with the matching chat-enabled plugin")
      const handler = chatHandler
      return async () => {
        check()
        const result = await handler({ connectionId: c.id, panelId: c.panelId, project: clone(expected), body: clone(body), check })
        check()
        if (Buffer.byteLength(JSON.stringify(result)) > 16 * 1024 * 1024) fail("payload_too_large", "Chat response exceeds its display budget")
        return { result }
      }
    }
    if (endpoint === "/panel") {
      assertObject(body)
      if (!Object.hasOwn(panelActions, body.action)) fail("invalid_payload", "Unknown panel action")
      schema(body, ["action", ...panelActions[body.action]])
      if (Object.hasOwn(body, "id")) assertString(body.id, "id", 256)
      if (Object.hasOwn(body, "token")) assertString(body.token, "token", 4096)
      if (Object.hasOwn(body, "pinned") && typeof body.pinned !== "boolean") fail("invalid_payload", "Invalid pinned flag")
      const owned = [...bindings.values()].find(b => b.connectionId === c.id)
      if (!owned) fail("not_bound", "Panel services require an active bound connection")
      const b = binding(owned.sessionID, { allowLocked: true })
      if (!panelHandler) fail("handler_unavailable", "Panel services are not registered")
      if (c.panelPending) fail("panel_busy", "Panel request already outstanding")
      const handler = panelHandler, credentialHash = credential.hash, input = clone(body)
      const recheck = result => {
        const current = binding(b.sessionID, { allowLocked: true })
        const rec = c.restore, lock = current.lock
        const recoveryResult = input.action === "checkpoint.restore.confirm" &&
          result?.recoveryCopy === true && result.rebindRequired === true && result.automationSuspended === true &&
          rec?.phase === "finished" && rec.bindingID === b.id && sameProject(rec.original, b.project) &&
          lock?.restore?.phase === "finished" && lock.state === "uncertain" &&
          lock.evidence?.outcome === "recovery_copy" && lock.evidence.checkpointId === result.checkpointId &&
          lock.evidence.currentCheckpointId === result.currentCheckpointId &&
          lock.evidence.expectedFingerprint === result.fingerprint &&
          result.path === lock.restore.openPath && result.path === current.project.path &&
          result.canonicalPath === b.project.path
        if (live.get(c.id) !== c || credential.hash !== credentialHash ||
            current.id !== b.id || current.connectionId !== c.id || (!sameProject(current.project, b.project) && !recoveryResult))
          fail("stale_binding", "Panel request binding or credential changed")
      }
      c.panelPending = true
      // Returning a thunk releases the HTTP transition queue before adapter host calls.
      return async () => {
        try {
          recheck()
          const result = await handler({ connectionId: c.id, sessionID: b.sessionID, binding: clone(b), body: input })
          recheck(result)
          const response = { result: clone(result) }
          if (Buffer.byteLength(canonical(response)) > MAX_BYTES) fail("payload_too_large", "Panel response exceeds limit")
          return response
        } finally { c.panelPending = false }
      }
    }
    if (endpoint === "/heartbeat") {
      schema(body, ["project", "capabilities", "busy"], ["activeCompId"])
      const p = project(body.project)
      const caps = capabilities(body.capabilities), activeCompId = activeComp(body.activeCompId)
      if (typeof body.busy !== "boolean") fail("invalid_payload", "busy must be boolean")
      if (!sameProject(p, c.project)) {
        for (const b of bindings.values()) if (b.connectionId === c.id) projectChangedBindings.add(b.id)
        await suspend(c, "Project identity, path or saved state changed; explicitly rebind")
        c.connected = true
      }
      if (Object.hasOwn(body, "activeCompId")) c.activeCompId = activeCompId
      c.project = p
      c.capabilities = caps
      c.busy = body.busy
      c.seen = now()
      const b = [...bindings.values()].find(b => b.connectionId === c.id)
      return { binding: b ? view(b) : null, lock: clone(targetLock(c.id, p) || null) }
    }
    if (endpoint === "/poll") {
      const pending = c.pending
      if (!pending || !pending.ready || pending.delivered) return { command: null }
      pending.delivered = true
      return { command: clone(pending.command) }
    }
    schema(body, ["id"], ["result", "error"])
    assertString(body.id, "id", 256)
    if (Object.hasOwn(body, "result") === Object.hasOwn(body, "error"))
      fail("invalid_payload", "Reply must contain exactly one result or error")
    if (body.error) {
      schema(body.error, ["code", "message"])
      assertString(body.error.code, "code", 128)
      assertString(body.error.message, "message", 8192)
    } else if (Object.hasOwn(body, "error")) fail("invalid_payload", "Invalid host error")
    const pending = c.pending
    if (!pending || !pending.delivered || pending.command.id !== body.id) fail("invalid_reply", "Unknown, late, or replayed reply")
    if (bytes > (pending.command.method === "capture" && !body.error ? CAPTURE_BYTES : MAX_BYTES))
      fail("payload_too_large", "Reply exceeds method transport limit")
    if (!body.error && pending.command.method === "capture") {
      try {
        schema(body.result, ["mime", "data", "width", "height"])
        const r = body.result
        if (!["image/png", "image/jpeg"].includes(r.mime) || typeof r.data !== "string" ||
            r.data.length > 4 * Math.ceil(5 * 1024 * 1024 / 3) ||
            !r.data.length || r.data.length % 4 || /[^A-Za-z0-9+/=]/.test(r.data) ||
            !Number.isSafeInteger(r.width) || !Number.isSafeInteger(r.height) ||
            r.width < 1 || r.height < 1 || r.width > 2000 || r.height > 2000)
          fail("invalid_host_result", "Invalid capture dimensions, format, or base64")
        const decoded = Buffer.from(r.data, "base64")
        if (decoded.length > 5 * 1024 * 1024 || decoded.toString("base64") !== r.data)
          fail("invalid_host_result", "Capture exceeds binary budget or has invalid encoding")
      } catch {
        body.error = { code: "invalid_host_result", message: "Capture reply failed method validation" }
      }
    }
    // A received one-shot reply must not time out during its durable transition.
    clearTimeout(pending.timer)
    if (!body.error && pending.command.method === "execute") {
      try {
        const r = body.result, p = pending.command.params
        if (r?.status === "stopped") {
          schema(r, ["status", "results", "failure", "recovery"])
          schema(r.failure, ["code", "message", "actionIndex"])
          schema(r.recovery, ["id", "snapshot"])
          assertString(r.failure.code, "failure code", 128)
          assertString(r.failure.message, "failure message", 2048)
          assertString(r.recovery.id, "recovery id", 256)
          if (p.phase && p.phase !== "chunk") fail("invalid_host_result", "Stopped result outside action execution")
          const start = p.phase === "chunk" ? p.offset : 0
          const count = p.phase === "chunk" ? p.count : p.actions?.length
          if (!Number.isSafeInteger(count) || count < 1) fail("invalid_host_result", "Stopped result has no dispatched actions")
          if (!Array.isArray(r.results) || !Number.isSafeInteger(r.failure.actionIndex) ||
              r.failure.actionIndex < start || r.failure.actionIndex >= start + count ||
              r.results.length !== r.failure.actionIndex - start ||
              !sameProject(project(r.recovery.snapshot.project), pending.project) ||
              !Number.isSafeInteger(r.recovery.snapshot.revision) || r.recovery.snapshot.busy !== false)
            fail("invalid_host_result", "Invalid stopped execution evidence")
          c.stopped = clone(r.recovery)
        } else if (p.phase === "restore_prepare" || p.phase === "restore_finish") {
          schema(r, ["status", "project", "receipt"])
          const next = project(r.project), rec = c.restore
          const b = bindings.get(pending.command.sessionID), lock = targetLock(c.id, pending.project)
          const preparing = p.phase === "restore_prepare"
          if (!rec || rec.id !== p.recoveryId || rec.owner !== canonical(p.transaction) ||
              rec.phase !== (preparing ? "preparing" : "finishing") ||
              r.status !== (preparing ? "recovery_saved" : "recovered") ||
              next.path !== (preparing ? pending.project.path : p.path) || !next.saved || !b || b.id !== pending.bindingID ||
              !sameProject(b.project, pending.project) || lock?.state !== "executing" ||
              lock.sessionID !== pending.command.sessionID || lock.restore?.id !== rec.id)
            fail("invalid_host_result", "Manual restore reply does not match the executing owner")
          restoreReceipt(r.receipt, next)
          if (r.receipt.dirty !== false) fail("invalid_host_result", "Restore transition must return a clean project")
          if (preparing) {
            const prior = p.expected
            if (!sameProject(next, pending.project) || r.receipt.projectEpoch !== prior.projectEpoch ||
                r.receipt.revision !== prior.revision)
              fail("invalid_host_result", "Manual emergency save changed the approved revision")
            rec.snapshot = canonical(r.receipt)
          } else {
            if (r.receipt.projectEpoch === p.expected.projectEpoch)
              fail("invalid_host_result", "Open must establish a new native project epoch")
            if (p.path === rec.original.path) {
              if (!sameProject(next, rec.original)) fail("invalid_host_result", "Original identity did not return")
              delete lock.recoveryOriginal
            }
            rec.finishedFingerprint = restoreFingerprint(r.receipt, c.id)
          }
          rec.phase = preparing ? "saved" : "finished"
          lock.restore.phase = rec.phase
          b.project = clone(next); c.project = clone(next); lock.project = clone(next)
          await persist()
        } else if (p.phase === "recovery_prepare" || p.phase === "recovery_finish") {
          schema(r, ["status", "project", "snapshot"])
          const next = project(r.project)
          const expectedPath = p.phase === "recovery_prepare" ? p.path : c.stopped?.original?.path
          const expectedStatus = p.phase === "recovery_prepare" ? "recovery_saved" : "recovered"
          const b = bindings.get(pending.command.sessionID), lock = targetLock(c.id, pending.project)
          if (r.status !== expectedStatus || next.path !== expectedPath || !next.saved ||
              !sameProject(next, r.snapshot.project) || !b || b.id !== pending.bindingID ||
              !sameProject(b.project, pending.project) || lock?.state !== "executing")
            fail("invalid_host_result", "Recovery project transition did not match authorization")
          if (p.phase === "recovery_prepare") {
            c.stopped.original = clone(pending.project)
            lock.recoveryOriginal = clone(pending.project)
          } else {
            if (!sameProject(next, c.stopped.original)) fail("invalid_host_result", "Original identity did not return")
            delete lock.recoveryOriginal
          }
          b.project = clone(next); c.project = clone(next); lock.project = clone(next)
          await persist()
          if (p.phase === "recovery_finish") c.stopped = null
        }
      } catch {
        body.error = { code: "invalid_host_result", message: "Execute reply failed recovery validation" }
      }
    }
    if (c.pending !== pending || !c.connected)
      fail("invalid_reply", "Connection changed while persisting reply")
    let result = null
    if (!body.error) {
      try {
        result = clone(body.result)
        if (pending.command.method === "inspect" && pending.command.params.restore === RESTORE_PROOF) {
          restoreReceipt(result, pending.project)
          c.restoreObserved = restoreFingerprint(result, c.id)
        }
        if (pending.command.method === "inspect" && result?.activeCompId !== undefined) activeComp(result.activeCompId)
      } catch (error) { body.error = { code: error.code === "restore_unsupported" ? error.code : "invalid_host_result",
        message: "Host reply is not finite JSON or has invalid metadata or unsupported restore protocol" } }
    }
    c.pending = null
    clearTimeout(pending.timer)
    c.busy = false
    c.seen = now()
    if (body.error) {
      const unknown = ["outcome_uncertain", "uncertain_outcome", "timeout", "invalid_host_result", "execution_failed", "capture_cleanup_failed"].includes(body.error.code) ||
        writes.has(pending.command.method) && ["host_error", "response_too_large"].includes(body.error.code) ||
        pending.command.method === "raw" && !["invalid_payload", "stale_project", "incompatible", "no_project", "busy", "unsaved_project", "preference_disabled", "lock_required", "binding_suspended"].includes(body.error.code)
      try {
        if (unknown) {
          c.busy = true
          await uncertain(c, body.error.message)
        }
      } finally {
        pending.reject(new AEError(unknown ? "outcome_uncertain" : body.error.code, body.error.message,
          unknown ? { cause: body.error.code } : {}))
      }
    } else {
      if (pending.command.method === "inspect" && result?.activeCompId !== undefined)
        c.activeCompId = result.activeCompId
      pending.resolve(result)
    }
    return { ok: true }
  }
  // Serialize transport transitions; host calls wait outside this queue.
  let requests = Promise.resolve()
  const server = http.createServer({ maxHeaderSize: 8192, requestTimeout: 5000, headersTimeout: 5000 }, (req, res) => {
    const task = requests.then(() => route(req))
    requests = task.catch(() => {})
    task.then(result => typeof result === "function" ? result() : result).then(result => {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" })
      res.end(JSON.stringify(result))
    }, error => {
      const status = { forbidden: 403, unauthorized: 401, not_found: 404, rate_limited: 429, payload_too_large: 413 }[error.code] || 400
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", Connection: "close" })
      res.end(JSON.stringify({ error: { code: error instanceof AEError ? error.code : "bridge_error",
        message: error instanceof AEError ? error.message : "Bridge request failed", details: error instanceof AEError ? error.details : {} } }))
    })
  })
  server.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"))
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const sweeper = setInterval(() => {
    const task = requests.then(expire)
    requests = task.catch(error => { diskError = error })
  }, Math.max(10, Math.min(1000, heartbeatMs / 2)))
  sweeper.unref()
  try {
    // Protected by the owner-only data directory; never exposed through HTTP or diagnostics.
    await atomic(path.join(dataDir, "automatic-connection.json"), { instanceId, code: automaticCode })
    await atomic(descriptorPath, { port: server.address().port, instanceId, protocol: PROTOCOL, version: VERSION, updateUrl: UPDATE_URL })
  } catch (error) {
    await bridge.close()
    throw error
  }
  return bridge
}
