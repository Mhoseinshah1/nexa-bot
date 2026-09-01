# Unknown register

### UNK-RGS-001 — Which QR codes does the background apply to?
- **Evidence:** the setting is global and asks for an image; nothing states its target.
- **Missing:** whether it applies to subscription-link QRs only, to all protocols, to WireGuard, or
  to every QR the bot emits.
- **Safe verification:** buy or view a service as a customer and look at the delivered QR; or read
  the source.
- **Priority:** P2 · **Status:** OPEN.

### UNK-RGS-002 — What is the current QR background, and can it be removed?
- **Evidence:** none — the section shows no image and offers no remove/reset control.
- **Safe verification:** source, or the Web panel if it exposes the same asset.
- **Priority:** P2 · **Status:** NOT_EXPOSED (there is no way to view or clear it from Telegram).

### UNK-RGS-003 — Which commands does `⛏️تنظیم کامند ربات` register?
- **Evidence:** the action reports success and tells the admin to reopen the chat.
- **Missing:** the command list itself, and whether it differs for admins, customers or reseller bots.
- **Safe verification:** open the bot's `/` menu in Telegram after reopening the chat — read-only.
- **Priority:** P2 · **Status:** OPEN, cheaply closable.

### UNK-RGS-004 — Is the start gift once per account, or repeatable?
- **Evidence:** the prompt says only "start gift", with `0 = disabled`.
- **Missing:** the grant condition (first `/start` only? every `/start`? per bot?).
- **Safe verification:** source; or watch a new user's wallet. Robot Statistics tracks `هدیه شروع` as
  a funding source, so its total is measurable over time.
- **Priority:** P2 · **Status:** OPEN.

### UNK-RGS-005 — What is `🎁 هدیه استارت` inside the referral submenu?
- **Evidence:** it sits among the referral settings; the label collides with the global gift; it was
  never pressed because it may be a toggle.
- **Missing:** whether it enables/disables the referral variant of the gift.
- **Safe verification:** clone bot, or source.
- **Priority:** **P1** — three similarly-named controls is a real modelling hazard.
- **Status:** OPEN.

### UNK-RGS-006 — The reseller membership amount itself
- **Evidence:** the prompt exists; **no current value is shown**.
- **Missing:** the price, the tier transition it buys, whether it recurs, whether admin approval still
  applies, and `0`/free semantics.
- **Safe verification:** the Web panel, or the customer-side `👨‍💻 درخواست نمایندگی` flow (which would
  display the price to the applicant) — read-only.
- **Priority:** **P1** · **Status:** OPEN.

### UNK-RGS-007 — What counts toward the monthly purchase floor?
- **Evidence:** the bot says `حداقل مبلغ پرداختی` — "minimum amount paid".
- **Missing:** whether that means wallet top-ups, product purchases, renewals, or total reseller sales.
- **Safe verification:** source; or compare a reseller's monthly statistics against their status.
- **Priority:** **P1** — it decides who gets demoted.
- **Status:** OPEN.

### UNK-RGS-008 — Which calendar defines "the month"?
- **Evidence:** `در هر ماه` and "days before month end"; the bot's dates are Persian throughout.
- **Missing:** Persian month vs Gregorian vs rolling 30 days.
- **Priority:** P2 · **Status:** OPEN.

### UNK-RGS-009 — What does the global reseller-bot update actually do?
- **Evidence:** none — zero targets, so nothing ran.
- **Missing:** whether "update" means code, commands, configuration, webhook or menu; scope; per-bot
  progress; failure semantics.
- **Safe verification:** run it again once at least one reseller bot exists; or read the source.
- **Priority:** P2 · **Status:** OPEN — **not testable in this deployment.**

### UNK-RGS-010 — What does the webhook reset actually do?
- **Missing:** delete-then-set vs set-only, `drop_pending_updates`, certificates, per-bot vs batched,
  error handling.
- **Status:** OPEN — **not testable in this deployment** (zero targets).

### UNK-RGS-011 — Does the global update also reset webhooks?
- **Evidence:** they are two separate buttons that each evaluate the target set independently.
- **Missing:** any internal dependency.
- **Priority:** P2 · **Status:** UNKNOWN.

### UNK-RGS-012 — Do either of the bulk actions write to the Admin Log or the report group?
- **Evidence:** neither produced a report-group message or any log reference in the chat. The Web
  admin-log vocabulary contains no reseller-bot maintenance verbs.
- **Missing:** a look at `/admin/logs` for entries at **04:51** and **04:52** on 1 Sep 2026.
- **Safe verification:** one read-only page load in the Web panel.
- **Priority:** P2 · **Status:** OPEN, cheaply closable.
