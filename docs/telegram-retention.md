# Telegram message-state retention

`telegram_wizards` and `telegram_review_messages` (R2, migration `0143`) record which
Telegram message shows a customer's purchase or top-up wizard, and which messages show an
administrator's receipt review. They are **presentation state, never business truth**: an
order, a payment, a capture and a decision re-decide every write under their own locks and
idempotency keys, and these rows only say which message to edit and whether a tapped button
still belongs to the screen it shows. Until this change nothing removed them, so both grew
by a row per tracked message for the life of the installation
(`docs/deployment.md`, "not pruned yet").

This document is the lifecycle map first (§1–§3), then the retention rules (§4–§7). Line
numbers are at the commit that introduced this file.

## 1. `telegram_wizards`: states

One row per tracked message, unique on `(tenant_id, bot_instance_id, chat_id, message_id)`.
`step` is the screen the message SHOWS (`TELEGRAM_WIZARD_STEPS`,
`packages/contracts/src/telegram-wizards.ts:49`):

| Step                                                                                                    | Meaning                                                                           | Who moves it on                                                                              |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `CATEGORIES`, `PRODUCTS`, `USERNAME`, `DISCOUNT`, `PREINVOICE`, `AWAITING_PAYMENT`, `METHODS`, `AMOUNT` | a wizard screen with buttons                                                      | the next tap (`claim` → `land`) or a typed answer (`claimLatest` → `land`)                   |
| `INVOICE_LOADING`                                                                                       | loading screen a turn landed and holds (`busy_until`) until its edit is asked for | the same turn, to `INVOICE_PENDING` (`bot-runtime.ts:14836`)                                 |
| `INVOICE_PENDING`                                                                                       | the provider invoice is still being created                                       | whichever of the turn and the gateway worker moves it first (`wizard-invoice-screens.ts:88`) |
| `INVOICE`                                                                                               | the invoice, with its pay link and check button                                   | the worker on the attempt's end; a check tap                                                 |
| `NOTICE`                                                                                                | a sentence the flow ended on; its buttons (if any) restart a step                 | a tap on such a button                                                                       |
| `CLOSED`                                                                                                | terminal: paid, withdrawn, finalised, or a message a refused edit LEFT            | nothing — no button of it is honoured again                                                  |

Other columns: `version` (bumped by every claim and move — what makes a landing
conditional), `busy_until` (a turn's lease, `WIZARD_CLAIM_LEASE_MS` = 30 s), `subject_id`
(the order for `ORDER`, the amount capture for `TOPUP`), `payment_id` (the invoice's
payment; no foreign key), `last_update_key` (the update that landed the screen, so its
redelivery replays), `updated_at`.

## 2. `telegram_review_messages`: states

One row per tracked review message, same unique key, `payment_id` a composite foreign key to
`payments`. `role` is `REVIEW` (the receipt and its decision buttons) or `PROMPT` (a reason,
amount or confirmation prompt a decision opened). Two states only: `finalised_at IS NULL`
(the message still offers a decision) and `finalised_at` set (edited into the decision's
record; a repeated tap is answered with the disposition's toast and nothing else).
`unfinaliseReviewMessage` clears a stamp whose edit Telegram definitely did not apply.

## 3. Readers and writers

Every write goes through `TelegramMessageStateService`
(`apps/api/src/modules/commerce/messaging/application/telegram-message-state.ts`), inside
`runAuthorizedMutation` under `maintenance.run` with `ScopeActivityReader` read in the
transaction, and every repository statement
(`.../infrastructure/drizzle-telegram-message-state.repository.ts`) is conditional.

| Operation                                                                 | Service (line)            | Repository (line)                                      | Called from                                                                                                                                                                                                                                                                     | Protects                                                                                                                                                               |
| ------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claim` — adopt an untracked message as the gate's first step, then claim | 365                       | `adoptWizard` 126, `findWizard` 158, `claimWizard` 171 | `bot-runtime.ts:5237` (every gated tap, `WIZARD_GATES`, `wizard-state.ts:196`)                                                                                                                                                                                                  | stale-callback protection (a tap is honoured only while the message still shows the button's screen and no other turn holds it); redelivery replay (`last_update_key`) |
| `claimLatest` — the wizard a typed answer continues                       | 434                       | `latestWizard` 340, `claimWizard`                      | `bot-runtime.ts:14753`                                                                                                                                                                                                                                                          | edit-in-place for typed answers                                                                                                                                        |
| `land` — the screen a claim's reply shows                                 | 460                       | `landWizard` 221                                       | `bot-runtime.ts:14781`                                                                                                                                                                                                                                                          | a worker move between claim and landing wins (version)                                                                                                                 |
| `release` — give a claim back                                             | 506                       | `releaseWizard` 253                                    | `bot-runtime.ts:5282`, `5312`, `14777`                                                                                                                                                                                                                                          | a failed or silent turn does not freeze the message for its lease                                                                                                      |
| `move` — the screen went out as a new message; the old one stays `CLOSED` | 520                       | `moveWizard` 274                                       | `bot-runtime.ts:14813`                                                                                                                                                                                                                                                          | the message LEFT keeps its keyboard; its `CLOSED` row keeps that keyboard stale (finding F2)                                                                           |
| `register` — a wizard screen sent as a new message                        | 535                       | `adoptWizard`                                          | `bot-runtime.ts:5575`                                                                                                                                                                                                                                                           | the next tap on it edits it in place                                                                                                                                   |
| `moveAll` — every wizard showing a payment / naming an order              | 564                       | `moveWizards` 372                                      | `bot-runtime.ts:14836` (loading → pending); `wizard-invoice-screens.ts:88` (worker: invoice ready / ended, via `GatewayPaymentService` `gateway-payment.service.ts:297`); `wizard-invoice-screens.ts:124` (`closeOrder`, the renewal lane, `container.ts` `orderScreens.close`) | invoice flows: exactly one of the turn and the worker edits each invoice message                                                                                       |
| `moveBack` — undo a move whose edit got a 429                             | 486                       | `landWizard`                                           | `wizard-invoice-screens.ts:110`                                                                                                                                                                                                                                                 | the message's buttons stay honoured so a tap can finish the edit                                                                                                       |
| `findReview`                                                              | 603                       | `findReviewMessage` 445                                | `bot-runtime.ts:5218` (the repeated-tap gate), `14873`                                                                                                                                                                                                                          | receipt-review final state                                                                                                                                             |
| `recordReview`                                                            | 583                       | `recordReviewMessage` 417                              | `bot-runtime.ts:5419`, `5586`, `14877`                                                                                                                                                                                                                                          | the decision finds every message to edit                                                                                                                               |
| `finaliseReviews`                                                         | 611                       | `finaliseReviewMessages` 457                           | `bot-runtime.ts:14885`                                                                                                                                                                                                                                                          | exactly the messages this call stamped are edited, once                                                                                                                |
| `unfinaliseReview`                                                        | (after `finaliseReviews`) | `unfinaliseReviewMessage` 633                          | `bot-runtime.ts:14896`                                                                                                                                                                                                                                                          | a refused/429 edit can be retried by a later tap                                                                                                                       |

What a row is FOR, and when that stops:

- **Stale-callback protection.** A tap on a message whose row shows another screen, or
  `CLOSED`, is answered and nothing else. Telegram keeps an inline keyboard tappable for
  as long as the message is in the chat — indefinitely. So this is the one purpose that
  does NOT end with time, and it is why a deleted row needs a replacement (§5).
- **Idempotency / crash recovery.** `last_update_key` lets Telegram's redelivery of the
  landing update through again; Telegram redelivers for at most a day. A lease
  (`busy_until`) is 30 seconds. Neither outlives the retention period by any margin.
- **Edit-in-place recovery and invoice flows.** The worker moves invoice screens only for
  payments still being decided; a `GATEWAY` attempt ends within an hour
  (`PAYMENT_WINDOW_MINUTES_MAX`). The renewal lane closes an order's screens when the
  order settles. Once the payment is terminal and the order done, nothing writes the row.
- **Receipt-review final state.** A decision (approve, reject, credit) requires the payment
  `PENDING` (`receipt-credit-capture.service.ts:191`; `payment.service.ts` refuses every
  manual decision on a payment that is not `PENDING`). A `PENDING` transfer with a receipt never expires
  (`payment-expiry.service.ts`, "A submitted receipt has no timer"), so its rows stay
  needed until a reviewer decides; `UNKNOWN` may still be reconciled. Once terminal, no
  decision is taken again and no review message is edited again.
- **Old Telegram messages still in chats.** Their keyboards stay tappable for ever; §5 is
  what keeps them harmless after their rows are gone.

## 4. Retention rules

A tenant-scoped sweep (`TelegramMessageStateService.purgeExpired`, run by
`TelegramMessageRetentionLoop` in the worker) deletes, per pass and per table, at most a
batch of rows, oldest first. Retention period: `TELEGRAM_MESSAGE_STATE_RETENTION_DAYS` = 30
(a contract constant, like `TICKET_REPLY_FILE_RETENTION_DAYS`; see its docblock for why not
a setting).

**A wizard row is removed only when ALL hold** (`purgeWizards`):

1. `updated_at` is more than 30 days ago (every claim, landing, move and release bumps it);
2. it is not leased: `busy_until IS NULL OR busy_until <= now`;
3. its `payment_id` names no payment that is still open — `state NOT IN
PAYMENT_TERMINAL_STATES`, i.e. `PENDING` or `UNKNOWN` — nor one whose `updated_at` is
   within the retention period (a payment id with no row names nothing);
4. for an `ORDER` wizard, its `subject_id` names no order that is not done — `state NOT IN
(ORDER_SETTLED_STATES ∪ ORDER_TERMINAL_STATES)`, i.e. `DRAFT` or `AWAITING_PAYMENT` —
   nor one whose `updated_at` is within the retention period. Written as the DONE list, so
   a state added later is retained by default;
5. for an `ORDER` wizard, its order is not BUSY: it has no provisioning operation still
   running (any state outside `OPERATION_TERMINAL_STATES`), no `SUCCEEDED`/`ABANDONED`
   operation with `announced_at IS NULL`, and no `PENDING` customer notification whose
   subject is one of its operations.

Rules 3–5 exist for the DELAYED writers (Codex review of #131): the gateway worker's
`refresh(paymentId)` runs right after a payment's outcome commits, a reviewer can decide a
receipt that has been pending for weeks, and the renewal result's `closeOrder` runs only
when the notification lane delivers `SERVICE_RENEWED` — after the order's RENEW operation
has succeeded and been announced, which can be days after the order was paid if the
operation went `UNKNOWN`. Each of them must still find the wizard, or the result arrives
beside a keyboard that looks live and whose taps are silently stale. `updated_at` is bumped
by every state transition of a payment and of an order.

Every step qualifies, `CLOSED` and `NOTICE` included, once those five hold.

**A review row is removed only when ALL hold** (`purgeReviewMessages`):

1. its payment is terminal (`PAYMENT_TERMINAL_STATES`: `CONFIRMED`, `FAILED`, `CANCELLED`,
   `EXPIRED`) — so `PENDING` (including a block, which finalises only the blocker's copy and
   leaves the receipt in the queue) and `UNKNOWN` keep every row;
2. its last write — `finalised_at`, or `created_at` when it was never finalised (a payment
   decided in the Web Admin or expired) — is more than 30 days ago.

**Never touched**: orders, payments, receipts, wallet entries, services, provisioning
operations, audit and operational records, the outbox, `processed_messages`. The sweep
deletes from the two presentation tables only, and the backup still dumps everything
(nothing is excluded; `telegram_message_horizons` is an ordinary table in the dump).

## 5. The purge horizon: why a stale tap after cleanup is safe

Before this change a tap on a message with NO row was treated as a message "sent before
this release, or whose send answer was lost": a wizard gate ADOPTED it as the gate's first
step and claimed it; a review tap went to the decision. That is wrong for a message whose
row was deleted — a `CLOSED` row a refused edit left behind still carries the pre-invoice
keyboard, and adopting it would let its wallet button pay (the case
`r2-wizard-edit-in-place.test.ts` "retention: …" reproduces).

So the sweep records, per `(tenant, bot, chat)`, the greatest message id it has removed:
`telegram_message_horizons.purged_through_message_id`. It is raised with `GREATEST` (it
never falls) in the **same transaction** as the delete, and never deleted.

- **Wizard gate** (`TelegramMessageStateService.claim`): no row AND `message_id <=` the
  chat's horizon → `STALE`, nothing written. Read in the claim's transaction after
  `findWizard`; because the delete and the horizon commit together, a read that no longer
  sees the row sees the horizon.
- **Review gate** (`bot-runtime.ts`, `reviewTapIsRetired`): a review tap on a message with
  no row at or below the horizon is answered like a finalised one — `answerCallbackQuery`
  and nothing else. The decision is never asked for again (and would be refused anyway: the
  sweep removed the row only because the payment is terminal).

The rule is exact, not a time window: every removed message's id is at or below its chat's
horizon by construction. Its only cost is on the safe side: an untracked message older than
a removed one in the same chat (i.e. more than 30 days old) is also answered as stale
instead of adopted. That relies on Telegram message ids increasing within a private chat
for USABILITY only; if they did not, the effect would be more stale answers, never an
adoption of a removed row.

A tap after cleanup can therefore never create, repeat or re-decide anything: no draft, no
payment, no wallet movement, no provider call — the services behind the buttons are not
reached. (They would still refuse on their own state; the horizon makes that a second line,
not the only one.)

## 6. Concurrency, tenancy, bounds, restarts

- **Sweep vs. tap.** Candidates are a `MATERIALIZED` CTE taken `FOR UPDATE OF c SKIP
LOCKED`; the DELETE re-checks age and lease on the row it removes. A tap whose claim
  committed first has bumped `updated_at` — no longer a candidate. A claim that arrives
  while the sweep holds the row waits, then finds it gone (`STALE`). A `moveAll` from the
  worker likewise finds nothing to edit. Pinned by "a sweep racing taps on its rows".
- **Why a CTE.** `id IN (SELECT … LIMIT n FOR UPDATE SKIP LOCKED)` may be re-run per outer
  row; a re-run skips the rows the statement has just deleted and returns the NEXT n, so the
  bound becomes "everything" (the batching test caught a limit of 3 deleting 7). Note: the
  same pattern is used by `DrizzleTicketRepository.purgeReplyFileContentBefore`; it was not
  changed here (out of scope) and is worth the same check.
- **Two worker replicas** are the normal case on every rolling update: `SKIP LOCKED` gives
  them disjoint rows, and horizon upserts are sorted by key so they cannot deadlock.
- **Tenancy.** Every predicate names the tenant; the horizon is keyed by tenant, bot and
  chat. Pinned by "tenant A's sweep never touches tenant B".
- **A stopped scope removes nothing** — the same `ScopeActivityReader` check as every other
  write here, inside the transaction.
- **Bounds.** 500 rows per table per transaction, at most 40 batches per hourly tick; a
  tick that reaches the ceiling logs a warning and the next continues. First tick 150 s
  after start, so a restart loop still sweeps. Restart-safe: each batch commits on its own
  and nothing is held in memory but the failure streak.
- **Indexes.** `telegram_wizards_retention_idx (tenant_id, updated_at)` and
  `telegram_review_messages_retention_idx (tenant_id, created_at)` are ONLINE indexes
  (`online-indexes.ts`), built concurrently after the migrator: both tables take a write
  per tap. Migration `0153_telegram_message_retention` only creates the empty horizon table.

## 7. Operational visibility

The loop is in the worker's readiness list (`telegram-message-retention`): a loop whose
every tick fails turns readiness stale. A failure streak is ONE operational condition,
`telegram.message_retention_failing` (dedupe key = code, so per tenant), written when 3
consecutive ticks have failed and then at most once an hour while it lasts — its occurrence
counter climbs, no row per tick. The first completed tick records
`telegram.message_retention_recovered`, which resolves exactly that condition, including one
a replaced replica left open (looked up once per process). Both codes are declared in
`packages/contracts/src/telegram-wizards.ts`.

## 8. What is retained, and why

| Row class                                                                                                                                             | Fate                   | Reason                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wizard, untouched > 30 d, not leased, no open payment / unfinished order (any step)                                                                   | removed                | nothing writes it again; §5 keeps its keyboard stale                                                                                                                      |
| Wizard touched within 30 d                                                                                                                            | retained               | may still be claimed, landed, moved or redelivered                                                                                                                        |
| Wizard with a live lease                                                                                                                              | retained               | a turn is using it                                                                                                                                                        |
| Wizard showing a `PENDING` / `UNKNOWN` payment                                                                                                        | retained               | the worker may still edit the invoice into its outcome; `UNKNOWN` may be reconciled                                                                                       |
| `ORDER` wizard of a `DRAFT` / `AWAITING_PAYMENT` order                                                                                                | retained               | the order can still be paid and its screens closed                                                                                                                        |
| Wizard whose payment or order changed within 30 d; `ORDER` wizard whose order has a running or unannounced operation or a pending result notification | retained               | a delayed writer (worker refresh, renewal `closeOrder`) still edits it                                                                                                    |
| Review row of a terminal payment, last write > 30 d                                                                                                   | removed                | no decision is taken on it again                                                                                                                                          |
| Review row of a `PENDING` / `UNKNOWN` payment                                                                                                         | retained (**blocker**) | a pending receipt has no timer and stays reviewable for as long as nobody decides; its rows are what the decision edits. Bounded by the review queue itself, not by time. |
| `telegram_message_horizons`                                                                                                                           | retained               | one row per chat the sweep touched; it is the stale-tap proof                                                                                                             |
