# Presentation preferences

Settings > General provides Small, Normal and Large text; Comfortable and Compact spacing; Enter or Ctrl/Cmd+Enter to send; and automatic, collapsed or expanded activity/reasoning details. Shift+Enter always preserves a new line. IME composition never submits a message.

Preferences persist in a separate presentation-only local storage entry. Invalid or oversized saved values fall back to readable defaults. Reset affects only these four choices; individual message disclosure choices, connection credentials and recovery state are preserved. Activity defaults never hide actionable permission questions.

Validation: 26 focused preference/chat-panel tests passed, including IME/send keys, persistence, malformed values, reset and manual disclosure choices after reload. The browser check verified persistence/reset and 320/360/700px layouts with Large text. Syntax and reproducible artifact checks passed. No backend permission or execution policy was changed.
