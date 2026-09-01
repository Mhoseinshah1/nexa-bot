# Incidents — User Management phase

An **INCIDENT** is something this investigation did or suffered. Defects in MirzaBot itself go to
`source-bugs.md` and are never filed here.

## INCIDENT-UM-001 — claude-in-chrome MCP server disconnected during menu mapping

**When**: immediately after the `👤 مدیریت کاربر` inline menu was successfully read out of the DOM and
written to `menu-tree.md`, while taking a confirming screenshot.

**Symptom**: `Connection closed`, then the `claude-in-chrome` server no longer appears in
`RefreshMcpTools`. Same failure class as INCIDENT-001 / 004 / 007 in the Store phase — this is the
fourth occurrence across the project and appears to be environmental, not caused by any action taken.

**Impact on data**: none. Nothing was in flight. No message had been sent since
`👤 مدیریت کاربر`, which the bot had already answered. No user, balance, tier or service was touched —
at the time of the drop **not a single state-changing action had been performed in this phase at all**.

**State at the drop**: bot sitting on the User Management inline menu; test user not yet searched;
baseline not yet captured.

**Resolution**: findings up to the drop were already written to disk (per the audit-knowledge-base
skill's "write continuously" rule), so nothing was lost. Offline documentation work continued while
waiting for the tool to return; on reconnection the first action is a **read**, not a click, to
re-establish state.

## INCIDENT-UM-002 — Two unintended button presses caused by in-place message editing

**What happened**: twice, a coordinate read from the DOM was already stale by the time the click
landed, because `♻️  بروزرسانی اطلاعات` **edits the record message in place** (UBR-005) and the attached
29-button keyboard re-flows. The clicks intended for `🎁 درصد تخفیف` landed on:

1. `➕ محدودیت اکانت تست` — the bot then asked `تعداد ساخت اکانت تست را ارسال کنید`. **Resolved safely**:
   the baseline value `1` was re-sent, so the field ends where it started (`محدودیت اکانت تست : 1`,
   re-verified on the record).
2. `تایید دستی شماره تلفن` — the bot answered `شماره کاربر تایید گردید.` ("the user's phone was
   verified"). This fired **twice**.

**Authorisation**: both buttons are inside the owner's explicit authorisation for this account
([TELEGRAM_USER_ID_REDACTED]), so no boundary was crossed. They were, however, **not intended at that moment**, which is
why they are logged rather than quietly absorbed.

**Impact**: the test-account limit is back at its baseline. The manual phone-verification flag was set;
the account's baseline had `شماره موبایل : none` and `وضعیت تایید قانون : تایید نشده`, and the effect of
this button on those fields still needs to be re-read and, if it changed anything, reverted using
`عدم احراز کاربر` or the equivalent. **This is recorded as an outstanding restoration item in
`test-user-state.md`.**

**Root cause**: the DOM read and the click are two separate tool calls, so any layout change in between
invalidates the coordinate. This is a sharper version of the "same-turn screenshot" rule already in the
audit skill: with an in-place-edited keyboard, even a same-turn *DOM read* is not sufficient.

**Corrective method adopted**: after any action that edits the record, take a fresh screenshot and click
from **that** screenshot, and confirm the bot's reply — which arrives further down the chat — before
pressing anything else. (This is exactly what the owner advised mid-session.) Scroll to the bottom
before reading, because the virtual scroller otherwise returns a stale last bubble.

## INCIDENT-UM-003 — Fourth browser-tool outage

The `claude-in-chrome` MCP server dropped again while the next round of main-menu testing was being
planned. Nothing was in flight; no action had been started. Same environmental failure class as
INCIDENT-UM-001 and the three Store-phase outages. No data impact.

State at the drop: test user `[TELEGRAM_USER_ID_REDACTED]` unblocked and stable; bot idle on the user record.
