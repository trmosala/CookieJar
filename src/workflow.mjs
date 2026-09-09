import { randomBytes, randomUUID, createHash } from "node:crypto"
import { realpath, copyFile, stat, unlink } from "node:fs/promises"
import { constants, createReadStream } from "node:fs"
import path from "node:path"
import { AEError, fail, hash, canonical, assertObject, assertString, PROPOSAL_TTL } from "./protocol.mjs"

const clone = value => JSON.parse(canonical(value))
const uncertain = error => ["outcome_uncertain", "uncertain_outcome", "timeout", "disconnected", "binding_suspended", "stale_binding", "not_bound", "storage_failed", "invalid_host_result"].includes(error.code)
const sameProject = (a, b) => a.id === b.id && a.path === b.path
const MAX_BYTES = 3 * 1024 * 1024

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

export function createWorkflow({ bridge, checkpoints, grants, now = Date.now, longPlanMs = 30000 }) {
  const proposals = new Map()
  const rawGates = new Map()
  const running = new Set()
  bridge.onRelease(async (sessionID, bindingID) => {
    proposals.delete(sessionID)
    rawGates.delete(sessionID)
    await grants.release(sessionID, bindingID)
  })

  function current(sessionID, expected, options = {}) {
    const b = bridge.binding(sessionID, options)
    if (expected && (b.id !== expected.id || b.connectionId !== expected.connectionId ||
        !sameProject(b.project, expected.project)))
      fail("stale_binding", "Session binding or project changed; propose again")
    return b
  }
  async function snapshot(sessionID, expected, allowLocked = false) {
    const b = current(sessionID, expected, { allowLocked })
    const data = bounded(await bridge.call(sessionID, "inspect", {}, { allowLocked }))
    current(sessionID, b, { allowLocked })
    assertObject(data)
    if (!data.project || !sameProject(data.project, b.project)) fail("stale_project", "Host project identity no longer matches binding")
    if (typeof data.project.saved !== "boolean" || !Array.isArray(data.items) ||
        !Array.isArray(data.selection) || !Array.isArray(data.installedEffects) ||
        !(data.activeCompId === null || Number.isSafeInteger(data.activeCompId)) ||
        typeof data.capabilities?.fileNetwork !== "boolean" || typeof data.busy !== "boolean")
      fail("invalid_host_result", "Inspection must include complete project, items, selection, effects, capabilities, and busy state")
    if (data.busy) fail("host_busy", "AE reports an active operation")
    return { data, fingerprint: hash(data), binding: b }
  }
  async function revision(sessionID, plan, allowLocked = false) {
    const inspected = await snapshot(sessionID, plan.binding, allowLocked)
    if (inspected.fingerprint !== plan.fingerprint) fail("stale_fingerprint", "Project changed since this proposal was inspected")
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
    await revision(sessionID, { binding: b, fingerprint: inspected.fingerprint }, true)
    const saved = await bridge.call(sessionID, "save", {}, { allowLocked: true })
    if (!saved?.project?.saved || !sameProject(saved.project, b.project))
      fail("stale_project", "Save changed project identity or did not save the project")
    // Current host omits dirty/save timestamps. Do not normalize revision or content:
    // revision also guards opaque/mixed-style state that cannot be compared directly.
    await revision(sessionID, { binding: b, fingerprint: inspected.fingerprint }, true)
    const checkpoint = await checkpoints.create({
      projectPath: b.project.path, projectId: b.project.id, planHash, pinned: true,
    })
    const verified = await checkpoints.verify(checkpoint.id)
    if (!await checkpointMatches(verified, b) || verified.planHash !== planHash)
      fail("checkpoint_invalid", "Checkpoint verification or plan identity failed")
    await revision(sessionID, { binding: b, fingerprint: inspected.fingerprint }, true)
    return verified
  }

  async function restoreCheckpoint(sessionID, b, checkpoint, expected) {
    const verified = await checkpoints.verify(checkpoint.id)
    if (!await checkpointMatches(verified, b) || verified.hash !== checkpoint.hash)
      fail("checkpoint_invalid", "Checkpoint changed or belongs to another project")
    // ponytail: host exposes no atomic close/replace/open transaction. Open a verified
    // private copy instead; never replace canonical bytes behind a dirty or unknown host.
    const recoveryPath = path.join(bridge.dataDir, "workflow-recovery-" + randomUUID() +
      (path.extname(verified.path).toLowerCase() === ".aepx" ? ".aepx" : ".aep"))
    let created = false, dispatched = false
    try {
      await copyFile(verified.path, recoveryPath, constants.COPYFILE_EXCL)
      created = true
      const digest = createHash("sha256")
      for await (const chunk of createReadStream(recoveryPath)) digest.update(chunk)
      if (digest.digest("hex") !== verified.hash) fail("checkpoint_invalid", "Recovery copy bytes did not verify")
      await revision(sessionID, { binding: b, fingerprint: expected }, true)
      current(sessionID, b, { write: true, allowLocked: true })
      dispatched = true
      const opened = await bridge.call(sessionID, "open", { path: recoveryPath }, { allowLocked: true })
      if (!opened?.project?.path || await realpath(opened.project.path) !== await realpath(recoveryPath))
        fail("restore_failed", "AE did not confirm opening the verified recovery copy")
      return { checkpointId: checkpoint.id, path: recoveryPath, canonicalPath: b.project.path,
        recoveryCopy: true, rebindRequired: true, canonicalReplaced: false,
        warning: "Recovery copy opened; original file was not replaced. Save As to the intended canonical path, then explicitly rebind and review reconciliation. The original target remains locked." }
    } finally {
      // A timed-out open may still complete. Never delete a potentially live project.
      if (created && !dispatched) await unlink(recoveryPath)
    }
  }

  async function fileHash(file) {
    const before = await stat(file)
    if (!before.isFile() || before.size === 0 || await realpath(file) !== file)
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
    // inspected snapshot when no durable confirmed outcome matches. Never auto-approve.
    async reconcile(sessionID, ask) {
      return exclusive(sessionID, async () => {
        const b = current(sessionID, null, { allowLocked: true })
        const inspected = await snapshot(sessionID, b, true)
        const evidence = b.lock?.evidence
        const proven = evidence?.outcome === "confirmed" && evidence.expectedFingerprint === inspected.fingerprint
        if (b.lock && !proven) {
          await permit(ask, `Review reconciliation for ${b.project.path}.\nSnapshot SHA-256: ${inspected.fingerprint}\n${JSON.stringify(inspected.data, null, 2)}\nConfirm this is the intended recovered state, including external/raw effects. No command will be retried.`, {
            kind: "reconcile", binding: b, fingerprint: inspected.fingerprint, snapshot: inspected.data, evidence: evidence || null,
          })
        }
        await revision(sessionID, { binding: b, fingerprint: inspected.fingerprint }, true)
        const latest = current(sessionID, b, { allowLocked: true })
        if (hash(latest.lock) !== hash(b.lock)) fail("stale_binding", "Recovery lock changed during review")
        await bridge.unlock(sessionID)
        return { ...inspected.data, fingerprint: inspected.fingerprint, reconciled: true,
          proof: proven ? "confirmed_outcome" : "explicit_review", previousLock: b.lock,
          warning: "No command was retried. Inspection does not undo external or raw-script side effects." }
      })
    },
    async restore(sessionID, checkpointId, ask) {
      return exclusive(sessionID, async () => {
        assertString(checkpointId, "checkpointId", 256)
        const b = current(sessionID, null, { write: true })
        const initial = await snapshot(sessionID, b)
        const checkpoint = await checkpoints.verify(checkpointId)
        if (!await checkpointMatches(checkpoint, b))
          fail("checkpoint_invalid", "Checkpoint is unverified or belongs to another project")
        const destination = await stat(b.project.path)
        const sourceTimestamp = Date.parse(checkpoint.createdAt)
        if (!Number.isFinite(sourceTimestamp)) fail("checkpoint_invalid", "Checkpoint timestamp is invalid")
        current(sessionID, b, { write: true })
        await permit(ask, `Restore checkpoint ${checkpointId}.\nSource: ${checkpoint.createdAt}\nDestination file: ${destination.mtime.toISOString()} (${b.project.path})\nFirst save and verify a checkpoint of the current state, including unsaved edits. Then open a verified recovery copy through AE's dirty-state guard. The canonical file is NOT replaced; Save As and reviewed reconciliation are required.`, {
          kind: "restore", checkpoint, binding: b, sourceTimestamp, destinationTimestamp: destination.mtimeMs,
          fingerprint: initial.fingerprint, recoveryCopy: true,
        })
        current(sessionID, b, { write: true })
        await revision(sessionID, { binding: b, fingerprint: initial.fingerprint })
        const unchanged = await stat(b.project.path)
        if (unchanged.ino !== destination.ino || unchanged.size !== destination.size ||
            unchanged.mtimeMs !== destination.mtimeMs || unchanged.ctimeMs !== destination.ctimeMs)
          fail("stale_project", "Destination file changed during restore approval")
        await bridge.lock(sessionID, { kind: "restore", checkpointId })
        await checkpoints.pin(checkpointId, true)
        // Any failure keeps the lock and recovery checkpoints. No canonical disk replacement.
        const currentCheckpoint = await saveCheckpoint(sessionID, initial, hash({ checkpointId, fingerprint: initial.fingerprint }))
        await bridge.recordOutcome(sessionID, { outcome: "recovery_copy", checkpointId, currentCheckpointId: currentCheckpoint.id })
        const result = await restoreCheckpoint(sessionID, b, checkpoint, initial.fingerprint)
        return { ...result, currentCheckpointId: currentCheckpoint.id }
      })
    },
  }
  return workflow
}
