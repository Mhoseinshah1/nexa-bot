# MirzaBot source defects observed during the Bot Capabilities phase

These are defects **in MirzaBot itself**, not investigation mistakes.
Investigation mistakes live in `incidents.md` — the two are never merged.

## BC-SB-001 — Missing "back to previous menu" on two sub-screens
- **Where:** `🔗 لینک دانلود برنامه → ⚙️ تنظیمات → ✏️ ویرایش برنامه`, and the
  `🎁 قرعه کشی شبانه` / `🎲 گردونه شانس` settings menus.
- **Defect:** these screens offer only `🏠 بازگشت به منوی مدیریت`, with no
  `▶️ بازگشت به منوی قبل`. Every comparable screen in the bot offers both.
- **Effect:** the admin is thrown back to the **top** of the admin panel and must
  re-navigate three levels to reach the sibling option. Worse, in one observed case
  `🏠 بازگشت به منوی مدیریت` from the app list landed on the bot's `/start`
  welcome screen rather than the admin panel.
- **Severity:** UX / navigation. No data risk.
- **Confidence:** VERIFIED_BY_UI.

## BC-SB-002 — Typo in the first-connection cron prompt
- **Where:** `🕚 کرون اولین اتصال → ⚙️ تنظیمات`
- **Defect:** the prompt reads `در این بخش باید **تغیین** کنید ...`; the correct
  Persian is `تعیین`.
- **Severity:** cosmetic.
- **Confidence:** VERIFIED_BY_UI.

## BC-SB-003 — Most settings screens never show the current value
- **Where:** 7 of the 12 nested settings screens.
- **Defect:** the bot asks for a new value without printing the existing one. Only
  `🕚 کرون زمان` (3روز), `🕚 کرون اولین اتصال` (4روز), `❌ کرون حذف` (3روز),
  `❌ کرون حذف حجم` (2روز), `👤 پشتیبانی در پیوی` (`[TELEGRAM_ACCOUNT_REDACTED]`) and
  `💰 حداقل مبلغ خرید برای پورسانت` (`0 تومان`) echo it.
  The referral percentage, start-gift amount, volume threshold, lottery prizes and
  luck-wheel prize do not.
- **Effect:** **an admin cannot read the current configuration without overwriting
  it.** To find out what the referral percentage is, you must type a new one.
- **Severity:** significant — it converts a read into a write.
- **Confidence:** VERIFIED_BY_UI.

## BC-SB-004 — `⭕️ ورودی نا معتبر` fired by callback presses, not by input
- **Where:** across the cron settings screens.
- **Defect:** while a settings screen is waiting for a value, pressing an **inline**
  button (a callback, not a text message) frequently produces `⭕️ ورودی نا معتبر`
  — "invalid input" — even though nothing was typed. The bot's pending-value handler
  appears to intercept callback updates it should ignore.
- **Effect:** confusing, and in several observed cases the intended settings screen
  did not open at all until the FSM was cleared with `▶️ بازگشت به منوی قبل`.
  It is also the reason a value screen can look "dead" on first press.
- **Severity:** moderate — misleading error, lost input, forces re-navigation.
- **Confidence:** VERIFIED_BY_UI (reproduced many times; every affected screen was
  then re-opened cleanly after a `بازگشت` and behaved correctly).

## BC-SB-005 — Destructive actions sit in undifferentiated keyboards
- **Where:** `❌ حذف برنامه` (delete a download app);
  `🔄 ریست محدودیت کل کاربران` (reset location-change counters for **all** users).
- **Defect:** both are rendered identically to the harmless value-setter buttons
  beside them, and the UI implies no confirmation step.
- **Severity:** high risk of accidental mass mutation.
- **Confidence:** VERIFIED_BY_UI (layout). The confirmation behaviour is UNKNOWN
  because neither button was pressed.

## BC-SB-006 — The whole-bot kill switch looks like a dice toggle
- **Where:** `📡 وضعیت ربات`, first row of page 1/3.
- **Defect:** the switch that turns the entire bot off is the same size, colour and
  shape as `🎰 نمایش تاس`, with no confirmation and no warning, in a list whose other
  entries are cosmetic.
- **Severity:** the highest-consequence single tap in the product.
- **Confidence:** VERIFIED_BY_OWNER (meaning) + VERIFIED_BY_UI (layout).
