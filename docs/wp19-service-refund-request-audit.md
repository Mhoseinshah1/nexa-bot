# WP19 — Customer service refund request: audit and design

The owner's brief (§2) asks for a customer-initiated request to cancel a service and have
money returned. An administrator chooses how much of the principal comes back. The money is
credited to the customer's Nexa wallet, and only after the provider account is deleted.

This document separates three things:

- what the owner decided;
- what existing rules already fix;
- what this package had to choose on technical grounds.

Each choice was made conservatively, against the invariants in `CLAUDE.md`.

## 1. What already exists

| Piece                          | Where                                                                                                                                         | What WP19 takes from it                                                                                                                                                                                                                                                                      |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A refund as financial evidence | `refunds` table; `RefundService`; `packages/contracts/src/refunds.ts`                                                                         | The row. A `REQUESTED` refund RESERVES its amount (`REFUND_CONSUMING_STATES`), so a second refund of the same payment cannot overrun it. `REQUESTED → COMPLETED` exists for the wallet channel; `REQUESTED → FAILED` releases the amount.                                                    |
| The refund bound               | `RefundService.request`: `lockPayment`, then `consumptionFor`, then `refundFitsWithin`                                                        | The same two steps in the same order, under the same payment lock. The bound is on `payments.amount`, which since WP18 is the PRINCIPAL alone. The customer fee lives in its own snapshot columns, so a fee can never be inside the bound.                                                   |
| Cashback and referral reversal | `cashback.reverseForRefund`, `referrals.reverseForRefund`                                                                                     | Called on completion, after the credit, exactly as a wallet refund calls them.                                                                                                                                                                                                               |
| The financial log              | WP18 `FinancialLogConsumer`                                                                                                                   | A `RefundCompleted` / `RefundFailed` already logs the money. A new `ServiceRefundRequestResolved` logs the workflow's outcome.                                                                                                                                                               |
| Provider deletion              | `TERMINATE` operation. The executor calls `finishTerminate`; a success moves the service to `TERMINATED` and writes `ServiceStateChanged`.    | This is the deletion. WP15's provenance rules apply unchanged: an `ACTIVE`, `SUSPENDED` or `EXPIRED` service had a SUCCEEDED create. `terminateWithoutProvider`, the no-provenance path, runs only for `PENDING_PROVISION` and `UNRECONCILED`, and those are not eligible here.              |
| Ambiguous delete               | `IDEMPOTENT_MUTATIONS` includes `TERMINATE`. A failure is `FAILED`, retried with back-off while `PROVIDER_FAILURE_RETRYABLE`; 404 is success. | An ambiguous DELETE is settled by retrying the same idempotent delete of an account we created. That is not a blind replay: it deletes the one account whose provenance is recorded, and "already gone" is success. While the operation is retrying, the request waits; nothing is credited. |
| Earn-at-delivery sweep         | WP8/WP9: `ProvisionerLoop` drives `cashback.settleDue` and `referrals.settleDue`                                                              | The request settles the same way: a sweep on the provisioner tick decides requests whose `TERMINATE` operation has become terminal. No hook is added at the executor's success site (WP8's rule: "never by hooks at each success site").                                                     |
| Admin DM card                  | WP10 receipt push (ADR-0031): consumer, then push rows, then worker lane                                                                      | Mirrored for the review card. Recipients are administrators with a Telegram binding who hold both decision permissions.                                                                                                                                                                      |
| Admin typed input              | `admin_amount_captures` + `ADMIN_CAPTURE_PURPOSES`                                                                                            | Two new purposes: the amount, and the rejection reason.                                                                                                                                                                                                                                      |
| Customer typed input           | `customer_text_captures` + `CUSTOMER_CAPTURE_PURPOSES`                                                                                        | One new purpose: the customer's reason (`subject_id` is the service).                                                                                                                                                                                                                        |
| Customer lane                  | `CUSTOMER_NOTIFICATION_KINDS` (CHECK-pinned), with values read from the subject row at send time (the `PAYMENT_REJECTED` precedent)           | Three new kinds: REGISTERED, APPROVED and REJECTED. Their values are read from the request row.                                                                                                                                                                                              |
| Feature flag                   | `features.ts` (the `customer_link_rotation` precedent: default off, `TENANT_WIDE`)                                                            | `customer_refund_requests`, default off. It appears in Web Admin's feature list with no new page.                                                                                                                                                                                            |

**Found:** a `TERMINATED` service stays in the customer's list. Every customer query
(`pageForCustomer`, `countForCustomer`, `searchForCustomer`, `getForCustomer`) filters only
by tenant and customer. §2.8 requires the service to leave the list after a successful
refund. That is scoped to this workflow: see T5.

## 2. Owner decisions (brief §2), and where each lands

| Decision                                                                                                                                           | Implementation                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A setting, default off; the button absent when off; stale callbacks fail safely; in-progress requests stay reviewable                              | Flag `customer_refund_requests`. The customer paths check it inside their transaction. The admin paths deliberately do not: a request already filed can still be decided.           |
| `درخواست بازگشت وجه` → info + `✅ تأیید درخواست بازگشت وجه` → reason capture                                                                       | Three customer steps. Only the last one writes.                                                                                                                                     |
| Reason required, trimmed, 3–500 code points, durable, one open request per service, replay safe                                                    | A CHECK constraint on the column; a partial unique index on `(tenant, service)` over the non-terminal states; `open` answers an existing open request instead of creating a second. |
| Not offered for a trial, a terminal service, one with an open request, one that cannot be deleted, or one whose source cannot be resolved          | One evaluator, `decideRefundRequestEligibility`. It is called for the button (a courtesy), at filing, at approval preview and at approval.                                          |
| The source is the original confirmed `NEW_SERVICE` payment. Admin chooses the amount, > 0, ≤ the remaining principal. The fee is never refundable. | The source is resolved from `services.order_id`: order `purpose = NEW_SERVICE`, and the order's own CONFIRMED payment. It is re-checked under the payment's lock at approval.       |
| A four-button admin card                                                                                                                           | Approve / reject open captures. "View user" and "view service" reuse the existing admin navigation callbacks.                                                                       |
| Approve: amount capture → lock and revalidate → one destructive confirmation → execute                                                             | The amount is stored on the capture row. The confirmation callback names the capture, never the figure.                                                                             |
| Refund to the Nexa wallet whatever the method                                                                                                      | Channel `WALLET_CREDIT` for every method. The refund's `reason` is the constant `SERVICE_REFUND_REQUEST`. The request row carries the customer's reason and the admin's decision.   |
| Delete before credit, exactly once. UNKNOWN or ambiguous: no credit. Definitive failure: no credit, operator-visible. Hide only after success.     | See §3.                                                                                                                                                                             |
| Reject: mandatory reason; terminal, stored, customer told, nothing deleted, nothing moved                                                          | `OPEN → REJECTED` as one conditional UPDATE.                                                                                                                                        |
| Customer notifications: registered, approved (exact amount + removal), rejected (+ reason). Never a false "completed".                             | Registration is the interactive reply to the reason message. APPROVED and REJECTED go through the lane.                                                                             |
| Every final outcome in the WP18 log                                                                                                                | `ServiceRefundRequestResolved {COMPLETED \| REJECTED \| FAILED}` goes to `FinancialLogConsumer`.                                                                                    |
| Durable without Telegram; minimal Web Admin fallback                                                                                               | The row is the record. On the service page, a card lists requests and offers approve and reject. The services list names open requests. There is no global browser.                 |

## 3. The state machine

```
            reject (reason)                       sweep: TERMINATE SUCCEEDED
   OPEN ─────────────────────▶ REJECTED        ┌──────────────────────────▶ COMPLETED
     │                                          │   (credit once, reversals,
     │ approve (amount, final confirm)          │    hide, customer told)
     └──────────────────────▶ EXECUTING ────────┤
                                                │   sweep: TERMINATE FAILED/ABANDONED
                                                └──────────────────────────▶ FAILED
                                                    (refund released, no credit,
                                                     operator-visible, logged)
```

- **OPEN.** Filed by the customer. No refund row exists, nothing is reserved and no
  operation is planned.
- **EXECUTING.** In ONE transaction, under the request lock then the payment lock:
  - a `REQUESTED` `WALLET_CREDIT` refund of the approved amount is created. It holds the
    amount against the payment, so a concurrent partial refund sees it;
  - a `TERMINATE` operation is planned;
  - the request records the amount, the refund id, the operation id, the admin and the time.
  - No money has moved.
- **COMPLETED.** The sweep found the operation SUCCEEDED and the service TERMINATED. In ONE
  transaction:
  - the refund goes `REQUESTED → COMPLETED` (conditional), with one `REFUND` ledger credit
    on reference `<refundId>:refund` (the wallet's own unique backstop);
  - cashback and referral reversals run;
  - the customer's APPROVED notification is queued;
  - `RefundCompleted` and `ServiceRefundRequestResolved` are written;
  - the request goes `EXECUTING → COMPLETED` (conditional).
    A replay finds the request no longer EXECUTING and does nothing.
- **FAILED.** The sweep found the operation FAILED (a non-retryable refusal, or the
  attempt ceiling) or ABANDONED. The refund goes `REQUESTED → FAILED`, which releases its
  amount. The request records the operation's failure kind. Nothing is credited and the
  customer is told nothing false. An operator can see the row on the service page and in
  the log. The customer may file again, because FAILED is terminal and frees the one-open
  slot.
- **UNKNOWN operation, or SUCCEEDED without the service TERMINATED.** The request stays
  EXECUTING and nothing is credited. The Web card shows the operation's state. This is the
  "never credit on ambiguity" rule, with no automatic exit.

## 4. Technical choices

- **T1 — reserve at approval, not at completion.** The brief requires "obeys existing
  partial-refund concurrency". Reserving through an existing consuming state (`REQUESTED`)
  means the existing bound, the existing sum and the existing lock decide both refunds.
  No second counter is introduced.
- **T2 — a sweep, not a hook.** A crash between deletion and credit costs one tick, never
  the credit: the request is durably EXECUTING and the operation durably SUCCEEDED.
- **T3 — two new `RefundService` methods** (`reserveForServiceRefund`,
  `settleServiceRefund`) that run inside the caller's transaction. They reuse
  `creditWallet`, `completed`'s order rule, the reversals and `announce`. The channel is
  `WALLET_CREDIT` by product rule (brief §2.7), stated as a constant beside
  `AUTOMATIC_REFUND_CHANNEL`. `REFUND_METHOD_SUPPORT` is untouched, so an operator's own
  refund of a gateway payment is still refused.
- **T4 — permissions.** Deciding needs `refunds.issue` (it moves money) AND
  `services.terminate` (it deletes an account). The push goes only to administrators holding
  both. No new permission is added.
- **T5 — hiding.** The customer queries exclude a service that has a COMPLETED refund
  request (`NOT EXISTS`). A service an operator terminated for another reason stays visible,
  as today.
- **T6 — the customer's REGISTERED sentence is the interactive reply.** A
  lane notification as well would tell the customer the same fact twice. The lane kind
  `SERVICE_REFUND_REQUEST_REGISTERED` exists only as that reply's fallback: when Telegram
  answers the interactive send with a rate limit, the reply is queued once (the 4J-2
  mechanism) rather than lost. APPROVED and REJECTED arrive later, asynchronously, so they
  always go through the lane.
- **T7 — the generic refund notice is suppressed.** `settleServiceRefund` completes the
  refund with `notifyCustomer: false`. The APPROVED notice already names the amount and the
  removal, so `REFUND_COMPLETED` as well would be the same money told twice.
- **T8 — an operator cannot settle the reservation by hand.** `RefundService.complete`
  and `fail` refuse a refund whose reason is `SERVICE_REFUND_REQUEST`
  (`REFUND_STATE_INVALID`). Only the request's sweep settles it. Otherwise an operator
  could credit money before the deletion, or release a reservation whose deletion is still
  in flight.
- **T9 — rejection is immediate.** Once the administrator has typed the reason, the
  rejection is written. There is no second confirmation (brief §2.9). The destructive
  confirmation belongs to approval alone.

## 5. Surfaces

- **Telegram, customer.** Row four of the service detail offers `درخواست بازگشت وجه` when
  `customerOffer` answers OFFERED, or states that a request is pending. `fa:` shows the
  explanation. `fb:` opens the reason capture. The reason message files the request, and
  a reason out of bounds reopens the capture.
- **Telegram, administrator.** The review card is pushed to every bound administrator who
  holds both decision keys. `qa:` opens the amount capture. The typed amount is validated
  under the payment's lock and answered with one destructive confirmation, `qc:<capture>`.
  `qb:` opens the reason capture, and the reason rejects. `qd:<capture>` cancels either
  prompt. View user and view service reuse `9:v:` and `I:`. A stale, forged or replayed
  tap decides nothing.
- **Web Admin.** On the services list, a read-only card of requests that are OPEN,
  EXECUTING or FAILED. On the service page, the service's requests, with approve (amount
  plus a confirmation checkbox) and reject (reason) for the one that is OPEN. HTTP:
  `GET /service-refund-requests`, `GET /services/:id/refund-requests`,
  `POST /service-refund-requests/:id/approve` (the body must carry `confirm: true`) and
  `POST /service-refund-requests/:id/reject`. Reading needs `refunds.view`; deciding needs
  both keys.

## 6. Evidence

- `tests/integration/service-refund-requests.test.ts` covers every row of §2, the races
  (concurrent filing, two approvers, approve against reject, a concurrent operator partial
  refund), tenant isolation, and the deletion outcomes: success, ambiguity, definitive
  failure, and SUCCEEDED without the service moving.
- `tests/web/service-refund-requests.test.tsx` covers the Web Admin fallback.
- `docs/wp19-falsification.md` records each rule reverted and the test that failed.

## 7. A rollback to the release before WP19

A read of what that release does with WP19's rows found nothing that crashes, retries for
ever or refuses a whole page. Four things behave differently while it runs, and
`docs/deployment.md` lists them with the query to run before rolling back:

- an executing request is not credited until the roll-forward;
- a new request's review cards are not sent;
- a reason typed across the rollback lands in the service note;
- an operator can close a reservation by hand through a hand-made API call.

That last one needed code. After the roll-forward, a reservation closed COMPLETED with no
credit would have been announced as credited, and one closed FAILED would have thrown on
every tick and held every later request behind it. So `settleServiceRefund` answers a
COMPLETED reservation only when its own `<refundId>:refund` entry exists, and refuses one
without it. `settleDue` also decides each request in its own guarded transaction, so a
refusal leaves that request EXECUTING for an operator and the sweep moves on (W19-22,
W19-23).

## 8. The first Codex review of #83

It found six issues. All were real, and each is fixed with a named test and a killed mutation
(W19-24 to W19-29):

- **Stuck rows could fill every batch (P1).** The sweep query returned the oldest
  EXECUTING rows whose deletion was terminal, including rows it would only refuse. Fifty of
  those ahead of a valid refund held it back for ever. The query now returns only what the
  sweep can decide: a SUCCEEDED deletion whose service moved, with the reservation still
  REQUESTED, or a failed one whose reservation is REQUESTED or released.
- **A pushed card whose buttons could not work (P1).** The card is pushed to administrators
  holding `refunds.issue` and `services.terminate`, but the prompts read the request under
  `refunds.view`. They now read it under the same two keys. They show nothing the card did
  not.
- **A reservation recognised by free text (P2).** An operator's refund whose typed reason
  happened to be `SERVICE_REFUND_REQUEST` was refused completion and failure. A reservation
  is now known by its link from a `service_refund_requests` row.
- **A rejection that a crash could strand (P2).** The reason was recorded on the prompt
  first, then the request rejected. A crash in between left a prompt no message could reach
  and a request still OPEN. The rejection is now written first. It replays on the same
  reason, so the redelivered message finishes it, and a database trigger in the test holds
  the order.
- **A replayed confirmation said "started" after the end (P2).** It now answers CLOSED when
  the request is past EXECUTING.
- **The attention card filtered a truncated page (P2).** It now asks the server once per
  state that wants an operator, so the server filters before it limits.

Because the query now excludes what the in-code guards refuse, W19-01 and W19-22 are paired
rows (see the falsification record).

## 9. The second Codex review of #83

It found five issues. All were real, and each is fixed with a named test and a killed mutation
(W19-30 to W19-40):

- **A rejection whose prompt had been cancelled (P1).** The reason prompt was read, and the
  request rejected, in different transactions. A cancel or a new prompt committed between the
  two still let the old prompt reject. The rejection now runs inside the prompt's transaction
  (`rejectWithin`), under the administrator's capture lock that `cancel` and `open` take, and
  only while the prompt is still open. Its close commits with it, so neither half can be left
  without the other. This supersedes the round-1 ordering (W19-28), which was the gap: it
  made the rejection commit first.
- **An approval that read a service already ended (P2).** Eligibility was read without a lock,
  under `READ COMMITTED`, so a termination committing `TERMINATED` in between was seen as
  ACTIVE. The approval then reserved money and planned a second deletion, which the sweep
  would credit. The approval now takes the service's row lock before it reads eligibility, and
  holds it until the deletion is planned. The lock is taken service first, then payment — the
  order the executor already uses — so it adds no cycle.
- **A confirmation shown for an approval that would refuse (P2).** The amount preview checked
  only the payment's bound. It now applies the approval's own executability rule: the shared
  eligibility evaluator and the request's source payment.
- **Malformed ids reached PostgreSQL (P2).** A request id is validated as a UUID before any
  query. The service answers with not-found, and the HTTP boundary parses the approve, reject
  and per-service path ids (400).
- **One page per state (P2).** The list takes a keyset cursor (`before`/`beforeId`, both or
  neither) and returns `nextCursor`. The attention card follows the cursor to the end of each
  state, so the oldest undecided request is always shown. The per-service list is not paged. A
  service has at most one active request, and it is always the service's newest row, so the
  first page holds it.

The re-run of the whole driver also found W19-02 alive. Since round 1, the sweep query admits
only a SUCCEEDED or FAILED/ABANDONED deletion, so adding UNKNOWN to the terminal states alone
changes nothing. W19-02b reverts that and the query's failure clause together.

It also found that the falsification record claimed a W19-14b row that the driver never had.
Added, the row survived: the rejection is guarded three times — the early state check, the
conditional UPDATE, and the `service_refund_requests_rejected_check` CHECK. W19-14c reverts
all three (the driver lifts the CHECK for that one row and restores it), and the race test
dies.
