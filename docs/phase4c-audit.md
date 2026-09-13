# Phase 4C audit — wallet, payments and settlement

Written before any Phase 4C code, against `main` at
`39ae0c422e456aa5d3623c2f38068e35b98febdd`, so that a later reader can tell what
this phase INHERITED from what it decided.

The finding that shapes everything below: **Phase 4C is the phase with the least
design left in it.** `ledger.ts` and `payment.ts` were written in Phase 0 as
frozen contracts, the tables landed in migration 0032, and the invariants that
matter are already enforced by database triggers. There is almost nothing to
invent here and a great deal to obey. Where this document records a decision, it
is because the contracts genuinely left a hole — and each one says which.

---

## 1. What Wallet already means

**A ledger, and only a ledger.** `wallet_entries` (0032) stores one row per
movement: `direction` (`CREDIT`/`DEBIT`), `reason` from the frozen vocabulary,
an amount that is **always positive** (`wallet_entries_amount_check`), a
currency, and a `reference` that is unique per tenant.

`ledger.ts` states the rule: _"amounts are always POSITIVE and direction is a
separate column; a reversal is a new entry referencing the original, never an
edit. Balance is derived and cached, never authoritative."_

**Append-only is enforced by the database, not by intention.** Migration 0033
installs `wallet_entries_no_update` and `wallet_entries_no_delete`, both
executing `nexa_reject_mutation` from 0001. An UPDATE or DELETE from application
code raises. The comment records why: _"An UPDATE on a ledger entry is the legacy
system's mutable balance with extra steps."_

**There is no balance column and 4C adds none.** `CLAUDE.md`: _"Balance is
derived from an append-only ledger. **Never add a balance column.**"_
`scripts/check-boundaries.sh` rejects a migration that adds one.

`ledger.ts` says balance is _"derived and cached"_. **No cache table exists, and
4C does not create one.** A cache is a second copy of a financial truth whose
invalidation nothing in this repository specifies; deriving by `SUM` over an
index that already exists for exactly this
(`wallet_entries_customer_created_idx` on `(customer_id, created_at, id)`, whose
own comment says _"the sum reads the whole of a customer's slice and the page
reads the tail of it"_) costs one indexed scan per read. When that becomes a
measured problem it is a snapshot-plus-delta design, and it needs its own ADR.

**Negative balance is settled by contract.** `WALLET_ALLOWS_NEGATIVE_BALANCE =
false`, and `payment.ts` explains it is a constant rather than an `if` _"so that
the reseller credit line in 4F has to change data rather than code"_.

### What the research says, and where it disagrees

| Legacy behaviour                                                                                            | Evidence                                                                                | What 4C does                                                                                                      |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| One mutable balance field in Toman, read live everywhere                                                    | EVIDENCED (`entities-states.md`, Wallet)                                                | Replaced by the ledger. This is the defect the contract exists to prevent.                                        |
| Admin adjusts by a signed delta with **no confirmation**, proven 2,659,767 → +1,000 → 2,660,767 → −1,000    | EVIDENCED, `UBR-009`                                                                    | Kept as a delta, but it appends a ledger entry with a mandatory reason and an audit row.                          |
| The per-user financial report **does not reconcile** — a residual of 916,550 against a balance of 2,659,767 | EVIDENCED, `UNK-RSV2-012`: _"it is not a ledger … a summary, not an account statement"_ | This is the single strongest argument in the corpus for the ledger. Quoted in 0033's own comment.                 |
| Admin **debits are added to** the top-up total instead of subtracted                                        | EVIDENCED, `RSV2-BR-019`                                                                | A direction column makes this arithmetically impossible.                                                          |
| Wallet adjustments log actor, target, delta and resulting balance but **not the reason**                    | EVIDENCED, `LGR-BR-063`                                                                 | `wallet_entries.reason` is NOT NULL and CHECK-constrained.                                                        |
| Mass top-up commits with no confirmation, no affected count and **no undo**                                 | EVIDENCED, `UBR-022`/`UBR-023`                                                          | **Out of scope.** `users.wallet.mass` and `MASS_CREDIT`/`MASS_DEBIT` exist and get no producer in 4C.             |
| Whether a balance truly goes below zero, or the ceiling is only a purchase gate                             | **UNKNOWN**, `UNK-UM-005`, still open                                                   | Settled by contract, not by guessing: `WALLET_ALLOWS_NEGATIVE_BALANCE = false`. The per-customer ceiling is 4F's. |
| `نوع تراکنش` implies a transaction-type column the UI never enumerated                                      | **NOT_EXPOSED**, `UNK-UM-007`                                                           | Noted. Not evidence of a ledger, and not used as any.                                                             |

---

## 2. What Payment already means

**A first-class entity, distinct from Order, and the research agrees.** The
corpus is unambiguous: payment tracking codes are **10 lowercase hex** where
order codes are 8 (`WEB-BR-023`), and all-time there were **124,196 payments
against 74,860 orders** — _"Payments ≠ orders. They are wallet top-ups; the order
pipeline spends from the wallet afterwards."_ (EVIDENCED, VERIFIED_BY_MATH.)

The schema already encodes exactly that asymmetry: `payments.order_id` is
nullable, _"Null for a wallet top-up, which settles no order."_

**States.** `PENDING`, `CONFIRMED`, `FAILED`, `CANCELLED`, `EXPIRED`, `UNKNOWN`.
`UNKNOWN` is deliberately **not** terminal — `payment.ts` explains that making it
terminal would need a "reopen" transition, _"and a reopened payment is a payment
whose confirmed-at timestamp cannot be trusted."_ Its two reconciliation
transitions both carry the `reconciliationEvidenceRecorded` guard.

**Methods.** `WALLET`, `MANUAL_TRANSFER`, `GATEWAY` — and
`SELF_CONTAINED_PAYMENT_METHODS = ['WALLET', 'MANUAL_TRANSFER']`. The contract is
explicit that _"an unconfigured gateway is REFUSED, not simulated"_, citing the
Marzban descriptor that advertised fourteen operations no code could perform.

**Evidence kinds.** `OPERATOR_REVIEW`, `WALLET_DEBIT`, `GATEWAY_CALLBACK`,
`RECONCILIATION`.

**What the database already guarantees, before 4C writes a line:**

- `payments_order_confirmed_key` — a partial unique index on `order_id` where
  `state = 'CONFIRMED'`. At most **one** confirmed payment per order, _"because
  two concurrent confirmations both read 'no confirmed payment yet'."_
- `payments_confirmed_check` — `(state = 'CONFIRMED') = (confirmed_at IS NOT NULL
AND evidence_kind IS NOT NULL)`. A confirmation without evidence cannot exist.
- `payments_order_fk` on `(tenant_id, order_id, customer_id)` — a payment that
  names an order must name its owner. _"Without the third column a wallet debit
  could settle another customer's order."_
- `payments_tenant_reference_key` — the quotable reference is unique per tenant.
- `nexa_payments_confirmation_guard` (0033, replaced by 0035) — once `CONFIRMED`,
  the amount, currency, customer, order, method, reference, evidence kind,
  evidence note, confirmation time, **confirming admin** and state are all
  immutable. Only `external_reference` may still change, _"a gateway identifier
  learned during reconciliation is the one fact that legitimately arrives after
  confirmation."_

That last guard is the direct answer to `UNK-PR-010` — the legacy receipt review
records **neither reviewer nor time**, so _"was this approved by a human"_ is
unanswerable there.

### The receipt evidence, and how little of it there is

**The pending-receipts queue was empty for the entire investigation.** No receipt
was ever observed end to end. Consequently `UNK-PR-001` through `UNK-PR-011` are
all open: list format, detail view, media delivery, the approve button, whether
the amount is editable, reject and reason, customer notification, reversibility,
the status enum, the reviewer field, and the auto-approval settings' values.

What IS evidenced:

- A dedicated Telegram admin role `🧾 تأییدکنندهٔ رسید` exists — one of exactly
  four, orthogonal to customer tier (`ABR-003`/`ABR-005`). Our `receipt_reviewer`
  seed role is that role.
- Receipt approval is one of only **two** admin mutations logged at all
  (`LGR-BR-083`); the other is wallet adjustment.
- Receipts are `TELEGRAM_ONLY` — **no web surface existed at all**.
- `رسید` (receipt) and `پرداخت` (payment) name the same thing in two places in
  the same feature (`PRBR-004`), and which is the record is **not established**.

**Timer auto-approval is real and 4C does not implement it.** Four controls exist
on card-to-card — auto-approve, approve-without-review, the delay, and a per-user
exemption — and the corpus's own summary is _"Money claimed by an uploaded
receipt can be credited without any human ever seeing it."_ (`FBR-007` /
`PRBR-003`.) `docs/open-questions.md` classifies this as a **DECISION**, not a
requirement to reproduce. Every confirmation in 4C is an operator holding
`receipts.review`, recorded with their id and the time.

---

## 3. What Settlement already means

**One frozen transition with one named guard:**

```
{ from: 'AWAITING_PAYMENT', to: 'PAID', on: 'SETTLE', guard: 'settlementIsFunded' }
```

`state-machine.ts`: _"Named guard, resolved by the owning module. Documentation
here, code there."_ Implementing `settlementIsFunded` is Phase 4C's central
deliverable.

`commerce.ts` states what it must mean: _"an order settles only when the money
backing it is real — a confirmed payment or a committed wallet debit — and never
because a client said so."_

**There is no transition out of `PAID` back to `AWAITING_PAYMENT`**, and the
contract says why: _"A settlement that turns out to be wrong is a refund plus a
new order, never a reopened one, because the alternative is an order whose
paid-at timestamp is a lie."_

**Re-pricing at settlement is not merely forbidden — it is impossible.**
`nexa_orders_snapshot_guard` (0033) freezes `total_amount`, `currency`, every
`line_*` column and the `quote` once `confirmed_at` is set. The order's total is
physically immutable by the time it can be settled.

### What the research says about settlement

| Legacy behaviour                                                                                                                           | Evidence                                                                                                                              | What 4C does                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Checkout shows a pre-invoice with the live wallet balance inline and two parallel buttons: `💳 پرداخت با درگاه` and `✅ استفاده از موجودی` | EVIDENCED (store crossmap)                                                                                                            | The wallet button is implemented. The gateway button is refused with `bot.payment.unconfigured`.                                                                           |
| **No payment button was ever clicked in any phase**                                                                                        | stated outright                                                                                                                       | Everything after the click is unobserved. Every post-payment claim below is traced to the log group or marked UNKNOWN.                                                     |
| Wallet-only purchase: `موجودی قبل − موجودی بعد = قیمت نهایی`                                                                               | EVIDENCED, VERIFIED_BY_MATH, `LGR-BR-002` (993,000 − 888,000 = 105,000)                                                               | The debit equals the order total exactly.                                                                                                                                  |
| Wallet may be applied **partially**, remainder to the gateway                                                                              | EVIDENCED, `LGR-BR-003`                                                                                                               | **Deferred.** A split needs a second rail to take the remainder, and there is none. 4C's wallet settlement is all-or-nothing.                                              |
| One label `قیمت نهایی` means the gateway charge in one message and the balance debit in another                                            | EVIDENCED, `LGR-BR-001`/`002`                                                                                                         | A defect to avoid, not to port. A payment's `amount` means one thing.                                                                                                      |
| Whether an unpaid Order row exists server-side at checkout                                                                                 | **UNKNOWN**, `UNK-T003`, open                                                                                                         | Already settled by Phase 4B, which creates a real `DRAFT` row. Not re-opened.                                                                                              |
| Debit/provisioning ordering and atomicity                                                                                                  | **NOT_EXPOSED** — the log has no correlation ids and success/failure land in different topics with no shared key (`LGR-BR-080`/`082`) | 4C commits the debit, the payment confirmation and the order transition in ONE transaction. Nothing about the legacy ordering is inherited because nothing was observable. |

---

## 4. Which ledger reasons already exist

All 22 are frozen in `LEDGER_REASONS`. **Phase 4C produces three of them**, and
invents none:

| Reason         | Producer in 4C                                         |
| -------------- | ------------------------------------------------------ |
| `PURCHASE`     | the DEBIT that funds a wallet settlement               |
| `ADMIN_CREDIT` | an operator crediting a wallet (`users.wallet.credit`) |
| `ADMIN_DEBIT`  | an operator debiting a wallet (`users.wallet.debit`)   |

> **Revised after the audit was accepted.** An earlier draft of this table
> listed `TOPUP_RECEIPT` as a fourth, produced by a customer-initiated wallet
> top-up. That is now deferred — see §8, _"Standalone top-up is deferred"_. A
> manual transfer in this release pays for an ORDER, whose amount is a frozen
> snapshot; nothing credits a wallet except an operator.

The other nineteen get no producer here and are named so a reader can see the
absence is deliberate: `TOPUP_RECEIPT` (see §8); `TOPUP_GATEWAY`, `TOPUP_STARS`,
`TOPUP_CRYPTO` (no
adapter); `PURCHASE_REVERSAL`, `REFUND`, `CHARGEBACK`, `CORRECTION` (refunds, out
of scope); `CASHBACK_*` (three unrelated legacy mechanisms, 4E);
`REFERRAL_*`, `START_GIFT`, `LOTTERY_WIN`, `LUCK_WHEEL_WIN` (4E/4F);
`MASS_CREDIT`, `MASS_DEBIT` (no mass tooling); `RESELLER_*` (4F); `OTHER`.

`ADMINISTRATIVE_REASONS` and `REVERSAL_REASONS` are frozen classifications and 4C
honours the first: an administrative reason may only be produced by an
administrative action, never by a flow.

---

## 5. Which transitions are already frozen

- **Order:** the whole `ORDER_MACHINE`. 4C uses exactly one edge, `SETTLE`, and
  reads the target from the machine rather than writing `'PAID'` as a literal —
  the rule Phase 4B established.
- **Payment:** the whole `PAYMENT_MACHINE`. 4C uses `CONFIRM` (guard
  `evidenceVerified`). `FAIL`, `CANCEL`, `EXPIRE`, `LOSE_TRACK` and both
  reconciliation edges have no producer in 4C; `LOSE_TRACK` and reconciliation
  exist for a gateway, and there is no gateway.

---

## 6. Which payment rails are actually evidenced

The legacy roster is **eleven gateways, three enabled** — nowpayment,
درگاه سفارشی and Telegram Stars; card-to-card is disabled (`FBR-004`,
`WEB-BR-012`/`013`). In production traffic the log group shows
درگاه سفارشی (169 of 174 financial messages), استار تلگرام, NowPayments and
`cart to cart` [sic — the enum carries the misspelling, `BUG-LGR-023`].

**No exchange rate and no currency selector exists anywhere.** Across five
gateway schemas there is _no fee, no currency selector, no crypto network, no
confirmation count and no payment-expiry field_ (`FBR-010`, VERIFIED_BY_UI for
the absence). Telegram Stars has **no conversion-rate setting at all**, yet
payments store the resulting Toman amount: 43 ⭐ ⇒ 137,922 تومان (`LGR-BR-062`).
Where the rate came from is NOT_EXPOSED. The one counter-sighting is an FX rate
printed at raw float precision in a log line, `4.7846889952153 usd`
(`BUG-LGR-022`).

**This is why `money.ts` requires a currency on every amount and why 4C refuses
rather than converts.** No conversion is frozen, so no conversion happens: a
payment whose currency differs from the order's is refused, not rescaled.

**Which rails 4C implements:** `WALLET` and `MANUAL_TRANSFER`, exactly
`SELF_CONTAINED_PAYMENT_METHODS`. `GATEWAY` is refused with
`bot.payment.unconfigured`, which is the key frozen for precisely that.

**Amount limits.** Two layers existed — a global minimum/maximum on the Financial
root **and** per-gateway minima/maxima — and the global minimum was itself **per
user tier** (عادی 50,000, نماینده عادی 100,000, نماینده پیشرفته 20,000, an
ordering the corpus flags as anomalous with cause UNKNOWN, `FBR-012`). Which
layer wins is **UNKNOWN and deliberately unresolved** (`FBR-008`). 4C has **no
amount-limit layer at all**, and one sanity rail that is not a policy:
`PAYMENT_AMOUNT_MAX_MINOR`, the ceiling above which a request is certainly a
mistake or an attack.

> **Corrected after §8.** An earlier draft of this paragraph said 4C had "exactly
> one layer — `wallet.topup.minimum`". That was written before standalone top-up
> was deferred and it contradicted §8 two sections later. `wallet.topup.minimum`
> stays `PLANNED` with NO consumer in this release: nothing in 4C lets a customer
> name an amount, so there is no amount for a minimum to bound. The tiered
> minimum and the per-gateway layering are both 4F's or later.

---

## 7. Which Web Admin surfaces were already specified

| Surface                                                                                                                     | Evidence                                                          | 4C                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Payments list + detail**, keyed by a 10-hex tracking code, with **status** and **method** columns                         | EVIDENCED, `WEB_ONLY (detail)`                                    | Built. The reference generator follows the recorded shape: 10 lowercase hex.                                                                                                                    |
| Payment status vocabulary differs between pages (`موفق`/`در انتظار`/`ناموفق` on charts, `رد شده` in the list)               | **UNKNOWN**, `UNK-WEB-005`, open                                  | Not inherited. Our six states are frozen in `PAYMENT_STATES` and rendered from it.                                                                                                              |
| **Wallet per user**: `Tab مالی` showing `جمع خدمات` and `موجودی`, with `افزایش موجودی` / `کسر موجودی` and `صفر کردن موجودی` | EVIDENCED                                                         | Balance and history built; credit and debit built behind their own permissions. **No "zero the balance" control** — it is a set-balance in disguise, and the ledger has no reason for it.       |
| **Receipts: no web surface at all**, `TELEGRAM_ONLY`                                                                        | EVIDENCED                                                         | Improved deliberately. Confirmation happens in Web Admin Payments, where the reviewer's identity is recorded — which is exactly what `UNK-PR-010` records as unanswerable in the legacy system. |
| `/admin/logs` records actor, a Persian sentence, one customer id, time and IP — **no before/after, no entity id**           | EVIDENCED, `WEB-BR-024`: _"an activity feed, not an audit trail"_ | Every financial mutation writes a real `audit_logs` row with before/after.                                                                                                                      |
| Cashback per tier **and** per gateway, two independent mechanisms, stacking UNKNOWN                                         | `WEB-BR-021`, store unknown #18                                   | Out of scope. 4E.                                                                                                                                                                               |

---

## 8. Which Telegram behaviours were already specified

**Frozen template keys, all seven of which already exist** — 4C adds none:

| Key                               | Placeholders             | Used in 4C for                                 |
| --------------------------------- | ------------------------ | ---------------------------------------------- |
| `bot.wallet.balance`              | `{balance}`              | the customer's derived balance                 |
| `bot.wallet.insufficient`         | `{shortfall}`            | a wallet settlement refused for want of funds  |
| `bot.payment.manual_instructions` | `{total}`, `{reference}` | the out-of-band transfer and the code to quote |
| `bot.payment.unconfigured`        | —                        | `GATEWAY` chosen                               |
| `bot.payment.received_for_review` | —                        | evidence queued for an operator                |
| `bot.order.awaiting_payment`      | `{total}`, `{expiresAt}` | already produced by 4B                         |
| `bot.order.settled`               | —                        | the terminal financial state                   |

Evidence for the customer side is **strong before the payment and absent after
it**. Balance display is EVIDENCED (`/wallet` card, and inline on every
pre-invoice). The payment-method screen was read but **never clicked**
(`UNK-T007`), so the success signal is _"UNKNOWN/NOT_TESTED"_ in the corpus's own
words. Receipt-submission templates exist (`متن بعد از ارسال رسید`) but the flow
was never exercised, and the corpus warns: _"A template's existence proves
nothing about whether the feature is enabled."_

### DEFECT FOUND IN OUR OWN SHIPPED COPY

`packages/i18n/src/catalogue.fa.ts` ships
`bot.order.settled` as **«پرداخت تأیید شد. سرویس شما در حال آماده‌سازی است.»** —
_"Payment confirmed. Your service is being prepared."_

**Nothing in Phase 4C prepares anything.** No provisioning, no panel call, no
service row. 4B could ship that string because 4B never sent it; 4C is the phase
that first does, and sending it would be the product claiming an effect that did
not happen — the defect class this codebase is organised around.

The template KEY and its frozen description are untouched. The shipped **default
copy** is corrected to state only what is true: the payment was confirmed and the
order is paid. A tenant who later runs 4D can word it however they like; the
default must not lie in the release that ships it.

### Two decisions the contracts left open

**No free-text amount prompt.** The legacy top-up asks for an amount as free text
(50,000–10,000,000 Toman). That is an FSM prompt, and `FBR-013` records what FSM
prompts do here: a Financial value prompt **captures the conversation** — while a
setting awaits a value, other inline buttons return `⭕️ ورودی نا معتبر`, and the
next ordinary message typed is consumed as that setting's value. It is the
mechanism behind `INCIDENT-FIN-001`, where a production gateway setting was
overwritten by a mistyped menu label. This runtime has no FSM and 4C does not add
one, and it needs none: no path in this release lets a customer name an amount.

**Standalone top-up is deferred, and this replaces an earlier draft of this
section.** That draft had a customer top up by
`max(shortfall, wallet.topup.minimum)`. Both halves are authoritative values on
their own, and combining them into a payable amount is a FINANCIAL PRODUCT RULE
that no contract states and no research records — the legacy minimum was per user
TIER, and its precedence against the per-gateway minimum is explicitly unresolved
(`FBR-008`, `FBR-012`). Inventing the combination is exactly what this phase must
not do.

So in this release **every payment names an order**, and its amount is read from
that order's frozen snapshot. `wallet.topup.minimum` stays `PLANNED`: it gets its
consumer in the phase that gives a standalone top-up an authoritative amount —
tenant-defined presets, a gateway's own minimum, or a reseller tier.

The wallet is therefore funded in 4C only by `ADMIN_CREDIT`, where the authority
is an authenticated operator holding `users.wallet.credit` and the amount is
their own audited input.

---

## 8a. The client is never the source of a money amount

Stated on its own because it is the invariant both customer paths are built
around, and because a violation of it looks like ordinary plumbing.

A Telegram callback carries **an order id and nothing else**. It is an INTENT and
an IDENTIFIER, never a quantity. Every value that decides how much money moves —
amount, currency, customer, tenant, and the order's state — is re-read from the
database inside the transaction that moves it, and validated there:

- amount and currency come from `orders.total_amount` / `orders.currency`, which
  `nexa_orders_snapshot_guard` froze at confirmation;
- the customer must own the order, checked against the row rather than against
  anything the update carried;
- the order must still be `AWAITING_PAYMENT`, checked by the conditional UPDATE
  itself rather than by a prior read.

A callback that carried an amount would have it ignored. A stale or tampered
order id fails ownership and state at MUTATION time, not at render time.
`commerce.ts` states the same rule one step earlier for pricing — _"never because
a client said so"_ — and this is that rule with money attached.

The two customer paths, and the authoritative source of every figure in each:

| Path                           | Amount                | Currency          | Wallet effect                        | Evidence          |
| ------------------------------ | --------------------- | ----------------- | ------------------------------------ | ----------------- |
| `WALLET` settlement            | `orders.total_amount` | `orders.currency` | `PURCHASE` debit, same transaction   | `WALLET_DEBIT`    |
| `MANUAL_TRANSFER` for an order | `orders.total_amount` | `orders.currency` | none — the money arrived out of band | `OPERATOR_REVIEW` |

---

## 9. Which decisions belong to later phases

Recorded so a reader can tell a deferral from an oversight:

- **Provisioning, service lifecycle, renewals, extra volume and time.** 4D. A
  `PAID` order in this release is paid and nothing more. `ServiceProvisioned` and
  `ServiceStateChanged` are frozen events with no producer here.
- **Refunds.** `REFUND`, `PURCHASE_REVERSAL` and `CHARGEBACK` are frozen ledger
  reasons, `refunds.view`/`refunds.issue` are frozen permissions, and
  `PAID → REFUNDED` is a frozen transition. None gets a producer in 4C. The
  research never observed a refund mechanism either — only a support-mediated
  policy sentence in `/support` Q9 (`TBR-013`).
- **Gateways.** `GATEWAY`, `TOPUP_GATEWAY`, `TOPUP_STARS`, `TOPUP_CRYPTO`,
  `GATEWAY_CALLBACK`, `PaymentGatewayPort`, `LOSE_TRACK` and both reconciliation
  transitions. They exist so that the shape of an unknown outcome is settled
  before money can be lost to one; nothing here produces them.
- **Partial wallet payment** with the remainder to a gateway (`LGR-BR-003`).
  Needs a second rail.
- **Mass wallet operations** (`users.wallet.mass`, `MASS_CREDIT`, `MASS_DEBIT`).
  The legacy tool has no confirmation, no affected count and no undo
  (`UBR-022`/`023`); rebuilding it needs the dry-run/confirm/audit shape ADR-0010
  requires, which is its own piece of work.
- **Cashback, referral, lottery, luck wheel, start gift.** 4E.
- **Resellers**: `RESELLER_SETTLEMENT`, `RESELLER_MEMBERSHIP_FEE`, the
  per-customer negative-balance ceiling, and the tiered top-up minimum. 4F.
- **Standalone wallet top-up**, and with it `TOPUP_RECEIPT` and
  `wallet.topup.minimum`'s first consumer. It needs an authoritative amount
  source this release does not have.
- **Receipt media handling.** The customer uploading an image the operator then
  views. Every question about that record is open (`UNK-PR-001`…`006`) and the
  queue was empty, so there is nothing to be faithful to. 4C carries the
  reference the customer quotes; the operator confirms against their own bank
  record.
- **Auto-approval of receipts** (`FBR-007`/`PRBR-003`). A decision, and the
  decision for this release is no.

## 10. Open questions this phase does NOT resolve

`UNK-PR-001`…`UNK-PR-011` (all open, one cause: an empty queue), `UNK-WEB-005`,
`UNK-UM-004`/`005`/`007`/`019`, `UNK-LGR-008`, `FBR-008`, the never-opened FX
gateway schemas, and store unknown #18. `docs/open-questions.md` carries
recorded **fallbacks** for several of these; a fallback is a design default
chosen for the rebuild, not a legacy finding, and this phase cites none of them
as evidence.

Above all: `UNK-PR-007` — _what an approval actually credits_ — stays open. The
corpus's own entities table says `Receipt → Wallet` is UNKNOWN, _"not proven that
approval credits the wallet rather than settling an order"_, and the file ends
_"Nothing here is VERIFIED, because no receipt was ever observed."_ 4C does not
resolve it by choosing; it makes both readings **explicit and distinguishable in
the data**, which is what the schema already does by making `payments.order_id`
nullable. A confirmed payment with no order credits the wallet. A confirmed
payment naming an order settles that order. Which one a given payment is, is a
column, not an inference.
