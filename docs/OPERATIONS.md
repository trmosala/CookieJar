# Installation And Recovery

These are pre-production operating instructions and qualification expectations. There is no approved signed release or certified host yet. Verify the exact environment and limitations in QUALIFICATION.md before any real-work use.

## Install And Activate

1. Obtain the approved matched CookieMonster installer and signed ZXP from the internal release owner. Verify their hashes, trusted publisher and compatibility mapping. No such approved pair is recorded yet.
2. Close AE and use the organization-qualified extension manager/version to install the signed ZXP. The manager and per-user/system installation scope must be recorded in the matrix; no manager is certified by these docs.
3. Explicitly install the trusted plugin package (keep `plugin.mjs` and `render-worker.mjs` together) and select the reviewed config using the consumer's documented loader. Fully quit and restart CookieMonster/OpenCode after installation so startup reloads the plugin/config; account for active jobs and resolve uncertain operations before quitting. Then open AE and the CookieMonster panel under Window > Extensions. This is a manual installation step, not an instruction for the agent to restart the current session.
4. Request `ae_pair` in chat and enter the short-lived code only in the local panel. Never attach pairing codes or credential files to support tickets.
5. List connections and explicitly bind a saved project. Inspect unsaved projects only; save deliberately before mutation. Review proposals and normal generic permission prompts before execution.

If the panel is absent, check the signed installation receipt, exact AE/CEP versions, install scope and manifest compatibility with support. Do not disable signature checks, broaden the host manifest or enable CEP debug mode as a production workaround.

## Scripting Preference

The integration must detect and leave this preference unchanged. If file/network scripting is disabled, enable it deliberately in AE after reviewing the risks:

- Windows: Edit > Preferences > Scripting & Expressions > Allow Scripts to Write Files and Access Network.
- macOS: After Effects > Settings (or Preferences on the qualified version) > Scripting & Expressions > Allow Scripts to Write Files and Access Network.

Reopen/reconnect the panel and recheck capability status. Exact menu wording is a manual qualification item per AE point version. Disable only affected capabilities; a disabled preference is not permission to silently modify user settings. Raw scripting remains disabled until explicitly enabled for the current bound Session, and default config policy denies raw tools.

## Updates And Removal

Check both installed versions and the compatibility mapping before updating. A mismatch must hard-stop automation and show update guidance. The repository release links are placeholders for distribution coordination; the real CookieMonster internal link and approved build are still unassigned.

Release bindings and reconcile active jobs before an approved paired update. Explicit release purges ordinary Session audit details; functional holds needed for active jobs or recovery remain subject to retention and must not be purged with the audit history. Back up functional state through the documented application workflow, not by placing it in the installer. Compatible upgrades must retain necessary per-user pairing, verified checkpoints and active-job/crash-recovery records. Test this preservation on each qualified environment.

For rollback, the release owner supplies a previously approved matched installer/ZXP pair and verifies recovery-data schema compatibility. Do not blindly downgrade files with active jobs or unknown mutation outcomes. No approved rollback artifact exists yet.

To uninstall, stop new work, resolve or deliberately cancel tracked jobs, release bindings, unpair/rotate credentials, close the panel and remove the extension through the same qualified manager. The desktop owner removes the AE plugin entry without replacing other plugins or browser permissions. Preserve user projects and needed recovery copies; delete credentials and remaining functional data only after explicit confirmation that no recovery/job requires them. Never recursively delete a project directory.

## Checkpoints And Storage

The target default is a visible `CookieMonster Checkpoints` folder beside the saved project. Each checkpoint needs identity, plan, timestamp, size and verification metadata. If project-side storage fails, the per-user fallback must warn that the recovery copy does not travel with the project. UI-reported storage location is authoritative; platform data paths are implementation-owned, not guessed here.

Retention target: at most 10 unpinned copies or 5 GB per project, pruning oldest unpinned entries while respecting functional recovery/job holds. Pin required copies. Manual restore requires explicit confirmation and preservation of current dirty work. It always opens a verified recovery copy rather than restoring in place to the canonical path. Compare the recovered project, use Save As deliberately and explicitly rebind before further mutation. Keep separate external project backups; checkpoints are not archival backups.

Additional asset/output paths require exact or recursive Session/binding-scoped grants. An exact-folder write grant permits direct-child writes, not arbitrary descendant writes. Sources stay read-only; imports reuse matching interpreted footage rather than changing its interpretation. SMB shares and managed sync folders are unsupported until their exact provider/server/client combination is qualified for canonicalization and write/read behavior. Hydrate cloud files and confirm availability before use; do not assume an online placeholder is a local file. If network-side checkpointing fails, inspect the reported local fallback and recovery warning rather than repeatedly retrying writes.

## Uncertain Outcomes

On timeout, modal blocking, disconnect during mutation or failed rollback, do not retry the action. Raw-script errors also leave the outcome uncertain and locked. Keep automation suspended, inspect the reported outcome and checkpoint verification, and use `ae_reconcile` to review actual evidence.

Automatic rollback is separate from manual restore: stopped, acknowledged structured-operation errors may roll back using a verified emergency checkpoint, atomic snapshot-checked close/reopen and an unchanged, hash-matched canonical project. A timeout or intervening manual edit leaves the operation locked instead; do not assume every error restores the project.

For manual recovery, preserve the original and recovery files and deliberately save current dirty work to a separate safe path before opening the verified recovery copy. Manual restore always requires Save As and explicit rebind, even when the canonical path is available. An error, a timeout or a tool's mere return is not proof of successful restoration.

## Render Recovery

Use `ae_render_list` for scoped discovery. After release or restart, `ae_render_recover` requires explicit `ask` approval to recover/reclaim access; `ae_render_status` and `ae_render_result` defaulting to `allow` do not bypass that requirement or grant access to another project's jobs.

A corrupt manifest with known scope exposes safe metadata with an unknown state and no outputs. Corruption whose scope cannot be established is reported only as an aggregate count, not per-job metadata. Preserve the damaged files and manually restore the manifest from trusted evidence before process control; a count or partial metadata is not authorization to reconstruct identity, reclaim or kill a process.

PID alone does not establish process identity. Unknown progress remains unknown; only verified expected output is a deliverable. Keep partial output quarantined or untouched while its outcome is uncertain. Never kill an unrelated process or delete output solely because a stale manifest mentions it.

## Host Limitations

**Capture is unavailable:** `ae_capture` always returns `unsafe_state` on the current host path because reliable preview/modal detection is unavailable. Normalization and attachment tests do not establish capture; do not bypass this safety refusal.

Template discovery temporarily adds/removes a render-queue item and requires approval and a lock; existing terminal queue entries are allowed. An exactly identified, installed but disabled effect may be enabled while protecting its stored data. Property execution uses 64-action chunks without a total action-count cap. `comp.reorder` is unsupported by the documented AE native API.

The parent reports final-source verification clean: 182/182 tests with zero failures, skips or cancellations in 246.2576849 seconds, 32 script checks, 11 hashed artifacts and successful manifest inventory/SHA256 reproducibility verification. All original five safety-review findings, seven acceptance-review findings and final three findings were fixed and rechecked, with no remaining concrete P1/P2 findings in those targeted reviews; see [issue status](ISSUE_STATUS.md). Actual AE execution, saved-project reopen, macOS and network-storage behavior remain unqualified. Desktop consumer integration, approved signed ZXP/desktop releases, exact OS/AE/CEP/storage qualification and real pilot/sign-off remain pending. All 17 issues remain open and remotely unchanged. No live AE run was attempted; no commits, pushes or deployment were performed by this workstream.

## Support And Privacy

Review metadata diagnostic exports before sharing them. Diagnostics restrict timings to finite values under allowlisted names, use fixed error codes and report storage counts rather than arbitrary error text or stored content. Useful metadata includes versions, capability flags, hashes, storage mode and job state. Do not send client frames, projects, checkpoints, assets, prompts, raw scripts, credentials, usernames, project paths or network paths in automatic diagnostics. Explicit reports also require review. Approved update URLs remain unassigned.

Provide exact matrix ID, build hashes, safe error code, operation type and whether the target is locked. Escalation requires a named support owner before pilot distribution; none is assigned here.
