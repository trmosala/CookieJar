# CookieMonster After Effects

Standalone, pre-production AE sidecar plugin and CEP panel. **Unsigned and not certified.** AE 25/26 are candidates, not supported-environment claims. See [issue status](docs/ISSUE_STATUS.md), [qualification](docs/QUALIFICATION.md) and [pilot gates](docs/PILOT.md).

**Capture unavailable:** `ae_capture` always returns `unsafe_state` on the current host path because there is no reliable preview/modal detection signal. Image normalization and attachment tests do not establish working capture.

`comp.reorder` is explicitly unsupported; layer reordering is supported. Manual checkpoint restore saves and verifies dirty work before guarded canonical restoration, retaining the displaced `originalPath`. Publication is not crash-atomic; fallback opens a private verified recovery copy with automation locked. See [recovery procedures](docs/OPERATIONS.md).

## Development

Node 22+; root dependency Zod 4.1.8; Bun 1.3.14 for bundling. From this directory:

```sh
npm ci --ignore-scripts
npm test
npm run check
npm run build
node scripts/verify-build.mjs --rebuild
```

Package metadata and the lockfile are valid, with Zod pinned to 4.1.8. Run dependency commands in this directory, not a parent/sibling project. Tests include a Bun packaging regression, so Bun is required for the full suite as well as builds. Direct equivalents are `node --test test/*.test.mjs`, `node scripts/check.mjs`, and `node scripts/build.mjs`.

Build output: self-contained Node ESM package `dist/cm-ae/` with `plugin.mjs`, companion `render-worker.mjs`, default `permissions.json` and Zod license; complete `dist/panel`, compatibility mapping, and a deterministic SHA256 manifest. Keep the plugin and worker together. No install, signing, or publishing occurs. V8 parsing of host JSX is not an AE/ExtendScript test.

Final AE source verification passed **264/264 tests, zero failures, skips or cancellations, in 613.0605642 seconds**; `npm run check` checked **32 scripts**; `npm run build` produced **11 hashed artifacts**; and `node scripts/verify-build.mjs --rebuild` passed manifest inventory, SHA256 and reproducibility verification. The verified source is committed as `b3a1fb3` (base `49ef591`), unchanged since verification. Sibling desktop source is committed as `a1e9efeff` (base `fa0b443cd`). Both commits are local and unpushed.

Restore/credential, render-retirement P1/P2 and desktop permission-override findings were fixed and re-reviewed with no remaining concrete findings in those scoped reviews. [Issue status](docs/ISSUE_STATUS.md) records **13 confirmed closed issues; only #7, #15, #16 and #17 remain open**. Final refreshed Windows packaged smoke passed, including four matching artifact hashes, actual loader checks and detached-worker completion with a render double; see [integration evidence](docs/INTEGRATION.md#final-smoke-evidence). Live AE/CEP, macOS and network qualification, signing and approved internal distribution remain absent.

## Configuration

Generate a **new explicit local output** from your existing JSON configuration:

```sh
node scripts/merge-config.mjs ./existing-config.json ./dist/cm-ae/plugin.mjs ./merged-config.json
```

The CLI never searches for or edits global configuration, never overwrites an existing file, and refuses required-artifact failures. Existing plugin strings/tuples and user permission policy remain intact. Read tools, including scoped render listing, default to allow; state-changing tools and explicit render recovery ask; raw tools deny. Template discovery also asks because it temporarily changes the render queue. The adapter rejects unsafe auto-allow policies for privileged operations rather than silently rewriting user rules. Raw scripting additionally requires runtime Session enablement.

After explicitly installing the whole plugin package and selecting the reviewed config in the consumer, fully quit and restart CookieMonster/OpenCode to reload them. Resolve uncertain operations and account for active renders first. Generating the config file alone does not install or activate anything; no restart is performed by these commands.

Desktop staging/startup/packaging is implemented in the sibling's `packages/desktop`, using `CM_AE_ARTIFACT_DIR` and the application version in server `releaseMetadata`, without replacing browser policy. Refreshed Windows packaged smoke passed and #1 is closed; see [integration](docs/INTEGRATION.md).

## Install And Use

There is no approved production installation yet. After release gates pass, install the signed ZXP with the qualified extension manager and open the panel under AE's **Window > Extensions** menu (wording varies by qualified host). Do not bypass signature verification for a pilot.

Select an explicit panel profile and reuse its exact name after restart; `legacy` reuses the previous shared pairing in place. In chat, request a pairing code (`ae_pair`), enter it in the panel, list connections (`ae_connections`), then explicitly bind a saved project (`ae_bind`). Invalid-credential recovery requires a fresh code and explicit confirmation, preserves identity/latches/locks and never automatically reconnects or rebinds. Inspect, propose a structured plan, review it, and approve execution through the existing permission UI. Grant only required filesystem roots. Release the binding when finished.

See [operations](docs/OPERATIONS.md) for scripting preferences, updates, uninstallation, checkpoints and recovery; [release instructions](docs/RELEASE.md) for signing and evidence requirements. The docs describe the intended workflow and gates, not proof that every host scenario is implemented or qualified.
