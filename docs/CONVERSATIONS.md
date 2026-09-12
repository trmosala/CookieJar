# Project conversations in AE

Choose **Conversations** beside **New chat** to find a previous chat for the current AE project. Search matches CookieMonster titles. Each page shows up to ten conversations, their last activity and workspace. Use **Open** to resume a conversation or **Rename** to change its title.

CookieMonster stores the titles and messages. AE keeps only session ownership and execution context, including prior delivery, restore and composition targets. Opening a conversation loads history without submitting a prompt, binding AE or replaying an edit. The last captured composition is restored to the picker; a removed composition stays visibly missing and cannot silently fall back to the active viewer.

New chat, Open and Rename are blocked while a reply, permission, AE operation, restore or uncertain delivery needs resolution. Stale requests and responses cannot switch or populate another conversation. A deleted CM session remains visible as unavailable, with access to the other project conversations.

Older extension versions saved previous session IDs without workspace or targeting context. These IDs are resolved only within their recorded workspace. If that workspace does not match, open the old conversation in CookieMonster. No search across unrelated workspaces is used to guess ownership.

## Verification

On 12 September 2026, the full AE suite passed 361 tests. Follow-up rename/switching checks passed after the final guards. The real CM integration passed 18 assertions, desktop bundle validation passed 22 tests, and permission precedence passed 12 scenarios. Both package typechecks, browser flows, syntax check and reproducible artifact verification passed.

The backend checks cover two conversations reopened and renamed after reload, fixed targets, search and paging, foreign project/workspace rejection, missing sessions, busy and uncertain switching, and delayed history responses. Titles are read back after renaming and are not written to the AE ownership file.

The browser check uses the real panel HTML, CSS and JavaScript with a simulated chat API. It covers paging, search, rename, reload, reopen, fixed targets, a delayed poll from the previous chat, empty and disconnected states, busy controls and keyboard navigation at 320×500.

The cross-repository test runs the real AE authenticated bridge and CookieMonster session/skill APIs with temporary workspaces. Model execution and AE inspection are simulated. It verifies both renamed conversations after chat reload, reopening without prompt dispatch, targeting and a deleted CM session. This does not claim a live model or native AE editing test.

From this AE checkout:

```powershell
node --test test/chat.test.mjs test/chat-panel.test.mjs
node scripts/verify-conversations-ui.mjs
```

The browser check uses Playwright and installed Edge on Windows. Set `CM_PLAYWRIGHT_MODULE` if Playwright is installed outside this repository. The screenshot is saved under ignored `coverage/`.

From CookieMonster's `packages/opencode` directory:

```powershell
$env:TEMP = node -p "require('node:fs').realpathSync.native(require('node:os').tmpdir())"
$env:TMP = $env:TEMP
$env:CM_AE_SOURCE_DIR = 'D:\Workarea\CookieJar-issue22'
bun test --timeout 60000 --test-name-pattern 'AE chat saves a reviewed skill' test/server/httpapi-instance.test.ts
```

The integration test is skipped without `CM_AE_SOURCE_DIR`. Point it at the absolute source checkout being tested.
