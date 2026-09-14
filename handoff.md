# CookieJar AE workstation handoff

Date: 2026-09-14

## Immediate requests

The user is moving to another workstation with new agents.

Pending product request: **Include an `AGENTS.md` in the extension ZIP.** This has not been implemented. Determine which distribution archive the user means by inspecting the current packaging scripts. Distinguish the outer team-release ZIP from the signed CEP ZXP. Add agent-facing installation instructions to the intended distribution before checksums/signing, not by modifying a signed archive afterward.

This handoff is a new local file. It has not been committed or pushed by its creation. Transfer it to the next workstation or commit/push it with user authorization.

## Repository state

Repository: https://github.com/trmosala/CookieJar.git

Mac checkout:
`/Users/kamokgelo.motsoenyane/Library/CloudStorage/OneDrive-Ogilvy/Documents/GitHub/CookieJar`

Last verified state before creating this file:
- Local branch: `main`, clean, at `d653d4c`.
- Fetched `origin/main`: `171976d`, merge of PR #29.
- Local checkout is 32 commits behind the fetched remote.
- Fetch was performed, but the latest merged source was NOT checked out.
- Local source package version is `0.2.2`; fetched remote source is `0.2.3`.
- Remote may have advanced since this check. Fetch and inspect again.

Both of this conversation's commits are ancestors of fetched `origin/main`:
- `6e77c57`: `docs(ae): document internal plugin installation`
- `d653d4c`: `fix(ae): default chat workspace to saved project folder`

The merged README, integration instructions, workspace default implementation and regression tests were inspected and retain our work. Later commits add other features and change development/client execution policy; preserve those changes.

Before working, inspect status and fast-forward safely or use a fresh clone of current main. Do not overwrite uncommitted work. Do not build the old local checkout as the current release.

## Decisions and completed work

### Internal installation

Use **Ask CookieMonster to install the plugin** rather than building a dedicated installer UI for this internal workflow.

Documented in `README.md` and `docs/INTEGRATION.md`:
- Copy the complete `cm-ae/` contents into a predictable per-user version directory.
- macOS: `~/Library/Application Support/CookieMonster/plugins/cookiejar-ae/VERSION/`
- Windows: `%LOCALAPPDATA%\CookieMonster\plugins\cookiejar-ae\VERSION\`
- Place `plugin.mjs`, `render-worker.mjs`, permissions and licenses directly in that version directory.
- Use the full release version, including any prerelease identifier.
- Do not register the extracted package in Downloads as the permanent installation.
- Back up and merge the configuration actually loaded by CookieMonster/OpenCode.
- Preserve existing plugins, MCP integrations and permission rules.
- Verify backend activation separately from AE panel connection, pairing and binding.

These paths are an internal installation convention, not directories automatically managed by the current desktop application.

There are two installed components: the AE panel and the OpenCode plugin. The plugin starts the local bridge; the bridge is not a third application.

Runtime state is separate: `~/.cookiemonster-ae/`, unless `CM_AE_DATA_DIR` overrides it. The bridge creates this directory. The panel and bridge must agree on the location. Creating an empty directory manually is not a connection fix.

### Saved-project workspace default

Implemented and pushed in the four files:
- `src/chat.mjs`
- `panel/chat.js`
- `test/chat.test.mjs`
- `test/chat-panel.test.mjs`

Behavior:
- Use the saved `.aep` file's exact parent folder by default.
- Preserve an explicit workspace choice and existing conversation workspace.
- For unsaved projects, ask the user to save or select a workspace.
- Do not silently select an ancestor or unrelated sole registered workspace.
- Keep state, model lookup and sending consistent.
- Reset transient selection on project changes.
- Cover macOS, Windows drive and UNC paths.

Important limitation: the folder must already be registered/open in CookieMonster. If unavailable, the panel identifies the exact folder to open. This does NOT implement automatic workspace opening or bypass client registration, lifecycle events or permissions.

The original screenshot's native dialog was not conclusively identified. The implemented change targets chat workspace resolution, not an assumed native picker API.

## Installation on the previous Mac

Installed release source:
`/Users/kamokgelo.motsoenyane/Downloads/CookieJar-AE-0.2.3-team-test-20260913`

Backend installed at:
`/Users/kamokgelo.motsoenyane/Library/Application Support/CookieMonster/plugins/cookiejar-ae/0.2.3/`

Global configuration:
`/Users/kamokgelo.motsoenyane/.config/opencode/opencode.json`

Configuration backup:
`/Users/kamokgelo.motsoenyane/.config/opencode/opencode.json.before-cookiejar-ae-0.2.3-20260914.bak`

Installed CEP panel:
`/Users/kamokgelo.motsoenyane/Library/Application Support/Adobe/CEP/extensions/com.cookiemonster.ae`

The installation agent reported:
- All 12 release hashes and all five installed package hashes passed.
- Plugin import and JavaScript syntax checks passed.
- Plugin registered once with supplied permissions.
- Existing settings, including unrelated `atom-ae` and `AfterEffectsMCP`, preserved.
- No app restart or AE project manipulation performed during installation.

The release is labelled a Windows team test. Inspection found macOS code, not an explicit incompatibility, but macOS remains unqualified. The checksum manifest uses CRLF; hash verification must handle trailing carriage returns without altering release files.

Live bridge activation, connection and binding were not formally verified after restart in this conversation. Do not claim a verified end-to-end Mac installation.

The installed package does NOT contain the workspace-default update from this conversation. It was left untouched rather than deploying the older local `0.2.2` build over `0.2.3` or modifying a signed panel.

These paths and config changes are machine-local, not Git content. Do not copy credentials or assume the new workstation has identical paths.

## Diagnosis that led to installation

The panel originally failed with `ENOENT` for `~/.cookiemonster-ae/` and remained disconnected. Restarting did not help.

At investigation time:
- The panel was installed, but the global config had no CookieJar AE plugin entry.
- CookieMonster `1.18.27` generated inline configuration for its browser plugin only.
- The backend package was later located in Downloads and installed/registered.
- Other AE MCP integrations did not initialize CookieJar's bridge.

Separate logs showed an unavailable `@opencode-ai/plugin@0.0.0-prod-202609091011` dependency and a missing desktop `app-update.yml`. Neither was established as the cause of CookieJar's missing registration.

## Verification and deployment status

For the workspace-default work before the latest remote merge:
- 26 targeted chat/panel tests passed.
- Four packaging tests passed.
- Syntax checks passed.
- Build, SHA256 inventory and deterministic rebuild verification passed.
- `git diff --check` passed.

A full-suite run reported 315 passes, six failures and two skips. One missing-Bun packaging failure passed on rerun; five compatibility/macOS process-identity failures remained unresolved. Earlier runs had different dependency/address failures. Do not treat these results as validation of the later merged source.

Unsigned local artifacts exist in `dist/` from the older checkout. They are NOT an approved update package.

Fetched main now has matching version `0.2.3`, but matching version numbers alone do not establish matching artifact contents or readiness. Its README labels it a deployment-hardening candidate blocked for client release. Consult current deployment evidence, signing instructions and CI results.

## Next-agent checklist

1. Inspect/fetch current Git state and work from current main, preserving this handoff and other local changes.
2. Inspect release ZIP/ZXP generation, build manifests, signing inputs and packaging tests.
3. Implement the pending inclusion of `AGENTS.md` in the intended extension distribution. Use the current README and integration instructions as the source for internal setup guidance.
4. Make those instructions usable from an extracted release without assuming the source repository or merge helper is included. Inspect what is actually shipped.
5. Include predictable install paths, config preservation, matching panel/backend versions, restart guidance and separate verification statuses. State the registered-workspace limitation honestly.
6. Update package inventory/hash expectations and regression tests where appropriate. Do not alter signed outputs in place or disable signature checks.
7. Run relevant tests, syntax checks, build and reproducibility verification on the latest source. Report existing failures separately.
8. If asked to deploy, obtain/build a matching panel/backend package through the supported signing/install workflow. Do not mix versions, weaken permission policy, delete recovery state or restart applications without approval.
9. Commit/push or distribute artifacts only as authorized for the current task. Report exactly what was built, installed, committed and verified.

Use disposable AE projects for testing. Preserve checkpoints, uncertain-operation evidence and configuration backups.
