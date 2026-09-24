# WP10 follow-up — receipt push, Block User, credited-to-wallet disposition

**Scope.** This audit covers four owner requirements that follow PR #70 (Payment File 02):

1. **Push.** A new card-to-card receipt is pushed to every authorized Telegram administrator.
2. **Block User.** A fourth action on the receipt message.
3. **Credited-to-wallet.** An explicit `CREDITED_TO_WALLET` disposition.
4. **Caption.** The pushed caption is checked against File 01 §4.

This document was written before any production code. It audits `main` at `8ef2340`. Line
numbers refer to that commit.

**Owner corrections, received after approval and built in the same package** (§11 records
what was built and where it differs from the plan below):

- **OQ-WP10F-01 is in scope and built.** The Telegram reject takes a MANDATORY reason (File 01
  §7), and the customer's `PAYMENT_REJECTED` message includes it.
- **OQ-WP10F-02 is in scope and built.** A blocked customer is shown their own stored reason
  (File 01 §9).
- **OQ-WP10F-03 stays open**, recorded in `docs/open-questions.md`.
- **The push states are `DELIVERED`, `UNKNOWN` and `FAILED`** (with `PENDING` and
  `SUPERSEDED`), not `SENT` and `UNCONFIRMED`. An ambiguous send is never recorded as delivered.

**Authorities.**

- The owner's follow-up requirements.
- Payment Spec File 01 (§3–§10). It was not supplied for PR #70; it is supplied now.
- File 02, which overrides File 01 where they differ.
- `docs/payments-file02-design.md`, which records what PR #70 built.

**What does not change.** Receipts do not expire. Review happens in Telegram only. There is no
Web approve or reject. The three dispositions stay mutually exclusive, and a credit still
happens exactly once. This package adds no fee, no partial-refund UI, no timeline, no My
Payments, no gateway refund and no external gateway, and it leaves cashback and referral
untouched.

## 1. Gaps

| #   | Requirement                                     | State at `8ef2340`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | Push the receipt to authorized admins           | **Partial, and not durable.** Phase 5T already sends a text poke, which contradicts `payments-file02-design.md` D3 ("a push … is not added"). `container.ts:2889-2927` (`notifyReviewersOf`) queues `RECEIPT_AWAITING_REVIEW` on the operator lane (`notifications.ts:48`). It is text only, with no media, no caption context and no buttons (`bot.admin.receipt_awaiting`, `templates.ts:3203`). It runs **after** the receipt commits, as best effort, from the surface (`bot-runtime.ts:9084-9093`, `container.ts:3151-3170`). A crash between the commit and the poke loses the poke permanently: Telegram's redelivery answers `filed: false`, and the comment at `container.ts:3159` admits it. No test exercises the fan-out: `notifyReviewers` is referenced by no test. |
| G2  | Block User, the fourth button                   | **Absent on the receipt.** `receiptDecisionButtons` (`bot-runtime.ts:4485-4516`) draws approve, reject and credit only. A block exists in the customers section (`9:b:`, `bot-runtime.ts:1046-1050`, `6059-6083`), but that path has no confirmation and no reason capture: it writes the fixed sentence `'Blocked from the Telegram management panel.'` (`6070`).                                                                                                                                                                                                                                                                                                                                                                                                                |
| G3  | Mandatory block reason                          | **Not enforced anywhere.** `CustomerService.setStatus` turns an empty reason into `null` (`customer.service.ts:469-472`). The Web route's reason is optional (`customers.controller.ts:108`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| G4  | Block audit carries the receipt as context      | **Absent.** The audit has `before {status}`, `after {status, changed}` and `reason` (`customer.service.ts:562-575`). Nothing links it to a payment.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| G5  | `CREDITED_TO_WALLET` in list and reports        | **Detail only.** `paymentDetailSchema.receiptCredit` exists (`http.ts:3366`, `payments.controller.ts:109-121`, PAY-63). The list (`paymentSummarySchema`, `http.ts:3248`) shows the state `FAILED` with a `danger` badge (`payments.tsx:78-89`). No payment "report" exists: no reports controller, and the dashboard reads no payments (`dashboard.tsx:39`). So the list, with its filter, is the report.                                                                                                                                                                                                                                                                                                                                                                        |
| G6  | Telegram recognises an already-resolved receipt | **No.** A stale approve or reject tap gets `bot.admin.receipt_gone` whatever happened: `reviewItem` returns `null` for any non-PENDING payment (`receipt.service.ts:433-435`, `bot-runtime.ts:4703-4705`). A stale credit gets the same (`creditRefusal`, `bot-runtime.ts:3586-3602`), even though the refusal carries `disposition: 'CREDITED_TO_WALLET'` (`receipt-disposition.service.ts:184-193`, `payment.service.ts:2162-2170`).                                                                                                                                                                                                                                                                                                                                            |
| G7  | Caption fields from File 01 §4                  | **Partial.** The caption has `reference`, `total`, `customer` (Telegram id), `username`, `order` (line title) and `note` (`bot-runtime.ts:4447-4461`). It lacks the operation type, service username, volume, duration, display name and balance. See §6.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

## 2. Reuse points (evidence)

**Receipt submit** (`ReceiptService.submit`, `receipt.service.ts:170-370`):

- One `runAuthorizedMutation` transaction.
- Order of work: take the advisory capture lock (`225`), read the window, refuse a blocked customer (`246-263`), take the payment `FOR UPDATE` (`265`), insert the receipt (`292`), audit **only when a row was written** (`330-351`), then `rememberOnce`.
- There is no outbox write today, and `ReceiptServiceDeps` has no `outbox`.
- A redelivered update replays from the idempotency store, or files nothing (`filed: false`, `304`).
- **Hook point:** an outbox write beside the audit, inside `if (filed !== null)`. It commits with the receipt, and a redelivery produces none.

**Outbox relay:**

- `processed_messages` is claimed per (consumer, event) in the relay's transaction, and the effect commits with the claim (`outbox-relay.ts:308-328`).
- It pauses a stopped tenant (`tenantIsActive`, `337-345`).
- A consumer **must not** do network I/O (`event-consumer.ts:30-35`, ADR-0018).
- One consumer is registered today (`container.ts:824-826`).

**Admin resolution:**

- `TelegramAdminService.reviewers(scope, permission, correlationId, tx)` (`telegram-admin.service.ts:203-223`) returns every bound administrator whose resolved set holds the key.
- The bound list is `admins.telegram_user_id IS NOT NULL` for the tenant (`drizzle-admin.repository.ts:183-193`).
- `AdminPermissionResolver.resolve` gives a non-ACTIVE administrator nothing, and applies roles ∪ GRANT − DENY with override expiry (`admin-permission-resolver.ts:35-62`, `100-114`).
- The binding (HB-3) is per tenant, not per bot. The chat id is the numeric Telegram user id.
- There is **no hardcoded id anywhere**.

**Media send:**

- `CustomerMessenger.sendFile` (`messaging/application/ports.ts:162-196`, `237`; `telegram-customer-messenger.ts:283-323`) sends by `file_id` through the **named** bot (`tokenForBotInstance`).
- It takes a caption from a template key and inline buttons.
- It returns `DELIVERED | REFUSED | UNKNOWN | RATE_LIMITED` (ADR-0030 §2).
- A `file_id` belongs to the bot that received it, so the push must use `payment_receipts.bot_instance_id`, as the pull item already does (`bot-runtime.ts:4436-4441`).

**Shared rendering:**

- The pull item (`adminReceipt`, `bot-runtime.ts:4419-4476`) already builds the §10 single message.
- It uses the `PAY-37` text fallback when Telegram refuses the file.
- `reviewNoteOf` bounds the customer note to 600 code points (`3226-3232`).

**Capture idiom:** `admin_amount_captures` (`schema.ts:3949-4017`, `receipt-credit-capture.service.ts`) is the INCIDENT-FIN-001 answer:

- one open row per (tenant, bot, admin), by a partial unique index (`3985`) and the advisory lock `0x4143`;
- it reads ONE value;
- it expires after five minutes;
- only the sender's own capture reads their message (PAY-40);
- a slash command and a main-menu label never reach it, because both are routed before `USERNAME_TEXT` (`bot-runtime.ts:2421`, `7057-7067`).

**Customer block:** `CustomerService.block` (`customer.service.ts:414-430` → `setStatus`, `456-600`):

- It charges `users.block` before the replay and again inside the transaction.
- It reads scope activity inside the transaction.
- It makes a conditional `UPDATE … WHERE status = 'ACTIVE'` (`drizzle-customer.repository.ts:264-289`) and stores `blocked_reason`.
- It writes an audit row, writes `CustomerBlocked` to the outbox only when the status changed, and remembers the key under the `'WEB'` namespace.

## 3. Notification mechanism — decision

### Candidates, and why two of them cannot carry this

**The customer lane (`customer_notifications`) — cannot.**

- Its identity is `UNIQUE (tenant, kind, subject_id)` (`schema.ts:6373`). That allows one row per payment, not one per administrator.
- `customer_id` is a foreign key to `customers`.
- Its kinds are a closed set with **no payload** and a customer audience. ADR-0030 §1 refuses exactly the widening this would need, and migration 0069's header says the same about admin kinds.

**The operator lane (`notifications`, ADR-0018) — nearly fits, and is wrong on the property the owner stressed.** What it offers:

- per-row destination snapshots;
- `UNIQUE (tenant, dedupe_key)` (`schema.ts:1147`);
- attempts and released claims;
- Web visibility of FAILED intents.

What it lacks:

1. **Media, buttons, and a choice of bot.** It is text only (`OutboundMessage`, `ports.ts:262-268`; `textMessageBody`, `telegram-transport.ts:88-92`). It sends from `activeTokenForTenant` (`telegram-transport.ts:63`, `drizzle-tenant.repository.ts:226-243`), and a receipt's `file_id` is scoped to a particular bot.
2. **No UNKNOWN outcome.** `DELIVERY_OUTCOMES` has none (`notifications.ts:74`, pinned by CHECK).
   - A timeout becomes `FAILED_RETRYABLE` (`send-message.ts:157-163`).
   - It is re-sent until `max_attempts` (`notification-dispatcher.ts:780`).
   - A lease that expires mid-send is re-claimed.
   - Each of those is a duplicate media message with live buttons. ADR-0030 §1 records that this lane regards a duplicate as "merely noise". The owner does not: "retries must not spam".
   - Fixing this means widening a pinned enum to serve two audiences, which ADR-0025 and ADR-0030 both forbid.

**Is there an existing admin-facing lane?** Only the 5T poke on the operator lane, above.

### Decision: an outbox event, a fan-out consumer and a narrow per-admin lane

The new lane mirrors the customer lane's outcome table. It is recorded as **ADR-0031** in the
implementation.

**1. The event.** A new event type, `PaymentReceiptSubmitted`, with aggregate `Payment` and
payload `{ paymentId, receiptId }`. Adding it is a contract change in its own commit.

- It is written in `ReceiptService.submit`'s transaction, only when `filed !== null`.
- The receipt and the event commit together, and nothing about delivery is in that transaction. This satisfies the owner's rule that the receipt commits independently of delivery.
- The fan-out cannot roll the receipt back, because it runs later, on the relay.

**2. The consumer.** `receipt-review-push-fanout` does database work only, inside the relay's transaction.

- It re-reads the payment. If the payment is no longer PENDING, it writes nothing.
- It calls `reviewers(scope, 'receipts.review', …, tx)`. That resolves the recipients when the event is delivered, from the current bindings, statuses, roles and overrides.
- It inserts one row per eligible administrator with `ON CONFLICT DO NOTHING`.
- An outbox redelivery is idempotent twice over: once through `processed_messages`, and once through the row's unique key.

**3. The lane table.** `receipt_review_pushes`:

- **Identity:** `UNIQUE (tenant_id, receipt_id, admin_id)`.
- **Composite foreign keys:** to `payments`, `payment_receipts` (`payment_receipts_tenant_id_key`, `schema.ts:4081`) and `admins` (`admins_tenant_id_key`, `656`), plus `bot_instance_id` copied from the receipt.
- **States:** `PENDING | DELIVERED | UNKNOWN | FAILED | SUPERSEDED` (renamed by the owner's correction).
- **Bookkeeping:** `attempts`, `next_attempt_at`, `send_started_at`, `resolved_at`, `chat_id` (stamped at send, as history) and `last_error_code` (a machine code).
- **CHECKs:** `(state <> 'PENDING') = (resolved_at IS NOT NULL)`, and a partial due index `WHERE state = 'PENDING'`.

**One row per receipt, not per payment.** A payment holds at most `PAYMENT_RECEIPT_MAX_PER_PAYMENT = 5` receipts (`payment-receipts.ts:61`), so the fan-out is bounded. A second receipt is new evidence: the blurred screenshot, then the clear one.

**4. The dispatcher.** `ReceiptReviewPushService.deliverDue` runs as a loop in the `worker` role, beside `customerNotificationLoop` (`main.worker.ts:172`). For each claimed row, in order:

1. If the scope is inactive, release the claim.
2. If the payment is no longer a PENDING `MANUAL_TRANSFER`, mark the row `SUPERSEDED('payment.decided')`.
3. Re-resolve the administrator: still ACTIVE, still bound, still holding `receipts.review` and `receipts.view` (added by the Codex review, §11). If not, mark the row `SUPERSEDED('admin.no_authority')`. The chat id is read here, from the **current** binding. This is the delivery-time resolution the owner asked for.
4. Build the caption and the buttons for **this** administrator's permission set (§6, §4).
5. Stamp `send_started_at` and commit.
6. Call `sendFile` outside any transaction.
7. Record the outcome:
   - `DELIVERED` → `DELIVERED`.
   - `RATE_LIMITED` → stays `PENDING`, due at Telegram's `retry_after`, and does **not** spend an attempt.
   - `REFUSED` → the PAY-37 text fallback once. If that is also refused, back off; after the attempt ceiling, `FAILED`.
   - `UNKNOWN` → `UNKNOWN`, terminal, **never re-sent**, never recorded as delivered.
8. A reaper moves any row whose `send_started_at` outlived the lease to `UNKNOWN`. It is never re-sent.

### How each owner condition is met

| Owner condition             | Mechanism                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Duplicate Telegram update   | Replayed by the receipt's idempotency key: no receipt row, so no event.                                                                                                                                                                                                                                                                                                                                                                                                      |
| Outbox retry                | `processed_messages`, plus the unique key.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Worker retry or restart     | `send_started_at`, plus the reaper to `UNKNOWN`. Never re-sent.                                                                                                                                                                                                                                                                                                                                                                                                              |
| Two worker replicas         | `FOR UPDATE SKIP LOCKED` claim.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| One administrator's failure | Rows are independent. A 429 defers only that row.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Observability               | Per-row state and `last_error_code`. `FAILED` and `UNKNOWN` also open a per-administrator operational condition (`payments.receipt_push_failed`, dedupe `payments.receipt_push_failed:<adminId>`). `DELIVERED` to that administrator resolves it (`payments.receipt_push_ok`). Both are new codes, declared beside their producer as `telegram.customer_send_failed` is. They reach the log group through the existing projector (`operational-event-projector.ts:130-176`). |

**What the pull queue is for.** It remains: `adminReceipts` and `adminReceipt` are unchanged. It is also the recovery for every lost push (`UNKNOWN`, `FAILED` or `SUPERSEDED`). That is what makes "never resend an UNKNOWN" affordable.

**The 5T poke is retired.** Its producer is removed: `notifyReviewersOf`, the `notifyReviewers` dependency and the call in `submitReceipt`. Otherwise every receipt would reach each administrator as two messages. The kind `RECEIPT_AWAITING_REVIEW` and its template stay declared, because PENDING operator-lane rows may outlive the release. That follows the "widened enum is reader-compatible" convention.

**Known limit.** A tenant may run several bots, and an administrator who never started the bot
that received the receipt cannot be reached from it. That send is `REFUSED` and then `FAILED`,
with an operational condition. The receipt is still in the pull queue. An administrator granted
`receipts.review` after the fan-out is not pushed that receipt; they are pushed the next one.

## 4. Block User — reuse, not reimplementation

**Domain path.** The block is `CustomerService.block`: the same permission (`users.block`), the same conditional UPDATE, the same audit action `customer.block` and the same `CustomerBlocked` event. There is no blocking code in payments. Two minimal changes to `CustomerService.block`:

- **An optional `context`:** `{ source: 'RECEIPT_REVIEW', paymentId, captureId }`. It is folded into the request hash and carried in the audit row's `after.context`. `AuditEntry` (`ports.ts:177-186`) needs no contract change for this, because `after` is free-form. The `CustomerBlocked` payload schema (`events.ts:223`) is **not** widened.
- **Before and after:** the audit also records `blockedReason` before and after, beside the status. The actor, customer and correlation id are already on the row.

**Why a typed reason needs a capture.** The Telegram flow needs typed text. INCIDENT-FIN-001 means that text must go through a capture, never through a bare "next message" prompt.

**Decision: generalise `admin_amount_captures` rather than add a sibling table.** The table gains:

- `purpose` (`RECEIPT_CREDIT_AMOUNT | RECEIPT_BLOCK_REASON`, default the first);
- a `reason` column.

The unique open index on (tenant, bot, admin) then guarantees **one open prompt per administrator per bot across both purposes**. A sibling table could only promise that in service code. With two tables, a typed message could belong to two open prompts at once, which is INCIDENT-FIN-001 again. The existing payment foreign key gives the context link and the customer (`payments.customer_id`).

**The flow.** It follows the owner's order and File 01 §9 (Block → confirmation → mandatory reason → commit → notify):

1. **Tap Block** (a new two-character prefix family, checked by `bot-runtime.test.ts`'s prefix-disjointness test). The reply asks for confirmation and states that this does **not** decide the receipt. It writes nothing.
2. **Tap Yes.** This opens a `RECEIPT_BLOCK_REASON` capture and supersedes any open credit capture in the same transaction, under lock `0x4143`. It charges `users.block` and `receipts.view`.
3. **The administrator types the reason.** The capture reads ONE reason: trimmed, 1–500 characters (`CUSTOMER_BLOCK_REASON_MAX_LENGTH`, `http.ts:1722`). An empty or over-long reason is answered and the capture stays open. Only the sender's own capture reads the message, and a slash command or a menu label never reaches it.
4. **A commit button restates the reason.** Pressing it closes the capture `CONFIRMED` and calls `CustomerService.block` with the key `receipt-block-capture:<captureId>`, the capture's reason and the context. A capture found already `CONFIRMED` re-drives under the same key, as the credit confirm does (`receipt-credit-capture.service.ts:332-395`). A double tap, or a crash between the close and the block, therefore produces one block.

**Why commit on a button and not on the typed text.** A swallowed message would then be visible
before anything is written. The typed text alone never changes a customer.

**The mandatory reason is enforced by the backend twice:**

- the capture service refuses an empty reason;
- the database CHECK requires `purpose = 'RECEIPT_BLOCK_REASON' AND close_reason = 'CONFIRMED'` to imply a non-empty trimmed `reason`.

**The reply.**

- The blocking administrator is told the customer is blocked, and that the receipt is still awaiting a decision.
- A customer who was already BLOCKED is audited with `changed: false`. The reply says "already blocked", and the stored reason is **not** overwritten.
- The pushed message is not edited: no `editMessage` exists in this codebase.

**Authority.**

- The button is drawn only for `users.block` holders, in both the push and the pull item. The seeded `receipt_reviewer` does not hold it (`permissions.ts:449-455`).
- The backend charges `users.block` at open, at confirm and inside `setStatus`.

**Not a disposition.** Nothing in the block path touches `payments`, `receipt_credits` or the ledger:

- The payment stays PENDING. Approve, reject and credit remain available to any reviewer.
- An operator's approval of a blocked customer's transfer is allowed by design (`payment.service.ts:3252-3263`, OQ-4C-02). A blocked customer's notifications are deferred, not lost (`customer-notification.service.ts:415-427`).

## 5. Receipt disposition — representation

**The payment state machine stays as it is.** `CREDITED_TO_WALLET` keeps `PENDING → FAILED` plus a `receipt_credits` row.

**The new field.** A **derived** `receiptDisposition: 'APPROVED' | 'REJECTED' | 'CREDITED_TO_WALLET' | null` is added to `paymentSummarySchema`. It defaults to `null` on parse, for readers holding an older response, and the detail inherits it. It is computed in the list and detail queries:

| Disposition          | Condition                                                                                                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CREDITED_TO_WALLET` | A `receipt_credits` row exists (primary key `(tenant, payment)`, so a cheap `LEFT JOIN`). Its amount, decider and time are already in `receiptCredit` on the detail.         |
| `APPROVED`           | `state = 'CONFIRMED'` and `confirmed_by_admin_id IS NOT NULL`, on a `MANUAL_TRANSFER` holding at least one receipt.                                                          |
| `REJECTED`           | `state = 'FAILED'`, `resolved_by_admin_id IS NOT NULL`, no credit row, and at least one receipt.                                                                             |
| `null`               | Everything else: pending, expired, withdrawn, wallet, and a signal-only transfer decided without a receipt. That last case is a payment decision, not a receipt disposition. |

The "has a receipt" test is `EXISTS` on `payment_receipts_payment_idx` (`schema.ts:4074`).

**Web.**

- The list renders the disposition beside the state. A credited payment reads "credited to wallet", not a bare danger-toned FAILED.
- The list gains an optional `disposition` filter. This is the "report" answer, because no report surface exists (G5).
- The detail shows the disposition label above the existing credit card (PAY-63).
- Everything stays read-only.

**Telegram.** A read `ReceiptService.dispositionOf(scope, actor, paymentId)` charges `receipts.view`.

- `adminReceipt`, `adminDecide` and `adminCreditOpen` answer a decided receipt with its disposition, and `creditRefusal` does the same with the refusal's `disposition` detail.
- The answers use three new keys: `bot.admin.receipt_already_approved`, `…_rejected` and `…_credited {amount}`.
- `receipt_gone` is kept for a payment that is not found or not a manual transfer.
- No second approve, reject or credit is possible. That is already guaranteed by the conditional UPDATE (invariant 7, PAY-16/19). This only changes the words.

**Where FAILED could be misread today.**

- The list's badge and the `state=FAILED` filter.
- The detail's badge. The credit card below it clarifies.
- Any stale Telegram tap.
- API consumers of the summary.

Customer messaging is already right: a credit sends `RECEIPT_CREDITED_TO_WALLET`, not `PAYMENT_REJECTED`.

## 6. Caption field availability (File 01 §4)

The caption is built in ONE application function, used by both the pull item and the push — one implementation, two wrappers. It renders `bot.admin.receipt`, extended with **optional** placeholders. That is a contract change, and it keeps tenants' existing overrides valid.

| File 01 §4 field               | Source                                                                                                                                                                                                                                | Available?                                                                                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Operation type                 | `payments.order_id IS NULL` means a top-up; otherwise `orders.purpose` (`schema.ts:3008`; `ORDER_PURPOSES`, `commerce.ts:221`). The label is rendered from catalogue keys, never the enum.                                            | Yes                                                                                                                                                           |
| Service username               | NEW_SERVICE: `service_username_reservations.username` by order (`schema.ts:1864`, unique by order `1924`). RENEW, ADD_TRAFFIC and ADD_TIME: `service_commercial_actions.service_id` (`4784`) → `services.provider_username` (`4382`). | Mostly. A panel with no template has no name until provisioning (`nx…`), so it shows a dash.                                                                  |
| Product name, volume, duration | The order snapshot: `line_title`, `line_traffic_bytes` and `line_duration_days` (`schema.ts:3013-3015`). Rendered through the `BYTES` and `DURATION_DAYS` label keys (§11 correction).                                                | Yes, for order payments. A top-up shows a dash.                                                                                                               |
| Account name                   | `customers.first_name` / `last_name` (`CustomerRecord`).                                                                                                                                                                              | Yes                                                                                                                                                           |
| Numeric Telegram id            | `customers.telegram_user_id`.                                                                                                                                                                                                         | Yes (already shown)                                                                                                                                           |
| Telegram username              | `customers.username`.                                                                                                                                                                                                                 | Yes (already shown)                                                                                                                                           |
| Current wallet balance         | `WalletRepository.balanceOf(customer, payment currency)`: a `SUM` over the ledger, with no lock and no network (`drizzle-wallet.repository.ts:158`). The Web read charges `users.view` (`wallet.service.ts:60`, `170-179`).           | **Only for a recipient holding `users.view`**, read at render time and labelled as a snapshot. Otherwise a dash, because `receipt_reviewer` does not hold it. |
| Amount                         | `payments.amount` (the expected amount).                                                                                                                                                                                              | Yes (already shown)                                                                                                                                           |
| Payment tracking code          | `payments.reference`, the code the customer quotes.                                                                                                                                                                                   | Yes (already shown)                                                                                                                                           |
| Customer's note                | `payment_receipts.caption` → `reviewNoteOf` (600 code points).                                                                                                                                                                        | Yes (already shown)                                                                                                                                           |

**Excluded on purpose:**

- the subscription link, credentials and the panel address;
- the destination card number;
- the `file_id`, internal ids beyond what is already shown, and any secret.

**Length.** The plain caption is still cut to Telegram's 1,024 by `boundCaption` (`send-message.ts:298`, PAY-54). The note is rendered last, so the facts survive a cut.

**Invented nothing.** File 01's "کد پیگیری" is mapped to `reference`. No field without a source is added.

## 7. Concurrency boundaries

**Locks each path takes.**

| Path             | Locks, in order                                                                                                                                                                                                 |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Credit           | payment `FOR UPDATE` → customer `FOR UPDATE` (`lockCustomer`) → conditional UPDATE → ledger (`receipt-disposition.service.ts:182`, `227`, `237`; `drizzle-wallet.repository.ts:133-141`).                       |
| Approve (order)  | payment conditional UPDATE → order lock → customer `FOR UPDATE` → panel → reservation (`payment.service.ts:2755`, `2845`, `2866`).                                                                              |
| Approve (top-up) | payment → customer.                                                                                                                                                                                             |
| Reject           | payment conditional UPDATE only (`payment.service.ts:2114-2240`). Its `customer_notifications` insert takes `FOR KEY SHARE` on the customer through the foreign key.                                            |
| Block            | customer `FOR NO KEY UPDATE`, from the conditional UPDATE on non-key columns. Then `aggregate_sequences('Customer', id)`, the audit row and idempotency. No payment row, no `Wallet` or `Payment` sequence row. |

**Why no cycle is possible.**

- Block waits only on the customer row, and every disposition that touches the customer takes the payment first. The wait is one-directional.
- Credit or approve vs block: whichever reaches the customer row second waits. Both then commit. Neither checks the other's effect: a credit does not read customer status, and a block does not read the payment.
- `FOR KEY SHARE` (reject's foreign-key check) does not conflict with `FOR NO KEY UPDATE`, so **reject never waits on a block**.
- The outbox sequence rows are disjoint: `Customer/<id>` for the block, `Wallet/<customerId>` for the ledger event (`referral-commission.service.ts:150`), `Payment/<id>` for payment events.

**The rule this imposes.** The block-from-receipt path may **read** the payment for context. It must never lock it after the customer, because customer → payment against payment → customer is a deadlock. The rule is pinned by a test (§10, F-B7).

**The capture transactions.** They take the advisory lock `(0x4143, tenant, bot, admin)` and the capture row, and read the payment without a lock. They are separate from the block transaction, so they add no edge.

**Push vs permission changes.**

- The fan-out reads the bound administrators and their grants inside the relay's transaction, taking no row locks.
- A role change, disable or unbind is either seen at fan-out, or caught by the send-time re-resolution (`SUPERSEDED`).
- The push never blocks, and is never blocked by, administrator management. It never touches payments beyond a read, so it cannot delay a disposition.

## 8. Gaps found beyond the four items

The audit recorded three File 01 gaps outside the four items. The owner ruled on each:

- **OQ-WP10F-01 — File 01 §7, the reject reason. BUILT** (§11).
  - Before: the Telegram reject was one tap with the fixed note `'Rejected in the Telegram management panel.'` (`bot-runtime.ts:4718-4722`), and `PAYMENT_REJECTED` carried no values.
  - Now: the reject button opens a reason capture, and the confirm rejects with the reason.
  - The customer lane READS the reason from the payment's `resolution_note`, so there is no producer payload and ADR-0030 §1 stands.
- **OQ-WP10F-02 — File 01 §9, the reason shown to the customer. BUILT** (§11).
  - This reverses the recorded decision that `bot.blocked` carries no reason (`templates.ts:359-366`), on the owner's instruction.
- **OQ-WP10F-03 — File 01 §9's mandatory reason on every block. OPEN**, in `docs/open-questions.md`.
  - The customers-section block keeps its one tap and its fixed surface note.
  - The Web block reason stays optional.
  - Only the receipt path requires a reason.
- **Pre-existing: the idempotency namespace.** `CustomerService.setStatus` hard-codes the idempotency namespace `'WEB'` (`customer.service.ts:488`, `589`) while also serving Telegram. `docs/conventions.md` requires keys namespaced per surface. The receipt path's keys are capture-derived UUIDs, so they cannot collide, but the rule is broken for the customers section. It is recorded in `docs/open-questions.md`.
- **Pre-existing: a design-document inaccuracy.** `payments-file02-design.md` D3 says no admin push exists, but the 5T poke did. D3 is corrected.
- **File 01 §11** (expiration per method) and **§20–21** (the fee) are overridden by File 02 §4 and §9. They remain out of scope.

## 9. Migrations needed

Each is generated from `schema.ts` and checked by `pnpm db:check`.

- **`0116_receipt_review_pushes.sql`**: the lane table from §3.
  - the unique `(tenant_id, receipt_id, admin_id)`;
  - composite foreign keys to `payments`, `payment_receipts` and `admins`, and a foreign key to `bot_instances`;
  - the state enum CHECK, the resolved-at equality CHECK, `attempts >= 0`;
  - the partial due index.
- **`0117_admin_capture_purpose.sql`**: `admin_amount_captures` gains columns and CHECKs; nothing is renamed.
  - `purpose text NOT NULL DEFAULT 'RECEIPT_CREDIT_AMOUNT'`, with an enum CHECK;
  - `reason text NULL`, with `reason IS NULL OR length(btrim(reason)) BETWEEN 1 AND 500`;
  - purpose exclusivity: credit ⇒ `reason IS NULL`; block ⇒ `amount_minor IS NULL`;
  - `admin_amount_captures_confirmed_check` rewritten per purpose. A confirmed credit has an amount; a confirmed block has a reason.
  - Existing rows take the default and satisfy every CHECK.
- **No migration** for the disposition, which is derived; for `customers`, whose `blocked_reason` already exists; or for `notifications`, whose kind stays declared.

**Contract changes**, each in its own commit with its reason:

- `EVENT_TYPES += 'PaymentReceiptSubmitted'`, with a payload schema;
- `RECEIPT_REVIEW_PUSH_STATES`;
- `ADMIN_CAPTURE_PURPOSES`;
- the two operational codes;
- the `receiptDisposition` field and the `disposition` list filter in `http.ts`;
- the new template keys and the optional `bot.admin.receipt` placeholders, with their Persian catalogue entries.

## 10. Test plan

**Method.** Every race is produced, not hoped for. One side is held after its lock with the
`holdAfter` spy, and the other is seen WAITING in `pg_stat_activity` (`awaitWaitingOn`,
`receipt-dispositions.test.ts:293-331`) before the first is released. Falsification follows
`docs/wp10-falsification.md`:

- a separate worktree and database;
- each rule reverted alone;
- named tests run green first;
- a mutation counted only when vitest's JSON report shows a named test FAILED.

The rows continue as **PAY-68…**.

### Push (integration, `receipt-review-push.test.ts`)

- **P1.** A filed receipt writes one `PaymentReceiptSubmitted`. A redelivered update writes none.
- **P2.** The fan-out creates rows exactly for bound, ACTIVE administrators holding `receipts.review`. It excludes:
  - a DISABLED administrator;
  - an unbound one;
  - one whose permission comes only from a role and is removed by a DENY override;
  - one whose GRANT override has expired;
  - an administrator of tenant B.
- **P3.** Relaying the same event twice, or dispatching it with the `processed_messages` claim removed, still gives one row per (receipt, admin).
- **P4.** At send time:
  - an administrator disabled, unbound or stripped of permission after the fan-out gets `SUPERSEDED` and no send;
  - a payment decided before the send gets `SUPERSEDED`;
  - the chat id is the binding current at send.
- **P5.** Outcomes:
  - `UNKNOWN` stays `UNKNOWN` (never `DELIVERED`), and a second pass sends nothing;
  - a row stranded with `send_started_at` → `UNKNOWN` via the reaper;
  - a 429 → retried at `retry_after` with no attempt spent;
  - `REFUSED` → text fallback, then backoff, then `FAILED`.
- **P6.** One administrator's refusal does not delay another's `DELIVERED`.
- **P7.** `FAILED` or `UNKNOWN` opens `payments.receipt_push_failed` for that administrator, and the next `DELIVERED` resolves it.
- **P8.** The push goes through the receipt's bot (a two-bot tenant).
- **P9.** It is ONE `sendPhoto`/`sendDocument` with the caption and this administrator's buttons:
  - credit only with `users.wallet.credit`;
  - block only with `users.block`;
  - the balance only with `users.view`.
- **P10.** A fan-out consumer that throws leaves the receipt committed. The relay retries, and the customer's reply is unaffected.
- **P11.** The 5T poke is gone: no `RECEIPT_AWAITING_REVIEW` row for a new receipt.

### Block (integration, `telegram-admin-receipts.test.ts`, `customers`)

- **B1.** The full flow: Block → confirmation → Yes → reason → commit. The customer is BLOCKED with that reason. The audit row is `customer.block` with the actor, before and after, the reason and `after.context.paymentId`. There is one `CustomerBlocked`.
- **B2.** The payment is still PENDING with no `receipt_credits` row and no ledger entry. A different reviewer then approves (and, in another case, rejects or credits) successfully.
- **B3.** An empty or whitespace reason is answered and the capture stays open. A direct insert of a CONFIRMED block capture without a reason violates the CHECK.
- **B4.** No `users.block`: no button, and a crafted tap is refused with a denial recorded, at both open and confirm.
- **B5.** The INCIDENT-FIN-001 rows, mirroring PAY-40…46 for the reason capture:
  - another administrator's message is not read;
  - a customer's message is not read;
  - a slash command is not read;
  - it reads ONE reason;
  - it expires;
  - a confirm by another administrator is refused;
  - cancel vs confirm races both ways (the PAY-66/67 shape);
  - opening a block capture supersedes an open credit capture, and vice versa.
- **B6.** A double tap, or a replay after a crash between close and block, gives one block.
- **B7.** An already-blocked customer is not overwritten, and the reply says so.

### Block vs disposition races (deterministic)

- **R1.** Credit held after `lockCustomer`; block started and seen waiting on `update "customers"`; release. Both commit: the payment is FAILED with a credit, and the customer is BLOCKED. No `40P01`.
- **R2.** Block held after `setStatus`; credit started and seen waiting on `for update` of `customers`; release. Both commit.
- **R3.** Approve (order) held after `lockCustomer` vs block: both commit.
- **R4.** Block held; reject **completes without waiting** (asserted while the block is still held). This shows the block takes no payment lock.
- **R5.** Tenant isolation: tenant A's administrator cannot open a block capture on tenant B's payment.

### Disposition

- **D1.** Each of `CREDITED_TO_WALLET`, `APPROVED`, `REJECTED` and `null` is derived exactly, including a signal-only rejected transfer → `null`, in the list and the detail over HTTP.
- **D2.** The `disposition` filter.
- **D3.** Web: the list shows "credited to wallet" for a credited FAILED payment.
- **D4.** Telegram: a stale approve, reject or credit tap after a credit answers `…_credited` with the amount. After an approval it answers `…_approved`. Nothing moves.

### Caption (unit plus integration)

- **C1.** Each §6 field for NEW_SERVICE (CUSTOM name), RENEW and a top-up, with dashes where there is no source.
- **C2.** No subscription URL, card number or `file_id` in the rendered caption.
- **C3.** The pull item and the push render identical captions for the same recipient, because both use one builder.

### Falsification rows to record

| Row   | Mutation                                                         | Must kill    |
| ----- | ---------------------------------------------------------------- | ------------ |
| F-P1  | The outbox write in `submit` removed                             | P1           |
| F-P2  | `ON CONFLICT DO NOTHING` / unique key dropped                    | P3           |
| F-P3  | `receipts.review` filter dropped from the fan-out                | P2           |
| F-P4  | The send-time authority re-check removed                         | P4           |
| F-P5  | The send-time payment-PENDING check removed                      | P4           |
| F-P6  | `UNKNOWN` mapped to retry                                        | P5           |
| F-P7  | The reaper resends instead of `UNKNOWN`                          | P5           |
| F-P8  | A 429 spends an attempt                                          | P5           |
| F-P9  | The tenant-active check removed                                  | P2 / P4      |
| F-P10 | Buttons built from all permissions instead of the recipient's    | P9           |
| F-P11 | Balance rendered without `users.view`                            | P9           |
| F-P12 | The operational condition not opened                             | P7           |
| F-B1  | The reason emptiness refusal removed                             | B3           |
| F-B2  | The capture CHECK relaxed                                        | B3           |
| F-B3  | `users.block` authorize removed from open or confirm             | B4           |
| F-B4  | `eq(adminId)` dropped from the reason lookup                     | B5           |
| F-B5  | The block key made per-tap instead of capture-derived            | B6           |
| F-B6  | The context not passed to the audit                              | B1           |
| F-B7  | The block path locks the payment `FOR UPDATE` after the customer | R2 (`40P01`) |
| F-B8  | The block path calls a disposition (e.g. resolve)                | B2           |
| F-D1  | `receiptDisposition` ignores `receipt_credits`                   | D1           |
| F-D2  | Stale taps answered with `receipt_gone`                          | D4           |
| F-D3  | Web list renders state only                                      | D3           |

## 11. As built

What the implementation does, where it differs from the plan above, and why.

**Push (§3).** Built as designed, with the owner's state names.

- **Decision 1.** One event, `PaymentReceiptSubmitted`, written in `ReceiptService.submit` only for a filed row.
- **Fan-out.** The consumer `payments.receipt-review-push` fans out through `TelegramAdminService.reviewers`.
- **The lane.** Rows go into `receipt_review_pushes`, migration `0116`.
- **Sending.** `ReceiptReviewPushService` re-resolves the payment and the administrator (`TelegramAdminService.reviewerById`, which is new) immediately before each send. It sends through `CustomerMessenger.sendFile`, and falls back to text on `REFUSED`.
- **Outcomes.** `DELIVERED` only on a definite 2xx. `UNKNOWN` for a timeout, a 5xx, an unreadable 2xx or a stranded send; it is never re-sent and never recorded as delivered. `RATE_LIMITED` spends no attempt. `FAILED` after 3 refusals.
- **Where it runs.** `ReceiptReviewPushLoop` runs in the worker every 10 s and is health-checked.
- **The poke.** The 5T producer is removed.
- **Where the codes live.** The two operational codes are declared beside their producer (`receipt-review-push.service.ts`), as `telegram.customer_send_failed` is. The audit called them contract changes, but no contract registry of these codes exists; only the management-page lists live in contracts.

**Block User (§4).** Built as designed, with one structural refinement.

- The capture mechanics are ONE generic service, `ReceiptReasonCaptureService`, with two policies (`receipt-reason-policies.ts`): Block User and the rejection reason. Two copies of the INCIDENT-FIN-001 mechanics would drift.
- Block uses the path `CustomerService.blockWithOutcome`. It is the same path as `block`, and additionally returns whether this command changed the customer, so the reply can say "already blocked" truthfully.
- The audit carries `before`/`after.blockedReason` and `after.context {source, paymentId, captureId}`.

**Rejection reason (OQ-WP10F-01, File 01 §7).**

- **The flow.** `E:` opens a `RECEIPT_REJECT_REASON` capture (migration `0117`, which also carries the block purpose). The reason is typed and restated. `xe:` confirms and calls `PaymentService.rejectManualTransfer` under `receipt-reject-capture:<captureId>`.
- **Mandatory in the service too.** `rejectManualTransfer` itself now refuses an empty or over-long reason (`REJECT_REASON_REQUIRED`), so no caller can reject without one.
- **Where the reason lives.** It is stored in `payments.resolution_note`, the column the contract already documents as "why it was rejected, in the operator's own words". A structured field would duplicate it.
- **What the customer sees.** `bot.payment.rejected` has an OPTIONAL `{reason}`, which the lane reads through `PaymentRepository.rejectionReasonFor`. It shows a dash for a rejection recorded before the reason was mandatory, including the old fixed surface note.
- **No one-tap reject remains.**

**Blocked customer's reason (OQ-WP10F-02, File 01 §9).**

- **The new key.** `bot.blocked_with_reason` is a key of its own with a required `{reason}`. A block with no reason keeps `bot.blocked` as a whole sentence, and every existing override of `bot.blocked` keeps working. A placeholder on `bot.blocked` would have rendered an empty "reason" line for reason-less blocks.
- **Where the reason is read.** `blockedReply` reads THIS turn's resolved customer row only.
- **What is never shown.** The customers section's fixed note, `'Blocked from the Telegram management panel.'`, is never shown as a reason. That section is otherwise unchanged (OQ-WP10F-03).
- **Web copy.** The Web block hint now says the reason is shown to the customer.

**Disposition (§5).** Built as designed.

- One SQL expression (`receiptDispositionSql`) feeds the list column, the `disposition` filter and Telegram's already-resolved answers.
- The Web list has a disposition column and a filter.
- The Web detail has a disposition row beside the existing credit card.
- A stale Telegram tap answers `bot.admin.receipt_already_{approved,rejected,credited}`.

**Caption (§6).** Built as designed, through ONE builder, `ReceiptReviewCaption`, shared by the pull item and the push.

_Correction (coordinator):_ the first build rendered a top-up's duration and traffic as `0`, because those placeholders were typed `DURATION_DAYS`/`BYTES`. That invented a fact the system does not have, and `0` days also reads as unlimited. Both placeholders are now `STRING`, pre-rendered like `balance`:

- a known value goes through `bot.admin.receipt_duration` or `bot.admin.receipt_traffic`;
- an unknown value is the dash.

The facts reader also reports an add-on's unbought amount as unknown. That amount is the line's `0`, which `orders_quantity_line_check` pins to mean "none bought", so an `ADD_TRAFFIC` caption's duration and an `ADD_TIME` caption's volume are dashes. A service line's `0` is passed through as the order froze it.

**Tests.**

| File                                             | Count | What it covers                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tests/integration/receipt-review-push.test.ts`  | 19    | Push rows P1–P11, and the facts reader's add-on mapping.                                                                                                                                                                                                                                                                                                                             |
| `tests/integration/receipt-block-reject.test.ts` | 26    | Block, the blocked customer's reason, the rejection reason, the reason-bearing reject races, and the five produced block-vs-disposition races. It holds the plan's R1–R4. R5 is NOT a separate test: a block capture on another tenant's payment is refused by the tenant-scoped payment read, but no test pins it. The tenant case that IS pinned is the blocked customer's reason. |
| `tests/integration/wallet-payments-http.test.ts` | 1 new | The disposition on the Web list, detail and filter.                                                                                                                                                                                                                                                                                                                                  |
| `tests/unit/receipt-review-caption.test.ts`      | 10    | Caption (a dash for an unknown volume or duration), buttons, reason bound, blocked reply.                                                                                                                                                                                                                                                                                            |
| `tests/web/payments.test.tsx`                    | 2 new | The Web list and detail.                                                                                                                                                                                                                                                                                                                                                             |

The falsification rows are PAY-68…PAY-104 in `docs/wp10-falsification.md`.

### The one Codex review

The review raised five findings. Four were confirmed against the code and fixed in `798b4d4`, with the falsification rows PAY-105…PAY-113 in `docs/wp10-falsification.md`:

- **The push needs `receipts.view` as well as `receipts.review`.** This holds at the fan-out and again at send. The rejection's capture charges `receipts.view` again, as the one-tap rejection did through `reviewItem`.
- **A block reason is bounded in code points in `CustomerService`,** as the capture counts it. A UTF-16 slice kept 250 of 500 confirmed emoji and could split a surrogate pair.
- **A Cancel on a CONFIRMED reason capture reports the actual state:** the customer's row for a block, and the payment for a rejection. A capture closes before its action runs, so CONFIRMED proves the reason, not the action.
- **An UNKNOWN, FAILED or reaped push opens its operational condition in the transaction that makes it terminal.**

The fifth finding was declined. It said a crafted reject callback can reject a pending transfer that has no receipt. `main`'s one-tap path had the same admission (`reviewItem` never required a receipt), and approve still does.
