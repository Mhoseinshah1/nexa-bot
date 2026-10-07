# Payments: the under-review UX, the reconciliation workspace and the receipt flow

Roadmap items E1, E2 and E6 (branch `roadmap/payments-ops-ux`). The work is audit-first:
it extends the Payment Operations Center (`docs/payment-operations-center.md`) and the
receipt flow (`docs/pre-support/a10-e7-falsification.md`, `docs/payments-file02-design.md`)
rather than building a second one. **No accounting semantics changed.** No state, no ledger
reason, no money path and no write path was added. One facet (`NEEDS_ACTION`) and one
derived, never-stored field (`situation`) were added to the reads.

## 1. E1 — one treatment for every "under review" state

### 1.1 What existed

Each state already had its own words, in its own place: the payment state badge, the
receipt disposition badge (WP10 follow-up §5), the provider-review badge and banner
(TonPays Telegram §9.6), the UNKNOWN banner, the queue hints, and the customer's Telegram
templates. Nothing put them side by side, and nothing said — per state — whether money
probably moved, what the customer should do, which operator actions exist and what is
safe. An operator had to assemble that from five cards.

### 1.2 What was added

`packages/contracts/src/payment-situations.ts`: a closed set of **situations** and ONE pure
classifier, `paymentSituationOf(facts)`. A situation is derived from facts other flows
already recorded; it is never stored and it is not a state. The server calls the classifier
while building every payment summary (`PaymentService.situations`, one statement for a page
in `DrizzlePaymentRepository.situationFacts`) and sends the answer as
`paymentSummarySchema.situation`. The Web Admin renders it through total maps and never
classifies.

The classifier reads the queue facets from the **same SQL predicates** the queue list and
counts use, so a situation and the queue it lists under cannot disagree.

| Situation            | State(s) it comes from              | What happened                                          | Money probably moved?     | Customer should        | Operator actions that exist                                                     | Needs a person |
| -------------------- | ----------------------------------- | ------------------------------------------------------ | ------------------------- | ---------------------- | ------------------------------------------------------------------------------- | -------------- |
| `AWAITING_PAYMENT`   | PENDING                             | instructions or link sent, customer said nothing       | not yet                   | pay within the window  | none                                                                            | no             |
| `INVOICE_NOT_ISSUED` | PENDING (gateway)                   | the create was refused or its answer lost; no link     | no                        | start again            | none                                                                            | no             |
| `CUSTOMER_SIGNALLED` | PENDING (manual)                    | the customer SAYS they sent it; nobody checked         | claimed                   | wait, do not pay again | review the receipt — in Telegram only (File 02 §10)                             | yes            |
| `PROVIDER_REVIEW`    | PENDING (gateway)                   | the provider took the receipt and is reviewing it      | possibly                  | wait, do not pay again | none (wait for the provider)                                                    | no             |
| `OUTCOME_UNKNOWN`    | UNKNOWN                             | the outside world may have taken money; Nexa can't say | possibly                  | wait, do not pay again | ask the provider again; reconcile from the recorded answer                      | yes            |
| `MISMATCH`           | UNKNOWN                             | the lane held it: another amount, customer, reference  | possibly                  | wait, do not pay again | verify at the provider; ask again; reconcile                                    | yes            |
| `PARTIAL`            | PENDING, UNKNOWN, FAILED/EXP./CANC. | the provider recorded a partial payment                | partially                 | wait, do not pay again | UNKNOWN: verify, ask again, reconcile. Ended: verify, manual wallet adjustment¹ | only UNKNOWN   |
| `LATE_COMPLETION`    | UNKNOWN, FAILED/EXP./CANC.          | the provider approved after the attempt's window       | at the provider, not here | wait, do not pay again | UNKNOWN: verify, ask again, reconcile. Ended: verify, manual wallet adjustment¹ | only UNKNOWN   |
| `CONFIRMED`          | CONFIRMED                           | confirmed by trusted evidence                          | yes                       | nothing                | refund² (`refunds.issue`)                                                       | no             |
| `REFUND_IN_PROGRESS` | CONFIRMED                           | a refund is still open                                 | being returned            | nothing                | complete or fail the refund                                                     | yes            |
| `REFUNDED`           | CONFIRMED                           | some or all of it went back                            | returned                  | nothing                | refund the rest² — the server computes what is left                             | no             |
| `CREDITED_TO_WALLET` | FAILED                              | a reviewer credited what they saw to the wallet        | to the wallet             | nothing                | none                                                                            | no             |
| `REJECTED`           | FAILED (by an administrator)        | a reviewer did not accept the receipt                  | no                        | may pay again          | none                                                                            | no             |
| `FAILED`             | FAILED (no administrator)           | the gateway said unsuccessful, or reconciliation       | no                        | may pay again          | none                                                                            | no             |
| `EXPIRED`            | EXPIRED                             | the window closed with nothing confirmed               | no                        | may pay again          | none                                                                            | no             |
| `CANCELLED`          | CANCELLED                           | withdrawn before confirmation                          | no                        | nothing                | none                                                                            | no             |

¹ `MANUAL_WALLET_ADJUSTMENT` is the customer page's wallet credit (`users.wallet.credit`).
It is the only path that exists for money the domain cannot settle, and whether to use it
is **unresolved** (`OQ-WP11A-03`); the guide says so wherever it offers it.
² Only where `REFUND_METHOD_SUPPORT` has a channel this release performs (WALLET,
MANUAL_TRANSFER; never GATEWAY) and the payment bought an order (a top-up is already on the
wallet, `TOPUP_CREDITED_TO_WALLET`). The server still decides: `DELIVERY_IN_PROGRESS` is a
transient refusal the guide does not try to predict.

Rules the table obeys, each pinned by `tests/unit/payment-situations.test.ts` over every
combination of the facts the classifier branches on:

- **No two accounting states share a situation's money story.** `FAILED` alone is four
  situations. A situation is derived only from the states in its row.
- **An UNKNOWN is never shown as a failure, as "no money", or as something to pay again.**
- **Wherever money may have moved, the customer is told not to pay again.** "May pay again"
  appears only where the money signal is "no".
- **What the provider said after the end outranks how the attempt ended.** An expired
  attempt the provider then approved is `LATE_COMPLETION` (money at the provider), not
  `EXPIRED` (nothing moved).
- **Reconciliation is offered only on an UNKNOWN gateway payment**; a refund only where a
  channel exists and an order was bought.

### 1.3 The customer side

Every customer sentence is a template key. `PAYMENT_SITUATION_CUSTOMER_TEMPLATES` is the
audit: for each situation, the frozen keys that tell the customer, all checked to exist in
the catalogue. Two situations deliberately send nothing new:

- `LATE_COMPLETION` — "we saw your late payment" would promise an outcome nobody decided
  (`OQ-WP11A-03`). The customer was told the attempt expired or is unresolved, which was
  true when it was said.
- `REFUND_IN_PROGRESS` — an open refund has moved nothing; the customer hears when it
  completes (`REFUND_COMPLETED`).

### 1.4 The operator side

- `/payments`: a "وضعیت عملیاتی" column with the server's situation (outlined when nobody
  needs to act).
- `/payments/:id`: a guidance card first in the page — what happened, money, what the
  customer should do, the operator actions that exist, what is safe — and a line saying the
  accounting state is still the state badge. The controls themselves stay on the cards that
  hold the evidence (reconcile, refunds), each gated by its own permission as before.

## 2. E2 — the reconciliation workspace

### 2.1 Audit: what was already there

| Brief item                     | Already present                                                                                                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| filters                        | queue, route, state, method, receipt disposition, created-at range, one search box (incl. provider ids)                                                                                          |
| customer/order/payment context | detail: customer link, Telegram identity, order link (or "top-up"), route, external reference, destination snapshot, gateway invoice, fee, FX snapshot; list: same columns                       |
| evidence                       | gateway invoice card (creation, last inquiry, last webhook, outcome, late completion), receipts (metadata + bytes behind `receipts.view`), receipt credit                                        |
| resolution actions             | ask again and reconcile (`payments.reconcile`), refund (`refunds.issue`); receipt decisions in Telegram only                                                                                     |
| audit trail                    | the payment timeline, AUDIT section behind `audit.view` (action, actor type, result; never before/after)                                                                                         |
| idempotency                    | reconcile and ask-again take a key; a replay of ask-again returns the stored `{requested}`; a replay of reconcile returns the payment as it now stands (pinned in `nowpayments-gateway.test.ts`) |
| no secrets                     | no link, no card number (last four only), no Sheba, no file id, no credential, provider strings through `machineCode`                                                                            |

### 2.2 What was added

- **`NEEDS_ACTION`** (`PAYMENT_OPS_QUEUES`): the payments a person must act on, as one more
  SQL facet shared by the list and the counts — `paymentNeedsAction` in SQL. It contains
  only what an existing command resolves, so the queue drains:
  every UNKNOWN (reconcile), a PENDING manual transfer the customer says they sent (the
  Telegram review, or its expiry), and a CONFIRMED payment with a refund still open
  (complete or fail it). Late or partial money on an attempt that already ended is NOT in
  it: no domain operation resolves one (`OQ-WP11A-03`), and a work queue that holds what
  nobody can close is the list-that-only-grows the money rules forbid. Those stay visible in
  their own `LATE_COMPLETION` and `PARTIAL` facets.
- **Attention ordering**: `NEEDS_ACTION` leads the chips; every queue lists oldest first
  (the existing ascending keyset on `(created_at, id)` — the oldest unresolved is the most
  at risk), so no second cursor shape was needed.
- **Situation on every row** (§1.4), and the queue facets each row is in
  (`paymentSummarySchema.queues`).

`tests/integration/payment-situations.test.ts` writes one row per classifier arm in the
shapes the lanes write and holds the SQL facet and the classifier to the same answer row by
row, the count to the list, the list to oldest-first across pages of three, tenant B's
UNKNOWN out of tenant A's list, a resolved refund out of the queue, and the read behind
`payments.view`.

### 2.3 What was deliberately not built

- No "mark as paid", no "mark for review" (the provider review is opened only by the
  provider's answer), no force-settle of late or partial money. Each would be a new money
  path.
- No new resolution for `LATE_COMPLETION` on an ended attempt: the owner has not decided
  between "credit by hand" and "nothing" (`OQ-WP11A-03`).
- Reconcile's replay is NOT changed to return a stored response body: it returns the
  payment as it stands, which for a decided payment is the decision; storing a whole detail
  response would freeze evidence the page is meant to show current. Recorded, not changed.

## 3. E6 — the receipt flow, end to end

### 3.1 Audit

| Brief item                | Finding                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| simple, image-first input | Already: one tap «✅ پرداخت را انجام دادم \| ارسال رسید» records the claim and opens the window; the prompt asks for an image (E7); a document is still accepted (refusing it would be its own contract change).                                                                                                                                           |
| exact 30-minute copy      | Already correct, and now pinned (`tests/unit/receipt-window.test.ts`, which had no test): the window is the sooner of 30 minutes and the payment's deadline, the sentence carries the server's figure, a part-minute is rounded UP, never to zero, and no window is promised past the deadline.                                                            |
| consistent approve/reject | Already: approve, reject (reason captured, restated, confirmed) and credit (amount captured, restated, confirmed) are one conditional PENDING edge each, mutually exclusive, and a stale tap answers WHICH way it was decided (WP10 follow-up §5, `receipt-dispositions.test.ts`, `receipt-block-reject.test.ts`). Approve is one tap by File 01's design. |
| stable tracking code      | **Gap fixed.** The invoice carried the code, and the receipt flow EDITS the invoice into `bot.payment.received_for_review` — which had no code. The one code the customer quotes vanished from the chat at the moment they would need it; the rejection and the expiry notices did not carry it either.                                                    |
| duplicate actions         | Already: a redelivered update, the same file again and a further file send nothing new (A10); duplicate approve/reject/credit taps decide once.                                                                                                                                                                                                            |
| expired window remedy     | **Gap fixed.** `bot.payment.receipt_expired` told the customer to press «ارسال رسید» on the payment message — but the receipt prompt had already edited that button away, so the remedy named a button that existed nowhere.                                                                                                                               |

### 3.2 What changed

- `bot.payment.received_for_review`, `bot.payment.rejected`, `bot.payment.expired` gain an
  optional `{reference}` (contract commit), rendered as «کد پیگیری پرداخت: …». Every producer
  supplies it: the claim reply, both invoice finalisations (the receipt turn and the prompt
  turn that settles a race), and the notification lane for PAYMENT_REJECTED,
  PAYMENT_EXPIRED and the PAYMENT_TRANSFER_RECORDED fallback — read from the payment the
  notification names, never a payload (ADR-0030 §1). An unreadable code drops the line.
- A receipt that arrives after its window closed is answered with `bot.payment.receipt_expired`
  AND the «send receipt» button for that payment, while the payment can still take one
  (PENDING, inside its deadline). The tap is the ordinary one: a new key, a new window. A
  payment that can no longer take a receipt is answered `bot.payment.not_pending`, with no
  button. Nothing about money changed: the button opens a window, never a decision.

## 4. Falsification

`scripts/mutate-payments-ops-ux.py` reverts one rule at a time and runs the named test; the
results of the last run are in §4.1.

### 4.1 Results

Run on `nexa_test_pay` at the head of `roadmap/payments-ops-ux`: **21 of 21 killed**.

| #      | Rule reverted                                                            | Named test                                    |
| ------ | ------------------------------------------------------------------------ | --------------------------------------------- |
| SIT-01 | a late completion on an ended attempt outranks how it ended              | unit `payment-situations` — killed            |
| SIT-02 | a credited receipt is not a rejection                                    | unit — killed                                 |
| SIT-03 | an UNKNOWN tells the customer not to pay again                           | unit — killed                                 |
| SIT-04 | a refund only where `REFUND_METHOD_SUPPORT` has a channel                | unit — killed                                 |
| SIT-05 | reconciliation only on an UNKNOWN gateway payment                        | unit — killed                                 |
| SIT-06 | an open refund is `REFUND_IN_PROGRESS`, ahead of a completed one         | integration `payment-situations` — killed     |
| SIT-07 | late money on an ended attempt is not work (the queue drains)            | unit — killed                                 |
| SQL-01 | NEEDS_ACTION excludes a PENDING provider review                          | integration — killed                          |
| SQL-02 | NEEDS_ACTION excludes late money on an ended attempt                     | integration — killed                          |
| SQL-03 | an open refund is REQUESTED or AWAITING_EXTERNAL, never FAILED           | integration — killed                          |
| SQL-04 | the situations read charges `payments.view`                              | integration — killed                          |
| WEB-01 | NEEDS_ACTION leads the chips                                             | web `payment-situations` — killed             |
| WEB-02 | the detail shows the guidance card                                       | web — killed                                  |
| WEB-03 | the row renders the server's situation, never one derived from the state | web — killed                                  |
| E6-01  | the expired-window reply carries the send-receipt button                 | integration `telegram-payment-flow` — killed  |
| E6-02  | no button for a payment past its own deadline                            | integration — killed                          |
| E6-03  | the receipt turn's final invoice carries the tracking code               | integration — killed                          |
| E6-04  | the prompt turn's final invoice carries the tracking code                | integration — killed                          |
| E6-05  | the expiry notice carries the tracking code                              | integration `customer-notifications` — killed |
| E6-06  | the rejection notice carries the tracking code                           | integration — killed                          |
| E6-07  | the window's minutes are rounded UP                                      | unit `receipt-window` — killed                |

Not covered by mutation, stated rather than hidden: the claim reply's tracking code on the
path where no window can be opened (`receiptWindow === null` in `signalTransferSent`) — the
same value as the two finalisations, unexercised by a Telegram-level test.

## 5. Manual acceptance — NOT RUN

Real Telegram and real providers were not exercised. On a staging bot:

1. **Receipt flow, tracking code.** Order → card-to-card → «پرداخت را انجام دادم | ارسال
   رسید» → send a photo. Expect the invoice edited into «اعلام شما ثبت شد…» ending in
   «کد پیگیری پرداخت: <the same code the invoice showed>», then ONE «رسید شما دریافت شد…».
2. **Expired window.** Open the prompt, wait 30 minutes (or shorten the payment window),
   send a photo. Expect «مهلت ارسال رسید به پایان رسید…» with the «پرداخت را انجام دادم |
   ارسال رسید» button; tap it, send the photo again; expect it filed and the one
   «رسید شما دریافت شد…». After the payment's own deadline, a late photo answers
   «این پرداخت دیگر در انتظار نیست.» with no button.
3. **Rejection and expiry notices** carry «کد پیگیری پرداخت: …» matching the invoice.
4. **Web Admin** `/payments?queue=NEEDS_ACTION`: a signalled transfer, an UNKNOWN gateway
   payment and an open manual refund are listed oldest first; reconciling the UNKNOWN or
   completing the refund removes it from the list and the chip count.
5. **Situation card** on an UNKNOWN TonPays payment reads «نتیجه نامعلوم», money «شاید پول
   جابه‌جا شده باشد», customer «منتظر بماند و دوباره پرداخت نکند», actions ask-again and
   reconcile; on an expired TonPays attempt with a late completion it reads «تأیید دیرهنگام
   درگاه» and names the wallet adjustment as undecided policy.

## 6. Open questions

- `OQ-WP11A-03` (existing) decides whether late or partial money on an ended attempt gets a
  domain resolution. If it does, that resolution's exit can join `NEEDS_ACTION`.
- **OQ-E6-01** — the invoice labels the code «شناسه فاکتور» (the owner's invoice layout)
  while every later message labels it «کد پیگیری پرداخت». Both print the same
  `payments.reference`. Unifying the label is a copy decision for the owner.
