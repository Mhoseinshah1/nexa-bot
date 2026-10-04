# TB2 — Business conversations, human takeover, and the outbound lane

**Status: implemented.** Program: Intelligent Support Agent. Decided by ADR-0033 §4–§8.
Builds on TB1 (`tb1-business-transport.md`). No AI code is in this package.

## What TB2 delivers

| Concern       | Implementation                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conversation  | `business_conversations` (migration `0197`), keyed `(bot, owner, chat)`. It is not keyed by the connection row, so a reconnect with a new connection id continues the same conversation, and `connection_row_id` follows the latest connection.                                                                                                                                                                      |
| States        | `AI_ACTIVE`, `HUMAN_ACTIVE`, `HANDOFF_REQUIRED` (with a typed reason, CHECK-pinned) and `PAUSED`. `DISABLED` is projected from the mode and the connection, never stored. Every transition is a conditional UPDATE naming its `from` states. There is no `setState`.                                                                                                                                                 |
| Control epoch | `control_epoch` moves only on a transition **into** `HUMAN_ACTIVE` (the owner typing, another bot, operator takeover, operator or assist send), on a resume to `AI_ACTIVE`, and on a handoff. In the same transaction, every `PENDING`, unstamped lane row created under an older epoch is superseded.                                                                                                               |
| Final check   | The lane locks the conversation, reads `ScopeActivityReader`, and applies `businessOutboundSendable` (equal epoch, plus `AI_ACTIVE` for an `AUTO` row) in the transaction that stamps `send_started_at`. A row that fails is `SUPERSEDED` and nothing is sent.                                                                                                                                                       |
| Outbound lane | `business_outbound_messages`, using ADR-0030's discipline: lease and claim, stamp before the call, record after. `DELIVERED` keeps Telegram's message id. `RATE_LIMITED` is requeued without spending an attempt. `REFUSED` becomes `FAILED`. `UNKNOWN` becomes `UNCONFIRMED` and is **never resent**, and so does a stranded stamp. An `AUTO` row that failed or is unconfirmed hands the conversation to a person. |
| Echo proof    | A message is ours if it carries `sender_business_bot` equal to this bot, **or** if this bot's send record holds its message id in this chat (`isOwnMessage`). Anything else outgoing is human.                                                                                                                                                                                                                       |
| Identity      | The peer is the private chat's id. The customer is linked only by exact `(tenant, telegram_user_id)`, never by username, and a business message never creates a customer.                                                                                                                                                                                                                                            |
| Transcript    | `business_messages` holds bounded text and kind. An edit bumps `content_version`, and an out-of-order or redelivered edit never rewinds a newer one. A deletion purges the text and changes no state. Text and lane bodies are purged 30 days after sending (`BUSINESS_MESSAGE_TEXT_RETENTION_DAYS`).                                                                                                                |
| Permissions   | `business_chats.view` (LOW) and `business_chats.reply` (MEDIUM; requires view), granted to existing system roles by the hand-written `0198`. They are enforced by the service inside its transactions, never by the surface.                                                                                                                                                                                         |
| Web Admin     | The inbox (state filter, cursor paging, connection status), conversation detail (transcript by origin, lane rows by state), the operator's reply, take over, and «سپردن دوباره به هوش مصنوعی».                                                                                                                                                                                                                       |
| Process       | `BusinessOutboundLoop` runs in the worker every 3 s with loop health (`business-outbound`), and `stop()` waits for the pass in flight.                                                                                                                                                                                                                                                                               |

## Decisions made in this package

1. **The epoch moves on a transition into human control, not on every human message.**
   While the conversation is already `HUMAN_ACTIVE`, nothing the AI queued can send (an
   `AUTO` row also needs `AI_ACTIVE`). Moving the epoch there would supersede the operator's
   own queued replies, and a second message of theirs would cancel the first. The rule that
   protects the customer is unchanged: no AI row survives a human taking the conversation.
2. **An operator's failed or unconfirmed send changes nothing about control.** The person
   is already holding the conversation and sees the row's state. Only an `AUTO` row hands
   off.
3. **A send through a connection that cannot send is refused up front** (409), not queued
   to fail. The operator is looking at the screen.
4. **A deletion for a chat NEXA never recorded creates nothing.**
5. **The settle delay (6 s, 3–30 s) is TB7's.** TB2 produces no `AUTO` rows. The race
   tests insert them directly, as TB7 will.

## The six mandated race tests (continuation program §32)

| #   | Race                                     | Test (`tests/integration/business-conversations.test.ts`)                                               |
| --- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 1   | A human before the AI job                | `R1: a human message before the AI reply is queued leaves the AI nothing it can send`                   |
| 2   | A human while provider work is pending   | `R2: a human message while the AI reply is being produced supersedes it before any send`                |
| 3   | A human after the draft, before the send | `R3: a draft that already passed every earlier check still loses to a human at the final check`         |
| 4   | A duplicate outgoing owner update        | `R4: a redelivered owner message moves the epoch once`                                                  |
| 5   | Resume invalidates the older epoch       | `R5: resuming the AI advances the epoch, so nothing queued while a human held it sends`                 |
| 6   | A stale outbound row cannot send         | `R6: a row whose epoch is not the conversation’s is superseded at the final check, whatever its origin` |

The same suite also covers:

- the five origins;
- exact-id customer linking, and that a business message never creates a customer;
- operator replay and key mismatch;
- `UNKNOWN`, 429 and stranded-stamp handling;
- edits and deletions;
- the up-front refusal;
- permissions and tenant isolation.

Mutation results are in `tb2-falsification.md`.

## Manual real-Telegram acceptance (TB2 portion)

Pending staging. Record the results in `telegram-business-observations.md`.

1. A customer messages. A conversation appears in «گفتگوهای تلگرام بیزینس» as AI_ACTIVE,
   linked to the right customer.
2. The owner replies by hand in the Telegram app. The conversation becomes HUMAN_ACTIVE,
   and the takeover is in the audit log.
3. An operator replies from the Web Admin. The customer sees it from the business account.
   Its echo is recorded as «ارسال از NEXA», not as a human takeover.
4. «سپردن دوباره به هوش مصنوعی» returns the conversation to AI_ACTIVE.
5. Edit and delete a customer message. The transcript shows the edit, and the deleted
   message's text is gone.
6. Revoke the right to reply. The operator's send is refused with a clear error.
