# Incidents — Robot Statistics v2

## No mutation of any kind occurred.

Actions taken, exhaustively:
- 26 inline-callback presses, every one of them a report render or a navigation step.
- 7 typed messages, all of them required inputs to read-only prompts:
  `2026/08/01`, `2026/08/31` (custom range) · `[TELEGRAM_USER_ID_REDACTED]` (authorised user lookup) ·
  `2026/08/31`, `2026/08/31`, `2026/09/01`, `2026/09/01` (comparison custom range).
- No refund, no wallet change, no order or service deleted, no payment status changed, no receipt
  approved or rejected, no user modified, no counter reset, no product touched, no bulk action.

The feature contains no control capable of any of those, which is itself a finding (RSV2-BR-022).

## INCIDENT-RSV2-001 — one stale-keyboard press (benign)

While navigating out of the product comparison, one press landed on a keyboard belonging to an older
overflow message. The bot re-rendered `آمار کل` onto the canvas instead of opening the intended report.
No state changed; the step was simply repeated. Recorded because it illustrates
SOURCE_UX-RISK-STATS-008 rather than because it caused harm.

## Tooling notes

- The `claude-in-chrome` bridge dropped twice during the phase (once mid-way, once after the last
  capture). All findings were written to disk continuously, so nothing was lost. When the extension's
  batch/computer tools failed, typing was done by focusing the composer and using
  `document.execCommand('insertText', …)` plus a click on the send button — the same user-visible effect.
- Telegram Web virtualises the message list, so a real scroll action is required before reading new
  bubbles from the DOM; several captures were re-read after a scroll for this reason.
- Emoji are rendered as `<img alt>`; text was extracted with a walker that resolves `alt`, because plain
  `innerText` silently drops them. This is what the first pass missed (CON-003, CON-006).
