# ADR 0033 — Telegram Business conversations, and why a human always wins

**Status: accepted for implementation (TB1, TB2).** Program: Intelligent Support Agent.
Evidence: `docs/support-agent/tb0-audit.md` §1, §3, §4.

## Context

The product's support channel is the owner's own Telegram account. Telegram's official
Business connection lets a bot receive the private messages of a connected Business
account and send messages on that account's behalf, using `business_connection_id`.
Customers would see an AI's answer as coming from the person they already know as
support. So the cost of a wrong message is not "a bot misbehaved". The cost is that
the owner said it.

Three properties of the primitive shape every decision below:

1. **No send is idempotent.** No Telegram method takes a deduplication key. A
   timed-out send may have been delivered.
2. **Telegram has no conditional send.** "Send unless the owner has just typed" cannot
   be expressed. Any check we make happens before a request whose effect we do not
   control.
3. **Several facts are UNKNOWN** until a real account is observed
   (`tb0-audit.md` §1.3). The most important one is whether messages the owner types
   by hand reach the bot at all.

## Decision

### 1. The official Business connection, and nothing else

Business updates arrive on the existing per-bot webhook. Telegram's default
`allowed_updates` already includes them. They are dispatched **before**
`botRuntime.handle` to a dedicated handler, so a business message can never be
mistaken for a customer's own bot chat. Its chat id may equal a bot-chat id, and the
reference says the two chats are independent. No userbot, MTProto session or
imitation of the account is built (program §2, §3).

### 2. A connection is a row keyed by the bot, identified by its owner

`telegram_business_connections` is keyed by `(bot_instance_id, connection_id)`. The
tenant comes from the bot instance, which comes from the authenticated route. The
connection's `user.id` is the **owner**. Its status (`ACTIVE`, `DISABLED`,
`RIGHTS_INSUFFICIENT`, `SUPERSEDED`) is **projected** from `is_enabled`, the stored
rights, and the supersession pointer. It is never stored as a second fact that could
disagree. A connection is sendable only when it is enabled **and** holds `can_reply`.
Anything else fails closed and raises a deduplicated operational event. A send refused
with a connection-class error is verified with `getBusinessConnection` before any
state is re-enabled.

### 3. Every outgoing business message has one classification, and doubt means "human"

`tb0-audit.md` §1.4 is the rule. It splits an outgoing message into five cases: our
own echo, an away or greeting message, another business bot, the owner, and a
customer. **Any outgoing message we cannot positively attribute to our own bot is a
human**, because the costs are asymmetric. A wrongly silent AI costs a few minutes; an
AI that answers over the owner costs the conversation.

### 4. The epoch is the takeover mechanism

Each conversation has `state` and a monotonically increasing `control_epoch`. Every
human signal increments the epoch and sets `HUMAN_ACTIVE`, under the conversation's
row lock, in the transaction that records it. Every job and every outbound row
carries the epoch it was created under. The send lane locks the conversation, compares
the epoch and the state, and stamps `send_started_at` **in one transaction**, then
calls Telegram outside it. A mismatch marks the row `SUPERSEDED`, and nothing is sent.

There is no `setState`. Every transition is a conditional UPDATE naming its `from`
states, for the reason ADR-0028 gives: replays, double-clicks and two replicas are all
made safe by that one mechanism.

### 5. Returning control is explicit

`HUMAN_ACTIVE → AI_ACTIVE` happens only by an operator action
(«سپردن دوباره به هوش مصنوعی»). It needs `business_chats.reply` and an idempotency key,
and it writes an audit row. It also increments the epoch, so a job created before the
takeover can never send after the resume. An inactivity timeout may be added later as
a tenant setting. It must be visible and cancellable, and it is off by default.

### 6. An UNKNOWN send is never resent

The outcome mapping is `TelegramCustomerMessenger`'s:

| Outcome        | Effect                                                                  |
| -------------- | ----------------------------------------------------------------------- |
| `DELIVERED`    | Record `message_id`                                                     |
| `RATE_LIMITED` | Requeue at `retry_after`, no attempt spent                              |
| `REFUSED`      | `FAILED`, conversation `HANDOFF_REQUIRED`                               |
| `UNKNOWN`      | `UNCONFIRMED`, conversation `HANDOFF_REQUIRED` (`SEND_OUTCOME_UNKNOWN`) |

A stamped row whose process died is reaped to `UNCONFIRMED`, never re-sent. This is
the same rule ADR-0025 §3 and ADR-0030 hold, for the same reason.

### 7. Edits and deletions

An edit increments the message's `content_version`. A pending job based on an older
version is superseded, and **one** new job is enqueued. An edit can therefore never
produce two replies. A deletion purges the stored text and supersedes jobs on that
message. It changes no conversation state, so a deleted message cannot reopen or
close anything. Both are idempotent on the update key.

### 8. Data minimisation

The transcript is kept only as far as the agent needs context. Message text is
bounded, purged 30 days after receipt and immediately on deletion. Telegram file ids
are never projected to the browser. Audit rows record that a takeover happened, never
what was said.

## Consequences

- **Residual race, stated.** A human message sent after our stamp commits, or not yet
  delivered by Telegram, cannot be beaten. Auto-reply mitigates it with a configurable
  settle delay before the final check (`OQ-TB-04`). It cannot be eliminated by any
  design on this primitive.
- **If U3 resolves "owner messages are not delivered", `AUTO_REPLY_SAFE` does not
  ship.** Takeover would be undetectable. Assist Mode, where a human presses send, is
  unaffected.
- A business message never creates a customer (`tb0-audit.md` §3). The connection
  owner's contacts are not registered as NEXA customers by messaging them.

## Considered and rejected

- **A userbot session (MTProto).** It would observe everything, but it imitates the
  account, holds the owner's full session credentials, and the program forbids it.
- **Detecting the human by message text or timing.** It is not authoritative, and the
  program forbids it.
- **A `PAUSED_UNTIL` timestamp instead of an epoch.** A timestamp compares against the
  clock. An epoch compares against _what happened_, and two events in the same
  millisecond are still ordered.
- **Retrying UNKNOWN sends with a content hash check.** Telegram exposes no read of
  "did this exact message arrive", so the check could not be made.
