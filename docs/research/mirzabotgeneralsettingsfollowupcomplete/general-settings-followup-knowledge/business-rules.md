# Business rules — General Settings follow-up (GSR-###)

## GSR-001 — "گزارشات ربات" configures a notification destination, not reports
- **Rule:** `📣 گزارشات ربات` holds exactly one value: the numeric Telegram **group** id the bot
  sends notifications to. It contains no report types, schedule, frequency, format or viewer.
- **Section:** گزارشات ربات
- **Evidence:** the prompt asks only for `آیدی عددی گروه ... برای ارسال اعلان`; the screen's only
  other content is a 5-step group-setup tutorial; the reply keyboard is navigation only.
- **Effect:** anyone looking for reporting must go to `📊 آمار ربات`. A rebuild should name this
  field "notification group", not "reports".
- **Confidence:** VERIFIED_BY_UI.

## GSR-002 — The notification destination must be a topic-enabled group with the bot as admin
- **Rule:** the bot states three preconditions: it must be a **group**, the group must have
  **topics / forum mode** enabled, and **the bot must be an admin** of it.
- **Section:** گزارشات ربات
- **Evidence:** steps 3 and 4 of the in-prompt tutorial.
- **Effect:** a plain channel or a topicless group will not work. A rebuild must validate this, or
  at least surface the failure — the bot currently gives no feedback either way.
- **Confidence:** VERIFIED_BY_UI (the requirement is stated); the enforcement is UNKNOWN.

## GSR-003 — Notification destination is a single group; there is no fallback and no test
- **Rule:** one id, one destination. No secondary target, no per-notification routing, no test-send,
  no way to clear the field.
- **Section:** گزارشات ربات
- **Evidence:** the screen offers no other control.
- **Effect:** if that group is deleted or the bot is removed from it, admin notifications go nowhere
  and nothing in the bot says so.
- **Confidence:** VERIFIED_BY_UI (absence); the silent-failure consequence is INFERRED.

## GSR-004 — Forced-join is a channel *collection*, and its membership IS the on/off switch
- **Rule:** `📯 تنظیمات کانال` implements forced channel membership. It is enabled by adding at
  least one channel and can be disabled **only** by removing every channel. There is no toggle.
- **Section:** تنظیمات کانال
- **Evidence:** `برای فعال کردن قابلیت جوین اجباری یک کانال اضافه کنید` +
  `برای غیرفعال کردن این قابلیت باید تمام کانال ها را حذف کنید`.
- **Effect:** the only way to switch the gate off temporarily is to delete configuration you then
  have to retype. A rebuild should add an explicit enable flag alongside the list.
- **Confidence:** VERIFIED_BY_UI.

## GSR-005 — A forced-join channel is identified by @username **or** a `-100…` numeric id
- **Rule:** `اضافه کردن کانال` accepts either form; the bot says the username must include the `@`.
- **Section:** تنظیمات کانال
- **Evidence:** `لطفا یوزرنیم کانال خود با @ را یا آیدی عددی کانال که با -100 شروع میشود را وارد نمایید`.
- **Effect:** private channels (no username) are supported via the numeric id.
- **Contrast:** `📣 گزارشات ربات` accepts **only** the numeric id — two adjacent settings in the same
  menu with different accepted formats and no explanation.
- **Confidence:** VERIFIED_BY_UI.

## GSR-006 — The forced-join channel list cannot be read without entering the delete flow
- **Rule:** `📯 تنظیمات کانال` never displays the configured channels. The only screen that would
  plausibly enumerate them is `حذف کانال`.
- **Section:** تنظیمات کانال
- **Evidence:** the section's own screen shows only the two action buttons; no list, no count.
- **Effect:** an admin who wants to know which channels are enforced must open a destructive path
  to find out. This is a read-requires-risk design, and a sharper version of BC-SB-003
  (read-requires-write) from the previous phase.
- **Confidence:** VERIFIED_BY_UI for the absence; the delete-flow contents are UNKNOWN (not opened).

## GSR-007 — "بهینه سازی ربات" is an irreversible bulk deletion of six order classes
- **Rule:** confirming it deletes inactive orders, **unpaid orders**, admin-deleted orders, inactive
  test services, user-deleted orders, and orders whose time or volume has expired. The bot states
  the operations are `قابل بازگشت نیستند` — not reversible.
- **Section:** بهینه سازی ربات
- **Evidence:** the verbatim warning message.
- **Effect:** it destroys the bot's own order history, including the record of unpaid/failed
  payments. It is not a cache or storage optimisation.
- **Confidence:** VERIFIED_BY_UI (the declared scope). What it actually removes at the database
  level was **not** tested and must not be.

## GSR-008 — The balance warning targets the customer, and its alert is currently disabled
- **Rule:** `⚠️ مبلغ هشدار موجودی` is the threshold at which **the customer's own wallet balance**
  triggers a warning message **sent to the customer**. Its counterpart capability
  `⚠️ اعلان کاهش موجودی` is `❌ خاموش`, so no such warning is being sent today.
- **Section:** مبلغ هشدار موجودی
- **Evidence:** `موجودی کاربر به آن مبلغ رسید به کاربر پیام هشدار ارسال شود` (this phase) +
  the capability state captured and re-verified in the Bot Capabilities phase.
- **Effect:** the setting is inert until the capability is enabled. A rebuild should either grey the
  field out or say so on the screen.
- **Confidence:** VERIFIED_BY_UI for both halves; the code-level gating between them is INFERRED.

## GSR-009 — The balance warning is a single global number, not tier-segmented
- **Rule:** one amount applies to every user tier.
- **Section:** مبلغ هشدار موجودی
- **Evidence:** the prompt names no tiers and echoes no per-tier values.
- **Contrast:** `⬇️ حداقل شارژ موجودی` in Financial **is** tier-segmented
  (`f` 50,000 / `n` 100,000 / `n2` 20,000 تومان). So tier-segmentation in this product is
  per-setting, not a global convention — a rebuild must not assume either way.
- **Confidence:** VERIFIED_BY_UI.

## GSR-010 — Three of the four sections are bare value prompts with no current-value echo
- **Rule:** `📯 تنظیمات کانال` (no channel list), `⚠️ مبلغ هشدار موجودی` (no amount) show nothing of
  their current state. Only `📣 گزارشات ربات` echoes its current value.
- **Section:** all four
- **Evidence:** the four screens as captured.
- **Effect:** continues the pattern quantified in the previous phase (BC-SB-003): MirzaBot's admin
  UI is largely write-only, so auditing configuration through the bot is impossible.
- **Confidence:** VERIFIED_BY_UI.
