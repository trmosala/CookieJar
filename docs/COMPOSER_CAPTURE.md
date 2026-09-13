# Attach the current composition frame

Use **Attach current frame** beside the attachment button in the composer. It captures the selected composition at the time reported by AE when clicked. Follow mode uses the active composition; a pinned target uses that composition's own time. The preview records the composition name, ID and time, and can be removed before sending. Later viewer or time changes do not change the attached image.

Capture uses PNG with alpha, up to 1200 pixels wide and 2000 pixels high. Captured frames share the existing four-file, 10 MiB total attachment budget. Nothing is attached if the remaining budget is insufficient. Sending uses the existing CookieMonster file-part path.

The panel must remain visible and the project must be saved, idle and owned by the current conversation. The button establishes a conversation binding without sending a model prompt. The authenticated capture engine retains its inspection, revision, capability, lock and PNG checks. Project changes discard stale responses. An ambiguous timeout requires recovery and never retries automatically. Capturing does not move the viewer or change composition time.

## Verification

Automated coverage exercises frozen pinned targets, changes during capture, stale project responses, attachment removal and sending, file count limits, uncertainty without retry, authenticated dispatch and idle binding without a prompt. Existing capture tests cover PNG validation, alpha, size limits, missing capability and capture-lock recovery.

The full AE suite passed 367 tests; the subsequent idle-binding and shared-byte-budget tests also passed (the final panel suite passed all 23 tests). Syntax checks and reproducible verification of all 14 artifacts passed. CookieMonster desktop bundle validation passed 22 tests, its typecheck passed, and all 12 permission-precedence scenarios passed.

On 13 September 2026, the installed visible CEP panel captured the real `Atom Hello` composition (#16) at 4.83333333333333 seconds as a 1080 x 1920 PNG. The preview showed the exact composition and time; removing it cleared the draft attachment. The viewer and timeline remained at the original frame. The qualification used real AE host execution, authenticated bridge transport and CEP canvas normalization with a simulated CookieMonster session service. No model prompt was sent. Native timeout and project-switch scenarios were not induced; those paths were tested automatically.

`node scripts/verify-native-capture.mjs --run-live` starts the opt-in isolated qualification bridge and prints its private data directory. A temporary test panel can point its automatic store there. Capture evidence goes under ignored `coverage/native-capture`. Close that test panel and restore its normal `ui.js` before stopping the bridge. Never redirect the normal credential store or send a model prompt through the qualification service.
