# WP10 — Payment / Receipt / Reconciliation: audit and decisions

> **Superseded in part.** The owner's Payment Spec File 02 is now the authority for this
> package; `docs/payments-file02-design.md` records where it overrides the decisions below.
> P1 (the late-review lane) and §10-B P5–P9 and P11 are withdrawn; P2, P3, P4 and P13 stand.

§10 of the autonomous execution plan. This document records what the payment, receipt,
refund and ledger code does at `0ff0448`, measured against §10.1–§10.16. It then records
the decisions P1–P12 this package implements, and what is deliberately not built.
Open questions are `OQ-WP10-01`… in `docs/open-questions.md`.

The audit was done read-only against the code, not the older audits. Where an earlier
document and the code disagree, the code is what is recorded here.

## 1. What exists

| Entity                | Where                                                              | Notes                                                                                              |
| --------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Order                 | `orders`; machine in `contracts/commerce.ts`                       | DRAFT, AWAITING_PAYMENT, PAID, CANCELLED, EXPIRED, REFUNDED. `PAID → REFUNDED` exists.             |
| Payment               | `payments`; `contracts/payment.ts`                                 | PENDING, CONFIRMED, FAILED, CANCELLED, EXPIRED, UNKNOWN. Methods WALLET, MANUAL_TRANSFER, GATEWAY. |
| Receipt               | `receipt_captures`, `payment_receipts` (append-only, 0067)         | Telegram file ids. The bytes stay at Telegram.                                                     |
| Refund                | `refunds` (frozen, no delete, 0073)                                | WALLET_CREDIT completes immediately. EXTERNAL waits for an operator.                               |
| Wallet                | `wallet_entries` (append-only)                                     | The balance is a SUM, and there is no balance column.                                              |
| Cashback / commission | `order_cashback`, `order_referral_commissions` and their reversals | Reversed inside the refund's transaction.                                                          |

**Every live rail is manual or internal.**

- `GATEWAY` is refused by `assertMethodAvailable`, and `PAYMENT_GATEWAY_PROVIDERS` is `['MANUAL_TRANSFER']`.
- There is no callback route, no provider transaction reference and no reconciliation worker.
- `payments.external_reference` is never written. `UNKNOWN`, `LOSE_TRACK` and `RECONCILE_*` have no producer.
- The owner has not named a provider (`OQ-4G-04`, `OQ-5D-01`).

## 2. §10 against the code

| §     | Requirement                   | State                                                                                                                                                                                                                                                                                                                           |
| ----- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10.1  | Domain separation             | **Met.** Each concept has its own table. A manual order payment settles with no ledger row. A receipt reaches the payment through read-only ports. Refunds are frozen rows.                                                                                                                                                     |
| 10.2  | Durable identity, idempotency | **Partial.** UUIDs and the `payments_order_confirmed_key`, `payments_open_topup_key` and wallet reference keys exist. Idempotency is in PostgreSQL only. No bank or provider reference is captured or unique. Callback replay is not applicable.                                                                                |
| 10.3  | States                        | **Partial.** UNKNOWN exists with no producer. "Under review" is only `customer_signalled_at`. Refunds use their own model.                                                                                                                                                                                                      |
| 10.4  | Atomic settlement             | **Met.** Debit, payment, order and planning commit in one transaction. The provider call happens later, in the provisioner.                                                                                                                                                                                                     |
| 10.5  | Expiry, late success          | **Partial — defect D1.** `sales.payment_window_minutes` is a TTL of 5–60, default 60. A payment the customer said they PAID, or sent a receipt for, still expires. It drops out of the review queue, and a late confirmation is refused. The only remedy is an unlinked `ADMIN_CREDIT`, which `receipt_reviewer` does not hold. |
| 10.6  | Gateway callback              | **Not applicable.** No gateway exists.                                                                                                                                                                                                                                                                                          |
| 10.7  | Reconciliation                | **Absent.** Blocked on a provider (P12).                                                                                                                                                                                                                                                                                        |
| 10.8  | Receipt record                | **Partial.** Customer, tenant, payment and file metadata are recorded. The verifier and decision time are on the payment. The claimed amount, reference and date are not recorded, and there is no normalized reason.                                                                                                           |
| 10.9  | Auto-approval                 | **Safe by absence.** Nothing is auto-approved. Image-only evidence always goes to a person (`OQ-5P-02`).                                                                                                                                                                                                                        |
| 10.10 | Exact amount                  | **Partial.** The order amount must equal the payment amount, but the amount RECEIVED is never captured. Underpaid, overpaid and mismatch have no codes.                                                                                                                                                                         |
| 10.11 | Duplicate receipts            | **Partial.** `(tenant, payment, file_unique_id)` is unique within one payment only.                                                                                                                                                                                                                                             |
| 10.12 | Manual approve/reject         | **Met, except normalized reasons.** Permissioned, tenant-scoped, a conditional UPDATE plus re-read, idempotent, the same service from Web and Telegram, audited, and a rejection is frozen.                                                                                                                                     |
| 10.13 | Refunds                       | **Partial — defect D3.** Append-only, exactly-once, bounded, and reversals run inside the refund. An operator's full refund leaves the order PAID. It sends the customer nothing and emits no event.                                                                                                                            |
| 10.14 | Cross-entity invariants       | **Partial.** See P5 and P10.                                                                                                                                                                                                                                                                                                    |
| 10.15 | Failure tests                 | Wallet, approval and refund races are covered. Callback and reconciliation cases are not applicable. See each decision for the tests added.                                                                                                                                                                                     |
| 10.16 | Surfaces                      | **Partial.** No late-review lane, no mismatch reasons, and no notice of an operator refund or of a partial refund.                                                                                                                                                                                                              |

Two more defects the audit found:

- **D2.** `settleFromWallet` ignores a PENDING manual transfer on the same order. The transfer is left to expire. If the customer had signalled it, their money is stranded. Even if not, they are told `PAYMENT_EXPIRED` about an order they have already paid for.
- **D4.** A `TOPUP_RECEIPT` credit and a `REFUND` credit emit no `WalletEntryRecorded`. Every other ledger write does.
- **D5.** An order whose discounts bring it to zero confirms, and then cannot be paid. The pricing engine clamps each discount to the running amount (`clampDiscount`), so a 100% automatic discount, or a 99% reseller tier followed by a 50% promotion, prices the order at `0`. Confirmation accepts that total. Settlement then writes a payment of `0` and `payments_amount_check` (`amount > 0`) aborts it, so the customer holds an order nothing can settle and is told only that something failed. Reproduced both ways against `0ff0448` plus WP9-B.

## 3. Decisions

The package ships as two pull requests, and each passes the gates on its own.

- **§10-A: money that is stranded or silently kept.** P1–P4.
- **§10-B: the quality of the evidence behind a decision.** P5–P11, and P13 (D5).

**P1 — A transfer the customer vouched for survives its window (D1, §10.5).**

The owner's expiry rule stands: the payment and its order close at the deadline, and
nothing reopens either. Money that did arrive gets its own outcome.

- **The late-review lane.** An EXPIRED `MANUAL_TRANSFER` joins it when it carries a customer signal or at least one receipt. It also needs to have no decision yet.
  - The lane is bounded by construction: it holds only expired transfers with evidence, and every item leaves it through exactly one decision.
- **Decisions.** Exactly two, recorded once, in an append-only `late_transfer_decisions` row keyed by `(tenant, payment)`:
  - **CREDITED**: the payment's exact amount goes to the customer's wallet under the new ledger reason `LATE_TRANSFER`, with reference `<paymentId>:late`. The payment stays EXPIRED and the order stays closed. The customer can spend the credit on the same order or a new one.
  - **DISMISSED**: nothing moves, and a reason is required.
- **Who decides.** `receipts.review`, the authority that could have confirmed the transfer inside its window. A credit to the wallet is the same money reaching the customer by the only door still open.
- **What the customer is told.** At expiry, a signalled transfer gets `PAYMENT_EXPIRED_UNDER_REVIEW` instead of `PAYMENT_EXPIRED`: the window closed, the transfer is still being checked, and anything that arrived will reach the wallet. A credit sends `LATE_TRANSFER_CREDITED`. A dismissal sends `PAYMENT_REJECTED`.
- **Concurrency.** Two reviewers, or a credit racing a dismissal, produce one decision. The decision row's primary key and the ledger reference key each enforce this on their own.

**P2 — A wallet payment and an open transfer cannot both settle an order (D2).**

`settleFromWallet` first cancels the order's PENDING transfers that nobody has vouched
for. It uses the same conditional UPDATE the customer's own cancel uses, so a signal
that commits in between keeps its row. If a signalled transfer is left, the wallet
payment is refused with `ORDER_TRANSFER_UNDER_REVIEW`, and nothing is debited. The
customer said they sent money for this order, and only a reviewer may decide it.

**P3 — An operator's refund has an explicit consequence (D3, §10.13).**

- **Refused while delivery is undecided.** A refund of an order payment is refused (`REFUND_NOT_PERMITTED`, reason `DELIVERY_IN_PROGRESS`) while the order's purchase operation is not terminal. That covers PENDING, IN_PROGRESS and UNRECONCILED. Refunding money for an account the customer may be holding is the ambiguity the money rules forbid. The automatic refund stays the path for a create that failed.
- **The order becomes REFUNDED when the refunds complete the payment.** The transaction whose COMPLETED refunds bring the refunded total to the payment's full amount moves the order `PAID → REFUNDED`. It also writes `OrderRefunded` to the outbox. A partial refund leaves the order PAID.
- **The customer is told every completed refund.** `REFUND_COMPLETED` is a new kind whose subject is the refund row.
- **The service is not touched.** Suspending or terminating it is the operator's existing, explicit service action. The Web Admin states that the service is still active after a full refund, rather than acting on it silently.

**P4 — Every ledger write announces itself (D4).** `TOPUP_RECEIPT` and `REFUND` credits
now emit `WalletEntryRecorded` in their transaction, like every other writer.

**P5 — The amount received is captured, and a mismatch is a decision, not a guess (§10.10).**

- The Web confirmation may carry the amount the operator saw arrive. A different amount or currency is refused with `PAYMENT_AMOUNT_MISMATCH` (`UNDERPAID`, `OVERPAID` or `CURRENCY`), and nothing moves.
- The Telegram confirm button states the exact expected amount, so pressing it attests to that amount.
- An overpayment is never credited silently. The reviewer rejects it with a reason.

**P6 — Rejections carry a normalized reason (§10.8, §10.12, §10.16).**
`PAYMENT_REJECTION_REASONS` is `NOT_RECEIVED`, `AMOUNT_UNDERPAID`, `AMOUNT_OVERPAID`,
`WRONG_BENEFICIARY`, `DUPLICATE_REFERENCE`, `UNREADABLE_EVIDENCE` or `OTHER`. The reason
is required on a rejection and on a late dismissal, and is pinned by a CHECK. The
free-text note stays alongside it.

**P7 — A bank reference credits one payment (§10.2, §10.11, §10.14).** A confirmation
may record the bank's transfer reference in `payments.external_reference`. A partial
unique index on `(tenant_id, external_reference)` refuses the same reference on a second
payment, and so does the service, which answers `PAYMENT_REFERENCE_REUSED`.

**P8 — A receipt seen on another payment is flagged (§10.11).** The review read model
names the other payments that carry the same Telegram `file_unique_id`. This is a flag
for the reviewer, never a refusal: the same screenshot is not proof of the same payment.

**P9 — DB backstops (§10.14).**

- `payments` refuses DELETE.
- One PENDING `MANUAL_TRANSFER` per order becomes a partial unique index. Today a lock enforces it.

**P10 — The Web receipt queue and the late-review lane (§10.16).** Both appear on the
payments page, with the decision actions and the mismatch and duplicate flags.

**P11 — Receipt claims (§10.8).** Not built: the customer-claimed amount, reference and
date. Asking for them adds turns to the Telegram flow, and the reviewer already reads
them from the image. Recorded as `OQ-WP10-02`.

**P13 — An order total never falls below one minor unit (D5).** The engine's discount
clamp becomes `running − 1`, the floor the reseller reduction already uses
(`resellerReductionMinor` is capped at `subtotal − 1`). One rule in one place, so every
caller — catalogue quote, confirmation, commercial actions — prices the same way. A
zero-total order would need a settlement with no payment row, which is a second
settlement path for the rarest case; the floor keeps the one path and costs the customer
one minor unit. The alternative, refusing a zero total at confirmation, leaves a 100%
discount an operator can create and no customer can use.

**P12 — Not built: gateway, callback, reconciliation worker, auto-verifier (§10.6, §10.7, §10.9).**
No provider is named, and CLAUDE.md requires a provider rule to be proven against the
real system before it is declared. Building them against a fake would prove only that
the two agree with each other. What exists already keeps the path open:

- `UNKNOWN` and the `RECONCILE_*` edges;
- the `GATEWAY_CALLBACK` evidence kind;
- the ledger reasons `TOPUP_GATEWAY`, `CHARGEBACK` and `PURCHASE_REVERSAL`.

When a provider is named, the build is:

- a `gateway_events` table unique on `(provider, provider_txn_id)`;
- a verified callback;
- producers for UNKNOWN;
- a reconciliation worker that queries the provider;
- the §10.15 callback tests run against a disposable real sandbox.

Recorded as `OQ-WP10-01`.
