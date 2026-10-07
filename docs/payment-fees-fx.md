# Fee consistency and FX provenance (roadmap E4, E5)

Branch `roadmap/payments-financial-hardening`. Audit-first: WP18 (`docs/wp18-gateway-fee-financial-log-audit.md`)
built the customer fee and Package FX (`docs/fx-audit.md`) the central rate. Both were
already correct on the money; what was missing was ONE place every surface reads them from.
**No accounting semantics changed.** No schema change, no migration.

## 1. E4 — one source of truth for a payment's money

### 1.1 Audit

| Figure                      | Where it lived                                                                                      | Finding                                                                                     |
| --------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Customer amount (principal) | `payments.amount`; detail `amount`                                                                  | Correct; the revenue basis, the top-up credit and the refund ceiling (WP18 A1).             |
| Fee (surcharge)             | `payments.customer_fee_*` snapshot; detail `customerFee`                                            | Correct; frozen by the guard trigger; never revenue, credit or refundable.                  |
| What the customer paid      | `payable_amount` snapshot, or the principal                                                         | Correct in the report (`coalesce(payable_amount, amount)`); the detail had no single field. |
| Merchant fee / merchant net | **Not recorded anywhere.** Provider final/credit amounts are diagnostic metadata                    | Must not be invented — now said explicitly (`NOT_RECORDED`).                                |
| Wallet credit               | Ledger (`TOPUP_*`, `RECEIPT_CREDIT`); detail `receiptCredit`                                        | Correct; the detail had no single field for "what this payment put on the wallet".          |
| Refund ceiling              | `RefundService` (`payments.amount`); ledger `paidMinor`                                             | Correct.                                                                                    |
| Report                      | `financialCash`: Σ amount, Σ customer_fee_amount, Σ coalesce(payable, amount), CONFIRMED non-wallet | Correct.                                                                                    |
| Frontend arithmetic         | `formatBasisPointsPercent` (display of a stored rate) and `parsePercentBasisPoints` (input)         | No recomputation of a percentage or a sum on any payment page.                              |

### 1.2 What was added

`packages/contracts/src/payment-amounts.ts` — `paymentAmountsOf`, one pure `bigint` function
from the payment's own snapshot to: principal, customer fee (+ its basis points), customer
paid, received (confirmed money from outside), wallet credit, wallet debit, refund ceiling,
and merchant net `null` with `NOT_RECORDED`. The server sends it as
`paymentDetailSchema.amounts`; the Web Admin's money card renders it and computes nothing.

### 1.3 Tests

- `tests/unit/payment-amounts.test.ts` — fee (surcharge) never credited or refundable; paid =
  principal + fee; received only when confirmed and external; wallet settlement is a debit;
  partial and late (never confirmed) receive and refund nothing; a receipt credit is the
  wallet credit of a FAILED transfer; merchant net never invented; invariants over every
  state × method × fee rate × kind × principal.
- `tests/integration/financial-reports.test.ts` (E4 case) — over HTTP, the report's principal,
  customer fees and customer paid equal, per currency, the sums of the detail breakdowns of
  exactly the payments the cash section counts (the fixture holds a 2 % fee sale, a refunded
  sale, a wallet purchase, a receipt credit and a USD top-up); every refund ceiling is the
  principal and equals the refund ledger's `paidMinor`.
- `tests/integration/payment-money-truth.test.ts` — the ceiling against the ledger for an
  order; a wallet settlement's debit and zero received.
- `tests/web/payment-money.test.tsx` — the card shows the server's figures even when they do
  not add up, and the sum the browser could have computed is nowhere on the page.

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
  attempt; a newer, very different central quote stored afterwards changes nothing it says;
  an UPDATE of the snapshot is refused by the database and the provenance is unmoved.
- Existing (fail-closed): `fx-stars.test.ts` (beyond-stale and feature-off refusals),
  `fx-conversion.test.ts`, `fx-service.test.ts`.

## 3. Falsification

`scripts/mutate-payments-financial.py` reverts one rule at a time and runs the named test.
Run on `nexa_test_pay2` at the head of `roadmap/payments-financial-hardening`: **9 of 9
killed** (E3's two mutants included).

| #      | Rule reverted                                                            | Named test                                 |
| ------ | ------------------------------------------------------------------------ | ------------------------------------------ |
| AMT-01 | the refund ceiling is the principal, never the payable                   | unit `payment-amounts` — killed            |
| AMT-02 | a top-up credits the principal, never the fee                            | unit — killed                              |
| AMT-03 | money is received only once confirmed                                    | unit — killed                              |
| AMT-04 | the server's principal is `payments.amount`, as the report reads it      | integration `financial-reports` — killed   |
| AMT-05 | the page renders the server's figure instead of adding principal and fee | web `payment-money` — killed               |
| REF-01 | the ledger carries the refusal reason                                    | integration `payment-money-truth` — killed |
| REF-02 | the page names the reason, not the general sentence                      | web — killed                               |
| PRV-01 | a central-rate attempt with no snapshot reports no rate                  | unit `rate-provenance` — killed            |
| PRV-02 | the rate is frozen at the attempt's creation                             | integration `payment-money-truth` — killed |

## 4. Manual acceptance — NOT RUN

1. Staging: a NOWPayments (or Stars central-mode) attempt — the payment page's provenance
   card names `MARKET`, the source, the book and fetch times and the quote id; after an FX
   refresh with a different rate, the same attempt's card is unchanged.
2. A Stars attempt in fixed mode names `OPERATOR` and the route's rate.
3. Turn the central feature off, or let the quote pass the stale limit: a new central-rate
   attempt is refused and the customer reads «نرخ ارز در این لحظه در دسترس نیست…».
4. A fee-bearing TonPays attempt: the money card's customer paid equals the provider invoice
   amount; the financial report's customer fees line rises by exactly the fee.

## 5. Open questions

- **OQ-E4-01** — merchant net. No provider adapter records what the provider kept. If the
  owner wants a merchant-net line, the provider's settlement report must be read as evidence
  (per provider, with its own acceptance); it cannot be derived from the customer fee.
