# Payment package — File 02 design

The owner's _Payment System Specification — File 02_ (execution addendum) is the product
authority for this package. It overrides File 01 where the two differ, and it overrides the
earlier WP10 decisions in `docs/wp10-payments-audit.md` wherever they disagree. This
document records the audit against File 02 and the design. It was written before the
production code, as File 02 §3 requires.

**File 01 was not supplied.** File 02 refers to it in §10 (the Telegram receipt message),
§13 (compensation) and for the gateway list. This design uses File 02 and the merged code
only, and guesses nothing about File 01. Where File 01 would decide a point, this document
says so. See `OQ-WP10-01`.

Starting point: `main` at `e2e6fc0`, where the reseller package (PR #69) is merged and main
is healthy, so File 02 §1 is satisfied. This package is one pull request, as File 02 §3.11
requires. The unmerged §10-A work is reshaped to fit File 02 before that PR is opened.

## 1. Audit against File 02

| §     | Requirement                                              | State at `e2e6fc0` + unmerged §10-A                                                                                                                                                                                                                                                                                                          |
| ----- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4     | No payment fee                                           | **Met.** There are no fee columns, settings or UI. `RESELLER_MEMBERSHIP_FEE` is a ledger reason with no writer, and it stays that way.                                                                                                                                                                                                       |
| 5–8   | External gateway: one active, grace, callback, mismatch  | **Absent, and cannot be built truthfully yet.** See §3.                                                                                                                                                                                                                                                                                      |
| 9     | A submitted receipt never expires                        | **Conflicts.** `expireDue` expires every PENDING payment at `expires_at`, receipts included. The §10-A late-review lane is built on that expiry. There are two hidden gaps: the username-hold sweep deletes the hold of an order still awaiting review, and `withdrawPending` lets the customer withdraw a transfer they sent a receipt for. |
| 10    | Review in Telegram only; the Web Admin is read-only      | **Conflicts.** `main` already lets the Web Admin approve and reject card-to-card payments (`POST payments/:id/confirm`, `/reject`). §10-A added credit and dismiss. Telegram sends the receipt media and the action message as separate messages.                                                                                            |
| 11    | Approve, reject and manual credit are mutually exclusive | **Partial.** Approve and reject exclude each other through `WHERE state = 'PENDING'` and the terminal freeze trigger. Manual credit does not exist.                                                                                                                                                                                          |
| 12    | Manual wallet credit from a receipt                      | **Absent.** The §10-A late credit is the nearest thing, but it applies only to expired payments and uses a fixed amount.                                                                                                                                                                                                                     |
| 13    | Compensation                                             | **Met.** `RefundService.refundUndeliverable` credits the principal once. It is called from settlement and from the provisioner on a definitive failure, and sends `ORDER_REFUNDED_TO_WALLET`. §10-A P3 adds consequences only, with no new workflow.                                                                                         |
| 14    | Zero total                                               | **Defect D5.** A discount stack can price an order at `0`. The order confirms, and then settlement aborts on `payments_amount_check`.                                                                                                                                                                                                        |
| 15/16 | Renewal cashback                                         | **Engine met.** A `cashback_rules` rule may apply to `RENEW`. The promise is frozen at confirmation and earned only when the purchase operation `SUCCEEDED`. No test covers a renewal.                                                                                                                                                       |
| 17/18 | Top-up gift per gateway                                  | **Absent.** There is no percentage and no snapshot, the `CASHBACK_TOPUP` reason has no writer, and there is no gift notification.                                                                                                                                                                                                            |
| 20    | Referral                                                 | **Met.** Commission is promised at confirmation and earned at delivery, reversed in the refund, and top-ups earn nothing.                                                                                                                                                                                                                    |
| 21    | Web Admin diagnostics                                    | **Partial.** The list lacks the payment id, Telegram id and username, gateway, external reference and updated-at columns. There is no compensation list.                                                                                                                                                                                     |

## 2. Design

### D1 — A submitted receipt keeps its payment open (§9, invariant 16)

- **Expiry sweep.** `expireDue` skips any PENDING `MANUAL_TRANSFER` that has at least one row in `payment_receipts`. The predicate sits in both the candidate SELECT and the conditional UPDATE. `ReceiptService.submit` already inserts under the payment's row lock, so a receipt and the sweep are serialised.
- **The order.** It already stays `AWAITING_PAYMENT`, because `orders.expireDue` refuses an order with a PENDING payment. Approval passes `OPERATOR_MAY_CONFIRM_LATE`, which bypasses the order deadline. A capacity slot that lapsed meanwhile is either re-taken at settlement or refunded automatically (§13), so no change is needed there.
- **The username hold.** `sweepExpiredHolds` no longer deletes an unfunded hold whose order is still `AWAITING_PAYMENT`. Without this, a late approval would silently fall back to a random `nx…` name, even on a CUSTOM-only panel. The order-expiry path still releases such a hold when the order actually closes.
- **Withdrawal.** `withdrawPending` refuses a transfer that carries a receipt. The refusal code is `ORDER_TRANSFER_UNDER_REVIEW`. Under File 02, a submitted receipt leaves review only through an admin's decision.
- **A signal with no receipt.** File 02 is silent on this. It keeps today's behaviour: it expires at the payment window, and the customer is told `PAYMENT_EXPIRED`.
- **The late-review lane is removed.** That covers §10-A P1: the `LateTransferService`, the `late_transfer_decisions` table, the `LATE_TRANSFER` reason, the `PAYMENT_EXPIRED_UNDER_REVIEW` and `LATE_TRANSFER_CREDITED` kinds, and its Web and Telegram surfaces. None of it is merged, so it is removed rather than migrated. The tests that pin "a receipted transfer expires" are inverted.

### D2 — Three mutually exclusive dispositions of a receipt (§11, §12, invariants 7 and 8)

**The dispositions.**

- **Approve**: the existing `confirmManualTransfer`.
- **Reject**: the existing `rejectManualTransfer`.
- **Credit to wallet**: new, via `ReceiptDispositionService.creditToWallet`. The admin enters the exact amount.

**How credit to wallet is recorded.** One transaction does all of the following:

- takes the payment row `FOR UPDATE`;
- checks the payment is a PENDING `MANUAL_TRANSFER` with at least one receipt;
- moves it `PENDING → FAILED` with a conditional UPDATE, filling the existing resolution columns (`resolved_by_admin_id`, `resolution_note`);
- appends the ledger entry `RECEIPT_CREDIT` for the entered amount, in the payment's currency, carrying `payment_id` and `actor_admin_id`. Its reference is `<paymentId>:receipt-credit`. A partial unique index allows one such entry per payment, and a CHECK requires `payment_id` on it;
- inserts a `receipt_credits` row, keyed by `(tenant, payment)`. The row holds the amount, the entry id, the admin and a note. It is append-only, and an insert trigger refuses any row whose payment is not a FAILED `MANUAL_TRANSFER` or whose entry is not that payment's `RECEIPT_CREDIT`;
- writes `WalletEntryRecorded` and an audit row, and sends the customer the `RECEIPT_CREDITED_TO_WALLET` kind.

**Why the three cannot both happen.** All three race on the same conditional UPDATE, which only succeeds `FROM PENDING`. That is invariant 7. A loser is answered `PAYMENT_ALREADY_RESOLVED` and has no side effect.

**Invariant 8.** Crediting at most once is held twice over: by the table's primary key and by the unique index on the ledger entry.

**Idempotency.** The request hash includes the amount, so a replay returns the first result, and a different amount under the same key is refused.

**Authority.** It requires `receipts.review` **and** `users.wallet.credit`. An arbitrary amount into a wallet is exactly what `users.wallet.credit` guards. So an installation that separates a receipt reviewer from finance keeps that separation, and the reviewer can still approve or reject. It is deny by default.

**The order.** A credited payment leaves its order in `AWAITING_PAYMENT`, so the customer may pay it from the wallet or let it expire. It is not settled: a manual credit is not a payment of the order.

**Reused from §10-A.** The shape of `late_transfer_decisions`, its guard trigger and its race tests.

**Block User.** File 02 names "Block User" as a separate customer action. It already exists in the customer section and is not a disposition.

### D3 — The review surface is Telegram only (§10, §21)

**The Web Admin becomes read-only for card-to-card.**

- These are removed: `POST payments/:id/confirm` and `POST payments/:id/reject`, with their UI, their contract route entries and their tests, and the §10-A credit and dismiss routes.
- Every read stays: the list, the detail page, receipt metadata and the refund history. The existing receipt-image read also stays; it is not a mutation, and §10 says only that it "does not need to be" shown.
- Operator refunds are not receipt review and are unchanged.

**The Telegram admin receipt item becomes one message.** It is a single `sendPhoto` or `sendDocument` of the first receipt, carrying:

- a caption rendered from a template: reference, amount, customer, order, and the customer's own caption when there is one;
- inline buttons: approve, reject, and credit to wallet.

Further receipts follow as media without buttons.

**The customer's note.** It is the Telegram caption the customer attached to the receipt. It is stored on the new nullable `payment_receipts.caption` column, trimmed and bounded to 1024 characters. It is rendered only into the admin caption, never logged.

**The credit-to-wallet flow in Telegram.**

1. The button opens an amount capture: an `admin_amount_captures` row with a short expiry, scoped to that admin and that payment. This follows the `receipt_captures` idiom, and it answers INCIDENT-FIN-001, because only the capturing admin's next message is read, and only while the capture is open.
2. The amount is parsed from Latin, Persian or Arabic digits.
3. An explicit confirm button states the amount before anything moves.
4. The confirm carries the capture id and calls D2 with an idempotency key derived from it.

A push notification to admins when a receipt arrives is **not** added. The review queue stays pull-based. File 01 may say otherwise; see `OQ-WP10-01`.

### D4 — Zero total (§14, D5)

The pricing engine floors every commercial order's total at one minor unit: `clampDiscount` caps a discount at `running − 1`, the same floor the reseller reduction already uses. This is one rule in one place, so the quote, confirmation and commercial actions all agree. There is no zero-total payment flow, and trials are untouched: they are GRANT orders outside pricing. The pricing test that pins a total of `0` is updated, and the two reproductions of D5 become regressions that confirm **and** settle.

### D5 — The top-up gift (§17, §18, invariants 10, 11 and 13)

**Configuration.** `payment_gateways.topup_cashback_percent` is an integer from 0 to 100, default 0. It is edited in the existing Web Admin gateway section. It applies per gateway row, so `MANUAL_TRANSFER` (card-to-card top-up) is configurable today, and any future external gateway inherits the column.

**Snapshot.** When a top-up payment is created, the payment records `gateway_provider` and `topup_cashback_percent`, snapshotted from the gateway it was offered through. The payments guard trigger freezes both columns, so a later change by an admin cannot alter a created payment's promise. Order payments record the provider and a null percentage.

**Earning.** In the transaction that credits the principal (`TOPUP_RECEIPT`), and only when that transaction inserted it:

- the gift is `floor(principal × percent / 100)`, and it is written only when above zero;
- it is a separate `CASHBACK_TOPUP` entry, carrying `payment_id`, with reference `<paymentId>:topup-cashback`;
- a partial unique index allows one such entry per payment, so it is once-only whether it comes from a replay or a race;
- the customer is sent `WALLET_TOPUP_GIFT_CREDITED`, subject the payment, which is once-only through `customer_notifications_subject_key`. A 0% gift sends no gift message.

**No recursion.** The gift's basis is the payment's principal, never a ledger entry, so cashback cannot earn cashback.

**What gets no gift.** A manual receipt credit (D2) is not a successful top-up, so it earns no gift.

### D6 — Renewal cashback (§16, invariant 12)

The WP8 engine already does what §16 asks. This package adds the tests that were missing:

- a `RENEW` order earns its cashback only after the RENEW operation `SUCCEEDED`, as a separate entry;
- the promise goes void when the operation `FAILED` and the order is refunded;
- nothing is earned while the operation is `UNKNOWN`;
- a replay of the earning sweep earns nothing more.

### D7 — Web Admin diagnostics (§21)

**Payment list columns.** The list adds the payment id, the customer's Telegram id and username, the gateway, the external reference and the updated-at time. The API summary gains `gatewayProvider`, `externalReference`, and the customer's `telegramUserId` and `username`. The detail page stays current-state, with no timeline.

**The compensation list.** A new read route lists every refund with reason `UNDELIVERABLE` and channel `WALLET_CREDIT`: payment, order, customer, principal, the amount credited, the reason, the state and the time. It uses keyset paging and requires `payments.view`.

### D8 — Kept from §10-A

Everything File 02 is consistent with stays:

- **P2.** A wallet payment withdraws the order's unsignalled pending transfers and refuses when a signalled one remains.
- **P3.** An operator refund is refused while delivery is undecided. A full refund moves the order to REFUNDED and sends `REFUND_COMPLETED`. No new partial-refund UI is added.
- **P4.** Every ledger write emits `WalletEntryRecorded`.

## 3. Deferred: the external gateway (§5–§8, invariants 3–6, 15, 17 and 18)

File 02 requires, for automated external gateways:

- one active gateway at a time;
- a callback that is authenticated and exactly-once;
- reconciliation that stops ten minutes after `expires_at`;
- an automatic amount-mismatch outcome;
- the race tests that go with each of these.

**No external provider exists** in this codebase: `PAYMENT_GATEWAY_PROVIDERS = ['MANUAL_TRANSFER']`. **None is named** in File 02. Telegram Stars appears only as an example, and File 01 was not supplied.

**Why it is not built here.** `CLAUDE.md` records four provider defects that shipped behind green suites, because a fake and an adapter written by the same hands only agree with each other. It rules that a provider's behaviour is proven against the real system and declared only after that. The Stars example also carries an FX question: Stars are not Toman, and the owner has decided nothing about conversion.

**The honest choice.** Building a callback route, an event table and a reconciler against a provider nobody named would be a placeholder abstraction proven only by a fake. So this package does not build them, and says so rather than shipping machinery nothing can reach.

**What already keeps the path open:**

- the `UNKNOWN` state and the `LOSE_TRACK` / `RECONCILE_*` edges;
- the `GATEWAY_CALLBACK` and `RECONCILIATION` evidence kinds;
- `payments.expires_at` and `payments_unknown_idx`;
- the per-gateway `topup_cashback_percent` from D5, which a future gateway inherits unchanged.

**The build, once a provider is named** (recorded as `OQ-WP10-01`):

1. An `external` flag on the gateway descriptor.
2. A partial unique index `(tenant_id) WHERE status = 'ACTIVE' AND provider <> 'MANUAL_TRANSFER'`. Activation locks the tenant's external rows and deactivates any other active one.
3. A `gateway_events` table, unique on `(provider, provider_txn_id)`.
4. An authenticated callback that finalises through the one conditional `confirm` edge, verifying server to server first.
5. A reconciler over `PENDING`/`UNKNOWN` gateway payments with `now() < expires_at + 10 min`, claiming each by conditional UPDATE.
6. Mismatch handled as `FAILED`, with resolution `AMOUNT_MISMATCH` and no admin route.
7. The §24 race tests, run against the provider's real sandbox.

## 4. Out of scope, per File 02 §22

Explicitly not built:

- payment fees of any kind, including fixed and seller-side;
- partial-refund UI or a partial-refund workflow;
- direct gateway refunds;
- two-admin approval;
- automatic duplicate-receipt detection (the §10-B P8 is dropped);
- fraud detection;
- a payment timeline;
- a Telegram "My Payments" screen;
- a generic zero-total payment flow;
- card-to-card decisions from the Web Admin;
- heavy reconciliation;
- manual resolution of a gateway amount mismatch.

**Dropped from the earlier §10-B plan:** P5 (a Web confirmation with the received amount), P6 (normalised rejection reasons), P7 (a unique bank reference), P8, P9 and P11.

## 5. Tests the package adds

- **§9 receipt expiry:**
  - a receipted transfer and its order survive the sweep;
  - the username hold survives, and a late approval provisions under the chosen name;
  - withdrawal is refused;
  - a signal-only transfer still expires.
- **§11 dispositions:** approve against approve, approve against reject, approve against credit, reject against credit, and credit against credit. Each race is held inside the transaction and shown waiting in `pg_stat_activity`. Exactly one outcome commits and the loser has no side effect.
- **§12 manual credit:** the exact amount is credited, and the payment, the admin, idempotency, the permissions, the database guards and tenant isolation are all covered.
- **§14 zero total:** the floor holds, and both reproductions confirm and settle.
- **§16 renewal cashback:** earned after `SUCCEEDED`, void on `FAILED`, nothing while `UNKNOWN`.
- **§17 top-up gift:**
  - gift at 10%, none at 0%;
  - a separate entry and a separate notification;
  - a replay or a racing confirmation produces one gift;
  - the snapshot is frozen against a later change to the percentage;
  - a manual receipt credit earns no gift.
- **§21 read models:** the compensation list and the new columns.
- **Surfaces:**
  - the Web Admin has no card-to-card mutation left, checked by route registration and the web tests;
  - Telegram shows the review as a single message, and the amount capture and its confirmation work.
- **Falsification:** every new rule is reverted alone and its named test watched to fail, recorded in `docs/wp10-falsification.md`.
