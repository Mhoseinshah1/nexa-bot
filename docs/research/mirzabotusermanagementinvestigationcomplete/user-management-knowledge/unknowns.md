# Unknowns — User Management phase

Every item classified: **OPEN** · **PARTIALLY_RESOLVED** · **RESOLVED** · **SUPERSEDED** · **OUT_OF_SCOPE**.
This file starts as the phase's question list, carried in from earlier phases, and is updated as answers land.

## Questions this phase was created to close

| ID | Question | Origin | Status |
|---|---|---|---|
| UNK-UM-001 | What does `تنظیم نماینده` actually do — a modal, a confirmation, an immediate toggle? Is there a demotion path? | Web Admin phase, UNK-001 follow-up | OPEN |
| UNK-UM-002 | Does the Telegram side expose the **per-user discount** that lives in the web panel's separate `/users/discount_users/` table? | Web Admin §4.6.5 | OPEN |
| UNK-UM-003 | Does the per-user discount stack with the reseller discount and with discount codes? | prior UNK-003 (pricing precedence) | OPEN |
| UNK-UM-004 | Is `سقف منفی شدن حساب` (negative-balance ceiling) gated to `n2` on the Telegram side as it is on the web? | Web Admin BR-007 | OPEN |
| UNK-UM-005 | Can a wallet balance actually go below zero, or does the ceiling only gate purchase eligibility? | Web Admin BR-007 | OPEN — the menu's `لیست کاربرانی که موجودی منفی دارند` strongly suggests balances really do go negative |
| UNK-UM-006 | Is referral binding truly immutable, and can an admin override it? | BR-009, proven only as bot copy | OPEN |
| UNK-UM-007 | Does `نوع تراکنش` have values beyond `افزایش موجودی`? | payments.md | OPEN |
| UNK-UM-008 | Do Telegram-initiated user actions write to the same admin log as web actions, with the same wording? | audit-log-crossmap.md | OPEN |
| UNK-UM-009 | Is the config activate/deactivate pair reachable from Telegram, and does it change MirzaBot status only, the external panel user, or both? | Web Admin BR-015 | OPEN |
| UNK-UM-010 | What are the three service-deletion variants, and which one refunds? | Web Admin BR-015 | OPEN |
| UNK-UM-011 | The location-change contradiction: priced 30,000 T location-change events exist in the statistics but no customer UI was ever found. Does a per-user `محدودیت تغییر لوکیشن` control explain it? | UNK-R004 | OPEN |
| UNK-UM-012 | What is the reseller-application (`👨‍💻 درخواست نمایندگی`) approval workflow, seen once as a live notification with Approve/Reject? | robot-statistics §0 | OPEN |
| UNK-UM-013 | Admin role enforcement for User Management | prior UNK-005 | **OUT_OF_SCOPE** — only one admin account exists; testing needs a second admin, which is a production change |
| UNK-UM-014 | What do the two mass tools (`👥 شارژ همگانی`, `🔋 حجم یا زمان همگانی`) do exactly? | this phase | **OPEN, and will stay open** — submitting either mutates every user or every service |
| UNK-UM-015 | Does the Telegram user record expose fields the web panel does not, or vice versa? | web-admin-crossmap.md | OPEN |
| UNK-UM-016 | Does changing a user's tier change what they see in the Store, and does it preserve wallet, services and orders? | Store phase, store-user-group-pricing.md | OPEN |

## New unknowns raised by the menu itself

| ID | Question | Status |
|---|---|---|
| UNK-UM-017 | `🛍 جستجو سفارش` — does order search allow mutation of the found order? | OPEN |
| UNK-UM-018 | `📨 بخش ارسال پیام` — is it per-user or broadcast, and is there a confirmation before sending? | OPEN |
| UNK-UM-019 | Is the negative-balance list populated, i.e. do real users currently sit below zero? | OPEN |
