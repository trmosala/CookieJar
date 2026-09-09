# CookieMonster After Effects

Standalone, pre-production AE sidecar plugin and CEP panel. **Unsigned and not certified.** AE 25/26 are candidates, not supported-environment claims. See [issue status](docs/ISSUE_STATUS.md), [qualification](docs/QUALIFICATION.md) and [pilot gates](docs/PILOT.md).

**Capture unavailable:** `ae_capture` always returns `unsafe_state` on the current host path because there is no reliable preview/modal detection signal. Image normalization and attachment tests do not establish working capture.

`comp.reorder` is unsupported by the documented AE native API. Manual checkpoint restore opens a verified recovery copy and requires Save As and explicit rebind; guarded automatic rollback of stopped, acknowledged structured-operation errors is separate.

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

The coordinating parent's final-source verification passed **182/182 tests, zero failures, skips or cancellations, in 246.2576849 seconds**; `npm run check` checked **32 scripts**; `npm run build` produced **11 hashed artifacts**; and `node scripts/verify-build.mjs --rebuild` passed manifest inventory, SHA256 and reproducibility verification.

The parent reports all findings from the original five safety-review findings and seven acceptance-review findings plus the final three findings fixed and rechecked, with no remaining concrete P1/P2 findings in those targeted reviews. Final verified artifacts include `dist/cm-ae/plugin.mjs`, its companion `dist/cm-ae/render-worker.mjs`, and `dist/panel`. [The evidence ledger](docs/ISSUE_STATUS.md) separates standalone implementation from acceptance: all 17 issues remain open and remotely unmodified. No live AE run was attempted; no commits, pushes or deployment were performed by this workstream.

## Configuration

Generate a **new explicit local output** from your existing JSON configuration:

```sh
node scripts/merge-config.mjs ./existing-config.json ./dist/cm-ae/plugin.mjs ./merged-config.json
```

The CLI never searches for or edits global configuration, never overwrites an existing file, and refuses required-artifact failures. Existing plugin strings/tuples and user permission policy remain intact. Read tools, including scoped render listing, default to allow; state-changing tools and explicit render recovery ask; raw tools deny. Template discovery also asks because it temporarily changes the render queue. The adapter rejects unsafe auto-allow policies for privileged operations rather than silently rewriting user rules. Raw scripting additionally requires runtime Session enablement.

After explicitly installing the whole plugin package and selecting the reviewed config in the consumer, fully quit and restart CookieMonster/OpenCode to reload them. Resolve uncertain operations and account for active renders first. Generating the config file alone does not install or activate anything; no restart is performed by these commands.

For the desktop application integrator, see [the consumer bridge](docs/INTEGRATION.md). This repo does not modify CookieMonster desktop packaging or startup: **#1 remains partial**.

## Install And Use

There is no approved production installation yet. After release gates pass, install the signed ZXP with the qualified extension manager and open the panel under AE's **Window > Extensions** menu (wording varies by qualified host). Do not bypass signature verification for a pilot.

In chat, request a pairing code (`ae_pair`), enter it in the panel, list connections (`ae_connections`), then explicitly bind a saved project (`ae_bind`). Inspect, propose a structured plan, review it, and approve execution through the existing permission UI. Grant only required filesystem roots. Release the binding when finished. Reconnect does not imply automatic rebinding.

See [operations](docs/OPERATIONS.md) for scripting preferences, updates, uninstallation, checkpoints and recovery; [release instructions](docs/RELEASE.md) for signing and evidence requirements. The docs describe the intended workflow and gates, not proof that every host scenario is implemented or qualified.
