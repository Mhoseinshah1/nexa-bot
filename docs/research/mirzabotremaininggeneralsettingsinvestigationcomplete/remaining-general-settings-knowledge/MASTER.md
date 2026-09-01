# MASTER — Remaining General Settings (7 sections) — AUTHORITATIVE

## PHASE_STATUS
**COMPLETE.** All seven sections opened and documented. Both authorised bulk actions executed exactly
once each. No configuration value was changed.

## SAFETY RESULT
```
NO QR BACKGROUND REPLACED            ✅
NO BOT COMMAND CHANGED               ✅ (nothing there is editable)
NO START GIFT VALUE CHANGED          ✅ verified: still 25000
NO RESELLER MEMBERSHIP AMOUNT CHANGED ✅
NO MONTHLY FLOOR CHANGED             ✅ verified: 1000000 / 0 / 3, capability ✅ فعال
Global reseller-bot update  : executed ONCE → «❌ رباتی وجود ندارد»
Reseller-bot webhook reset  : executed ONCE → «❌ رباتی وجود ندارد»
```
One incident: **INCIDENT-GS-001** — `⛏️تنظیم کامند ربات` executes on press, so opening it to read it
triggered a (benign, idempotent) re-registration of the bot's Telegram commands.

## HEADLINE FINDINGS

1. **Three of the seven are not settings — they are buttons that fire on press.**
   `⛏️تنظیم کامند ربات`, `🔄 آپدیت همگانی ربات های نماینده`, `🔗 وبهوک مجدد ربات های نماینده` execute
   immediately: no screen, no confirmation, no preview, no target count. They look identical to the
   value prompts beside them.

2. **Bot commands are not configurable.** That section only re-publishes the product's built-in
   command list to Telegram and tells the admin to reopen the chat. No list, no labels, no mapping.

3. **The global start gift is 25,000 Toman and `0` disables it** — one of only two settings in the
   whole project that documents its zero semantics. It is a **wallet credit**: Robot Statistics tracks
   `هدیه شروع` as a wallet funding source alongside real payment gateways.

4. **The three "start gift" controls are genuinely different things.** Global signup credit (here),
   per-referral payment to the referrer (`🌟 مبلغ هدیه استارت`), and an untested referral toggle
   (`🎁 هدیه استارت`). A referred signup may cost the shop twice.

5. **`📊 کف خرید ماهانه نمایندگی` is the best-designed screen in MirzaBot** — it shows the feature
   state, all three current values, and explains the consequence. It is **enabled**: a
   `نماینده عادی` who does not pay **1,000,000 تومان** in a month **loses reseller status**, and their
   sales bot is **stopped but not deleted**, with a warning **3 days** before month end.
   `نماینده پیشرفته` has a floor of **0** — no requirement at all.

6. **`💰 مبلغ عضویت نمایندگی` prices the reseller *application*** (`قیمت درخواست عضویت`), pairing with
   the customer-side `👨‍💻 درخواست نمایندگی` button. **The amount itself is never shown.**

7. **This deployment has ZERO reseller bots.** Both bulk actions answered `❌ رباتی وجود ندارد`,
   independently corroborating the Web-Admin phase's empty reseller-bot list. The whole reseller-bot
   subsystem is provisioned but unused — so its runtime behaviour could not be observed, and none is
   claimed.

8. **One genuinely good pattern exists in the product**: the monthly-floor sub-settings carry a real
   inline **`🔙 انصراف`** cancel button — the only one found anywhere in this project.

## UNKNOWN
12 items in `unknowns.md`. P1: what `🎁 هدیه استارت` in the referral submenu does (UNK-RGS-005), the
reseller membership amount (UNK-RGS-006), and what counts toward the monthly floor (UNK-RGS-007).

## NOT_EXPOSED
The current QR background and any way to view or remove it · the registered command list · the
reseller membership amount · target counts, versions, warnings or confirmations for either bulk
action · any progress or per-bot reporting.

## AUTHORITATIVE_FILES
`menu-tree.md` · `qr-background.md` · `bot-command-settings.md` · `start-gift.md` ·
`reseller-membership-amount.md` · `reseller-monthly-purchase-floor.md` ·
`reseller-bots-global-update.md` · `reseller-bots-webhook-reset.md` · `reseller-crossmap.md` ·
`business-rules.md` (RGS-BR-001..010) · `unknowns.md` · `incidents.md` · `evidence-index.md` ·
`progress.md`
