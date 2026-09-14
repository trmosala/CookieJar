# CookieJar-AE

**0.2.2 — local development build for first testing on disposable projects.** A Node sidecar and CEP panel connect CookieMonster/OpenCode to After Effects. Unsigned; no environments are certified.

The panel now provides [chat inside After Effects](docs/PRODUCT_GOAL.md), backed by CookieMonster's existing conversation runtime. Open it, type a message, and review replies, captured frames and approvals in AE. It follows the active composition; choose a comp to pin it or insert an explicit @mention. Conversations stay with the project, and project changes stop previous work. Normal connection is automatic. Multiple targets or another conversation's ownership require an explicit choice.

The compact composer stays at the bottom of the panel. The top-left hamburger opens project Conversations and New chat. The separate top-right Settings gear opens preferences, troubleshooting and the project checkpoint list. Replies render Markdown; older images, activity and exchanges collapse, with manual choices saved for each project conversation. Recent completed frame captures expand and show composition/time metadata when supplied by the capture tool. Load earlier messages above the conversation. The restore arrow beneath a request selects its first edit checkpoint and opens a review before changing the whole project. Restore now preserves the previous disk version, saves current work in place and verifies an emergency copy before restoring. This avoids AE 26.3's Save As revision increment without accepting intervening edits; see [current validation](docs/RESTORE_VALIDATION.md) and [panel redesign validation](docs/PANEL_REDESIGN.md).

The current editing flow is **inspect → verify a checkpoint → execute → inspect the result**. `ae_inspect` supports bounded project/composition/layer/property queries and returns an `expectedRevision` token. `ae_execute` accepts that token, a label and a script body. It runs without a permission prompt by default, but only after saving and verifying a checkpoint. Explicit `ask` and `deny` policies remain supported. Scripts are unsandboxed; partial edits and external effects can remain after failure. There is no automatic rollback or retry for scripts.

`ae_propose` and the three `ae_raw_*` tools are no longer exposed. Structured transaction internals remain for existing recovery paths and regression tests. Pairing, exclusive bindings, checkpoints, manual restore, render management and diagnostics remain available.

`ae_capture` returns composition images for visual inspection: PNG with alpha, or JPEG, bounded to 2000 pixels. Keep AE idle and the panel visible. The panel waits for a complete native PNG before decoding and cleanup; timeout preserves the destination and requires reconciliation. Native capture uses undocumented `CompItem.saveFrameToPng`; Windows AE 26.3 has been live-tested, while other versions and preview/modal behavior remain unqualified.

## First test

Follow [FIRST_TEST.md](docs/FIRST_TEST.md) for local setup, the exact chat prompt, expected results and recovery instructions. It distinguishes automated evidence from the remaining live CEP/chat test.

The git-ignored local `opencode.json` points to this repository's `dist/cm-ae/plugin.mjs`. Keep the whole `dist/cm-ae` directory together. Restart CookieMonster/OpenCode with this repository selected so it loads the project configuration. Building alone does not reload an already-running consumer.

## Development

Node 22+, Zod 4.1.8, Marked 17.0.5 and Bun 1.3.14:

```sh
npm ci --ignore-scripts
npm test
npm run check
npm run build
node scripts/verify-build.mjs --rebuild
```

Build output is a self-contained Node ESM plugin and render worker, default permissions, dependency licenses, complete CEP panel, compatibility metadata and deterministic SHA256 manifest. Builds do not install, sign or publish. Tests use AE doubles unless explicitly described as live; V8 parsing of JSX is not proof that ExtendScript accepts it.

On an already configured Windows CEP development machine, install the verified panel with:

```powershell
powershell -NoProfile -File scripts/install-dev-panel.ps1
```

This preserves the previous panel outside the CEP extensions folder, verifies installed hashes and leaves profile data/preferences unchanged. Restart AE afterward. This is a local developer setup, not signed pilot distribution.

For another consumer configuration, generate a new explicit output while preserving existing plugins and permission policy:

```sh
node scripts/merge-config.mjs existing-config.json dist/cm-ae/plugin.mjs merged-config.json
```

Read tools and checkpoint-backed script execution default to allow; capture, filesystem grants, restore, template discovery and render control require approval. Auto-allow policies for those other privileged tools are rejected. Filesystem grants constrain managed operations; they do not sandbox arbitrary ExtendScript.

## Internal setup: ask CookieMonster

Extract the trusted team release, then ask CookieMonster:

> Install the CookieJar AE plugin from this release folder: [absolute folder path]. Follow the internal installation instructions in docs/INTEGRATION.md. Copy the complete cm-ae package to the documented location and register it in the configuration this CookieMonster instance actually loads. Preserve my existing plugins and permissions. Tell me when to restart, then verify bridge startup and report AE connection and pairing status separately.

Supply this README and [the installation instructions](docs/INTEGRATION.md#internal-installation-via-cookiemonster) if CookieMonster does not have this repository open. This is agent-assisted setup for internal use, not a built-in installer or an automatic action on extraction.

Install the contents of `cm-ae/` directly inside the appropriate version directory:

| Platform | Backend package location |
| --- | --- |
| macOS | `~/Library/Application Support/CookieMonster/plugins/cookiejar-ae/VERSION/` |
| Windows | `%LOCALAPPDATA%\CookieMonster\plugins\cookiejar-ae\VERSION\` |

Replace `VERSION` with the full release version, including any prerelease identifier. For example, macOS version `0.2.3` loads `~/Library/Application Support/CookieMonster/plugins/cookiejar-ae/0.2.3/plugin.mjs`, alongside `render-worker.mjs` and the rest of the package. These paths define our internal installation convention; the current desktop app does not automatically manage them. Do not register a plugin path in Downloads.

The bridge creates separate runtime data at `~/.cookiemonster-ae/` under the current user's home directory. Both bridge and panel must agree on any `CM_AE_DATA_DIR` override. Do not create an empty runtime directory to work around `ENOENT`; check plugin activation and startup errors instead.

### AE panel and pairing

The ZXP installs only the AE panel. The OpenCode plugin starts the local bridge, which is not a third application to install or launch. Both panel installation and backend setup are required.

There is no approved production installation yet. After release gates pass, install the signed ZXP with the qualified extension manager and open the panel under AE's **Window > Extensions** menu (wording varies by qualified host). Do not bypass signature verification for a pilot.

## Release status

The 264-test baseline and September 9 packaged desktop smoke belong to the previous `0.1.0` source, not this refactor. Current development evidence is recorded in [FIRST_TEST.md](docs/FIRST_TEST.md). The [issue ledger](docs/ISSUE_STATUS.md) records the replacement product roadmap and preserves historical release gaps. Closing the earlier issues does not establish certification or pilot completion.

See [operations](docs/OPERATIONS.md), [desktop integration](docs/INTEGRATION.md), [qualification](docs/QUALIFICATION.md), [release](docs/RELEASE.md) and [pilot](docs/PILOT.md). No production or pilot approval is implied by a passing development test.
