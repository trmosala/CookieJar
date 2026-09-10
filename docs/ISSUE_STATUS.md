# Current roadmap — 10 September 2026

The previous open issues (#7, #15, #16, #17) were closed as superseded at the user's request, not as evidence that all release qualification work is complete.

Implementation order:

1. [#18 Attach references in AE chat](https://github.com/trmosala/CookieJar/issues/18)
2. [#19 Select model and reasoning inside AE](https://github.com/trmosala/CookieJar/issues/19)
3. [#20 Restore project state from chat checkpoints](https://github.com/trmosala/CookieJar/issues/20)
4. [#21 Reuse brand and animation skills in AE](https://github.com/trmosala/CookieJar/issues/21)

Image generation/import is excluded because its current limitation belongs in CookieMonster. Current live-test evidence is in [FIRST_TEST.md](FIRST_TEST.md).

## Historical issue ledger (statuses below are from the earlier milestone)

# Issue Acceptance Status

**Historical ledger:** the September 9 closures and acceptance statements below describe 0.1.0. The 0.2.0 development refactor replaces public structured proposals/raw gates with approved script execution and adds experimental native capture. It has not requalified these issue acceptances. See [current setup and evidence](FIRST_TEST.md); no new GitHub status is claimed here.

Snapshot: 2026-09-09. GitHub closures are confirmed for #1, #3, #5, #9, #11, #12 and #14, in addition to the six prior closures (#2, #4, #6, #8, #10, #13). **13 issues are closed; only #7, #15, #16 and #17 remain open**, with the gaps below.

User-approved acceptance updates are recorded on GitHub: #5/#12 permit rollback only after an acknowledged failure with a stopped host and unchanged relevant state; external edits and uncertain outcomes preserve backups and locks. #11 excludes unsupported `comp.reorder` but still requires supported layer reordering.

## Verification Evidence

Final AE source verification passed **264/264 tests, zero failures, skips or cancellations, in 613.0605642 seconds**; `npm run check` checked **32 scripts**; `npm run build` produced **11 hashed artifacts**; and `node scripts/verify-build.mjs --rebuild` passed manifest inventory, SHA256 and reproducibility verification. Verified AE source is committed as `b3a1fb3` (base `49ef591`), unchanged since verification; sibling desktop source is committed as `a1e9efeff` (base `fa0b443cd`). Both commits are local and unpushed.

Restore/credential and render-retirement P1/P2 findings, plus the desktop permission-override finding, were fixed and re-reviewed with no remaining concrete findings in those scoped reviews. Final refreshed Windows packaged smoke passed: four artifact hashes match across AE build, desktop staging and unpacked package; actual loader checks and detached-worker completion with a render double passed. Desktop verification passed 29 tests/142 assertions and typecheck; all 12 permission-precedence cases passed against each of the AE build and refreshed packaged artifact. See [final smoke evidence](INTEGRATION.md#final-smoke-evidence).

## Per-Issue Ledger

Implementation, automated tests and issue closure are not host certification. Actual AE/CEP behavior, saved-project reopen, macOS and network-storage qualification remain external.

| Issue | Implementation / evidence | Remaining acceptance / limitation |
| --- | --- | --- |
| [#1 Bundled plugins](https://github.com/trmosala/CookieJar/issues/1) | Closed. Sibling desktop staging/startup/packaging implemented via `CM_AE_ARTIFACT_DIR`; app-version metadata and additive browser policy preserved. Final refreshed Windows packaged smoke passed. | Not a live desktop user session or real AE render; signed distribution and host qualification remain under #16. |
| [#2 Pairing](https://github.com/trmosala/CookieJar/issues/2) | Closed previously. Authentication, expiry/replay and rotation tested; explicit profiles, legacy in-place reuse and confirmed invalid-credential recovery preserve identity/latches/locks. | Real CEP pairing/restart/mismatch UX and exact OS qualification; no automatic rebind. |
| [#3 Binding](https://github.com/trmosala/CookieJar/issues/3) | Closed. Exclusive binding, takeover, release/rebind, project changes and epoch/project/owner guards tested and reviewed. | Real AE identity/status and Session lifecycle qualification. |
| [#4 Inspection](https://github.com/trmosala/CookieJar/issues/4) | Closed previously. IDs, locators, fingerprints and stale targets tested with AE doubles. | Real saved-project reopen, missing/reordered effects and large projects. |
| [#5 Transactions](https://github.com/trmosala/CookieJar/issues/5) | Closed. Immutable plans, approvals, checkpoints and guarded full-plan rollback tested under the approved stopped-host/unchanged-state acceptance. | External edits/timeouts preserve verified backups and locks; real AE interruption/recovery qualification remains. |
| [#6 Imports/grants](https://github.com/trmosala/CookieJar/issues/6) | Closed previously. Source immutability, path protections, interpreted-footage reuse and exact-folder direct-child writes tested. | Real imports and exact SMB/managed-sync provider/server/client qualification. |
| [#7 Capture](https://github.com/trmosala/CookieJar/issues/7) | Open. **Unavailable:** `ae_capture` always returns `unsafe_state`; no reliable preview/modal signal exists. | Reliable safety signal plus real capture/queue/indicator/attachment qualification. Normalization tests are not working capture. |
| [#8 Raw scripting](https://github.com/trmosala/CookieJar/issues/8) | Closed previously. Deny defaults, visible source, Session enablement, expiry and single use tested. | Errors remain uncertain and locked; real permission UI/host risk qualification. |
| [#9 Checkpoints](https://github.com/trmosala/CookieJar/issues/9) | Closed. Verified dirty backup precedes guarded canonical restore; displaced `originalPath` retained. Private recovery-copy fallback preserves original bytes and locks; paths disclosed. Storage/restore/reconcile tested and reviewed. | Publication is not crash-atomic; fallback needs deliberate Save As, rebind and reconciliation. Real dirty-work/reopen/storage-failure qualification remains. |
| [#10 Effects](https://github.com/trmosala/CookieJar/issues/10) | Closed previously. Effect actions, missing-effect preservation, stale locators and installed disabled-effect enablement tested. | Exact effect versions, licensing/modal failures and real rollback. |
| [#11 Composition edits](https://github.com/trmosala/CookieJar/issues/11) | Closed. Supported actions, including layer reordering, tested without a total action-count cap. Approved scope explicitly excludes/refuses `comp.reorder`. | Real multi-layer editing/deletion/recovery qualification. |
| [#12 Animation](https://github.com/trmosala/CookieJar/issues/12) | Closed. Property/keyframe/expression actions and 64-action chunks tested without a total cap; approved guarded rollback retains edits/backups/locks on uncertainty. | Real interpolation/markers/expressions and recovery qualification. |
| [#13 Rendering](https://github.com/trmosala/CookieJar/issues/13) | Closed previously. Checkpoints, approved template discovery, grants, outputs and process checks tested; terminal queue entries allowed. | Real aerender templates, cancellation and verified outputs on Windows/macOS. |
| [#14 Render recovery](https://github.com/trmosala/CookieJar/issues/14) | Closed. Durable recovery and ask-only reclaim/retirement tested and reviewed. Retirement requires proven terminal/quiescent ownership, approved inventory and same-volume claims; outputs/shared checkpoints preserved. | Interrupted retirement, corrupt plans or missing manifests require manual recovery, never plan replay or automatic cleanup/control; see [operations](OPERATIONS.md). Real aerender qualification remains. |
| [#15 Diagnostics](https://github.com/trmosala/CookieJar/issues/15) | Open. Metadata-only diagnostics and mutual software version/link guidance implemented; release purges ordinary audit details but preserves functional holds. | Approved internal update records/URLs/builds remain `not_configured`. Public source is not an approved installer; real preference/status qualification remains. |
| [#16 Package/certify](https://github.com/trmosala/CookieJar/issues/16) | Open. Plugin, worker and panel built; 11 hashed artifacts passed inventory/SHA256 reproducibility checks; refreshed Windows package smoke passed. Signing wrapper, CI and qualification docs exist. | Desktop and CLI are unsigned. Requires approved signed installers/ZXP, an agreed exact Windows/macOS/AE/CEP/storage matrix and actual manual qualification. |
| [#17 Closed pilot](https://github.com/trmosala/CookieJar/issues/17) | Open. Planned only; no artists recruited or sessions executed. | Blocked by #16, then requires a real cohort, named support owner, consent, executed pilot and production sign-off. |

## Release Truth

Verified artifacts include `dist/cm-ae/plugin.mjs`, companion `dist/cm-ae/render-worker.mjs` and `dist/panel`. `compatibility.json` remains `certifiedEntries: []`, `signed: false`, without approved release artifacts or an approved CookieMonster build; AE 25/26 are candidates only. The smoke verified actual Electron `app.getVersion()` as `1.18.27` in AE compatibility, not release approval. Desktop and CLI remain unsigned. Live AE/CEP, macOS/network qualification, signed distribution and pilot execution are not established by automated tests, packaged smoke or issue closure.
