import { randomBytes, randomUUID, createHash } from "node:crypto"
import { realpath, stat, lstat, copyFile } from "node:fs/promises"
import { constants, createReadStream } from "node:fs"
import path from "node:path"
import { AEError, fail, hash, canonical, assertObject, assertString, PROPOSAL_TTL } from "./protocol.mjs"
import { RESTORE_PROOF, restoreReceipt, restoreFingerprint } from "./bridge.mjs"

const clone = value => JSON.parse(canonical(value))
const uncertain = error => ["outcome_uncertain", "uncertain_outcome", "timeout", "disconnected", "binding_suspended", "stale_binding", "not_bound", "storage_failed", "invalid_host_result"].includes(error.code)
const sameProject = (a, b) => a.id === b.id && a.path === b.path
const MAX_BYTES = 3 * 1024 * 1024
const SCRIPT_PROOF = "script-overview-v1"

function overviewProof(inspected) {
  const { fingerprint, nextCursor, ...data } = inspected.data
  // Cursor handles change on every page read; their presence, not their value, is scene metadata.
  return hash({ kind: SCRIPT_PROOF, connectionId: inspected.binding.connectionId, data, hasMore: nextCursor !== null })
}

function bounded(value) {
  const text = canonical(value)
  if (Buffer.byteLength(text) > MAX_BYTES) fail("payload_too_large", "Workflow payload exceeds the inspection/transport budget")
  return JSON.parse(text)
}

function actionList(value) {
  if (!Array.isArray(value) || !value.length) fail("invalid_actions", "Provide a nonempty action array")
  const actions = bounded(value)
  for (const action of actions) {
    assertObject(action, "action")
    assertString(action.type, "action.type", 128)
    if (/raw|script/i.test(action.type)) fail("invalid_actions", "Raw scripts cannot be included in structured plans")
  }
  return actions
}

export function inspectArgs(value = {}) {
  const query = bounded(value)
  assertObject(query, "query")
  if (Object.keys(query).some(key => !["compId", "layerId", "propertyPath", "depth", "cursor"].includes(key)))
    fail("invalid_payload", "Unknown inspection query field")
  for (const key of ["compId", "layerId"])
    if (Object.hasOwn(query, key) && (!Number.isSafeInteger(query[key]) || query[key] < 1 || query[key] > 2147483647))
      fail("invalid_payload", `${key} must be a positive persistent ID`)
  if (Object.hasOwn(query, "layerId") && !Object.hasOwn(query, "compId") ||
      Object.hasOwn(query, "propertyPath") && !Object.hasOwn(query, "layerId"))
    fail("invalid_payload", "Layers require compId; propertyPath requires compId and layerId")
  if (Object.hasOwn(query, "depth") && (!Number.isInteger(query.depth) || query.depth < 0 || query.depth > 8))
    fail("invalid_payload", "Inspection depth must be an integer from 0 to 8")
  if (Object.hasOwn(query, "cursor")) {
    assertString(query.cursor, "cursor", 8192)
    if (query.cursor.includes("\u0000")) fail("invalid_payload", "Invalid cursor")
  }
  if (Object.hasOwn(query, "propertyPath")) {
    if (!Array.isArray(query.propertyPath) || query.propertyPath.length > 32)
      fail("invalid_payload", "propertyPath must be a bounded array")
    for (const part of query.propertyPath) {
      assertObject(part, "propertyPath segment")
      if (Object.keys(part).some(key => !["index", "matchName", "name"].includes(key)) ||
          !Number.isSafeInteger(part.index) || part.index < 0 || part.index > 100000)
        fail("invalid_payload", "Invalid propertyPath segment")
      assertString(part.matchName, "matchName", 4096)
      if (part.matchName.includes("\u0000")) fail("invalid_payload", "Invalid matchName")
      if (Object.hasOwn(part, "name") && (typeof part.name !== "string" || part.name.length > 4096 || part.name.includes("\u0000")))
        fail("invalid_payload", "Invalid property name")
    }
  }
  return query
}

export function createWorkflow({ bridge, checkpoints, grants, now = Date.now, longPlanMs = 30000 }) {
  const proposals = new Map()
  const rawGates = new Map()
  const queryRevisions = new Map()
  const revisionSalt = randomBytes(32).toString("hex")
  const running = new Set()
  bridge.onRelease(async (sessionID, bindingID) => {
    proposals.delete(sessionID)
    rawGates.delete(sessionID)
    queryRevisions.delete(sessionID)
    await grants.release(sessionID, bindingID)
  })

  function current(sessionID, expected, options = {}) {
    const b = bridge.binding(sessionID, options)
    if (expected && (b.id !== expected.id || b.connectionId !== expected.connectionId ||
        !sameProject(b.project, expected.project)))
      fail("stale_binding", "Session binding or project changed; propose again")
    return b
  }
  function queryRevision(sessionID, b, data) {
    const scope = hash({ sessionID, bindingID: b.id, connectionId: b.connectionId,
      project: { id: data.project.id, path: data.project.path }, projectEpoch: data.projectEpoch })
    const prior = queryRevisions.get(sessionID)
    // Native counters can reset after reopening. Never resurrect an observed older token.
    // Native projectEpoch also detects same-path, same-counter replacements.
    const epoch = !prior ? 0 : prior.epoch + (prior.scope !== scope || data.revision < prior.revision ? 1 : 0)
    const token = hash({ salt: revisionSalt, scope, epoch, revision: data.revision })
    queryRevisions.set(sessionID, { scope, epoch, revision: data.revision, token })
    return token
  }
  async function snapshot(sessionID, expected, allowLocked = false, query) {
    const b = current(sessionID, expected, { allowLocked })
    const data = bounded(await bridge.call(sessionID, "inspect", query === undefined ? {} : { query }, { allowLocked }))
    current(sessionID, b, { allowLocked })
    assertObject(data)
    if (!data.project || !sameProject(data.project, b.project)) fail("stale_project", "Host project identity no longer matches binding")
    if (typeof data.project.saved !== "boolean" || !Array.isArray(data.items) ||
        !Array.isArray(data.selection) || !Array.isArray(data.installedEffects) ||
        !(data.activeCompId === null || Number.isSafeInteger(data.activeCompId)) ||
        typeof data.capabilities?.fileNetwork !== "boolean" || typeof data.busy !== "boolean")
      fail("invalid_host_result", "Inspection must include complete project, items, selection, effects, capabilities, and busy state")
    if (data.busy) fail("host_busy", "AE reports an active operation")
    if (query !== undefined) {
      if (!Number.isSafeInteger(data.revision) || data.revision < 1 ||
          typeof data.projectEpoch !== "string" || !data.projectEpoch.length || data.projectEpoch.length > 256 ||
          typeof data.project.id !== "string" || !data.project.id.length || data.project.id.length > 256 ||
          !(data.project.path === null || typeof data.project.path === "string" && data.project.path.length > 0 && data.project.path.length <= 32768) ||
          data.project.saved !== (data.project.path !== null) ||
          typeof data.aeVersion !== "string" || !data.aeVersion.length || data.aeVersion.length > 256 ||
          typeof data.fingerprint !== "string" || !data.fingerprint.length || data.fingerprint.length > 256 ||
          !(data.nextCursor === null || typeof data.nextCursor === "string" && data.nextCursor.length > 0 && data.nextCursor.length <= 8192) ||
          data.activeCompId !== null && data.activeCompId < 1)
        fail("invalid_host_result", "Query inspection must include native revision, project identity, version, fingerprint and cursor")
    }
    const token = query === undefined ? null : queryRevision(sessionID, b, data)
    return { data, fingerprint: query === undefined ? hash(data) : token, binding: b,
      ...(query === undefined ? {} : { query }) }
  }
  async function revision(sessionID, plan, allowLocked = false) {
    const inspected = await snapshot(sessionID, plan.binding, allowLocked, plan.query)
    if (inspected.fingerprint !== plan.fingerprint)
      fail(plan.query === undefined ? "stale_fingerprint" : "stale_revision", "Project changed since inspection")
    return inspected
  }
  async function restoreSnapshot(sessionID, expected) {
    const b = current(sessionID, expected, { allowLocked: true })
    if (bridge.compactRestore !== RESTORE_PROOF)
      fail("restore_unsupported", "Matching compact restore bridge and host are required")
    let data
    try {
      data = bounded(await bridge.call(sessionID, "inspect", { restore: RESTORE_PROOF }, { allowLocked: true }))
    } catch (error) {
      if (["invalid_payload", "unsupported_method", "invalid_method"].includes(error.code))
        fail("restore_unsupported", "Host does not support compact restore; update the matching host without fallback")
      throw error
    }
    current(sessionID, b, { allowLocked: true })
    restoreReceipt(data, b.project)
    return { data, binding: b, fingerprint: restoreFingerprint(data, b.connectionId) }
  }
  async function restoreRevision(sessionID, binding, fingerprint) {
    const inspected = await restoreSnapshot(sessionID, binding)
    if (inspected.fingerprint !== fingerprint)
      fail("stale_fingerprint", "Project identity, native epoch, revision or dirty state changed since restore review")
    return inspected
  }
  function alive(plan) {
    if (plan.expiresAt <= now()) fail("proposal_expired", "Proposal expired; propose again")
  }
  function consume(sessionID, token, kind) {
    assertString(token, "token", 256)
    const plan = proposals.get(sessionID)
    if (!plan || plan.kind !== kind || plan.token !== token) fail("invalid_token", "Unknown, changed, or already-used proposal")
    proposals.delete(sessionID)
    alive(plan)
    if (hash(plan.payload) !== plan.payloadHash) fail("invalid_token", "Proposal payload changed")
    return plan
  }
  async function permit(ask, summary, metadata) {
    if (typeof ask !== "function") fail("permission_required", "An explicit permission callback is required")
    if (await ask(summary, clone(metadata)) === false) fail("permission_denied", "Permission denied")
  }
  async function authorize(sessionID, b, actions) {
    const result = clone(actions)
    for (const action of result) {
      if (/import/i.test(action.type)) {
        assertString(action.path, "import path", 32768)
        action.path = await grants.check({ sessionID, bindingID: b.id, path: action.path,
          write: false, projectPath: b.project.path })
        current(sessionID, b, { allowLocked: true })
      }
    }
    return result
  }
  async function exclusive(sessionID, operation) {
    if (running.has(sessionID)) fail("workflow_busy", "This session already has a workflow operation in progress")
    running.add(sessionID)
    try { return await operation() } finally { running.delete(sessionID) }
  }
  async function checkpointMatches(checkpoint, b) {
    return checkpoint?.verified && checkpoint.projectId === b.project.id &&
      checkpoint.projectPath === await realpath(b.project.path)
  }
  async function saveCheckpoint(sessionID, inspected, planHash) {
    const b = inspected.binding
    await revision(sessionID, inspected, true)
    const saved = await bridge.call(sessionID, "save", {}, { allowLocked: true })
    if (!saved?.project?.saved || !sameProject(saved.project, b.project))
      fail("stale_project", "Save changed project identity or did not save the project")
    // Current host omits dirty/save timestamps. Do not normalize revision or content:
    // revision also guards opaque/mixed-style state that cannot be compared directly.
    await revision(sessionID, inspected, true)
    const checkpoint = await checkpoints.create({
      projectPath: b.project.path, projectId: b.project.id, planHash, pinned: true,
    })
    try {
      const verified = await checkpoints.verify(checkpoint.id)
      if (verified?.id !== checkpoint.id || !await checkpointMatches(verified, b) || verified.planHash !== planHash)
        fail("checkpoint_invalid", "Checkpoint verification or plan identity failed")
      await revision(sessionID, inspected, true)
      return verified
    } catch (error) {
      throw new AEError(error.code || "checkpoint_invalid", error.message, { ...error.details, checkpointId: checkpoint.id })
    }
  }

  function checkpointIdentity(checkpoint) {
    return hash(Object.fromEntries(["id", "projectId", "projectPath", "path", "planHash", "createdAt", "size", "hash"]
      .map(key => [key, checkpoint[key]])))
  }

  async function fileHash(file) {
    const before = await lstat(file)
    if (!before.isFile() || before.nlink !== 1 || before.size === 0 || await realpath(file) !== file)
      fail("checkpoint_invalid", "Recovery requires a nonempty canonical regular file")
    const digest = createHash("sha256")
    for await (const chunk of createReadStream(file)) digest.update(chunk)
    const after = await stat(file)
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
      fail("checkpoint_changed", "Recovery file changed during verification")
    return digest.digest("hex")
  }

  function recoveryScene(snapshot) {
    const scene = clone(snapshot)
    // Reopening a file starts a new native revision epoch; only these counters may differ.
    delete scene.revision
    delete scene.fingerprint
    const visit = value => {
      if (!value || typeof value !== "object") return
      if (value.locator) delete value.locator.revision
      for (const child of Object.values(value)) visit(child)
    }
    visit(scene)
    return hash(scene)
  }

  async function recoverStopped(sessionID, plan, checkpoint, stopped, transaction) {
    const verified = await checkpoints.verify(checkpoint.id)
    if (!await checkpointMatches(verified, plan.binding) || verified.hash !== checkpoint.hash)
      fail("checkpoint_invalid", "Preplan checkpoint changed")
    const canonicalPath = verified.projectPath
    // The mandatory preplan save left canonical bytes equal to the checkpoint.
    // Reopening those bytes avoids all canonical overwrite races.
    if (await fileHash(canonicalPath) !== verified.hash) fail("checkpoint_changed", "Canonical file changed since preplan save")
    const emergencyPath = path.join(bridge.dataDir, "workflow-emergency-" + randomUUID() + path.extname(canonicalPath))
    await revision(sessionID, { binding: plan.binding, fingerprint: hash(stopped.snapshot) }, true)
    const saved = bounded(await bridge.call(sessionID, "execute", {
      phase: "recovery_prepare", transaction, recoveryId: stopped.id, expected: stopped.snapshot, path: emergencyPath,
    }, { allowLocked: true }))
    const recoveryBinding = current(sessionID, null, { allowLocked: true })
    if (recoveryBinding.id !== plan.binding.id || saved.status !== "recovery_saved" ||
        saved.project.path !== emergencyPath || !sameProject(saved.project, recoveryBinding.project))
      fail("invalid_host_result", "Emergency save identity was not confirmed")
    const emergency = await checkpoints.create({ projectPath: emergencyPath, projectId: saved.project.id,
      planHash: plan.payloadHash, pinned: true })
    const currentCheckpoint = await checkpoints.verify(emergency.id)
    if (!currentCheckpoint.verified || currentCheckpoint.projectPath !== emergencyPath ||
        currentCheckpoint.projectId !== saved.project.id || await fileHash(emergencyPath) !== currentCheckpoint.hash)
      fail("checkpoint_invalid", "Emergency current-state checkpoint did not verify")
    await bridge.recordOutcome(sessionID, { outcome: "prepared", planHash: plan.payloadHash,
      checkpointId: checkpoint.id, currentCheckpointId: currentCheckpoint.id })
    if (await fileHash(canonicalPath) !== verified.hash) fail("checkpoint_changed", "Canonical file changed during recovery")
    await revision(sessionID, { binding: recoveryBinding, fingerprint: hash(saved.snapshot) }, true)
    const restored = bounded(await bridge.call(sessionID, "execute", {
      phase: "recovery_finish", transaction, recoveryId: stopped.id, expected: saved.snapshot,
      verifiedCheckpoint: { id: currentCheckpoint.id, hash: currentCheckpoint.hash,
        size: currentCheckpoint.size || (await stat(currentCheckpoint.path)).size },
    }, { allowLocked: true }))
    if (restored.status !== "recovered" || !sameProject(restored.project, plan.binding.project))
      fail("invalid_host_result", "Canonical recovery was not confirmed")
    const result = await snapshot(sessionID, plan.binding, true)
    if (hash(restored.snapshot) !== result.fingerprint || recoveryScene(result.data) !== plan.recoveryScene ||
        await fileHash(canonicalPath) !== verified.hash)
      fail("invalid_host_result", "Recovered state changed before verification")
    await bridge.recordOutcome(sessionID, { outcome: "confirmed", planHash: plan.payloadHash,
      checkpointId: checkpoint.id, currentCheckpointId: currentCheckpoint.id, expectedFingerprint: result.fingerprint })
    await bridge.unlock(sessionID)
    return { rolledBack: true, checkpointId: checkpoint.id, currentCheckpointId: currentCheckpoint.id,
      emergencyPath, fingerprint: result.fingerprint, canonicalReplaced: false }
  }

  const workflow = {
    async inspectRestore(sessionID) {
      const inspected = await restoreSnapshot(sessionID)
      return { ...inspected.data, fingerprint: inspected.fingerprint, binding: inspected.binding }
    },
    async inspectQuery(sessionID, query = {}) {
      query = inspectArgs(query)
      return exclusive(sessionID, async () => {
        const inspected = await snapshot(sessionID, null, true, query)
        return { ...inspected.data, binding: inspected.binding, expectedRevision: inspected.fingerprint }
      })
    },
    async executeScript(sessionID, input, ask) {
      const payload = bounded(input)
      assertObject(payload)
      if (Object.keys(payload).some(key => !["source", "expectedRevision", "label"].includes(key)))
        fail("invalid_payload", "Script execution accepts only source, expectedRevision and label")
      assertString(payload.source, "source", 262144)
      assertString(payload.label, "label", 128)
      if (/\u0000/.test(payload.source) || /[\u0000-\u001f]/.test(payload.label) ||
          typeof payload.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(payload.expectedRevision))
        fail("invalid_payload", "Invalid script source, label or expectedRevision token")
      return exclusive(sessionID, async () => {
        const b = current(sessionID, null, { write: true })
        if (queryRevisions.get(sessionID)?.token !== payload.expectedRevision)
          fail("stale_revision", "Use expectedRevision from a current inspectQuery result")
        const initial = await snapshot(sessionID, b, false, {})
        if (initial.fingerprint !== payload.expectedRevision) fail("stale_revision", "Project changed since inspection")
        if (!initial.data.project.saved || !initial.data.project.path)
          fail("unsaved_project", "Save the project before executing scripts")
        const expiresAt = now() + PROPOSAL_TTL
        const planHash = hash({ payload, bindingID: b.id })
        await permit(ask, `Run UNSANDBOXED ExtendScript body: ${payload.label}\nProject: ${b.project.path}\nFile, network, process, preference and other external effects cannot be rolled back. Partial project changes may remain on failure. A verified checkpoint will be retained; no automatic rollback or retry.\nExact source:\n${payload.source}`, {
          kind: "script", ...payload, hash: planHash, binding: b, nonTransactional: true,
        })
        alive({ expiresAt })
        current(sessionID, b, { write: true })
        await revision(sessionID, initial)
        await bridge.lock(sessionID, { kind: "script", proof: SCRIPT_PROOF, planHash, nonTransactional: true })
        let checkpoint = null, dispatched = false
        try {
          checkpoint = await saveCheckpoint(sessionID, initial, planHash)
          await bridge.recordOutcome(sessionID, { outcome: "prepared", planHash, checkpointId: checkpoint.id })
          alive({ expiresAt })
          await revision(sessionID, initial, true)
          current(sessionID, b, { write: true, allowLocked: true })
          await bridge.recordOutcome(sessionID, { outcome: "dispatched", planHash, checkpointId: checkpoint.id })
          dispatched = true
          const result = bounded(await bridge.call(sessionID, "raw", {
            source: payload.source, label: payload.label, expectedRevision: initial.data.revision,
            expectedEpoch: initial.data.projectEpoch,
            expectedProject: { id: b.project.id, path: b.project.path },
          }, { allowLocked: true }))
          if (!result || typeof result !== "object" || Array.isArray(result) || !Object.hasOwn(result, "value") ||
              !Number.isSafeInteger(result.revision) || result.revision < initial.data.revision ||
              !result.project || !sameProject(result.project, b.project))
            fail("invalid_host_result", "Script must return a JSON value, native revision and matching project")
          const after = await snapshot(sessionID, b, true, {})
          if (after.data.revision !== result.revision || after.data.projectEpoch !== initial.data.projectEpoch)
            fail("stale_revision", "Project changed after script execution")
          await bridge.recordOutcome(sessionID, { outcome: "confirmed", planHash,
            checkpointId: checkpoint.id, expectedFingerprint: overviewProof(after) })
          const overview = { ...after.data, binding: { ...current(sessionID, b, { allowLocked: true }), lock: null },
            expectedRevision: after.fingerprint }
          await bridge.unlock(sessionID)
          return { result: result.value, checkpointId: checkpoint.id, expectedRevision: after.fingerprint, overview }
        } catch (error) {
          if (dispatched || uncertain(error)) {
            await bridge.markUncertain(sessionID, "Script outcome was not confirmed; retain checkpoint and partial changes").catch(() => {})
            throw new AEError("outcome_uncertain", "Partial project changes and external effects may remain. No retry or automatic rollback; reconcile the locked target.", {
              cause: error.code || "execution_failed", checkpointId: checkpoint?.id || error.details?.checkpointId || null, rolledBack: false,
              hostMessage: error.message,
              warning: "Partial changes may remain; the checkpoint does not undo external effects.",
            })
          }
          await bridge.unlock(sessionID)
          throw new AEError(error.code || "execution_failed", error.message, {
            ...error.details, checkpointId: checkpoint?.id || error.details?.checkpointId || null, rolledBack: false,
          })
        }
      })
    },
    async inspect(sessionID) {
      const inspected = await snapshot(sessionID, null, true)
      return { ...inspected.data, fingerprint: inspected.fingerprint, binding: inspected.binding }
    },
    async propose(sessionID, actions) {
      actions = actionList(actions)
      return exclusive(sessionID, async () => {
        const b = current(sessionID, null, { write: true })
        const initial = await snapshot(sessionID, b)
        const authorized = await authorize(sessionID, b, actionList(actions))
        current(sessionID, b, { write: true })
        const preflight = bounded(await bridge.call(sessionID, "preflight", { actions: authorized }))
        current(sessionID, b, { write: true })
        assertObject(preflight)
        const payload = actionList(preflight.actions)
        if (!Array.isArray(preflight.warnings) || !Array.isArray(preflight.affected) ||
            !Number.isFinite(preflight.estimatedMs) || preflight.estimatedMs < 0)
          fail("invalid_host_result", "Preflight must return warnings, affected objects, and an estimate")
        if (hash(await authorize(sessionID, b, payload)) !== hash(payload))
          fail("invalid_host_result", "Preflight returned noncanonical import paths")
        await revision(sessionID, { binding: b, fingerprint: initial.fingerprint })
        const pinnedProperties = payload.some(action => action.locator)
        const warnings = [...preflight.warnings]
        if (payload.some(action => /effect/i.test(action.type)))
          warnings.push("Effects may trigger licensing dialogs, caches, downloads, or network activity that project rollback cannot undo.")
        if (preflight.estimatedMs > longPlanMs)
          warnings.push("Long plan: execution uses bounded, snapshot-checked chunks with host identity proofs.")
        const plan = {
          kind: "structured", token: randomBytes(32).toString("base64url"), binding: b,
          fingerprint: initial.fingerprint, payload, payloadHash: hash(payload), expiresAt: now() + PROPOSAL_TTL,
          warnings, affected: preflight.affected, estimatedMs: preflight.estimatedMs, pinnedProperties,
          recoveryScene: recoveryScene(initial.data),
        }
        proposals.set(sessionID, plan)
        return clone({ token: plan.token, actions: payload, hash: plan.payloadHash, fingerprint: plan.fingerprint,
          expiresAt: plan.expiresAt, binding: b, warnings, affected: plan.affected, estimatedMs: plan.estimatedMs })
      })
    },
    async execute(sessionID, token, ask) {
      const plan = consume(sessionID, token, "structured")
      return exclusive(sessionID, async () => {
        current(sessionID, plan.binding, { write: true })
        await revision(sessionID, plan)
        await permit(ask, `Execute ${plan.payload.length} AE action(s) on ${plan.binding.project.path}:\n${JSON.stringify(plan.payload, null, 2)}\nWarnings: ${plan.warnings.join("; ")}\\nOn an acknowledged stopped failure, recover the whole preplan scene only after verifying an emergency copy of the partial state. Unknown outcomes or interleaved edits retain the lock without retry.`, {
          kind: "structured", hash: plan.payloadHash, actions: plan.payload, binding: plan.binding,
          warnings: plan.warnings, affected: plan.affected, estimatedMs: plan.estimatedMs,
        })
        alive(plan)
        current(sessionID, plan.binding, { write: true })
        await revision(sessionID, plan)
        if (hash(await authorize(sessionID, plan.binding, plan.payload)) !== plan.payloadHash)
          fail("grant_changed", "Import authorization or canonical path changed")
        current(sessionID, plan.binding, { write: true })
        await bridge.lock(sessionID, { kind: "structured", planHash: plan.payloadHash })
        let checkpoint = null
        let mutated = false
        let actionIndex = null, stopped = null
        const transaction = { id: randomUUID(), sessionID, bindingID: plan.binding.id }
        try {
          checkpoint = await saveCheckpoint(sessionID, await revision(sessionID, plan, true), plan.payloadHash)
          await bridge.recordOutcome(sessionID, { outcome: "prepared", planHash: plan.payloadHash, checkpointId: checkpoint.id })
          let expected = plan.fingerprint
          const results = []
          const refs = new Map()
          const chunks = []
          const chunkSize = plan.pinnedProperties ? 64 : 1
          for (let i = 0; i < plan.payload.length; i += chunkSize) chunks.push(plan.payload.slice(i, i + chunkSize))
          if (plan.pinnedProperties) {
            const checked = bounded(await bridge.call(sessionID, "preflight", { actions: plan.payload }, { allowLocked: true }))
            if (hash(checked.actions) !== plan.payloadHash) fail("stale_plan", "Preflight changed approved actions")
            await revision(sessionID, plan, true)
            const begun = await bridge.call(sessionID, "execute", { phase: "begin", transaction, actions: plan.payload }, { allowLocked: true })
            if (begun?.status !== "prepared" || begun.offset !== 0) fail("invalid_host_result", "Host transaction was not prepared")
          }
          for (let i = 0; i < chunks.length; i++) {
            actionIndex = i * chunkSize
            const chunk = await authorize(sessionID, plan.binding, chunks[i])
            if (hash(chunk) !== hash(chunks[i])) fail("grant_changed", "Import authorization changed")
            for (const [key, value] of Object.entries(plan.pinnedProperties ? {} : chunk[0])) {
              if (value && typeof value === "object" && Object.hasOwn(value, "$ref")) {
                if (Object.keys(value).length !== 1 || !refs.has(value.$ref))
                  fail("invalid_reference", "Creation reference is unresolved")
                chunk[0][key] = refs.get(value.$ref)
              }
            }
            const before = await snapshot(sessionID, plan.binding, true)
            if (before.fingerprint !== expected) fail("stale_fingerprint", "Project changed between execution chunks")
            if (!plan.pinnedProperties) {
              const checked = bounded(await bridge.call(sessionID, "preflight", { actions: chunk }, { allowLocked: true }))
              if (hash(checked.actions) !== hash(chunk)) fail("stale_plan", "Chunk preflight changed the approved payload")
            }
            await revision(sessionID, { binding: plan.binding, fingerprint: before.fingerprint }, true)
            current(sessionID, plan.binding, { write: true, allowLocked: true })
            if (!mutated) alive(plan)
            await bridge.recordOutcome(sessionID, { outcome: "dispatched", planHash: plan.payloadHash, checkpointId: checkpoint.id })
            mutated = true
            const executed = bounded(await bridge.call(sessionID, "execute", plan.pinnedProperties
              ? { phase: "chunk", transaction, offset: actionIndex, count: chunk.length, expected: before.data }
              : { actions: chunk }, { allowLocked: true }))
            if (executed.status === "stopped") {
              stopped = executed.recovery
              actionIndex = plan.pinnedProperties ? executed.failure.actionIndex : actionIndex + executed.failure.actionIndex
              throw new AEError("action_failed", executed.failure.message, { cause: executed.failure.code })
            }
            if (plan.pinnedProperties && (executed.offset !== actionIndex + chunk.length ||
                executed.status !== (i === chunks.length - 1 ? "complete" : "chunk") || !executed.snapshot))
              fail("invalid_host_result", "Host transaction progress is invalid")
            if (!Array.isArray(executed.results) || executed.results.length !== chunk.length)
              fail("invalid_host_result", "Execute must return one result per action")
            if (!plan.pinnedProperties && chunk[0].ref) {
              const id = executed.results[0]?.id
              if (!Number.isSafeInteger(id) || id < 1) fail("invalid_host_result", "Creation must return a persistent ID")
              refs.set(chunk[0].ref, id)
            }
            results.push(...executed.results)
            const after = await snapshot(sessionID, plan.binding, true)
            if (executed.snapshot && hash(executed.snapshot) !== after.fingerprint)
              fail("stale_fingerprint", "Project changed after host execution")
            expected = after.fingerprint
          }
          current(sessionID, plan.binding, { allowLocked: true })
          await bridge.recordOutcome(sessionID, { outcome: "confirmed", planHash: plan.payloadHash,
            checkpointId: checkpoint.id, expectedFingerprint: expected })
          await bridge.unlock(sessionID)
          // Cleanup failure must never roll back an already completed transaction.
          const cleanup = await checkpoints.pin(checkpoint.id, false).then(() => null, () => "Checkpoint remains pinned; cleanup failed")
          return { results, checkpointId: checkpoint.id, hash: plan.payloadHash, fingerprint: expected, cleanup }
        } catch (error) {
          if (uncertain(error)) throw new AEError("outcome_uncertain", "Outcome uncertain; no retry or automatic rollback. Reconcile the locked target.", {
            cause: error.code, checkpointId: checkpoint?.id || null, actionIndex,
          })
          if (mutated && checkpoint && stopped) {
            let recovered
            try {
              recovered = await recoverStopped(sessionID, plan, checkpoint, stopped, transaction)
            } catch (rollback) {
              await bridge.markUncertain(sessionID, "Stopped failure recovery was not confirmed").catch(() => {})
              throw new AEError("rollback_failed", "Target remains locked; current edits and recovery files are retained", {
                cause: error.code, rollback: rollback.code || rollback.message,
                checkpointId: checkpoint.id, actionIndex, rolledBack: false,
              })
            }
            throw new AEError("action_failed", error.message, { ...error.details, ...recovered, actionIndex })
          }
          if (mutated) {
            await bridge.markUncertain(sessionID, "Execution failed without matching stopped evidence")
            throw new AEError("outcome_uncertain", "No acknowledged stopped snapshot; no retry or rollback", {
              cause: error.code, checkpointId: checkpoint?.id || null, actionIndex, rolledBack: false,
            })
          }
          await bridge.unlock(sessionID)
          if (checkpoint) await checkpoints.pin(checkpoint.id, false)
          throw new AEError(error.code || "execution_failed", error.message, {
            ...error.details, rolledBack: false, checkpointId: checkpoint?.id || null, actionIndex,
          })
        }
      })
    },
    async enableRaw(sessionID, ask) {
      return exclusive(sessionID, async () => {
        const b = current(sessionID, null, { write: true })
        const initial = await snapshot(sessionID, b)
        await permit(ask, "Enable raw ExtendScript for this binding for five minutes. Raw execution is non-transactional; file, preference, network, and process side effects cannot be rolled back.", {
          kind: "raw_enable", binding: b, nonTransactional: true,
        })
        current(sessionID, b, { write: true })
        await revision(sessionID, { binding: b, fingerprint: initial.fingerprint })
        const gate = { binding: b, expiresAt: now() + PROPOSAL_TTL }
        rawGates.set(sessionID, gate)
        return clone({ enabled: true, expiresAt: gate.expiresAt, binding: b, nonTransactional: true })
      })
    },
    async proposeRaw(sessionID, input) {
      input = bounded(input)
      return exclusive(sessionID, async () => {
        const gate = rawGates.get(sessionID)
        if (!gate || gate.expiresAt <= now()) fail("raw_disabled", "Explicitly enable raw scripting for this session first")
        const b = current(sessionID, gate.binding, { write: true })
        const payload = bounded(input)
        assertObject(payload)
        if (Object.keys(payload).some(key => !["source", "purpose", "risks"].includes(key)))
          fail("invalid_payload", "Raw proposal accepts only source, purpose, and risks")
        assertString(payload.source, "source", 512 * 1024)
        assertString(payload.purpose, "purpose", 8192)
        if (!Array.isArray(payload.risks) || !payload.risks.length) fail("invalid_payload", "List raw script risks explicitly")
        for (const risk of payload.risks) assertString(risk, "risk", 8192)
        const inspected = await snapshot(sessionID, b)
        if (gate.expiresAt <= now() || rawGates.get(sessionID) !== gate) fail("raw_disabled", "Raw enablement expired")
        const expiresAt = Math.min(gate.expiresAt, now() + PROPOSAL_TTL)
        const payloadHash = hash(payload)
        const token = hash({ payload, bindingId: b.id, sessionID, fingerprint: inspected.fingerprint,
          expiresAt, nonce: randomBytes(16).toString("hex") })
        const plan = { kind: "raw", token, payloadHash, payload, binding: b, fingerprint: inspected.fingerprint, expiresAt }
        proposals.set(sessionID, plan)
        return clone({ ...payload, hash: token, payloadHash, binding: b, fingerprint: plan.fingerprint, expiresAt, nonTransactional: true })
      })
    },
    async executeRaw(sessionID, token, ask) {
      const plan = consume(sessionID, token, "raw")
      return exclusive(sessionID, async () => {
        const gate = rawGates.get(sessionID)
        if (!gate || gate.expiresAt <= now()) fail("raw_disabled", "Raw enablement expired")
        current(sessionID, plan.binding, { write: true })
        await revision(sessionID, plan)
        await permit(ask, `Run NON-TRANSACTIONAL raw ExtendScript:\nPurpose: ${plan.payload.purpose}\nRisks: ${plan.payload.risks.join("; ")}\nFull source:\n${plan.payload.source}`, {
          kind: "raw", hash: token, ...plan.payload, binding: plan.binding, nonTransactional: true,
        })
        alive(plan)
        if (rawGates.get(sessionID) !== gate || gate.expiresAt <= now()) fail("raw_disabled", "Raw gate changed or expired")
        current(sessionID, plan.binding, { write: true })
        await revision(sessionID, plan)
        await bridge.lock(sessionID, { kind: "raw", hash: token, nonTransactional: true })
        let returned = false
        try {
          await revision(sessionID, plan, true)
          alive(plan)
          const response = await bridge.call(sessionID, "raw", { source: plan.payload.source }, { allowLocked: true })
          returned = true
          const result = bounded(response)
          assertObject(result)
          current(sessionID, plan.binding, { allowLocked: true })
          await bridge.unlock(sessionID)
          return { ...result, hash: token, nonTransactional: true }
        } catch (error) {
          if (returned) {
            await bridge.markUncertain(sessionID, "Raw execution completed but result validation failed").catch(() => {})
            throw new AEError("outcome_uncertain", "Post-execution raw failure; no retry", { cause: error.code })
          }
          if (!uncertain(error)) {
            current(sessionID, plan.binding, { allowLocked: true })
            await bridge.unlock(sessionID)
          }
          throw error
        }
      })
    },
    // Adapter contract: ask(summary, metadata) must explicitly review the immutable
    // inspected snapshot when no durable confirmed outcome matches. Compact receipts
    // require review of the actual project, not scene-equivalence inference. Never auto-approve.
    async reconcile(sessionID, ask) {
      return exclusive(sessionID, async () => {
        const b = current(sessionID, null, { allowLocked: true })
        const script = b.lock?.reason?.kind === "script" && b.lock.reason.proof === SCRIPT_PROOF
        const compact = b.lock?.reason?.kind === "restore" && b.lock.reason.proof === RESTORE_PROOF
        if (script && (b.lock.connectionId !== b.connectionId || !sameProject(b.lock.project, b.project) ||
            b.lock.restore || b.lock.recoveryOriginal))
          fail("recovery_target_mismatch", "Script recovery requires its original connection and project")
        const inspected = compact ? await restoreSnapshot(sessionID, b)
          : await snapshot(sessionID, b, true, script ? {} : undefined)
        const fingerprint = script ? overviewProof(inspected) : inspected.fingerprint
        const evidence = b.lock?.evidence
        // A bounded overview is not a complete scene/external-effects proof, even after confirmation.
        const proven = !script && !compact && evidence?.outcome === "confirmed" && evidence.expectedFingerprint === fingerprint
        const expiresAt = now() + PROPOSAL_TTL
        if (b.lock && !proven) {
          const scope = compact
            ? "Compact native guards only, NOT full scene proof. Review the actual AE project and retained recovery files, including external effects, before explicitly confirming."
            : script
            ? "Bounded overview only: properties and later pages are omitted. Review the actual AE project and external effects before confirming."
            : "Full inspected snapshot."
          await permit(ask, `Review reconciliation for ${b.project.path}.\n${scope}\nSnapshot SHA-256: ${fingerprint}\n${JSON.stringify(inspected.data, null, 2)}\nConfirm this is the intended recovered state, including external/raw effects. No command will be retried.`, {
            kind: "reconcile", binding: b, fingerprint, snapshot: inspected.data, evidence: evidence || null,
            ...(compact ? { protocol: RESTORE_PROOF, actualProjectReviewRequired: true } : {}),
          })
        }
        alive({ expiresAt })
        if (compact) await restoreRevision(sessionID, b, fingerprint)
        else if (script) {
          if (overviewProof(await snapshot(sessionID, b, true, {})) !== fingerprint)
            fail("stale_revision", "Project or reviewed overview changed during reconciliation")
        } else await revision(sessionID, inspected, true)
        alive({ expiresAt })
        const latest = current(sessionID, b, { allowLocked: true })
        if (hash(latest.lock) !== hash(b.lock)) fail("stale_binding", "Recovery lock changed during review")
        await bridge.unlock(sessionID, compact ? {
          restoreReview: fingerprint,
          authorizeRestoreReview: () => { alive({ expiresAt }); return true },
        } : undefined)
        return { ...inspected.data, fingerprint, reconciled: true,
          proof: proven ? "confirmed_outcome" : "explicit_review", previousLock: b.lock,
          warning: "No command was retried. Inspection does not undo external or raw-script side effects." }
      })
    },
    async restore(sessionID, checkpointId, ask) {
      return exclusive(sessionID, async () => {
        assertString(checkpointId, "checkpointId", 256)
        const b = current(sessionID, null, { write: true })
        // The parent bridge must validate both phases and durably follow their project transitions.
        if (bridge.canonicalRestore !== true) fail("restore_unavailable", "Canonical restore requires the bridge's guarded manual recovery phases")
        const initial = await restoreSnapshot(sessionID, b)
        const checkpoint = await checkpoints.verify(checkpointId)
        if (checkpoint.id !== checkpointId || !await checkpointMatches(checkpoint, b))
          fail("checkpoint_invalid", "Checkpoint is unverified or belongs to another project")
        const destination = await lstat(b.project.path)
        const destinationHash = await fileHash(b.project.path)
        const sourceTimestamp = Date.parse(checkpoint.createdAt)
        if (!Number.isFinite(sourceTimestamp)) fail("checkpoint_invalid", "Checkpoint timestamp is invalid")
        const expiresAt = now() + PROPOSAL_TTL
        const identity = checkpointIdentity(checkpoint)
        let restoreLock = null
        const checkApproval = async (binding, expected, verifyCheckpoint = true) => {
          alive({ expiresAt })
          current(sessionID, binding, { write: true, allowLocked: true })
          await restoreRevision(sessionID, binding, expected)
          if (verifyCheckpoint && checkpointIdentity(await checkpoints.verify(checkpointId)) !== identity)
            fail("checkpoint_changed", "Approved checkpoint identity or timestamp changed")
          alive({ expiresAt })
          const latest = current(sessionID, binding, { write: true, allowLocked: true })
          if (restoreLock && (latest.lock?.state !== "executing" || latest.lock.id !== restoreLock.id ||
              hash(latest.lock.reason) !== hash(restoreLock.reason)))
            fail("outcome_uncertain", "Restore lock changed; preserve recovery files without opening or retrying")
        }
        current(sessionID, b, { write: true })
        await permit(ask, `Restore checkpoint ${checkpointId}.
Source: ${checkpoint.createdAt}
Destination file: ${destination.mtime.toISOString()} (${b.project.path})
Preserve the existing disk file first, save current edits in place, and verify a private emergency copy and protected checkpoint. Then restore the original path and close/reopen through compact native guards. Any revision change during saving stops restoration before publication or close and keeps automation locked. If canonical publication fails, the canonical file contains your saved current work; open a verified recovery copy and keep automation locked. Never retry an uncertain host call.`, {
          kind: "restore", checkpoint, binding: b, sourceTimestamp, destinationTimestamp: destination.mtimeMs,
          destinationIdentity: hash({ path: b.project.path, hash: destinationHash,
            ...Object.fromEntries(["dev", "ino", "size", "mtimeMs", "ctimeMs"].map(key => [key, destination[key]])) }),
          fingerprint: initial.fingerprint, protocol: RESTORE_PROOF, receipt: initial.data, recoveryCopy: false,
        })
        await checkApproval(b, initial.fingerprint)
        const unchanged = await lstat(b.project.path)
        if (["dev", "ino", "size", "mtimeMs", "ctimeMs"].some(key => unchanged[key] !== destination[key]) ||
            await fileHash(b.project.path) !== destinationHash)
          fail("stale_project", "Destination file changed during restore approval")
        const transaction = { id: randomUUID(), sessionID, bindingID: b.id }
        const emergencyPath = path.join(bridge.dataDir, "workflow-emergency-" + randomUUID() + path.extname(checkpoint.projectPath))
        const planHash = hash({ identity, fingerprint: initial.fingerprint, destinationHash, expiresAt })
        await bridge.lock(sessionID, { kind: "restore", proof: RESTORE_PROOF, checkpointId, planHash, fingerprint: initial.fingerprint })
        restoreLock = current(sessionID, b, { allowLocked: true }).lock
        if (!restoreLock || restoreLock.state !== "executing")
          fail("outcome_uncertain", "Restore lock was not confirmed")
        let currentCheckpoint, previousCheckpoint, restored
        try {
          await checkpoints.protect(checkpointId, transaction.id)
          await checkApproval(b, initial.fingerprint)
          // In-place saving must never destroy the prior on-disk version.
          const previous = await checkpoints.create({ projectPath: b.project.path, projectId: b.project.id, planHash, pinned: true })
          previousCheckpoint = await checkpoints.verify(previous.id)
          if (!await checkpointMatches(previousCheckpoint, b) || previousCheckpoint.hash !== destinationHash)
            fail("stale_project", "Destination changed before saving current work")
          await checkpoints.protect(previousCheckpoint.id, transaction.id)
          await checkApproval(b, initial.fingerprint)
          const beforeSave = await lstat(b.project.path)
          if (["dev", "ino", "size", "mtimeMs", "ctimeMs"].some(key => beforeSave[key] !== destination[key]) ||
              await fileHash(b.project.path) !== destinationHash)
            fail("stale_project", "Destination changed before saving current work")
          const saved = bounded(await bridge.call(sessionID, "execute", {
            phase: "restore_prepare", transaction, recoveryId: transaction.id, expected: initial.data, path: emergencyPath,
          }, { allowLocked: true, timeoutMs: 120000 }))
          const recoveryBinding = current(sessionID, null, { write: true, allowLocked: true })
          if (recoveryBinding.id !== b.id || recoveryBinding.connectionId !== b.connectionId ||
              saved.status !== "recovery_saved" || saved.project?.path !== b.project.path ||
              !sameProject(saved.project, recoveryBinding.project))
            fail("invalid_host_result", "Manual recovery save identity was not confirmed")
          restoreReceipt(saved.receipt, saved.project)
          if (saved.receipt.dirty !== false || saved.receipt.projectEpoch !== initial.data.projectEpoch ||
              saved.receipt.revision !== initial.data.revision)
            fail("invalid_host_result", "Current state changed while saving")
          const savedFingerprint = restoreFingerprint(saved.receipt, b.connectionId)
          const savedDestination = await lstat(b.project.path)
          const created = await checkpoints.create({ projectPath: b.project.path, projectId: saved.project.id, planHash, pinned: true })
          currentCheckpoint = await checkpoints.verify(created.id)
          if (!await checkpointMatches(currentCheckpoint, recoveryBinding) || currentCheckpoint.planHash !== planHash ||
              await fileHash(emergencyPath) !== currentCheckpoint.hash ||
              await fileHash(b.project.path) !== currentCheckpoint.hash)
            fail("checkpoint_invalid", "Current-state backup did not verify")
          await checkpoints.protect(currentCheckpoint.id, transaction.id)
          await bridge.recordOutcome(sessionID, { outcome: "prepared", planHash, checkpointId, currentCheckpointId: currentCheckpoint.id })
          const beforeReplace = () => checkApproval(recoveryBinding, savedFingerprint)
          await beforeReplace()
          restored = await checkpoints.restore(checkpointId, {
            canonicalPath: checkpoint.projectPath, expectedCheckpoint: checkpoint,
            expectedDestination: { ...savedDestination, hash: currentCheckpoint.hash },
            beforeReplace: () => checkApproval(recoveryBinding, savedFingerprint, false),
          })
          if (restored.recoveryCopy !== true && restored.recoveryCopy !== false)
            fail("invalid_host_result", "Storage did not confirm the restore outcome")
          let openPath = restored.path
          if (restored.recoveryCopy) {
            openPath = path.join(bridge.dataDir, "workflow-recovery-" + randomUUID() + path.extname(checkpoint.projectPath))
            await copyFile(checkpoint.path, openPath, constants.COPYFILE_EXCL)
          } else if (openPath !== checkpoint.projectPath) fail("invalid_host_result", "Unexpected canonical restore path")
          // A failed freshness guard is not permission to open a fallback over newer edits.
          await beforeReplace()
          if (await fileHash(openPath) !== checkpoint.hash || await fileHash(emergencyPath) !== currentCheckpoint.hash)
            fail("checkpoint_changed", "Recovery files changed before open")
          await bridge.recordOutcome(sessionID, { outcome: "dispatched", planHash, checkpointId, currentCheckpointId: currentCheckpoint.id })
          await beforeReplace()
          const opened = bounded(await bridge.call(sessionID, "execute", {
            phase: "restore_finish", transaction, recoveryId: transaction.id, expected: saved.receipt, path: openPath,
            verifiedCheckpoint: { id: currentCheckpoint.id, hash: currentCheckpoint.hash, size: currentCheckpoint.size },
          }, { allowLocked: true, timeoutMs: 120000 }))
          const finalBinding = current(sessionID, null, { allowLocked: true })
          if (finalBinding.id !== b.id || finalBinding.connectionId !== b.connectionId || opened.status !== "recovered" ||
              opened.project?.path !== openPath || !sameProject(opened.project, finalBinding.project))
            fail("invalid_host_result", "Manual restore open identity was not confirmed")
          restoreReceipt(opened.receipt, finalBinding.project)
          if (opened.receipt.dirty !== false || opened.receipt.projectEpoch === saved.receipt.projectEpoch ||
              await fileHash(openPath) !== checkpoint.hash)
            fail("invalid_host_result", "Restored project changed before verification")
          const inspected = await restoreRevision(sessionID, finalBinding, restoreFingerprint(opened.receipt, b.connectionId))
          if (restored.recoveryCopy) {
            await bridge.recordOutcome(sessionID, { outcome: "recovery_copy", planHash, checkpointId,
              currentCheckpointId: currentCheckpoint.id, expectedFingerprint: inspected.fingerprint })
            await bridge.markUncertain(sessionID, "Recovery copy opened; original target still requires explicit recovery")
          } else {
            current(sessionID, b, { allowLocked: true })
            await bridge.recordOutcome(sessionID, { outcome: "confirmed", planHash, checkpointId,
              currentCheckpointId: currentCheckpoint.id, expectedFingerprint: inspected.fingerprint })
            await bridge.unlock(sessionID)
          }
          // Retain holds on failures/fallback; successful cleanup never rolls back the restore.
          const cleanup = restored.recoveryCopy ? null : await Promise.all([
            checkpoints.protect(checkpointId, transaction.id, false),
            checkpoints.protect(currentCheckpoint.id, transaction.id, false),
            checkpoints.protect(previousCheckpoint.id, transaction.id, false),
          ]).then(() => null, () => "Recovery checkpoints remain protected; cleanup failed")
          return { ...restored, path: openPath, canonicalPath: checkpoint.projectPath,
            checkpointId, currentCheckpointId: currentCheckpoint.id, previousCheckpointId: previousCheckpoint.id, emergencyPath,
            canonicalReplaced: !restored.recoveryCopy, rebindRequired: restored.recoveryCopy,
            automationSuspended: restored.recoveryCopy, fingerprint: inspected.fingerprint,
            protocol: RESTORE_PROOF, receipt: inspected.data, cleanup,
            warning: restored.recoveryCopy
              ? "Recovery copy opened. Original bytes are retained at the canonical path or originalPath. Do not overwrite newer edits. Review the emergency backup, Save As to the intended path, explicitly rebind and reconcile; automation remains locked."
              : "Current-state checkpoint, previous disk checkpoint and displaced originalPath are retained. Review them before explicit cleanup." }
        } catch (error) {
          await bridge.markUncertain(sessionID, "Manual restore was not confirmed; retain all recovery files").catch(() => {})
          throw new AEError(uncertain(error) ? "outcome_uncertain" : error.code || "restore_failed", error.message, {
            ...error.details, checkpointId, currentCheckpointId: currentCheckpoint?.id || null,
            previousCheckpointId: previousCheckpoint?.id || null,
            emergencyPath, originalPath: restored?.originalPath || null, canonicalReplaced: restored?.recoveryCopy === false,
          })
        }
      })
    },
  }
  return workflow
}
