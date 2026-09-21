# Repository guidance

## Commands

- Use Node 22+ and Bun 1.3.14. Bun is needed by some tests as well as the build; npm installs do not supply it.
- CI runs `npm ci --ignore-scripts`, `npm test`, `npm run check`, `npm run build`, then `node scripts/verify-build.mjs --rebuild` on macOS and Windows with Node 22/24.
- Focused file: `node --test test/panel-host.test.mjs`. Focused case: `node --test --test-name-pattern="pattern" test/panel-host.test.mjs`.
- `npm test -- --test-name-pattern="pattern"` forwards Node flags, but `scripts/test.mjs` always appends every `test/*.test.mjs` file and sets concurrency to four. Passing a filename to `npm test` does not narrow the suite.
- Storage fixtures require canonical temporary paths. CI resolves `os.tmpdir()` with `realpathSync.native` and exports it as `TMPDIR`, `TMP`, and `TEMP`. The test wrapper sets only `TMP`/`TEMP`; on macOS also canonicalize `TMPDIR` to avoid `/var` versus `/private/var` failures. Do not relax production path checks to fix fixtures.
- `npm run check` checks syntax and package metadata, not types or lint. Its JSX check uses V8, not After Effects.
- Browser QA is separate from `npm test`. For example, `node scripts/verify-redesign-ui.mjs` needs external Playwright via `CM_PLAYWRIGHT_MODULE` or module resolution, installed Microsoft Edge, and an existing `coverage/` directory. It uses UI fixtures, not live AE.

## Runtime boundaries

- `src/plugin.mjs` exports `{ id: "cm-ae", server }`. Importing it must not start listeners or touch the filesystem; the `server` lifecycle shares a reference-counted runtime across directory-scoped plugin instances.
- `src/chat.mjs` delegates messages, models, and permissions to CookieMonster. Local chat state holds project/session ownership and delivery/recovery records, not a second conversation history.
- `panel/index.html` loads plain browser scripts. Keep browser code ES5; `panel/ui.js` uses the Node transport rather than browser networking or a CSInterface dependency. `panel/transport.cjs` is the CommonJS bridge to Node and host RPC.
- `panel/host.jsx` runs inside AE and must remain ES3. Do not apply Node/browser syntax assumptions to it. Host tests use doubles and cannot establish native ExtendScript compatibility.
- `src/render-worker.mjs` is a separate process entrypoint. Keep it separately bundled beside `plugin.mjs`; its own `import.meta.url` is required for detached worker launch.

## Build and integration

- Edit sources, not `dist/`. Builds copy the panel without transpilation and bundle the Node entrypoints. Do not run concurrent builds in one checkout.
- `verify-build.mjs --rebuild` first verifies an existing `dist/`, then rebuilds using its recorded profile and compares manifests byte-for-byte. Run a build first; keep unrelated files out of `dist/`.
- `node scripts/build.mjs --client` changes script approval policy to `ask`; development defaults to `allow`. Client builds reject matching auto-allow overrides. Keep plugin enforcement and packaged permissions consistent.
- `release/AGENTS.md` is shipped installation guidance copied to `dist/AGENTS.md`, not this root file. Preserve its checksum and installation requirements when changing release packaging.
- Version values are duplicated in `package.json`, `package-lock.json`, `src/protocol.mjs`, `panel/transport.cjs`, `panel/CSXS/manifest.xml`, `panel/index.html`, and `compatibility.json`. Updating npm metadata alone does not update the installed pair.
- Local `opencode.json` is git-ignored. The development consumer loads `dist/cm-ae/plugin.mjs`; keep the complete `cm-ae` directory together. Rebuilding does not reload a running consumer. Matching panel installation and application restarts are separate steps; see `docs/INTEGRATION.md`.

## AE safety

- Preserve the inspect/current revision, verified checkpoint, execute, and inspect flow. Scripts are unsandboxed; grants do not constrain arbitrary script side effects, and checkpoints do not undo external effects.
- Uncertain scripts/captures are not automatically retried. Panel-local uncertainty and durable bridge locks require separate reconciliation. Never delete profiles, locks, or recovery files to unblock testing.
- The bridge creates `~/.cookiemonster-ae/`; any `CM_AE_DATA_DIR` override must match in AE and CookieMonster. An absent runtime directory is a startup diagnostic, not a reason to create an empty replacement.
- Use disposable projects for native tests. `docs/FIRST_TEST.md` contains host probes and historical evidence, not blanket current-version verification. `compatibility.json` and `docs/DEPLOYMENT_READINESS.md` track release gates; passing unit tests or builds does not certify AE or approve distribution.
