# Phase 4B audit — what Phase 4A already froze

Written before any Phase 4B implementation, for the reason `docs/phase4-audit.md`
was: the expensive mistake available here is inventing a second vocabulary beside
one that already exists. Products, orders, their states, their permissions, their
snapshot columns and their customer-facing template keys are **already in `main`**.
Phase 4B implements them. It does not design them.

Everything below was read from the merged tree at
`2cfd75f5ca231c7430e35c066fa5e3aee9cd89fd`.

---

## 1. What `Product` already means

Frozen in `packages/contracts/src/catalog.ts` and the `products` table
(`schema.ts`, migration 0032).

| Concept       | Frozen as                                                      | Note                                                                      |
| ------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------- |
| identity      | `ProductId` (branded, `ids.ts`)                                | not a new id type                                                         |
| status        | `PRODUCT_STATUSES = ['ACTIVE','INACTIVE']`                     | **two** values, not a lifecycle                                           |
| visibility    | `PRODUCT_AUDIENCES = ['EVERYONE','RESELLERS_ONLY','HIDDEN']`   | its own axis, deliberately not the tier enum                              |
| specification | `durationDays`, `trafficBytes` (bigint), `deviceLimit \| null` | `0` = unlimited for the first two; `null` device limit = provider default |
| price         | `priceAmount` + `priceCurrency`, **both nullable together**    | CHECK `(price_amount IS NULL) = (price_currency IS NULL)`                 |
| fulfilment    | `panelId`, nullable                                            | a product names a **panel**, never a provider type                        |
| ordering      | `sortOrder` 0..100000, then `createdAt`, then `id`             | the index `products_tenant_sort_idx` is exactly this                      |

Two predicates are already written and are the only correct readings of the two
state axes:

```ts
isPurchasable(status); // status === 'ACTIVE'
isListed(status, audience); // isPurchasable && audience !== 'HIDDEN'
```

`HIDDEN` is explicitly **not** `INACTIVE`: a hidden product is live and unlisted
(sellable through a link an operator pastes), an inactive one cannot be bought by
anyone. Collapsing them would make "unlist" and "stop selling" one button.

**A product with no price is not free** — it is a product that cannot be sold. The
contract says so in its header, and the nullable price pair is how it says it.

**There is no category entity.** `catalog.view` is labelled "View products and
categories", but no `categories` table and no category contract exists anywhere in
the tree. Categories are therefore **not frozen and not Phase 4B's to invent**.

### Not frozen, and therefore not built

No stock, no inventory, no provider allocation, no dynamic availability, no
discount price, no reseller price, no referral price column exists on `products`.
The one recorded owner decision about fulfilment says why auto-allocation is
absent, and it is binding:

> `web.planned_products_panel_choice` — there will be **no automatic "least loaded
> panel" selection**. Either the product is tied to a specific panel, or the
> customer chooses the panel at purchase time.

Phase 4B takes the first branch: the product's own `panelId`. Customer panel
choice is a later phase's surface.

---

## 2. What `Catalog` already means

There is no catalog table, and there should not be one. The catalogue is a **read
model over `products`**, and its membership rule is already written as
`isListed(status, audience)`.

`bot.catalog.empty`'s frozen description states the customer-visible rule exactly:

> "Shown when a tenant has no listed, **priced, fulfillable** product."

So a product reaches a customer only when all four hold: `ACTIVE`, audience is not
`HIDDEN`, it has a price pair, and it has a `panelId`. That is not a Phase 4B
invention — it is the description of a template key frozen in `main`.

Ordering is `sortOrder, createdAt, id`, which is the existing index, so the
catalogue's ordering is deterministic without adding anything.

---

## 3. What `Order` already means

Frozen in `packages/contracts/src/commerce.ts` and the `orders` table.

```
DRAFT ──CONFIRM──► AWAITING_PAYMENT ──SETTLE (guard: settlementIsFunded)──► PAID ──REFUND──► REFUNDED
  │                      │
  ├─CANCEL─► CANCELLED   ├─CANCEL─► CANCELLED
  └─EXPIRE─► EXPIRED     └─EXPIRE─► EXPIRED
```

Six states, five events, three terminal (`CANCELLED`, `EXPIRED`, `REFUNDED`).
`PAID` is reachable only through a **guarded** transition whose guard is named
`settlementIsFunded` — money that is real, never a client assertion.

**The Phase 4B boundary falls exactly on an existing edge.** `AWAITING_PAYMENT` is
defined in the contract as "confirmed by the customer, priced, and waiting for
money". Phase 4B owns `DRAFT` and `CONFIRM`; `SETTLE` is 4C's and is not
implemented, not stubbed and not faked. No new state is needed to express the
boundary, which is the strongest evidence the machine was designed for this split.

Per-order limits are already fixed: `MAX_ORDER_LINES = 1`, `MAX_ORDER_QUANTITY = 1`
— narrower than the schema so it can widen without a migration.

### The snapshot invariant, already enforced by columns

Every `line_*` column on `orders` is a snapshot taken at confirmation:
`lineTitle`, `lineDurationDays`, `lineTrafficBytes`, `lineDeviceLimit`,
`lineUnitPriceAmount`, `lineQuantity`, plus `panelId` and the whole `quote` jsonb.

`productId` and `panelId` are retained for **navigation only**. The contract says
in terms that they are "explicitly NOT how the purchase is reconstructed". The
legacy «محصول حذف‌شده» is what a report that joins on today's product row produces.

The database already enforces the arithmetic and the lifecycle:

- `orders_total_consistent_check`: `total = subtotal - discount`
- `orders_discount_bounded_check`, `orders_amounts_check`: no negative total
- `orders_settled_at_check` / `_refunded_at_check` / `_cancelled_at_check`: each
  timestamp exists exactly when its state has been reached
- `orders_state_check`: the state enum, from the contract

### Tenancy is already a database guarantee

Two composite foreign keys exist and must be **used, not re-implemented in
application comments**:

```
orders_customer_fk  (tenant_id, customer_id) → customers(tenant_id, id)
orders_product_fk   (tenant_id, product_id)  → products(tenant_id, id)
```

An order naming another tenant's customer or another tenant's product is not
unlikely — it is **unrepresentable**. `products_tenant_id_key` and
`orders_tenant_id_customer_key` are the unique constraints those references target.

---

## 4. Pricing — what Phase 4B may and may not own

`PRICING_PRECEDENCE` is frozen as data in `pricing.ts`:

```
BASE_PRICE (REPLACES) → TIER_PRICE (REPLACES) → PANEL_ADJUSTMENT (ADJUSTS)
→ CUSTOM_SERVICE_FORMULA (REPLACES) → USER_OVERRIDE (REPLACES)
→ PROMOTIONAL_DISCOUNT (ADJUSTS)
```

with two properties this phase must respect:

1. **It is pending owner sign-off** (`docs/open-questions.md`, O-1) because the
   legacy system has no precedence to reproduce (`PRICING_PRECEDENCE = UNKNOWN`,
   SBR-033). Phase 4B therefore implements **only `BASE_PRICE`** and leaves the
   remaining five steps unimplemented rather than guessing them.
2. **A quote's trace is mandatory** — `PriceQuote.trace` is not optional, and
   `commerce.ts` says a quote without one is refused. So a Phase 4B order carries a
   real one-step trace naming `BASE_PRICE`, not an empty array.

Wallet application and cashback are recorded as _settlement_ concerns and are
deliberately absent from the precedence. Phase 4B does not touch them.

---

## 5. Permissions — already frozen, do not invent

Products are governed by the **`catalog.*`** vocabulary, not a `products.*` one:

| Permission               | Risk    | Phase 4B use                                  |
| ------------------------ | ------- | --------------------------------------------- |
| `catalog.view`           | LOW     | read products                                 |
| `catalog.edit`           | default | create / edit / change state                  |
| `catalog.pricing.edit`   | HIGH    | pricing **rules** — 4C+, not 4B               |
| `catalog.discounts.edit` | HIGH    | 4E                                            |
| `orders.view`            | LOW     | read orders                                   |
| `orders.cancel`          | HIGH    | cancel — an edge 4B owns                      |
| `orders.manual.create`   | HIGH    | operator-created order — not a 4B requirement |

A product's _price field_ is edited under `catalog.edit` (it is a property of the
product); `catalog.pricing.edit` governs pricing **rules**, which do not exist yet.

**No system role but `owner` holds `catalog.edit`.** `operator` and `sales` carry
`catalog.view` only, and `sales` adds `catalog.discounts.edit` without it. Found while
writing the RBAC tests, which had to build a custom role to charge the permission at
all. It is a frozen decision — the catalogue is the owner's to curate — and Phase 4B
does **not** change `ROLE_SEEDS`: widening a role is a permission-model change with no
producer in this phase, and the rule is that a permission arrives only with its first
consumer. The tests therefore grant `catalog.edit` through a custom role rather than
borrowing `owner`, which holds everything and would prove nothing about which key the
route actually wants.

---

## 6. Events and audit

`AGGREGATE_TYPES` contains `Order` and **does not contain `Product`**. The event
catalogue defines `OrderConfirmed`, `OrderSettled`, `OrderCancelled`,
`OrderRefunded` — and no `OrderCreated` and no product event at all.

Two consequences, both narrowing:

- The first order event is `OrderConfirmed`, emitted on `DRAFT → AWAITING_PAYMENT`.
  Creating a `DRAFT` emits nothing, because the frozen catalogue names no such
  fact. `OrderSettled` / `OrderRefunded` belong to later phases and are not emitted.
- **Product mutations produce audit rows, not domain events.** Adding a `Product`
  aggregate and product events would be a contract change with no consumer, which
  is the placeholder-infrastructure pattern `0002_drop_callback_refs` exists to
  record. Audit is the repository's normal evidence for an admin mutation and is
  sufficient.

`OrderConfirmed`'s payload is fixed: `{ customerId, productId, totalMinor, currency }`.

---

## 7. Customer-facing text — frozen keys with declared placeholders

| Key                          | Placeholders                                              | Phase 4B role                          |
| ---------------------------- | --------------------------------------------------------- | -------------------------------------- |
| `bot.catalog.heading`        | —                                                         | introduces the list                    |
| `bot.catalog.empty`          | —                                                         | no listed, priced, fulfillable product |
| `bot.order.summary`          | `productTitle`_, `total`_, `durationDays`, `trafficBytes` | the summary a customer **confirms**    |
| `bot.order.awaiting_payment` | `total`_, `expiresAt`_                                    | the truthful terminal 4B message       |
| `bot.order.cancelled`        | —                                                         | cancellation                           |
| `bot.blocked`                | —                                                         | outranks every intent (4A rule)        |

`bot.order.settled` exists and is **not** used by Phase 4B: nothing here settles
anything, and rendering it would be the fake claim the scope forbids.

Two facts this fixes for the flow:

- `bot.order.summary` says "the summary a customer **confirms**", so `DRAFT` is a
  real customer-visible step and not an implementation detail to skip.
- `bot.order.awaiting_payment` **requires `expiresAt`**, so confirming an order must
  compute an expiry. See §9.

Phase 4A's `bot.start.welcome` currently says purchasing is not yet enabled. That
sentence becomes false the moment a catalogue exists, and Phase 4B must update it —
the same "copy must be true of this head" rule that produced it.

---

## 8. What Phase 4B inherits and must reuse rather than rebuild

| Thing                 | Where                                           | Rule                                                                       |
| --------------------- | ----------------------------------------------- | -------------------------------------------------------------------------- |
| keyset cursor         | `surfaces/web/keyset-cursor.ts`                 | **moved** in 4A for exactly this reuse; `(createdAt, id)` microsecond TEXT |
| seven-step write path | `runAuthorizedMutation`                         | permission re-checked **inside** the committing transaction                |
| idempotency           | `IdempotencyStore` + `rememberOnce`             | loser's insert is a CONFLICT that rolls its whole transaction back         |
| scope activity        | `ScopeActivityReader.scopeIsActive`             | read **inside** every write transaction                                    |
| audit                 | `AuditWriter`                                   | in the business transaction                                                |
| outbox                | `OutboxWriter`                                  | in the business transaction                                                |
| Telegram send         | `send-message.ts` / `TelegramCustomerMessenger` | refuses to run inside a transaction at all                                 |
| bot runtime           | `bot-runtime.ts`                                | `BOT_INTENTS` is documented as "later subphases add members"               |
| customer resolution   | `CustomerService.resolveFromUpdate`             | one upsert, idempotent, `status` never touched                             |

The products cursor is **not** the same shape as the customers cursor: products
page on `(sortOrder, createdAt, id)`, a three-part key, while `keyset-cursor.ts`
encodes `(createdAt, id)`. Orders page on `(createdAt, id)` and reuse it directly.
Whether the products list needs the three-part key or can page on `(createdAt, id)`
with `sortOrder` as a _display_ order is a Phase 4B decision recorded in its own
commit — it is not a licence to copy the cursor file.

---

## 9. What Phase 4B must add, and why each is not an invention

Each of these has its **first producer and first consumer in this phase**, which is
the repository's stated bar for adding to a frozen contract.

| Addition                                 | Why it cannot be avoided                                                                                                                                                                                                                             |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| order-expiry **setting**                 | `bot.order.awaiting_payment` requires `expiresAt`; `ORDER_EXPIRY_MINUTES_MIN/MAX` exist as bounds with **no value**, and `commerce.ts` says the window "is an operator SETTING". The bounds without a setting is a contract that cannot be honoured. |
| product / order **error codes**          | `errors.ts` has `CUSTOMER_NOT_FOUND` and a full `panel.*` family but nothing for products or orders. A refusal needs a code.                                                                                                                         |
| product / order **HTTP shapes + routes** | `http.ts` has none.                                                                                                                                                                                                                                  |
| new **BOT_INTENTS** members              | the file documents this as the extension point.                                                                                                                                                                                                      |
| Web Admin **Products / Orders** pages    | both are currently `PLANNED_SURFACES` entries.                                                                                                                                                                                                       |

Nothing here adds a state, an aggregate, a permission or a pricing step.

### Migrations

0032–0036 are on `main` and are **never edited**. The `products` and `orders`
tables already have every column Phase 4B needs, so the expected number of new
migrations is **zero for the core model**. Any genuinely new index or constraint
becomes `0037+`.

---

## 10. Rules already decided that Phase 4B must obey

1. An existing order **must not change when its product changes later** — snapshot
   columns exist for this and the contract forbids reconstruction by join.
2. A product with no price, or no panel, is **not sellable** — and it is refused at
   order time naming the product, not silently hidden (`catalog.ts` on the null
   `panelId`: "refused at order confirmation rather than at browse time, because
   the refusal message an operator needs names the product").
3. `HIDDEN ≠ INACTIVE`.
4. One product per order.
5. No automatic panel selection.
6. An ordinary `AWAITING_PAYMENT` order is **not** "needs attention"
   (`web.planned_orders_attention`).
7. Order history is preserved and never overwritten by one generic current status
   (`web.planned_orders_history`).
8. The Orders page and the future Payments page share **one** projection so they can
   never show contradictory states (`web.planned_orders_shared_projection`) — so
   Phase 4B builds that projection once, and does not build a second one later.
9. A blocked customer gets `bot.blocked` for **every** intent — 4A's `replyFor`
   makes BLOCKED outrank the intent, so a blocked customer cannot reach a catalogue
   or create an order, without any new rule.
10. Resolve → commit → reply. No network inside a business transaction.

---

## 11. Deliberately left unresolved (4C–4F)

Recorded so that a later reader can tell a deferral from an oversight:

- **Pricing steps 2–6.** `TIER_PRICE`, `PANEL_ADJUSTMENT`, `CUSTOM_SERVICE_FORMULA`,
  `USER_OVERRIDE`, `PROMOTIONAL_DISCOUNT` — frozen as data, unimplemented, and the
  precedence itself is still pending owner sign-off (O-1).
- **Settlement.** `SETTLE`, the `settlementIsFunded` guard, `payments`,
  `wallet_entries`, `bot.order.settled`. 4C.
- **Expiry sweeping.** `orders_expiry_idx` exists and covers `AWAITING_PAYMENT`
  only; nothing sweeps yet. The `EXPIRE` edge is frozen and unimplemented. 4C.
- **Provisioning.** `services`, `provisioning_operations`, every provider call. 4D.
- **Discounts / referrals / trials / resellers.** Tables and contracts exist;
  `RESELLERS_ONLY` is declared and consumed in 4F.
- **Categories.** Named in a permission label, entity nowhere. Not designed.
- **Customer-chosen panel at purchase.** The second branch of
  `web.planned_products_panel_choice`.
- **Manual operator order creation.** `orders.manual.create` exists; no surface
  requires it in 4B, so it gets no producer here.

---

## 12. The one thing this audit changes about the plan

The instruction's scope list says "Orders" and "order/product snapshots". The
frozen machine shows the boundary is **`AWAITING_PAYMENT`, reached through
`CONFIRM`** — not a new "created" state and not `PAID`. So the Phase 4B customer
flow is three steps against two frozen template keys:

```
/catalog        → bot.catalog.heading + listed products   (or bot.catalog.empty)
select product  → DRAFT order + bot.order.summary          (price computed server-side)
confirm         → CONFIRM → AWAITING_PAYMENT + bot.order.awaiting_payment
```

and it stops there, because the next edge needs money that no phase in this branch
can produce.
