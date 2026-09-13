# Custom CEP panel redesign (#27)

The panel follows the [approved reference](https://github.com/trmosala/CookieJar/blob/docs/ae-ui-redesign-reference/docs/design/ae-chat-redesign.png): warm dark surfaces, small corners, a compact project header, plain assistant replies, collapsed steps and a bottom composer. It retains the custom CEP implementation and authenticated bridge.

The top-left hamburger opens a project-scoped Conversations overlay. New chat, search, paging, rename and reopen use the existing CM session lifecycle. Opening the drawer does not send a prompt; reopening loads history without replaying edits. Busy/recovery guards explain unavailable switching. Escape returns focus to the hamburger; selecting a conversation returns focus to the composer. Long project and conversation names truncate with full-text tooltips.

The separate Settings gear opens preferences, connection, recovery and render services. Both overlays contain keyboard focus and close with Escape. The composer retains skills, attachments, frame capture, model/reasoning choice, composition/layer references, Send and Stop. At 320px the model controls use their own toolbar row. The composer remains pinned while history scrolls. Approvals and recovery notices remain outside collapsed activity.

Recent completed frame captures expand by default; older images remain collapsed. Existing manual choices survive. Composition ID and time captions come only from validated capture output; missing metadata falls back to the attachment filename.

## Validation (2026-09-13)

- Complete AE suite: 378 passed, zero failures. Additional targeted capture-metadata assertion passed after the suite.
- Syntax check and reproducible build inventory: 16 hashed artifacts.
- Browser verification scripts: conversations, skills, preferences, targets, render dashboard and redesign. Tested 320/360/700px, pinned composer, visible controls, Escape/focus, stale responses and no prompt on navigation.
- CookieMonster vendored bundle: 22 tests passed. Source and vendor checksum match.
- Browser screenshots are synthetic transport fixtures, not native AE evidence: `coverage/redesign-320.png`, `redesign-360.png`, `redesign-700.png`, `redesign-settings.png`.
- The final build is installed in the development CEP directory and copied to the configured local plugin dist. Previous installed files are backed up by the installer.

Native limitation: Windows was locked when the final reload/visual check was attempted. The tool returned access denied and a lock-screen image. Final redesigned chat/drawer/settings have therefore **not** been visually qualified in native CEP. Earlier composer capture was verified after restarting CookieMonster through the normal bridge. The final panel and runtime still require reload after unlocking; browser checks do not certify Chromium 99 or AE point-version compatibility.

No OpenCode web embed, second history store, CSP relaxation, permission-policy change or automatic restoration was introduced.
