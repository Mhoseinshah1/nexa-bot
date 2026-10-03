# Gateway Health (program §11, B2)

A tab beside the payment routes' configuration (`/payment-gateways?tab=health`), over
`GET /payment-gateways-health` (`payments.gateways.view`). READ-ONLY: nothing here calls a
provider, writes a row or estimates anything.

## What each route shows, and where it comes from

| Line                                  | Source                                                                                                                                                                                                      |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Switch                                | `payment_gateways.status`                                                                                                                                                                                   |
| Configuration gaps                    | `PaymentGatewayService.readinessFacts` → `configurationGaps`: the enable refusals' own reasons, in `setStatus`'s order, plus an enabled receiving account for a manual transfer. Set or not, never a value. |
| Credential check                      | whether the adapter offers a safe read-only call (NOWPayments `/v1/estimate` only — TonPays, TonPays Telegram, CentralPay and Stars document none, and none is invented), and the stored last result        |
| Last invoice / last answer            | `gateway_invoices`: latest `created_invoice_at`; latest `last_inquiry_at` with a status and no error                                                                                                        |
| Last inquiry / create failure         | latest `last_inquiry_error_code` with its time; latest `CREATE_FAILED`/`CREATE_UNKNOWN` with `creation_sent_at`                                                                                             |
| Errors in the range                   | attempts created in the range, and how many match the Payment Operations Center's `PROVIDER_ERROR` predicate — two counts, never a percentage                                                               |
| Provider calls                        | `payment_gateway_call_budgets`: calls used since the current budget window opened                                                                                                                           |
| Open conditions                       | open `operational_events` with a `GATEWAY_HEALTH_OPERATIONAL_CODES` code whose context names the route                                                                                                      |
| Queues (`payments.view`)              | `PaymentAttentionReader` (B1), each figure a link to `/payments?gateway=…&queue=…`                                                                                                                          |
| Last reconciliation (`payments.view`) | latest successful `payment.reconcile_*` / `gateway_invoice.reconcile_inquiry_requested` audit row naming the route                                                                                          |
| Latency                               | **not measured** — a create's elapsed time is logged, never stored — so it is said, not shown                                                                                                               |

Each attempt keeps only its LATEST inquiry, so the "last" lines are the latest answers still on
record, not a log of every call. A route with no record shows "not recorded" everywhere and the
state `NO_ACTIVITY`; the best state is `NO_ISSUES_RECORDED`, deliberately not "healthy".

## Health events and the Notification Center hook (for B3)

No operational-event code was added or renamed. The gateway lane already raises
`payments.gateway_misconfigured`, `…_webhook_unverified`, `…_create_unknown`,
`…_late_completion`, `…_identity_mismatch`, `…_receipt_unknown`, `…_card_change_unknown` and
`…_review_unresolved`; `GATEWAY_HEALTH_OPERATIONAL_CODES` (contracts) lists exactly those (a unit
test holds it to the producers' constants), so the Notification Center can subscribe by code
under the category `GATEWAY_HEALTH_CATEGORY = 'PAYMENT_GATEWAY'`.

For signals that are not operational events, `container.gatewayHealth.signals(scope, window)`
returns `GatewayHealthSignal[]` (`gatewayHealthSignalSchema`): `{ key, category, provider, kind,
severity, opsCode, count, since }`. Kinds: `OPEN_CONDITION` (carries `opsCode` — skip it if you
already notify from the ops log), `CONFIGURATION_INCOMPLETE` (an ACTIVE route lost a
requirement), `CHECK_FAILED`, `PROVIDER_ERRORS`, `PAYMENTS_UNKNOWN`,
`PAYMENTS_NEED_RECONCILIATION`. `key` is stable while the fact holds (`<provider>:<kind>[:<code>]`)
— dedupe on it. The method charges no permission (a system sweep calls it under its own
authority); it is tenant-scoped. Notification persistence is B3's.
