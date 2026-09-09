# Desktop Integration Boundary

[#1](https://github.com/trmosala/CookieJar/issues/1) remains partial. The standalone plugin now builds, exports `{ id: "cm-ae", server }`, and ships with `render-worker.mjs`. Parent verification reports a clean actual-package build/rebuild; it does not prove sibling desktop packaging/startup or existing browser regressions. No sibling files are changed.

## Consumer Bridge

The desktop startup owner can use the source helper after locating both trusted artifacts:

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

Existing permission rules keep their order; global string policy is preserved. New defaults are subordinate to user rules, not permission to rewrite them. The current adapter separately rejects auto-allow for privileged operations, including matching wildcard/agent rules. A preserved but incompatible policy may therefore block startup or an operation; review the explicitly selected config rather than silently widening permissions or changing browser policy. The desktop owner must confirm its actual loader and permission semantics.

## Adapter Policy

`AE_PERMISSIONS` covers pairing/connections, binding/release, inspection/proposals/execution, grants/capture, raw scripting, checkpoints/restore, templates, rendering and diagnostics/reconciliation.

- `ae_render_list`: `allow` for scoped read-only discovery; listing does not grant control of a recovered job or another project's jobs.
- `ae_render_recover`: `ask` for the adapter's explicit recovery-access path under integration. A policy entry alone does not make a tool available; confirm the installed adapter inventory.
- `ae_templates`: `ask`, not read-only. Current host discovery temporarily adds/removes a render-queue item, validates the saved bound project and takes an execution lock.
- `ae_render_status` and `ae_render_result`: `allow`; recovery/control still needs its explicit authorization path.
- Mutation/control tools: `ask`; `ae_raw_enable`, `ae_raw_propose`, `ae_raw_execute`: `deny` by default. Runtime Session enablement is separately required.

Rollback/chunking, grant handling and explicit recovery changes are undergoing independent review. Do not infer a fixed action cap, automatic rollback guarantee or final recovery behavior from an older build; the parent must verify the final integrated adapter.

## Remaining Desktop Evidence

- Development and packaged desktop builds both include/start browser and AE artifacts without replacing entries.
- Optional-artifact failures are visible and current browser tests/permissions remain unchanged.
- Actual OpenCode hooks, generic approvals, attachments, Session deletion and disposal are exercised.
- Record the exact CookieMonster build, installer hash and approved update URL; none is supplied by this standalone repo.
