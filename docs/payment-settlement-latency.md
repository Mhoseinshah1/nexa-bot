# Payment settlement latency (FIX-03, 2026-10-09)

The owner's report: «پرداخت شما توسط درگاه تأیید شد» arrived at 09:37, and the message
with the amount and the tracking code at about 09:39. This document traces the path from a
gateway's answer to the customer's final message, names the delay, and records what was
changed and what remains outside our control.

## 1. Root cause

The two messages come from two different lanes, and the second one waited for a timer.

1. **«تأیید شد» is an edit, made in the settling pass.** The gateway lane
   (`GatewayPaymentService.runOnce`, every `GATEWAY_PAYMENT_INTERVAL_MS` = 3 s) asks the
   provider, hands an approval to `PaymentService.confirmGatewayPayment`, and — once that
   transaction has committed — calls `refreshScreens`, which edits the customer's invoice
   message into `bot.payment.gateway_confirmed`. Telegram shows an edited message with the
   time it was first SENT (the invoice), not the time of the edit, so «09:37» is the
   invoice's time, not the approval's.
2. **The amount and the tracking code are a notification row.** The same transaction that
   credits the wallet (`confirmAndCredit`: the payment `CONFIRMED`, the `TOPUP_GATEWAY` or
   `TOPUP_RECEIPT` entry, the gift, the outbox events) enqueues `WALLET_TOPUP_CREDITED`,
   due at once (`next_attempt_at` NULL). The ledger and the row commit together; nothing in
   the money path waits.
3. **The row then waited for the customer notification lane's next pass.**
   `CustomerNotificationLoop` ran every `CUSTOMER_NOTIFICATION_INTERVAL_MS` = **60 s**, so a
   credit committed just after a pass was sent up to a minute later — uniformly 0–60 s,
   30 s on average, plus the pass's own work.

Measured against a real database with the production loop (§4): 60.03–60.06 s from the
credit's commit to the send when the commit falls right after a pass. Read on a phone that
shows minutes, a 60 s wait after an approval made in the minute after the invoice was sent
is «09:37» then «09:39».

Not the cause, checked: the outbox relay (1 s, and the customer's message does not go
through it), the operator notification dispatcher (2 s, operator messages only), the
provisioner (5 s, orders only), the ledger posting (same transaction as the approval), and
retries (a healthy send is a first attempt).

## 2. The path, per rail

Each row is one stage; the right-hand column is what schedules the next stage.

| Stage                      | TonPays / TonPays Telegram / NOWPayments / CentralPay                                                                                                                                                                                                                                                                                                                                      | Telegram Stars                                                                            | Card to card (manual receipt)                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 1. Approval reaches us     | The lane's inquiry: first at `FIRST_INQUIRY_DELAY_MS` (20 s) after the invoice is created, then `inquiryBackoffMs` (40 s, 80 s, 160 s, then 300 s), one last ask 15 s before the deadline. A webhook (NOWPayments IPN, TonPays callback), a CentralPay browser return or the customer's «بررسی وضعیت» tap brings it forward, no sooner than `INQUIRY_MIN_SPACING_MS` (5 s) after the last. | Telegram's `successful_payment` update, recorded on arrival.                              | An operator approves the receipt.                 |
| 2. Authoritative decision  | The provider's own inquiry (only the inquiry decides; a webhook is a hint).                                                                                                                                                                                                                                                                                                                | The recorded charge (Telegram's authenticated update).                                    | The operator's decision.                          |
| 3. State + ledger + notice | One transaction: `confirmGatewayPayment` → `confirmAndCredit` (top-up) or `confirmAndSettle` (order).                                                                                                                                                                                                                                                                                      | Same, via `settleRecorded`, straight after the update; the worker's pass is the backstop. | Same, via `confirmManualTransfer`.                |
| 4. «Approved» on screen    | `refreshScreens`, in the same lane pass, after the commit (edit in place).                                                                                                                                                                                                                                                                                                                 | —                                                                                         | The review card is answered in place.             |
| 5. Final message           | `WALLET_TOPUP_CREDITED`, sent by the customer notification lane's next pass.                                                                                                                                                                                                                                                                                                               | Same.                                                                                     | Same (`RECEIPT_CREDITED_TO_WALLET` for a credit). |

Order payments are not top-ups and are never announced as one: `confirmAndSettle` marks the
order `PAID` and writes `OrderSettled`; the provisioner (`PROVISIONER_TICK_MS`, 5 s) creates
the service and delivers it in the same tick. Renewal and add-on results go through the
customer notification lane and gain the same promptness as a top-up.

## 3. The change

- `CUSTOMER_NOTIFICATION_INTERVAL_MS`: 60 s → **2 s**. Shorter than the gateway lane's 3 s
  so the final message follows the approval it confirms rather than trailing it by a
  gateway interval. An idle pass is the stranded-send reap, the lapsed-subject read, the
  quiet-hours release and the claim — a handful of indexed statements against partial
  indexes built for them, the same order of work the gateway lane already does every 3 s.
- `CUSTOMER_NOTIFICATION_STALE_AFTER_MS` = 180 s: the worker's readiness tolerance for this
  lane, stated in time. It was three one-minute intervals; three two-second intervals would
  call a one-minute send backlog a stalled loop and fail a rollout.
- Unchanged, deliberately: the retry back-off and the attempt ceiling, the lease, the
  429 rule (the later of Telegram's `retry_after` and the lane's own 60 s back-off, WP20),
  the rule that an unknown send is never repeated, the claim's ordering (immediate kinds
  before reminders), quiet hours, and every money rule. No nudge across processes was
  added: the approval can commit in the API (Stars, an operator's approval) or the worker
  (the gateway lane), and the short pass covers both with no new mechanism.
- Not consolidated: the «approved» edit stays. It is the invoice message's own truthful end
  (it removes the pay button) and edits in place as before; the amount and the tracking
  code are a separate fact read from the ledger at send time. They now arrive seconds apart.

A defect found by the crash case and fixed in the same change: a worker that died between
the settlement's commit and the lane's `recordOutcome` left the approval scheduled against
a `CONFIRMED` payment, and the restarted pass recorded it as a `LATE_COMPLETION` — the
operator was told a paid invoice could no longer be settled, and the financial log carried
a late approval, for money credited exactly once. `settleApproved` now hands a confirmed
payment to the settlement path, which answers `ALREADY_CONFIRMED` under the payment's lock;
every other ineligible payment is still a late completion.

## 4. Measured

`tests/integration/payment-settlement-latency.test.ts`, the production loop and real
timers against a real PostgreSQL, the loop started at the commit (its worst phase: the first
pass is a whole interval away). Time from the credit's commit to the send handed to Telegram:

| Rail                  | Before (60 s cadence) | After (2 s cadence), three runs |
| --------------------- | --------------------- | ------------------------------- |
| Card to card (manual) | 60 057 ms             | 2 041 / 2 041 / 2 034 ms        |
| TonPays (full lane)   | 60 045 ms             | 2 056 / 2 053 / 2 038 ms        |
| NOWPayments           | 60 037 ms             | 2 031 / 2 021 / 2 033 ms        |
| CentralPay            | 60 027 ms             | 2 028 / 2 039 / 2 026 ms        |
| Telegram Stars        | 60 037 ms             | 2 032 / 2 050 / 2 072 ms        |

These are the WORST phase — a commit just after a pass. Over a uniformly random phase the
wait is half an interval on average: about 30 s before and about 1 s after, with the pass's
own work (20–70 ms here, a local database and a fake Telegram) on top. The "before" column
was measured by reverting the one constant; the per-rail tests time out at the old cadence.

A real Telegram call adds its own round trip (`sendMs` in the log line, §5), and a real
provider adds its confirmation time before any of this starts (§6).

## 5. Instrumentation and threshold

Every send logs one line, `customer notification latency`, with `queuedMs` (commit to the
send stamp), `sendMs` (the Telegram call) and `totalMs`, the kind, the subject and the
outcome (`notification-latency.ts`). A first attempt of an immediate kind whose `queuedMs`
exceeds `CUSTOMER_NOTIFICATION_LATENCY_WARN_MS` = **10 s** is logged at `warn` as
`customer notification waited longer than expected`, with the threshold.

The threshold is five intervals: the healthy worst case is one interval (2 s) plus the
pass's work (well under a second here), and ten seconds leaves room for a busy database and
a small backlog while still flagging every one-minute wait the old cadence produced. A
reminder held by quiet hours and a retry after a refusal wait by design and are not judged;
a send after a 429 is — that wait is Telegram's, and it should be seen.

The persisted breakdown, from existing columns, for one payment:

```sql
SELECT p.reference,
       gi.last_webhook_at,                           -- the provider's hint, if any
       gi.last_inquiry_at,                           -- the inquiry that decided
       p.confirmed_at,                               -- ledger + notice committed (one tx)
       gi.outcome_at,                                -- the lane recorded its outcome
       n.created_at   AS notice_queued_at,           -- = confirmed_at
       n.resolved_at  AS notice_sent_at,             -- Telegram's answer observed
       n.state, n.attempts,
       n.resolved_at - p.confirmed_at AS commit_to_message
  FROM payments p
  LEFT JOIN gateway_invoices gi ON gi.payment_id = p.id AND gi.tenant_id = p.tenant_id
  LEFT JOIN customer_notifications n
         ON n.tenant_id = p.tenant_id AND n.subject_id = p.id
        AND n.kind IN ('WALLET_TOPUP_CREDITED', 'RECEIPT_CREDITED_TO_WALLET')
 WHERE p.tenant_id = $1 AND p.id = $2;
```

## 6. What stays external, and is reported rather than hidden

- **The provider's confirmation time.** Without a webhook, an approval is seen at the next
  scheduled inquiry (20 s, then 40 s, 80 s, 160 s, 300 s). A webhook or the customer's
  status tap brings it to within 5 s. That is before the «approved» message and before the
  credit; this change does not touch it, because asking a provider more often spends the
  tenant's call budget and TonPays' own rate limit.
- **Telegram 429.** A rate-limited send is retried at the later of `retry_after` and 60 s,
  with no attempt spent. The send after it is logged at `warn` with its `queuedMs`.
- **An unknown Telegram outcome.** `UNCONFIRMED`, never resent: the customer may already
  have the message. The credit is unaffected.
- **A stopped or restarting worker.** Rows wait; a send stamped by a dead process is
  resolved `UNCONFIRMED`, never repeated; everything else is sent by the next pass after
  the restart.

No figure here is a promise of "the same second": the bound is one lane interval plus the
pass's work on a healthy installation.

## 7. The four stages, and how to read a field report (FIX-01, 2026-10-10)

The owner's later report — a purchase announced about 2 s after approval, a top-up's final
message 90–120 s after it — needs the delay split before anything is changed. Four stages:

| Stage                                    | Where it is measured                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Discovery (provider approval → seen)  | `gateway payment settlement latency` (lane, worker): `trigger`, `invoiceToDiscoveryMs`, `dueToDiscoveryMs`, `webhookToDiscoveryMs`, `inquiryAttempt`.                                                                                                                                                                                                                                                                                                                                                                        |
| 2. Settlement (seen → ledger committed)  | Same line, `discoveryToConfirmedMs`; `payments.confirmed_at`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 3. Announcement queued (committed → due) | Top-up: zero by construction — `WALLET_TOPUP_CREDITED` is enqueued IN the settling transaction (`customerMessage: NOTIFICATION_LANE`). A new service (`NEW_SERVICE`, `CUSTOM_SERVICE`): the provisioning operation, same transaction (`PROVISIONER`). A renewal, add-on, extra devices or location change: the commercial operation, same transaction; its RESULT is queued by the provisioner's outcome announcer once the operation succeeds (`PROVISIONER_THEN_NOTIFICATION_LANE`). The line's `orderPurpose` says which. |
| 4. Sent (due → Telegram answered)        | Top-up and commercial order: `customer notification latency` (`queuedMs`, `preSendMs`, `sendMs`), §5 — `SERVICE_RENEWED` / `SERVICE_ACTION_SUCCEEDED` for a commercial order, after the provisioner's tick. New service: the provisioner's tick (`PROVISIONER_TICK_MS`, 5 s) and `services.delivered_at`.                                                                                                                                                                                                                    |

The provider's own approval instant is **not knowable** here — no provider in this
repository reports one this installation can trust — so stage 1 is measured from the
invoice's creation and from the moment the row fell due, never from "when the customer paid".
The line carries identifiers and durations only: no amount, key, card, payload or link.

`trigger` says what made the discovering row due, derived from the claimed row
(`domain/inquiry-discovery.ts`): `WEBHOOK_HINT` (a webhook since the last inquiry),
`RECEIPT_ACK` (a TonPays Telegram receipt acknowledgement that opened a review),
`RECEIPT_UPLOAD` (a TonPays Telegram receipt accepted without an acknowledgement, or whose
answer was lost — it brings the inquiry forward too), `CUSTOMER_HINT` (the «بررسی وضعیت» tap
or a CentralPay browser return — the API logs `gateway status check brought an inquiry
forward` / `gateway browser return brought a verify forward` by payment id, which tells them
apart), `OPERATOR_RECHECK`, `SCHEDULED` (the schedule alone — after a rate-limited answer,
either its normal step or the 60 s floor), `STARS_UPDATE` (Telegram's `successful_payment`,
settled on arrival) and `STARS_RECOVERY` (the worker settling a recorded Stars payment the
update did not finish). For both Stars triggers `inquiryAttempt` is null: no inquiry found
them. A manual card-to-card approval is the operator's decision; its stage 1 is
`payment_receipts.created_at` → `payments.confirmed_at`.

**Which version a report was made on matters.** `v0.5.5` (`eb139bef`) runs the customer
notification lane every **60 s** (`CUSTOMER_NOTIFICATION_INTERVAL_MS`); `main` after #252
runs it every 2 s. On v0.5.5 a top-up's stage 4 alone is 0–60 s, and a new service's is not
(the provisioner sends directly, 0–5 s) — the top-up/purchase asymmetry. A renewal or add-on
pays both: the provisioner's tick, then the lane. 90–120 s needs 30–60 s
more than that, and on the current schedule it can only come from stage 1 (below), a
Telegram 429 (≥ 60 s), or a backlog in a 200-row lane pass. The query below says which.

Worst case per rail on `main`, a healthy installation, from the provider's approval:

Stage 4 for a renewal or add-on is the provisioner's tick (5 s) plus the panel call, then the
top-up column's lane wait.

| Rail                  | Stage 1, no hint                                                                                            | Stage 1, hinted                                                                                             | Stages 2–3 | Stage 4 top-up (v0.5.5 / main) | Stage 4 order           |
| --------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------ | ----------------------- |
| TonPays               | the gap to the next ask: 20 s, then 40, 80, 160, 300 s (asks at t+20, 60, 140, 300, 600 s …) + one 3 s pass | webhook / tap: ≤ 5 s spacing + 3 s pass                                                                     | same pass  | 60 s / 2 s                     | 5 s tick + panel create |
| TonPays Telegram      | before a receipt: as TonPays; after its acknowledgement: 120 s (first hour of review), 600 s to 6 h         | ack: next pass; webhook ≤ 8 s; tap ≥ 60 s                                                                   | same pass  | 60 s / 2 s                     | 5 s + panel             |
| NOWPayments           | as TonPays (chain confirmations dominate)                                                                   | verified IPN ≤ 8 s                                                                                          | same pass  | 60 s / 2 s                     | 5 s + panel             |
| CentralPay            | as TonPays                                                                                                  | browser return ≤ 8 s **once routed** (`/payments/return/*` was not routed by Caddy before batch 2026-10-10) | same pass  | 60 s / 2 s                     | 5 s + panel             |
| Telegram Stars        | 0 (Telegram's authenticated update)                                                                         | —                                                                                                           | inline     | 60 s / 2 s                     | 5 s + panel             |
| Card to card (manual) | the operator                                                                                                | —                                                                                                           | inline     | 60 s / 2 s                     | 5 s + panel             |

Plus, for every lane: a pass's creations (up to 5 × 15 s each) run before its inquiries, a
budget-exhausted provider defers an inquiry by 5 s, and a 429 from the provider moves it at
least 60 s. `tests/integration/payment-discovery-latency.test.ts` walks these on the real
schedule, pass by pass at the production interval, for an order and a top-up, through to the
delivery card (provisioner) or the amount-and-code message (lane).

### The per-payment query for a field report

```sql
-- One payment: every stage's timestamp — top-up, new service, or renewal/add-on. Ids and times only.
SELECT p.id, p.order_id IS NULL                         AS is_topup, o.purpose,
       p.gateway_provider, p.created_at                 AS payment_created_at,
       gi.created_invoice_at,                            -- the invoice the customer paid
       gi.last_webhook_at, gi.webhook_count,             -- did the provider call back at all?
       gi.callback_url_sent,                             -- did we send it a callback URL?
       gi.inquiry_attempts, gi.last_inquiry_at,          -- the inquiry that decided
       p.confirmed_at,                                   -- stage 2: ledger + state, one tx
       n.created_at  AS notice_queued_at,                -- stage 3 (top-up): = confirmed_at
       n.resolved_at AS notice_sent_at, n.state AS notice_state, n.attempts,
       s.created_at  AS service_created_at,              -- stage 4 (new service): provisioner
       s.delivered_at, s.delivery_state,
       op.completed_at AS operation_done_at,             -- stage 4 (renewal/add-on): provisioner …
       r.created_at  AS result_queued_at,                --   … then its result, queued
       r.resolved_at AS result_sent_at, r.state AS result_state,   -- … and sent by the lane
       p.confirmed_at - gi.created_invoice_at          AS invoice_to_confirmed,
       COALESCE(n.resolved_at, s.delivered_at, r.resolved_at) - p.confirmed_at AS confirmed_to_message
  FROM payments p
  LEFT JOIN gateway_invoices gi ON gi.tenant_id = p.tenant_id AND gi.payment_id = p.id
  LEFT JOIN customer_notifications n
         ON n.tenant_id = p.tenant_id AND n.subject_id = p.id
        AND n.kind IN ('WALLET_TOPUP_CREDITED', 'RECEIPT_CREDITED_TO_WALLET')
  LEFT JOIN orders o ON o.tenant_id = p.tenant_id AND o.id = p.order_id
  LEFT JOIN services s ON s.tenant_id = p.tenant_id AND s.order_id = p.order_id
       AND o.purpose IN ('NEW_SERVICE', 'CUSTOM_SERVICE', 'TRIAL')
  LEFT JOIN provisioning_operations op
         ON op.tenant_id = p.tenant_id AND op.order_id = p.order_id AND op.type::text = o.purpose::text
        AND o.purpose NOT IN ('NEW_SERVICE', 'CUSTOM_SERVICE', 'TRIAL')
  LEFT JOIN customer_notifications r
         ON r.tenant_id = p.tenant_id AND r.subject_id = op.id
        AND r.kind IN ('SERVICE_RENEWED', 'SERVICE_ACTION_SUCCEEDED')
 WHERE p.tenant_id = $1 AND p.id = $2;
```

Read it as: `last_webhook_at` NULL with `callback_url_sent` true means the provider never
called back and discovery waited for the schedule; `last_inquiry_at` far after the
customer's payment with a small `inquiry_attempts` is a backoff gap; `confirmed_to_message`
above a few seconds on a top-up or a renewal is the lane (60 s on v0.5.5, a 429, or a backlog — the
`customer notification latency` line for that payment says which). Then grep the worker's
log for the payment id: the settlement line gives the trigger and the durations directly.
