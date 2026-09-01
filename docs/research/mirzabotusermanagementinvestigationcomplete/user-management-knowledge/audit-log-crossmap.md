# Admin-Log Crossmap — User Management

STATUS: baseline recorded from the prior Web Admin phase. Telegram-side verification pending.

## Log verbs already known to exist for user actions

Read read-only from the production `/admin/logs` history in the Web Admin phase — that is, the effect
of these buttons was learned **without ever pressing them**:

| Log wording (verbatim) | Implied action |
|---|---|
| «ارسال پیام به کاربر با متن : {text}» | admin sent a message to a user |
| «افزایش موجودی به مبلغ {amount}\| موجودی قبلی : {previous_balance}» | wallet credit — **records the previous balance** |
| «کسر موجودی به مبلغ {amount}» | wallet debit |
| «صفر کردن موجودی کاربر» | wallet zeroed |
| «افزودن سفارش برای کاربر با نام کاربری {username}» | manual order added |
| «کاربر مسدود گردید» | user blocked |
| «کاربر از مسدودیت خارج گردید» | user unblocked |
| «فعال سازی کانفیگ های کاربر» | all of a user's configs activated |
| «غیرفعال سازی کانفیگ های کاربر» | all of a user's configs deactivated |
| «تغییر وضعیت کانفیگ با شناسه {id}» | one config's status toggled |
| «معاف کردن از کانال» | exempted from channel membership |

Log row fields: id · admin username · action description · target customer numeric id (0 = not
applicable) · timestamp · IP.

## What this phase must determine

1. Do **Telegram**-initiated User Management actions produce log rows at all, or is the log web-only?
2. Is the wording identical, so that the two surfaces write to one shared log?
3. Does the log record before/after values for every financial mutation, or only for
   `افزایش موجودی` (which is the only verb observed to carry `موجودی قبلی`)?
4. Are the two mass tools (`👥 شارژ همگانی`, `🔋 حجم یا زمان همگانی`) logged as one row or as N rows?
   **This can only be answered by reading the log after someone else uses them — it will not be tested.**

## Method

After each authorised state change on the test user, the log is to be checked and the row quoted, with
the target id reduced to the test user only. No unrelated customer's log rows are reproduced.
