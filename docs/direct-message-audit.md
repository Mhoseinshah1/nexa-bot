# Phase A2 — direct message from Customer 360

«ارسال پیام»: one operator-written message (text, or a photo or document with an optional
caption) to ONE customer, from the customer's page. Program §7.

## 1. Audit: what already delivered something to a customer

| Path                                                                                            | What it is                                                                                                                                                                                                                        | Used here?                                                                                                                             |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Broadcast lane (`modules/commerce/broadcasts`)                                                  | Mass lane: frozen audience, per-bot pacing, its own recipient table and dispatcher, `broadcasts.send`.                                                                                                                            | No. A single-recipient broadcast would appear in the broadcast list, share the mass permission and its pacing. §7 requires separation. |
| Customer notification lane (ADR-0030, `messaging/application/customer-notification.service.ts`) | Closed kinds, one frozen template per kind, values read at send time from the row the subject id names; stamp-before-send, reaper to `UNCONFIRMED`, 429 back on the queue with no attempt spent, refusals retried to the ceiling. | **Yes.**                                                                                                                               |
| Ticket reply (`TICKET_REPLY`, `TICKET_REPLY_ATTACHMENT`)                                        | Operator-written text and file on that lane: the MESSAGE ROW is the subject and the dispatcher reads the words from it.                                                                                                           | The precedent followed exactly.                                                                                                        |
| Phase 2 operator notifications                                                                  | Operator channels, not customers.                                                                                                                                                                                                 | No.                                                                                                                                    |

So a direct message is a row (`customer_direct_messages`) plus a lane row of kind
`DIRECT_MESSAGE` (text) or `DIRECT_MESSAGE_MEDIA` (file + caption). The lane still carries a
kind and an id and nothing else (ADR-0030 §1): the only writer of the row is
`CustomerDirectMessageService.send`, guarded, rate limited and audited. No second transport,
no second outcome taxonomy.

## 2. Rules

- **Permission**: `users.message.send` (send) and `users.message.view` (history), both
  requiring `users.view`; independent of `broadcasts.send` and `tickets.reply`. Seeded to
  owner, operator and support; backfilled by `0166_direct_message_grants.sql`.
- **Write path** (one transaction): guard → scope activity → the tenant's direct-message
  advisory lock (`0x444d`, taken first, nothing else takes it) → idempotency replay →
  target revalidation → rate limit → file staging bound → row + lane row + outbox
  `CustomerDirectMessageQueued` + audit `customer.direct_message`.
- **Target, at send time**: the customer is this tenant's (else `NOT_FOUND`), `ACTIVE`
  (else `TARGET_UNAVAILABLE/BLOCKED`), and its own bot (`first_bot_instance_id`) is `ACTIVE`
  (else `TARGET_UNAVAILABLE/NO_BOT`). Read `FOR SHARE`, so a concurrent block is seen or waits.
  A block committed after queueing pauses the lane row (the lane's existing rule).
- **Idempotency**: the key is namespaced `surface:admin:key` and stored on the row with the
  request hash (text + file digest). Same key and content → the first message, `replayed`;
  different content → `platform.idempotency_payload_mismatch`. The web client keeps the key
  across an ambiguous failure (`useSubmissionKey.settleOn`).
- **Rate limit**: counted from the rows inside the transaction under the lock — at most
  `DIRECT_MESSAGE_MAX_PER_ADMIN` (30) per operator and `DIRECT_MESSAGE_MAX_PER_CUSTOMER` (5)
  per customer in a sliding 10-minute window; `RATE_LIMITED` with `details.scope`.
- **Staleness**: both kinds declare a precondition; the subject reader holds a message only
  while it is younger than `DIRECT_MESSAGE_STALE_AFTER_MS` (24 h). Older → `SUPERSEDED`,
  shown as `EXPIRED`, never sent. Quiet hours never hold them.
- **Delivery states** shown to the operator are a projection of the lane row
  (`directMessageDeliveryState`): `QUEUED`, `SENDING`, `SENT` (accepted by Telegram),
  `FAILED`, `UNKNOWN` (never re-sent), `EXPIRED`. Nothing says delivered or read.
- **Privacy**: the audit row holds the operator (actor), the customer (entity), the kind,
  the text LENGTH and the file's type/size/sha256 — never the text or the bytes. The outbox
  event holds ids and the kind. No chat id, bot id or Telegram file handle leaves the API.
- **Files**: the ticket-reply allow-list and its one rule (`ticketReplyFileRefusal`): JPEG/PNG
  as a photo, PDF/TXT as a document, signature-checked. Bytes are staging: cleared with the
  handle stamped by the delivery, or by the worker's `direct-message-files` sweep after
  `DIRECT_MESSAGE_FILE_RETENTION_DAYS`; at most `DIRECT_MESSAGE_FILE_STAGED_MAX_BYTES` per tenant.

## 3. Tests and mutation evidence

`tests/integration/customer-direct-messages.test.ts` (18 cases, real PostgreSQL and the real
lane against a Telegram stand-in), `tests/unit/direct-messages.test.ts`,
`tests/web/customer-direct-messages.test.tsx`. Each mutation below was applied alone and
turned at least one named case red:

| Mutation                                    | Failing case                                       |
| ------------------------------------------- | -------------------------------------------------- |
| drop the tenant lock                        | rate limit under concurrency; concurrent duplicate |
| drop the BLOCKED check                      | refuses a blocked customer…                        |
| drop the bot-ACTIVE predicate               | refuses … a customer whose only bot is not active  |
| drop the staleness predicate                | … once stale it EXPIRES unsent                     |
| replay reports `replayed: false`            | double click … ONE message                         |
| per-customer bound `+1`                     | rate limit under concurrency                       |
| per-operator window from `now`              | limits one operator … across customers             |
| drop the file handle stamp                  | sends a photo … clears the bytes                   |
| web: preview enabled for a blocked customer | cannot write to a blocked customer                 |
| web: preview button sends directly          | three compose cases                                |

## 4. Manual acceptance (real Telegram)

- Text, photo and PDF reach a real customer chat through the customer's own bot, with the
  `bot.direct_message.*` heading; the photo shows its caption.
- A customer who blocked the bot: the row ends `FAILED` after the lane's attempts.
- The history moves from «در صف ارسال» to «پذیرفته‌شده توسط تلگرام» within a lane interval (60 s).
