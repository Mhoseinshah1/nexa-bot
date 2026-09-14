# Phase 4D audit — provisioning and real service creation

What exists before a line of Phase 4D is written, what it already decides, and what
this phase must therefore add rather than invent. Written before the code, from the
repository, so that the implementation can be checked against it.

The headline: **the contracts and the schema for this phase already landed.** The
Architecture Hardening phase froze `packages/contracts/src/provisioning.ts` and
`operation.ts`, and migration `0032_phase4_commerce.sql` created `services` and
`provisioning_operations` with their constraints. Phase 4D is almost entirely an
application-layer and adapter phase. That is a much narrower job than it looks, and
most of the ways to get it wrong are already closed by a CHECK constraint.

---

## 1. What is already frozen, and therefore not up for decision

### The service machine

`SERVICE_STATES` — `PENDING_PROVISION`, `ACTIVE`, `SUSPENDED`, `EXPIRED`,
`TERMINATED`, `UNRECONCILED`. `SERVICE_MACHINE` is a complete transition table.

Two properties of that graph are load-bearing and this phase may not weaken them:

- **`UNRECONCILED` has no edge to a second create.** It leaves only via
  `RECONCILED_ACTIVE` (guard `providerUserAdopted`) or `RECONCILED_ABSENT` (guard
  `providerUserProvablyAbsent`), and only the second lands back in
  `PENDING_PROVISION`, which is the one state a fresh create is legal from. Any code
  that calls `createUser` on an `UNRECONCILED` service is the duplicate this state
  exists to prevent.
- **`EXPIRED` is not terminal and `TERMINATED` is.** Renewal is the product.

### The operation machine

`OPERATION_STATES` — `PLANNED`, `IN_FLIGHT`, `SUCCEEDED`, `FAILED`, `UNKNOWN`,
`ABANDONED`. `RELEASE` returns `IN_FLIGHT` → `PLANNED` under the guard
`leaseExpiredAndCallNeverStarted`, which is why `provisioning_operations.call_started_at`
exists as a column committed on its own before the provider call.

`UNKNOWN` → `SUCCEEDED` / `FAILED` both carry the guard `providerStateRead`. There is
no edge from `UNKNOWN` to `IN_FLIGHT`: an unknown outcome is resolved by a READ, never
by repeating the mutation.

### The failure classification

`failureOutcome(kind, mutating)` is pure, total and already written. The division it
encodes is **not** transient-versus-permanent; it is _did the request certainly not
take effect_:

| Kind                                                                                                          | Mutating outcome | Why                                                       |
| ------------------------------------------------------------------------------------------------------------- | ---------------- | --------------------------------------------------------- |
| `UNREACHABLE`, `TLS_FAILED`, `BLOCKED_TARGET`, `AUTHENTICATION_FAILED`, `AUTHENTICATION_REQUIRES_INTERACTION` | `FAILED`         | never reached an authenticated endpoint                   |
| `RATE_LIMITED`                                                                                                | `FAILED`         | the panel explicitly refused to process it                |
| `TIMEOUT`                                                                                                     | `UNKNOWN`        | may have been received and processed                      |
| `PROVIDER_ERROR`, `MALFORMED_RESPONSE`, anything else                                                         | `UNKNOWN`        | a 5xx may have committed a write before failing to answer |

A non-mutating operation is always `FAILED`, never `UNKNOWN`: a read that did not
answer changed nothing.

**This phase must not re-derive this table anywhere.** The executor calls
`failureOutcome`.

### The provider username

`providerUsernameFor(serviceId)` — `nx` + 32 lowercase hex characters, derived from
the service id. This is the property that makes adoption possible at all: after an
unknown outcome, a reconcile can ask the provider for this exact name. It throws on a
non-UUID input rather than producing a name nobody can look up.

No customer text enters it. A username built from a Telegram display name would carry
Persian characters, emoji and somebody's real name onto a third party's panel.

### The operation id

`OperationId` — 16 lowercase hex characters derived by SHA-256 from the idempotency
key under a namespace. Derived, never generated, so two replicas racing a retry agree
with no lookup and no coordination. `provisioning_operations` has a unique index on
`(tenant_id, operation_id)`, so the second insert LOSES on the index rather than
starting a second provider call.

### The capability mapping

`OPERATION_REQUIRED_CAPABILITIES` already maps every operation type to the provider
capabilities it needs. `RECONCILE` requires none, because reading a user is how both
adapters already establish health.

### The lease and attempt bounds

`OPERATION_LEASE_SECONDS_MIN` = 60, `OPERATION_LEASE_SECONDS_MAX` = 3600,
`OPERATION_MAX_ATTEMPTS` = 5. The lease floor is above the provider HTTP timeout plus
its retries on purpose: a lease that expired mid-call would let a second worker start
the same mutation.

---

## 2. What the schema already enforces

`0032_phase4_commerce.sql` created both tables. The constraints that matter:

**`services`**

- `services_panel_provider_username_key` — UNIQUE `(panel_id, provider_username)`.
  Per panel, deliberately not per tenant: two tenants may legitimately share a panel,
  and a collision there would mean two services claiming one provider account.
- `services_provisioned_at_check` —
  `(state = 'PENDING_PROVISION' OR state = 'UNRECONCILED') = (provisioned_at IS NULL)`.
  A service cannot be `ACTIVE` without a provisioning time.
- `services_terminated_at_check`, `services_traffic_check`,
  `services_usage_synced_check` (a usage figure and its "as of" travel together).
- Composite foreign keys that carry `tenant_id` into every association — customer,
  order (with the customer), panel. A service cannot be stitched to another tenant's
  row.
- Partial indexes already exist for the two background scans: `services_expiry_idx`
  on `ACTIVE`/`SUSPENDED`, `services_unreconciled_idx` on `UNRECONCILED`.

**`provisioning_operations`**

- `provisioning_operations_tenant_operation_key` — UNIQUE `(tenant_id, operation_id)`.
  The derivation's whole purpose.
- `provisioning_operations_claim_check` — `(claimed_by IS NULL) = (lease_until IS NULL)`.
- `provisioning_operations_completed_check` — terminal states have a completion time.
- `provisioning_operations_operation_id_check` — `operation_id ~ '^[0-9a-f]{16}$'`.
- Partial indexes for the due scan (`state = 'PLANNED'`), the lease sweep
  (`state = 'IN_FLIGHT'`) and the unknown queue (`state = 'UNKNOWN'`).

### What the schema does NOT yet enforce — and must

1. **One service per order.** There is a composite foreign key from `services` to
   `orders`, but no UNIQUE on `(tenant_id, order_id)`. The directive's
   exactly-once-logical-service rule is currently application discipline only. This
   phase adds the index; that is what turns "two workers must not" into "two workers
   cannot".
2. **No `next_attempt_at`.** `provisioning_operations` has `attempts`, `claimed_by`,
   `lease_until` and `call_started_at`, but nothing that expresses backoff. Without it
   a failed operation is re-claimed on the very next tick, which is a hot loop against
   somebody else's panel.
3. **No delivery state on `services`.** `subscription_url` exists; whether the customer
   was actually told exists nowhere. The directive requires that a Telegram delivery
   failure leave the service `ACTIVE` and be independently retryable, which needs its
   own column rather than a service state.

---

## 3. What the provider layer is, and exactly how far it goes

`ProviderConnectionAdapter` — `descriptor`, `supports(capability)`, `probe(target, http)`.
Both `marzban.adapter.ts` and `sanaei.adapter.ts` implement this and **nothing else**.

`ProviderAdapter extends ProviderConnectionAdapter` with `createUser` and `readUsage`
and is declared but implemented by nobody. The comment on it says "Phase 4 territory;
declared so the seam is visible."

**Both descriptors declare `capabilities: ['HEALTH_CHECK']` and only that.** This is
not an oversight — `provider.ts` records that Marzban previously advertised fourteen
operations and that this was rejected, because the endpoint publishing the array is how
the product tells an operator what it can do:

> the array was advertising operations no code could perform. Each returns in the
> commit that implements it.

So growing those arrays is a contract change, it is this phase's to make, and it must
be made **one capability at a time, in the commit that implements it**. A Phase 4D that
declares `ADD_VOLUME` before Phase 4E writes it would be reintroducing exactly the
defect that comment describes.

### The HTTP client is already the right one

`SafeHttpClient` pins the socket to a pre-validated address, never follows redirects,
and refuses only destinations that are never a panel. `probe-core.ts` is the single
probe implementation with two wrappers. The service half must use the same client and
the same budget; a second outbound path would escape the tenant probe bound.

---

## 4. Where a service must come from

`PaymentService.confirmAndSettle` is, by its own comment, **the one place `SETTLE` is
taken**. It runs inside a transaction, it re-reads the order, it runs
`settlementRefusal` against the CONFIRMED payment, and it writes the audit row and the
outbox message.

That is where the service and its `PROVISION` operation are created, and the reason is
the exactly-once rule: an order settles once, atomically, and if the service row is
written in the same transaction then "one settled order produces at most one logical
service" is a consequence of the order machine plus a UNIQUE index, not of a worker
behaving well. The alternative — consume `PaymentConfirmed` from the outbox and create
the service in a handler — makes the guarantee depend on the handler being idempotent,
which is a strictly weaker position for no benefit.

**No network call moves into that transaction.** The transaction writes two rows in
`PENDING_PROVISION`/`PLANNED` and commits. Every provider call happens afterwards, in
the executor, outside any transaction. `docs/conventions.md` and the boundary check
already enforce this.

## 5. Which order becomes which service

A renewal is a NEW order against the SAME service — `provisioning.ts` and
`commerce.ts` both say so. So:

- An order whose line has no existing service creates one. `services.order_id` is the
  ORIGINATING order.
- A renewal order creates **no** service row and instead plans an operation against an
  existing one. That is Phase 4E's work; 4D must not make it impossible, which is why
  the UNIQUE is on `(tenant_id, order_id)` and not on `(tenant_id, customer_id, product_id)`.

Under that rule every order creates zero or one services, and the UNIQUE index says
exactly that.

---

## 6. Panel selection

The product already carries `panelId`, and `OrderLineSnapshot.panelId` snapshots it at
confirmation, with a comment giving the reason: a later re-point of the product must
not silently move an existing service's home.

So selection in Phase 4D is **not** a scheduler. The panel is already chosen — by the
operator, when they bound the product — and the order snapshotted it. What this phase
must do is _validate_ that the snapshotted panel is still usable at provisioning time
and refuse explicitly when it is not:

- the panel still exists and belongs to this tenant (the composite FK already forces this);
- its status is `ACTIVE`, not `DISABLED`;
- its provider type resolves to a registered adapter;
- that adapter declares the capability the operation needs.

`PRODUCT_NOT_FULFILLABLE` already exists for "no panel bound". A panel that is bound
but unusable is a different fact and needs its own code.

Health is deliberately **not** a selection input here. `panel_health` is latest-state
only and a panel can be `UNCHECKED`; refusing to provision onto an unprobed panel would
make a fresh install unable to sell anything. An unhealthy panel fails the actual call,
and that failure is classified by the existing taxonomy — which is more honest than a
pre-emptive refusal based on a possibly stale read.

---

## 7. What the research establishes about delivery

From `docs/research/`: the legacy system delivers a subscription link, and separately
supports configuration files; captions are operator-configurable text. `ServiceDelivery`
in `provider.ts` already models all four shapes — `SUBSCRIPTION_LINK`, `RAW_CONFIGS`,
`CONFIG_FILE`, `CREDENTIALS` — plus `NONE`.

`DELIVER_SUBSCRIPTION_LINK`, `DELIVER_RAW_CONFIGS` and `DELIVER_CONFIG_FILE` are
already separate capabilities, so a panel that serves a link but no file says so.

Delivery text comes from a template key. `CLAUDE.md`: customer-facing text comes from a
template key, no string literals in surfaces.

---

## 8. Decisions this phase takes, and why

| Decision                         | Choice                                          | Reason                                                                                                                                              |
| -------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where the service row is created | in `confirmAndSettle`'s transaction             | makes exactly-once a UNIQUE index rather than worker discipline                                                                                     |
| Panel selection                  | validate the order's snapshot; do not re-choose | the snapshot exists precisely so a re-point cannot move a live service                                                                              |
| Health as a selection input      | no                                              | latest-state-only, and `UNCHECKED` is normal on a fresh install                                                                                     |
| Backoff                          | new `next_attempt_at` column                    | without it a failed op is a hot loop against a third party                                                                                          |
| Delivery tracking                | new column on `services`, not a service state   | delivery failure must leave the service `ACTIVE` and be separately retryable                                                                        |
| Capability declarations          | grow one at a time, in the implementing commit  | `provider.ts` records the rejection of the alternative                                                                                              |
| Process role                     | the existing `worker`, not a fifth `main`       | the executor's calls are outbound HTTPS like the monitor's, but they are ORDER-driven and must not be delayed behind a slow panel sweep — see below |

### The one genuinely open choice: which process runs the executor

The monitor exists as its own role because a probe is outbound HTTPS on a timer and
must not share an event loop with the webhook. The same argument applies to a provider
create. But the monitor's own comment gives the reason it is not the worker — "a
monitor stuck on a hanging panel delays notification delivery" — and that argument
applies equally to putting provisioning inside the monitor: a customer waiting for a
config must not queue behind a sweep of every panel in the installation.

Resolved: **a dedicated `provisioner` role**, a fifth `main`. It is the same image and
the same module graph, selected by the container command, exactly as `monitor` and
`recovery` already are. Recorded as an ADR.

---

## 9. What this phase does NOT do

Deferred to 4E, and named so the boundary is checkable:

- renewal, add-volume, add-time, suspend/resume, terminate;
- periodic provider synchronisation and divergence detection;
- panel migration;
- the lifecycle sweeper that moves `ACTIVE` → `EXPIRED`.

Deferred to 4F: discounts, referral, trial, reseller, affiliate — their tables exist
and stay empty.

Consequence: of the sixteen `PROVIDER_CAPABILITIES`, this phase declares only
`CREATE_USER`, `READ_USAGE` and whichever `DELIVER_*` each panel genuinely serves. The
rest arrive with their operations.

---

## 10. Open questions this phase does not resolve

- The subscription-link domain for 3X-UI is configured separately, because the panel
  does not derive it from its own address — `requiredActivationFields:
['subscriptionDomain']` already records this. Phase 4D must read that field and
  refuse when it is absent rather than guess a URL.
- Marzban's inbound/proxy selection: which inbounds a created user is attached to is a
  per-panel operator decision. Evidence is needed before a default is chosen; recorded
  rather than guessed.
