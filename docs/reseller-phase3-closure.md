# Reseller phase 3 — closure audit

Written from `main` at `325b765`, branch `claude/r-reseller-close`. It checks the owner's
reseller scope against what is already on `main`, and it records one conflict that the
owner has to decide (§3).

**Result.** Every positive requirement is already built. No feature code was needed. This
package adds the following:

- two regression tests that were missing (§4);
- one web constant read: the tier form's blank credit limit now reads
  `RESELLER_DEFAULT_CREDIT_LIMIT_MINOR` instead of a literal `'0'`;
- this document.

There are no contract, schema, migration, permission, state or ledger changes.

**One conflict.** The owner's exclusion list says no debt, no negative balances and no
credit purchases. `main` has a reseller credit line, built in WP9-B R8, that lets a wallet
purchase take a reseller's balance below zero. It is **off by default** and applies only
where an operator has typed a positive limit. It has **not** been removed. §3 gives the
evidence and the options.

---

## 1. The owner's requirements, one by one

| Requirement                                                       | Status  | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A reseller uses Nexa's SAME Products and catalogue                | Covered | A grant's subject is a `products.id`, a `product_categories.id` or a `panels.id` (`packages/contracts/src/http.ts` `resellerTierGrantSchema`; `reseller_tier_grants` / `reseller_grant_overrides` in `schema.ts`). No reseller product table exists. `RESELLERS_ONLY` is an `audience` value on an ordinary `products` row, not a second catalogue (`catalog/application/catalog-visibility.ts:47,107`; `drizzle-product.repository.ts:62`).                                                                                                              |
| The owner controls which products, plans and panels               | Covered | Deny-by-default per dimension, decided by ONE evaluator: `resellers/domain/entitlement.ts:48` `decideEntitlement`. Tier grants are edited on `/reseller-tiers`, and per-reseller grants on `/reseller-plans` and `/resellers`.                                                                                                                                                                                                                                                                                                                            |
| The owner controls which actions                                  | Covered | The `OPERATION` grant over `RESELLER_GRANTABLE_OPERATIONS` (`packages/contracts/src/promotions.ts:598`): new service, renew, add traffic, add time, add devices and change location. Each one is checked at its own entry point: `order.service.ts:366,1663`, `commercial-action.service.ts:553` and `location-change.service.ts:208`. A trial is never grantable. A custom service is governed by its own per-tier rules (`docs/package-d-custom-service-audit.md` §7, `custom-service-pricer.ts:179`).                                                  |
| Per-reseller overrides                                            | Covered | `effectiveGrants` (`entitlement.ts:94`) applies per dimension and REPLACES the tier's grants, so an override can narrow as well as widen. `ResellerService.standing` (`reseller.service.ts:65-106`) returns the effective grant set to every caller: the catalogue courtesy at `product.service.ts:312-314` and the authoritative confirmation at `reseller.service.ts:194-219` via `PricingService.redeem`. Pricing override: `USER_OVERRIDE` over `TIER_PRICE` (R3). Credit limit: the reseller's own limit, else the tier's (`reseller-credit.ts:26`). |
| Reseller pricing through the existing engine                      | Covered | `PricingService.price` (`pricing/application/pricing.service.ts:103-116`) applies `applyResellerLayer` (`reseller-pricing.ts:42`) and then the same promotions. No other caller prices a reseller. The admin preview shows the rate (`resellerPriceLayer`) and computes no price (`docs/round-n-reseller-audit.md` §2.2).                                                                                                                                                                                                                                 |
| The minimum monthly sales can be tracked                          | Covered | `monthly-minimum.ts:23` `effectiveMonthlyMinimum` (the reseller's own, else the tier's), `ResellerMinimumService.progress`, and the shared `resellerSalesStatement`. Shown on `/reseller-plans` (`docs/round-n-reseller-audit.md` §3).                                                                                                                                                                                                                                                                                                                    |
| A missed minimum is only informational, with an optional reminder | Covered | `reseller-minimum.service.ts:122-125`. The sweep (`runOnce`, line 216 onwards) writes only a `reseller_minimum_notices` row and a notification row. Its dependencies include no wallet, ledger, payment or status writer.                                                                                                                                                                                                                                                                                                                                 |

### What the owner excluded, and what `main` has

| Excluded                                                  | On `main`                                                                                                                                                                                                          |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Reseller debt, negative balances, credit purchases        | **PRESENT, but off unless an owner sets a limit.** See §3.                                                                                                                                                         |
| Buy-now-pay-later, loans, credit lines                    | The same credit line (§3). It has no instalments, no due date and no interest.                                                                                                                                     |
| Debt settlement                                           | Absent. `RESELLER_SETTLEMENT` is a reserved ledger reason with no writer (`packages/contracts/src/ledger.ts:65`). `OQ-WP9-04` says so too.                                                                         |
| Automatic monetary penalties, automatic wallet deductions | Absent. `RESELLER_MEMBERSHIP_FEE` is reserved with no writer (`ledger.ts:66`). The only automatic debits are the cashback and referral reversals that a refund triggers, and they never go below zero (CLAUDE.md). |
| Automatic demotion or suspension for a missed minimum     | Absent (`docs/round-n-reseller-audit.md` §3.5 and §4, "Intentionally NOT implemented").                                                                                                                            |
| A separate reseller catalogue                             | Absent (§1, first row).                                                                                                                                                                                            |
| Reseller bots or child bots                               | Absent. The `BOT` grant only chooses which of the tenant's OWN bots a reseller may buy through.                                                                                                                    |

## 2. The regression requirements and the tests that pin them

| Requirement                                                   | Tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A reseller never gains a Product outside its effective grants | `tests/unit/reseller-entitlement.test.ts`: "catalogueScope agrees with decideEntitlement" over every grant subset, and the same check under every override shape. `tests/integration/resellers.test.ts`: "entitlements fail closed, per dimension", "refuses to confirm when a grant was withdrawn…" and the reseller-only catalogue. `tests/integration/reseller-plan-controls.test.ts`: "narrows one reseller to named existing Products…" and "re-decides at confirmation…". |
| Override precedence is correct                                | Unit `effectiveGrants` cases: it narrows, it widens one dimension only, an empty override denies, and order does not matter. Integration: "widens a dimension the tier refuses, for that reseller only (the override REPLACES)". Pricing: "lets the reseller's own percentage REPLACE the tier's", and the unit case "takes the override over the tier".                                                                                                                        |
| Pricing stays one authoritative engine                        | Integration "pricing inheritance (R3, R4)" (TIER_PRICE and USER_OVERRIDE steps in the quote trace) and "the purchase snapshot (R9)": a quote is honoured, and refused with `RESELLER_TERMS_CHANGED` rather than re-priced.                                                                                                                                                                                                                                                      |
| Normal customers are unaffected                               | **New:** `resellers.test.ts` "an ordinary customer beside a configured reseller". A discounting, credit-bearing tier and a per-reseller catalogue override are both live. The ordinary customer still sees the full public catalogue, pays list price with only a `BASE_PRICE` step, gets no terms row and cannot overdraw. Existing tests: "a suspended reseller is an ordinary customer (R1)" and the reseller-only catalogue case.                                           |
| The monthly minimum moves no money and changes no status      | `reseller-plan-controls.test.ts` "creates no debt, ledger entry, status or tier change for a reseller below the minimum". It checks that the whole `wallet_entries` table, the `resellers` status, tier and credit columns, and `payments` are unchanged across a sweep and a dispatch. Also "applies no minimum to a suspended reseller…".                                                                                                                                     |
| No debt path beyond the owner-set limit                       | `resellers.test.ts` "the credit line (R8)": a zero limit allows no debt; the balance stops at exactly −L; an own limit of zero overrides a generous tier; no credit in a foreign currency; a manual debit never overdraws; two concurrent purchases fit only once. **New:** the ordinary-customer case above. **New:** `tests/web/resellers.test.tsx` "extends no credit by default: a tier saved without touching the limit sends zero".                                       |

## 3. The conflict: reseller credit (WP9-B R8)

### What exists, exactly

- **The mechanism.** `PaymentService.settleFromWallet` (`payments/application/payment.service.ts:829-856`) locks the customer and reads the balance. It then reads `ResellerService.creditAllowance` (`reseller.service.ts:154-170`), which returns `creditAllowanceOf` (`resellers/domain/reseller-credit.ts:36-52`). It refuses the purchase unless `canCover(balance, total, allowance)` holds, which means `balance − total ≥ −allowance` (`wallet/domain/balance.ts:65-79`). **So yes: an ACTIVE reseller with a positive limit can buy with an insufficient balance, and the wallet goes negative, down to −limit.** The integration test "lets the wallet reach exactly −L and not −L−1" proves it against real PostgreSQL.
- **Where it applies.** Only to WALLET settlement of an order, which covers new services and the granted commercial actions, because they settle through the same path. It does not apply to these:
  - an operator's manual debit (`wallet.service.ts:343`, `canCover` with no allowance);
  - a cashback or referral clawback, which never goes below zero;
  - a gateway, receipt or Stars payment, which never debits the wallet.
- **When it is enabled.** Only when all three of these hold (`creditStateOf`, `reseller-credit.ts:36-42`):
  1. the reseller is `ACTIVE`;
  2. the effective limit is positive. The effective limit is the reseller's own limit if one is set, else the tier's.
  3. the purchase is in the limit's currency.
- **The default is zero, so no credit.** `RESELLER_DEFAULT_CREDIT_LIMIT_MINOR = 0n` (`packages/contracts/src/promotions.ts:542`), documented as "a credit feature must default to no credit". The tier column defaults to 0 (`schema.ts`, `reseller_tiers.credit_limit_amount`). A new reseller's own limit is NULL, which means it inherits the tier's. The Web Admin tier form starts at that constant (`apps/web/src/pages/reseller-tiers.tsx`, `BLANK_TIER`, pinned by the new web test). The tier write contract REQUIRES an explicit `creditLimit` (`http.ts` `resellerTierWriteSchema`), so the API has no implicit non-zero value. Credit exists only where an operator holding `resellers.edit` typed a positive number.
- **What happens to a debt.** Nothing automatic (`docs/open-questions.md` `OQ-WP9-04`): no collection, fee, interest, reminder, ageing, suspension or block. It is a negative balance that later top-ups and operator credits repay. Suspension, or lowering the limit, stops further credit and leaves the debt in place. The Web Admin shows credit in use (`/resellers` credit card, WP14 D1). It also asks the operator to acknowledge before lowering a limit below the debt or suspending a reseller who owes (`OQ-WP14-01`).
- **The monthly minimum is not tied to it.** No code path connects them. The minimum sweep reads sales and writes notices only (§1).

### Why this conflicts with the owner's list

"No reseller debt; no negative balances; no buy-now-pay-later; no credit purchases; no reseller loans/credit lines" describes this feature. It is opt-in and owner-controlled, but it is the feature.

### Options for the owner (nothing has been changed)

1. **Keep it as an owner-controlled setting that defaults to zero** (today's behaviour). No code change. An installation that never types a positive limit can never see a negative balance; the tests above pin that. Risk: one operator typing a number turns it on for a whole tier.
2. **Remove the ability to extend credit, and keep the data.**
   - Make `creditAllowanceOf` return `0n`, so `settleFromWallet` refuses any shortfall.
   - Refuse a non-zero `creditLimit` in the two write schemas (a contract change, in its own commit).
   - Hide the limit field and the credit card in the Web Admin.
   - Existing negative balances stay as they are, because the ledger is append-only and is repaid by top-ups. The columns stay, because the rollback window forbids dropping them.
   - Tests to flip: the R8 integration cases ("reach exactly −L", "own limit in both directions", "concurrent 0.6·L") and `reseller-phase2-http.test.ts`'s credit cases become "refused".
3. **Middle ground:** keep the code and add a tenant feature flag, default OFF, that `creditAllowanceOf`'s caller must also see. This is a new flag, so it is a contract change.

Option 2 is small and well bounded: one domain function, two schema refinements, the web form and the tests. It should still be its own reviewed package, because it changes money behaviour that is in force today.

## 4. What this package changed

| Change                                                                                     | Why                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tests/integration/resellers.test.ts`: "an ordinary customer beside a configured reseller" | No test combined a live discount, a credit line and an override with an ordinary customer's catalogue, price, terms and overdraft.                                                                     |
| `tests/web/resellers.test.tsx`: "extends no credit by default…"                            | Pins that the form's untouched value is zero. The existing case typed `'0'` itself, so a changed default would have passed.                                                                            |
| `apps/web/src/pages/reseller-tiers.tsx` `BLANK_TIER.limitAmount`                           | Reads `RESELLER_DEFAULT_CREDIT_LIMIT_MINOR` instead of the literal `'0'`. The contract constant had no reader, so the "default to no credit" decision was stated in one place and enforced in another. |

### Mutations, each reverted after its run

| Mutation                                                                                               | Failed                                                                    |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `ResellerService.creditAllowance` returns `1_000_000n` for a non-reseller instead of `0n`              | the new integration case: the ordinary customer's settlement went through |
| The customer catalogue filter (`drizzle-product.repository.ts:62`) no longer excludes `RESELLERS_ONLY` | the new integration case: the catalogue had 3 items, not 2                |
| `BLANK_TIER.limitAmount` set to `'1000'`                                                               | the new web case                                                          |
