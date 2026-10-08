# Fee consistency and FX provenance (roadmap E4, E5)

Branch `roadmap/payments-financial-hardening`. Audit-first: WP18 (`docs/wp18-gateway-fee-financial-log-audit.md`)
built the customer fee and Package FX (`docs/fx-audit.md`) the central rate. Both were
already correct on the money; what was missing was ONE place every surface reads them from.
**No accounting semantics changed.** No schema change, no migration.

## 1. E4 — one source of truth for a payment's money

### 1.1 Audit

| Figure                      | Where it lived                                                                                      | Finding                                                                                     |
| --------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Customer amount (principal) | `payments.amount`; detail `amount`                                                                  | Correct; the revenue basis, the top-up credit and the refund bound (WP18 A1).               |
| Fee (surcharge)             | `payments.customer_fee_*` snapshot; detail `customerFee`                                            | Correct; frozen by the guard trigger; never revenue, credit or refundable.                  |
| What the customer paid      | `payable_amount` snapshot, or the principal                                                         | Correct in the report (`coalesce(payable_amount, amount)`); the detail had no single field. |
| Merchant fee / merchant net | **Not recorded anywhere.** Provider final/credit amounts are diagnostic metadata                    | Must not be invented — now said explicitly (`NOT_RECORDED`).                                |
| Wallet credit               | Ledger (`TOPUP_*`, `RECEIPT_CREDIT`); detail `receiptCredit`                                        | Correct; the detail had no single field for "what this payment put on the wallet".          |
| Refundable amount           | `RefundService` (`payments.amount`); ledger `paidMinor`, `refundableMinor`, `refusalReason`         | Correct. The ledger is the one answer; the breakdown carries none (F1).                     |
| Report                      | `financialCash`: Σ amount, Σ customer_fee_amount, Σ coalesce(payable, amount), CONFIRMED non-wallet | Correct.                                                                                    |
| Frontend arithmetic         | `formatBasisPointsPercent` (display of a stored rate) and `parsePercentBasisPoints` (input)         | No recomputation of a percentage or a sum on any payment page.                              |

### 1.2 What was added

`packages/contracts/src/payment-amounts.ts` — `paymentAmountsOf`, one pure `bigint` function
from the payment's own snapshot to: principal, customer fee (+ its basis points), payable
(what the customer was ASKED to pay, frozen, in every state), received (confirmed money from
outside), wallet credit, wallet debit, and merchant net `null` with `NOT_RECORDED`. The server
sends it as `paymentDetailSchema.amounts`; the Web Admin's money card renders it and computes
nothing, and it is the ONE card that shows the gateway fee (the rate, the fee, the payable).

**No refund figure.** How much of a payment may still be refunded, and whether at all, is the
refund ledger's answer (`RefundService.ledgerFor`: `refundable`, `refusalReason`,
`refundableMinor`) — the same decision the write path refuses with. An earlier draft carried a
principal-based "refund ceiling" here too; it was a second answer that said "250 000" for a
gateway payment the ledger refuses outright, and was removed (review of PR #247, F1).

### 1.3 Tests

- `tests/unit/payment-amounts.test.ts` — fee (surcharge) never credited; payable = principal
  - fee; received only when confirmed and external; wallet settlement is a debit; partial and
    late (never confirmed) receive and credit nothing; a receipt credit is the wallet credit of
    a FAILED transfer; no refund figure; merchant net never invented; invariants over every
    state × method × fee rate × kind × principal.
- `tests/integration/financial-reports.test.ts` (E4 case) — over HTTP, every tenant payment
  the period touches, in any state, is fetched and its breakdown summed. Per currency the
  report's **principal received, customer fees, customer paid, wallet top-ups, receipt credits
  and wallet spending** are exactly those sums (customer paid = Σ `received`; top-ups = Σ
  `walletCredit` of confirmed top-ups; receipt credits = Σ `walletCredit` of credited FAILED
  transfers; spending = Σ `walletDebit`). The fixture holds a 2 % fee sale, full and partial
  refunds, two wallet purchases, a receipt credit (with its `receipt_credits` row), a USD
  top-up and an EXPIRED top-up attempt with a LATE_COMPLETION (received and credited nothing).
  **What this does NOT claim:** the wallet section's other movements (refunds to the wallet,
  cashback, commissions, gifts, transfers, administrative entries) are ledger facts with no
  payment breakdown behind them, and are asserted by the statement's own cases, not here.
- `tests/integration/payment-money-truth.test.ts` — a wallet settlement's debit and zero
  received; a confirmed top-up's credit and a reviewer's receipt credit as the controller read
  them; read equals write over every `REFUND_REFUSAL_REASONS` member (exactly 409
  `REFUND_NOT_PERMITTED`, `details.reason` = the ledger's reason, nothing written), including
  CURRENCY_MISMATCH (refunds in two currencies) and DELIVERY_IN_PROGRESS (an UNKNOWN
  purchase operation).
- `tests/web/payment-money.test.tsx` — the card shows the server's figures even when they do
  not add up, the sum the browser could have computed is nowhere on the page, the payable is
  labelled «مبلغ قابل پرداخت», no ceiling is drawn, and the rate is grouped (`103,500`).
- `tests/web/payments.test.tsx` (WP18 case) — the rate, the fee and the payable appear once
  each: one card shows the fee.

## 2. E5 — FX provenance

### 2.1 Audit

| Brief item                                 | Finding                                                                                                                                                                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rate provenance explicit and central       | The snapshot was complete (policy, quote id, source, book and fetch time, state, policy version, ratio, effective rate) but read differently per policy; a fixed rate showed as a bare number. Gap: one shape for every policy. |
| Fail closed with no authoritative rate     | Already: a central-rate attempt with no usable quote is refused `FX_UNAVAILABLE` (`docs/fx-audit.md` §3.8, M1/M4); the Telegram reply is `bot.payment.fx_unavailable`; the FX card shows `UNAVAILABLE` and why.                 |
| Historical settled rates and evidence kept | Already: the snapshot is written once and frozen by `nexa_gateway_invoices_snapshot_guard`; a replay hands back the attempt with its own snapshot.                                                                              |

### 2.2 What was added

`gatewayRateProvenanceOf` (`gateway-invoices.ts`): the attempt's own snapshot read into one
shape — authority `NONE` (same unit), `OPERATOR` (the frozen fixed rate) or `MARKET` (the
central quote with its evidence) — sent as `gatewayInvoiceView.rateProvenance` and rendered
as one card. A central-rate attempt whose snapshot is missing reports no rate rather than
borrowing the fixed one.

### 2.3 Tests

- `tests/unit/rate-provenance.test.ts` — each authority; the market evidence whole; the
  fail-closed reading.
- `tests/integration/payment-money-truth.test.ts` — over HTTP, the provenance of a central-rate
  attempt, its quote time and fetch time each from its own column; a fixed-rate (Stars)
  attempt's operator rate; a newer, very different central quote stored afterwards changes nothing it says;
  an UPDATE of the snapshot is refused by the database and the provenance is unmoved.
- Existing (fail-closed): `fx-stars.test.ts` (beyond-stale and feature-off refusals),
  `fx-conversion.test.ts`, `fx-service.test.ts`.

## 3. Falsification

`scripts/mutate-payments-financial.py` reverts one rule at a time and runs the named test;
every mutation and package rebuild is restored in a `finally` (review of PR #247, CX2). Run on
`nexa_test_pay2` at the head of `roadmap/payments-financial-hardening`: **21 of 21 killed**
(E3's mutants included). AMT-01 (the old refund ceiling) was retired with the field.

| #      | Rule reverted                                                             | Named test                        |
| ------ | ------------------------------------------------------------------------- | --------------------------------- |
| AMT-02 | a top-up credits the principal, never the fee                             | unit `payment-amounts`            |
| AMT-03 | money is received only once confirmed                                     | unit                              |
| AMT-04 | the server's principal is `payments.amount`, as the report reads it       | integration `financial-reports`   |
| AMT-05 | the page renders the server's payable instead of adding principal and fee | web `payment-money`               |
| F1-01  | the detail grows a principal-based refund figure                          | integration `financial-reports`   |
| F1-02  | the page draws a ceiling of its own                                       | web `payment-money`               |
| F2-01  | a wallet purchase counts as money received from outside                   | integration `financial-reports`   |
| F3-01  | the ledger forgets the currency witness                                   | integration `payment-money-truth` |
| F3-02  | the write's witness reads one currency (`min`) of a mixture               | integration `payment-money-truth` |
| F5-X1  | the controller says no payment is a top-up                                | integration `payment-money-truth` |
| F5-X2  | the controller drops the receipt credit                                   | integration `payment-money-truth` |
| F5-X3  | the quote time is read from the fetch time                                | integration `payment-money-truth` |
| F5-X4  | the fixed rate is dropped                                                 | integration `payment-money-truth` |
| REF-01 | the ledger carries the refusal reason                                     | integration `payment-money-truth` |
| REF-02 | the page names the reason, not the general sentence                       | web `payment-money`               |
| F6-01  | the write names a different reason from the ledger's                      | integration `payment-money-truth` |
| F6-02  | an UNKNOWN purchase operation no longer holds the money                   | integration `payment-money-truth` |
| NIT-01 | the rate is shown raw instead of grouped                                  | web `payment-money`               |
| NIT-02 | the fee is drawn on a second card                                         | web `payments`                    |
| PRV-01 | a central-rate attempt with no snapshot reports no rate                   | unit `rate-provenance`            |
| PRV-02 | the rate is frozen at the attempt's creation                              | integration `payment-money-truth` |

## 4. Manual acceptance — NOT RUN

1. Staging: a NOWPayments (or Stars central-mode) attempt — the payment page's provenance
   card names `MARKET`, the source, the book and fetch times and the quote id; after an FX
   refresh with a different rate, the same attempt's card is unchanged.
2. A Stars attempt in fixed mode names `OPERATOR` and the route's rate.
3. Turn the central feature off, or let the quote pass the stale limit: a new central-rate
   attempt is refused and the customer reads «نرخ ارز در این لحظه در دسترس نیست…».
4. A fee-bearing TonPays attempt: the money card's payable equals the provider invoice
   amount; the financial report's customer fees line rises by exactly the fee.

## 5. Open questions

- **OQ-E4-01** — merchant net. No provider adapter records what the provider kept. If the
  owner wants a merchant-net line, the provider's settlement report must be read as evidence
  (per provider, with its own acceptance); it cannot be derived from the customer fee.
