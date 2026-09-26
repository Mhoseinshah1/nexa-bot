# WP18 — Gateway customer fee and the shared financial log: audit

Written before any code. It separates three things:

- the **owner's decisions** (the WP18 brief, §1);
- the **existing rules** those decisions must live inside;
- the **technical choices** this package makes where the brief is silent.

Each technical choice is the conservative one, and the reason is given.

## 1. What exists today (read from the code at `ed4afec`)

### 1.1 The gateway money path

| Step                   | Where                                                                          | What it does with an amount                                                                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Order attempt          | `PaymentService.requestGatewayPayment`                                         | Re-reads `order.totals.total` in the transaction. That figure is the final total after discounts.                                                                                                  |
| Top-up attempt         | `PaymentService.requestGatewayTopup`                                           | Uses `typedTopupAmount(intent.amount)`, and snapshots the route's `topup_cashback_percent`.                                                                                                        |
| Route check            | `gatewayRouteFor` → `routesFor(scope, customer, purpose, amount)`              | Tests the route's min/max bounds against that amount.                                                                                                                                              |
| Shared body            | `openGatewayAttempt`                                                           | Sets `sentAmount = adapter.providerAmountOf(amount)`, refusing `AMOUNT_NOT_REPRESENTABLE` when there is none. Writes `payments.amount = amount`, then `gateway_invoices.sent_amount = sentAmount`. |
| Open-attempt reuse     | `findOpenAttempt`                                                              | Matches on `payments.amount` + currency + provider + customer + order.                                                                                                                             |
| Provider create        | `GatewayPaymentService.processCreation`                                        | Sends `invoice.sentAmount`.                                                                                                                                                                        |
| Approval               | `confirmGatewayPayment`                                                        | An order goes to `confirmAndSettle`; a top-up goes to `confirmAndCredit`. No provider amount reaches either.                                                                                       |
| Settlement guard       | `domain/settlement.ts:77`                                                      | Refuses when `payment.amount ≠ order.totals.total`.                                                                                                                                                |
| Top-up credit          | `confirmAndCredit`                                                             | Writes `TOPUP_GATEWAY` for `payments.amount`, plus a `CASHBACK_TOPUP` gift of `floor(payments.amount × percent / 100)`.                                                                            |
| Refund ceiling         | `RefundService` (`refundableMinor`, `refundFitsWithin`, `refundUndeliverable`) | Uses `payments.amount`.                                                                                                                                                                            |
| Proportional reversals | `CashbackService`, `ReferralCommissionService`                                 | Use `payments.amount` as the denominator.                                                                                                                                                          |
| Reports                | `drizzle-reporting.repository.ts`                                              | Revenue reads `orders.total_amount`. Payment groups sum `payments.amount`.                                                                                                                         |

**Finding A1.** At least nine code paths treat `payments.amount` as the principal: settlement, the top-up credit, the top-up gift, the refund ceiling (three sites), the two proportional reversals, and the payment-group report. Folding the fee into `payments.amount` would, for example:

- fail every gateway order at the settlement guard;
- credit the fee to the wallet;
- make the fee refundable.

So the brief's "keep the existing internal payment amount as principal" is also the only safe reading of the code. **`payments.amount` stays the principal.** The fee is a snapshot beside it.

### 1.2 Operator log routing

- **Destination settings:** `ops.notifications.telegram_chat_id` (empty means none) and `ops.notifications.telegram_topic_id` (null means the group itself). Both sit under the `ops_notifications` flag, which is off by default.
- **Topics:** there is exactly one topic id and no per-category topic.
- **The operator lane** (`notifications` + `NotificationDispatcher`) is the one durable Telegram carrier for operator messages. It already provides:
  - a snapshotted destination;
  - a dedupe key;
  - bounded attempts;
  - honouring of `retry_after`;
  - a render outside any transaction.
- **Outbox consumers** run in the relay's transaction and may do database work only (`EventConsumer`). `ReceiptReviewPushConsumer` is the pattern: it consumes an event and writes a lane row, and the lane sends later.

### 1.3 Which financial transitions already emit an event

| Transition                                                    | Event today                                                                                             |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Order payment confirmed (wallet, manual, gateway)             | `PaymentConfirmed` (+ `OrderSettled`)                                                                   |
| Top-up confirmed (manual, gateway)                            | `PaymentConfirmed` (+ `WalletEntryRecorded` ×1–2)                                                       |
| Manual transfer rejected                                      | none (audit + customer notice)                                                                          |
| Gateway attempt failed (inquiry said unsuccessful)            | none (audit + customer notice)                                                                          |
| Gateway late completion                                       | none (audit + WARN ops event, below the default ERROR threshold)                                        |
| Refund completed (operator or automatic)                      | only `WalletEntryRecorded` when a wallet credit is written; `OrderRefunded` only on a full order refund |
| Refund failed (operator) / superseded by the automatic refund | none                                                                                                    |

**Finding A2.** Five of the seven transitions the brief names have no event, so there is nothing a consumer could hear. Adding events is a contract change, and it gets its own commit.

## 2. Owner decisions (brief §1) and how each is met

| #   | Decision                                                                                                                 | Implementation                                                                                                                                                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| O1  | The fee applies to external `GATEWAY` routes only.                                                                       | Only a route whose descriptor `settlesVia === 'GATEWAY'` may carry a non-zero fee. A non-zero fee on `MANUAL_TRANSFER` is refused `VALIDATION`. The wallet and admin credit/debit paths never read the fee.                                                           |
| O2  | Per tenant and route; 0 = disabled; up to 2 decimals; stored as integer basis points; 0.00–100.00 %.                     | `payment_gateways.customer_fee_basis_points integer NOT NULL DEFAULT 0 CHECK 0..10000`. The HTTP body carries an integer (`customerFeeBasisPoints`). The Web Admin turns the typed percent into basis points through one contracts parser, `parsePercentBasisPoints`. |
| O3  | Snapshotted at attempt creation.                                                                                         | `payments.customer_fee_basis_points`, `customer_fee_amount` and `payable_amount` are written at insert and frozen in every state by the payments guard trigger.                                                                                                       |
| O4  | fee = principal × rate, integer arithmetic, half-up to the minor unit; payable = principal + fee.                        | `gatewayCustomerFeeMinor(principalMinor, bps) = (principalMinor × bps + 5000) / 10000` on `bigint`, in contracts. There is no float anywhere.                                                                                                                         |
| O5  | The invoice create amount is the payable.                                                                                | `sent_amount = adapter.providerAmountOf(payable)`.                                                                                                                                                                                                                    |
| O6  | Provider amounts are diagnostic; `completed && paid` inquiry stays authoritative.                                        | Unchanged. Nothing new compares provider amounts to anything. The log labels the provider's final amount "diagnostic".                                                                                                                                                |
| O7  | The wallet receives the principal only; the gift is based on the principal.                                              | Unchanged, because `payments.amount` is the principal (A1). A test pins it.                                                                                                                                                                                           |
| O8  | The fee never inflates revenue, order value, wallet, cashback, referral, reseller, discount basis or the refund ceiling. | All of these read `payments.amount` or `orders.total_amount` (A1), and neither changes. Tests pin the refund ceiling, wallet credit, gift and order total.                                                                                                            |
| O9  | The fee is non-refundable; no fake gateway refund API.                                                                   | The refund ceiling is `payments.amount`. No adapter method is added.                                                                                                                                                                                                  |
| O10 | Customer display (gateway only): مبلغ سفارش / مبلغ شارژ, کارمزد درگاه, مبلغ قابل پرداخت.                                 | Two new templates, one for an order and one for a top-up, are used when the snapshotted fee is above zero. With no fee, the existing single-amount invoice is still true (payable = principal) and is kept. Non-gateway methods never see a fee.                      |
| O11 | One provider-neutral financial log to the log group's payment topic.                                                     | See §3.                                                                                                                                                                                                                                                               |
| O12 | The smallest tenant-scoped topic setting; no second bot; no hardcoded ids.                                               | New setting `ops.notifications.payments_topic_id`, a positive int or null, under the same flag. Null falls back to `ops.notifications.telegram_topic_id`. The sender is the lane's existing transport (the tenant's active bot).                                      |
| O13 | Log failure never rolls back money.                                                                                      | The business transaction writes a domain event to the outbox. A consumer turns it into a lane row later, and the dispatcher sends it later still. None of the three can reach the financial transaction.                                                              |
| O14 | Never log secrets, tokens, subscription URLs or raw payloads.                                                            | Event payloads carry ids and closed-vocabulary codes. The consumer copies named fields only: ids, amounts, a username, a display name, a provider invoice id and a provider amount. There is no raw payload, invoice URL or `pay_url`.                                |

## 3. The financial log pipeline

```
business tx ──► outbox (PaymentConfirmed | PaymentFailed | PaymentLateCompletionObserved
                        | RefundCompleted | RefundFailed)
relay tx    ──► FinancialLogConsumer  (DB reads only)
                  └─► NotificationService.queue(kind FINANCIAL_EVENT, dedupe fin:<eventId>,
                                                destination = financial destination)
dispatcher  ──► Telegram sendMessage(chat, message_thread_id = payments topic)
```

### 3.1 New events (contract commit)

| Event                                                                                                                                       | Emitted by                                                                     | Aggregate                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------- |
| `PaymentFailed` `{customerId, orderId, method, cause}`, cause ∈ `REJECTED`, `GATEWAY_FAILED`                                                | `rejectManualTransfer`, `failGatewayPayment`                                   | Payment                                      |
| `PaymentLateCompletionObserved` `{customerId, orderId, provider}`                                                                           | `GatewayPaymentService.lateCompletion`, only when it newly records the outcome | Payment                                      |
| `RefundCompleted` `{refundId, customerId, paymentId, orderId, amountMinor, currency, channel}`                                              | `RefundService.completed` (operator) and `refundUndeliverable` (automatic)     | Payment (the refund is named in the payload) |
| `RefundFailed` `{refundId, customerId, paymentId, orderId, amountMinor, currency, channel, cause}`, cause ∈ `OPERATOR_FAILED`, `SUPERSEDED` | `RefundService.fail` and the supersede loop                                    | Payment (the refund is named in the payload) |

### 3.2 What is deliberately not logged

These are not "meaningful final financial state changes" for an operator: nothing moved, and nobody decided.

- Expiry of an unpaid attempt, and a customer withdrawing their own payment.
- Inquiry polling and a webhook hint.
- A lost create answer, whose outcome is UNKNOWN. That is still the ops log's `payments.gateway_*` machinery.

A rejection by an operator and an unsuccessful gateway verdict are logged, because both are final.

### 3.3 Consumer rules

- **Database reads only**, in the relay transaction. It reads the payment, the customer (Telegram id, username, display name) and, for a `GATEWAY` payment, its invoice (provider invoice id, provider final amount).
- **One kind**, `FINANCIAL_EVENT` (a new `NOTIFICATION_KINDS` member; the CHECK widens in the migration). Templates are under `ops.financial.*`, PLAIN_TEXT. Money goes through the MONEY placeholder, so the one formatter owns the unit.
- **Dedupe key `fin:<outbox event id>`.** A redelivered event whose `processed_messages` claim was lost still writes nothing new.
- **Destination** comes from `NotificationService.financialDestination`: null when the flag is off or the chat is empty, and the event is then simply not logged. The DB stays the source of truth, and the consumer never throws for "not configured".
- **A consumer error** rolls back only the consumer's SAVEPOINT (relay rule). The financial row committed long before.

### 3.4 Fields per log (brief §1.3)

- **Order paid:** method, route, the customer's Telegram id, username and display name, payment reference, payment id and order id. Then principal, fee and payable; the provider invoice id; the provider final amount (labelled diagnostic); the evidence kind (`GATEWAY_INQUIRY`, `OPERATOR_REVIEW`, `WALLET_BALANCE`); and the time.
- **Top-up credited:** the same, but the amount lines are principal credited, fee and total paid. The gift is the `CASHBACK_TOPUP` amount actually written, read from the ledger rather than recomputed.
- **Failure:** cause, method, customer, reference, principal, fee, payable and time.
- **Late completion:** provider, customer, reference, principal, fee, payable, provider invoice id, provider final amount (diagnostic) and time.
- **Refund completed/failed:** customer, refund id, payment reference, order id, amount, channel, cause (for failed) and time.

## 4. Technical choices (the brief is silent)

- **T1 — Route bounds test the principal.** Min/max are about what Nexa sells, and the principal is the figure the operator set them against. Changing them to the payable would move every existing bound by the fee.
- **T2 — Snapshot columns are nullable, and the CHECK accepts either all-null or all-set.**
  - All-null is a pre-WP18 row, read as fee 0.
  - All-set requires `method = 'GATEWAY'`, `0 ≤ bps ≤ 10000`, `fee ≥ 0` and `payable = amount + fee`.
  - The migration adds nullable columns, so a process still on the previous release (a rolling update) inserts all-null and passes. `migration-compatibility.test.ts` requires exactly this.
- **T3 — `findOpenAttempt` keeps matching on the principal.** A reused open attempt keeps the fee it was created with, which is what "later config changes do not mutate existing attempts" means. The customer is shown that attempt's own snapshot.
- **T4 — IRR payable must still be a whole Toman.** The fee rounds half-up to the payment currency's minor unit, as the brief says. For an IRR installation that can give a payable that is not a multiple of 10 rial. `providerAmountOf` then refuses it `AMOUNT_NOT_REPRESENTABLE`, the existing rule: never invoice a figure the customer was not quoted. Recorded as `OQ-WP18-01`. It does not arise for IRT, the currency TonPays documents.
- **T5 — The fee templates appear only when fee > 0.** With the fee at 0 the three lines would read "fee 0" under a payable equal to the principal, which the existing template already says truthfully.
- **T6 — Payment detail (HTTP/Web) carries `customerFee` `{basisPoints, fee, payable}` or null.** It is shown as its own lines on the payment page and never added to any total. The brief allows reports to show the fee separately, but no report sums it in this package, to keep revenue untouched.

## 5. Open questions added

- **`OQ-WP18-01`** — an IRR installation whose fee makes the payable a non-whole Toman gets `AMOUNT_NOT_REPRESENTABLE` for that attempt. The choices would be to round the fee to the Toman or to refuse the rate at configuration time. Both are product decisions this package does not take.
