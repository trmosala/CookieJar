# First development test — 0.2.2

## Live restart test — 10 September 2026

CM and AE were restarted, and the installed CEP panel connected to the real 0.2.2 CM plugin. Opening the disposable project exposed an AE-specific failure: comparing a retained, invalidated Project object throws `Object is invalid`. The host now calls `isValid` before comparing it. A native same-file reopen reproduced the failure before the fix and passed afterward (`coverage/debug-reopen2.txt`). All 42 host tests and the 39-script syntax check passed; the rebuilt 12-artifact panel was verified and installed.

The actual CEP UI followed active comp 14, pinned comp 1 without changing the viewer, resumed following, and tracked a viewer switch to comp 1. Sending a read-only prompt created a real CM conversation and persisted the prompt. CM returned `wpp_auth_required`: its WPP session needs the user to sign in. No model reply, edit approval, execution or capture was completed in this run. The visible text in both comps predates this test.

Diagnostic script activity caused a local uncertainty latch; after checking the unchanged saved project, the panel's reconciliation control cleared that local latch. The bridge still reported a durable uncertain lock, which must be inspected/reconciled through the conversation before testing writes. Do not delete profile or lock files. Resume after WPP sign-in with inspection, explicit reconciliation, then the approved disposable edit and capture tests below.

## Embedded chat — 0.2.2

Open the AE panel after loading the matching CM plugin. Type the first prompt below directly into the panel. Expect a project conversation, incremental text replies, and inline approve-once/reject controls for edits and captures. Choosing a composition pins it; Follow active composition resumes viewer tracking. The @ button inserts its name and ID. New chat starts a fresh conversation for this project.

Browser QA exercised sending, exact approval display, approve-once, pin/follow switching, and rejection of a late response after changing project. The first message stayed targeted at comp 14 while the viewer moved to comp 28 and the picker was pinned to comp 21. A 420-pixel-wide preview is in `output/playwright/ae-chat-approval.png`; it uses a UI fixture, not a live model response.

The consumer integration test `CookieMonster/packages/opencode/test/plugin/cm-ae-chat.test.ts` exercises the real CM SDK and server with a local test model. It verifies that panel chat submits a message, receives a model response and reads the persisted CM history. A separate native AE inspection (`coverage/native-chat-context.log`) verifies the built host/transport against the disposable AE project. Running CM and CEP browser processes still require reload before end-to-end user testing.

Final validation: the 300-test suite passed (`coverage/chat-full-suite.log`). A subsequent real-SDK rerun exposed a heartbeat/binding race; the panel now refreshes ownership after receiving a command. All 40 transport tests, including the new race regression, passed after that fix (`coverage/chat-transport-final.log`), and the real CM SDK test passed again (`coverage/cm-chat-sdk-final.log`). CM package type checking passed. The final 12-artifact build passed reproducibility/hash verification and was installed as 0.2.2 with the prior panel backed up. Native AE returned both composition IDs/names and active comp 1 from the final build. No running client-work session was restarted.

## Automatic connection baseline — 0.2.1

The matching 0.2.1 CM plugin and CEP panel implement automatic local authentication and selection of a single AE target on inspection/capture. The agreed embedded-chat direction is recorded in [PRODUCT_GOAL.md](PRODUCT_GOAL.md).

The built plugin and production panel transport connected to native AE 26.3 and inspected the existing disposable project without calling `ae_pair` or `ae_bind`, or requesting approval. It reported active composition 14 and a valid inspection revision. Evidence: `coverage/live-automatic.log`. This used the isolated native-script adapter described below, not the running CEP browser UI or the busy CM conversation. No project edits were made.

The panel is installed locally and the project configuration references the updated built plugin. Running CM/AE processes were not restarted; reload both to activate the matching versions. Startup before CM is available waits/retries. Uncertain state remains blocked, project changes require reselection, multiple AE targets require a choice, and another conversation's ownership requires explicit takeover.

Validation: all 293 tests passed (`coverage/automatic-full-suite.log`, 366.9 seconds), 36 scripts passed syntax checks, and the 11-artifact build passed reproducibility and SHA256 verification. Connection tests cover credential bootstrap/replay, retry, ownership conflicts, multiple instances, project changes, restart and retained uncertainty. The installed panel hashes match the verified build.

## Setup

Use a new disposable project on local disk. This version exposes script-based editing; do not use older instructions involving `ae_propose` or `ae_raw_enable`.

## Setup on this Windows machine

1. Build with `npm run build`, then run `node scripts/verify-build.mjs`. For repeatable build verification, add `--rebuild`.
2. Run `powershell -NoProfile -File scripts/install-dev-panel.ps1`. This requires an existing CEP development environment, backs up the previous panel, and installs the complete matching build. It does not change Adobe security settings or profile data.
3. Restart After Effects. Open **Window > Extensions > CookieMonster AE (Development)**. Confirm the panel reports **0.2.2**.
4. Save a new empty project as `CookieMonster First Test.aep` in a disposable local folder. AE's scripting file/network preference must already be enabled for checkpointing and capture; the integration leaves it unchanged.
5. Fully quit and reopen CookieMonster/OpenCode after accounting for active work. Select this repository, whose local `opencode.json` loads `dist/cm-ae/plugin.mjs`. Other plugins and global configuration are not replaced.
6. Ask chat to list its AE tools. Expect `ae_inspect` and `ae_execute` with `source`, `expectedRevision` and `label`; expect **no `ae_propose`**. If the old tools appear, the consumer is still loading an old plugin/configuration.
7. The panel connects automatically. Ask CookieMonster to inspect AE; with a single available instance the conversation binds automatically. Connection recovery settings retain manual pairing for invalid credentials. Do not delete local identity or recovery data to bypass errors.

Old `0.1.0` panels and `0.2.2` plugins must refuse to pair. Update both components; do not bypass the mismatch. If a reused profile reports invalid credentials, use the existing explicit credential-recovery flow.

## First chat prompt (type in the AE panel)

> Use the After Effects extension to inspect my saved disposable project. Create a 1280×720, 24 fps, three-second composition named “CookieMonster First Test” with centered text “Hello from CookieMonster”. Animate the text opacity from 0% at time 0 to 100% at time 1. Show me the exact script for approval, execute it with the current inspection revision, then inspect the new composition and report its IDs and checkpoint ID. Stop after inspection; do not render or capture yet.

Pass conditions:

- One exact-source approval precedes editing. Denying the prompt leaves the project unchanged.
- AE shows the composition, text layer and two opacity keyframes.
- The tool returns `result`, `checkpointId`, `expectedRevision` and a fresh `overview`.
- The panel has no uncertain/locked outcome after success, and the pre-edit checkpoint is listed.

With the panel visible and AE idle, ask:

> Capture the new composition at time 1, alpha enabled, maximum width 1280. Return the image attachment and inspect it visually.

Expect a PNG attachment showing the title. Repeat at time 0 for a transparent frame, or with alpha disabled for a JPEG. Composition time, selection, project revision and render queue should remain unchanged. If native output times out, its destination is preserved and automation requires reconciliation; do not retry automatically.

## Additional checks

- **Stale edit:** inspect, manually change a layer in AE, then try an execution using the old token. Expect `stale_revision` with no new script execution. Reinspect before submitting a fresh edit.
- **Recovery:** on the disposable project only, approve a script that changes a layer and then throws. Expect an uncertain outcome, retained checkpoint and blocked further writes. Inspect the partial changes; use panel local reconciliation if latched, followed by chat `ae_reconcile`. Do not retry the failed source automatically. Manual restore is a separate approved operation.
- **Restart:** release the binding and restart the consumer/panel. The panel reconnects with its saved identity; a fresh inspection binds the single available instance. Another conversation's ownership, multiple targets, project changes and uncertain outcomes must not be bypassed.

## Script contract

`source` is an ExtendScript **function body**. Use ES3 syntax (`var`, ordinary functions) and return JSON-compatible primitives, arrays or plain objects; return IDs instead of native AE objects. Omitted return becomes `null`.

```js
var comp = app.project.items.addComp("CookieMonster First Test", 1280, 720, 1, 3, 24);
var text = comp.layers.addText("Hello from CookieMonster");
var sourceText = text.property("ADBE Text Properties").property("ADBE Text Document");
var style = sourceText.value;
style.fontSize = 64;
style.applyFill = true;
style.fillColor = [1, 1, 1];
style.applyStroke = false;
sourceText.setValue(style);
var bounds = text.sourceRectAtTime(0, false);
text.property("ADBE Transform Group").property("ADBE Anchor Point")
    .setValue([bounds.left + bounds.width / 2, bounds.top + bounds.height / 2]);
text.property("ADBE Transform Group").property("ADBE Position").setValue([640, 360]);
var opacity = text.property("ADBE Transform Group").property("ADBE Opacity");
opacity.setValueAtTime(0, 0);
opacity.setValueAtTime(1, 100);
return { compId: comp.id, layerId: text.id };
```

Never hard-code an `expectedRevision`; copy it from the latest `ae_inspect`. The checkpoint protects saved project content, not arbitrary file/network/process effects of unsandboxed code. Successful scripts leave their edits in the open project; save deliberately afterward.

## Repeatable native-host probe

With an empty unsaved project, run `scripts/ae-host-smoke.jsx` using AE's **File > Scripts > Run Script File**. It loads the production host, saves a disposable project under the OS temp directory, exercises inspection/save/script/stale-revision/capture dispatch, and writes `cm-ae-host-smoke-*/report.jsonl` there. It refuses an existing saved or populated project and does not change preferences. It leaves its synthetic project and report available for inspection.

This probe exercises the native host directly. It does **not** establish CEP transport, consumer permission UI, checkpoint orchestration or chat attachment behavior.

## Verification record

Local evidence collected on 10 September 2026 (Windows, Node 24.15.0, Bun 1.3.14, AE 26.3x87):

- Matching 0.2.0 plugin/panel built; all 11 artifact hashes verified, including a reproducible rebuild. Installed panel hashes match. The panel was opened in AE and visibly reported 0.2.0.
- Native host smoke reported PASS: saved a disposable project, inspected it, confirmed save preserves the native revision, executed the title/keyframe source, inspected properties, rejected stale source, safely refused capture, and saved the result. Report: `%TEMP%/cm-ae-host-smoke-1789043667589/report.jsonl`.
- AE showed a native `no current context` warning during the command-line probe; the report completed and the centered white title was visible afterward. This is a qualification limitation, not a certified clean artist workflow.
- Focused host, panel transport and UI suite: 87/87 passed. Capture integration suite after updating its refusal expectation: 3/3 passed.
- CookieMonster's real plugin-loader/permission suite against this build: 12/12 passed, 105 assertions. Its stale retired-tool expectation was updated in the sibling repository.
- Full suite completed and exited normally: 285/286 passed in 367.6 seconds. Its sole failure was the obsolete capture test expecting `unsupported_capability` after capture was deliberately disabled. That expectation was corrected to `unsafe_state`; the complete capture suite then passed 3/3. Production code did not change after that full run started. A second full run after the expectation-only correction was not performed. Logs are retained locally under `coverage/final-suite.log`, `coverage/final-capture-tests.log`, `coverage/final-panel-tests.log` and `coverage/final-consumer-loader.log`.

The live CEP-to-plugin edit could not start because the existing default bridge is still version 0.1.0 and holds its exclusive ownership endpoint. That running consumer was left intact. Fully quit/reopen CookieMonster with this repository selected, then follow the first chat prompt. Chat approval UI, native checkpoint orchestration through CEP, and artist acceptance remain to be tested. Signing and macOS/network qualification are also outstanding.

### Isolated live test from Codex

Completed against AE 26.3x87 while CookieMonster continued using its unchanged 0.1.0 bridge. The built 0.2.0 plugin, HTTP bridge, panel Client and HostRPC ran against separate temporary bridge/profile storage. An adapter carried HostRPC calls through `AfterFX.com -r` and response files, with the production host retained in an isolated ExtendScript global. This tests native orchestration, not the CEP browser transport or chat approval UI.

- Paired and bound only the saved disposable project; a denied edit left its revision unchanged.
- Created composition **Codex Live Bridge Test** (ID 14), with **Tested from Codex** (layer ID 26), 1280×720, 24 fps, three seconds.
- Verified checkpoint `e2e090ad-0e7a-4a28-8b3d-caff2878bf42` (84,201 bytes) by hash before accepting the edit result.
- Targeted property inspection confirmed opacity keys `(0s, 0%)` and `(1s, 100%)`. The initial harness incorrectly expected keys in a layer summary; it was corrected to query the property, and resumed without repeating the creation script.
- Rejected an obsolete revision token, safely refused capture with no retained lock, saved/displayed the result at one second, released the binding and closed the isolated runtime.
- Logs: `coverage/codex-live-edit.log` and `coverage/codex-live-resume.log`. Saved project: `%TEMP%/cm-ae-host-smoke-1789043667589/First Test.aep`.

### Capture fix and live vision test

Capture is enabled in the current build; the disabled-capture results above describe the earlier first-test snapshot. The old code assumed the native PNG existed immediately, then removed its destination on failure. The host now returns a pending output path without premature cleanup; the panel waits for a complete PNG before decoding. Timeout retains both the destination and the uncertainty latch. Delayed-file and partial-file regressions cover this behavior.

The isolated built-plugin/native-AE test returned and decoded three real image attachments: composition 14 at one second as a 1280×720 alpha PNG (18,831 bytes), its fully transparent time-zero frame at 640×360 (1,002 bytes), and composition 1 at one second as a 640×360 JPEG (8,946 bytes). Each capture preserved the inspection revision, released its lock and removed its temporary directory. The test used the production normalizer with a native Canvas implementation through the script adapter; CEP browser execution and the consumer's chat image UI remain separate qualification checks. Log: `coverage/live-vision.log`.

After the fix, all 93 host, transport, panel UI and capture tests passed (`coverage/vision-tests.log`). Syntax checks and reproducible artifact/hash verification passed. The matching panel was installed with a backup of the previous build; reload AE before using the updated panel. CookieMonster's running 0.1.0 bridge was neither restarted nor replaced.

### Embedded chat live restart test — 10 September 2026

CM login succeeded and the AE panel received real model replies through the authenticated chat bridge. Testing exposed two startup/recovery defects, now fixed in the installed 0.2.2 panel:

- Opening a project invalidates AE's previous native project handle. Even comparing that handle can throw; the host now checks `isValid` before comparing it. The native reopen reproduction passed, as did 42 host tests (`coverage/live-restart-host-tests.log`).
- Automatic startup previously selected an idle profile alphabetically ahead of the identity holding an interrupted capture. It now prioritizes the interrupted identity, retaining its credential and recovery evidence. All four automatic connection tests passed (`coverage/live-auto-recovery-tests.log`).

After restarting AE with the installed fix, the original connection was restored. The saved disposable project was reviewed, its local latch cleared, and its durable capture lock reconciled through CM's explicit one-time permission. No capture was retried. The panel correctly retained comp 14 as its pinned target while the viewer displayed comp 1. Syntax checks passed for all 39 scripts.

The full recovery snapshot exceeded the embedded approval size limit, so its review was correctly routed to CM. CM's oversized approval layout required zoom reset and keyboard focus to expose its footer; its large tool result also required additional model processing. These are usability limitations in the tested recovery flow.

The authenticated embedded flow then passed end to end:

- Submitted a text-only edit from AE while comp 14 was pinned and comp 1 was active. Approved the exact script once in the AE panel. CM created checkpoint `5f84d089-b4a9-4a25-a762-8e2000d87687`, executed it, and verified layer 26's text changed to **Live from After Effects**. The script only changed that existing TextDocument's text field; comp 1 stayed untouched.
- Approved `ae_capture` in AE for comp 14 at one second, alpha enabled, width 1280. The real CEP capture returned a 1280×720 PNG, appeared inline in the panel, and the model accurately described its white text and placement. The active viewer remained comp 1. The bridge reported no remaining lock and the chat returned idle without an error.
- Saved the disposable project. Local evidence: `coverage/live-chat-state.json` and `coverage/live-cep-frame.png`.

Two final startup/presentation fixes were built and installed: automatic selection resumes the most recently used available identity after recovery (rather than reverting alphabetically), and cleared server errors no longer linger above the composer. The automatic-connection regression now covers reopening after the latch is cleared; all four tests passed again. The final build's 12 artifact hashes and 39 script syntax checks passed.

Final restart check passed: AE reopened the saved project and automatically restored the same conversation, pinned comp 14, and captured image without pairing or profile selection. The composer showed Ready with no stale error.

UI simplification: matched CookieMonster/OpenCode's neutral dark styling, made chat fill the dock with a fixed composer, moved technical controls into a troubleshooting drawer, and added conditional recovery guidance. All 11 panel UI tests passed, including local/durable recovery transitions. The installed panel was visually checked in AE with the restored conversation and settings drawer. Build hashes verified.

## Reference attachments (issue #18)

The AE composer accepts PNG, JPEG, WebP, PDF, TXT and Markdown references through Attach, file drop, or clipboard image paste. Up to four non-empty files may be attached, with a combined 2 MiB limit. Add a prompt, check the thumbnails/filenames, and remove unwanted references before sending. Draft references are held in memory and cleared when the AE project changes or the message is accepted.

References use CookieMonster's normal file message parts and selected model. Text briefs become model context through CM's existing text-file handling. CM's provider capability handling reports when a model cannot read images or PDFs. This feature does not generate images or import assets into AE.

The request fixes its composition ID on Send. Attachment content participates in the durable delivery identity. An uncertain send retains the draft and blocks another submission; inspect the conversation in CM before starting a new chat. Opening a native file dialog may temporarily defer AE status reads; closing it reconnects automatically, without marking a read-only timeout as an uncertain edit. Edit/render recovery protections remain unchanged.

Validation: automated coverage includes file-part delivery, duplicate identity, invalid/oversized data, browse/drop/paste, removal, project changes during reads, uncertain delivery, and delayed modal status callbacks. Live Windows AE 26.3 testing verified the file picker, preview/removal, automatic reconnect after a prolonged picker, and admission of an image-plus-prompt message through the installed panel.

Live model result: CM_GPT-5.6 Sol - High correctly described the attached white “Live from After Effects” text and its placement after a bounded comp-14 inspection; comp 1 remained active. A tools-disabled prompt exposed the CM/WPP `o1_code_required_tool_not_called` provider error, which was surfaced in AE. The normal inspection-plus-reference workflow completed with idle status and no error. The full suite passed 309 tests before the modal fix; 44 focused panel/transport tests passed after it, followed by the final four composer/dialog tests and 40-script syntax check. Native clipboard paste and drag/drop have automated coverage but were not separately exercised with OS input.


## Model and reasoning selection (issue #19)

Choose a Model above the composer, then a Reasoning level when the provider supports separate variants. Changes save to the existing CM session, and reopening the panel restores them. CM/WPP presets such as “CM_GPT-5.6 Sol - High” already include reasoning in the model name; their separate reasoning control shows Model default. No additional login or provider setup is required in AE.

The catalog refreshes every 15 seconds. Disconnected CM, no connected models, unavailable saved models, unsupported reasoning and failed saves have explicit states. Model controls are disabled while a reply or save is pending and while message delivery is uncertain. Before submitting a message, the backend rechecks the selected model and its reasoning against CM's current catalog.

Validation: 312 full-suite tests passed, followed by six composer tests after the final dropdown refresh adjustment. The build verified 12 artifact hashes and syntax checks passed for 40 scripts. Live testing loaded 39 configured models, saved both a WPP preset and GPT-5.6 Sol / High in CM, rejected an unsupported reasoning level, and restored the saved preset after restarting AE. Native UI inspection confirmed the controls disable during a live reply. The legacy plugin SDK does not expose the session model endpoint; the plugin reuses its authenticated transport for CM's existing `/api/session/{sessionID}/model` endpoint and verifies the resulting session selection.

The end-to-end smoke prompt completed on CM_GPT-5.6 Sol - Low: one bounded `ae_inspect` call returned comp 14 as “Codex Live Bridge Test”, with idle status and no error. The original High preset was restored after testing.

Final native check: keyboard selection in the installed AE model picker changed High to Low, and CM state confirmed the new preset. High was restored afterward. A delayed state-poll regression test verifies that an old response cannot overwrite a newer confirmed selection.

Final complete suite: 315 tests passed with zero failures after the stale-poll fix. The final installed panel reconnected to the saved project and retained its CM model selection.
