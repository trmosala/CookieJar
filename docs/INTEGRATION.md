# Desktop Integration Boundary

**0.2.2 development update:** the current public editing tools are targeted `ae_inspect` and script-body `ae_execute`. `ae_propose` and all `ae_raw_*` tools are retired. Use the matching 0.2.2 panel and rebuild/reload the consumer. Current evidence and the local project configuration are described in [FIRST_TEST.md](FIRST_TEST.md). The September 9 packaged evidence below remains historical.

The bridge publishes `automatic-connection.json` in its protected data directory alongside the non-secret discovery descriptor. The panel uses that runtime-scoped secret for initial authentication and then retains its own credential. No unauthenticated command endpoint is added. Inspect/capture automatically select the sole connected instance without taking another session's ownership. See [PRODUCT_GOAL.md](PRODUCT_GOAL.md) for the embedded-chat direction.


The chat adapter uses the plugin's provided `input.client` and `input.directory`. The authenticated `/chat` endpoint never accepts arbitrary session IDs: it resolves the panel/project's saved CM session. Chat operations run outside the bridge transport transition queue so inspections and permissions can progress. User messages are admitted through `session.promptAsync`; replies are read from `session.messages`, and permission events are forwarded to the panel with once/reject replies through the SDK. The adapter does not implement a second agent loop. `chat-projects.json` stores only project/session associations and submission receipts; CM retains message history.


[#1](https://github.com/trmosala/CookieJar/issues/1) is closed with sibling desktop integration under `CookieMonster/packages/desktop` and passing final refreshed Windows packaged smoke. The standalone plugin exports `{ id: "cm-ae", server }` and ships with `render-worker.mjs`. Packaged smoke evidence is recorded below, separately from standalone build/rebuild verification and live-host qualification.

## Desktop Wiring

Set `CM_AE_ARTIFACT_DIR` to the absolute built `CookieMonster-AE/dist/cm-ae` directory before desktop development/build. `scripts/stage-ae-plugin.mjs`, called by `predev.ts` and `prebuild.ts`, validates and stages the plugin, worker, `permissions.json` and Zod license into desktop `resources/cm-ae`; `electron-builder.config.ts` includes these resources. Missing/invalid optional artifacts warn and are omitted, rather than retaining an old staged bundle.

`src/main/ae-artifact.mjs` validates development/packaged resources without importing them into Electron's main process. `server.ts` supplies the application version as `releaseMetadata.cookieMonsterVersion`; `wpp-bridge/proxy/providerConfig.mjs` adds AE alongside browser configuration. Browser policy remains unchanged. AE defaults are applied by the plugin config hook below user policy, not injected into the desktop's higher-precedence environment config; unsafe AE auto-allow still fails closed.

## Internal installation via CookieMonster

Internal users ask CookieMonster to install from an extracted trusted team release. This is an agent-assisted procedure, not a built-in installer. Use the package locations documented in [the README](../README.md#internal-setup-ask-cookiemonster).

1. Inspect the release instructions, compatibility metadata and package inventory. Verify available hashes and trusted team provenance before executing package code. A bundled checksum alone does not establish authenticity. Confirm `cm-ae/plugin.mjs`, `cm-ae/render-worker.mjs` and the supplied permission policy are present; stop on missing artifacts or incompatibility.
2. Copy the complete contents of `cm-ae/` directly into the documented per-user `VERSION` directory, without an extra `cm-ae` subdirectory. Use the full release version. Verify an existing installation rather than blindly overwriting it, and preserve previous versions for rollback.
3. Identify the configuration this CookieMonster/OpenCode instance actually loads, including desktop-generated configuration. Back it up and register the absolute installed `plugin.mjs` path or file URL once. Expand home and environment placeholders before registration. Preserve browser plugins, other plugins, MCP settings and existing user permission rules.
4. Merge the supplied AE permission defaults using the helper below when available, and review the result before applying it. The helper belongs to this repository and may not be included in the release package. Do not weaken an incompatible permission policy to force startup.
5. Report the installed path and configuration changed. Ask the user to resolve uncertain operations and account for active renders before fully quitting and restarting CookieMonster/OpenCode. Do not terminate their session without approval. Report verification as pending if a restart interrupts it.
6. After restart, verify plugin loading and live bridge startup, not just the presence of copied files or a stale `descriptor.json`. Report loader or dependency failures rather than repeatedly restarting.
7. Have the user install/open the approved matching AE panel, then check connection and complete pairing and explicit saved-project binding through the documented tools. Report backend activation, panel connection, pairing and binding separately.

The backend installation directory is separate from runtime state. The bridge creates `.cookiemonster-ae` under the current user's home directory by default. Both bridge and panel must use the same `CM_AE_DATA_DIR` override if configured. Finder-launched macOS applications may not inherit terminal environment settings.

An `ENOENT` for that runtime directory means the expected location is missing. Check plugin activation, startup logs and data-directory overrides; do not create an empty directory as the fix. Installing the ZXP only installs the panel. Unrelated AE MCP integrations do not start this bridge.

For updates, verify the new package before changing registration. Retain the previous package and configuration backup for a compatibility-reviewed rollback. Do not delete runtime credentials or project state.

## Consumer Bridge

Other consumers can use the source helper after locating both trusted artifacts:

```js
import { AE_PERMISSIONS, mergeBundledPlugins } from "./path/to/cm-ae/src/config.mjs";

const result = await mergeBundledPlugins(existingConfig, [
  { id: "browser", path: absoluteBrowserArtifact, permissions: existingBrowserDefaults },
  { id: "cm-ae", path: absoluteAEArtifact, permissions: AE_PERMISSIONS, optional: true },
]);
for (const diagnostic of result.diagnostics) reportStartupDiagnostic(diagnostic);
if (result.diagnostics.some((item) => item.severity === "error")) {
  throw new Error("Required bundled plugin validation failed");
}
startOpenCode(result.config);
```

The application values and startup/diagnostic functions are consumer-supplied, not package exports. Alternatively run the README's explicit-output CLI, review its output, and intentionally supply that file to the consumer's documented config loader. Keep the complete `dist/cm-ae/` directory together; the source helper is separate from that runtime package.

After explicitly installing the plugin and selecting the reviewed config, fully quit and restart CookieMonster/OpenCode so startup reloads them. Resolve uncertain operations and account for detached renders before quitting. No automatic installation, global-config edit or restart is performed by the helper or CLI.

## Validation And Policy

Artifacts require `{id, path, permissions, optional?}`; paths are absolute or file URLs. Files are resolved and syntax-checked with `node --check`, never imported for validation. Existing plugin strings/tuples are preserved. Invalid optional artifacts produce warnings without inserting their entries/defaults; required failures are errors that the consumer must reject. Syntax checks do not validate imports, hook compatibility, artifact authenticity or sandbox safety.

Existing permission rules keep their order; global string policy is preserved. New defaults are subordinate to user rules, not permission to rewrite them. The current adapter separately rejects auto-allow for privileged operations except checkpoint-backed `ae_execute`, including matching wildcard/agent rules. A preserved but incompatible policy may therefore block startup or an operation; review the explicitly selected config rather than silently widening permissions or changing browser policy. The desktop owner must confirm its actual loader and permission semantics.

## Adapter Policy

`AE_PERMISSIONS` covers pairing/connections, binding/release, inspection/script execution, grants/capture, checkpoints/restore, templates, rendering/retirement and diagnostics/reconciliation.

- `ae_render_list`: `allow` for scoped read-only discovery; listing does not grant control of a recovered job or another project's jobs.
- `ae_render_recover`: `ask` for explicit recovery/reclaim after release or restart.
- `ae_render_retire`: `ask` for previewed inventory of proven terminal/quiescent owned artifacts. Published outputs and shared source checkpoints stay untouched; same-volume private claims are required.
- `ae_templates`: `ask`, not read-only. Host discovery temporarily adds/removes a render-queue item, validates the saved bound project and takes an execution lock.
- `ae_render_status` and `ae_render_result`: `allow`; recovery/control still needs its explicit authorization path.
- `ae_execute`: `allow` by default. A current revision and a verified checkpoint are mandatory before dispatch; checkpoint failure prevents execution. Explicit `ask` or `deny` rules remain supported. Other mutation/control tools retain `ask`; the removed raw tools have no active defaults or Session gate.

Restore/credential, render-retirement and desktop permission-override fixes have been re-reviewed with no remaining concrete findings in those scoped reviews. Rollback remains conditional on stopped/unchanged state; interruption preserves locks/backups. Retirement interruptions require manual recovery, never automatic plan replay; see [operations](OPERATIONS.md).

## Final Smoke Evidence

Passed on 2026-09-09 against AE `b3a1fb3` (base `49ef591`) and sibling desktop `a1e9efeff` (base `fa0b443cd`), both local and unpushed. AE source is unchanged since its 264/264-test verification, 32 syntax checks and 11-artifact SHA256/reproducible build verification.

- All four AE package files (plugin, worker, permissions and Zod license) matched SHA256 across `CookieMonster-AE/dist/cm-ae`, desktop `resources/cm-ae` staging and refreshed Windows `win-unpacked/resources/cm-ae`.
- Actual `Config.node` and `Plugin.node` under Bun loaded 5 browser tools plus 24 AE tools in valid development and packaged-resource layouts. Valid, missing and malformed optional-artifact scenarios passed in each layout; omitted AE artifacts produced diagnostics without breaking browser loading. Controlled browser IPC and `ae_connections` succeeded; actual Electron `app.getVersion()` value `1.18.27` appeared in AE compatibility.
- Desktop verification passed 29 tests/142 assertions and typecheck. All 12 permission-precedence cases passed against each of the AE build and refreshed packaged artifact.
- Packaged `CookieMonster.exe` in Node mode (`ELECTRON_RUN_AS_NODE=1`, Electron `42.3.3`, Node `24.15.0`) ran a disposable sidecar through the real adapter and unmodified packaged worker. The worker survived parent exit, then completed via a render double, produced one verified output and exited. The completed receipt recorded output SHA256 `9c0462a069a704723a07322bb5aca01b6bcffc4ac81e5c1dcdb72060232195b2`.

To reproduce loader/precedence checks, stage/build with `CM_AE_ARTIFACT_DIR` as described above. From sibling `CookieMonster/packages/opencode`, run the committed test against the AE build, then repeat with `CM_AE_TEST_ENTRY` pointing to the refreshed unpacked package's absolute `resources/cm-ae/plugin.mjs` path:

```powershell
$env:CM_AE_TEST_ENTRY = "E:\Work\Development\CookieMonster-AE\dist\cm-ae\plugin.mjs"
bun test test/plugin/cm-ae-precedence.test.ts
```

For the artifact-smoke cases, also set `CM_AE_SMOKE_SCENARIOS` to an absolute JSON scenario-file path before that command. Supply valid/missing/malformed cases for each layout from desktop resource validation and provider configuration, with the version from an Electron `app.getVersion()` probe. Each entry contains `name`, `config`, `warnings` and `expectedVersion` (`1.18.27` for valid AE, null when omitted). The committed test runs the real loader with controlled browser IPC; the scenario file and disposable worker harness are separate inputs, not generated by that test. For detached-worker reproduction, use the packaged executable in Node mode, a disposable real-adapter sidecar, the unmodified worker and a render double; verify survival after parent exit and the completed output receipt.

Local evidence was recorded at `%TEMP%\opencode\cj1-worker-K29UpD\evidence.json`, with the package at `%TEMP%\opencode\cj1-package-smoke\win-unpacked`; these disposable paths are not release artifacts. This was not a real AE render or a live desktop user session.

## Remaining Evidence

Full live AE/CEP behavior, macOS/network qualification and real approval/attachment/Session lifecycle operation remain unqualified. Desktop and CLI are unsigned. #16 requires approved signed installers/ZXP and exact environment qualification; #17 then requires a real pilot and sign-off. Approved internal update records/URLs remain `not_configured` (#15). Capture now uses an experimental undocumented API; preview/modal safety and live attachment qualification remain open (#7).
