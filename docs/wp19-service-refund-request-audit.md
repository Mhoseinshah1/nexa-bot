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

## 10. The third Codex review of #83

It found five issues. All were real, and each is fixed with a named test and a killed mutation
(W19-41 to W19-45):

- **A decision reported as denied after it committed (P1).** The HTTP response re-read the
  decided request through the list, charged `refunds.view`. A decider holding only the two
  decision keys was told "denied" for money already reserved and a deletion already planned.
  The response is now read under the decision keys (`decidedView`).
- **A confirmation that outlived its refusal (P1).** A capture stays CONFIRMED so that a crash
  between the close and the approval is finished by the next tap. That also let a tap long
  after a refusal the administrator had been shown carry out the approval, once the panel or
  the payment's bound recovered. A definitive refusal now retires the capture
  (`CONFIRMED -> SUPERSEDED`). An unclassified error leaves it CONFIRMED, so a retry of an
  indeterminate failure is still the same approval.
- **A prompt closed by a transient failure (P2).** The reason prompt was closed before the
  error was classified. It is now closed only after `refusalOf` has proved the request decided
  or not actionable. Anything else is rethrown with the prompt still open.
- **A filing that read a service already ended (P2).** Filing now takes the service's row lock
  before reading eligibility, as the approval does.
- **A redelivered filing after its request was decided (P2).** The partial unique index
  deduplicates only while a request is live. Filing now takes an idempotency key — the update
  that carried the reason — which is stored on the request and unique for ever
  (`service_refund_requests_filing_key`, folded into the unmerged migration 0125). This also
  brings the filing in line with the rule that every state-changing command takes one.

## 11. The fourth Codex review of #83

It found seven issues. All were real, and each is fixed with a named test and a killed mutation
(W19-46 to W19-54):

- **A cause the previous release cannot read (P1).** WP19 had added `DELETION_FAILED` to
  `RefundFailed.cause`. The release before WP19 parses that payload with its two-value enum, so
  an event written here and relayed after a rollback would fail its financial-log consumer on
  every pass. A contract commit returns the enum to its two values (a unit test pins them), and
  a released reservation writes no `RefundFailed`. Its financial-log line is
  `ServiceRefundRequestResolved` FAILED, a type that release never routes.
- **Two deletions planned for one service (P1).** The approval planned its `TERMINATE` under
  the service's row lock, but an operator's terminate did not take it, and nothing else keys an
  open `TERMINATE`. Both could pass `findOpen`, and the request would be bound to whichever
  deletion ran second, which fails against a removed account. Now every `TERMINATE` planner
  takes the service's row lock before `findOpen`, and judges the state from the locked row.
- **A panel read on a second connection (P2).** The approval's operability read now uses its
  own transaction.
- **A filing that read a payment already refunded (P2).** Filing re-decides eligibility under
  the source payment's lock. The order is service before payment, the executor's order. An
  operator's full refund that commits mid-filing now files nothing.
- **A redelivered amount answered with nothing (P2).** An entered amount is remembered against
  its Telegram message (`request_idempotency`, namespace `TELEGRAM`). A redelivery restates the
  same confirmation while the prompt is still open and its request still OPEN.
- **An amount prompt closed by a transient failure (P2).** The prompt closes only for a request
  that is gone or decided. Any other failure propagates with the prompt kept, as the reason
  prompt already does.
- **Web decision keys that were never recorded (P2).** Approve and reject record their keys in
  `request_idempotency` (namespace `WEB`). A retry is answered with the request it decided. A
  key reused for another request, amount or reason is refused as a payload mismatch and decides
  nothing.

## 12. The fifth Codex review of #83

It found four issues. All were real, and each is fixed with a named test and a killed mutation
(W19-55 to W19-61):

- **A redelivered message routed to a newer prompt (P1).** Telegram redelivers an update it did
  not see answered, and every capture reads plain text. Round 4 remembered an entered amount,
  but a replay whose prompt had since closed fell through to whatever prompt was open. A
  rejection is decided on its reason at once, so an old amount could reject an unrelated
  request.
  - A known replay is now answered from the prompt it filled and goes nowhere else.
  - The reason path records its message too.
  - The general rule is enforced in the other direction as well: a refund-request prompt
    reads only a message whose Telegram `update_id` is newer than the tap that opened it.
    Update ids increase per bot, so no message typed before the tap can become this prompt's
    amount or reason, whichever capture it was typed for.
  - The tap's id is stored on the capture: `admin_amount_captures.opened_update_id`, nullable,
    folded into the unmerged 0125.
- **An order audit that contradicted the settlement (P2).** A service refund request settles
  only after its deletion succeeded, but a settlement that exhausted the payment audited the
  order as `serviceLeftUntouched: true`. It now records `serviceRemovedByRequest: true`.
- **A stale registration notice (P2).** A `SERVICE_REFUND_REQUEST_REGISTERED` held back by a
  rate limit could arrive after the decision. The notice renders only while the request is
  OPEN; after the decision there is nothing to send.
- **A queue hidden from its own permission (P2).** The Web Admin queue and a service's request
  card were drawn only for `services.view`. They are now drawn for `refunds.view` alone, and the
  Services entry in the navigation opens for either key. The services list itself is still
  `services.view`'s, and is never fetched without it.

## 13. The sixth Codex review of #83

It found four issues. All were real, and each is fixed with a named test and a killed mutation
(W19-62 to W19-73):

- **A release after another deletion removed the service (P1).** The sweep decided from the
  request's own operation alone. If that deletion failed and an operator's retry then removed
  the account before the sweep ran, the reservation was released: the customer lost the
  service and the refund the administrator approved.
  - The sweep now locks the service (request before service, the approval's order).
  - A service that is TERMINATED while the reservation is still `REQUESTED` is completed and
    credited, whichever TERMINATE removed it.
  - While another TERMINATE of the service is `PLANNED` or `IN_FLIGHT`, the sweep waits for its
    answer, and its query skips the row so it cannot fill a batch.
  - It releases only when this request's own deletion definitively failed and nothing else is
    deleting.
  - A reservation already released by hand (the release before WP19) is released again,
    never credited.
  - Every TERMINATE planner takes the same service lock before `findOpen` (round 4). A
    deletion planned after the sweep decided is an operator acting on a request already shown
    as FAILED.
- **A redelivered reason told "registered" after its request moved on (P2).** Filing answers a
  redelivery with its own request in any state (round 3), but the runtime rendered every
  answer as a registration. An approved request still deleting is now answered as pending. A
  decided one shows the service as it now stands, or `not_found` once a completed request has
  hidden it. The decision itself reached the customer through the lane.
- **An anonymous wallet credit (P2).** The sweep acts as the system, so the ledger entry it
  wrote had no `actor_admin_id`. The credit now names the approving administrator, the
  refund's `requested_by_admin_id`. The audit row and the event keep the system actor that
  performed the sweep.
- **Three scans that could miss a moving request (P2).** The Web Admin attention card read
  OPEN, EXECUTING and FAILED as three keyset scans at three moments. A request moving between
  two of them could be on no page. A contracts commit adds `attention=true` to the list query:
  one keyset stream over `SERVICE_REFUND_REQUEST_ATTENTION_STATES`, exclusive with `state`. No
  transition changes `(createdAt, id)`, so each request is on exactly one page, in the state it
  had there.
