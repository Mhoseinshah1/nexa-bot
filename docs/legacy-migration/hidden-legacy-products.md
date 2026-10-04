# Hidden Legacy Products — prerequisites (Item 14)

**Status: DONE (prerequisites), P6 HOLD.** What exists is the canonical shape key, one
stable hidden product per tenant per shape, the current-tariff resolution with an
explicit UNRESOLVED state, a database guard that keeps the product hidden, and the
adoption predicate P6 will call. Nothing adopts a service, calls a provider, or imports
data. No HTTP or Telegram surface reaches it yet; the P7 importer is on hold.

The numbers this design is sized against are the earlier audit's (7,369 active-real
productless invoices: 6,799 normal, 570 custom). The final figures are Q1/Q1b of
[`sql-evidence.md`](sql-evidence.md), which is MANUAL ACCEPTANCE.

## 1. The audit: what already exists, and what it decides

| Existing piece                                | What it means here                                                                                                                                                 |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `products.audience = 'HIDDEN'` (`catalog.ts`) | live but unlisted; `audienceClause` keeps it out of the customer AND the reseller catalogue                                                                        |
| `unorderableReason`                           | a HIDDEN product is still orderable by direct reference — **unless it has no category** (`NOT_CATEGORISED`) or no panel (`NOT_FULFILLABLE`)                        |
| `CommercialActionService.quoteRenewal`        | a renewal re-quotes the SERVICE's own product at its **current** list price, through `PricingService.price`; it reads no category and uses the service's panel     |
| `PricingService.price` / `pricing-engine.ts`  | the one pricing boundary; discounts, reseller layer and cashback act on its quote                                                                                  |
| `services.product_id`                         | a service names the product it renews from; the creation trigger only requires it to be non-null exactly when its order's is                                       |
| Package D (`CUSTOM_SERVICE`)                  | a NEXA custom service has **no** product and is not renewable (`OQ-PKG-D-01`) — so a legacy custom service cannot become one; it needs a product to stay renewable |

So the representation is: a legacy service whose invoice named no product references a
**hidden, uncategorised, panel-less product** that stands for its shape. It renews
through the existing renewal path at that product's current price, and it can never be
bought new: the order path refuses an uncategorised (and panel-less) product, while the
renewal path never asks.

## 2. The canonical shape key

`legacyShapeKey` (`apps/api/src/modules/commerce/catalog/application/legacy-shape.ts`)
reduces the five legacy tariff facts to a deterministic, versioned key:

```
legacy-shape:v1:[<code_panel|null>, "<traffic bytes>", <days>, <0|1 custom>]
```

| Legacy column                | Canonical form                                                                                                                                              |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `code_panel`                 | trimmed; empty → `null` (the missing-panel population). Case is kept: two spellings are not assumed to be one panel                                         |
| `Volume`                     | GB through `parseTrafficGb` (1 GB = 1 GiB, as everywhere in NEXA), bytes as text                                                                            |
| `Service_time` + `time_unit` | whole days; `time_unit` NULL/empty/`d`/`day`/`days` (any case) only                                                                                         |
| `is_custom`                  | `0`/`1`                                                                                                                                                     |
| `price_product`              | **not an input.** It is a historical purchase snapshot (owner decision: renew at the current tariff). Two invoices of one shape at two prices are one shape |

Refused as `UNMAPPABLE`, never guessed: an unknown `time_unit` (`month`, `hour`, …), a
zero volume or duration (whose legacy meaning — unlimited? — is not established), an
unparseable figure, an `is_custom` that is not 0/1, a control character or >200
characters in `code_panel`. An unmappable shape writes nothing, so it has no shape row,
which blocks its services from P6 by default. Q1c says whether the accepted set must
grow; growing it is an owner decision and a new key version.

## 3. Stable identity and the current tariff

`legacy_product_shapes` (migration 0181) holds one row per `(tenant, shape_key)` and the
one hidden product for it (`(tenant, product_id)` is unique too). `LegacyProductService`:

- **`ensureShape`** — idempotent by key AND by shape. Under a transaction-scoped
  advisory lock on `(tenant, shape_key)`, it returns the existing shape or creates the
  product — `INACTIVE`, `HIDDEN`, no category, no panel, **no price**, the shape's
  traffic and days, title `سرویس قدیمی · 10 GB · 30 روز` (operator data, renamable) —
  and the shape row, `UNRESOLVED / NOT_YET_RESOLVED`. Audited
  `legacy.product_shape.ensure`.
- **`resolveTariff` `MATCH`** — the current NEXA tariff is the price of the ACTIVE,
  `EVERYONE` product in the sales currency with exactly the same traffic and days that a
  customer can buy today — bound to a panel and in an `ACTIVE` category, the two further
  terms `unorderableReason` refuses a purchase on (`resolveCurrentTariff`, pure). A
  product in a withdrawn category, or with no panel, is a price from the past and is
  neither a tariff nor a second price that makes a match ambiguous (program 4 validation,
  defect V4-D1). One distinct price → `RESOLVED /
MATCHED_PUBLIC_PRODUCT`, the hidden product priced with it and ACTIVE, the source
  product recorded. None → `NO_CURRENT_TARIFF`; several prices → `AMBIGUOUS_TARIFF`;
  both leave the product inactive and unpriced. `RESELLERS_ONLY` and `HIDDEN` prices
  (including other legacy products) are never a tariff.
- **Re-resolution follows the tariff.** Run again after the public price moves, `MATCH`
  re-prices the hidden product to the current figure. A later run that finds no tariff
  leaves an already-RESOLVED shape as it was: withdrawing a renewal price an operator
  accepted is a decision, not a finding.
- **`resolveTariff` `STATED`** — the manual-review exit: an operator states the current
  tariff (sales currency, positive, with a reason) → `RESOLVED / OPERATOR_STATED`. This
  is how a custom shape with no public equivalent becomes renewable.
- **`legacyShapeAdoption(shape, product)`** — P6's gate, decided here so P6 cannot
  decide it differently: RESOLVED, and the product ACTIVE, HIDDEN, uncategorised,
  priced, and the shape's own product. A refusal carries a CLOSED reason for the manual
  review queue — `NO_SHAPE`, the shape's own `NOT_YET_RESOLVED` / `NO_CURRENT_TARIFF` /
  `AMBIGUOUS_TARIFF`, or `PRODUCT_NOT_ADOPTABLE` — so no caller invents a tariff or
  re-derives a reason. `legacyShapeAdoptable` is the same decision as a boolean.
- **A stated tariff yields to a current public one.** `STATED` is the exit for a shape
  NEXA does not sell; once NEXA sells it, a `MATCH` moves the shape onto that price
  (`MATCHED_PUBLIC_PRODUCT`), because the owner's rule is "renew at the current NEXA
  tariff". Pinned by a test so it is a decision, not an accident.

Permissions: `catalog.edit` for both writes, `catalog.view` to read. Each write reads
scope activity inside its transaction, is idempotent by key (namespaced by the actor's
surface), audits before/after as values, and records a DENIED audit row on refusal.
No outbox event: product creation emits none either, and nothing consumes one.

### Why the price is a copy, and when it moves

The renewal path prices the service's product from that product's own row. Making it
read a different product's price would change the one renewal path for every service; a
hidden product whose price is refreshed by `MATCH` keeps renewal untouched. The cost is
that the hidden price moves when a resolution runs, not at the instant the public price
changes. `OQ-I14-01` records the choice between a scheduled re-resolution and a live link.

## 4. What cannot leak

- **Catalogue.** `HIDDEN` excludes it from the customer and reseller catalogue queries;
  no category means no category page lists it either.
- **New sales.** No category → `NOT_CATEGORISED` at order confirmation; no panel →
  `NOT_FULFILLABLE`. A direct product reference cannot buy one.
- **Edits.** `nexa_legacy_shape_product_hidden` (migrations 0182, widened by 0185)
  refuses an UPDATE that would make a shape's product non-HIDDEN, give it a category, or
  CHANGE its `duration_days` or `traffic_bytes` — the two figures that are the shape, that
  the tariff is matched on, and that a renewal buys. Price, status and title stay
  editable — price and status are what a resolution writes.
- **Discounts, reseller terms, cashback.** The renewal goes through
  `PricingService.price` like any renewal, so exactly the current rules apply: a
  tenant-wide renewal discount applies, a product- or category-scoped one does not (the
  product is in no category and named by no rule), a reseller's tier grants do not name
  it. Nothing here grants or scopes anything.

## 5. Tests

- `tests/unit/legacy-shape.test.ts` — the key: deterministic, versioned, price-free,
  canonical spellings, every dimension separates, custom shapes, every refusal; the
  tariff rule (public/active/currency/spec, reseller-only never, ambiguity refused); the
  adoption gate.
- `tests/integration/legacy-products.test.ts` — one hidden inactive unpriced product per
  shape; reruns and other spellings and other historical prices do not duplicate; a real
  two-way race on one shape creates one product (barrier on the advisory lock — removing
  the lock fails it); custom shapes are their own product; unmappable writes nothing;
  UNRESOLVED when there is no tariff; ambiguity refused; a service references the hidden
  product and its renewal quotes the CURRENT tariff (never the 29,000 legacy price) and
  follows a tariff change on re-resolution; an accepted tariff survives a run that finds
  none; an operator states a custom tariff with a reason and it renews; never in the
  customer catalogue or a category page, never ordered new; the database refuses listing
  or categorising it, and changing its traffic or duration (an ordinary product's stay
  editable — reverting 0185 to 0182's guard fails this case); tenant isolation (same key, two products, no cross-tenant tariff,
  no cross-tenant id); `observer` is denied and nothing is written.

Mutation checked: removing `lockKey` from `ensureShape` fails the race case.

## 6. Coordination and what is deferred

- **Provenance link (Item 7).** `legacy_import_map` is being built on
  `wp3/i7-p4-import-metadata`. This package does not duplicate it: the shape row IS the
  provenance of a hidden product (key, panel code, dimensions, custom flag), and P7 will
  write one `legacy_import_map` row per invoice pointing at the service and naming the
  shape. That link is P7's, on hold.
- **`code_panel` → NEXA panel.** The hidden product deliberately names no panel; the
  service carries its own. The explicit `code_panel → panel UUID` map is P5/P6's.
- **Reseller renewals.** A legacy service owned by an ACTIVE reseller is decided by
  the one entitlement evaluator, `decideEntitlement`, unchanged: a tier that grants
  every category (a `CATEGORY` grant with no subject) covers a hidden legacy product
  like any other; a tier that names products or categories does not name it, and the
  renewal is refused for that reseller. Whatever reseller price layer the tier applies
  to any product applies here — no wider. Legacy agents are not recreated automatically
  (§19), so no reseller holds a legacy service until an operator makes one;
  `OQ-I14-02` asks whether such renewals should be granted explicitly.
- No P6 adoption, no importer, no provider call.

## 7. Final validation — program 4, Item 4 (2026-10-04)

Every program rule, the code that enforces it, and the test that fails when the rule is
reverted. "M" marks a rule mutation-checked in this pass or the original one (revert the
rule, watch the named test fail, restore).

| Program rule                                                                            | Code                                                                                                                               | Test(s)                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deterministic, versioned shape key                                                      | `legacyShapeKey` / `keyOfLegacyShape` (`legacy-shape.ts`), `LEGACY_SHAPE_KEY_VERSION`                                              | unit `legacy-shape.test.ts` "is deterministic and versioned", "canonicalises spellings", "separates every tariff dimension", "keeps the panel code exactly"                                                                                                                   |
| Historical `price_product` is not an input and never the renewal tariff                 | `LegacyShapeInput` has five fields, no price; product created `price: null`; `resolveCurrentTariff` reads only live products       | unit "has no price input at all"; unit `legacy-products-boundary.test.ts` "the shape input has exactly the five tariff facts" and "never the historical price"; integration `legacy-products.test.ts` "renews at the CURRENT tariff, never the historical price"              |
| No second productless pricing system                                                    | the hidden product is an ordinary `products` row; renewal is `CommercialActionService` → `PricingService.price` unchanged          | unit `legacy-products-boundary.test.ts` (pricing + commercial modules never mention legacy shapes; legacy code imports nothing from pricing); integration renewal quotes go through `commercialActions.draft`                                                                 |
| Renewal at the CURRENT NEXA tariff, following it                                        | `resolveTariff` `MATCH` re-prices from the current tariff                                                                          | integration "renews at the CURRENT tariff … follows it on re-resolution", "a stated tariff yields to a current public one"                                                                                                                                                    |
| The current tariff is a price a customer can buy today (V4-D1)                          | `resolveCurrentTariff` requires `panelBound` and a purchasable `categoryStatus`; the repository left-joins the category            | integration "takes no tariff from a product nobody can buy now" (failed first: `AMBIGUOUS_TARIFF`); unit "takes the price a customer can buy today", "has no tariff when nothing public, active and priced sells this shape" — M (dropping either term fails both unit cases) |
| Custom legacy services remain renewable                                                 | custom is its own shape; `STATED` with a reason → `OPERATOR_STATED`                                                                | integration "separates a custom shape", "lets an operator state the tariff of a custom shape … and it renews"                                                                                                                                                                 |
| Hidden products never in a normal catalogue / audience path                             | `audienceClause` excludes `HIDDEN` for CUSTOMER and RESELLER; no category, no panel; `unorderableReason` → `NOT_CATEGORISED`       | integration "is never listed and never sold as a new service", "stays out of every catalogue audience, customer and reseller, even once bound to a panel" — M (making `audienceClause` list `HIDDEN` for resellers fails it)                                                  |
| The product cannot be made listable or re-shaped                                        | `nexa_legacy_shape_product_hidden` (0182, 0185)                                                                                    | integration "refuses, at the database, an edit that would list or categorise it", "… a change to the shape's traffic or duration" — M (0182 vs 0185)                                                                                                                          |
| Repeated import creates no duplicate hidden product, including concurrently             | idempotency by key and by shape; advisory lock on `(tenant, shapeKey)`; unique `(tenant, shape_key)`                               | integration "does not duplicate a shape", "creates one product when the same shape is ensured concurrently" — M (removing `lockKey`)                                                                                                                                          |
| No safe current-tariff mapping ⇒ closed manual-review outcome, never an invented tariff | UNMAPPABLE writes nothing; `UNRESOLVED` with a closed reason, product inactive and unpriced; `legacyShapeAdoption` closed blockers | unit refusal table, "names a closed manual-review reason"; integration "writes nothing for a shape it cannot map", "stays UNRESOLVED …", "refuses to guess between two current prices", "gives P6 a closed manual-review reason for every shape it may not adopt"             |
| An accepted tariff is not withdrawn by a run that finds none                            | `MATCH` leaves a RESOLVED shape as it is                                                                                           | integration "keeps an accepted tariff when a later run finds none"                                                                                                                                                                                                            |
| Tenant isolation, deny by default, scope activity in the transaction                    | scoped repository; `catalog.edit` / `catalog.view`; `assertScopeActive(tx)`                                                        | integration "keeps tenants apart", "denies an actor without catalog.edit", "refuses both writes once the tenant has stopped accepting work"                                                                                                                                   |

**Defect found and fixed — V4-D1.** `resolveCurrentTariff` took any ACTIVE, `EVERYONE`,
priced product of the shape as "the current tariff", including one in a withdrawn
(`INACTIVE`) category or with no panel — products `unorderableReason` refuses to sell.
Such a price could become a legacy service's renewal price, or make a real match
`AMBIGUOUS_TARIFF`. The integration case was written first and failed
(`expected 'AMBIGUOUS_TARIFF' to be 'NO_CURRENT_TARIFF'`); the fix narrows the candidate
filter only, so its effect is strictly toward fewer matches or a cleaner single match.
No migration: the rule is in the query and the pure filter.

**Owner decisions kept as documented, not re-decided here:** `OQ-I14-01` (re-resolution
is on demand, the renewal path is not live-linked), `OQ-I14-02` (resellers decided by the
unchanged entitlement evaluator), `OQ-I14-03` (only NULL/`d`/`day`/`days` and a positive
volume are mappable until Q1c). Q1/Q1b/Q1c themselves remain MANUAL ACCEPTANCE
(`sql-evidence.md`); no synthetic result here is legacy evidence.
