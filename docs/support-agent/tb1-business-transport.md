# TB1 — Telegram Business connection and transport

**Status: implemented.** Program: Intelligent Support Agent. Decided by ADR-0033. Builds
on `docs/support-agent/tb0-audit.md`. No AI code is in this package.

## What TB1 delivers

| Concern                   | Implementation                                                                                                                                                                                                                                                                                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Routing                   | `businessUpdateOf` (`modules/commerce/business-chats/domain/telegram-business.ts`) recognises the four business update types **by key presence**. The webhook dispatches them **first**, before Stars, the operations group, `/ping` and the customer turn (`surfaces/telegram/business-updates.ts`).                                                       |
| Strict reading            | `parseBusinessConnection`, `parseBusinessMessage`, `parseBusinessDeletion`. Identity fields must be the documented types. Only documented rights that are `true` are kept. An absent `rights` object means **no** rights.                                                                                                                                   |
| Connection persistence    | `telegram_business_connections` (migration `0196`), keyed `(bot_instance_id, connection_id)`. Status is projected by `businessConnectionStatus` (`ACTIVE`, `DISABLED`, `RIGHTS_INSUFFICIENT`, `SUPERSEDED`) and never stored.                                                                                                                               |
| Supersession (`OQ-TB-02`) | A **new** connection id for the same owner on the same bot supersedes every older row of that owner. A later report about a superseded id leaves it superseded.                                                                                                                                                                                             |
| Unknown connection        | A business message for a connection NEXA never saw is resolved by `getBusinessConnection`. When Telegram cannot answer, nothing is guessed: the message is not processed, and the operator is told why.                                                                                                                                                     |
| Classification            | `classifyBusinessMessage` (contracts) returns `INBOUND`, `OWN_ECHO`, `OFFLINE`, `OTHER_BOT` or `HUMAN`, with the conservative rule: an outgoing message not positively attributable to this bot is human.                                                                                                                                                   |
| Send on behalf            | `BusinessTransport.sendText` returns `DELIVERED`, `REFUSED`, `RATE_LIMITED` or `UNKNOWN`. A connection that is not `ACTIVE` is refused **before any request**. A Telegram refusal re-reads the connection through `getBusinessConnection`. Plain text, no `parse_mode`, no reply `chat_id`.                                                                 |
| Idempotency               | A connection report is keyed by the Telegram update key, so a redelivered update is a replay. A message's connection lookup uses its own derived key (`…:connection`), so TB2 can record the message under the update key without a payload-hash collision.                                                                                                 |
| Scope activity            | Every connection write reads `ScopeActivityReader` inside its transaction. A stopped tenant records nothing.                                                                                                                                                                                                                                                |
| Operator alerts           | `support.business_connection.unusable` (WARN, deduplicated per connection row) opens when a connection becomes `DISABLED` or `RIGHTS_INSUFFICIENT`. `support.business_connection.usable` closes it when the connection is `ACTIVE` again or superseded. `support.business_update_failed` covers malformed updates, unknown connections and failed re-reads. |
| Registration              | `TELEGRAM_HANDLED_UPDATE_TYPES` now names the four business types. Registration already resets `allowed_updates` to Telegram's default set, which includes them. An explicit list that omits them is reported as narrowed.                                                                                                                                  |

## Decisions made in this package

1. **Operational-event codes.** `tb0-audit.md` §2 sketched separate codes for "disabled"
   and "rights insufficient". TB1 records **one** condition,
   `support.business_connection.unusable`, with the projected status in its context. The
   operator's action is the same for both (reconnect the bot, or grant the right to reply),
   and a connection that is disabled with reduced rights is one problem, not two open rows.
   No event had been recorded under the sketched names, so naming the codes here is the
   introducing release (CLAUDE.md: a code is schema).
2. **The outbound lane moves to TB2.** A durable outbound lane in TB1 would have had no
   producer: nothing in TB1 decides to send a message. CLAUDE.md forbids placeholder
   abstractions, and `0002_drop_callback_refs` records what a table with no producer
   costs. TB1 delivers the transport and its outcome taxonomy, so the TB2 lane only applies
   the rule ADR-0030 already proves: `UNKNOWN` is never resent, and 429 is requeued
   without spending an attempt. The lane, its epoch check and its first producer (the
   operator's send) arrive together in TB2.
3. **Edits and deletions.** TB1 reads both strictly and routes an edit exactly like a new
   message. There is no stored message text yet, so a deletion has nothing to purge. The
   policy in ADR-0033 §7 (an edit supersedes pending work on the older version and
   enqueues one new job; a deletion purges text and changes no state) is implemented
   where the stored text and the jobs exist, in TB2 and TB7.
4. **A refused send re-reads the connection, but not an unknown outcome.** Only a 4xx is
   evidence that the connection changed. A 5xx or a timeout is not, so it changes nothing
   stored.
5. **`getBusinessConnection` answering `NOT_FOUND`** is recorded as the connection being
   disabled. That is the only safe reading of "this id does not exist". `UNAVAILABLE`
   changes nothing, because no answer is not evidence.

## Invariants and the tests that hold them

| Invariant                                                                                  | Test                                                                                              |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| A business update never reaches the customer turn and never resolves or creates a customer | `tests/unit/business-webhook.test.ts`                                                             |
| A malformed business payload is reported, never routed elsewhere                           | `tests/unit/business-webhook.test.ts`, `tests/unit/business-chats.test.ts` ("not even an object") |
| A failed connection report is a non-2xx, so Telegram redelivers it                         | `tests/unit/business-webhook.test.ts`                                                             |
| Doubt about who sent a message resolves to HUMAN                                           | `tests/unit/business-chats.test.ts` (classification)                                              |
| Only ACTIVE may send; every other status is refused before any request                     | `tests/unit/business-transport.test.ts`, `tests/unit/business-chats.test.ts` (status)             |
| 429 is not UNKNOWN, and UNKNOWN is not a refusal                                           | `tests/unit/business-transport.test.ts`                                                           |
| Absent rights grant nothing; unknown rights are dropped                                    | `tests/unit/business-chats.test.ts`                                                               |
| Supersession by owner, never across owners, and never undone by a late report              | `tests/integration/business-connections.test.ts`                                                  |
| One open condition per connection, closed by its recovery                                  | `tests/integration/business-connections.test.ts`                                                  |
| Replay, scope-activity refusal, tenant isolation, "ask Telegram, never guess"              | `tests/integration/business-connections.test.ts`                                                  |

Mutation results are recorded in `docs/support-agent/tb1-falsification.md`, produced by
the committed `scripts/mutate-tb1.py`.

## Manual real-Telegram acceptance (TB1 portion)

This is required before any production enablement. It is **pending** a test Business
account and staging. Record each observation in
`docs/support-agent/telegram-business-observations.md`.

1. Enable Business Mode for the staging bot in @BotFather. Confirm that `getMe` returns
   `can_connect_to_business: true`.
2. From a Telegram Premium test account, connect the bot under Settings → Telegram
   Business → Chatbots with "reply to messages" granted. **Observe** the
   `business_connection` update: its `id`, `user.id`, `rights` object and `is_enabled`.
   Confirm a row in `telegram_business_connections` with status `ACTIVE`.
3. From a second test account (the customer), message the business account. **Observe**
   `business_message`: `from.id` is the customer, `business_connection_id` is present, and
   the customer turn did not run (no customer row was created by this message).
4. Send a reply from the business account **by hand** in the Telegram app. **Observe**
   whether a `business_message` arrives (OQ-TB-03), and its `from`, `sender_business_bot`
   and `is_from_offline`. NEXA must classify it `HUMAN`.
5. Call `BusinessTransport.sendText` through a staging-only harness for the customer's
   chat. Confirm the customer sees the message **from the business account**. **Observe**
   whether an echo `business_message` arrives carrying `sender_business_bot` = this bot.
   NEXA must classify it `OWN_ECHO`.
6. Configure an away message. Trigger it and **observe** `is_from_offline: true`. NEXA must
   classify it `OFFLINE`.
7. Revoke "reply to messages" in the business settings. **Observe** the update. The status
   must become `RIGHTS_INSUFFICIENT`, one `support.business_connection.unusable` must
   open, and a send attempt must be refused with no request made.
8. Grant it again. The status must return to `ACTIVE` and the condition must close.
9. Disconnect the bot, then reconnect it. **Observe** whether the connection `id` changes
   (OQ-TB-02) and whether the disconnect arrives as `is_enabled: false`. With a new id the
   old row must be `SUPERSEDED`.
10. Edit and delete a customer message. **Observe** `edited_business_message` and
    `deleted_business_messages`. Neither may run the customer turn.
11. Send to a chat with no incoming message in the last 24 hours. **Observe** Telegram's
    error. It must be `REFUSED`, never `UNKNOWN`.
12. Confirm that a second staging tenant's bot never sees the first tenant's connection
    rows, and that the same connection id on another bot resolves nothing.
