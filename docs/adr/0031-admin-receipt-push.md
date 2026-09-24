# ADR 0031 — the administrators' receipt push

**Status: accepted.** WP10 follow-up. Extends ADR 0030's outcome table to an administrator
audience. Retires the Phase 5T text poke's producer.

## Context

File 01 §3 requires that a customer's card-to-card receipt reach the authorized administrators
in Telegram. It must arrive as ONE message: the file, the context in its caption, and the
decisions as its inline buttons. The owner's follow-up adds these requirements:

- the push must be durable, idempotent and observable when it fails;
- it must not be part of the transaction that files the receipt;
- no retry, restart or redelivery may produce an uncontrolled duplicate.

The pull queue stays.

**The Phase 5T poke is not that push.** It is a text-only `RECEIPT_AWAITING_REVIEW` intent on the
operator lane.

- It is queued by the surface AFTER the receipt commits, as best effort (`container.ts` at
  `8ef2340`). A crash between the commit and the poke loses it permanently, because Telegram's
  redelivery answers `filed: false`.
- It carries no media and no buttons.
- `docs/wp10-followup-audit.md` §1 G1 measures it.

## Decision

### 1. An event, a consumer, and a lane of its own

The push has three parts:

- **The event.** `ReceiptService.submit` writes `PaymentReceiptSubmitted` in the transaction that
  files a NEW receipt row. A redelivered update files nothing and writes nothing. The receipt and
  the event are therefore equally durable, and nothing about delivery is in that transaction.
- **The consumer.** `payments.receipt-review-push` fans the event out, inside the relay's
  transaction.
  - It re-reads the payment. A decided payment gets no push.
  - It lists the tenant's bound administrators whose resolved authority holds `receipts.review`,
    through `TelegramAdminService.reviewers`. The resolver gives a disabled administrator
    nothing.
  - It inserts one `receipt_review_pushes` row per (receipt, administrator) with
    `ON CONFLICT DO NOTHING`.
- **The dispatcher.** `ReceiptReviewPushService` runs in the worker. For each claimed row, in
  order:
  1. It re-checks that the payment is still pending. If not, the row becomes `SUPERSEDED`.
  2. It re-resolves the administrator: still ACTIVE, still bound, and still holding the
     permission. If not, the row becomes `SUPERSEDED`. The chat it sends to is the binding
     current at send time.
  3. It builds the caption and the keyboard for THAT administrator.
  4. It stamps `send_started_at` and commits.
  5. It sends through `CustomerMessenger.sendFile`, from the bot that received the file.

**Why a consumer and not the receipt's transaction.** A fan-out inside the filing transaction
would put an administrator query and N inserts in the one place whose failure costs a customer
their receipt. The owner rules that out explicitly.

**Why not the customer lane.** `customer_notifications` is one row per (kind, subject), carries a
foreign key to `customers`, and holds a closed set of kinds with no payload. ADR 0030 §1 refuses
exactly the widening this would need.

**Why not the operator lane.**

- `notifications` sends text only, from the tenant's first active bot. A `file_id` belongs to the
  bot that received it.
- Its `DELIVERY_OUTCOMES` enum, which a CHECK constraint pins, has no UNKNOWN. A timeout is
  retried, and so is a lease that expires mid-send. For an operator alert ADR 0030 calls that
  "merely noise". For a receipt carrying live decision buttons, it is the spam the owner forbade.
- ADR 0025 and ADR 0030 both refuse to widen a pinned enum so that it serves two audiences.

### 2. The outcome table is ADR 0030's

| Send outcome              | Row                                                                                                                                     |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `DELIVERED`               | `DELIVERED`                                                                                                                             |
| `UNKNOWN`                 | `UNKNOWN`, terminal, **never re-sent and never recorded as `DELIVERED`**                                                                |
| a send whose process died | `UNKNOWN`, via the reaper (`last_error_code` `push.send_stranded`), never re-sent                                                       |
| `RATE_LIMITED`            | `PENDING` again at Telegram's `retry_after`, **no attempt spent**                                                                       |
| `REFUSED`                 | the same caption and buttons as text from the same bot. If that is also refused, back off, and after three refusals the row is `FAILED` |

The row's states are the send's outcomes, by the owner's correction: an earlier draft of this ADR
called them `SENT` and `UNCONFIRMED`, and a name that is not the outcome is where "unknown" starts
being read as "sent".

The pull queue is the recovery for every push this lane does not deliver. That is what makes
"never re-send an UNKNOWN" affordable.

### 3. Idempotency and isolation

- **Idempotency.** The unique key `(tenant_id, receipt_id, admin_id)` absorbs an outbox
  redelivery, a consumer replayed after its `processed_messages` claim was lost, and two relay
  replicas.
- **Leases.** A row whose send started is never claimed again. The claim is a conditional UPDATE
  that moves `next_attempt_at` to a lease, which is the customer lane's mechanism.
- **Isolation.** Rows are independent: one administrator's refusal, rate limit or stranded send
  touches no other administrator's row.
- **Tenancy.** Composite foreign keys tie each row to its tenant's payment, receipt and
  administrator.

### 4. Observability

`FAILED` and `UNKNOWN` open the operational condition `payments.receipt_push_failed`, deduped
per administrator. The next `DELIVERED` to that administrator closes it with
`payments.receipt_push_ok`. The condition's context carries ids and a machine code, never the
customer's caption. The row's own `last_error_code` says why each push is where it is.

### 5. The poke is retired

`notifyReviewersOf` and the surface's `notifyReviewers` dependency are removed. Keeping them would
send every receipt twice.

The kind `RECEIPT_AWAITING_REVIEW` and the template `bot.admin.receipt_awaiting` stay declared. A
PENDING row written by the previous release may outlive it, and a widened enum must remain
reader-compatible (`docs/conventions.md`).

## Consequences

- An administrator who never started the bot that received a receipt cannot be pushed from it:
  Telegram answers 403. The row is `FAILED` and the condition opens. The receipt is still in the
  queue.
- An administrator granted `receipts.review` after the fan-out is not pushed that receipt, but is
  pushed the next one.
- A payment decided before the send is not pushed. A payment decided after the send leaves a
  message whose buttons answer "already decided", and name how.
