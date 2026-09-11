# Compact restore validation, 11 September 2026

The implementation on `codex/chat-checkpoint-restore` replaces repeated full-scene restore inspection with `compact-restore-v1` receipts. Structured-action recovery keeps its existing full-scene checks. The original `RESTORE_HANDOFF.md` predates this implementation.

## Save As safety

Compact restore now rejects every Save As revision change at the host, bridge and workflow. A delta of one cannot distinguish a save-only increment from an intervening edit serialized by the save. The host retains the emergency file, latches uncertainty and refuses close or retry. The workflow does not publish the selected checkpoint over the canonical project after this failure.

The regression that edits a property immediately before serialization failed before this correction and passes afterward. Tests also cover a save-only increment, a larger increment, project replacement, dirty state and error callbacks. Successful compact restoration requires an unchanged revision. This deliberately blocks native AE versions or situations where Save As advances the revision.

These receipts are not a full scene-equivalence proof. Native revision coverage, callback/reentrancy behavior and successful 96-layer restoration remain unqualified. The native measurements below establish a refusal, not successful restoration. Existing successful results in `FIRST_TEST.md` concern the earlier implementation.

## Windows test environment

The inherited TEMP and TMP paths contain the short username `TIISET~1`. A disposable-directory probe showed ordinary `realpathSync` preserving that alias while `realpathSync.native` and async `realpath` expand it to `TiisetsoMosala`. Production storage correctly refuses noncanonical parent paths. No storage checks were relaxed.

Run from `D:\Workarea\CookieJar` in PowerShell:

```powershell
$env:TEMP = node -p "require('node:fs').realpathSync.native(require('node:os').tmpdir())"
$env:TMP = $env:TEMP
npm test
npm run check
npm run build
node scripts/verify-build.mjs
git diff --check
```

The environment changes apply only to that shell and its children.

## Earlier results

- Final full-suite command used the canonical environment above and `node --test --test-concurrency=4 test/*.test.mjs`. It completed 341 tests: 340 passed, one failed. All compact restore tests passed.
- The remaining failure was `uncertain termination quarantines partials but retains reservation` in `test/render.test.mjs`. It reported `unverified` instead of `quarantined_partial`. The exact case passed immediately in isolation with `node --test --test-name-pattern='uncertain termination quarantines' test/render.test.mjs`. Its underlying intermittent cause is unresolved; this is not a clean full-suite pass.
- The earlier default-concurrency run exposed the stale Save As warning assertion, which was updated, plus intermittent abort/persistence failures. Do not infer a confirmed Windows file-lock cause from those errors alone.
- `npm run check` passed all 40 script syntax checks. JSX was parsed by V8, not executed in AE.
- `npm run build` produced 12 unsigned artifacts. `node scripts/verify-build.mjs` passed inventory and SHA-256 verification. `git diff --check` passed with line-ending warnings.
- Full final-suite output is retained at `C:\Users\TiisetsoMosala\AppData\Local\Temp\cookiejar-final-limited-tests.log`.

## Native qualification boundary

The later native test used After Effects 26.3x87, PID 64784. Preflight confirmed the user's `AE Test Env/checkpoint testing.aep` was saved, clean and idle. A disposable composition with 96 layers and position keyframes was created, saved and inspected through the actual host code. The observed `app.onError` value was `undefined`; the host now accepts this native idle value while refusing active callbacks.

Measured native times: initial save 154 ms; Save As baseline 113 ms; restore preparation 113 ms; reopening the original project 367 ms. The baseline Save As incremented revision by one. Restore preparation also incremented revision and correctly refused before close, returning `uncertain_outcome`. It did not reach publication, reopen or a successful restore. The 96-layer payload did fit the compact inspection protocol.

The diagnostic initially called unsupported `log.flush()` and caused an AE error dialog. This was a diagnostic defect, corrected before the disposable test ran. The dialog was dismissed and the original project was reopened clean. Its SHA-256 before and afterward was `F3A3593778D750F88DD09CBEE8BC4C7342149B9CE4D0F01CA035EF44637CD335`. Local ignored evidence: `coverage/native-compact-qualification.txt` and `coverage/native-compact-qualification.jsx`.

The compact redesign is not native-release-ready. Do not allow a one-step revision increase without a proof that distinguishes saving from an intervening edit. Successful native restore, recovery of unsaved markers and live chat reconnection remain outstanding.

## Panel completion checks

- Implemented bounded inert Markdown rendering, cursor-based earlier history, entire older-exchange collapsing and persistence scoped to project/conversation.
- Automated panel and Markdown tests passed 18/18, including panel reload persistence and project isolation.
- Real Edge browser checks passed for formatting, history loading, disclosure state across polling and fixed-bottom composer layout at 420×780, 320×500 and 700×1000. This uses a mocked chat API, not a live CEP session.
- Syntax checks passed for 43 scripts. The unsigned build produced 14 artifacts with verified SHA-256 inventory, including Marked's license.
- The parallel full suite completed 348 tests: 342 passed and 6 failed. One failure was a missing Marked dependency in the isolated build-test fixture, now corrected. Other failures involved persistence, a render job gate and an expired binding. A serial rerun is recorded separately below; these causes are not assumed to be fixed merely by reducing concurrency.
- The serial rerun completed 348 tests: 347 passed, one failed with `storage_failed` during bridge persistence. Parallel-run output included Windows `EPERM` from atomic state replacement. Bridge persistence now uses the same bounded rename retry as the render journal for Windows sharing errors, without unlinking the destination. Two injected-failure tests passed: transient errors eventually persist the lock, and exhausted retries preserve old disk state and disable automation. This does not establish which external reader caused the observed conflict.
- Final full suite after the persistence correction: **351/351 passed**, no skips, using canonical TEMP/TMP and `node --test --test-concurrency=4 test/*.test.mjs` (265.4 seconds). Output: `%LOCALAPPDATA%/Temp/cookiejar-persistence-fixed-tests.log`. Final syntax checks, reproducible rebuild, 14-artifact inventory and installed-panel hashes passed. This supersedes the earlier automated results, but does not qualify native restore.
- Updated development panel installed with previous version retained outside the extensions directory. AE and CookieMonster must reload the matching panel/plugin. No signing identity is configured, and no signed release was produced.
