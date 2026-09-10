# Installation And Recovery

These are pre-production operating instructions and qualification expectations. There is no approved signed release or certified host yet. Verify the exact environment and limitations in QUALIFICATION.md before any real-work use.

For **0.2.2 local development testing**, start with [FIRST_TEST.md](FIRST_TEST.md). The signed-install procedure below applies to future distribution. Current editing uses `ae_inspect` and exact-source `ae_execute`; the old proposal/raw-tool split is retired.

## Install And Activate

1. Obtain the approved matched CookieMonster installer and signed ZXP from the internal release owner. Verify their hashes, trusted publisher and compatibility mapping. No such approved pair is recorded yet.
2. Close AE and use the organization-qualified extension manager/version to install the signed ZXP. The manager and per-user/system installation scope must be recorded in the matrix; no manager is certified by these docs.
3. Explicitly install the trusted plugin package (keep `plugin.mjs` and `render-worker.mjs` together) and select the reviewed config using the consumer's documented loader. Fully quit and restart CookieMonster/OpenCode after installation so startup reloads the plugin/config; account for active jobs and resolve uncertain operations before quitting. Then open AE and the CookieMonster panel under Window > Extensions. This is a manual installation step, not an instruction for the agent to restart the current session.
4. The panel selects and retains a local identity automatically and authenticates using owner-only local connection metadata. No pairing code is required in normal operation.
5. Type into the AE chat panel to start or resume the project conversation. The first inspect/capture automatically binds the single connected target. With multiple AE instances, select the target with `ae_connections` and `ae_bind`; another conversation's ownership requires explicit takeover.
6. Save deliberately before mutation and review the exact script source in the normal permission prompt. Idle reconnection to the same project can resume on inspection; project changes and uncertainty require explicit recovery/selection.


For an invalid credential, install matching panel/plugin versions, obtain a fresh chat code and explicitly confirm credential recovery for the same profile. Identity, local uncertain latches and durable locks remain; recovery does not reconnect or rebind. Inspect AE before clearing a local latch, then reconnect, explicitly rebind and reconcile durable locks separately. Never delete profile/bridge state to bypass recovery.

If the panel is absent, check the signed installation receipt, exact AE/CEP versions, install scope and manifest compatibility with support. Do not disable signature checks, broaden the host manifest or enable CEP debug mode as a production workaround.

## Scripting Preference

The integration must detect and leave this preference unchanged. If file/network scripting is disabled, enable it deliberately in AE after reviewing the risks:

- Windows: Edit > Preferences > Scripting & Expressions > Allow Scripts to Write Files and Access Network.
- macOS: After Effects > Settings (or Preferences on the qualified version) > Scripting & Expressions > Allow Scripts to Write Files and Access Network.

Reopen/reconnect the panel and recheck capability status. Exact menu wording is a manual qualification item per AE point version. Disable only affected capabilities; a disabled preference is not permission to silently modify user settings. In 0.2.2, `ae_execute` requires approval of each script and a current inspection revision. There is no separate Session raw-enable tool. Scripts are unsandboxed; managed filesystem grants do not restrict their external effects.

## Updates And Removal

Check both installed versions and the compatibility mapping before updating. Mutual version/link guidance is implemented and a mismatch stops automation. Approved internal update records, URLs and matched builds are still missing; a public source/release page is not an approved installer.

Release bindings and reconcile active jobs before an approved paired update. Explicit release purges ordinary Session audit details; functional holds needed for active jobs or recovery remain subject to retention and must not be purged with the audit history. Back up functional state through the documented application workflow, not by placing it in the installer. Compatible upgrades must retain necessary per-user pairing, verified checkpoints and active-job/crash-recovery records. Test this preservation on each qualified environment.

For rollback, the release owner supplies a previously approved matched installer/ZXP pair and verifies recovery-data schema compatibility. Do not blindly downgrade files with active jobs or unknown mutation outcomes. No approved rollback artifact exists yet.

To uninstall, stop new work, resolve or deliberately cancel tracked jobs, release bindings, unpair/rotate credentials, close the panel and remove the extension through the same qualified manager. The desktop owner removes the AE plugin entry without replacing other plugins or browser permissions. Preserve user projects and needed recovery copies; delete credentials and remaining functional data only after explicit confirmation that no recovery/job requires them. Never recursively delete a project directory.

## Checkpoints And Storage

The target default is a visible `CookieMonster Checkpoints` folder beside the saved project. Each checkpoint needs identity, plan, timestamp, size and verification metadata. If project-side storage fails, the per-user fallback must warn that the recovery copy does not travel with the project. UI-reported storage location is authoritative; platform data paths are implementation-owned, not guessed here.

Retention target: at most 10 unpinned copies or 5 GB per project, pruning oldest unpinned entries while respecting functional recovery/job holds. Pin required copies. Manual restore requires explicit confirmation, a verified backup of current dirty work and guarded publication to the canonical path; the displaced original is retained at `originalPath`. Publication is not crash-atomic. Keep separate external project backups; checkpoints are not archival backups.

Additional asset/output paths require exact or recursive Session/binding-scoped grants. An exact-folder write grant permits direct-child writes, not arbitrary descendant writes. Sources stay read-only; imports reuse matching interpreted footage rather than changing its interpretation. SMB shares and managed sync folders are unsupported until their exact provider/server/client combination is qualified for canonicalization and write/read behavior. Hydrate cloud files and confirm availability before use; do not assume an online placeholder is a local file. If network-side checkpointing fails, inspect the reported local fallback and recovery warning rather than repeatedly retrying writes.

## Uncertain Outcomes

On timeout, modal blocking, disconnect during mutation or failed rollback, do not retry the action. Raw-script errors also leave the outcome uncertain and locked. Keep automation suspended, inspect the reported outcome and checkpoint verification, and use `ae_reconcile` to review actual evidence.

`ae_execute` in 0.2.2 never automatically rolls back or retries a script. It retains a verified pre-script checkpoint and locks on uncertain outcomes; inspect partial changes and reconcile deliberately. The older structured-operation rollback implementation remains internal for regression/recovery compatibility, but is not the current chat editing path. Historical #5/#12 structured-plan acceptance does not qualify script execution.

Approved manual restore first saves dirty work to a private emergency project and verifies a protected current-state checkpoint. It then attempts guarded canonical publication and snapshot-checked close/reopen, retaining the displaced original. Confirmed canonical restore does not require Save As/rebind. If publication fails and freshness guards still hold, a private verified recovery copy is opened without overwriting original bytes, retained at the canonical path or `originalPath`; automation stays locked. Review it, deliberately Save As, explicitly rebind and reconcile before resuming. A failed freshness guard does not authorize opening fallback over newer edits.

Results disclose the recovery path, `emergencyPath`, current-state checkpoint ID and displaced `originalPath` when present. Preserve these files and holds on errors/timeouts; an uncertain host call is never retried. Publication is guarded, not crash-atomic, so inspect both canonical and displaced paths after interruption rather than assuming either outcome.

## Render Recovery

Use `ae_render_list` for scoped discovery. After release or restart, `ae_render_recover` requires explicit `ask` approval to recover/reclaim access; `ae_render_status` and `ae_render_result` defaulting to `allow` do not bypass that requirement or grant access to another project's jobs.

A corrupt manifest with known scope exposes safe metadata with an unknown state and no outputs. Corruption whose scope cannot be established is reported only as an aggregate count, not per-job metadata. Preserve the damaged files and manually restore the manifest from trusted evidence before process control; a count or partial metadata is not authorization to reconstruct identity, reclaim or kill a process.

PID alone does not establish process identity. Unknown progress remains unknown; only verified expected output is a deliverable. Keep partial output quarantined or untouched while its outcome is uncertain. Never kill an unrelated process or delete output solely because a stale manifest mentions it.

`ae_render_retire` is ask-only: review the removal/preservation inventory before approving permanent retirement. Only proven-owned artifacts of a confirmed terminal, quiescent job qualify. Recovery records, logs, private checkpoints and staging/quarantined partials may be removed; published outputs, shared source checkpoints and another job's reservation stay untouched. Status/control/recovery for a retired job are no longer available. Claims require the same volume as private recovery storage; cross-volume retirement refuses, with no copy/delete fallback.

Interrupted retirement preserves remaining artifacts/claims and the durable plan; that plan is evidence, not authorization. Status reports `unknown` / `render_retire_partial` with `manual_retirement_recovery_required`, including a corrupt plan or missing manifest. There is no automatic cleanup or process control:

1. Stop render services before manual inspection.
2. Verify original and claimed object identities against the plan and trusted evidence. Preserve every mismatch; missing claims do not prove deletion.
3. Restore only to vacant paths under verified parents, or explicitly remove only proven-owned remnants. Never overwrite a replacement or replay the plan.
4. Resolve the interrupted state manually and obtain a fresh preview/approval to retry retirement.

The per-job socket gate isolates busy jobs; contention may delay a call up to 30 seconds, and the owning process's exit releases the socket. Do not delete recovery state to bypass it. Private storage is assumed trusted against same-user/admin mutation; these guards do not provide isolation from such actors.

## Host Limitations

**Capture:** request an explicit composition/time through `ae_capture` with the panel visible and AE idle. PNG preserves alpha; JPEG composites on black. The native host dispatches once, then CEP waits up to 10 seconds for a complete PNG and up to 10 seconds for image decoding. A pending PNG timeout preserves its temporary directory and retains local/durable uncertainty; do not retry until AE is idle and the outcome is reconciled. Successful output is bounded and the temporary directory is removed. AE 26.3 was tested live; the undocumented API and preview/modal behavior remain qualification limits.

Template discovery temporarily adds/removes a render-queue item and requires approval and a lock; existing terminal queue entries are allowed. The old structured action engine still has 64-action chunks and excludes `comp.reorder`. These action-schema rules do not constrain arbitrary scripts exposed by 0.2.2.

Historical 0.1.0 evidence: AE `b3a1fb3` passed 264 tests, 32 syntax checks and reproducible artifact verification; sibling desktop `a1e9efeff` passed packaged smoke with a render double. Those results do not describe the current refactor. See [current development evidence](FIRST_TEST.md#verification-record) and [historical integration evidence](INTEGRATION.md#final-smoke-evidence). Desktop and CLI are unsigned; full live AE/CEP, macOS/network qualification, approved signed releases and pilot sign-off remain absent.

## Support And Privacy

Review metadata diagnostic exports before sharing them. Diagnostics restrict timings to finite values under allowlisted names, use fixed error codes and report storage counts rather than arbitrary error text or stored content. Useful metadata includes versions, capability flags, hashes, storage mode and job state. Do not send client frames, projects, checkpoints, assets, prompts, raw scripts, credentials, usernames, project paths or network paths in automatic diagnostics. Explicit reports also require review. Approved internal update URLs remain `not_configured` (#15).

Provide exact matrix ID, build hashes, safe error code, operation type and whether the target is locked. Escalation requires a named support owner before pilot distribution; none is assigned here.
