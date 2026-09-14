# Edit and retry

Each user request has an **Edit and retry** action. It retrieves the complete text and supported attachments from CookieMonster and opens them in the composer. Edit the text, review the current composition target, select any references or skill, then Send. Send without changing the text to retry the request. Cancel retry restores your previous unsent draft.

This creates a new attempt in the same conversation. It preserves earlier messages and starts from the current AE state. To undo earlier edits first, use the request's Restore action and complete its review before retrying. The model is instructed to inspect the current state and avoid repeating mutation scripts blindly. Existing checkpoint requirements still apply to every new edit.

Retry does not branch, delete messages, revert CookieMonster files or restore AE automatically. Original composition references and skill revisions are not silently reused. Requests containing unavailable or unsupported attachments fail without dropping those attachments. Busy sessions, unresolved delivery and recovery block retry. A new attempt uses the normal durable delivery identity; uncertain delivery never retries automatically.

Validation: `node --test test/chat.test.mjs test/chat-panel.test.mjs` and `node scripts/verify-retry-ui.mjs`. The browser check covers draft cancellation, explicit submission and composer placement at 320, 360 and 700px.

Native Windows AE 2026 check: restarted CookieMonster, reopened the installed CEP panel, loaded an existing request through Edit and retry, and cancelled the draft. The original text appeared, the composer remained pinned, and no prompt or project edit was dispatched. Actual resubmission was exercised in bridge and browser tests.
