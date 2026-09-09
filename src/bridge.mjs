import http from "node:http"
import os from "node:os"
import path from "node:path"
import { randomBytes, randomUUID, createHash } from "node:crypto"
import net from "node:net"
import { lstat, readFile, open, rename, unlink } from "node:fs/promises"
import { secureDirectory } from "./storage.mjs"
import { AEError, fail, canonical, assertObject, assertString, PROTOCOL, VERSION, UPDATE_URL } from "./protocol.mjs"

const MAX_BYTES = 4 * 1024 * 1024
const digest = value => createHash("sha256").update(value).digest("hex")
const clone = value => JSON.parse(canonical(value))
const writes = new Set(["save", "execute", "open", "raw", "capture"])
const CAPTURE_BYTES = 7 * 1024 * 1024
const panelActions = {
  checkpoints: [], "checkpoint.pin": ["id", "pinned"], "checkpoint.delete": ["id"],
  "checkpoint.restore.propose": ["id"], "checkpoint.restore.confirm": ["token"],
  renders: [], diagnostics: [],
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
} = {}) {
  for (const value of [timeoutMs, heartbeatMs, pairingTtlMs])
    if (!Number.isFinite(value) || value <= 0) fail("invalid_payload", "Timeouts must be positive")
  dataDir = path.resolve(dataDir)
  const statePath = path.join(dataDir, "bridge-state.json")
  const descriptorPath = path.join(dataDir, "descriptor.json")
  const instanceId = randomUUID()
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
      await rename(temporary, file)
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
  const pairing = new Map()
  const releaseListeners = new Set()
  let attempts = []
  let closed = false
  let bindingChange = false
  let panelHandler = null
  let closing = null

  function healthy() {
    if (closed) fail("disconnected", "Bridge is closed")
    if (diskError) fail("storage_failed", "Bridge persistence failed; writes are disabled")
  }
  function targetLock(connectionId, p) {
    return state.locks.find(lock => lock.connectionId === connectionId ||
      p?.path && (lock.project.path === p.path || lock.recoveryOriginal?.path === p.path))
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
    dataDir,
    pairingCode(sessionID) {
      healthy()
      assertString(sessionID, "sessionID", 256)
      for (const [code, p] of pairing) if (p.sessionID === sessionID || p.expiresAt <= now()) pairing.delete(code)
      if (pairing.size >= 100) fail("rate_limited", "Too many outstanding pairing codes")
      const code = randomBytes(6).toString("hex").toUpperCase()
      const expiresAt = now() + pairingTtlMs
      pairing.set(digest(code), { sessionID, expiresAt })
      return { code, expiresAt, protocol: PROTOCOL, version: VERSION, updateUrl: UPDATE_URL }
    },
    async connections() {
      await expire()
      return [...live.values()].map(c => ({
        id: c.id, connectionId: c.id, epoch: c.epoch, panelId: c.panelId, aeVersion: c.aeVersion,
        project: clone(c.project), capabilities: clone(c.capabilities), activeCompId: c.activeCompId ?? null,
        connected: c.connected, busy: c.busy, binding: [...bindings.values()].filter(b => b.connectionId === c.id).map(view)[0] || null,
        lock: clone(targetLock(c.id, c.project) || null),
      }))
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
    async unlock(sessionID) {
      const b = binding(sessionID, { allowLocked: true })
      const c = live.get(b.connectionId)
      if (c.pending || c.busy) fail("host_busy", "Cannot unlock while AE is busy")
      const lock = targetLock(b.connectionId, b.project)
      if (!lock) return
      if (lock.connectionId !== b.connectionId || !sameProject(lock.project, b.project))
        fail("recovery_target_mismatch", "Rebind the original connection and project before clearing its lock")
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
      if (method === "execute" && payload.phase) {
        const fields = {
          begin: ["actions"], chunk: ["offset", "count", "expected"],
          recovery_prepare: ["recoveryId", "expected", "path"],
          recovery_finish: ["recoveryId", "expected", "verifiedCheckpoint"],
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
      }
      return new Promise((resolve, reject) => {
        const pending = { command: { id: randomUUID(), method, params: payload, sessionID }, bindingID: b.id, project: clone(b.project), resolve, reject, delivered: false }
        c.pending = pending
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

  function negotiate(body) {
    if (body.protocol !== PROTOCOL || body.version !== VERSION)
      fail("incompatible_version", "Panel and plugin versions must match", {
        protocol: PROTOCOL, version: VERSION, panelProtocol: body.protocol, panelVersion: body.version, updateUrl: UPDATE_URL,
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
    if (!["/pair", "/connect", "/heartbeat", "/poll", "/reply", "/disconnect", "/unpair", "/rotate", "/panel"].includes(endpoint))
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
    const limit = endpoint === "/panel" ? 65536 : captureReply ? CAPTURE_BYTES : MAX_BYTES
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
    const info = { protocol: PROTOCOL, version: VERSION, updateUrl: UPDATE_URL }
    if (endpoint === "/pair") {
      schema(body, ["code", "protocol", "version", "panelId"])
      assertString(body.code, "code", 64)
      assertString(body.panelId, "panelId", 256)
      negotiate(body)
      const codeHash = digest(body.code)
      const code = pairing.get(codeHash)
      if (!code || code.expiresAt <= now()) fail("invalid_pairing_code", "Pairing code is invalid, used, or expired")
      pairing.delete(codeHash)
      let record = state.credentials.find(c => c.panelId === body.panelId)
      if (record) {
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
      return { credential: secret, connectionId: record.connectionId, ...info }
    }
    let c = live.get(credential.connectionId)
    if (endpoint === "/connect") {
      schema(body, ["protocol", "version", "panelId", "project", "aeVersion", "capabilities"], ["activeCompId"])
      negotiate(body)
      if (body.panelId !== credential.panelId) fail("unauthorized", "Credential belongs to a different panel")
      const p = project(body.project)
      const caps = capabilities(body.capabilities), activeCompId = activeComp(body.activeCompId)
      assertString(body.aeVersion, "aeVersion", 128)
      if (c) await suspend(c, "Panel reconnected; explicitly rebind")
      c = { id: credential.connectionId, epoch: randomUUID(), panelId: credential.panelId, project: p, capabilities: caps,
        aeVersion: body.aeVersion, activeCompId, connected: true, seen: now(), busy: false, pending: null }
      live.set(c.id, c)
      return { connectionId: c.id, ...info }
    }
    if (endpoint === "/disconnect" || endpoint === "/unpair" || endpoint === "/rotate") {
      schema(body, [])
      if (c) await suspend(c, "Panel disconnected or credential changed")
      if (endpoint === "/unpair") credential.hash = null
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
      const recheck = () => {
        const current = binding(b.sessionID, { allowLocked: true })
        if (live.get(c.id) !== c || credential.hash !== credentialHash ||
            current.id !== b.id || current.connectionId !== c.id || !sameProject(current.project, b.project))
          fail("stale_binding", "Panel request binding or credential changed")
      }
      c.panelPending = true
      // Returning a thunk releases the HTTP transition queue before adapter host calls.
      return async () => {
        try {
          recheck()
          const result = await handler({ connectionId: c.id, sessionID: b.sessionID, binding: clone(b), body: input })
          recheck()
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
      if (!pending || pending.delivered) return { command: null }
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
        if (pending.command.method === "inspect" && result?.activeCompId !== undefined) activeComp(result.activeCompId)
      } catch { body.error = { code: "invalid_host_result", message: "Host reply is not finite JSON or has invalid metadata" } }
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
    await atomic(descriptorPath, { port: server.address().port, instanceId, protocol: PROTOCOL, version: VERSION, updateUrl: UPDATE_URL })
  } catch (error) {
    await bridge.close()
    throw error
  }
  return bridge
}
