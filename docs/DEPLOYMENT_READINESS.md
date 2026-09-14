# 0.2.3 deployment readiness

Status: **blocked for client deployment**. The candidate is unsigned and no environment is certified. This report distinguishes implemented fixes from the remaining release evidence.

## Implemented

- Conversation retirement survives replacement, deletion and restart. Delayed submissions check conversation identity before dispatch; deletion during admission aborts through the captured CM connection. CM remains the owner of conversation content.
- An uncertain submission blocks new request IDs across restart. Looking up the same ID never resends it. Reconciliation rejects outstanding admission, requires explicit review of an unknown delivery, and clears only that reviewed request ID.
- HTTP bodies are received under size limits and an explicit five-second deadline outside the bridge transition queue. An incomplete pairing request cannot hold up heartbeats. Credentials and transition state are checked again after admission.
- Render cleanup uses the existing process-held job lock. A verified terminal job can recover an empty legacy release marker or an interrupted owned reservation cleanup; foreign files and reservations are preserved.
- New render jobs use an immutable `g2-` ID namespace and a gate range outside this machine's outbound TCP pool. Existing job IDs retain their original gate so old supervisors remain coordinated. A regression holds the former port occupied and proves both new-job isolation and legacy-gate compatibility. Occupied gates still fail closed without contacting or killing another listener.
- Checkpoint preflight checks capacity and free space before save/restore. It counts both restore backups and all retained protections. Automatic checkpoints are temporarily protected rather than permanently pinned; confirmed operations, safe pre-dispatch failures and reviewed script reconciliation release their own hold. Explicit pins and other owners are preserved.
- The test runner canonicalizes Windows temporary paths and bounds test-file concurrency. Plugin and panel versions are both 0.2.3.
- The client build profile compiles explicit script approval into the plugin and packages matching permissions. Development defaults remain unchanged. Both the client runtime and config preparation refuse matching wildcard, nested, agent/mode or legacy tool auto-allow rules. This prevents CM permission precedence from silently bypassing review.

Disk preflight uses the current on-disk project size plus save/restore copies and a metadata reserve. AE's eventual serialized size and concurrent external disk consumption cannot be reserved by this check; creation still repeats integrity and quota checks. Old pins are not guessed to be automatic or silently removed. Uncertain recovery files remain protected.

## Reproduce and prepare

```powershell
npm ci --ignore-scripts
npm test
npm run check
node scripts/build.mjs --client
node scripts/verify-build.mjs --rebuild
node scripts/merge-config.mjs existing-config.json dist/cm-ae/plugin.mjs reviewed-config.json --client
```

The merge creates a new file only, preserves unrelated permissions and stricter script denial, and does not change a running consumer. Check the resulting configuration and matching panel/plugin hashes before installing the pair. Builds do not install, sign or publish.

## Evidence and open gates

Local validation uses Windows 11 Enterprise 10.0.26200, Node 26.8.1 and Bun 1.3.14. Automated AE tests use doubles unless expressly marked native. The observed installed CookieMonster is 1.18.27; its binaries are fingerprinted in the candidate receipt, not certified by that fingerprint.

The first full hardening run reported 369/375 passing: five outdated permanent-pin expectations and one intermittent restore abort. The pin expectations were updated to assert protection and retention behavior. Focused review regressions cover delayed deletion, immutable delivery review, capacity counts, safe abort cleanup and reviewed cleanup. Later validation results are recorded in the final evidence below.

The restore interruption was traced to Windows `EPERM` while publishing the panel recovery latch. A real file-sharing regression reproduced `aborted`; the panel now retries only local metadata publication and stays locked if it cannot persist the latch. See the follow-up investigation for causal evidence and validation. Gate failures retain the original OS error code and port for diagnosis while continuing to fail closed.

The initial instrumented run did not reproduce the failure. A later run captured the local publication error before reconnection, distinguishing it from a network failure. The final correction targets the recovery latch; descriptor-read handling remains unchanged.

Subsequent full runs failed render startup on a gate that was unavailable or occupied. The old gate range exactly overlapped this machine's dynamic outbound range, 49152–65535. A deterministic occupied-port regression reproduced that conflict and passes with new jobs using 16384–32767. This removes the demonstrated conflict with the observed outbound pool; availability still needs checking on client machines with custom ranges, exclusions or other listeners. The old logs did not capture the specific competing socket. A separate excluded-port probe acquired successfully, so port exclusion was not established as the cause.

After initial preflight refusals, the user authorized saving the open project. Native canonical restore with the final latch fix passed on AE 26.3x87 in 42.345 seconds. It verified the 96-layer scene, checkpoint bytes, preservation of the unsaved test edit in recovery storage, lock release and return to the user's original project with its post-save hash unchanged. Evidence is `coverage/native-restore-wgX5Lu/report.json`. This source-tree CLI run does not qualify native fallback restore or installed CEP chat with a live CM/model.

Release requires:

1. Qualify the revised recovery-latch publication and render gate under client load.
2. Complete remaining native disposable-project tests and installed CEP/live CM tests against the exact candidate pair. Verify inspection, approval/denial, editing, reconnect, uncertainty, fallback restore, capture and render recovery.
3. Confirm the client's exact Windows/AE/CM versions and storage topology; test cloud or network storage separately if used.
4. Sign with the organization's real certificate, verify the installed signature and hashes, and retain the previous matched pair for rollback. Signing tooling/certificate credentials are not configured in this environment.
5. Complete the named pilot and release approval. The candidate receipt must remain blocked until those records exist.

Rollback means restoring the previous matched panel/plugin package and consumer configuration after stopping work and reviewing recovery state. Schema-2 chat safety state is not backward compatible with the old raw-map reader: do not point the old plugin at upgraded state or discard retirement tombstones to make it load. Old renderers cannot manage new `g2-` jobs. Finish or reconcile those jobs before downgrading, or retain the matching renderer to manage them. Preserve the upgraded state and backups; qualify migration/rollback on disposable data before pilot installation.

## Final evidence

Follow-up restore investigation: [RESTORE_INVESTIGATION.md](RESTORE_INVESTIGATION.md).
The recovery-latch fix passed **393/393 tests**, zero failures, in 392.58 seconds
in `coverage/restore-final-acceptance.log`. Seven regressions cover real Windows
file sharing, durable-latch failures, bounded retries and newer recovery warnings.

Earlier hardening full-suite run: **386/386 passed**, zero failures, 383.08 seconds, recorded in `coverage/deployment-release-check.log`. The additional case-folded gate check passed in `coverage/gate-case-final.log`. Earlier failures remain preserved in `deployment-full.log`, `deployment-final.log` and `deployment-acceptance.log`; the instrumented rerun is `deployment-trace.log`. The later investigation established the recovery-latch cause using a spontaneous causal trace and a failing filesystem regression.

`npm run check` parsed 48 scripts successfully. `node scripts/build.mjs --client` and `node scripts/verify-build.mjs --rebuild` verified 14 hashed artifacts and a byte-for-byte reproducible client build. The actual compiled client policy rejected wildcard, agent and legacy auto-allow, and retained denial; the persistent compiled-plugin regression also passes. `npm audit --omit=dev --json` reported zero known vulnerabilities in the installed dependency graph.

Changes are isolated on `codex/deployment-hardening` in `D:/Workarea/CookieJar-deployment`. The live source checkout, installed panel and consumer configuration were not changed. With user authorization, the open AE project was saved before native qualification and reopened afterward. Raw local evidence remains under `coverage/`; the unchanged unsigned candidate receipt records the earlier source commit, exact input hashes, artifact hashes, observed consumer binaries and outstanding gates. The later native evidence is recorded separately above. No client deployment has been performed.
