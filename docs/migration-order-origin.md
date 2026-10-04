# Migration P3 — `orders.origin` and `LEGACY_ADOPTION`

Status: built (contracts, schema, report and guard adjustments, test helpers, tests). The
adoption **write path (P6) is HOLD**: nothing in `apps/` creates a `LEGACY_ADOPTION` order.

## Why an order at all

An adopted legacy service is a provider account the legacy bot sold that NEXA must now
represent. `services.order_id` is NOT NULL and unique and `orders.panel_id` is NOT NULL,
so the service needs an order. The registered decision: **no new purpose** — the order is
`purpose = NEW_SERVICE` and `origin = LEGACY_ADOPTION`.

## Schema (0187 generated, 0188 hand-written)

| Rule                                                                                                                                                    | Where |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `orders.origin text NOT NULL DEFAULT 'STANDARD'` — the default IS the backfill: every existing row and every writer that does not name it is `STANDARD` | 0187  |
| `orders_origin_check`: `origin IN ORDER_ORIGINS`                                                                                                        | 0187  |
| `orders_legacy_adoption_shape_check`: an adoption is `NEW_SERVICE`, `PAID`, subtotal = discount = total = 0, no discount code                           | 0187  |
| `orders_origin_immutable` trigger: `origin` cannot be rewritten in either direction                                                                     | 0188  |

Consequences of the shape check, by construction rather than by every query remembering:

- **Never revenue.** The total is 0, so no money figure can include an adoption even where
  a count forgot the origin. The legacy purchase price may be kept on the LINE
  (`line_unit_price_amount`) as a snapshot; it is not read by any total.
- **Never refunded.** `PAID` only — `REFUNDED` is refused, and there is no payment for any
  refund path to find. `ProvisionerService.refundPurchase` also declines an adoption
  explicitly before touching the service.
- **Never re-classified.** A real sale cannot be turned into an adoption (erasing revenue)
  and an adoption cannot become a sale (inventing it).

## Contracts

`ORDER_ORIGINS = ['STANDARD', 'LEGACY_ADOPTION']`, `DEFAULT_ORDER_ORIGIN`,
`orderOriginSchema` (`commerce.ts`); `orderOriginIsSale` (exhaustive) and
`SALE_ORDER_ORIGINS = ['STANDARD']` (`reporting.ts`). `OrderRecord.origin` is read by the
order repository; no writer sets it.

## Reports and triggers

Every `orders o` read in `drizzle-reporting.repository.ts` that counts sales, revenue,
buyers, successful orders, renewals, products, traffic sold, referred sales, reseller
sales, the financial statement's sales/channels/products, the orders drill-down, new
services (summary and per panel) carries `o.origin = ANY(SALE_ORDER_ORIGINS)`. Live service
counts (`activeServices`, service states) are NOT filtered: an adopted service is live.

Origin alone triggers nothing:

- **Provisioning** is driven by `provisioning_operations` rows written at settlement; an
  adoption is never settled through NEXA, so none exists. The provisioner tick is proven
  inert over an adoption.
- **Cashback / commission** are earned only from rows promised at confirmation
  (`order_cashback`, `order_referral_commissions`); an adoption is never confirmed.
- **Referral signup gift** (`referredPurchases`) reads only `SALE_ORDER_ORIGINS`, proven
  even beside a SUCCEEDED PROVISION operation for the adoption.

Deliberately unchanged, and why:

- **First-purchase discounts** (`isFirstPurchase`) still count an adoption as a prior
  purchase: a migrated customer bought before, and the conservative answer gives no
  first-buyer discount away.
- **Audience segments** ("purchased", "last purchase") and the Customer 360 order
  aggregate still see the adoption as a PAID order. P6 decides `settled_at` (the legacy
  purchase time is the natural choice), which is what those read. Recorded for P6.
- Operator order lists and order lookups are unchanged; an adoption is a real order.

## Tests

- `tests/integration/order-origin.test.ts` — column/default/constraints/trigger exist;
  an ordinary order gets STANDARD without naming it; an adoption reads back; priced,
  re-purposed and refunded adoptions are refused; origin rewrites refused both ways;
  summary, dashboard, financial, products, services, orders drill-down and infrastructure
  exclude it; referred purchases exclude it; first-purchase unchanged; a provisioner tick
  creates no operation, ledger entry, refund, cashback or commission; tenant isolation.
  Mutation-checked: making the report origin predicate always true, and dropping the
  signup-gift origin filter, each fail it.
- `tests/integration/legacy-adoption-fixture.ts` — `insertLegacyAdoptionOrder` /
  `insertLegacyAdoption`, the test-only helpers that write an adoption directly.
- `tests/unit/reporting-contracts.test.ts` — the origin vocabulary and its sale rule.
