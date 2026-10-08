# Payment Operations Center (program §10, B1)

One cross-provider workspace over the payment domain as it already is. It adds no payment
state, no state machine, no write path and no "force paid". The Web Admin's `/payments` list
IS the workspace: it was already the one cross-provider list, and a second page would have been
a second list.

## Audit (what existed, and what it decided)

| Concern                | Where it lives                                                                                      | Used as                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Payment states         | `PAYMENT_STATES` — PENDING, CONFIRMED, FAILED, CANCELLED, EXPIRED, UNKNOWN                          | the state column and filter, unchanged       |
| Gateway attempt        | `gateway_invoices`: creation state, LAST inquiry, LAST webhook + count, outcome, late completion    | queue predicates, row signal, timeline       |
| Mismatch               | `GatewayPaymentService.holdMismatch`: PENDING → UNKNOWN, audited `payment.lose_track` + `reason`    | `MISMATCH` queue, `PAYMENT_OUTCOME_UNKNOWN`  |
| Lapsed provider review | the review sweep: the same action, no `reason`                                                      | UNKNOWN, never MISMATCH                      |
| Partial payment        | NOWPayments `partially_paid` (a MISMATCH that never fulfils); no other route exposes one            | `PARTIAL` queue (`PARTIAL_PAYMENT_STATUSES`) |
| Late completion        | `gateway_invoices.outcome = 'LATE_COMPLETION'`; nothing moved, no domain resolution                 | `LATE_COMPLETION` queue                      |
| Reconcile an UNKNOWN   | `PaymentService.reconcileGatewayPayment`, `payments.reconcile`, per-provider evidence table         | unchanged; the queue mirrors its rule in SQL |
| "Ask again"            | `PaymentService.reinquireGatewayPayment` — a row write, spaced a minute                             | unchanged; also offered on queue rows        |
| Refund                 | `RefundService` (operator, `refunds.issue`); `refundUndeliverable` (automatic, the one credit path) | unchanged; on the payment page               |
| Mark for review        | **not in the domain** — the provider review window is opened only by the provider's own answer      | not offered (nothing invented)               |
| Timeline               | WP17 `assemblePaymentTimeline` + reader, sections behind their permissions                          | extended, not duplicated                     |
| Search                 | #140 `classifyListSearch`, one `q`                                                                  | gains the gateway's own ids                  |

## Queues

A queue is a facet of what has been RECORDED, never a state; a payment can be in several, and
the state column still says where it is. Each is ONE SQL predicate
(`infrastructure/payment-ops-queue-sql.ts`) shared by the list filter and the counts, so a count
and the list it opens cannot disagree. Definitions are in `packages/contracts/src/payment-operations.ts`.

`NEEDS_RECONCILIATION` is the SQL twin of `reconcilableNow` (`domain/gateway-reconciliation.ts`),
which composes exactly the two checks `reconcileGatewayPayment` makes under the lock; it is
derived from the same evidence table, and an integration test holds the SQL and the TypeScript
to the same answer over every provider × status × `paid` × reference.

Filters: queue, gateway route, state, method, receipt disposition, a created-at range (the
reports' ranges, resolved by the reports' resolver in the tenant calendar, half-open; absent =
no bound, so an UNKNOWN never ages out), and the one `q` — now also a gateway's order, invoice,
charge or payment id, or the invoice id a verified webhook named for a lost create
(`hinted_invoice_id`, the only invoice id a CREATE_UNKNOWN attempt carries), exact. Every search
shape asks the provider ids — a uuid too, since a provider's id can be uuid-shaped and the box
classifies by shape. The web client sends `from`/`to` only with `range=CUSTOM`, which is the only
range the server accepts them with.

Roadmap E2 (`docs/payments-under-review-ux.md`) adds `NEEDS_ACTION`: the payments a person
must act on, each with an existing command as its exit (every UNKNOWN, a signalled manual
transfer, a confirmed payment with an open refund), shown first among the chips. Every row
also carries the server-derived situation (E1), from the same predicates.

## Timeline

`GET /payments/:id/timeline` gains (contract `PAYMENT_TIMELINE_KINDS`):

- under `payments.view`: invoice requested (with creation state / code), invoice created, the
  LAST webhook hint (with how many arrived), the LAST inquiry (status, `paid`, error code), each
  "ask again", provider review opened (with its deadline), outcome unknown (with the
  mismatch reason), the gateway outcome and a late completion. The invoice row keeps the last
  inquiry and webhook, not a log, so these are "the last one, at this time" — never a
  fabricated series;
- a FAILED last inquiry (error code set) carries the error and NO status or `paid`: the row
  keeps the last OBSERVED status through a failed call, so showing it at the failed inquiry's
  time would present an earlier answer as that inquiry's result;
- "ask again" is read from its `gateway_invoice.reconcile_inquiry_requested` audit rows with
  `requested = true` (one entry each), not from `reconcile_inquiry_requested_at`, which the
  inquiry that answers the request clears. Those rows are read under `payments.view` like the
  `payment.lose_track` rows — not behind `audit.view` — because the entry was a `payments.view`
  fact before and an operator who may press the button must see that it was pressed; only the
  time is carried, no actor and no `before`/`after`. No migration;
- under `orders.view` (new section `ORDER`): the settling order's settlement, the operation that
  delivers what it bought (`PURCHASED_AS`) and its refund — only on the CONFIRMED payment;
- under `audit.view` (new section `AUDIT`): every audit row on the payment, by action code,
  actor type, result and — only for an administrator — the admin id. Never `before`/`after`.

Every provider-supplied string is passed through `machineCode` (short code or dropped). No link,
no card, no secret, no provider amount reaches it.

## Shared read model — "operational attention" (for B2 Gateway Health and B3 Notification Center)

```ts
// apps/api/src/modules/commerce/payments/application/payment-operations.service.ts
interface PaymentAttentionReader {
  counts(scope: TenantContext, window: TimePeriod | null): Promise<readonly PaymentAttentionRow[]>;
}
interface PaymentAttentionRow {
  gatewayProvider: PaymentGatewayProvider | null; // null: offered through no route
  counts: Readonly<Record<PaymentOpsQueue, number>>; // every queue, incl. PENDING/UNKNOWN/MISMATCH
}
```

- Implementation: `DrizzlePaymentAttentionReader` (one grouped statement, `count(*) FILTER` per
  queue over the shared predicates). Container: `container.paymentAttention`.
- No permission of its own: a system caller (a health probe, a notification sweep acting as
  `SYSTEM_JOB`) reads it under its own authority. An operator reads it through
  `PaymentOperationsService.attention` (`payments.view`) or `GET /payment-operations/attention`
  (`paymentAttentionResponseSchema`, optional `range`/`from`/`to`).
- Window: payments CREATED in `[start, end)`; null = no bound. Tenant-scoped. Rows with every
  count zero are omitted.

## Indexes

Online (`ONLINE_INDEXES`), no migration: `gateway_invoices_tenant_hinted_payment_idx` and
`gateway_invoices_tenant_hinted_invoice_idx` (the two webhook-named search arms) and
`provisioning_operations_tenant_order_idx` (the timeline's fulfilment read).
