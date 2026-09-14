# CookieJar AE release installation

These instructions apply to an extracted CookieJar AE team-release archive. Treat the archive as immutable input. Do not edit the signed ZXP, `cm-ae` package, manifests, receipts, or checksums in place.

## Before installation

1. Read `README.md`, `build-manifest.json`, `compatibility.json`, `signing-receipt.json`, and `SHA256SUMS.txt` from this extracted folder.
2. Verify every entry in `SHA256SUMS.txt`, including this file. A matching checksum detects damage but does not prove who supplied the archive. Confirm the release through the team's trusted channel.
3. Confirm the ZXP and `cm-ae` backend have the same full release version. Do not combine this panel with an older backend or desktop-bundled plugin.
4. Stop if the archive is incomplete, a hash fails, the platform is outside the recorded test scope, or recovery reports an uncertain operation. Preserve checkpoints, recovery files, and evidence.

## Install the backend

Use the bundled installer with Node 22+ after identifying the exact configuration loaded by this OpenCode instance. No npm installation or source checkout is needed. First preview:

```sh
node install.mjs --config /absolute/path/to/opencode.json
```

Then apply the requested installation:

```sh
node install.mjs --config /absolute/path/to/opencode.json --apply
```

Windows launcher: `./Install.ps1 -Config C:/absolute/path/opencode.json -Apply`. macOS launcher: `sh ./install.command --config /absolute/path/opencode.json --apply`. Omit the apply argument to preview. The selected configuration must already exist and contain strict JSON. JSONC or desktop-generated configurations require their owning application's configuration mechanism; do not remove comments or overwrite generated settings to force installation.

The installer verifies release hashes, installs the complete backend, updates an existing registration within the documented version directory, preserves other plugins and existing policy, and retains a configuration backup. Repeating the same installation verifies the existing files. Different bytes under the same release version are refused. It reports runtime activation, panel connection and binding as pending until verified after restart. It does not install the signed ZXP or restart applications. If a custom CM_AE_DATA_DIR is reported, confirm AE inherits the same value; otherwise use the default.

Copy the contents of `cm-ae/` directly into a new per-user version directory. Do not add another `cm-ae` directory inside it and do not register the extracted release or Downloads folder as the permanent plugin location.

| Platform | Version directory |
| --- | --- |
| macOS | `~/Library/Application Support/CookieMonster/plugins/cookiejar-ae/VERSION/` |
| Windows | `%LOCALAPPDATA%\CookieMonster\plugins\cookiejar-ae\VERSION\` |

Replace `VERSION` with the exact version in `build-manifest.json`, including any prerelease identifier. The version directory must contain `plugin.mjs`, `render-worker.mjs`, `permissions.json`, and the supplied license files.

Find the configuration that this CookieMonster/OpenCode instance actually loads. Back it up before changing it. Merge one reference to the installed `plugin.mjs` and the supplied AE permission defaults while preserving existing plugins, MCP integrations, provider settings, and user permission rules. Never weaken a stricter rule merely to make startup succeed. Retain the previous version and configuration backup for rollback.

OpenCode uses a `plugin` array and a `permission` object. For example, an existing configuration may become:

```json
{
  "plugin": ["existing-plugin", "C:/Users/USER/AppData/Local/CookieMonster/plugins/cookiejar-ae/VERSION/plugin.mjs"],
  "permission": { "existing_tool": "ask", "ae_execute": "ask" }
}
```

This is a shape example, not a replacement configuration or the complete AE policy. Expand the actual user path and version. Copy every default from the supplied `cm-ae/permissions.json` only where the existing configuration has no rule for that tool. Preserve existing plugin entries, including tuple entries with options, and avoid registering the same installed path twice. Preserve wildcard, agent-specific, string-form and ordered permission policies; if their precedence is unclear, leave the original configuration intact and report the conflicting rule. Never replace a whole configuration with this example. Write a proposed merged copy, inspect the diff, then apply it with the original backup retained. Desktop-generated configuration may require the desktop's own configuration mechanism.

To check the panel version, read `CSXS/manifest.xml` inside the ZXP with an archive reader without modifying the archive. Compare `ExtensionBundleVersion` with the numeric release version. For prereleases, the CEP version may omit the prerelease suffix: require the signed panel files to match the `panel/` hashes in `build-manifest.json` as well. Version labels alone do not prove that builds match.

The backend installation directory is not runtime state. The bridge creates `~/.cookiemonster-ae/` unless `CM_AE_DATA_DIR` overrides it. The panel and backend must use the same override. Do not create an empty runtime directory to mask an `ENOENT`; diagnose plugin loading and bridge startup instead.

## Install the panel

Install the supplied ZXP with the qualified extension manager described in `README.md`. Do not disable signature verification. The ZXP installs only the After Effects panel. The `cm-ae` plugin starts the local bridge, so both components are required.

Before restarting applications, ask the user to resolve uncertain operations and account for active renders. Fully quit and restart CookieMonster/OpenCode after installing or changing its plugin configuration. Restart After Effects after installing the panel. Do not terminate either application without the user's approval.

## Verify and report

Report each status separately. File installation does not prove runtime activation.

- Release hashes and ZXP signature verification
- Backend import and CookieMonster/OpenCode plugin activation
- Live bridge startup
- AE panel connection
- Pairing and saved-project binding
- Read-only inspection, approval, edit, checkpoint restore, capture, and render tests actually performed

The saved `.aep` parent directory must already be registered or open as a CookieMonster workspace. If it is unavailable, report the exact folder the user must open. Do not silently select an ancestor or another registered workspace.

Use disposable AE projects for live testing. Preserve the user's existing compositions, configuration, credentials, checkpoints, and recovery state. Do not claim client approval, platform certification, or end-to-end verification unless the supplied release evidence and the tests you performed establish it.
