# WP14 — Reseller Phase 2: audit and design

Status: audit written before any implementation; §7 records what was built and the evidence. Branch `claude/wp14-reseller-phase2`,
from `origin/main` at `4e6fb39`. It does not depend on WP10G, WP11A, WP12 or WP13.

The governing rule is the owner's: **no reseller debt, repayment, settlement, commission,
profit or accounting semantics are invented.** WP9-B (`docs/wp9-reseller-audit.md`,
decisions R1–R14) is the definition of what a reseller is. This package implements only
what those decisions and the ledger already define. It records every question they leave
open and implements none of those.

---

## 1. What exists

| Area                | Where                                                         | What is there                                                                                                                                                                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity            | `resellers`                                                   | One row per customer, `ACTIVE` or `SUSPENDED` (R1). `SUSPENDED` is an ordinary customer everywhere.                                                                                                                                                                                                            |
| Tiers               | `reseller_tiers`, `reseller_tier_grants`                      | Name, pricing policy (`LIST_PRICE` or `PERCENTAGE_DISCOUNT`) and credit limit, with grants per kind: product, category, panel, bot, operation. Fail-closed (R2, R5).                                                                                                                                           |
| Per-tier pricing    | `reseller-pricing.ts`                                         | The `TIER_PRICE` step replaces the subtotal (R3).                                                                                                                                                                                                                                                              |
| Per-user pricing    | `resellers.pricing_mode`                                      | `TIER` (no override), `LIST_PRICE` or `PERCENTAGE_DISCOUNT`, as a `USER_OVERRIDE` step (R3).                                                                                                                                                                                                                   |
| Credit limits       | `resellers.credit_limit_*`, `reseller_tiers.credit_limit_*`   | The effective limit is the reseller's own, else the tier's (R8).                                                                                                                                                                                                                                               |
| Credit usage        | `ResellerService.creditAllowance` → `canCover`                | Read under the customer's wallet lock at settlement. Applies only to an ACTIVE reseller, in the limit's own currency. A purchase may take the balance down to `−limit`. **Nothing today shows an operator how much of that line is in use.**                                                                   |
| Debt                | the append-only ledger                                        | A negative balance. Not collected, not aged, no fee, no reminder, no suspension (`OQ-WP9-04`).                                                                                                                                                                                                                 |
| Orders and services | `orders.customer_id`, `services.customer_id`                  | A reseller's orders and services are the customer's. Order and service lists already filter by `customerId`.                                                                                                                                                                                                   |
| Purchase snapshot   | `order_reseller_terms`                                        | One append-only row per reseller order, written at confirmation (R9): tier and tier name, layer, percent, list amount, cost, promotion, sale, margin, currency, bot. Indexed `(tenant, reseller, created_at)`. **Readable only one order at a time**, from the order's pricing card.                           |
| Payments            | `PaymentService.settleFromWallet`                             | The only place credit is used. Operator debits never overdraw. A clawback never goes below zero (R8).                                                                                                                                                                                                          |
| Audit               | `audit_logs`                                                  | `reseller.register` and `reseller.update` (entity `Customer`, id the customer); `reseller_tier.create`, `.update` and `.grants` (entity `ResellerTier`). Indexed on `(entity_type, entity_id)`. **Nothing reads them.** `audit.view` is declared, held by owner, observer and finance, and charged by nothing. |
| Web Admin           | `resellers.tsx`, `reseller-tiers.tsx`, the order pricing card | List, register and edit; tiers and the grants editor; the snapshot on each order. The page sends an operator to the customer page for the balance.                                                                                                                                                             |
| Reports             | —                                                             | WP12 (PR #76, unmerged) reports reseller orders, sales, services and credit in use without margin or cost. It is independent of this branch.                                                                                                                                                                   |

## 2. Rules defined exactly, and therefore implementable

1. **The allowance** (R8): an ACTIVE reseller's own limit, else the tier's, in its own
   currency, and only when positive. Zero for anyone else.
2. **Coverage** (`canCover`): a debit is allowed when `balance − amount ≥ −allowance`.
3. **Debt** (`OQ-WP9-04`, as built): the negative part of the balance, repaid by top-ups
   and operator credits like any balance. Suspension or a lower limit stops further credit
   and leaves the debt.
4. **The purchase snapshot** (R9): recorded at confirmation, never rewritten, and read as
   history "not from live settings".
5. **Change history**: every operator write already records its before and after
   (R11).

From these, the following are **derivations, not new rules**:

- **Credit in use** = `max(0, −balance)` in the limit's currency.
- **Available to spend on credit** = `balance + allowance`. This is the frontier
  `canCover` applies, so a purchase of at most this much would pass the credit check
  (other checks still apply).
- **Over the limit by** = `max(0, credit in use − allowance)`. Non-zero only after a
  limit was lowered below the debt or the reseller was suspended. R8 and `OQ-WP9-04` say
  this is allowed and leaves the debt.

## 3. Undefined, and therefore not built

| Question                                                                                          | Status                                                                                                                                           |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OQ-WP9-04`: how debt is settled — cycles, statements, due dates, collection, reminders, blocking | **Undefined.** No settlement, repayment rule, ageing, interest, fee or automatic collection. `RESELLER_SETTLEMENT` stays reserved.               |
| Membership fee (O-3), monthly floor (O-2)                                                         | **Undefined.** `RESELLER_MEMBERSHIP_FEE` stays reserved.                                                                                         |
| `OQ-WP9-05`: showing the reseller price in the catalogue list                                     | **Undefined.** The owner must decide which surfaces show a quote the list does not make. The list keeps the catalogue price; the summary quotes. |
| Reseller profit, commission on their own customers, sub-bots                                      | **Out of scope** (R14 and the owner's instruction).                                                                                              |
| Whether margin is reported                                                                        | Not added anywhere new. It stays where WP9-B put it, on the order's pricing card. The new purchase history omits it.                             |

## 4. What this package builds

All of it is read-only except one confirmation in the Web Admin, which changes no money.

### D1 — Credit standing (`GET /resellers/:customerId/credit`)

- **Permission:** `resellers.view` and `users.view`, because the balance is the
  customer's wallet (`WALLET_VIEW_PERMISSION`).
- **Rule:** the allowance is computed by ONE pure function, `creditAllowanceOf`, which
  `ResellerService.creditAllowance` now calls too. The operator view and settlement cannot
  disagree about the limit.
- **Balance:** it comes from `WalletRepository.balanceOf`, the one derivation, in the
  limit's currency.
- **Answer:** the effective limit and where it comes from (own or tier), whether credit
  applies (and if not, why: suspended, or no limit), the balance, credit in use, available
  to spend, and over-limit.
- **Selling currency:** the limit's currency is also the currency the installation sells
  in; that is the only currency in which credit is extended (R8). When the two differ,
  credit does not apply and the view says so.

### D2 — Purchase history (`GET /resellers/:customerId/purchases`)

- **Permission:** `resellers.view` and `orders.view`.
- **Content:** a keyset page, newest first, of `order_reseller_terms` joined to the
  order's current state and purpose. Tier name as sold, layer, percent, list amount, cost,
  promotion and sale, all per currency.
- **Source:** the snapshot, never live tier settings (R9). Margin is not selected (§3).

### D3 — Change history

- **Routes:** `GET /resellers/:customerId/history` and `GET /reseller-tiers/:id/history`.
- **Permission:** `resellers.view` and `audit.view`.
- **Content:** audit rows of exactly this entity and these actions (`reseller.%` on the
  customer, `reseller_tier.%` on the tier). Nothing else about the customer is returned.
- **Fields:** action, actor type and label, surface, time, result, and the stored
  before/after. They were redacted at write time, and the reseller terms they carry are
  what the page already shows. The actor's IP and user agent are not returned.
- **Bound:** newest first, at most 50 rows. This is a history panel, not a log browser;
  a paged audit browser belongs to WP16.

### D4 — Web Admin

- The reseller detail gains a credit card (D1), a purchases table (D2) and a history
  list (D3). Each is drawn only when the viewer holds the extra key it needs; otherwise
  it shows a sentence naming the key.
- The tier detail gains its history (D3).
- **Two confirmations before a save:** lowering the effective limit below the credit in
  use, and suspending a reseller who has credit in use. Each says, from R8 and
  `OQ-WP9-04`, that the debt stays where it is and further credit stops. The server
  behaviour is unchanged — it accepts both, as it always has.

### D5 — Consistency

- `creditAllowanceOf` becomes the single statement of R8, used by both settlement and the
  view. A unit test pins it, and a mutation of it must fail a test.
- No state, ledger reason, permission, event or migration is added.

## 5. Contracts (own commit)

- `RESELLER_ROUTES`: `credit`, `purchases` and `history`.
- `RESELLER_TIER_ROUTES`: `history`.
- Schemas: `resellerCreditStandingSchema`, `resellerPurchasePageSchema` and its query,
  and `resellerHistoryResponseSchema`.
- The credit-standing reasons: `CREDIT_APPLIES`, `RESELLER_SUSPENDED`, `NO_LIMIT` and
  `CURRENCY_MISMATCH`.

## 6. Tests (targeted)

- **Unit:** `creditAllowanceOf` over status, own and tier limits, currency and zero; the
  derivations (credit in use, available, over-limit).
- **Integration:**
  - a reseller who bought on credit shows the matching credit in use and available;
  - lowering the limit below the debt shows the over-limit amount;
  - a suspended reseller keeps the debt, with no credit applying;
  - the purchase history is the snapshot and survives a tier re-price;
  - the history holds exactly the reseller's rows;
  - permission splits;
  - tenant isolation.
- **Web:** the credit card; the confirmation before lowering a limit below debt; the
  per-key gating.

## 7. What was built, and the evidence

Implemented exactly as §4 describes. No state, ledger reason, permission, event, setting,
template key or migration was added.

| Piece                              | Where                                                                                                                                               |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| R8 stated once                     | `resellers/domain/reseller-credit.ts` (`creditAllowanceOf`, `creditStateOf`, `effectiveLimitOf`, `creditFigures`)                                   |
| Settlement uses it                 | `ResellerService.creditAllowance`; `toResellerSummary`'s effective limit now uses `effectiveLimitOf` too                                            |
| D1–D3 reads                        | `ResellerAdminService.creditStanding`, `.purchases`, `.history`, `.tierHistory`; `ResellersController`                                              |
| Purchase snapshot page             | `DrizzleResellerRepository.listPurchases` — keyset on `(created_at, order_id)`, joined on the terms' own composite foreign key, no margin           |
| Audit reader (reusable, e.g. WP16) | `platform/audit/application/ports.ts` (`AuditHistoryReader`, `AUDIT_VIEW_PERMISSION`) and `drizzle-audit-history.reader.ts`                         |
| Web Admin                          | `pages/reseller-standing.tsx` (three cards), `debtWarningOf` and the acknowledgement in `pages/resellers.tsx`, tier history in `reseller-tiers.tsx` |

Tests:

- `tests/unit/reseller-credit.test.ts` (11): the allowance over status, own/tier limit,
  zero and currency, and the derivations, including `canCover` at the frontier.
- `tests/integration/reseller-phase2-http.test.ts` (12): credit drawn by a real
  `settleFromWallet`; the view's available-to-spend passes settlement and one unit more is
  refused with `shortfallMinor: '1'`; a lowered limit; a suspension; `NO_LIMIT` and
  `CURRENCY_MISMATCH`; the snapshot surviving a tier re-price and rename, without the
  margin; keyset paging and a refused foreign cursor; the exact reseller and tier history,
  a DENIED attempt included, a wallet audit row on the same customer excluded, no IP or
  user agent; the 50-row bound; the permission split key by key; tenant isolation and
  404s.
- `tests/integration/route-registration.test.ts`: the four new routes.
- `tests/web/reseller-standing.test.tsx` (12): the cards, per-key gating (no request
  without the key), both acknowledgements and their reset on any further change, the
  unchanged body, `debtWarningOf` and `changedFieldsOf`.

Mutations, each reverted after the run (one rule at a time):

| Mutation                                                      | Failed                                                                                                                                                                           |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `creditStateOf` without the `status !== 'ACTIVE'` line        | 2 unit cases; integration "keeps a suspended reseller's debt and applies no credit to it"                                                                                        |
| `creditStateOf` without the currency line                     | 1 unit case; the EXISTING settlement case "grants nothing for a purchase in a currency other than the limit's" (`resellers.test.ts`), which shows settlement reads this function |
| The save button without `(warning !== null && !acknowledged)` | 3 web cases (both acknowledgements, and the reset)                                                                                                                               |

Still open, unchanged by this package: `OQ-WP9-04` (settlement, repayment, ageing,
collection) and `OQ-WP9-05` (reseller prices in the catalogue list), the membership fee
and monthly floor, and profit or commission reporting.
