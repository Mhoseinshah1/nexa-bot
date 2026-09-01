# MASTER — General Settings follow-up (4 sections) — AUTHORITATIVE

Continuation of the General Settings investigation. The Bot Capabilities section
(`⚙️ وضعیت قابلیت ها`) was completed in the previous phase and is **not** revisited here.

## PHASE_STATUS
**COMPLETE for a read-only phase.** All four target sections were opened and documented.
Two buttons were deliberately left unpressed (both destructive); everything else the UI can show
without a write has been captured.

## TARGET_SECTIONS
`📣 گزارشات ربات` ✅ · `📯 تنظیمات کانال` ✅ · `🗑 بهینه سازی ربات` ✅ (inspected, **not executed**) ·
`⚠️ مبلغ هشدار موجودی` ✅

## CHANGES_MADE_INTENTIONALLY
**NONE.**

## ACCIDENTAL_CHANGES
**NONE.** State verified: the reports group id read identically before and after the phase.

## HEADLINE FINDINGS

1. **`📣 گزارشات ربات` is not reports.** It is a single field holding the numeric id of the Telegram
   **group** that receives bot notifications. No report types, no schedule, no viewer. The group must
   have topics enabled and the bot must be its admin. A destination **is** configured today.

2. **`📯 تنظیمات کانال` is forced-join membership, and it has no on/off switch.** It is a
   *collection* of channels; adding one enables the gate, and only deleting every one disables it.
   A channel is identified by `@username` **or** a `-100…` id. **The configured channels are never
   displayed** — the only screen that would list them is the delete flow, so reading this setting
   requires entering a destructive path.

3. **`🗑 بهینه سازی ربات` is an irreversible bulk deletion of six order classes — including unpaid
   orders — presented with one inline button and no cancel.** Opening the section shows the warning
   and the confirm button immediately. There is no count, no scope filter, no backup advice, and no
   second confirmation. The label reads like routine housekeeping. **Not executed.**

4. **`⚠️ مبلغ هشدار موجودی` warns the *customer* about the *customer's own* wallet balance** — not
   the admin, not a panel or server balance. It is a single global Toman amount with no tier
   segmentation and no echoed current value. **Its counterpart capability `⚠️ اعلان کاهش موجودی` is
   `❌ خاموش`, so the threshold is inert today.**

5. **Two adjacent settings, two different id formats.** Reports accepts only a numeric id; channel
   settings accepts a username or a numeric id. Nothing explains the difference.

6. **Three of the four screens show no current state at all**, continuing the write-only pattern
   quantified in the previous phase.

## UNKNOWN
See `unknowns.md` — 12 registered items. The P1 ones: which channels are enforced right now
(UNK-GS-001), whether the optimization confirm executes immediately (UNK-GS-006, intentionally left
open), and how many records it would delete (UNK-GS-007).

## NOT_EXPOSED
Report types, schedules and frequencies · a notification test-send · a second notification
destination · a topic/thread selector despite topics being required · the forced-join channel list ·
the stored balance-warning amount · any record count or dry-run for optimization · any log of
previous optimization runs · any undo.

## BLOCKERS
None. The browser bridge dropped twice mid-phase; all four sections were captured before and after.

## INCIDENTS
**NONE.** See `incidents.md`.

## AUTHORITATIVE_FILES
`menu-tree.md` · `robot-reports.md` · `channel-settings.md` · `bot-optimization.md` ·
`balance-warning-amount.md` · `business-rules.md` (GSR-001..010) · `crossmap.md` · `unknowns.md` ·
`incidents.md` · `progress.md` · plus the root deliverables.
