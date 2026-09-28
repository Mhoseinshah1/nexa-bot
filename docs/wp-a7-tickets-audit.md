# WP-A7 — the support ticket system

A customer's support conversation, shared by the Telegram bot and the Web Admin. This
records what was built, the rules it rests on, and where it deliberately stops.

## 1. The model

| Table                   | What it holds                                                                                                                                                                                                                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ticket_categories`     | The subjects a customer files under. Never deleted — hidden (`is_active`). Unique title per tenant.                                                                                                                                                                                                                             |
| `ticket_category_seeds` | That the five defaults (مشکل اتصال، خرید و پرداخت، سرویس، حساب کاربری، سایر) were copied in once, from `bot.ticket.category_default_*`. The FAQ seed's pattern: a tenant that hides all five is not re-seeded.                                                                                                                  |
| `tickets`               | Tenant, customer, the bot it was opened through, category id AND a snapshot of its title, subject (the first line of the first message), status, priority, optional assignee, optional service / order / payment, created / updated / last-message / closed timestamps, and an identity `number` customers and operators quote. |
| `ticket_messages`       | Append-only (`nexa_reject_mutation`). Sender (`CUSTOMER`, `ADMIN`, `SYSTEM`), text, an attachment binding, a system fact, the command's idempotency key and request hash.                                                                                                                                                       |

Statuses (`TICKET_STATUSES`, CHECK-pinned): `OPEN`, `WAITING_FOR_CUSTOMER`,
`WAITING_FOR_SUPPORT`, `CLOSED`. `TICKET_MACHINE` is registered in `STATE_MACHINES`:

- a support reply moves `OPEN`/`WAITING_FOR_SUPPORT` → `WAITING_FOR_CUSTOMER`;
- a customer reply moves `WAITING_FOR_CUSTOMER` → `WAITING_FOR_SUPPORT` (a reply before
  support answered leaves it `OPEN`);
- an operator may mark either waiting status, close any active ticket, and reopen a closed
  one — a reopen waits for support. Nothing returns a ticket to `OPEN`;
- a message to a `CLOSED` ticket is refused (`ticket.closed`) from either side.

Every status write is `moveStatus`, a conditional UPDATE naming the status it leaves, taken
under the ticket's row lock. A close and a reopen also write a `SYSTEM` message
(`CLOSED_BY_CUSTOMER`, `CLOSED_BY_SUPPORT`, `REOPENED_BY_SUPPORT`) so the conversation keeps
the fact. `closed_at` is set exactly while `CLOSED` (an equality CHECK).

The message cap never blocks a status change: a ticket holding its 500th message can still be
closed and reopened. At the cap the move writes no `SYSTEM` row — the cap bounds the
conversation's rows, and a fact row past it would break that bound — while the status, the
`TicketStatusChanged` event and the audit row still record the change; that audit row carries
`factRecorded: false` so the missing fact is visible where the change is.

## 2. The customer's reply notification, and why it is not a payload

ADR-0030 §1 refuses a producer-supplied payload: the customer lane must never become "send
this customer some text". A ticket reply's text is variable, so:

- the **message row is the source of truth**. Support's reply is written as a
  `ticket_messages` row, and in the SAME transaction a `TICKET_REPLY` row is enqueued on
  `customer_notifications` through `CustomerNotifier`, naming **the message id** and nothing
  else;
- the dispatcher, at send time, reads the ticket number, the category and the text from that
  message row (`TicketService.notificationFacts`) — the shape `SERVICE_REFUND_REQUEST_REJECTED`
  already uses to read an administrator's reason from its request row. The customer is sent
  exactly what is stored in their ticket, and no caller can put anything else in front of them;
- it is sent through **the bot the ticket was opened on** (`CustomerNotifier.notifyThrough`
  with `tickets.bot_instance_id`), not the customer's first bot: the ticket is a conversation
  with that bot, and a reply arriving from another of the tenant's bots would come from an
  account the customer did not write to;
- its two buttons (reply, view) are derived from the subject by kind (`notificationButtons`),
  never stored;
- its precondition is `false`: a reply that was written stays written.

A delivery failure therefore never loses the message. A definite refusal spends one attempt
and stays `PENDING` with the lane's back-off; a 429 spends none; an unknown (5xx, timeout)
outcome is `UNCONFIRMED` and is never re-sent, the lane's rule against duplicates. In every
case the reply is in the ticket: the customer reads it in the bot's conversation view, and the
Web Admin shows each reply's delivery state, projected from the lane's own row rather than
copied onto the message. The reply's own response reads the message back through that same
join, so a replayed reply answers with where its notification actually is.

## 3. Telling support

`TicketSupportNotifyConsumer` is an outbox consumer of `TicketOpened` and of a customer's
`TicketMessagePosted`. It writes intents into the EXISTING operator notification lane
(`NotificationService.queue`) and touches none of its delivery internals:

- the operations destination, when it is configured and `ops_notifications` is on;
- each Telegram-bound administrator who holds `tickets.reply` — the ticket's assignee alone
  when the assignee can be reached, everyone who may reply otherwise — addressed to the
  person, the Phase 5T shape, so a default installation with no log group still tells
  somebody.

The kind is `OPERATIONAL_EVENT` and the template is `ops.support.ticket_opened` /
`ops.support.customer_replied`, the financial log's reasoning: a new `NOTIFICATION_KINDS`
member would be one the previous release's Web Admin refuses after a rollback. The text
names the ticket number, the category and the customer; never the customer's words.

WP-A4 is redesigning the log group's delivery and topics in parallel. When it lands, routing
`ops.support.*` to a support topic is a routing decision in that work, not a change here.

## 4. Attachments

The receipts' pattern (Phase 5R): the row holds the binding — which bot received the file and
Telegram's `file_id` / `file_unique_id` — and the declared type, name and size. The bytes stay
at Telegram and the Web Admin fetches them through the API (`TelegramReceiptFiles.download`,
the same bounded, redirect-refusing download), served as `application/octet-stream`,
`attachment`, `nosniff`, `no-store`. No `file_id` reaches a browser.

`ticketAttachmentRefusal` is the one rule: a photo, or a document whose declared MIME type AND
last extension agree on the allow-list (PDF, JPEG, PNG, WEBP, TXT), at most 10 MB. A document
missing its type, name or size is refused rather than trusted. An executable, a script, an
archive, HTML, SVG and a renamed `x.pdf.exe` are all refused. A refusal writes nothing and
reopens the window.

## 5. The bot

«🎫 پشتیبانی / تیکت‌ها» is a third main-menu row and `/tickets` a registered command.
`/paysupport` is unchanged — it still opens the support screen Telegram requires — and that
screen now carries a «🎫 تیکت‌های پشتیبانی» button into the desk.

List → «➕ تیکت جدید» → category → the window that reads the first message → «✅ تیکت #N ثبت
شد». The conversation view shows the latest six messages (each bounded) and says how many
older ones are kept; it offers reply and an ask-then-confirm close. The two windows reuse
`customer_text_captures` (`TICKET_NEW_MESSAGE` names the category, `TICKET_REPLY` the ticket),
read only messages newer than the tap that opened them, and are superseded by any later
prompt. A photo or document is offered to a ticket window only when that window is newer than
any open receipt window, and through `readText`'s `onlyPurposes`, so a file never closes a
note or search window as though it were its text. The choice is made INSIDE the read's
transaction: `readText`'s `yieldTo` takes the receipt window's own lock after the capture
lock and reads the receipt window there, so neither window can open between the choice and
the consumption. Nothing takes the two locks the other way round. When the receipt window
wins, the ticket window stays open and the file goes to the receipt path, as before.

A message read by a ticket window is checked against the ticket's status before its content:
a ticket support closed while the customer's reply window was open answers «closed» and
reopens no window, whatever the message was.

Every customer-facing read and write names the bot the update arrived on and matches the
ticket's own `bot_instance_id`: the list, the view, the reply prompt, the reply and the close.
A ticket opened through another of the tenant's bots answers `bot.ticket.not_found`, exactly
as a ticket that does not exist, so one bot's desk is no oracle for another's. Support in the
Web Admin sees every ticket.

A customer holds at most five open tickets in each bot and a ticket at most 500 messages — rails against a
loop, not policies.

## 6. Idempotency

A message's command key is stored on the row, unique per tenant, with the request's hash: the
Telegram update for a customer's message (a redelivery is one row and the same answer), and
`<surface>:<administrator>:<key>` for the Web Admin. The same key with different words is
`platform.idempotency_payload_mismatch`. `tickets.opening_key` makes a redelivered opening
one ticket. Status, assignee, priority and links are target-value commands under the row lock:
a repeat writes nothing and answers `changed: false`. Category creation uses the
`IdempotencyStore`.

## 7. Permissions and audit

`tickets.view` (LOW), `tickets.reply`, `tickets.assign` (assignee, priority, links),
`tickets.close` (every status change) and `tickets.categories.edit`, each action requiring the
view (`PERMISSION_REQUIRES`). Operator: all five; Support: the four ticket keys; Observer: the
view; Owner: all. Migration 0131 backfills the existing system roles.

Every administrator write goes through `runAuthorizedMutation` and is audited with its before
and after — no reason is asked for a reply or a status change. A refusal is audited `DENIED`.
The audit names facts (message id, status, attachment kind), never message text. Customer
writes run as the webhook's `SYSTEM_JOB` under `maintenance.run`, like every customer write,
with ownership as the authorization; another customer's ticket and another tenant's are both
`ticket.not_found`.

## 8. Where it stops

- An administrator's reply is text only. A file from support would need an upload path and a
  store this deployment does not have (`OQ-WPA7-01`).
- The ticket desk is behind the mandatory-channel guard like every other customer action;
  the basic support screen and `/paysupport` stay exempt as before (`OQ-WPA7-02`).
- There is no Telegram admin screen for tickets; support answers in the Web Admin. The
  personal notification tells an administrator where to go.
