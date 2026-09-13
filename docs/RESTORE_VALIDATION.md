# Restore validation, 13 September 2026

## Change

`compact-restore-v2` saves current work to its existing path. Native AE 26.3x87 probes found that clean and dirty in-place saves leave the project revision unchanged, while Save As increments it by one. The v1 implementation correctly rejected that ambiguous increment, making native restore unusable. V2 avoids Save As and still rejects every revision change during saving.

The restore operation now:

1. Reviews the exact project, checkpoint, destination disk identity and compact native receipt.
2. Preserves and verifies a pinned checkpoint of the previous disk file before saving.
3. Saves in place, verifies native project identity, epoch, unchanged revision, clean state and idle callbacks, then copies the saved file to a private emergency path.
4. Creates and verifies a protected current-state checkpoint. Its SHA-256 must match both the emergency copy and canonical file.
5. Publishes the selected checkpoint against the post-save disk identity, rechecks the native receipt and closes/reopens the project once.
6. Verifies the opened project, file hash and fresh receipt before clearing the lock. Returns `previousCheckpointId`, `currentCheckpointId` and retained file paths, and records them in chat restore history.

These backups have different meanings: `previousCheckpointId` preserves what was on disk before restoration began; `currentCheckpointId` includes current unsaved edits. Both belong to the canonical project, so its checkpoint list can show them. The emergency file is an additional copy of current work.

If canonical publication fails, the canonical file contains the newly saved current work. The older disk version remains in `previousCheckpointId`. A verified recovery copy may open, but automation remains locked until explicit reconciliation. Save errors, failed copies, stale state and missing acknowledgements never authorize automatic close or retry. Failed operations retain protected checkpoints.

V1 and V2 host/plugin receipts are intentionally incompatible. Reload the matching host and plugin together. No complete scene traversal or larger transport limit was introduced.

## Reproduction and regression coverage

Before the fix, `node --test --test-name-pattern='native Save As revision behavior' test/workflow.test.mjs` failed with `outcome_uncertain`. The same test now completes a restore through production HTTP bridge, panel transport, host source and checkpoint storage with AE objects simulated. It asserts that no Save As occurs, the selected bytes return and the unsaved marker survives in the current-state backup.

Additional regressions cover serialized edits during saving, any in-place revision increment, native save errors, false/throwing copy results, corrupted emergency bytes, edits during copy or before close, stale approvals, same-path project reopen, foreign ownership, missing/late replies, fallback and replay prevention. The large-scene test restores a file over 4 MiB containing over 28,000 simulated properties while forbidding scene traversal.

Final automated run: **360 passed, zero failed or skipped**, using canonical TEMP/TMP and `node --test --test-concurrency=4 test/*.test.mjs` in 341.3 seconds. Log: `coverage/restore-full-live-final.log`. The separate panel integration run passed all four reported tests, including canonical and fallback restores. Syntax checks passed for 45 scripts; reproducible rebuild and all 14 artifact hashes passed. `git diff --check` passed.

The verified unsigned development panel was installed at `%APPDATA%/Adobe/CEP/extensions/com.cookiemonster.ae`. The previous panel is retained at `%APPDATA%/Adobe/CEP/cookiemonster-backups/e0ef1a59-3e70-4c7f-8027-c43a79d7bcc9`. The matching plugin build is in `dist/cm-ae`. Both applications were restarted on 13 September; the updated panel connected automatically. Logs: `coverage/restore-syntax.log`, `coverage/restore-build-verify.log`, `coverage/restore-install.log`.

## Native and installed-panel qualification

The native probe reproduced the v1 failure and confirmed v2 restore preparation succeeds on AE 26.3x87. This is preparation evidence, not proof of successful close/reopen or installed CEP chat restoration.

The first full native runner attempt could not initialize protected storage under the workspace drive, before any restore operation. The runner now initializes its runtime under canonical local temporary storage before creating the disposable project. A second attempt completed two compact inspections through the native bridge, then a third inspection timed out without a native response. No `restore_prepare` or `restore_finish` command was dispatched. The runner stopped without retry and retained the fixture, runtime data and replies at `coverage/native-restore-FDU1x7/report.json`. The user's original `AE Test Env/checkpoint testing.aep` still matched SHA-256 `f3a3593778d750f88dd09cbee8bc4c7342149b9ce4d0f01ca035ef44637cd335`. The disposable qualification project remains available for inspection; do not assume it was automatically closed after the timeout.

`scripts/verify-native-restore.mjs` exercises the production bridge, panel transport, workflow and storage against a disposable native 96-layer project. Run with a clean, saved project and idle AE:

```powershell
node scripts/verify-native-restore.mjs --run-live
```

The runner retains per-command scripts, native replies and a JSON report under `coverage/native-restore-*`. Private runtime/checkpoint storage uses a canonical local temporary directory. Successful completion verifies the restored scene and unsaved backup marker and returns the original project after checking its SHA-256. On failure it retains the disposable project and backups without retrying a host operation. This CLI adapter does not qualify the installed CEP UI or live model.

Native qualification passed on 13 September: `coverage/native-restore-s55SoM/report.json`, AE 26.3x87, 96 animated null layers, 1.3 MB project, 31.424 seconds through the CLI bridge. The run verified selected canonical bytes, cleared lock, restored scene, matching emergency/current backup hashes, reopened backup containing the unsaved composition marker and all 96 layers, and returned the original user project unchanged. A separate hash check verified the previous disk checkpoint matches the baseline. Backup storage fell back to private local storage because protected project-side storage was unavailable; these copies do not travel with the project.

The preceding runner failure was an assertion bug: AE reorders items on reopen, placing the renamed composition after the Solids folder. The backup contained the marker; the runner now locates the CompItem instead of assuming item 1. The earlier locked-session timeout displayed an AE second-script warning after unlock; restarting AE cleared it. No override flags were used.

Installed-panel acceptance passed on 13 September with the live CookieMonster Sol High model in session `ses_f66d6f0a9ffeG8fZCqe3Dyxb1G`:

- Pinned composition ID 1; the model inspected it, renamed only the top layer from `Layer 95` to `Panel restore test`, used `ae_execute`, and independently inspected the result. The enabled message restore action and checkpoint card referred to `a2caa6b1-ca9b-4c3b-9c5c-d85c064fb936`.
- Cancel left the exact project revision (2247), dirty state, layer name and canonical SHA-256 unchanged. Evidence: `coverage/panel-restore-before.txt` and `coverage/panel-restore-cancel.txt`.
- Confirm completed from 05:16:07 to 05:16:38 UTC. The panel reported completion with recovery checkpoint `c8bf09ca-98fc-47ae-9914-1ec460a30c2b` and previous disk checkpoint `fd22c353-3660-4b17-a591-bf86a57e5fa2`. The restored file matched the selected checkpoint, the native scene had 96 layers with `Layer 95` on top, and the project was clean.
- After restarting AE, the same conversation, composition pin and completed restore notice returned. A read-only follow-up used only `ae_inspect`, confirmed the restored name/count, and left the canonical SHA-256 unchanged. No earlier edit replayed.
- Both backups were opened in native AE: the current-state backup contained `Panel restore test`, and the previous disk backup contained `Layer 95`, each with 96 layers. The original user project was returned and still matched SHA-256 `f3a3593778d750f88dd09cbee8bc4c7342149b9ce4d0f01ca035ef44637cd335`.

Evidence: `coverage/panel-restore-live-report.json`, `coverage/panel-restore-after.txt`, `coverage/panel-native-backup-final.txt`, and `coverage/native-restore-s55SoM/report.json`. The live backups used protected local fallback storage, not project-side storage.

The first live model request failed because WPP required sign-in, before any AE edit. The user signed in, and the subsequent request completed. The panel had remained on stale working state; its refresh path now catches rendering/refresh failures and releases the polling latch so subsequent polls recover. An injected rendering failure reproduced the latch problem and now passes alongside all 20 panel-chat tests. The exact original rendering exception was not captured. The updated panel was rebuilt, hash-verified and installed; previous panel retained at `%APPDATA%/Adobe/CEP/cookiemonster-backups/e9c5f982-5d69-4f54-86d4-7552650f9c09`.


The extension remains an unsigned development build. Native revision coverage for every AE feature and compatibility across other AE versions are not established by these tests.
