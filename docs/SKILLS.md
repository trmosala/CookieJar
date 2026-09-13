# Reusable skills in AE

Use **Save technique...** beneath a completed assistant reply to turn it into reusable instructions. Edit the name, description and instructions, choose the scope, then review the destination and select **Save skill**. Existing skills are never overwritten by this flow.

Open **Skills** in the prompt box to search CookieMonster's catalog and select a skill for the next request. Selection is not proof of execution: **Loaded skill** appears only after CookieMonster's native skill tool succeeds. Missing or changed skills require a fresh selection.

Workspace skills belong to the selected CookieMonster directory, not an individual `.aep` file. Other conversations using that directory can reuse them; unrelated workspaces cannot. Global skills use CookieMonster's global storage. The AE extension does not maintain a second skill store.

## Manage existing skills

Select a skill in the composer picker and choose **Manage selected skill**. Copy skill copies the complete saved definition, including additional frontmatter. Managed workspace and global skills can be renamed or edited. Review changes and confirm to save. Review deletion and confirm to remove the definition. Built-in and externally discovered skills are read-only.

Each change pins the selected file identity and revision and uses a single-use review. Changes from another editor invalidate the review. The previous definition is synced and verified in a sibling `.SKILL.md.<id>.bak` file before modification. Bundled scripts and other files stay in place. Renaming changes the skill name, not its containing folder. Deletion leaves backups and bundled files in that folder; creating another skill in the same folder remains deliberately blocked by the exclusive creation flow.

The manager requires the matching CookieMonster `/skill/manage` backend. An uncertain save/delete must be inspected and refreshed, never automatically retried.

## Issue #21 verification — 12 September 2026

- Real integration: AE chat and authenticated bridge, CookieMonster SDK, production skill/session HTTP handlers and on-disk skill storage. Saved reviewed instructions, reloaded chat, selected the same revision in a later conversation, checked prompt metadata, rejected the old selection in another workspace, and detected deletion. Passed 1 test / 12 assertions.
- CookieMonster managed storage and native skill tool tests passed, including workspace/global scope, exclusive creation and revision checks. The skill-selection compaction test also passed.
- Browser flow against the actual panel HTML/CSS/JavaScript passed: edit, review, save, later chat, search, selection and loaded badge. Keyboard focus wraps inside the save dialog; Escape returns to the composer. The composer stays within the viewport at 420×780 and 320×500, including an expanded picker. This browser test uses a simulated chat API.
- AE chat/backend and panel tests passed (39 tests); panel tests passed again after the UI changes (19 tests). Syntax check, build, reproducible artifact verification and CookieMonster typecheck passed.
- Broader CookieMonster skill/tool/compaction run: 68 passed, 1 skipped, 1 failed. The separate cancellation test `stops quickly when aborted during retry backoff` exceeded its 250 ms threshold (408 ms; isolated repeat 415 ms). No cancellation code was changed for this issue.

The real integration replaces model execution and AE composition inspection. These checks do not claim that a live model applied a saved technique to an AE composition.

## Repeatable checks

From the AE repository, with Playwright installed (or `CM_PLAYWRIGHT_MODULE` pointing to its package):

```powershell
node --test test/chat.test.mjs test/chat-panel.test.mjs
node scripts/verify-skills-ui.mjs
npm run check
npm run build
node scripts/verify-build.mjs --rebuild
```

The browser check uses installed Edge on Windows. `CM_BROWSER_CHANNEL` can select another installed Chromium channel; screenshots go to ignored `coverage/`.

From CookieMonster's `packages/opencode` directory:

```powershell
$env:TEMP = node -p "require('node:fs').realpathSync.native(require('node:os').tmpdir())"
$env:TMP = $env:TEMP
$env:CM_AE_SOURCE_DIR = 'D:\Workarea\CookieJar'
bun test --timeout 60000 --test-name-pattern 'AE chat saves a reviewed skill' test/server/httpapi-instance.test.ts
bun test --timeout 60000 test/skill/managed.test.ts test/tool/skill.test.ts test/session/compaction.test.ts
bun run typecheck
```

The cross-repository test is skipped when `CM_AE_SOURCE_DIR` is absent. Set it to the absolute AE source checkout being qualified.
