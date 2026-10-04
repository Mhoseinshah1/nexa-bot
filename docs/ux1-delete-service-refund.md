# UX/Admin Fix Batch 01, item 11 — delete a service, optionally with a refund

The owner's item: when an administrator presses «حذف سرویس», a modal offers

1. «فقط حذف سرویس» — delete only;
2. «حذف سرویس و بازگشت وجه» — delete, and return an amount to the customer's wallet.

The refund needs an amount in Toman with validation, a summary (service, customer, amount,
destination wallet) and an explicit final confirmation. It must be credited to the wallet
through a dedicated, auditable ledger operation with a tracking id, exactly once, never on a
failed or ambiguous provider deletion, and never by replaying the original payment.

This document is the audit that decided the design, then the design.

## 1. How deletion works today

- **The command.** `POST /services/:id/terminate` (typed phrase `TERMINATE`, permission
  `services.terminate`) calls `ProvisioningService.requestFromOperator(…, 'TERMINATE')`. It plans
  a `TERMINATE` operation under the service's row lock and the lifecycle lock, refuses while a
  customer refund request is OPEN, and writes `service.request_terminate` to the audit log.
  Nothing happens on the panel in the request.
- **The effect.** The `provisioner` role claims the operation and calls the adapter's delete.
  `TERMINATE` is in `IDEMPOTENT_MUTATIONS`: a 404 is success; a retryable failure stays `FAILED`
  and is retried with back-off; a definitive refusal (authentication, capability) or the attempt
  ceiling ends it `FAILED`/`ABANDONED`; a lost answer is `UNKNOWN`, which is not terminal and is
  settled by a READ (reconcile) or by another deletion — never by a guess. On success, in the same
  transaction, the service moves to `TERMINATED` and `ServiceStateChanged` is written.
- **Providers.** Whether a panel can delete is its operability verdict for `TERMINATE` — the
  adapter's proven, declared capability (Marzban and RickPanel delete; 3X-UI gained no mutable
  scope beyond create, `docs/phase4e-audit.md`). Where it is refused, the danger card shows the
  existing blocker sentence and neither option is offered.
- **Money.** A deletion moves none. An operator who wanted to compensate used the manual wallet
  adjust (`wallet.adjust`, CREDIT), which is not tied to the service, the payment or the deletion.

## 2. Which ledger path a refund takes

Three candidates were weighed.

| Option                                                     | Verdict                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The manual wallet adjust (`ADMIN_CREDIT`)                  | Rejected. It is written at once, so it cannot wait for the deletion; it is bounded by nothing about the service; and its key is the operator's, not the service's.                                                                                                                                               |
| A new ledger reason (`SERVICE_DELETE_REFUND`), new writer  | Rejected. It would be a second refund writer beside `RefundService`, with its own bound, its own reversal of cashback and referral commission, and its own answer to "how much of this payment came back". The money rules in `CLAUDE.md` exist to prevent exactly that.                                         |
| **WP19's service refund request, entered by the operator** | **Chosen.** `docs/wp19-service-refund-request-audit.md` already built "delete, then credit an administrator-chosen amount to the wallet, exactly once, never on ambiguity" for a customer's request, and survived twelve review rounds. An operator's delete-and-refund is that request with a different origin. |

So the ledger operation is the existing one, and it is already dedicated and auditable:

- a `refunds` row, channel `WALLET_CREDIT`, reason `SERVICE_REFUND_REQUEST`, `REQUESTED` at the
  command (it RESERVES the amount against the payment, so a concurrent partial refund sees it);
- on the confirmed deletion, one `wallet_entries` CREDIT, reason `REFUND`, reference
  **`<refundId>:refund`** — derived, and unique per tenant in the ledger, so a second credit for
  the same refund cannot be written by any writer;
- the `service_refund_requests` row (origin `OPERATOR`) links service, customer, payment,
  refund, deletion operation and the deciding administrator.

**The tracking id is the refund id** (the result screen shows it); the request id and the ledger
reference both lead to it.

**Relationship to `RefundService.refundUndeliverable`.** That is the one credit path for an
order the installation could not deliver: automatic, the full remaining amount, in the
transaction that discovers it. This is not that: the service WAS delivered, and an operator
decides to take it back and return part or all of its price as goodwill. It does not call
`refundUndeliverable`, does not move the order to a state of its own, and writes no ledger
entry of its own: it uses `RefundService.reserveForServiceRefund` / `settleServiceRefund` /
`releaseServiceRefund`, which share `creditWallet`, the payment lock, the consumption sum and the
cashback/referral reversals with every other refund. A payment fully refunded this way moves
the order `PAID → REFUNDED` exactly as an operator's refund does, and the order's audit says the
service was removed (`serviceRemovedByRequest`).

**The original payment is never replayed.** Nothing touches a gateway, a bank transfer or the
order's settlement: the amount is a wallet credit whatever the payment method was
(`SERVICE_REFUND_REQUEST_CHANNEL`, WP19 brief §2.7).

## 3. Semantics

- **Amount.** A decimal string of minor units on the wire, `bigint` in the service, positive.
  Sales currencies (Toman `IRT`, Rial `IRR`) have exponent 0, so the figure typed in Toman is the
  minor-unit figure; the field is labelled with the payment's currency. Persian and Arabic-Indic
  digits are read as digits; anything that is not whole digits is refused, never rounded.
- **Bound.** At most what the service's source payment still has to give back: the payment's
  principal (never the gateway fee, which WP18 keeps outside `payments.amount`) less every
  refund already consuming it. Decided under the payment's lock inside the command
  (`refundFitsWithin`), and checked again by the request's CHECK
  (`approved_amount_minor <= principal_minor`). The source is the service's own `NEW_SERVICE` or
  `CUSTOM_SERVICE` order and its one CONFIRMED payment. **A service with no paid source** (a
  trial, a free or legacy-adopted service) **is not offered a refund**: the modal says why and
  the operator may still delete only, or compensate with the manual wallet adjust, which is the
  honest tool when there is no payment to return.
- **Credit only after a confirmed delete.** The command reserves and plans; it credits nothing.
  The provisioner's sweep (`ServiceRefundRequestService.settleDue`, run on every provisioner tick
  in its own lane) credits in the transaction that observes the service `TERMINATED`:
  - `TERMINATE` SUCCEEDED and the service TERMINATED → one credit, request `COMPLETED`;
  - `FAILED` (definitive) or `ABANDONED`, and no other deletion undecided → the reservation is
    released, nothing is credited, request `FAILED` (the operator may try again — a new command);
  - `PLANNED`, `IN_FLIGHT`, a retrying failure, or `UNKNOWN` → nothing; the request stays
    `EXECUTING` and the Web Admin shows the deletion's state. When an `UNKNOWN` deletion is later
    settled — by a reconcile or by another deletion removing the account — the sweep credits once.
- **Idempotency.** The Web sends a stable key per (service, amount). The service stores it as the
  request's `filing_key` (prefixed `operator-delete-refund:`), unique per tenant for ever. It is
  read under the service's row lock, so a retry, a double click and a concurrent duplicate are all
  answered with the request the first one created; the same key with another amount or service is
  refused. A second command with a different key while one is active is refused
  (`ALREADY_REQUESTED`) by the code and, for a writer that forgets, by the partial unique index
  (one OPEN/EXECUTING request per service). Under all of these sits the ledger's unique
  `<refundId>:refund`.
- **Delete only** is the existing terminate, unchanged. It writes no refund, no request and no
  wallet entry.
- **Permissions.** `refunds.issue` AND `services.terminate` (WP19 T4: it moves money and deletes
  an account), checked before the transaction and again inside it. No new permission.
- **Tenancy and activity.** Every read is tenant-scoped (another tenant's service is
  `SERVICE_NOT_FOUND`); `ScopeActivityReader` is read inside the transaction; the outbox
  (`ServiceRefundRequested`, then `RefundCompleted`, `WalletEntryRecorded` and
  `ServiceRefundRequestResolved` from the sweep) is written in the business transaction.
- **Audit.** `service.delete_with_refund` (entity: the service) names the acting administrator,
  the customer, the payment, the amount and currency, the destination (`CUSTOMER_WALLET`), the
  refund id, the deletion's operation id and the outcome so far (`DELETION_PLANNED_CREDIT_PENDING`).
  Beside it: `refund.request`, `service.request_terminate`, and on settlement
  `refund.complete` + `service_refund_request.complete` (or `refund.fail` +
  `service_refund_request.fail`). No credential, link or free text is recorded.
- **Customer notification.** An operator's delete-and-refund tells the customer the generic
  `REFUND_COMPLETED` on credit (the customer filed nothing, so WP19's «your request was approved»
  would be false). No review card is pushed: the push consumer skips any request that is not an
  OPEN customer request.
- **Customer list.** As with WP19, a service whose request COMPLETED leaves the customer's list.
  A deleted-only service stays visible as `TERMINATED`, as before.

## 4. Schema and contract changes

- Contract (own commit): `SERVICE_REFUND_REQUEST_ORIGINS` (`CUSTOMER` | `OPERATOR`); the request
  view gains `origin`, and `reason` is nullable; `serviceDeleteRefundQuoteSchema`,
  `serviceDeleteWithRefundRequestSchema`, and route `deleteWithRefund`
  (`GET`/`POST /services/:serviceId/delete-with-refund`).
- Migration `0200_service_refund_request_origin`: `origin text NOT NULL DEFAULT 'CUSTOMER'` with an
  enum CHECK; `reason` and `bot_instance_id` become nullable, held by
  `service_refund_requests_origin_shape_check` — a customer's row has both, an operator's has
  neither and can never be `REJECTED`. Existing rows are all `CUSTOMER` and already satisfy it.

## 5. Web Admin

The danger card's button «حذف سرویس…» opens the modal. «فقط حذف سرویس» is selected first and
keeps the typed phrase. «حذف سرویس و بازگشت وجه» (drawn disabled, with a sentence, for a session
without both keys) reads the server's quote, shows what was paid and the maximum, validates the
amount as it is typed, then shows the summary — service, customer, amount, «کیف پول مشتری در
ربات» — with the note that the money moves only after a confirmed deletion, and a checkbox the
final button waits for. The result screen states the request as it stands: pending, blocked
(deletion `UNKNOWN`), failed (nothing credited) or completed, with the tracking id. The service
page's refund-request card lists the operator's request with its deletion state thereafter.

## 6. Rollback note

The release before this one reads `reason` as non-null. An operator's request listed by its Web
Admin would fail that client's schema parse on the refund-request cards (the server and the
sweep are unaffected: the sweep never reads `reason`). Before rolling back, decide or wait out
every `EXECUTING` operator request:
`SELECT id, state FROM service_refund_requests WHERE origin = 'OPERATOR' AND state = 'EXECUTING';`

## 7. Evidence

- `tests/integration/service-delete-refund.test.ts`: delete only (0 credits); delete + refund
  (1 credit, its reference, only after the deletion); retry and double submit; concurrent
  submits with one key and with distinct keys; UNKNOWN (pending, then 1 credit once confirmed);
  a retrying failure (0); a definitive failure (released, 0, then a new command credits once);
  amount validation and the bound after an earlier partial refund; the audit row; both
  permission halves; tenant isolation; a stopped installation; a customer request already
  standing; HTTP with and without `confirm: true`.
- `tests/web/service-delete-modal.test.tsx`: the two options, amount validation, the summary,
  the explicit confirmation, one key across a double click, delete-only routing, and the
  result wording.

## 8. Falsification

Each rule was reverted alone and the suite run (integration file, or the web file for W-rows):

| Row | Rule reverted                                                       | Result                                         |
| --- | ------------------------------------------------------------------- | ---------------------------------------------- |
| M1  | a filing key's replay answered with its request                     | killed (retry, concurrent, HTTP)               |
| M2  | an operator's request tells `REFUND_COMPLETED`, not WP19's APPROVED | killed                                         |
| M3  | `services.terminate` inside the transaction only                    | survives: the pre-check is the outer layer     |
| M3b | both layers of `services.terminate`                                 | killed (permission)                            |
| M4  | a replay must carry the same amount                                 | killed                                         |
| M5  | scope activity inside the command's transaction                     | survives: `planTerminateWithin` reads it again |
| M6  | a non-positive amount refused by the command                        | survives: `refundFitsWithin` and the CHECK     |
| M7  | eligibility (service state) refused                                 | killed                                         |
| M8  | the push consumer's state check (operator rows)                     | survives: the origin guard beside it           |
| W1  | the final button waits for the confirmation checkbox                | killed                                         |
| W2  | the amount bound in the form                                        | killed                                         |
| W3  | an UNKNOWN deletion reads "blocked", not "pending"                  | killed                                         |

The survivors are layered rules: each has a second implementation that the same test reaches.
