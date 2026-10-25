# 10 — Communications

**Nexa sends customers nothing automatically.** Not from the import, not from the
handover, not from the incident, not from the customer link beyond the ordinary reminders
that B7 turns on (which are capped and watched, see
[`07-background-roles.md`](07-background-roles.md)). Everything below is the owner's own,
manual act, through the owner's own channel. Conventions: [`00-overview.md`](00-overview.md).

## What the owner says, when

| When     | Channel (owner's choice)                    | Content                                                                         | By whom |
| -------- | ------------------------------------------- | ------------------------------------------------------------------------------- | ------- |
| T−24 h   | Mirza broadcast, manual (before the freeze) | The bot will be unavailable for a window starting at T0, with the window length | owner   |
| T−1 h    | Mirza broadcast, manual                     | Reminder of the window                                                          | owner   |
| T0 … H3  | none                                        | Mirza answers nothing; Nexa answers nothing                                     | —       |
| After H5 | channel post or bot pin, manual (H7)        | Nexa is live (optional until sales open)                                        | owner   |
| After B9 | channel post, manual                        | Sales and top-ups are open                                                      | owner   |

The announcement text is prepared before GO-1 ([`09-go-no-go.md`](09-go-no-go.md)). The
wording is the owner's; this runbook does not supply customer text.

## What customers experience

- **During the window** a message or button tap gets no answer. After the handover the
  updates queued during the freeze are discarded (OQ-CUT-01,
  [`06-token-handover.md`](06-token-handover.md)); nothing is replayed and no money moves.
- **An old Mirza button** answers «این دکمه قدیمی است…» with the main-menu button.
- **A customer with a negative balance** cannot buy until a top-up brings the wallet to
  zero. Nexa tells nobody automatically; the owner decides whether to say anything.
- **Reminders** flow from B7 on, at an ordinary rate.

## What Nexa must not send

- no message from the import or any backfill;
- no incident notification: the MAINTENANCE incident's customer message stays **empty** and
  «اطلاع‌رسانی» (`incidents.notify`) is never pressed, on start or on resolve;
- no broadcast from Nexa.

## Record

The announcement text, the channel and the time it went out, in
[`11-records.md`](11-records.md).

## راهنمای فارسی

**Nexa هیچ پیامی به‌صورت خودکار به مشتری نمی‌فرستد** — نه از انتقال، نه از واگذاری توکن، نه از
رخداد. هر اطلاعیه کار دستی خود مالک و از کانال خود اوست.

- ۲۴ ساعت و ۱ ساعت پیش از شروع: اطلاعیهٔ دستی مالک (پیام همگانی میرزا) دربارهٔ بازهٔ قطع.
- در بازه: میرزا و Nexa پاسخی نمی‌دهند. پس از واگذاری، پیام‌های صف‌شده دور ریخته می‌شوند
  (OQ-CUT-01) و هیچ پولی جابه‌جا نمی‌شود. دکمهٔ قدیمی میرزا با «این دکمه قدیمی است…» پاسخ
  می‌گیرد.
- پس از H5 و پس از B9: اعلام دستی مالک (اختیاری / باز شدن فروش).
- ممنوع: پیام از انتقال، اطلاع‌رسانی رخداد («اطلاع‌رسانی»؛ پیام مشتری رخداد **خالی** می‌ماند)، پیام
  همگانی از Nexa. متن اطلاعیه را مالک می‌نویسد.
