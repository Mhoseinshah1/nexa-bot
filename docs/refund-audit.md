# Refund audit (roadmap E3)

Branch `roadmap/payments-financial-hardening`. An audit of every way money might go back,
against what the domain can actually do. **No refund semantics changed.** The one code
change is that the refund ledger now says WHY a payment cannot be refunded
(`refundListResponseSchema.refusalReason`, from the same decision the write path refuses
with), and the Web Admin names that reason instead of one sentence listing four.

There is ONE automatic credit path, `RefundService.refundUndeliverable`, used by the
settlement lane and the provisioner, and one operator path, `RefundService.request` /
`complete` / `fail` under `refunds.issue`. Nothing here adds a third.

## 1. The matrix

| Case                                                     | Domain operation that exists                                                                                                                       | Operator surface                                                                              | Status                       |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------- |
| Order paid by **wallet**, delivered                      | Operator refund → `WALLET_CREDIT`, completed in the same transaction (one `REFUND` ledger entry, reference `${refundId}:refund`)                   | Refund card: request                                                                          | Supported                    |
| Order paid by **manual transfer**, delivered             | Operator refund → `EXTERNAL_MANUAL`: `REQUESTED → AWAITING_EXTERNAL`, then an operator records the real transfer (`complete`) or abandons (`fail`) | Refund card: request, complete, fail                                                          | Supported                    |
| Order paid by **gateway**, delivered                     | None. `REFUND_METHOD_SUPPORT.GATEWAY.supported = false`: no provider documents a refund API (TonPays, NOWPayments, CentralPay, Stars as built)     | Refusal: `CHANNEL_UNSUPPORTED`, named                                                         | **Unsupported** — §2.1       |
| Any order that **could not be delivered**                | `refundUndeliverable`: automatic, exact amount, to the wallet, in the transaction that discovers it                                                | Compensations list (read-only)                                                                | Supported (automatic)        |
| Order paid by **wallet**, undeliverable                  | Refused, never refunded: the debit is written in the settling transaction and dies with it                                                         | —                                                                                             | By design (money rule)       |
| A delivery still **in flight or UNKNOWN**                | None until it ends: `DELIVERY_IN_PROGRESS` (UNKNOWN is never refunded)                                                                             | Refusal: `DELIVERY_IN_PROGRESS`, named as transient                                           | By design                    |
| **Partial** payment (provider "partially paid")          | None. The payment is never CONFIRMED (`PAYMENT_NOT_SETTLED`); reconcile FAILED if the evidence supports it                                         | Refusal: `PAYMENT_NOT_SETTLED`; the situation guide names verify + wallet adjustment          | **Unsupported** — §2.2       |
| **Late completion** (provider approved after the window) | None for an ended attempt (`OQ-WP11A-03`); on an UNKNOWN, reconcile                                                                                | Same as partial                                                                               | **Unsupported** — §2.2       |
| **Wallet top-up** back to the bank                       | None. `TOPUP_CREDITED_TO_WALLET`: its money is already on the wallet; returning it too pays twice                                                  | Refusal named; `ADMIN_DEBIT` + a bank transfer by hand is the only route, and is not a refund | **Unsupported** — §2.3       |
| Receipt **credited to the wallet** instead of approved   | Not a refund: a `RECEIPT_CREDIT` entry for what the reviewer saw; the payment is FAILED                                                            | Read-only                                                                                     | Not applicable               |
| **Compensation** (goodwill, not tied to a payment)       | `ADMIN_CREDIT` on the customer's wallet (`users.wallet.credit`), audited, bounded by the large-credit permission                                   | Customer page wallet credit                                                                   | Supported — **not a refund** |
| Service refund request (customer asks, WP19)             | `ServiceRefundRequestService`: approved amount credited to the wallet                                                                              | Service refund requests page                                                                  | Supported                    |
| Refund in a **different currency**                       | Refused: `CURRENCY_MISMATCH`, fail closed; the ledger names it too (any consuming refund in another currency), so read and write agree             | Refusal named                                                                                 | By design                    |
| The **gateway fee**                                      | Never refundable: the refund bound is the principal (WP18 O9)                                                                                      | Refund ledger: `refundableMinor` (the money card carries no refund figure)                    | By design                    |

## 2. Future domain requirements (not built, and why)

No UI was built for any of these: a button with no operation behind it is the legacy
silent-success pattern.

### 2.1 Provider refunds

A `PROVIDER` refund channel needs, per provider: a documented refund endpoint; an outcome
model with an UNKNOWN state (a refund call that times out may have moved money — the same
rule as a create); a deadline and an inquiry; a ledger story for a refund that the provider
completes after Nexa recorded it as failed; and the capability declared only after a real
acceptance run against the provider (the `docs/real-panel-acceptance.md` rule). None of the
current providers documents one.

### 2.2 Late and partial money

What happens to money a provider holds for an attempt Nexa can no longer settle is the
owner's decision (`OQ-WP11A-03`: credit by hand, or nothing). A domain operation would need
an evidence binding (the provider's reference, write-once), an amount taken from that
evidence rather than typed, and a link from the resulting ledger entry back to the payment
so it can never be credited twice — the shape `receipt_credits` already has for receipts.

### 2.3 Wallet withdrawal

Returning wallet money to a bank account is a WITHDRAWAL, not a refund: it reduces a
liability rather than reversing a payment. It needs its own entity with the
`AWAITING_EXTERNAL` discipline refunds have, a ledger reason, a bound by the balance under
the wallet lock, and an owner decision on whether credits that came from gifts, cashback or
commissions may be withdrawn at all.

## 3. Tests

- `tests/integration/payment-money-truth.test.ts` — over HTTP: a gateway payment, a top-up and
  an unsettled payment each name their reason; a delivered wallet-funded order names none.
  Read equals write over EVERY `REFUND_REFUSAL_REASONS` member (the test fails if a reason is
  added without a case): a refund request is refused with exactly 409
  `REFUND_NOT_PERMITTED`, `details.reason` is the reason the ledger named, and nothing is
  written — including CURRENCY_MISMATCH (refunds in two currencies; the write's witness
  reports a mixture rather than `min` of it) and DELIVERY_IN_PROGRESS (an UNKNOWN purchase
  operation). Review of PR #247, CX1/F3/F6.
- `tests/web/payment-money.test.tsx` — the page names the server's reason, distinctly per
  reason, offers no control, and falls back to the general sentence for an older ledger.
- Existing: `refunds.test.ts`, `automatic-refund.test.ts`, `service-delete-refund.test.ts`,
  `service-refund-requests.test.ts`, `unit/refund-rules.test.ts`.

## 4. Manual acceptance — NOT RUN

1. On staging, open a delivered gateway order's payment: the refund card reads the gateway
   sentence and offers no form.
2. Open a confirmed card-to-card top-up: the top-up sentence.
3. Open a delivered wallet-funded order: the form is offered; a partial refund lands on the
   wallet at once and the remaining amount drops by exactly that much.
4. Open a delivered card-to-card order: request a refund, see AWAITING_EXTERNAL, make the
   transfer, complete it with the bank reference.
