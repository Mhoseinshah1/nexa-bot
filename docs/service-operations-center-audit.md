# Service Operations Center (program §13)

One operational workspace for services: the services list with the workspace's filters, the
service page with every action the provider and panel allow, and safe mass actions over a
filtered set. Built on the existing service command domain and the mass-operation lane; it
adds no provider write path, no second state machine and no second bulk mechanism.

## What already existed, and was reused

- Single-service operator actions (`ProvisioningService.requestFromOperator`): suspend,
  resume, terminate (typed phrase, `services.terminate`), sync usage (the panel/sync
  state), rotate link (the subscription refresh, where the provider declares it), retry
  provision, reconcile, resend. The availability matrix (`evaluateServiceActions`) and its
  agreement with the write paths (`service-operations-http.test.ts`) are unchanged in shape.
- The mass-operation lane (`modules/commerce/bulk-operations`): frozen audiences, preview →
  hash/count/fingerprint-bound confirmation → one transaction per item → per-item outcome
  read through from the provisioning operation → pause/resume/cancel with conditional edges.

## What §13 added

- **Filters**: product, location (the key stored on the service) and "expiring within N
  hours" (`[now, now + N h)` on the server's clock), beside state, delivery, panel and the
  one free-text search. The list rows carry the location label.
- **One service — grant and move** (`SERVICE_OPERATOR_ACTIONS` + `ADD_TRAFFIC`, `ADD_TIME`,
  `CHANGE_LOCATION`):
  - `ServiceGrantService.grant` (`services.grant`, HIGH, owner): an operator's FREE traffic
    or time through `ProvisioningService.planGrant` — the planner a mass grant item and a
    purchased add-on already use, with all of `prepareCommercialAction`'s refusals. The
    operation id derives from the request key; a replay returns the same operation. Reason
    mandatory, on the audit row.
  - `LocationChangeService.requestFromOperator` (`services.edit`): the customer's free move
    minus what only rations a CUSTOMER (price, cooldown/rolling limit, the customer panel
    policy switch, reseller entitlement). Same lock order, same `planLocationChange`, same
    frozen change record (price 0). The customer is not told about a request they never
    made (`requested_by_customer_id` NULL).
  - Availability gains `UNLIMITED` (nothing to add to) and `NO_TARGET` (nowhere to move),
    both fail-closed when the fact was not gathered; the capability answers first, so a
    3X-UI service reads `CAPABILITY` for everything but what 3X-UI declares.
- **Many services** — `SERVICE_SUSPEND` / `SERVICE_RESUME` mass kinds:
  - Reversible by each other, which is why they (and not terminate) are offered in bulk.
  - Charged `services.mass.status` AND `services.edit` — never a way to do in bulk what the
    operator could not do to one service.
  - The eligibility predicate is one SQL rule built from `BULK_KIND_LEGAL_STATE` (pinned to
    `OPERATION_LEGAL_FROM`) plus the panels operable for the operation now; the preview
    counts it, the confirmation materialises it, and the dry run (`ineligible`) classifies
    the rest of the selection — not in state, panel not operable, otherwise — with a sample.
  - Each item plans through `ProvisioningService.planStatusWithin`, which is the operator
    request path's own `planWithin` (open operation returned, audit row, operation), asked
    as a verdict: a service that left the state or whose panel can no longer do it is
    SKIPPED, nothing written.
  - No customer notice (there is no notification kind for it; ADR-0030 is closed). The
    database refuses `notify` on these kinds.
- **Retry of FAILED items** (`/bulk-operations/:id/retry/preview`, `/retry`):
  - Only `FAILED`: the provider refused authoritatively (or reconciliation decided it was
    not applied), so asking again cannot apply anything twice. An UNKNOWN outcome stays
    PLANNED and is never copied; its reconciliation read decides it.
  - A NEW operation (`retry_of_id`) whose items are copied from the failed ones and
    confirmed against the counted set — the original's history is never rewritten, and every
    provisioning operation the retry plans derives from the retry's own id.
  - A failed item is retried ONCE from its operation (any non-cancelled retry carrying that
    service excludes it), under the original's row lock; a retry's own failures are retried
    from the retry.
- **Web Admin**: the services page gains the filters and one mass-action card over exactly
  what the filters select (refused, in words, when the free-text search, delivery state or
  location — which the shared audience cannot express — is set); the service page gains the
  grant/move card and polls its operation history while an operation is in flight; the
  mass-operation page gains the two kinds and the retry card.

## Rebase note

Panel Health (C2) adds a DRAIN concept to panels. Nothing here models drain: a drained panel
should surface through `decideOperability` / the eligibility predicate's operable-panel list,
which every path above already asks.

## Tests

- `tests/integration/service-operations-center.test.ts`: filters and tenant isolation; the
  grant through the real provisioner, idempotent, audited with its reason; refusals
  (permission with DENIED audit, other tenant, unlimited); a move refused by capability;
  preview = execution with the dry run; a confirmation the set no longer matches; per-item
  outcomes and the retry of FAILED only, once; UNKNOWN never retried; both permissions.
- `tests/integration/service-operations-http.test.ts`: the matrix agrees with every route,
  the three new actions included.
- `tests/unit/service-actions.test.ts`, `tests/unit/bulk-service-kinds.test.ts`,
  `tests/web/service-operations-center.test.tsx`.
- Mutation-checked: retry copying PLANNED, the once-only rule removed, the companion
  permission removed, the grant under `services.edit`, RESUME's legal state — each killed.
