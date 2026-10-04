# Migration P6 — Service Adoption write path (Item 7) and reminder burst protection (Item 8)

Status: designed here before coding; built on `wp4/reminder-seed` (Item 8) and
`wp4/p6-adoption` (Item 7, stacked). **Adoption is not provisioning**: no provider is
called, no account is created, renewed, enabled, disabled, rotated or renamed. The adoption
service holds no provider client at all; runtime facts arrive as inputs that the P7
importer read through the read-only inventory (#169).

Synthetic data proves the code. Nothing here is legacy evidence, C1/C3 acceptance or a
rehearsal on real data — those stay manual acceptance (§11).

## 1. The audit — what the normal paid path creates, and what an adopted service must have

| Row / state on the paid path                                                       | Who writes it                                                   | Readers that depend on it                                                                  | Adopted service                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orders` (DRAFT → AWAITING_PAYMENT → PAID), line snapshot, quote, `settled_at`     | `OrderService.confirm`, `PaymentService.confirmAndSettle`       | `services.order_id` FK (NOT NULL, unique), reports, Customer 360, audience, first-purchase | **YES** — one order, `NEW_SERVICE` + `LEGACY_ADOPTION`, `PAID` at birth, zero totals (`orders_legacy_adoption_shape_check`), line = the resolved product's snapshot at price 0, quote = one zero BASE_PRICE step |
| `payments`, `wallet_entries`                                                       | payment lanes                                                   | refunds, revenue, refund requests (`NO_PAID_SOURCE` without one)                           | **NO** — never revenue, never refundable                                                                                                                                                                         |
| `panel_capacity_reservations`                                                      | `PanelSalesGate.acquire` at confirmation, deleted at settlement | capacity count (unexpired holds)                                                           | **NO** — a hold exists only while no service represents a claim; the adopted service row IS the claim (§3)                                                                                                       |
| `service_username_reservations` (funded)                                           | username step + `markFunded` at settlement                      | the allocator's namespace collision (`(namespace_key, username)` unique)                   | **YES** — lowercase canonical name in the panel's namespace, `mode = CUSTOM` (a name this installation did not author), funded at adoption (§4)                                                                  |
| `services` (PENDING_PROVISION) + `provisioning_operations` PROVISION               | `ProvisioningService.planForSettledOrder`                       | the provisioner claim, reconcile, refund                                                   | service **YES**, in its live state (§5); operation **NO** — an adopted service is never on a CREATE path (C3 constraint 5)                                                                                       |
| `services.subscription_ref`                                                        | `secrets.hex(16)` at settlement                                 | 3X-UI `subId`; unique per panel                                                            | **YES**, minted the same way in the adoption transaction (§4)                                                                                                                                                    |
| `services.subscription_url`, `expires_at`, `traffic_used_bytes`, `usage_synced_at` | the PROVISION outcome (`transition`), later `SYNC_USAGE`        | service screens, reminders, usage sync, renew/add-traffic/add-time targets                 | **YES**, from RickPanel runtime facts (input) — never from the invoice snapshot                                                                                                                                  |
| `delivery_state = DELIVERED`                                                       | `DeliveryService` after the link is sent                        | the delivery sweep (sends only `PENDING`)                                                  | **YES**, `DELIVERED` at adoption — the customer already holds the link from the legacy bot; `PENDING` would make the sweep send every adopted customer their link again                                          |
| `order_cashback`, `order_referral_commissions`, `discount_redemptions`             | `PricingService.redeem` at confirmation                         | the provisioner earn sweep (keyed on a SUCCEEDED op of the order's `PURCHASED_AS` type)    | **NO** — an adoption is never confirmed, so nothing is promised; and no operation exists, so the sweep has nothing to earn on                                                                                    |
| `service_reminders`                                                                | the reminder sweep                                              | the sweep's own `NOT EXISTS` (per period)                                                  | **YES** — seeded (§6), so no historical reminder is sent                                                                                                                                                         |
| `legacy_import_map`                                                                | (P7)                                                            | resume / reconcile / review                                                                | **YES** — `legacy_table = invoice`, `entity_type = SERVICE`                                                                                                                                                      |
| audit + outbox                                                                     | every write path                                                | —                                                                                          | **YES** — `legacy.service.adopt` audit, `ServiceAdopted` event, both in the transaction                                                                                                                          |

Every existing reader then treats an adopted service correctly with no change:

- **Service screens** read `services` by customer; an adopted service is an ordinary row.
- **Usage sync** (`listUsageSyncDue`) takes ACTIVE services and reads usage by
  `provider_username` (P1 removed the `provider_user_id` predicate). A disabled (SUSPENDED)
  or EXPIRED adopted service is not synced, as for any other.
- **Renew / add traffic / add time** quote the SERVICE's product at its current price
  through `PricingService.price` (`quoteRenewal`) — never the legacy price. The order line
  keeps unit price 0; nothing reads it for a renewal.
- **Expiry sweep** moves an ACTIVE adopted service whose deadline passes to EXPIRED, locally,
  as for any service (no provider call).
- **Reports** count sales with `o.origin = ANY(SALE_ORDER_ORIGINS)` (P3), so an adoption is
  never a sale, a buyer, revenue or a "new service"; live-service counts include it.
- **Refund requests** find no confirmed payment → `NO_PAID_SOURCE`. `refundPurchase`
  declines an adoption explicitly (P3).
- **Delivery sweep** sends nothing (DELIVERED).

## 2. The entry point

`LegacyAdoptionService.adopt(scope, actor, command)` in
`apps/api/src/modules/commerce/legacy-adoption/application/legacy-adoption.service.ts`.
Called by the P7 CLI as `SYSTEM_JOB` with **`maintenance.run`** — the only key
`SYSTEM_JOB_PERMISSIONS` holds and the one the opening-balance service charges; no
narrower existing key is held by a job. **No HTTP, Telegram or web surface constructs or
calls it** (a boundary test pins that only the container and the CLI may import it).

Outcomes: `ADOPTED` | `ALREADY_ADOPTED` (same mapping, same ids) | `MANUAL_REVIEW` (closed
reason; `recorded` says whether a map row was written — false only for an invoice key outside the evidenced shape, which the map refuses). Also `SKIPPED` (test panel), `FAILED` (unreadable provider record) and `REVIEW_CLOSED` (a person closed the review to reruns) — §9. The exact types are in `legacy-adoption-ports.ts`.

## 3. Capacity decision (6B)

An adopted account **already occupies its panel**. Refusing to record it would not free a
slot on the real machine; it would only make NEXA believe the panel has room it does not
have, and sell that room. So:

- Adoption takes the **panel row lock** (`SELECT … FOR UPDATE`, the lock `reserve` takes
  FIRST) and only then counts and inserts. A concurrent confirmation for the same panel
  therefore counts the adopted service (it waits on the lock and its count runs after the
  adoption commits) — never the state from before it.
- Adoption **never refuses for capacity**. The service row is in `SERVICE_CAPACITY_STATES`
  (every non-terminal state), so it is counted by the one capacity query like any other.
- **Never silent**: the outcome and the audit row carry `capacity = { maxServices,
usedAfter, overCap }`. A panel adopted past its cap then reads `AT_CAPACITY`: the
  catalogue hides it and confirmation refuses new sales there (`decideEligibility`) until an
  operator raises the cap or services end. Lowering/exceeding a cap terminates nothing (6B).
- No capacity reservation row is written: a hold is for the window in which no service
  represents a claim, and here the service exists from the first statement.

Lock order: the per-invoice transaction advisory lock
(`hashtextextended('legacy-adoption:<tenant>:invoice:<key>')`, the `legacy-shape:` form;
taken first and never together with another advisory lock) → the panel row → the username
reservation insert (a unique index). This matches the existing order → panel → reservation
order; the adoption order is new, so nothing else can be waiting on it. A purchase that
reserves the same name between the adoption's check and its insert makes the adoption's
insert fail on the namespace index and the whole transaction roll back; the importer's
retry then answers `CONFLICTING_EXISTING_ENTITY`.

## 4. Identity: username, subscription_ref, link (C3 SAFE_WITH_CONSTRAINT)

1. **Username** — `services.provider_username` is the panel's EXACT spelling from the
   verified match (`providerUsername`), never `lower()`; the match must be `ELIGIBLE` and its
   lowercase key must equal the canonical fold of that spelling. The reservation stores the
   lowercase canonical form, so a new customer cannot choose `alice` beside an adopted
   `Alice`. Conflict ⇒ `MANUAL_REVIEW CONFLICTING_EXISTING_ENTITY`, never a merge: any
   existing service on that panel with the same name (any state, case-folded), or a
   reservation of that name in the panel's namespace by another order (another tenant on the
   same host included — the namespace is not tenant-scoped).
2. **subscription_ref** — minted `secrets.hex(SUBSCRIPTION_REF_BYTES)` in the adoption
   transaction (CHECK + per-panel unique index hold); never derived from the legacy row or the
   panel token. RickPanel never sends it (C3 evidence 1).
3. **Provider restriction** — adoption is accepted only on a `rickpanel` panel. C3 is
   answered for RickPanel only; on 3X-UI the ref IS the client `subId`, so a random local ref
   would not match the account. Any other provider ⇒ `MANUAL_REVIEW SUBSCRIPTION_REF_BLOCKED`.
4. **Link** — `subscription_url` is the provider's own link IF the importer read one
   (`lookupUser` delivery, a GET) and passed it; never constructed, never rotated to obtain
   one. Null ⇒ adopted without a link (C3 constraint 1: the operator decides; nothing
   writes). It is never in an audit row, an event, a map row or a log — only `hasLink`.
   The P5 inventory deliberately does not carry links; obtaining one is a per-account read
   the importer decides on.
5. `provider_client_id` is minted like any service (RickPanel ignores it).

## 5. Service state mapping (runtime facts → NEXA)

RickPanel's `status` folded by the inventory (`RICKPANEL_ACCOUNT_STATES`):

| RickPanel  | NEXA `services.state` | Why                                                                                                                                                  |
| ---------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `active`   | `ACTIVE`              |                                                                                                                                                      |
| `limited`  | `ACTIVE`              | traffic exhausted but the account is enabled; NEXA has no traffic-exhausted state (EXPIRE is by time), and ADD_TRAFFIC / RENEW are legal from ACTIVE |
| `disabled` | `SUSPENDED`           | **disabled stays disabled** — the switched-off account; RESUME is the ordinary guarded way back                                                      |
| `expired`  | `EXPIRED`             | renewable                                                                                                                                            |
| `on_hold`  | MANUAL_REVIEW         | `UNSUPPORTED_SHAPE`: a not-yet-started window has no NEXA representation; guessing a start would invent an expiry                                    |
| `UNKNOWN`  | MANUAL_REVIEW         | `UNSUPPORTED_SHAPE`                                                                                                                                  |
| usage null | FAILED                | `PROVIDER_READ_FAILED` (a map FAILED row, retried by a rerun): the record's usage fields were absent/malformed — never a fake zero                   |

Figures: `expires_at` = the panel's expiry (null = unlimited); `traffic_limit_bytes` = the
panel's `data_limit` (null → 0 = unlimited); `traffic_used_bytes` = the panel's used figure
with `usage_synced_at` = the time the importer observed it (so the usage lane treats it as
measured). `provisioned_at` and `delivered_at` = adoption time. Order `settled_at` /
`confirmed_at` = the legacy purchase time when the importer supplies one (audience "last
purchase" reads it), else adoption time. `device_limit` NULL (none recorded — never
invented).

The adopted window must match the product's shape (a time-limited service needs a product
with a duration, an unlimited one a product without): `quoteRenewal` refuses a mismatch,
so a mismatched service would be adopted unrenewable ⇒ `PRODUCT_MAPPING_UNRESOLVED`.

## 6. Reminder burst protection (Item 8)

`ServiceReminderService.seedPassedThresholds(scope, serviceId, tx)` on the EXISTING lane:
it reads the service exactly as the two candidate queries do (same columns, same exact
basis text, same tenant-timezone day boundary, `seedCandidate`), decides with the sweep's
own functions (`passedReminderKinds` = the `expiryReminderDue` prefix and
`usageRemindersReached`), and writes each passed kind through the sweep's own `raise`
(`ON CONFLICT DO NOTHING` on the period key) — with **no notification**. It is what the
sweep already does for the kinds below the one it announces. Consequences:

- The first sweep after an adoption sends nothing historical (near-expiry, several passed
  usage thresholds, expired — the expired notice included).
- Future genuine thresholds still fire: the next rung against the same basis, and every
  rung of a new period (a renewal or added traffic moves the basis).
- Flags are deliberately NOT consulted: a family switched off at adoption and on later must
  not announce a pre-adoption crossing.
- Idempotent: a rerun writes nothing; two concurrent seeds write each row once.
- It runs inside the adoption transaction and re-reads scope activity there.
- An ALREADY_ADOPTED rerun does NOT seed again — by then the service may have moved on, and
  seeding its current state would swallow genuine reminders.

## 7. Idempotency and concurrency

- `command.idempotencyKey` through `IdempotencyStore` (namespace = the actor's surface):
  a replay returns the stored outcome; the same key with a different payload is refused;
  the loser of a race throws `IDEMPOTENCY_IN_FLIGHT` and rolls back (`rememberOnce`).
- The durable identity is the LEGACY KEY: a per-invoice advisory transaction lock serialises
  every adoption of one invoice; under it the map row decides — `IMPORTED` as a SERVICE ⇒
  `ALREADY_ADOPTED` with the same service/order ids (whatever the new idempotency key), a
  changed checksum reported (`sourceChanged`) and never re-pointed (the map refuses it).
- `services_tenant_order_key` and `services_panel_provider_username_key` remain the
  database's last word: N concurrent adoptions of one invoice produce one order and one
  service (tested with real concurrent transactions).

## 8. Revenue exclusion

Zero totals + `LEGACY_ADOPTION` (P3) + no payment + no ledger entry + no promise rows + no
provisioning operation. Proven through the real write path: the reports exclude it; the
provisioner tick (earn sweep included) creates no cashback, referral commission or reseller
record; a refund request finds no paid source.

## 9. Decisions and their map rows (closed)

| Outcome           | Map row                           | Reasons                                                                                                                                                                                                                                                                                                                                   |
| ----------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADOPTED`         | `IMPORTED` / `SERVICE`            | —                                                                                                                                                                                                                                                                                                                                         |
| `ALREADY_ADOPTED` | unchanged                         | —                                                                                                                                                                                                                                                                                                                                         |
| `SKIPPED`         | `SKIPPED` / `TEST_PANEL`          | a test-panel match                                                                                                                                                                                                                                                                                                                        |
| `MANUAL_REVIEW`   | `MANUAL_REVIEW` / reason          | passthrough (Item 9's `decisionForLegacyMatch` mapping): `PROVIDER_MISSING`, `AMBIGUOUS_PANEL`, `PANEL_UNMAPPED`, `USERNAME_CASE_COLLISION`, `INVENTORY_INCOMPLETE`, `INVALID_SOURCE_ROW`; decided here: `CUSTOMER_MISSING`, `PRODUCT_MAPPING_UNRESOLVED`, `SUBSCRIPTION_REF_BLOCKED`, `CONFLICTING_EXISTING_ENTITY`, `UNSUPPORTED_SHAPE` |
| `FAILED`          | `FAILED` / `PROVIDER_READ_FAILED` | the provider record had no readable usage, or an unusable link: not a question for a person (it is not a review reason); a rerun with a fresh read processes it again                                                                                                                                                                     |
| `REVIEW_CLOSED`   | none                              | a person closed this invoice's review to reruns (Item 9: DISMISSED, or RESOLVED other than `RETRY_AFTER_FIX`); nothing is decided until they reopen it                                                                                                                                                                                    |

Every review reason is a `LEGACY_REVIEW_REASON_CODES` member (Item 9), checked at compile
time (`satisfies`). An invoice key outside the map's evidenced shape is answered
`MANUAL_REVIEW / INVALID_SOURCE_ROW` with `recorded: false` and nothing written: the map
refuses such a key by design, and the importer reports it from its own run.

## 10. Contracts and migrations

- `ServiceAdopted` domain event (own commit): ids and state only.
- No migration. orders.origin (0187/0188), the import map (0190), its `invoice` key (0191)
  and the review reasons/state (0192, Item 9 — cherry-picked locally beneath this branch
  until it merges) already hold everything the adoption writes.

## 11. Tests and mutation

- `tests/unit/reminder-burst-seed.test.ts` — `passedReminderKinds`: healthy, every expiry
  prefix, the day-of rung from the query's boundary, expired, unlimited, every usage
  boundary, unlimited allowance, unmeasured figure, tenant thresholds, switches ignored.
- `tests/integration/reminder-burst-seed.test.ts` — near expiry, the next genuine threshold
  fires once, several passed volume thresholds then the next, expired (expired notice never
  sent), healthy then its first real threshold, a renewal re-arms, rerun, two seeds racing,
  the day-of rung in the tenant's timezone, unmeasured usage, another tenant's service,
  a stopped scope.

`scripts/mutate-migration-p6.py` reverts one rule at a time:

| Mutation                        | Killed by                                                   |
| ------------------------------- | ----------------------------------------------------------- |
| S1 only the due expiry kind     | near expiry; expired; day-of rung                           |
| S2 no usage kinds               | several passed volume thresholds; expired                   |
| S3 ignore `usage_synced_at`     | unit: unmeasured figure (equivalent against the DB's CHECK) |
| S4 day start in UTC             | day-of rung in the tenant's timezone                        |
| S5 no tenant filter in the read | another tenant's service                                    |
| S6 no scope-activity read       | a stopped scope                                             |

### Item 7

- `tests/integration/legacy-adoption.test.ts` (25 cases, every adoption call made with the
  process's `http`/`https`/`fetch` replaced by a recording fake that throws — asserted
  never called): happy path (order shape, service row, funded hold, map row, audit and event
  free of the link and Telegram id); rerun (same key replays, new key `ALREADY_ADOPTED`,
  changed checksum reported and never re-pointed); reused key with another payload refused;
  six concurrent adoptions of one invoice → one order, one service; existing customer beside
  their own service; customer missing then created; every match passthrough; an invoice key
  outside the evidenced shape (nothing written); a spelling that does not fold to the key;
  resolved/unresolved hidden product (including one priced by hand); no / foreign / inactive /
  window-mismatched product; state mapping incl. disabled → SUSPENDED and the refusals;
  unlimited traffic/time and no link; non-RickPanel → `SUBSCRIPTION_REF_BLOCKED`; distinct
  subscription refs; name conflicts on the panel and in another tenant's namespace; capacity
  over cap reported; reminder seed inside the adoption; revenue exclusion and an inert
  provisioner tick; renewal quotes the current tariff and follows a price change; permission
  denied and audited; stopped tenant (adoption and review); tenant isolation; run counters.
- `tests/unit/legacy-adoption-boundary.test.ts` — no surface or web page reaches it; the
  module imports no provider client, adapter, transport or network API; its container
  wiring has no provider dependency. `tests/unit/legacy-adoption-rules.test.ts` — the state
  map and the request hash.

| Mutation (`scripts/mutate-migration-p6.py`) | Killed by                               |
| ------------------------------------------- | --------------------------------------- |
| A1 the adoption makes a provider read       | every adopting case (the network fake)  |
| A2 no per-invoice lock                      | concurrency                             |
| A3 no ALREADY_ADOPTED lookup                | rerun; concurrency                      |
| A4 hold keeps the exact case                | happy path                              |
| A5 no username conflict check               | both conflict cases                     |
| A6 any provider type                        | subscription constraint                 |
| A7 disabled becomes ACTIVE                  | state mapping                           |
| A8 delivery PENDING                         | happy path                              |
| A9 no reminder seed                         | reminder seed in the adoption           |
| A10 STANDARD origin                         | happy path; rerun; concurrency; revenue |
| A11 no scope-activity read                  | stopped tenant (review decision)        |
| A12 customer lookup ignores the tenant      | tenant isolation                        |
| A13 over-cap never reported                 | capacity                                |
| A14 no window-shape check                   | product refusals                        |
| A15 hidden-shape gate skipped               | unresolved shape priced by hand         |

A11 and A15 survived the first run (each case was also refused by a neighbouring rule); the
cases were narrowed until each isolates its rule, and both are now killed.

## 12. Manual acceptance (not run here)

- Adopt a handful of real RickPanel accounts on staging from a real legacy dump; confirm the
  panel shows NO change (status, `sub_updated_at`, usage) — provider writes 0.
- The adopted customer's Telegram service screen shows the account with the panel's link
  (when the importer passed one) and correct usage/expiry; refresh (a GET) works.
- Renew one adopted service and confirm the quote is the CURRENT tariff of its product.
- Watch the first reminder sweep after a bulk adoption: zero historical messages.
