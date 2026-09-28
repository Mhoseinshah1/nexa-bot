# Package D — custom service (سرویس دلخواه): audit and design

The post-WP20 brief's Package D. A customer picks a location, types a volume in GB and a
duration in days, and pays a price computed from the operator's range rules. The purchase is
then paid for, settled and provisioned through the ordinary Nexa pipeline.

This document is written before the implementation, as the repository's convention
requires. It records what exists, the model chosen, and every decision the brief leaves to
the implementation.

## 1. What exists, and what blocks a product-less purchase

- **Every order names a product.**
  - `orders.product_id` is NOT NULL, and so is `services.product_id`.
  - `OrderLine.productId`, the `OrderConfirmed` event, and the HTTP order and service
    summaries all require one.
  - `OrderService.confirm` re-reads the product to decide whether it is still orderable.
- **Add-ons already fill `orders.product_id` with a navigation value**: the service's own
  product.
- **The pricing contract reserves a step for this.**
  - `PRICING_STEPS` has had `CUSTOM_SERVICE_FORMULA` (effect `REPLACES`) since Phase 0.
  - Nothing applies it yet.
- **Provisioning never re-reads the product.**
  - `planForSettledOrder` builds the service from the order's snapshot.
  - The provisioner reads the specification from the order.
  - So an order whose `line_*` snapshot is right provisions unchanged.
- **Purpose is dispatched by exhaustive switches** in `commerce.ts` (`orderPurposeCreatesNewService` and siblings) and `reporting.ts`, plus typed maps:
  - `PURCHASED_AS`, the operation type that proves a purchase was delivered;
  - `OPERATION_LABELS`;
  - the Web Admin label maps.
- **Literal `'NEW_SERVICE'` checks.** Each one is classified in §3.
- **Customer tiers.** No customer tier exists. The only tiers are reseller tiers (WP9-B). A customer's "tier" in this package is therefore:
  - their reseller tier when they are an ACTIVE reseller;
  - otherwise the ordinary-customer tier.
- **Text captures.** `customer_text_captures` is the generic customer text window, the one a top-up amount uses. It gains two purposes here.

## 2. The model: an honest `CUSTOM_SERVICE` purpose

The brief says "Do not fake this by creating an invisible ordinary product for every
purchase", and "no fake product dependency" is a named test. So:

- **The purpose.** `ORDER_PURPOSES` gains `CUSTOM_SERVICE`. It creates a new service, exactly as `NEW_SERVICE` and `TRIAL` do: `orderPurposeCreatesNewService` is true. This is a contract change and gets its own commit.
- **The product column.** `orders.product_id` becomes nullable, and `orders_product_purpose_check` pins it:
  `(product_id IS NULL) = (purpose = 'CUSTOM_SERVICE')`.
  - A custom order never names a product.
  - Every other order still must.
- **The service's product column.** `services.product_id` becomes nullable.
  - `nexa_service_requires_purchase_order` already refuses a service for a non-creating purpose.
  - It now also requires a CUSTOM_SERVICE order's service to have no product, and every other service to have one.
- **The line snapshot is the purchase.** The order's `line_*` columns hold:
  - the location label as `title`;
  - the days as `duration_days`;
  - the bytes as `traffic_bytes`;
  - the custom base price as `unit_price`, with quantity 1.

  That is the snapshot the provisioner and every order view already read.

- **The pricing snapshot.** A new table, `order_custom_service_terms`, holds what a line cannot (§5). It is written once, in the draft's transaction, and refused an UPDATE or a DELETE.
- **The service.** It is created from the order exactly as a `NEW_SERVICE` one is:
  - the panel comes from `order.line.panelId`;
  - the traffic comes from the line;
  - the username comes from the reservation.

  The provisioner cannot tell the difference, and that is the point.

## 3. Every purpose-dependent site, classified

| site                                               | CUSTOM_SERVICE                                                                                             |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `orderPurposeCreatesNewService`                    | true                                                                                                       |
| `orderPurposeTargetsExistingService`               | false                                                                                                      |
| `operationTypeForOrderPurpose` / `PURCHASED_AS`    | `PROVISION` — cashback and a referral commission are earned when the PROVISION succeeds, as for a purchase |
| `orderPurposeIsSale` (reporting)                   | true — it is revenue                                                                                       |
| `PRODUCT_RANKING_PURPOSES`                         | excluded — there is no product to rank                                                                     |
| `TRAFFIC_SELLING_PURPOSES`                         | included — it sells traffic                                                                                |
| `DISCOUNTABLE_PURPOSES`                            | included (§6)                                                                                              |
| `RESELLER_GRANTABLE_OPERATIONS`                    | NOT included — spelled out as the four it was, so no tier grant CHECK widens (§7)                          |
| `isFirstPurchase`                                  | a custom purchase counts as a purchase: a customer who bought one is not a first-time buyer                |
| first-purchase-only discounts                      | unchanged: still `applies_to = ['NEW_SERVICE']` only, so they never reach a custom order                   |
| discount-code entry (`assertCodeable`)             | allowed, as for `NEW_SERVICE`                                                                              |
| username step, capacity slot, confirm              | as `NEW_SERVICE` (via `orderPurposeCreatesNewService`)                                                     |
| settlement dispatch                                | as `NEW_SERVICE` (via `orderPurposeCreatesNewService`)                                                     |
| customer refund request (WP19)                     | allowed: a paid order that created the service                                                             |
| receipt-review facts                               | reads the username reservation, as for `NEW_SERVICE`                                                       |
| bot follow-up after settlement, draft buttons      | as `NEW_SERVICE`                                                                                           |
| renew / add traffic / add time on a custom service | refused, `CUSTOM_SERVICE_NOT_EXTENDABLE` (§9)                                                              |

## 4. Pricing rules (D2, D3)

**Table `custom_service_price_rules`**:

| column                          | meaning                                                                                                                 |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `dimension`                     | `VOLUME` or `TIME`                                                                                                      |
| `min_units`, `max_units`        | inclusive bounds. For VOLUME the unit is **one hundredth of a GB**, so `10.25` GB is `1025`; for TIME it is **one day** |
| `unit_price_amount`, `currency` | price per GB (VOLUME) or per day (TIME), in the tenant's sales currency                                                 |
| `customer_id`                   | a specific customer, or NULL                                                                                            |
| `reseller_tier_id`              | a reseller tier, or NULL. NULL on a rule with no customer means the ordinary-customer tier                              |
| `panel_id`                      | a specific panel, or NULL for all panels                                                                                |
| `enabled`                       | disabled rules are ignored everywhere                                                                                   |

- A customer rule names no tier (CHECK). Its specificity comes from the customer.
- **Validation.**
  - `min ≥ 1`, and `max ≥ min`.
  - Volume bounds have at most two decimals; they are integers in hundredths.
  - Days are whole, and at most `CUSTOM_SERVICE_MAX_DAYS` (3650).
  - Volume is at most the product ceiling, `MAX_TRAFFIC_BYTES`.
  - A price is positive, in the sales currency: a zero would make a dimension free, and — as for a product's price — free is not a price here.
  - A panel, a customer and a tier must belong to this tenant.
- **Overlap.**
  - Two ENABLED rules of the same dimension at the same specificity (same customer, tier and panel key) may not have intersecting ranges.
  - It is checked in the rule's write transaction, under a per-tenant advisory lock, so two concurrent saves cannot both pass.
  - Enabling a rule re-checks it.
  - (An exclusion constraint would need `btree_gist`, an extension this schema has never required and a production role may not be allowed to create.)
- **Specificity.** Decided per dimension, by one pure function, `selectCustomServiceRule`. Levels, most specific first:
  1. customer + this panel
  2. customer + all panels
  3. customer's tier + this panel
  4. customer's tier + all panels
- **Selection.**
  - The first level with a rule whose range contains the requested value is selected.
  - Within it exactly one rule must match. Two matches (a state validation prevents, but a restore or a hand edit could produce) make the service UNAVAILABLE, never a sum or a guess.
  - No match at any level is UNAVAILABLE.
  - VOLUME and TIME are selected independently, so a customer-specific volume price can combine with the tier's time price.

## 5. Price calculation and snapshot (D4, D6)

**The formulas**, in exact integer arithmetic, in minor units:

- `volume_price = round_half_up(volume_hundredths × price_per_gb / 100)`. The only division is by 100, and the rounding is written into the snapshot.
- `time_price = days × price_per_day`
- `custom_base_price = volume_price + time_price`

**The quote trace** carries the base as TWO `CUSTOM_SERVICE_FORMULA` steps:

- one naming the volume rule: `0 → volume_price`;
- one naming the time rule: `volume_price → base`.

So the trace says which rules fired. The discount pipeline then runs on top exactly as for a product, and a code re-quotes from the order's own snapshot.

**`order_custom_service_terms`** is written once, in the draft's transaction. It holds:

- the panel;
- the location label;
- the volume in hundredths and in bytes;
- the days;
- each selected rule's id and level;
- the price per GB and per day;
- the volume price and the time price;
- the base price and its currency.

**CHECK constraints pin the arithmetic**:

- `volume_price = (volume_hundredths * price_per_gb + 50) / 100`
- `time_price = days * price_per_day`
- `base = volume + time`

A trigger refuses UPDATE and DELETE, and rule ids are copied, not foreign keys. So editing or deleting a rule later rewrites nothing.

**Discounts, fees and the payable** use the existing order totals and quote, and the existing payment snapshot for a gateway's customer fee.

## 6. The commercial pipeline (D4)

Custom orders go through `PricingService.price` with `purpose: 'CUSTOM_SERVICE'`.

- **Discounts.**
  - Automatic and coded rules apply when their `applies_to` names `CUSTOM_SERVICE`.
  - A product- or category-scoped rule cannot reach a custom order: the engine refuses on scope, as for an add-on.
  - Adding the purpose to `DISCOUNTABLE_PURPOSES` widens the `applies_to` CHECK of `discounts` and `cashback_rules`. An existing rule does not silently start applying: its `applies_to` does not name the new purpose.
- **Cashback.** Promised at confirmation, earned at delivery, through `PURCHASED_AS`.
- **Referral commission.** Promised at confirmation, earned at delivery.
- **Payment and settlement.** Wallet, manual transfer, gateways (with their customer fee) and Stars all work unchanged, because they act on an order and its total.
- **The reseller layer is NOT applied** to a custom order (§7).

## 7. Resellers

The brief's "customer tier" is how a reseller is priced here: an ACTIVE reseller is priced by the rules written for their tier (or for them as a customer).

The WP9-B reseller layer — `TIER_PRICE` and `USER_OVERRIDE` on a list price — is not applied on top. Doing so would discount a price the operator already wrote for that tier, a second answer to "what does this reseller pay". `order_reseller_terms` is therefore not written for a custom order, and `recordPurchase` returns without one.

A reseller's entitlement grants (product, category, panel, operation) govern the catalogue, and a custom service is not in it. The custom-service equivalent of a grant is a rule: a tier with no custom-service rules cannot buy one.

This is "do not invent a new reseller settlement/profit system" read literally. No margin is recorded, because nothing here was bought at a cost and sold at a price.

## 8. Availability, locations and the customer flow (D1, D5, D7)

**The feature flag.** `custom_service` (the brief's `custom_service_enabled`), default OFF, TENANT_WIDE. When it is off:

- no entry button is drawn;
- every custom-service command refuses `CUSTOM_SERVICE_DISABLED`;
- confirmation refuses too.

**Locations.** A panel's `name` is an operator's internal label, so a panel is not offered to customers by it. The operator opts a panel in through `custom_service_locations`:

- panel id;
- a customer-facing label, for example «🇩🇪 آلمان»;
- enabled.

A location is offered only when:

- it is enabled;
- `PanelSalesGate` finds its panel ELIGIBLE: active, provision-capable, credentials and activation complete, healthy, validated, below capacity;
- there is at least one enabled VOLUME rule and one enabled TIME rule this customer could be priced by on that panel.

The panel list is a courtesy. Draft creation re-decides everything, and confirmation takes the capacity slot through the ordinary `panelSales.acquire`.

**The Telegram flow.** It is the brief's suggested one:

1. `🛠 سرویس دلخواه` is an inline button on the catalogue screen, drawn only when the flag is on and a location is available. It lists the available locations.
2. The customer picks a location. A `CUSTOM_SERVICE_VOLUME` window opens, with the panel as its subject, and asks for GB. The input is parsed by `TRAFFIC_GB_PATTERN`: at most two decimals, positive.
3. The window records the volume and becomes a `CUSTOM_SERVICE_DAYS` window, which asks for days: a positive whole number with ASCII or Persian digits.
4. The draft is created: the rules are selected, the price is computed, and the terms are snapshotted. An unpriced request answers `bot.custom_service.unavailable` and nothing is created.
5. The ordinary username step for that panel follows.
6. The pre-invoice is shown. It is `bot.order.preinvoice` with a custom-service breakdown block giving:
   - the location;
   - the volume and the time;
   - the price per GB and per day;
   - the volume price and the time price.

   Discounts, cashback and the total come from the ordinary lines. A route's fee is shown by the ordinary payment step, as for any order.

7. Explicit confirmation, the ordinary payment flow, then settlement, provisioning and delivery.

No provider operation starts before settlement: the only provisioning path is `planForSettledOrder`.

**Confirmation.** `OrderService.confirm` does not re-read a product for a custom order. It re-decides:

- the flag is on;
- the location is still enabled;
- the rules the quote named are still the ones selection picks, enabled and at the quoted prices. They are read under a SHARE lock, so a concurrent edit waits.

A difference refuses with `CUSTOM_SERVICE_TERMS_CHANGED`, and the order is never re-priced. It is the same rule WP8 and WP9-B follow: a quote is honoured or refused, never recomputed.

After that it takes the capacity slot and the username exactly as for a purchase.

## 9. Not done, deliberately

- **Renewing or extending a custom service.**
  - Renewal re-prices a PRODUCT, and a custom service has none.
  - Pricing a renewal from today's custom rules is a product decision the brief does not make.
  - So RENEW, ADD_TRAFFIC and ADD_TIME on a service with no product refuse `CUSTOM_SERVICE_NOT_EXTENDABLE`, and the Telegram buttons are not drawn.
  - Recorded as `OQ-PKG-D-01`.
- **Surcharges.** There is none.
- **A new reseller profit system.** None; see §7.

## 10. Rollback

Migration 0129 is additive, with two relaxations: `orders.product_id` and `services.product_id` become nullable.

- **With no custom order written**, the release before this one reads every row it could before.
- **After a custom order exists**, the older release's readers type `productId` as a string. They would:
  - render a null in the order and service lists;
  - refuse to parse an HTTP summary carrying one.

So before rolling back:

- turn the `custom_service` flag off;
- do not roll back across custom orders that are still open.

Settled custom orders stay readable in the database, and nothing is lost.

## 11. Tests (D8)

**Unit**

- Selection at each specificity level.
- A missing rule.
- Two matching rules → unavailable.
- Exact range boundaries (min, max, just outside).
- The 2-decimal GB parse into hundredths.
- Day validation.
- Exact money math, including half-up rounding and large values.
- The quote trace.

**Integration**

- Overlap refusal at the same level, and acceptance at different levels.
- Draft and confirm end to end.
- The snapshot is immutable after a rule edit or delete.
- A discount code, cashback and a referral commission on a custom order.
- The disabled flag.
- A disabled location.
- An ineligible (disabled) panel.
- Tenant isolation of rules, locations and orders.
- Wallet payment replay.
- Settlement provisions a service with `product_id` NULL, through the fake provider, and reconciliation behaves as for a purchase.

**Web and surface**

- The rules page and the locations page.
- The bot flow screens.

Falsification: `docs/package-d-falsification.md`.
