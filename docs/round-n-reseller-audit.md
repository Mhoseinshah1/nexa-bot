# Round N, package D — reseller plan controls (R1) and monthly minimum sales (R2)

Written before the code, from `main` at `a578d16`. §1 records what already exists, §2 and §3
what this package adds, and why each addition reuses something rather than standing beside
it. §4 records the Mirza evidence and what is deliberately not built. §6 records what was
built and the evidence for it.

The governing rules are CLAUDE.md's four reseller rules, `docs/wp9-reseller-audit.md`
(R1–R14) and `docs/wp14-reseller-phase2-audit.md`. None of them changes here:

- a reseller is a customer with an ACTIVE reseller row;
- entitlement is ONE evaluator, `decideEntitlement`, deny-by-default per dimension, and the
  catalogue is a courtesy held to it by a unit test over every grant subset;
- a quote is honoured, never re-priced, and `ResellerService.recordPurchase` decides again,
  authoritatively, at confirmation;
- credit is read under the wallet lock by `settleFromWallet` only.

Owner-locked exclusions, restated because R2 sits next to them: **no debt collection, no
repayment, no settlement, no ageing, no fee, no wallet debit, no sub-bots.**

---

## 1. What already exists

| Owner's need                                  | Already there                                                                                                                                                                                                                  | Gap                                                                                             |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Allowed Products per tier                     | `reseller_tier_grants` kind `PRODUCT`, subject a `products.id` (the existing catalogue — there is no second one), or `*`. Edited on `/reseller-tiers` through the grants editor, with product and category pickers.             | Not discoverable next to the plan settings; no preview of what a reseller can actually buy.   |
| Allowed categories / panels                   | The same grants, kinds `CATEGORY` and `PANEL` (and `BOT`, `OPERATION`). A product is allowed when it OR its category is granted (one dimension, `CATALOGUE`).                                                                  | None.                                                                                           |
| Per-reseller overrides                        | Pricing only: `resellers.pricing_mode` `TIER` / `LIST_PRICE` / `PERCENTAGE_DISCOUNT`, a `USER_OVERRIDE` step that REPLACES the tier's `TIER_PRICE` (R3). Credit limit: own, else the tier's (R8).                            | **No per-reseller entitlement override.** Every reseller on a tier can sell exactly the same.  |
| Tier / per-reseller pricing on the same Products | The tier's rate and the reseller's own rate, applied by `PricingService.price` over `pricing-engine.ts` to the existing product's list price, frozen in the quote trace and in `order_reseller_terms` at confirmation (R3, R9). | None. A per-product reseller PRICE LIST is refused by the contract (`RESELLER_PRICING_MODES`: "a rate, never a price list") and by WP9 R14; this package keeps that. |
| Effective-policy preview                      | The reseller edit form shows the tier's pricing next to "use the tier's". Nothing shows the entitlement a reseller ends up with.                                                                                               | **Missing.**                                                                                    |
| Monthly minimum                               | Nothing. WP9 R14 and WP14 §3 list the monthly floor (`O-2`) as not built.                                                                                                                                                      | **Missing.**                                                                                    |
| A reseller's sales in a period                | WP12 §5.7: PAID orders settled in the period that have an `order_reseller_terms` row, `sum(orders.total_amount)` per currency, sale purposes only (`SALE_ORDER_PURPOSES`). One SQL statement in `DrizzleReportingRepository.resellers`. | Not reusable: the `sold` CTE is inline in that one statement.                                  |
| Periods in the tenant calendar                | `report-calendar.ts` (`resolveReportPeriod`, `IntlTimePeriodResolver`): the ONE implementation of `TimePeriodResolver`, ICU calendar arithmetic, half-open `[start, end)` UTC boundaries, `THIS_MONTH` / `PREVIOUS_MONTH` in the tenant's `display_timezone` and `calendar` (Jalali by default). DST-safe through `localInstant`. | None.                                                                                           |
| Notifications                                 | The customer notification lane (ADR-0030): closed `CUSTOMER_NOTIFICATION_KINDS` pinned by a CHECK, one frozen template per kind, no payload; values read at send time from the SUBJECT row (the `WALLET_LOW_BALANCE` / `wallet_threshold_alerts` precedent: one occurrence row per fact, unique, `ON CONFLICT DO NOTHING`, then `notify`). `CustomerReminderLoop` runs the per-tenant sweeps. | Two kinds, one occurrence table and one sweep.                                                  |

Every caller of the reseller rules goes through `ResellerService.standing(...).grants`: the
catalogue courtesy (`ProductService` → `catalogueScope`), `OrderService.createDraft`, the
confirmation (`PricingService.redeem` → `ResellerService.recordPurchase` →
`assertEntitled`), commercial actions and location change. So an override applied inside
`standing` reaches every caller at once, and no caller needs to learn about it.

---

## 2. R1 — what this package adds

### 2.1 Per-reseller entitlement overrides, with the existing precedence

The existing precedence is R3's: a reseller's own policy **REPLACES** the tier's, and "no
override" inherits it. The same rule, per entitlement DIMENSION:

- the four dimensions are `decideEntitlement`'s own — `OPERATION`, `CATALOGUE`
  (products and categories together), `PANEL`, `BOT`;
- a dimension the reseller does not override inherits the tier's grants of that dimension;
- a dimension the reseller overrides uses ONLY the reseller's grants of that dimension — the
  tier's grants of it are ignored entirely, so an override can narrow as well as widen;
- an overridden dimension with no grant row grants nothing (deny by default, as for a tier).

Per dimension rather than per kind, because `PRODUCT` and `CATEGORY` are one dimension: an
override listing only products must not leave the tier's "every category" standing beside
it, which would silently keep everything the operator meant to narrow.

**One evaluator.** `effectiveGrants(tierGrants, override)` (pure, `entitlement.ts`) produces
the grant set; `decideEntitlement` and `catalogueScope` read it exactly as they read a
tier's. `ResellerService.standing` returns the EFFECTIVE set as `standing.grants`, so every
caller above — the courtesy and the authoritative confirmation alike — uses it without a
second check. The grant-subset agreement test is extended over overrides.

**Storage.** `reseller_entitlement_overrides` (one row per overridden dimension) and
`reseller_grant_overrides` (the override's grants, same `(kind, subject)` shape and CHECK as
`reseller_tier_grants`, foreign-keyed to its dimension row, cascade). Replaced as a set by
`POST /resellers/:customerId/grants` under the reseller row's `FOR UPDATE` — the lock
`standing` takes `FOR SHARE`, so a withdrawal cannot commit while a sale decides under the
grant it withdraws (the WP9 reasoning, reused).

### 2.2 Effective-policy preview

`GET /resellers/:customerId/policy` (`resellers.view`): per dimension, the tier's grants, the
override (or "inherited") and the effective grants; the pricing policy (tier's, override,
and the layer `resellerPriceLayer` resolves — the ONE statement of R3); the monthly minimum
(tier's, override, effective); and the existing Products, up to one page, each with
`decideEntitlement`'s answer for a new purchase. No price is computed there: a reseller's
price is `PricingService.price`'s answer at checkout, and the preview shows the rate that
boundary applies, not a second calculation of it.

The bot dimension depends on the bot a purchase arrives through; the per-product answer is
asked through the reseller's granted bots (any bot when every bot is granted, else the first
granted one), and the page says so. A reseller granted no bot is refused `BOT` for every
product, which is exactly what confirmation would do.

### 2.3 Web Admin

A new discoverable area «تنظیمات نمایندگان / پلن‌ها و حداقل فروش» (`/reseller-plans`):
the tiers with their allowed products, categories and panels (opening the SAME grants editor
`/reseller-tiers` uses — exported, not copied), their pricing and monthly minimum; the
monthly progress; and a per-reseller effective-policy card with the override editor. Persian
labels throughout, no raw enums.

---

## 3. R2 — monthly minimum sales

### 3.1 Model

- `reseller_tiers.monthly_minimum_amount` / `_currency`: null or zero is **no minimum**.
- `resellers.monthly_minimum_amount` / `_currency`: **null inherits** the tier's; zero is an
  explicit "no minimum for this reseller"; positive is the reseller's own. The same
  own-else-tier shape as the credit limit (R8), stated once in `effectiveMonthlyMinimum`.
- Money is bigint minor units with its currency. Sales in another currency do not count
  toward it — the credit limit's rule (R8), for the same reason: no rate anybody chose.
- A SUSPENDED reseller is an ordinary customer (R1): no minimum applies, and it is shown
  as "not active".

### 3.2 What counts — the reporting definition, reused

"Achieved sales" is WP12 §5.7's reseller **sales amount**, from ONE SQL fragment now shared
by the report and this package (`resellerSalesStatement`): orders with an
`order_reseller_terms` row naming the reseller, `state = 'PAID'`, a sale purpose, settled in
the period, `sum(orders.total_amount)` in the minimum's currency. Therefore, exactly as the
report states:

- only sales attributed to the reseller under reseller terms count — the terms row is
  written only at confirmation of an ACTIVE reseller's order (R9);
- a trial is never a sale; a custom service records no terms (Package D) and is not counted;
- a FULLY refunded order (state `REFUNDED`) is not a sale and leaves the period it was
  settled in, even when the refund lands later; a PARTIAL refund is not netted (WP12 §4).

No second revenue metric is invented.

### 3.3 Period

The calendar month in the tenant's `display_timezone` and `calendar` (Jalali by default),
from `resolveReportPeriod` — the same resolver the reports use — as a half-open UTC
interval `[start, end)`. DST-safe by construction (`localInstant`). The Web Admin shows this
month and the previous one.

### 3.4 Notifications — optional

- `RESELLER_MINIMUM_REMINDER`: a reminder `reminders.reseller_minimum_days` local days before
  the month ends (default **3**, Mirza's VERIFIED value), to an ACTIVE reseller still below a
  positive minimum. Behind the flag `reseller_minimum_reminders`, ON by default and inert
  until an operator sets a minimum (every minimum defaults to none).
- `RESELLER_MINIMUM_ACHIEVED`: once the month's sales reach the minimum. Behind
  `reseller_minimum_achieved_notices`, OFF by default (a Nexa addition).
- Subject: a `reseller_minimum_notices` row, unique on `(tenant, reseller, kind,
  period_start)`, written `ON CONFLICT DO NOTHING` — at most one reminder and one
  achievement per reseller per month, whatever the number of worker replicas or restarts;
  the lane's `customer_notifications_subject_key` then sends each once.
- No payload (ADR-0030 §1): the values are read at send time from the notice row (the
  minimum it recorded) and, for the reminder, the live sales figure by the same shared
  fragment — the `WALLET_LOW_BALANCE` precedent.
- The reminder has a precondition (re-checked after the claim): the reseller is still
  ACTIVE, the month has not ended, the effective minimum is still the one recorded, and the
  sales are still below it. A reseller who reaches the minimum while the reminder waits in
  quiet hours is not told they are behind. The reminder is a quiet-hours kind; the
  achievement is not.

### 3.5 Consequence — none

Tracking, reporting and notification only. **No debt, fee, wallet debit, ledger entry,
settlement, demotion, suspension or block** is created by any of this. The sweep writes a
notice row and a notification row and nothing else; a regression test asserts that a
below-minimum month leaves `wallet_entries`, `resellers.status` and the reseller's tier
unchanged.

---

## 4. Mirza evidence (`scratchpad/mirza-audit.md` §2 R2) and what is deliberately not built

| Mirza behaviour                                                                                     | Status   | Nexa                                                                                     |
| --------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------- |
| A per-tier monthly floor `📊 کف خرید ماهانه نمایندگی`; `0` means no requirement                   | VERIFIED | Per-tier minimum; null or 0 is none.                                                     |
| A separate enabled flag                                                                             | VERIFIED | The minimum is inert at 0; the reminder has its own flag.                                |
| A warning 3 days before month end                                                                   | VERIFIED | `reminders.reseller_minimum_days`, default 3.                                            |
| What counts (`حداقل مبلغ پرداختی`)                                                                  | UNKNOWN  | Nexa's own decision: WP12's reseller sales amount (§3.2). Not parity.                    |
| Which calendar                                                                                      | UNKNOWN  | Nexa's own decision: the tenant calendar (§3.3). Not parity. Consistent with `O-2`'s fallback (paid purchases, Jalali month). |
| A reseller below the floor "loses reseller status"                                                  | PARTIAL — declared on a settings screen, never observed at runtime | **Intentionally NOT implemented.** No demotion, suspension or block. The metric it rests on is UNKNOWN and the owner's brief forbids an invented consequence. `O-2`'s 48-hour grace period exists only for a consequence, so it is not built either. |
| The sales bot stops when a reseller leaves                                                          | PARTIAL  | Not applicable: Nexa has no reseller sub-bots, and none are built.                       |
| Per-reseller floor override; a progress screen                                                      | NOT_EXPOSED | Nexa additions under the brief; not parity.                                          |

---

## 5. Contracts, schema and routes

Contracts (own commit): the two notification kinds, their preconditions, quiet-hours flags
and templates; two template keys; two feature flags and one setting; the override
dimension vocabulary; the route shapes and schemas below.

Migration `0144_round_n_reseller_controls`: two nullable minimum pairs, the two override
tables, the notice table, the widened notification-kind CHECK.

| Route                                           | Permission                        | Write? |
| ----------------------------------------------- | --------------------------------- | ------ |
| `POST /reseller-tiers/:id/monthly-minimum`      | `resellers.edit`                  | yes, idempotent, audited `reseller_tier.monthly_minimum` |
| `POST /resellers/:customerId/grants`            | `resellers.edit`                  | yes, idempotent, audited `reseller.grants_override`      |
| `POST /resellers/:customerId/monthly-minimum`   | `resellers.edit`                  | yes, idempotent, audited `reseller.monthly_minimum`      |
| `GET /resellers/:customerId/policy`             | `resellers.view`                  | no     |
| `GET /reseller-minimums`                        | `resellers.view` and `orders.view` | no — per-reseller sales figures are order amounts, which `orders.view` already reads (the WP14 D2 split) |

Every write reads `ScopeActivityReader` inside its transaction, and carries an idempotency
key.

---

## 6. What was built, and the evidence

(Filled in when the package is complete.)
