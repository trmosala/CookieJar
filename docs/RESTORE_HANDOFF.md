# Restore investigation handoff — 2026-09-11

## Branch and completed work

Repository: https://github.com/trmosala/CookieJar

Continue from `codex/chat-checkpoint-restore`. The user designated this branch as the source of truth; it wins conflicts with main. Do not start the investigation from main's older implementation.

Issue #18 (reference attachments) and #20 (chat checkpoint restore) are closed. Model/reasoning selection is also implemented. The AE chat follows the active composition and can target other compositions through the connected CookieMonster plugin.

Implementation commits:

- `5f09f81`: chat checkpoint restore and native Save As recovery verification.
- `f47549c`: bridge validation of the native Save As revision increment.
- `30feef8`: retain chat ownership while restore temporarily changes the open project.
- `ff997c5`: completed live validation report.

## Verified behavior

The installed CEP panel successfully restored a two-composition checkpoint through its chat card. Cancel preserved unsaved work and disk bytes. Confirm saved current work, restored the selected checkpoint, recorded completion, and cleared bridge locks. The restored file hash matched the checkpoint. Opening the retained backup proved the unsaved marker survived. The original three-comp, 96-layer recreation was then returned byte-for-byte, and a prompt from the AE composer completed with chat connected and no errors.

Previous validation passed 325 tests, 40-script syntax checks, and a build verifying 12 artifact hashes. No runtime code has changed since that validation. See `docs/FIRST_TEST.md` for detailed evidence and caveats.

## Remaining problem

The full 96-layer recreation cannot pass the inherited complete-scene snapshot size limit for verified restore. The operation refuses before changing the project. The successful restore test used the smaller two-comp project; it does not establish large-project restore support.

Two different artifacts currently get called snapshots:

1. Local `.aep` checkpoints: authoritative project backups used to restore.
2. Full JSON scene descriptions: repeatedly collected and compared for freshness, approval, save, and recovery verification.

The JSON path has a 3 MiB workflow bound and 4 MiB bridge bound. Full descriptions include properties, locators, selection, and installed effects. Repeated traversal/serialization also adds latency and makes permission reviews enormous. Increasing the limits alone will not fix that cost.

The user reports ATOM checkpoint restoration is almost instant. We have not measured ATOM or instrumented our individual restore phases, so repeated inspection is a code-supported bottleneck candidate, not a measured breakdown of elapsed time.

## ATOM findings and proposed direction (not implemented)

Official documentation: https://tryatom.ai/docs/reference/checkpoints

ATOM documents a hidden checkpoint before each change, a visible checkpoint after successful changes, restoration from chat, confirmation by default, and checkpoint restoration when editing or branching an earlier message. AE checkpoints capture full project state, described as equivalent to saving and reopening the project. Its first-prompt guide requires an initially saved `.aep`: https://tryatom.ai/docs/getting-started/first-automation

These docs do not disclose AE checkpoint storage internals or the validation algorithm. The page mixes AE and Premiere material; its explicit verified `.prproj` copy description is Premiere-specific. Do not present that as proof of AE implementation details.

Recommended separation:

- Recovery: ready-to-open local `.aep` checkpoints, with current unsaved work preserved before restoration.
- Verification: compact receipts across the connection, with file integrity and necessary state checks local to the host/plugin.
- AI context: bounded queries for relevant comps/layers and optional visual previews, refreshed separately from restore completion.

Aim for AE save/open time plus minimal overhead. Merely moving the same repeated exhaustive comparisons locally addresses transport size, not traversal latency. Revision alone is insufficient without handling project identity, reopen epochs, and Save As behavior. Determine the minimal safe guard from native tests before replacing the existing checks.

## Investigation starting points

- `src/workflow.mjs`: `snapshot`, `revision`, `recoveryScene`, and `restore`; repeated `checkApproval` calls and complete expected snapshots.
- `src/bridge.mjs`: `MAX_BYTES`, `restoreSnapshot`, and restore phase/result validation.
- `panel/host.jsx`: native inspection, `restore_prepare`, `restore_finish`, and save/open verification.
- `panel/transport.cjs`: restore request and host timeouts.
- `src/chat.mjs` and `panel/chat.js`: restore audit, pending ownership, and polling suspension.
- Existing tests in `test/`: preserve coverage for changed projects, Save As increments, temporary-project polling, file integrity, cancellation, and uncertain outcomes.

First measure inspection/traversal, serialization/transport, file save/copy/hash, close/open, and context refresh separately on small and large projects. Compare against a manual AE save/open baseline. Then remove full scene payloads from the critical path without losing backup guarantees or allowing automatic retries after uncertain writes.

Acceptance target: the 96-layer case restores without payload-size failure; overhead is measured against native save/open; unsaved work remains recoverable; stale approvals cannot overwrite intervening edits; failures retain backups and a truthful audit; chat reconnects without replaying old edits.

## Moving machines

Fetch and check out the branch above, install dependencies with `npm ci` (Node 22+), and follow `docs/FIRST_TEST.md` and `docs/INTEGRATION.md` for local plugin/panel setup. `npm test`, `npm run check`, and `npm run build` are the repository validation commands.

Machine-local credentials, sessions, installed extensions, `.aep` projects, and ignored `coverage/` evidence are not transferred by Git. Reconnect locally rather than copying credentials. Useful files on the current Windows machine, if a separate project/evidence transfer is needed:

- Full recreation backup: `E:\Work\Development\CookieMonster-AE\coverage\issue20-full-project-before-test.aep`
- Its SHA-256: `8C3108B776412C7D66653BF90C454EA87AEB4060926D8872A753879FD0995F28`
- Live restore screenshot: `coverage/issue20-cep-restored.jpg`
- Verification summaries: `coverage/issue20-verified-backup.json`, `coverage/issue20-full-returned.json`
- Full test log: `coverage/issue20-complete-suite.log`

This handoff records the proposed optimization; no restore redesign or new benchmark has been implemented yet.
