# Reseller phase 3 — closure audit

Written from `main` at `325b765`, branch `claude/r-reseller-close`. It checks the owner's
reseller scope against what is already on `main`. The audit found one conflict, reseller
credit (§3). **The owner has decided it (owner decision, 2026-10-01): reseller credit is
removed** (§5).

**Result.**

- Every positive requirement was already built. No feature code was needed for them, and
  this package adds the regression tests that were missing (§4).
- The one conflict, reseller credit, is closed by the owner's decision. It is removed in
  two commits (§5):
  - a contract commit: every reseller write refuses a non-zero credit limit;
  - a behaviour commit: the allowance is zero for everyone, and the Web Admin shows no
    credit.
- No schema, migration, permission, state or ledger reason changed. No column was dropped.
  A balance that is already negative is left exactly as it is.

---

## 1. The owner's requirements, one by one

| Requirement                                                       | Status  | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A reseller uses Nexa's SAME Products and catalogue                | Covered | A grant's subject is a `products.id`, a `product_categories.id` or a `panels.id` (`packages/contracts/src/http.ts` `resellerTierGrantSchema`; `reseller_tier_grants` / `reseller_grant_overrides` in `schema.ts`). No reseller product table exists. `RESELLERS_ONLY` is an `audience` value on an ordinary `products` row, not a second catalogue (`catalog/application/catalog-visibility.ts:47,107`; `drizzle-product.repository.ts:62`).                                                                                               |
| The owner controls which products, plans and panels               | Covered | Deny-by-default per dimension, decided by ONE evaluator: `resellers/domain/entitlement.ts:48` `decideEntitlement`. Tier grants are edited on `/reseller-tiers`, and per-reseller grants on `/reseller-plans` and `/resellers`.                                                                                                                                                                                                                                                                                                             |
| The owner controls which actions                                  | Covered | The `OPERATION` grant over `RESELLER_GRANTABLE_OPERATIONS` (`packages/contracts/src/promotions.ts:598`): new service, renew, add traffic, add time, add devices and change location. Each one is checked at its own entry point: `order.service.ts:366,1663`, `commercial-action.service.ts:553` and `location-change.service.ts:208`. A trial is never grantable. A custom service is governed by its own per-tier rules (`docs/package-d-custom-service-audit.md` §7, `custom-service-pricer.ts:179`).                                   |
| Per-reseller overrides                                            | Covered | `effectiveGrants` (`entitlement.ts:94`) applies per dimension and REPLACES the tier's grants, so an override can narrow as well as widen. `ResellerService.standing` (`reseller.service.ts:65-106`) returns the effective grant set to every caller: the catalogue courtesy at `product.service.ts:312-314` and the authoritative confirmation at `reseller.service.ts:194-219` via `PricingService.redeem`. Pricing override: `USER_OVERRIDE` over `TIER_PRICE` (R3). (A credit-limit override existed; reseller credit was removed, §5.) |
| Reseller pricing through the existing engine                      | Covered | `PricingService.price` (`pricing/application/pricing.service.ts:103-116`) applies `applyResellerLayer` (`reseller-pricing.ts:42`) and then the same promotions. No other caller prices a reseller. The admin preview shows the rate (`resellerPriceLayer`) and computes no price (`docs/round-n-reseller-audit.md` §2.2).                                                                                                                                                                                                                  |
| The minimum monthly sales can be tracked                          | Covered | `monthly-minimum.ts:23` `effectiveMonthlyMinimum` (the reseller's own, else the tier's), `ResellerMinimumService.progress`, and the shared `resellerSalesStatement`. Shown on `/reseller-plans` (`docs/round-n-reseller-audit.md` §3).                                                                                                                                                                                                                                                                                                     |
| A missed minimum is only informational, with an optional reminder | Covered | `reseller-minimum.service.ts:122-125`. The sweep (`runOnce`, line 216 onwards) writes only a `reseller_minimum_notices` row and a notification row. Its dependencies include no wallet, ledger, payment or status writer.                                                                                                                                                                                                                                                                                                                  |

### What the owner excluded, and what `main` has

| Excluded                                                  | On `main`                                                                                                                                                                                                          |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Reseller debt, negative balances, credit purchases        | **Removed by owner decision, 2026-10-01** (§5). It was present, and off unless an owner set a limit (§3).                                                                                                          |
| Buy-now-pay-later, loans, credit lines                    | Removed with it (§5).                                                                                                                                                                                              |
| Debt settlement                                           | Absent. `RESELLER_SETTLEMENT` is a reserved ledger reason with no writer (`packages/contracts/src/ledger.ts:65`). `OQ-WP9-04` says so too.                                                                         |
| Automatic monetary penalties, automatic wallet deductions | Absent. `RESELLER_MEMBERSHIP_FEE` is reserved with no writer (`ledger.ts:66`). The only automatic debits are the cashback and referral reversals that a refund triggers, and they never go below zero (CLAUDE.md). |
| Automatic demotion or suspension for a missed minimum     | Absent (`docs/round-n-reseller-audit.md` §3.5 and §4, "Intentionally NOT implemented").                                                                                                                            |
| A separate reseller catalogue                             | Absent (§1, first row).                                                                                                                                                                                            |
| Reseller bots or child bots                               | Absent. The `BOT` grant only chooses which of the tenant's OWN bots a reseller may buy through.                                                                                                                    |

## 2. The regression requirements and the tests that pin them

| Requirement                                                   | Tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A reseller never gains a Product outside its effective grants | `tests/unit/reseller-entitlement.test.ts`: "catalogueScope agrees with decideEntitlement" over every grant subset, and the same check under every override shape. `tests/integration/resellers.test.ts`: "entitlements fail closed, per dimension", "refuses to confirm when a grant was withdrawn…" and the reseller-only catalogue. `tests/integration/reseller-plan-controls.test.ts`: "narrows one reseller to named existing Products…" and "re-decides at confirmation…".               |
| Override precedence is correct                                | Unit `effectiveGrants` cases: it narrows, it widens one dimension only, an empty override denies, and order does not matter. Integration: "widens a dimension the tier refuses, for that reseller only (the override REPLACES)". Pricing: "lets the reseller's own percentage REPLACE the tier's", and the unit case "takes the override over the tier".                                                                                                                                      |
| Pricing stays one authoritative engine                        | Integration "pricing inheritance (R3, R4)" (TIER_PRICE and USER_OVERRIDE steps in the quote trace) and "the purchase snapshot (R9)": a quote is honoured, and refused with `RESELLER_TERMS_CHANGED` rather than re-priced.                                                                                                                                                                                                                                                                    |
| Normal customers are unaffected                               | **New:** `resellers.test.ts` "an ordinary customer beside a configured reseller". A discounting tier with a stored (legacy) limit and a per-reseller catalogue override are both live. The ordinary customer still sees the full public catalogue, pays list price with only a `BASE_PRICE` step, gets no terms row and cannot overdraw. Existing tests: "a suspended reseller is an ordinary customer (R1)" and the reseller-only catalogue case.                                            |
| The monthly minimum moves no money and changes no status      | `reseller-plan-controls.test.ts` "creates no debt, ledger entry, status or tier change for a reseller below the minimum". It checks that the whole `wallet_entries` table, the `resellers` status, tier and credit columns, and `payments` are unchanged across a sweep and a dispatch. Also "applies no minimum to a suspended reseller…".                                                                                                                                                   |
| No debt or negative-balance path                              | Since the owner's decision (§5), `resellers.test.ts` "no reseller credit (R8 removed by owner decision)": "lets no stored limit overdraw…", "refuses a non-zero limit on every write…", "leaves a legacy debt exactly as it is…", "never lets an operator's manual debit overdraw…" and the concurrency case. Also the ordinary-customer case above, `reseller-phase2-http.test.ts` (HTTP 400 on every non-zero write; the frontier is the balance) and `tests/unit/reseller-credit.test.ts`. |

## 3. The conflict: reseller credit (WP9-B R8), as audited before the decision

This section records what `325b765` had. It is the evidence the owner decided on, and it
is **no longer current behaviour**: §5 gives what changed.

### What existed, exactly

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

### Options put to the owner

1. **Keep it as an owner-controlled setting that defaults to zero** (today's behaviour). No code change. An installation that never types a positive limit can never see a negative balance; the tests above pin that. Risk: one operator typing a number turns it on for a whole tier.
2. **Remove the ability to extend credit, and keep the data.**
   - Make `creditAllowanceOf` return `0n`, so `settleFromWallet` refuses any shortfall.
   - Refuse a non-zero `creditLimit` in the two write schemas (a contract change, in its own commit).
   - Hide the limit field and the credit card in the Web Admin.
   - Existing negative balances stay as they are, because the ledger is append-only and is repaid by top-ups. The columns stay, because the rollback window forbids dropping them.
   - Tests to flip: the R8 integration cases ("reach exactly −L", "own limit in both directions", "concurrent 0.6·L") and `reseller-phase2-http.test.ts`'s credit cases become "refused".
3. **Middle ground:** keep the code and add a tenant feature flag, default OFF, that `creditAllowanceOf`'s caller must also see. This is a new flag, so it is a contract change.

Option 2 is small and well bounded: one domain function, two schema refinements, the web form and the tests. **The owner chose option 2 (owner decision, 2026-10-01).**

## 4. What the first commit changed (audit regressions)

| Change                                                                                     | Why                                                                                                                                     |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/integration/resellers.test.ts`: "an ordinary customer beside a configured reseller" | No test combined a live discount, a credit line and an override with an ordinary customer's catalogue, price, terms and overdraft.      |
| `tests/web/resellers.test.tsx`: "extends no credit by default…"                            | Pinned the form's untouched value as zero. It is replaced in §5 by "offers no credit limit, and an edit writes zero over a stored one". |
| `apps/web/src/pages/reseller-tiers.tsx` `BLANK_TIER.limitAmount`                           | Read `RESELLER_DEFAULT_CREDIT_LIMIT_MINOR` instead of the literal `'0'`. The field is gone in §5; the save still writes that constant.  |

### Mutations, each reverted after its run

| Mutation                                                                                               | Failed                                                                    |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `ResellerService.creditAllowance` returns `1_000_000n` for a non-reseller instead of `0n`              | the new integration case: the ordinary customer's settlement went through |
| The customer catalogue filter (`drizzle-product.repository.ts:62`) no longer excludes `RESELLERS_ONLY` | the new integration case: the catalogue had 3 items, not 2                |
| `BLANK_TIER.limitAmount` set to `'1000'`                                                               | the new web case                                                          |

## 5. Owner decision, 2026-10-01: reseller credit is removed

The owner answered §3 directly: **remove reseller credit (option 2)**. There is no reseller
debt, no negative balance from a purchase and no credit purchase.

The first implementation is described below as it was committed. The review of PR #132
changed five parts of it, for clients and replicas that straddle the upgrade; §6 gives
those changes, and where they differ, §6 is current.

### Contract commit (its own commit)

- **The write schemas.** `creditLimitSchema` (`packages/contracts/src/http.ts`), used by
  tier create/update and reseller register/update, accepts only
  `RESELLER_DEFAULT_CREDIT_LIMIT_MINOR`, which is zero.
  - The field keeps its shape, so stored rows still read and existing clients still
    round-trip.
  - The reseller field may still be null, meaning "no limit of its own".
- **Retired:** `RESELLER_MAX_CREDIT_LIMIT_MINOR`.
- **The credit state.** `RESELLER_CREDIT_STATES` has one value, `CREDIT_REMOVED`. The
  credit standing view keeps its shape.
- **The report.** The resellers report's `creditLimit` is documented as always null.

### Behaviour

- **The allowance.** `creditAllowanceOf()` is `0n` and `creditStateOf()` is
  `CREDIT_REMOVED` (`resellers/domain/reseller-credit.ts:40,48`).
  - `ResellerService.creditAllowance` (`reseller.service.ts:154`) returns that value, so
    `PaymentService.settleFromWallet` (`payment.service.ts:837-843`) passes zero to
    `canCover`.
  - **No wallet purchase takes any balance below zero.** That holds for an ACTIVE
    reseller with a positive stored limit in the selling currency too.
  - Settlement no longer reads the reseller row.
- **Writes.** `ResellerAdminService` refuses a non-zero limit on all four writes with
  `COMMERCE_REQUEST_INVALID` (`refuseCredit`, `reseller-admin.service.ts:227,273,436,509,1138`).
  This is the same rule as the schema, for a caller that reaches the service without it.
- **Stored data.**
  - No column is dropped and no CHECK is added, because a destructive change is outside
    the rollback window.
  - A limit stored before the decision is still read and returned. It grants nothing.
  - An update writes zero for a tier, and null for a reseller, over it.
- **Existing negative balances are left exactly as they are.** No entry is written,
  changed, collected, aged or charged. A legacy debt is repaid only by the same top-ups
  and operator credits as any balance, and until then the wallet pays for nothing.
  `RESELLER_SETTLEMENT` and `RESELLER_MEMBERSHIP_FEE` stay reserved and unwritten.
  `OQ-WP9-04` records the resolution.
- **Unchanged:**
  - An operator's manual debit never overdraws.
  - A cashback or referral clawback never goes below zero.
  - The monthly minimum moves no money and changes no status.
- **The resellers report.** It returns `creditLimit: null`. `creditInUse` is the legacy
  debt, still read in the selling currency. The export drops its credit-limit column.

### Web Admin

- **Removed:**
  - the limit fields and the limit column on `/reseller-tiers` and `/resellers`;
  - the "effective limit" on the reseller head and on the customer page;
  - the debt acknowledgements (`debtWarningOf`, `OQ-WP14-01`, now moot).
- **`ResellerBalanceCard`** replaces `ResellerCreditCard`. It shows the balance, and a
  legacy-debt line and banner only when the balance is negative. That keeps a current
  negative balance truthful without offering any credit.
- **The business report column** shows only the legacy debt.
- Unused i18n keys were removed.

### Tests flipped or added

- **Unit** (`reseller-credit.test.ts`):
  - the allowance and the state are constant;
  - all three write schemas refuse `1`, `100000` and `1000000000000`, and accept zero or
    null.
- **Integration** (`resellers.test.ts`):
  - "lets no stored limit overdraw…": a legacy tier limit and a legacy own limit;
  - "refuses a non-zero limit on every write, and stores nothing";
  - "leaves a legacy debt exactly as it is…";
  - "never lets an operator's manual debit overdraw…";
  - the concurrency case settles from a funded wallet;
  - the refund case uses a funded wallet.
- **Integration** (`reseller-phase2-http.test.ts`):
  - the view reports zero allowance;
  - the frontier is the balance;
  - a legacy debt is shown as it is, active or suspended;
  - HTTP 400 on every non-zero write.
- **Integration** (`reports.test.ts`): no limit, and the legacy debt in the selling
  currency.
- **Web:**
  - no limit fields, and a stored limit is not drawn;
  - a tier edit writes zero, and a reseller save sends null;
  - the balance card;
  - no acknowledgement.
- **Falsification records.** WP9B-02, -03, -15 and -21, and R14-02, -09, -10, -12 and -16,
  are retired with the feature (the citation total goes from 2459 to 2449). R14-11 and
  R12-09 cite their renamed tests and were re-run.

### Mutations, each reverted after its run

| Mutation                                                                                                    | Failed                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The old allowance restored in `ResellerService.creditAllowance`: own-else-tier limit, ACTIVE, same currency | 5 integration cases: "lets no stored limit overdraw…", "leaves a legacy debt exactly as it is…", the concurrency case, and the phase-2 "agrees with settlement at the frontier…" and "shows a legacy debt as it is…" |
| `creditAllowanceOf` returns `1_000_000n`                                                                    | 3 unit cases                                                                                                                                                                                                         |
| `refuseCredit` weakened to refuse only a negative limit                                                     | "refuses a non-zero limit on every write, and stores nothing"                                                                                                                                                        |
| The schema refine weakened to `>= 0`                                                                        | the unit case "refuses one minor unit and anything above, on all three writes". The HTTP case still returns 400, because the service guard holds the same rule. That is defence in depth, not a gap.                 |
| `lockCustomer` without `FOR UPDATE` (WP9B-05, re-run)                                                       | the concurrency case: "the second settlement never waited"                                                                                                                                                           |
| The report's debt read in the stored limit's currency (R14-11, re-run)                                      | "reports a legacy debt exactly as the balance card derives it, whatever limit is stored"                                                                                                                             |
| `signedSum` adding a DEBIT (R12-09, re-run)                                                                 | "reports reseller orders, sales, services and a legacy debt, and never margin, cost or a credit limit"                                                                                                               |

## 6. PR #132 review: safe across the rolling update

Codex reviewed PR #132 and raised five findings. All five were confirmed, and each is fixed
with a regression test and a mutation that kills it. The contract changes are in their own
commits (`457a84f2` and `8d4cd803`). The behaviour, web and test changes are in `8be3d454`.

1. **[P1] Old replicas extended credit from retained limits.**
   - During a rolling update the migrations run first, and replicas of the previous
     release keep serving until they are replaced.
   - That code computes the allowance as the reseller's own limit, else the tier's, and
     extends credit only when it is positive and in the purchase currency.
   - **Fix: migration `0155_reseller_credit_removed`.** It is hand-written and data only,
     and is numbered after PR #131's `0153` and `0154`.
     - It sets every `reseller_tiers.credit_limit_amount` to 0.
     - It sets every `resellers` own limit to NULL (inherit the tier's 0).
     - From the moment it commits, the previous release computes zero too. So does a
       rollback to that release.
   - It is **irreversible by design**: the owner removed credit.
     - Each non-zero value is first written as an ordinary audit row on its own entity
       (`reseller_tier.update` / `reseller.update`, actor `SYSTEM_JOB`, correlation
       `migration-0155-reseller-credit-removed`, before and after). It therefore shows in
       the Web Admin change history.
     - The pre-update backup also holds the old values.
   - No wallet entry, balance, order or payment is read or written.
   - **Residual:** a replica of the previous release that is still serving could store a
     new positive limit, but only if an operator types one into the old form before that
     replica is replaced. The new release ignores that value. The next tier save writes
     zero over it, and the next reseller save writes null.
   - **The claim "limits stored before the decision still read but grant nothing" is
     superseded.** After the migration, no positive limit is stored.
2. **[P1] Legacy payloads must reach the idempotent replay.**
   - The schema parses the pre-decision shape again: 0 up to the restored
     `RESELLER_MAX_CREDIT_LIMIT_MINOR`.
   - `ResellerAdminService` refuses any non-zero limit (`COMMERCE_REQUEST_INVALID`) only
     AFTER the replay lookup, on all four writes.
   - So a command that committed before the upgrade and lost its response replays its
     original result.
   - A new key carrying a positive limit is refused. So is an old client re-sending the
     positive value the migration zeroed: the stored value is 0, so a positive one is a
     change. The operator reloads and saves without it.
   - A cached old form can still edit unrelated fields, because after the migration it
     loads and sends 0 (tier) or null (reseller).
3. **[P2] Credit-state vocabulary.**
   - `RESELLER_CREDIT_STATES` is the original four values again.
   - `creditStateOf()` answers `NO_LIMIT`, which is true once every stored limit is zero.
   - An old bundle parses the new server, and the new schema parses an old replica.
   - The Web Admin reads nothing from the field and draws the balance only.
4. **[P2] Report compatibility.** `creditLimit` in the resellers report is a zero money
   object in the selling currency, not null, so an old bundle that requires a money object
   still parses it. The schema still accepts null.
5. **[P2] User-facing credit claims.**
   - Rewritten for the balance-only rule and a legacy debt:
     - `web.wallet_balance_negative_hint`;
     - `web.resellers_intro` and `web.resellers_list_hint`;
     - `web.cb_reseller_standing`;
     - `web.reseller_status_hint` and `web.user_reseller_suspended`;
     - `web.report_resellers_hint`.
   - No Telegram template made a credit claim.
   - A web test now scans every Web Admin string and every Telegram template for an
     active-credit phrase. The one exception is `web.reseller_credit_limit`, the field label
     in change-history rows, migration 0155's included.

### Tests and mutations (each reverted after its run)

| Mutation                                                       | Failed                                                                                                            |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Migration 0155 without its `resellers` UPDATE                  | `resellers.test.ts` "migration 0155 zeroes every stored limit, so the PREVIOUS release computes no credit either" |
| `refuseCredit` called before the replay lookup in `createTier` | "replays a positive-limit command that committed before the decision…" and the HTTP "replays over HTTP…"          |
| `creditStateOf()` returns `CREDIT_APPLIES`                     | 1 unit case and 3 `reseller-phase2-http.test.ts` cases                                                            |
| The report's `creditLimit` back to null                        | 2 `reports.test.ts` cases                                                                                         |
| The old `web.wallet_balance_negative_hint` restored            | 2 web cases: the wallet card and "holds for every Web Admin string"                                               |

The migration test copies the previous release's allowance rule verbatim from `main`.
Before the migration's SQL runs, that rule extends credit on the fixture rows; afterwards
it yields zero for all three. The test also checks that `wallet_entries` is unchanged and
that exactly the two non-zero values are in `audit_logs`.
