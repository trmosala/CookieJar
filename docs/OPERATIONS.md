# Installation And Recovery

These are pre-production operating instructions and qualification expectations. There is no approved signed release or certified host yet. Verify the exact environment and limitations in QUALIFICATION.md before any real-work use.

## Install And Activate

1. Obtain the approved matched CookieMonster installer and signed ZXP from the internal release owner. Verify their hashes, trusted publisher and compatibility mapping. No such approved pair is recorded yet.
2. Close AE and use the organization-qualified extension manager/version to install the signed ZXP. The manager and per-user/system installation scope must be recorded in the matrix; no manager is certified by these docs.
3. Explicitly install the trusted plugin package (keep `plugin.mjs` and `render-worker.mjs` together) and select the reviewed config using the consumer's documented loader. Fully quit and restart CookieMonster/OpenCode after installation so startup reloads the plugin/config; account for active jobs and resolve uncertain operations before quitting. Then open AE and the CookieMonster panel under Window > Extensions. This is a manual installation step, not an instruction for the agent to restart the current session.
4. Select an explicit panel profile and reuse its exact name after reopening/restarting AE; simultaneous AE instances need distinct profiles. Select `legacy` only to reuse the previous shared pairing in place, not copy or migrate it.
5. Request `ae_pair` in chat and enter the short-lived code only in the local panel. Never attach pairing codes or credential files to support tickets.
6. List connections and explicitly bind a saved project. Inspect unsaved projects only; save deliberately before mutation. Review proposals and normal generic permission prompts before execution.

For an invalid credential, install matching panel/plugin versions, obtain a fresh chat code and explicitly confirm credential recovery for the same profile. Identity, local uncertain latches and durable locks remain; recovery does not reconnect or rebind. Inspect AE before clearing a local latch, then reconnect, explicitly rebind and reconcile durable locks separately. Never delete profile/bridge state to bypass recovery.

If the panel is absent, check the signed installation receipt, exact AE/CEP versions, install scope and manifest compatibility with support. Do not disable signature checks, broaden the host manifest or enable CEP debug mode as a production workaround.

## Scripting Preference

The integration must detect and leave this preference unchanged. If file/network scripting is disabled, enable it deliberately in AE after reviewing the risks:

- Windows: Edit > Preferences > Scripting & Expressions > Allow Scripts to Write Files and Access Network.
- macOS: After Effects > Settings (or Preferences on the qualified version) > Scripting & Expressions > Allow Scripts to Write Files and Access Network.

Reopen/reconnect the panel and recheck capability status. Exact menu wording is a manual qualification item per AE point version. Disable only affected capabilities; a disabled preference is not permission to silently modify user settings. Raw scripting remains disabled until explicitly enabled for the current bound Session, and default config policy denies raw tools.

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

Automatic rollback is separate from manual restore: acknowledged structured-operation errors may restore the entire pre-plan state only after the host is confirmed stopped and relevant state remains unchanged, using a verified emergency checkpoint and snapshot/hash guards. This is the approved #5/#12 acceptance. External edits, stale-state mismatches after mutation and timeouts preserve backups and recovery locks; do not assume every error restores the project.

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

**Capture is unavailable:** `ae_capture` always returns `unsafe_state` on the current host path because reliable preview/modal detection is unavailable. Normalization and attachment tests do not establish capture; do not bypass this safety refusal.

Template discovery temporarily adds/removes a render-queue item and requires approval and a lock; existing terminal queue entries are allowed. An exactly identified, installed but disabled effect may be enabled while protecting its stored data. Property execution uses 64-action chunks without a total action-count cap. Approved #11 scope excludes/refuses `comp.reorder`; supported layer reordering remains implemented.

Verified AE source is committed as `b3a1fb3` (base `49ef591`), unchanged since verification: 264/264 tests, zero failures/skips/cancellations in 613.0605642 seconds; 32 script checks; 11 hashed artifacts; manifest inventory/SHA256 reproducibility passed. Sibling desktop source is committed as `a1e9efeff` (base `fa0b443cd`); both commits are local and unpushed. Restore/credential, render-retirement and desktop permission-override findings were fixed and re-reviewed with no remaining concrete scoped findings. Final refreshed Windows packaged smoke passed, including four matching artifact hashes, actual loader checks and detached-worker completion with a render double; see [integration evidence](INTEGRATION.md#final-smoke-evidence). This was not a real AE render or a live desktop user session. Desktop and CLI are unsigned; live AE/CEP, saved-project reopen, macOS/network qualification, approved signed releases and pilot sign-off remain absent. See [issue status](ISSUE_STATUS.md): 13 confirmed closed issues; only #7, #15, #16 and #17 remain open.

## Support And Privacy

Review metadata diagnostic exports before sharing them. Diagnostics restrict timings to finite values under allowlisted names, use fixed error codes and report storage counts rather than arbitrary error text or stored content. Useful metadata includes versions, capability flags, hashes, storage mode and job state. Do not send client frames, projects, checkpoints, assets, prompts, raw scripts, credentials, usernames, project paths or network paths in automatic diagnostics. Explicit reports also require review. Approved internal update URLs remain `not_configured` (#15).

Provide exact matrix ID, build hashes, safe error code, operation type and whether the target is locked. Escalation requires a named support owner before pilot distribution; none is assigned here.
