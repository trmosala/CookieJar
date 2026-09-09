import { createHmac, randomBytes } from "node:crypto"
import { VERSION, PROTOCOL, validVersion, validProtocol } from "./protocol.mjs"

const states = new Set(["active", "suspended", "executing", "uncertain", "starting", "running", "cancelling", "completed", "failed", "cancelled", "unknown"])
const operations = new Set(["pair", "bind", "release", "inspect", "propose", "execute", "grant", "capture",
  "raw_enable", "raw_propose", "raw_execute", "checkpoints", "restore", "render_submit", "render_status",
  "render_cancel", "render_result", "render_recover", "render_retire", "diagnostics", "reconcile", "templates", "render_list"])
const errors = new Set(["incompatible_version", "aborted", "permission_denied", "permission_required", "permission_policy_required",
  "unsafe_permission_config", "not_bound", "binding_suspended", "stale_binding", "stale_project", "stale_fingerprint",
  "invalid_token", "proposal_expired", "invalid_payload", "payload_too_large", "invalid_capture", "invalid_host_result",
  "capability_missing", "unsafe_state", "host_busy", "target_locked", "outcome_uncertain", "timeout", "disconnected",
  "path_denied", "grant_changed", "checkpoint_scope", "checkpoint_invalid", "checkpoint_corrupt", "storage_failed",
  "render_scope", "render_template", "render_comp", "render_range", "render_process_identity", "restore_failed",
  "render_retire_refused", "render_retire_partial", "render_busy", "render_job", "render_closed"])
const state = value => typeof value === "string" && states.has(value) ? value : "unknown"
// Build labels and URLs can contain names or credentials, even when syntactically valid.
const version = value => validVersion(value) ? value.split(/[-+]/)[0] : null
const compatibility = value => ({
  status: ["compatible", "incompatible"].includes(value?.status) ? value.status : "unknown",
  panelVersion: version(value?.panelVersion),
  panelProtocol: validProtocol(value?.panelProtocol) ? value.panelProtocol : null,
  cookieMonsterVersion: version(value?.cookieMonsterVersion),
  cookieMonsterVersionStatus: value?.cookieMonsterVersionStatus === "configured" && validVersion(value?.cookieMonsterVersion)
    ? "configured" : "not_configured",
})

export function createDiagnostics() {
  const salt = randomBytes(32)
  const events = new Map()
  const identity = (kind, value) => typeof value === "string" && value.length > 0 && value.length <= 32768
    ? createHmac("sha256", salt).update(kind + "\0" + value).digest("hex") : null
  return {
    record(sessionID, operation, outcome, metadata = {}) {
      if (!operations.has(operation) || !["ok", "failed"].includes(outcome)) return
      // ponytail: bounded per-session metadata, no durable activity history.
      if (!events.has(sessionID) && events.size >= 1000) events.delete(events.keys().next().value)
      const list = events.get(sessionID) || []
      const event = { operation, outcome }
      if (Number.isFinite(metadata?.durationMs) && metadata.durationMs >= 0) event.durationMs = metadata.durationMs
      if (outcome === "failed") event.errorCode = errors.has(metadata?.errorCode) ? metadata.errorCode : "unknown"
      list.push(event)
      events.set(sessionID, list.slice(-100))
    },
    release(sessionID) { events.delete(sessionID) },
    clear() { events.clear() },
    export({ sessionID, connections = [], jobs = [], checkpoints = [], unscopableRenderCount = 0, compatibility: metadata } = {}) {
      const counts = { project: 0, fallback: 0, unknown: 0 }
      let pinnedCount = 0
      for (const checkpoint of Array.isArray(checkpoints) ? checkpoints : []) {
        const mode = checkpoint?.storageMode
        counts[mode === "project" || mode === "fallback" ? mode : "unknown"]++
        if (checkpoint?.pinned === true) pinnedCount++
      }
      return {
        schemaVersion: 1, versions: { plugin: VERSION, protocol: PROTOCOL, zod: "4.1.8" },
        compatibility: { ...compatibility(metadata), pendingPanels: (Array.isArray(metadata?.pendingPanels)
          ? metadata.pendingPanels : []).slice(0, 100).map(compatibility) },
        session: identity("session", sessionID),
        recovery: { unscopableCount: Number.isSafeInteger(unscopableRenderCount) && unscopableRenderCount >= 0 ? unscopableRenderCount : 0,
          remediation: "manual_manifest_recovery_required" },
        storage: { checkpointCount: counts.project + counts.fallback + counts.unknown, pinnedCount,
          modes: Object.entries(counts).map(([storageMode, count]) => ({ storageMode, count })) },
        connections: (Array.isArray(connections) ? connections : []).slice(0, 1000).map(c => ({
          connection: identity("connection", c?.connectionId ?? c?.id),
          project: identity("project", c?.project?.id),
          connected: c?.connected === true, busy: c?.busy === true,
          compatibility: compatibility(c?.compatibility),
          capabilities: { fileNetwork: c?.capabilities?.fileNetwork === true },
          bindingState: state(c?.binding?.state), lockState: state(c?.lock?.state),
        })),
        renders: (Array.isArray(jobs) ? jobs : []).slice(0, 1000).map(job => {
          const corrupt = ["corrupt_manifest", "invalid_job_directory"].includes(job?.reason)
          return {
            job: identity("job", job?.jobId), state: corrupt ? "unknown" : state(job?.state),
            reason: corrupt ? job.reason : "unknown",
            controllable: !corrupt && job?.metadataOnly !== true && job?.controllable === true,
            verified: !corrupt && job?.metadataOnly !== true && job?.outputState === "verified_completed",
          }
        }),
        events: (events.get(sessionID) || []).map(e => ({ ...e })),
      }
    },
  }
}
