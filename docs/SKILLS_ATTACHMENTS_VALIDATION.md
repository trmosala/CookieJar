# Skills and attachments validation — 2026-09-13

Installed the updated CookieMonster sidecar and CookieJar development panel, then reopened the panel in After Effects 2026.

Native checks passed for skill search, copy, reviewed rename and backup creation. The renamed file and original backup were checked on disk. Native deletion was not exercised; deletion passed the browser UI flow and the real CookieMonster HTTP test.

Native attachment selection accepted a JavaScript fixture over 3 MiB and a GIF. Holding the picker open, cancelling and reopening it completed without an AE modal-script error after the fix. The panel remained connected. No prompt or composition edit was submitted.

Two native defects were corrected: the skill manager now shrinks to keep the composer visible, and file selection waits for existing host work and pauses new host scripts while maintaining a busy heartbeat. Cancellation resumes polling on window focus or the next panel input for CEP Chromium 99.

Local validation:

- Feature baseline: 387 CookieJar tests passed before the native fixes.
- Final chat-panel regression suite: 29 passed, including modal host exclusion and busy heartbeat.
- Transport suite: 42 passed after the initial modal fix; the final heartbeat change is covered by the chat-panel regression.
- Browser skill copy/edit/review/save/delete and composer bounds at 320, 360 and 700 pixels passed.
- Syntax: 59 scripts checked. Build: 16 hashed artifacts verified and installed.
- CookieMonster skill tests: 12 passed; real HTTP skill management test passed; typecheck passed.

GitHub Actions were not used. Disposable skill evidence and local logs are retained under ignored `coverage/`.
