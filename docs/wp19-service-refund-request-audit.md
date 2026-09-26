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
| Customer lane                  | `CUSTOMER_NOTIFICATION_KINDS` (CHECK-pinned), with values read from the subject row at send time (the `PAYMENT_REJECTED` precedent)           | Two new kinds, APPROVED and REJECTED. Their values are read from the request row.                                                                                                                                                                                                            |
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
  lane notification as well would tell the customer the same fact twice. APPROVED and
  REJECTED arrive later, asynchronously, so they belong to the lane.
