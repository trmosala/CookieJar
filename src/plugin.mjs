import { z } from "zod"
import path from "node:path"
import { realpath, stat } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import { AsyncLocalStorage } from "node:async_hooks"
import { createBridge } from "./bridge.mjs"
import { createCheckpoints, createGrants } from "./storage.mjs"
import { createWorkflow } from "./workflow.mjs"
import { createRenderer } from "./render.mjs"
import { createDiagnostics } from "./diagnostics.mjs"
import { createChat } from "./chat.mjs"
import { capture, captureArgs, safeRefusals } from "./capture.mjs"
import { AE_PERMISSIONS } from "./config.mjs"
import { fail, hash, PROPOSAL_TTL, releaseMetadata } from "./protocol.mjs"

const text = z.string().min(1).max(256)
const filePath = z.string().min(1).max(32767).refine(p => path.isAbsolute(p) && !/[\0\r\n]/.test(p) && !p.split(/[\\/]/).includes(".."), "Use an absolute local path without traversal")
const id = z.number().int().positive()
const privileged = ["ae_bind", "ae_release", "ae_execute", "ae_grant", "ae_capture",
  "ae_checkpoints", "ae_restore", "ae_render_submit", "ae_render_cancel",
  "ae_reconcile", "ae_templates", "ae_render_recover", "ae_render_retire"]
const same = (a, b) => a?.id === b?.id && a?.connectionId === b?.connectionId &&
  a?.project?.id === b?.project?.id && a?.project?.path === b?.project?.path
const clone = value => structuredClone(value)
const match = (pattern, name) => new RegExp("^" + pattern.split("*").map(p => p.split("?").map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".")).join(".*") + "$").test(name)
const object = value => value !== null && typeof value === "object" && !Array.isArray(value)

function policyRules(policy, name) {
  if (policy === undefined) return []
  if (["allow", "ask", "deny"].includes(policy)) return [policy]
  if (!object(policy)) fail("unsafe_permission_config", "Invalid permission policy")
  const values = []
  for (const [pattern, rule] of Object.entries(policy)) {
    if (!match(pattern, name)) continue
    if (typeof rule === "string") values.push(rule)
    else if (object(rule)) values.push(...Object.values(rule))
    else fail("unsafe_permission_config", "Invalid permission rule")
  }
  if (values.some(v => !["allow", "ask", "deny"].includes(v))) fail("unsafe_permission_config", "Invalid permission action")
  return values
}

export function checkPermissionConfig(config, name, { configure = false } = {}) {
  if (!object(config)) fail("permission_policy_required", "The CookieMonster config hook must run before privileged tools")
  const agents = [...Object.values(config.agent || {}), ...Object.values(config.mode || {})]
  for (const tool of name ? [name] : privileged) {
    const policies = [config.permission, ...agents.map(agent => agent?.permission)]
    // Conservatively reject ANY matching allow, including wildcard and agent overrides.
    // The SDK has no force-once flag; always:[] cannot override a configured allow.
    if (policies.some(policy => policyRules(policy, tool).includes("allow")))
      fail("unsafe_permission_config", `${tool} requires ask or deny, including wildcard and agent permission rules`)
    if ([config, ...agents].some(value => object(value?.tools) &&
        Object.entries(value.tools).some(([pattern, enabled]) => enabled === true && match(pattern, tool))))
      fail("unsafe_permission_config", `${tool} cannot use legacy auto-allow tool configuration`)
    if (!configure && (policyRules(config.permission, tool).includes("deny") ||
        !policyRules(config.permission, tool).includes("ask")))
      fail("permission_denied", `${tool} requires explicit ask configuration for this approval`)
  }
}

function current(r, c, expected, options = {}) {
  c.check()
  const b = r.bridge.binding(c.sessionID, options)
  if (expected && !same(b, expected)) fail("stale_binding", "Session binding or project changed")
  return b
}

async function approval(r, c, name, summary, metadata = {}) {
  c.check()
  if (typeof r.permissionPolicy !== "function") fail("permission_policy_required", "A checked permission policy is required")
  r.permissionPolicy(name)
  if (typeof c.ask !== "function") fail("permission_required", "Explicit permission callback required")
  let listener
  const signals = [c.abort, c.lifetime].filter(Boolean)
  const aborted = new Promise((_, reject) => {
    listener = () => reject(Object.assign(new Error("Operation aborted"), { code: "aborted" }))
    for (const signal of signals) signal.addEventListener("abort", listener, { once: true })
  })
  try {
    c.check()
    const result = await Promise.race([
      Promise.resolve().then(() => { c.check(); return c.ask({ permission: name, patterns: [summary], always: [], metadata: clone(metadata) }) }),
      aborted,
    ])
    c.check()
    r.permissionPolicy(name)
    if (result === false) fail("permission_denied", "Permission denied")
  } finally {
    for (const signal of signals) signal.removeEventListener("abort", listener)
  }
}
const askFor = (r, c, name) => (summary, metadata) => approval(r, c, name, summary, metadata)

async function snapshot(r, c, b, expected) {
  current(r, c, b, { allowLocked: true })
  const inspected = await r.workflow.inspect(c.sessionID)
  current(r, c, b, { allowLocked: true })
  if (expected && inspected.fingerprint !== expected) fail("stale_fingerprint", "Project changed since review")
  return inspected
}
async function checkpoint(r, c, b, checkpointId) {
  const record = await r.checkpoints.verify(checkpointId)
  if (!record?.verified || record.id !== checkpointId || record.projectId !== b.project.id ||
      record.projectPath !== await realpath(b.project.path))
    fail("checkpoint_scope", "Checkpoint does not belong to the bound project")
  current(r, c, b, { allowLocked: true })
  return record
}
async function checkpointList(r, c) {
  const b = current(r, c, null, { allowLocked: true }), canonical = await realpath(b.project.path)
  const records = await r.checkpoints.list(b.project.id)
  current(r, c, b, { allowLocked: true })
  return records.filter(record => record.projectId === b.project.id && record.projectPath === canonical)
}
async function mutateCheckpoint(r, c, a, ask) {
  const b = current(r, c), initial = await snapshot(r, c, b)
  const record = await checkpoint(r, c, b, a.id)
  await ask(`${a.action === "pin" ? (a.pinned ? "Pin" : "Unpin") : "Delete"} checkpoint ${record.id} from ${record.createdAt} for ${b.project.path}`, { checkpoint: record, binding: b })
  current(r, c, b)
  await snapshot(r, c, b, initial.fingerprint)
  const verified = await checkpoint(r, c, b, a.id)
  if (verified.hash !== record.hash) fail("checkpoint_changed", "Checkpoint changed during approval")
  current(r, c, b)
  const result = a.action === "pin" ? await r.checkpoints.pin(a.id, a.pinned) : await r.checkpoints.remove(a.id)
  current(r, c, b)
  return result ?? { deleted: true, id: a.id }
}
async function templates(r, c, compId, ask) {
  const b = current(r, c, null, { write: true }), before = await snapshot(r, c, b)
  if (!before.items.some(item => item.id === compId && item.kind === "comp"))
    fail("invalid_payload", "Composition ID is not in the inspected project")
  await ask(`Discover installed render templates for composition ${compId}; temporarily adds and removes a render-queue item.`, { compId, binding: b })
  current(r, c, b, { write: true })
  await snapshot(r, c, b, before.fingerprint)
  current(r, c, b, { write: true })
  await r.bridge.lock(c.sessionID, { kind: "templates" })
  try {
    current(r, c, b, { write: true, allowLocked: true })
    const result = await r.bridge.call(c.sessionID, "templates", { compId }, { allowLocked: true })
    const parsed = z.object({ renderSettings: z.array(text).max(10000), outputModules: z.array(text).max(10000) }).strict().parse(result)
    current(r, c, b, { allowLocked: true })
    await r.bridge.unlock(c.sessionID)
    return parsed
  } catch (error) {
    if (safeRefusals.has(error.code)) {
      current(r, c, b, { allowLocked: true })
      await r.bridge.unlock(c.sessionID)
    }
    throw error
  }
}

async function submit(r, c, a, ask) {
  const b = current(r, c, null, { write: true })
  const installed = await templates(r, c, a.compId, ask)
  current(r, c, b, { write: true })
  if (!installed.renderSettings.includes(a.renderSettings) || !installed.outputModules.includes(a.outputModule))
    fail("render_template", "Select templates actually installed in After Effects")
  const before = await snapshot(r, c, b)
  const comp = before.items.find(item => item.id === a.compId && item.kind === "comp")
  if (!comp || typeof comp.name !== "string" || !comp.name.length ||
      before.items.filter(item => item.kind === "comp" && item.name === comp.name).length !== 1)
    fail("render_comp", "aerender requires a unique inspected composition name")
  if (!Number.isFinite(comp.duration) || !Number.isFinite(comp.frameRate) || comp.frameRate <= 0 ||
      a.endFrame < a.startFrame || a.endFrame - a.startFrame >= 100000 ||
      a.endFrame >= Math.floor(comp.duration * comp.frameRate + 1e-7))
    fail("render_range", "Inclusive frame range must fit the real composition duration")
  const grantInput = { sessionID: c.sessionID, bindingID: b.id, path: a.outputPath, write: true, projectPath: b.project.path }
  const outputPath = await r.grants.check(grantInput)
  const directoryGrant = { ...grantInput, path: path.dirname(outputPath) }
  if (await r.grants.check(directoryGrant) !== directoryGrant.path)
    fail("grant_changed", "Render output directory changed")
  current(r, c, b)
  await ask(`Save ${b.project.path}, create an immutable checkpoint, and render ${comp.name} (ID ${comp.id}), frames ${a.startFrame}-${a.endFrame}, with ${a.renderSettings} / ${a.outputModule} to ${outputPath}. Later live edits are excluded. Output naming must match the chosen template.`, { ...a, outputPath, compName: comp.name, binding: b, fingerprint: before.fingerprint })
  current(r, c, b, { write: true })
  await snapshot(r, c, b, before.fingerprint)
  if (await r.grants.check(grantInput) !== outputPath ||
      await r.grants.check(directoryGrant) !== directoryGrant.path) fail("grant_changed", "Output grant changed")
  current(r, c, b, { write: true })
  await r.bridge.lock(c.sessionID, { kind: "render_checkpoint" })
  // Any ambiguous save/checkpoint failure leaves the lock and recovery copy intact.
  await snapshot(r, c, b, before.fingerprint)
  const saved = await r.bridge.call(c.sessionID, "save", {}, { allowLocked: true })
  current(r, c, b, { write: true, allowLocked: true })
  if (!saved?.project?.saved || saved.project.id !== b.project.id || saved.project.path !== b.project.path)
    fail("stale_project", "Save changed the bound project")
  const savedState = await snapshot(r, c, b, before.fingerprint)
  const created = await r.checkpoints.create({ projectPath: b.project.path, projectId: b.project.id,
    planHash: hash({ compId: comp.id, fingerprint: savedState.fingerprint }), pinned: true })
  const verified = await checkpoint(r, c, b, created.id)
  const jobScope = Object.freeze({ projectId: verified.projectId, projectPath: verified.projectPath })
  await snapshot(r, c, b, savedState.fingerprint)
  current(r, c, b, { allowLocked: true })
  await r.bridge.unlock(c.sessionID)
  current(r, c, b)
  let job
  try {
    job = await r.renderer.submit({ ...a, outputPath, compName: comp.name, templates: installed,
      checkpointId: created.id, sessionID: c.sessionID, bindingID: b.id })
  } catch (error) {
    if (error.details?.jobId) {
      r.jobScopes.set(error.details.jobId, jobScope)
      r.recovered.add(error.details.jobId)
    }
    throw error
  }
  // A launch can finish after release; keep its independently verified project scope.
  r.jobScopes.set(job.jobId, jobScope)
  r.recovered.add(job.jobId)
  current(r, c, b)
  r.jobs.set(job.jobId, { sessionID: c.sessionID, bindingID: b.id })
  r.recovered.delete(job.jobId)
  // Renderer owns a private lease by now. Failed cleanup cannot cancel a submitted job.
  const cleanup = await r.checkpoints.pin(created.id, false).then(() => null, () => "Source checkpoint remains pinned")
  return { ...job, cleanup, note: "Only the saved immutable checkpoint is rendered; later live edits are excluded." }
}

function sourceScope(job) {
  const source = job.sourceCheckpoint
  if (["corrupt_manifest", "invalid_job_directory"].includes(job.reason) ||
      typeof source?.projectId !== "string" || !source.projectId.length ||
      typeof source?.projectPath !== "string" || !path.isAbsolute(source.projectPath)) return
  return { projectId: source.projectId, projectPath: source.projectPath }
}

function jobScope(r, job) {
  const source = sourceScope(job), known = r.jobScopes.get(job.jobId)
  if (source && known && (source.projectId !== known.projectId || source.projectPath !== known.projectPath)) return
  return source || known
}

function unknownJob(job) {
  return { jobId: job.jobId, state: "unknown",
    reason: ["corrupt_manifest", "invalid_job_directory"].includes(job.reason) ? job.reason : "unknown",
    metadataOnly: true, controllable: false, verified: false, outputs: [],
    remediation: "manual_manifest_recovery_required" }
}

async function jobList(r, c) {
  const b = current(r, c, null, { allowLocked: true }), canonical = await realpath(b.project.path)
  const jobs = await r.renderer.list()
  current(r, c, b, { allowLocked: true })
  return jobs.filter(job => {
    const owner = r.jobs.get(job.jobId), source = jobScope(r, job)
    return source?.projectId === b.project.id && source.projectPath === canonical &&
      (owner ? owner.sessionID === c.sessionID && owner.bindingID === b.id : r.recovered.has(job.jobId))
  }).map(job => ({ ...(sourceScope(job) ? { jobId: job.jobId, state: job.state, compId: job.compId,
    startFrame: job.startFrame, endFrame: job.endFrame } : unknownJob(job)),
    recoverable: !r.jobs.has(job.jobId) }))
}

async function jobAccess(r, c, jobId) {
  const b = current(r, c, null, { allowLocked: true })
  const owner = r.jobs.get(jobId)
  if (owner && (owner.sessionID !== c.sessionID || owner.bindingID !== b.id))
    fail("render_scope", "Render belongs to another session or binding")
  if (!owner && !r.recovered.has(jobId)) fail("render_scope", "No render ownership for this session")
  let job = await r.renderer.status(jobId)
  const canonical = await realpath(b.project.path), source = jobScope(r, job)
  current(r, c, b, { allowLocked: true })
  if (job.jobId !== jobId || !source || source.projectId !== b.project.id || source.projectPath !== canonical)
    fail("render_scope", "Render project scope is unavailable or does not match; manual manifest recovery may be required")
  if (!owner) {
    const before = await snapshot(r, c, b)
    await approval(r, c, "ae_render_recover", `Recover access to render ${jobId} for the bound project ${b.project.path}. This claim lasts only for this session and binding.${sourceScope(job) ? "" : " Metadata-only: manifest recovery is required before outputs or process control are available."}`, { jobId, binding: b })
    await snapshot(r, c, b, before.fingerprint)
    job = await r.renderer.status(jobId)
    const latest = jobScope(r, job)
    current(r, c, b, { allowLocked: true })
    if (job.jobId !== jobId || !latest || latest.projectId !== source.projectId || latest.projectPath !== source.projectPath)
      fail("render_scope", "Render project scope changed during approval")
    if (r.jobs.has(jobId) || !r.recovered.has(jobId)) fail("render_scope", "Render ownership changed during approval")
    r.jobs.set(jobId, { sessionID: c.sessionID, bindingID: b.id })
    r.recovered.delete(jobId)
  }
  // A status read may finish after retirement or release removed its ownership.
  // Never repopulate runtime scope from that stale observation.
  current(r, c, b, { allowLocked: true })
  if (owner && r.jobs.get(jobId) !== owner) fail("render_scope", "Render ownership changed during inspection")
  // Functional job identity only; no session IDs, prompts or audit history.
  r.jobScopes.set(jobId, Object.freeze({ ...source }))
  return sourceScope(job) ? job : unknownJob(job)
}

export function createTools(runtime) {
  const r = runtime, tools = {}
  function tool(name, description, args, execute) {
    tools[name] = { description, args, async execute(input, context) {
      const parsed = z.object(args).strict().parse(input)
      text.parse(context?.sessionID)
      const run = async (check = () => { if (context.abort?.aborted) fail("aborted", "Operation aborted") }, lifetime) => {
        const c = { ...context, check, lifetime }, started = performance.now()
        check()
        try {
          if (["ae_inspect", "ae_capture"].includes(name)) {
            await r.bridge.ensureBound(c.sessionID)
            check()
          }
          const result = await execute(parsed, c, askFor(r, c, name))
          if (name === "ae_reconcile") await r.chat?.recordReconciliation(c.sessionID)
          if (name === "ae_restore") await r.chat?.recordRestore(c.sessionID, { status: "completed",
            checkpointId: result.checkpointId, currentCheckpointId: result.currentCheckpointId,
            recoveryCopy: result.recoveryCopy, path: result.path, emergencyPath: result.emergencyPath, warning: result.warning })
          if (name !== "ae_release" && name !== "ae_bind") check()
          if (name !== "ae_release" && !lifetime?.aborted) r.diagnostics?.record(c.sessionID, name.slice(3), "ok", { durationMs: performance.now() - started })
          return name === "ae_capture" ? result : JSON.stringify(result ?? null)
        } catch (error) {
          if (!lifetime?.aborted) r.diagnostics?.record(c.sessionID, name.slice(3), "failed", { durationMs: performance.now() - started, errorCode: error?.code })
          throw error
        }
      }
      return r.run ? r.run(context, run) : run()
    } }
  }
  tool("ae_pair", "Recovery only: create a short-lived pairing code for the AE panel's advanced connection settings. Normal connection is automatic; start with ae_inspect instead.", {}, async (_, c) => r.bridge.pairingCode(c.sessionID))
  tool("ae_connections", "List connections and reported panel compatibility without other sessions' bindings. includeCompatibility adds runtime versions, trusted update guidance and this session's pending pairing mismatches, even with no connections.", {
    includeCompatibility: z.boolean().default(false),
  }, async (a, c) => {
    const list = await r.bridge.connections()
    c.check()
    const connections = list.map(({ id, connectionId, aeVersion, project, capabilities, activeCompId, connected, busy, binding, lock, compatibility }) => ({
      id, connectionId, aeVersion, project, capabilities, activeCompId, connected, busy, compatibility,
      mutationEligible: !!(connected && project?.saved && project.path && capabilities?.fileNetwork && !busy && !lock),
      owned: !!binding && binding.sessionID !== c.sessionID,
      binding: binding?.sessionID === c.sessionID ? binding : null,
    }))
    return a.includeCompatibility ? { compatibility: r.bridge.compatibility(c.sessionID), connections } : connections
  })
  tool("ae_bind", "Select an AE instance when several are connected, reselect after a project change, or explicitly take control from another conversation. A single available instance binds automatically on ae_inspect. Takeover requires review.", { connectionId: text, takeover: z.boolean().default(false) }, async (a, c, ask) => {
    const before = clone((await r.bridge.connections()).find(b => b.connectionId === a.connectionId))
    if (!before?.connected) fail("disconnected", "Connection is unavailable")
    const proof = hash(before)
    const expectedProject = Object.freeze(clone(before.project)), expectedOwner = before.binding?.id ?? null
    await ask(`Bind this session to ${before.project.path || "unsaved project"} on ${a.connectionId}${a.takeover ? "; take over its existing session" : ""}.${before.project.saved ? "" : " Inspection only; save manually and explicitly rebind before mutation."}`, { ...a, project: before.project })
    const after = (await r.bridge.connections()).find(b => b.connectionId === a.connectionId)
    c.check()
    if (!after || hash(after) !== proof) fail("stale_binding", "Target changed during binding review")
    return r.bridge.bind(c.sessionID, a.connectionId, {
      takeover: a.takeover, expectedProject, expectedOwner, expectedConnection: before.epoch,
    })
  })
  tool("ae_release", "Release only this session's active or suspended binding and ephemeral authorizations.", {}, async (_, c, ask) => {
    const b = current(r, c, null, { allowLocked: true, allowSuspended: true })
    await ask(`Release this session's AE binding to ${b.project.path || "unsaved project"}. Detached render jobs continue.`, { binding: b })
    current(r, c, b, { allowLocked: true, allowSuspended: true })
    return r.release ? r.release(c.sessionID) : r.bridge.release(c.sessionID)
  })
  tool("ae_inspect", "Automatically connect this conversation to the single available AE instance and inspect its project or query any composition, layer or property. Multiple instances or another conversation's ownership require ae_connections and explicit ae_bind. Returns expectedRevision for ae_execute; use nextCursor to continue a bounded query.", {
    compId: id.optional(), layerId: id.optional(),
    propertyPath: z.array(z.object({
      index: z.number().int().min(0).max(100000), matchName: z.string().min(1).max(4096),
      name: z.string().max(4096).optional(),
    }).strict()).max(32).optional(),
    depth: z.number().int().min(0).max(8).optional(), cursor: z.string().min(1).max(8192).optional(),
  }, (a, c) => r.workflow.inspectQuery(c.sessionID, a))
  tool("ae_execute", "Review exact ExtendScript source and execute against expectedRevision from ae_inspect after a verified checkpoint. Unsandboxed: external effects cannot be rolled back; partial changes may remain. No automatic rollback or retry.", {
    source: z.string().min(1).max(262144).regex(/^[^\u0000]*$/),
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/), label: z.string().min(1).max(128).regex(/^[^\u0000-\u001f]*$/),
  }, (a, c, ask) => r.workflow.executeScript(c.sessionID, a, ask))
  tool("ae_grant", "Approve an explicit canonical filesystem scope for this session and binding.", {
    path: filePath, recursive: z.boolean().default(false), write: z.boolean().default(false),
  }, async (a, c, ask) => {
    const b = current(r, c), before = await snapshot(r, c, b)
    const canonical = await realpath(a.path).catch(async error => {
      if (error.code !== "ENOENT" || !a.write || a.recursive) throw error
      return path.join(await realpath(path.dirname(a.path)), path.basename(a.path))
    })
    await ask(`Grant ${a.write ? "read/write" : "read"} access to ${canonical}${a.recursive ? " recursively" : ""} for this binding.`, { ...a, path: canonical, binding: b })
    current(r, c, b)
    await snapshot(r, c, b, before.fingerprint)
    current(r, c, b)
    const granted = await r.grants.grant({ ...a, path: canonical, sessionID: c.sessionID, bindingID: b.id })
    if (granted.path !== canonical) {
      await r.grants.release(c.sessionID, b.id)
      fail("grant_changed", "Approved path changed; rebind before granting again")
    }
    current(r, c, b)
    return granted
  })
  tool("ae_capture", "Capture one explicit composition/time as a bounded PNG (alpha default) or JPEG image attachment for visual inspection. Keep AE idle and the panel visible.", captureArgs,
    (a, c, ask) => capture(r, c.sessionID, a, ask, c.check))
  tool("ae_checkpoints", "List, pin, unpin, or delete checkpoints only for the current project.", {
    action: z.enum(["list", "pin", "delete"]).default("list"), id: text.optional(), pinned: z.boolean().optional(),
  }, async (a, c, ask) => {
    if (a.action === "list") {
      if (a.id !== undefined || a.pinned !== undefined) fail("invalid_payload", "List takes no checkpoint or pin flag")
      return checkpointList(r, c)
    }
    if (!a.id || a.action === "pin" && a.pinned === undefined || a.action === "delete" && a.pinned !== undefined)
      fail("invalid_payload", "Pin needs id/pinned; delete needs only id")
    return mutateCheckpoint(r, c, a, ask)
  })
  tool("ae_restore", "Review and restore a verified checkpoint of the bound project; save current state first.", { checkpointId: text },
    (a, c, ask) => r.workflow.restore(c.sessionID, a.checkpointId, ask))
  tool("ae_templates", "Discover installed templates using a temporary queue item after approval.", { compId: id },
    (a, c, ask) => templates(r, c, a.compId, ask))
  tool("ae_render_submit", "Save and checkpoint the live inspected composition, then render separately with trusted aerender configuration.", {
    compId: id, startFrame: z.number().int().nonnegative(), endFrame: z.number().int().nonnegative(),
    renderSettings: text, outputModule: text, outputPath: filePath,
  }, (a, c, ask) => submit(r, c, a, ask))
  tool("ae_render_recover", "Review and claim a detached render for this session and bound project.", { jobId: text },
    (a, c) => jobAccess(r, c, a.jobId))
  tool("ae_render_status", "Inspect this session's render; detached jobs first require ae_render_recover approval.", { jobId: text },
    (a, c) => jobAccess(r, c, a.jobId))
  tool("ae_render_result", "Return verified completed deliverables, never partial output as success.", { jobId: text }, async (a, c) => {
    const job = await jobAccess(r, c, a.jobId)
    if (job.metadataOnly) return job
    const b = current(r, c, null, { allowLocked: true }), result = await r.renderer.result(a.jobId)
    current(r, c, b, { allowLocked: true })
    const latest = await jobAccess(r, c, a.jobId)
    return latest.metadataOnly ? latest : result
  })
  tool("ae_render_cancel", "Approve cancellation of an owned render; renderer rechecks process identity before termination.", { jobId: text }, async (a, c, ask) => {
    const job = await jobAccess(r, c, a.jobId), b = current(r, c, null, { allowLocked: true })
    if (job.metadataOnly) fail("render_process_identity", "Manual manifest recovery required; process control is unavailable")
    const before = await snapshot(r, c, b)
    await ask(`Cancel render ${a.jobId}; partial outputs will be quarantined.`, { jobId: a.jobId, state: job.state, binding: b })
    await snapshot(r, c, b, before.fingerprint)
    if ((await jobAccess(r, c, a.jobId)).metadataOnly)
      fail("render_process_identity", "Manual manifest recovery required; process control is unavailable")
    return r.renderer.cancel(a.jobId)
  })
  tool("ae_render_retire", "Review and permanently retire a terminal render's recovery records and private artifacts; preserves published outputs and source checkpoints.", { jobId: text }, async (a, c, ask) => {
    const b = current(r, c, null, { allowLocked: true })
    r.permissionPolicy("ae_render_retire")
    const job = await jobAccess(r, c, a.jobId)
    if (job.metadataOnly) fail("render_retire_refused", "Manual manifest recovery required; retirement is unavailable")
    const owner = r.jobs.get(a.jobId), source = sourceScope(job)
    const check = () => {
      current(r, c, b, { allowLocked: true })
      r.permissionPolicy("ae_render_retire")
      const latest = r.jobScopes.get(a.jobId)
      if (!owner || r.jobs.get(a.jobId) !== owner || !source || !latest ||
          latest.projectId !== source.projectId || latest.projectPath !== source.projectPath)
        fail("render_scope", "Render ownership or project scope changed during retirement")
    }
    check()
    const preview = await r.renderer.retire(a.jobId)
    check()
    await ask(`Retire render ${a.jobId}. ${preview.warning}`, { ...preview, binding: b })
    check()
    const latest = await jobAccess(r, c, a.jobId)
    if (latest.metadataOnly) fail("render_retire_refused", "Manual manifest recovery required; retirement is unavailable")
    check()
    // The non-persisted guard also runs under the renderer gate, after async checks.
    const result = await r.renderer.retire(a.jobId, { approval: preview.approval, check })
    if (result?.retired !== true) fail("render_retire_refused", "Renderer did not confirm retirement")
    // Cleanup must still happen if release/abort arrived after the final deletion.
    r.jobs.delete(a.jobId)
    r.recovered.delete(a.jobId)
    r.jobScopes.delete(a.jobId)
    return result
  })
  tool("ae_render_list", "List owned and recoverable render IDs only for the bound project; listing never claims ownership.", {},
    (_, c) => jobList(r, c))
  tool("ae_diagnostics", "Export allowlisted metadata only, with per-runtime salted identities and no activity payloads.", {}, async (_, c) => {
    const connections = (await r.bridge.connections()).filter(item => item.binding?.sessionID === c.sessionID)
    const all = await r.renderer.list()
    const jobs = all.filter(job => r.jobs.get(job.jobId)?.sessionID === c.sessionID)
    const unscopableRenderCount = all.filter(job => !jobScope(r, job)).length
    const checkpoints = connections.some(item => item.connected && item.binding?.state === "active") ? await checkpointList(r, c) : []
    c.check()
    return r.diagnostics.export({ sessionID: c.sessionID, connections, jobs, checkpoints, unscopableRenderCount,
      compatibility: r.bridge.compatibility(c.sessionID) })
  })
  tool("ae_reconcile", "Review uncertain outcome evidence before unlocking; never retries a command.", {},
    (_, c, ask) => r.workflow.reconcile(c.sessionID, ask))
  return tools
}

export async function createRuntime(options = {}) {
  const bridge = await (options.factories?.bridge || createBridge)(options)
  let renderer
  try {
    const checkpoints = createCheckpoints({ dataDir: bridge.dataDir }), grants = createGrants()
    const scope = new AsyncLocalStorage()
    const check = () => scope.getStore()?.()
    const workflow = createWorkflow({
      bridge: {
        ...bridge,
        binding(...args) { check(); return bridge.binding(...args) },
        call(...args) { check(); return bridge.call(...args) },
        lock(...args) { check(); return bridge.lock(...args) },
      },
      checkpoints, grants, now: options.now,
    })
    renderer = await (options.factories?.renderer || createRenderer)({
      dataDir: bridge.dataDir, checkpoints, aerenderPath: options.aerenderPath ?? process.env.CM_AE_AERENDER,
      grants: { async check(input) {
        check()
        const destination = await grants.check(input)
        const directory = path.dirname(destination)
        if (await grants.check({ ...input, path: directory }) !== directory)
          fail("grant_changed", "Render staging directory changed")
        check()
        return destination
      } },
      processAdapter: options.processAdapter,
    })
    const diagnostics = createDiagnostics(), sessions = new Map(), jobs = new Map(), tokens = new Map()
    // Runtime-only trusted project scope survives release, but never survives a restart.
    const jobScopes = new Map()
    const recovered = new Set((await renderer.list()).map(job => job.jobId))
    let closing = false, closePromise
    const r = { bridge, checkpoints, grants, workflow, renderer, diagnostics, jobs, jobScopes, recovered, tokens,
      dataDir: bridge.dataDir, now: options.now || Date.now,
      permissionPolicy: name => checkPermissionConfig(options.permissionConfig, name),
      run(context, operation) {
        if (closing) fail("runtime_closed", "Runtime is closing")
        text.parse(context.sessionID)
        let session = sessions.get(context.sessionID)
        if (session?.draining) fail("aborted", "Session is being disposed")
        if (!session || session.controller.signal.aborted && session.pending.size === 0) {
          session = { controller: new AbortController(), pending: new Set() }
          sessions.set(context.sessionID, session)
        }
        const check = () => {
          if (closing || session.controller.signal.aborted || context.abort?.aborted) fail("aborted", "Session operation aborted")
        }
        const pending = Promise.resolve().then(() => scope.run(check, () => {
          check()
          return operation(check, session.controller.signal)
        }))
        session.pending.add(pending)
        return pending.finally(() => session.pending.delete(pending))
      },
      async release(sessionID) {
        sessions.get(sessionID)?.controller.abort()
        try { return await bridge.release(sessionID) } finally { cleanup(sessionID) }
      },
      async drain(sessionID) {
        const session = sessions.get(sessionID)
        if (session) session.draining = true
        try {
          await r.release(sessionID)
        } finally {
          if (session) await Promise.allSettled([...session.pending])
          // bind() can finish after the first release; remove that late binding too.
          await r.release(sessionID)
          sessions.delete(sessionID)
        }
      },
      close() {
        if (closePromise) return closePromise
        closing = true
        closePromise = (async () => {
          const results = await Promise.allSettled([...sessions.keys()].map(sessionID => r.drain(sessionID)))
          try { await renderer.close() } finally { await bridge.close(); diagnostics.clear(); tokens.clear(); jobs.clear(); jobScopes.clear(); recovered.clear() }
          const failed = results.find(result => result.status === "rejected")
          if (failed) throw failed.reason
        })()
        return closePromise
      },
    }
    function cleanup(sessionID) {
      diagnostics.release(sessionID); tokens.delete(sessionID)
      for (const [jobId, owner] of jobs) if (owner.sessionID === sessionID) {
        recovered.add(jobId)
        jobs.delete(jobId)
      }
    }
    bridge.onRelease(async (sessionID) => {
      sessions.get(sessionID)?.controller.abort()
      cleanup(sessionID)
    })
    bridge.setPanelHandler(input => r.run({ sessionID: input.sessionID }, (check, lifetime) =>
      panel(r, { ...input, check, lifetime })))
    return r
  } catch (error) {
    try { await renderer?.close() } finally { await bridge.close() }
    throw error
  }
}

async function panel(r, input) {
  const { sessionID, binding, connectionId, body } = input
  const c = { sessionID, check: input.check, lifetime: input.lifetime }
  const b = current(r, c, binding, { allowLocked: true })
  if (connectionId !== b.connectionId) fail("panel_scope", "Panel connection does not own this binding")
  const schemas = {
    checkpoints: {}, "checkpoint.pin": { id: text, pinned: z.boolean() }, "checkpoint.delete": { id: text },
    "checkpoint.restore.propose": { id: text }, "checkpoint.restore.confirm": { token: text },
    renders: {}, diagnostics: {},
  }
  if (!Object.hasOwn(schemas, body?.action)) fail("invalid_payload", "Unknown panel action")
  const a = z.object({ action: z.literal(body.action), ...schemas[body.action] }).strict().parse(body)
  const consent = async () => { current(r, c, b); return true }
  if (a.action === "checkpoints") return (await checkpointList(r, c)).map(record => ({
    id: record.id, createdAt: Date.parse(record.createdAt), pinned: record.pinned, storageMode: record.storageMode, size: record.size,
  }))
  if (a.action === "checkpoint.pin" || a.action === "checkpoint.delete")
    return mutateCheckpoint(r, c, { ...a, action: a.action.slice(11) }, consent)
  if (a.action === "checkpoint.restore.propose") {
    await r.chat?.assertRestorable(sessionID)
    current(r, c, b, { write: true })
    const before = await snapshot(r, c, b), record = await checkpoint(r, c, b, a.id)
    let review
    const stop = new Error("Review only")
    try {
      // Stop at the workflow's permission boundary, before any save, pin, lock or open.
      await r.workflow.restore(sessionID, a.id, (operation, metadata) => {
        review = { operation: z.string().min(1).max(65536).parse(operation), metadata: clone(metadata) }
        throw stop
      })
    } catch (error) {
      if (error !== stop) throw error
    }
    if (!review || review.metadata.fingerprint !== before.fingerprint ||
        review.metadata.checkpoint?.hash !== record.hash || !same(review.metadata.binding, b))
      fail("stale_fingerprint", "Restore review changed")
    const { sourceTimestamp, destinationTimestamp } = review.metadata
    if (!Number.isFinite(sourceTimestamp) || !Number.isFinite(destinationTimestamp))
      fail("checkpoint_invalid", "Restore timestamps are invalid")
    current(r, c, b)
    const token = randomBytes(32).toString("base64url")
    r.tokens.set(sessionID, { token, binding: b, fingerprint: before.fingerprint, checkpointId: record.id,
      checkpointHash: record.hash, sourceTimestamp, destinationTimestamp, operation: review.operation,
      reviewHash: hash(review.metadata), expiresAt: r.now() + PROPOSAL_TTL })
    return { token, sourceTimestamp, destinationTimestamp, operation: review.operation }
  }
  if (a.action === "checkpoint.restore.confirm") {
    const plan = r.tokens.get(sessionID)
    r.tokens.delete(sessionID)
    if (!plan || plan.token !== a.token || r.now() >= plan.expiresAt) fail("invalid_token", "Restore approval expired or was already consumed")
    current(r, c, plan.binding, { write: true })
    await snapshot(r, c, plan.binding, plan.fingerprint)
    const record = await checkpoint(r, c, b, plan.checkpointId)
    if (record.hash !== plan.checkpointHash || (await stat(b.project.path)).mtimeMs !== plan.destinationTimestamp)
      fail("stale_fingerprint", "Reviewed source or destination changed")
    await r.chat?.assertRestorable(sessionID)
    let started = false
    try {
      const restored = await r.workflow.restore(sessionID, plan.checkpointId, async (operation, metadata) => {
        if (operation !== plan.operation || hash(metadata) !== plan.reviewHash)
          fail("stale_fingerprint", "Restore operation changed; review it again")
        if (r.now() >= plan.expiresAt) fail("invalid_token", "Restore approval expired")
        await snapshot(r, c, plan.binding, plan.fingerprint)
        if ((await stat(b.project.path)).mtimeMs !== plan.destinationTimestamp) fail("stale_fingerprint", "Destination changed")
        await r.chat?.recordRestore(sessionID, { status: "pending", checkpointId: plan.checkpointId })
        started = true
        return true
      })
      await r.chat?.recordRestore(sessionID, { status: "completed", checkpointId: restored.checkpointId,
        currentCheckpointId: restored.currentCheckpointId, recoveryCopy: restored.recoveryCopy,
        path: restored.path, emergencyPath: restored.emergencyPath, warning: restored.warning })
      return restored
    } catch (error) {
      if (started) await r.chat?.recordRestore(sessionID, { status: "unconfirmed", checkpointId: plan.checkpointId,
        emergencyPath: error.details?.emergencyPath || null, currentCheckpointId: error.details?.currentCheckpointId || null,
        message: "Restore was not confirmed. Inspect After Effects and retain the recovery files before continuing." })
      throw error
    }
  }
  if (a.action === "renders") return jobList(r, c)
  const all = await r.renderer.list()
  current(r, c, b, { allowLocked: true })
  const visible = all.filter(job => r.jobs.get(job.jobId)?.sessionID === sessionID && r.jobs.get(job.jobId)?.bindingID === b.id)
  const connections = (await r.bridge.connections()).filter(connection => connection.connectionId === b.connectionId)
  const checkpoints = await checkpointList(r, c)
  current(r, c, b, { allowLocked: true })
  const unscopableRenderCount = all.filter(job => !jobScope(r, job)).length
  return r.diagnostics.export({ sessionID, connections, jobs: visible, checkpoints, unscopableRenderCount,
    compatibility: r.bridge.compatibility(sessionID) })
}

// No listeners, filesystem access, or runtime creation at import time.
let shared
export async function server(_input, options = {}) {
  const releaseHash = hash(releaseMetadata(options.releaseMetadata))
  if (shared?.closing) await shared.closing
  if (!shared) {
    const entry = { refs: 0, owners: new Map(), options: { ...options }, releaseHash }
    entry.promise = createRuntime(options).catch(error => { if (shared === entry) shared = undefined; throw error })
    shared = entry
  } else if (releaseHash !== shared.releaseHash ||
      (options.dataDir && options.dataDir !== shared.options.dataDir) ||
      (options.aerenderPath && options.aerenderPath !== shared.options.aerenderPath))
    fail("runtime_config", "All directory-scoped instances must use the same runtime configuration")
  const entry = shared
  entry.refs++
  let runtime
  try { runtime = await entry.promise } catch (error) { entry.refs--; throw error }
  if (!entry.chat) entry.chat = createChat(runtime)
  const chat = await entry.chat
  runtime.chat = chat
  const unregisterChat = chat.register(_input)
  runtime.bridge.setChatHandler(chat.handle)
  const owned = new Set(), owner = Symbol("plugin-instance")
  let disposed = false, disposePromise, config
  const tools = createTools({ ...runtime, permissionPolicy: name => checkPermissionConfig(config, name) })
  for (const definition of Object.values(tools)) {
    const execute = definition.execute
    definition.execute = (args, context) => {
      if (disposed) fail("runtime_closed", "Plugin instance is disposed")
      text.parse(context?.sessionID)
      chat.checkSession(context.sessionID)
      const previous = entry.owners.get(context.sessionID)
      if (previous && previous !== owner) fail("session_scope", "Session belongs to another plugin instance")
      entry.owners.set(context.sessionID, owner); owned.add(context.sessionID)
      return execute(args, context)
    }
  }
  async function release(sessionID) {
    if (entry.owners.get(sessionID) !== owner) return
    try { await runtime.drain(sessionID) } finally { entry.owners.delete(sessionID); owned.delete(sessionID) }
  }
  return {
    tool: tools,
    async config(value) {
      config = undefined
      checkPermissionConfig(value, null, { configure: true })
      if (value.permission === undefined || object(value.permission)) value.permission = {
        ...AE_PERMISSIONS, ae_templates: "ask", ae_render_recover: "ask", ...value.permission,
      }
      config = value
    },
    async event({ event }) {
      await chat.event(event)
      if (event?.type === "session.deleted") {
        const sessionID = event.properties?.info?.id
        if (typeof sessionID === "string") await release(sessionID)
      }
    },
    dispose() {
      if (disposePromise) return disposePromise
      disposed = true
      disposePromise = (async () => {
        const results = await Promise.allSettled([...owned].map(release))
        unregisterChat()
        entry.refs--
        if (entry.refs === 0) {
          entry.closing = runtime.close()
          try { await entry.closing } finally { if (shared === entry) shared = undefined }
        }
        const failed = results.find(result => result.status === "rejected")
        if (failed) throw failed.reason
      })()
      return disposePromise
    },
  }
}

export default { id: "cm-ae", server }
