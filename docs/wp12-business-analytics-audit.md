# WP12 — Business Analytics & Reports: audit

Written before any WP12 code, against `origin/main` at `4e6fb39`. Every figure WP12
displays is mapped here to the persisted row it is computed from. A metric this audit
cannot map to a structured source is classified `NOT_SUPPORTED_BY_CURRENT_DATA`, and
the product shows it as unavailable rather than inventing it.

Classifications:

- `SUPPORTED_EXACTLY` — one column or one predicate answers it, with no choice made here.
- `SUPPORTED_WITH_DEFINED_DERIVATION` — answerable from structured state, through a rule
  this document states and the code implements once.
- `NOT_SUPPORTED_BY_CURRENT_DATA` — no structured source exists. Omitted, and the reason
  is given.

Branch: `claude/wp12-business-analytics-reports`, from `origin/main`. It depends on
neither WP10G nor WP11A. **No migration**: §10 shows that every aggregate runs on
existing tables and indexes. Two indexes are proposed for the later integration pass,
with the query each one serves.

---

## 1. Sources

### 1.1 Orders — `orders` (`schema.ts`, `commerce.ts`)

| Fact                   | Column                                                                                              | Notes                                                                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Tenant                 | `tenant_id`                                                                                         | Every query's first predicate.                                                                                         |
| State                  | `state` ∈ `ORDER_STATES` = DRAFT, AWAITING_PAYMENT, PAID, CANCELLED, EXPIRED, REFUNDED              | `ORDER_SETTLED_STATES` = PAID, REFUNDED. `orders_settled_at_check` pins `settled_at IS NOT NULL` ⇔ settled.            |
| When the money arrived | `settled_at`                                                                                        | The timestamp basis for every sale (`PAID_AT`).                                                                        |
| When it was given back | `refunded_at`                                                                                       | Non-null exactly on REFUNDED (`orders_refunded_at_check`).                                                             |
| Commercial operation   | `purpose` ∈ NEW_SERVICE, RENEW, ADD_TRAFFIC, ADD_TIME, TRIAL                                        | Structured and CHECK-pinned. It is never inferred from a label.                                                        |
| Gross, discount, final | `subtotal_amount`, `discount_amount`, `total_amount`, `currency`                                    | `orders_total_consistent_check`: `total = subtotal − discount`. `orders_discount_bounded_check`. bigint minor units.   |
| Product snapshot       | `line_title`, `line_duration_days`, `line_traffic_bytes`, `line_quantity`, `line_unit_price_amount` | Immutable after confirmation (`nexa_orders_snapshot_guard`). `product_id` is "navigation only" — the docblock says so. |
| Category snapshot      | `line_category_id`, `line_category_name`, `line_category_emoji`                                     | NULL means UNKNOWN (pre-WP5 orders), never "uncategorised".                                                            |
| Trial is free          | `orders_trial_is_free_check`                                                                        | `purpose = 'TRIAL'` implies `total_amount = 0`.                                                                        |
| Discount code          | `discount_code`                                                                                     | Normalised upper case, or null.                                                                                        |
| Panel                  | `panel_id`                                                                                          | Navigation, set when the order is created.                                                                             |

A **partial refund** leaves the order PAID (`RefundService.completed`: the order moves
`PAID → REFUNDED` only when the COMPLETED refunds cover the whole payment). The
**undeliverable refund** (`refundUndeliverable`) moves it to REFUNDED directly.

### 1.2 Payments — `payments` (`payment.ts`)

| Fact                    | Column                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| Attempt state           | `state` ∈ PENDING, CONFIRMED, FAILED, CANCELLED, EXPIRED, UNKNOWN                         |
| Terminal with money     | CONFIRMED                                                                                 |
| Terminal without money  | `PAYMENT_RESOLVED_STATES` = FAILED, CANCELLED, EXPIRED                                    |
| Undecided               | PENDING (open) and UNKNOWN (terminal until reconciled, never retried)                     |
| Method                  | `method` ∈ `PAYMENT_METHODS` = WALLET, MANUAL_TRANSFER, GATEWAY                           |
| Route/provider          | `gateway_provider` (nullable text snapshot, frozen by `nexa_payments_confirmation_guard`) |
| Order payment vs top-up | `order_id` (NULL = wallet top-up)                                                         |
| Timestamps              | `created_at`, `confirmed_at`, `resolved_at`                                               |
| One sale per order      | `payments_order_confirmed_key`: at most ONE CONFIRMED payment per order                   |

`gateway_provider` is generic text. On `main` it holds `MANUAL_TRANSFER` or NULL. When
WP11A merges, a TonPays payment carries its own provider value and appears in the
payment report as a new row, with no WP12 change. WP12 names no provider.

### 1.3 Wallet ledger — `wallet_entries` (`ledger.ts`)

Append-only. `direction` is CREDIT or DEBIT, `amount > 0`, and `reason` ∈
`LEDGER_REASONS`, CHECK-pinned. The balance is derived (`balance.ts#signedMinor`) and
there is no balance column. Every WP12 wallet figure is grouped by `reason`, never by
the free-text `note`.

| Group (WP12)                 | Reasons                                                                                                               | Direction |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------- |
| Customer-funded top-up       | TOPUP_GATEWAY, TOPUP_RECEIPT, TOPUP_STARS, TOPUP_CRYPTO                                                               | CREDIT    |
| Receipt credited to wallet   | RECEIPT_CREDIT (a reviewer crediting a card-to-card receipt; customer money, but not a top-up the customer asked for) | CREDIT    |
| Cashback                     | CASHBACK_GATEWAY, CASHBACK_TOPUP, CASHBACK_RENEWAL, CASHBACK_PURCHASE                                                 | CREDIT    |
| Cashback reversal            | CASHBACK_REVERSAL                                                                                                     | DEBIT     |
| Gifts                        | REFERRAL_SIGNUP_GIFT, START_GIFT, LOTTERY_WIN, LUCK_WHEEL_WIN                                                         | CREDIT    |
| Referral commission          | REFERRAL_COMMISSION                                                                                                   | CREDIT    |
| Referral commission reversal | REFERRAL_COMMISSION_REVERSAL                                                                                          | DEBIT     |
| Wallet spending              | PURCHASE                                                                                                              | DEBIT     |
| Refund to wallet             | REFUND, PURCHASE_REVERSAL                                                                                             | CREDIT    |
| Administrative               | ADMIN_CREDIT, ADMIN_DEBIT, MASS_CREDIT, MASS_DEBIT, CORRECTION                                                        | either    |
| Other                        | RESELLER_SETTLEMENT, RESELLER_MEMBERSHIP_FEE, CHARGEBACK, OTHER                                                       | either    |

The report returns the per-reason rows, and the groups above are a pure function of
the reason code, declared once in the reporting domain.

### 1.4 Renewals and add-ons

A renewal, extra traffic or extra time is an ORDER whose `purpose` is RENEW,
ADD_TRAFFIC or ADD_TIME. It has its own `settled_at` and `total_amount`, and one row in
`service_commercial_actions` (`service_commercial_actions_order_key`: one row per
order). `orders_quantity_line_check` pins the line: ADD_TRAFFIC carries positive bytes
and zero days, and ADD_TIME the reverse.

### 1.5 Customers — `customers`

`created_at` is the registration instant: the row is written by the first `/start`, and
`first_seen_at` defaults to the same moment. `status` is ACTIVE or BLOCKED. WP12 reads
**no** profile column (`telegram_user_id`, `username`, `first_name`, `last_name`).

### 1.6 Services — `services` (`provisioning.ts`)

`state` ∈ PENDING_PROVISION, ACTIVE, SUSPENDED, EXPIRED, TERMINATED, UNRECONCILED is
canonical. "Active" is `state = 'ACTIVE'` and is never inferred from `expires_at`.
`provisioned_at` is when the account became real on a panel. `order_id` is the
NEW_SERVICE or TRIAL order that created the service (trigger
`nexa_service_requires_purchase_order`). `panel_id` is the panel.

### 1.7 Provisioning operations — `provisioning_operations`

`type` ∈ `OPERATION_TYPES`; `state` ∈ PLANNED, IN_FLIGHT, SUCCEEDED, FAILED, UNKNOWN,
ABANDONED. The terminal failures are FAILED and ABANDONED. UNKNOWN means "may have taken
effect; a READ decides", so it is **not** a failure. `failure_kind` is structured (the
provider kinds of `PROVIDER_FAILURE_KINDS`); `failure_message` is free text and is never
read by WP12. `completed_at` is the terminal instant, and `panel_id` the panel.

### 1.8 Panels, providers, locations

`panels.provider_type` is a code (ADR-0023: "a provider type is code, not a row"), and
`panels.name` is the operator's label. **Location** exists only as
`products.service_location_label` and `products.display_locations` — marketing text on
the CURRENT product. `customer-ux.ts` states it outright: "a location string is a
promise to a customer, never an instruction to a machine." It is not snapshotted onto the
order or the service.

### 1.9 Referrals

| Table                        | What it records                                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `referrals`                  | One attribution per referee, made at registration and never changed. `created_at` = signup. `trigger` = policy snapshot. |
| `referral_signup_gifts`      | The membership gift: `referrer_amount`, `referee_amount`, and entry ids once claimed.                                    |
| `order_referral_commissions` | PENDING, then EARNED (`earned_amount`, `earned_at`) or VOID.                                                             |
| `wallet_entries`             | REFERRAL_SIGNUP_GIFT, REFERRAL_COMMISSION, REFERRAL_COMMISSION_REVERSAL: the money actually moved.                       |

WP12 reads **money granted** from the ledger, the one place money moves, and reads
attribution from `referrals`.

### 1.10 Resellers

`resellers` (status ACTIVE or SUSPENDED, tier, `credit_limit_amount` and
`credit_limit_currency`) and `order_reseller_terms` (written once per reseller order:
`list_amount`, `cost_amount`, `sale_amount`, **`margin_amount`**). The credit in use is
the reseller's derived wallet balance below zero, in the limit's currency; that is
`canCover`'s own rule (`balance.ts`).

### 1.11 Tenant timezone and calendar

`tenants.display_timezone` (default `Asia/Tehran`) and `tenants.calendar` (default
`jalali`). `CachedTenantPresentationReader` already reads both for message rendering.
`packages/contracts/src/time.ts` declares a `TimePeriodResolver` port and
`NAMED_PERIODS`; both were declared in Phase 0 and never implemented. It says: "No module
computes its own date range." WP12 implements that port, once.

### 1.12 Metric registry

`packages/contracts/src/metrics.ts` declares `METRIC_DEFINITIONS`, empty on purpose
("Phase 0 registers only what it can actually compute"). Each entry has a name, a kind,
a prose formula, a timestamp basis, filters and supported periods. WP12 registers every
metric it computes, as a contract commit of its own. `contracts-invariants.test.ts`
asserts that an unregistered name is refused.

### 1.13 Web Admin

- `/` is `DashboardPage`: readiness, panel distributions and the attention card. It
  carries a `planned` "scope" card that says there is no revenue tile because nothing
  computes one. WP12 replaces that card with the Super Admin business section; the
  operational cards stay, at their own 15 s and 60 s cadence.
- `/reports` exists in the nav (permission `reports.view`) and renders `PlannedPage`.
  WP12 turns it into the real Reports page and removes the planned entry, as each earlier
  package did.
- `/referrals` is read-only lists plus the banner card. WP12 adds the analytics section
  to it.
- **Charts:** no chart library, and `apps/web/package.json` has three runtime
  dependencies. WP12 draws one inline SVG line chart; no dependency is added.
- **Jalali:** `@nexa/i18n` formats with `Intl` and the `fa-IR-u-ca-persian-nu-latn`
  locale. That is ICU's calendar with Latin digits, and it is the project's vetted
  calendar authority. WP12 uses the same ICU calendar on the server to find Jalali
  day, month and year boundaries. There is no hand-written leap-year arithmetic.
- **Money:** `formatMoney` / `<Money>` renders the full value, never abbreviated.
- **Polling:** `pollUnlessFinal(ms)` in `polling.ts` is the one interval rule.
- **Pagination:** keyset cursors (`encodeKeysetCursor` of `(createdAt, id)`), newest
  first, `nextCursor: null` at the end.

### 1.14 Exports

The only existing download is the backup archive and the receipt bytes. Both use
`@Res()`, `content-disposition: attachment` and a URL the browser navigates to, so the
session cookie rides along. There is no CSV or XLSX writer and no spreadsheet
dependency. WP12 adds a bounded server-side CSV writer and a minimal OOXML (XLSX)
writer, using `zlib.deflateRawSync` and `zlib.crc32` (Node ≥ 22.2; the engine floor is
22.11). There is no job system: every export is bounded (§8).

### 1.15 Caching

`CachedTenantPresentationReader` has a one-minute cache for presentation. No report
cache exists, and WP12 adds none (§10).

---

## 2. Super Admin

**Finding.** The highest-authority mechanism is the `owner` role (`OWNER_ROLE_KEY`,
`identity.ts`). Its seed holds every permission (`ROLE_SEEDS`: `owner` = ALL). The
identity services already use owner-role membership as the discriminator for the most
privileged acts: granting it, disabling an owner, and last-owner protection. Permissions
are stored as `role_permissions` rows.

**Why not a permission alone.** `reports.view` is held today by `operator`, `finance`,
`sales`, `observer` and others (`permissions.ts`). A new permission such as
`reports.business.view` would need a backfill migration to reach existing owner roles
(the rows are stored, not computed; compare `0031`). That is the migration the spec
asks us to avoid, and it could collide with the open `0121` branches.

**Decision.** A business or financial report requires BOTH:

1. the existing permission, through `PermissionGuard.check` — `reports.view` to read and
   `reports.export` to export. This keeps denials audited (`access.permission_denied`)
   and keeps a disabled owner or a negative override refused by the ONE resolution rule;
2. membership of the existing `owner` role, read through `AdminRepository.roleKeysFor`
   on every request, never cached into a session.

This is a role check, not an actor-type check. No new role, permission or migration is
added. A non-owner holding `reports.view` is refused with the same 403
`PERMISSION_DENIED` shape the guard produces, and an `access.permission_denied` event is
recorded with `requiredRole: owner`. The Web Admin reads the session's existing
`roleKeys` and hides the business section, the Reports nav entry and the referral
analytics from a non-owner. The server refuses them regardless.

---

## 3. Periods, timezone and granularity

All boundaries are computed in the tenant's `display_timezone` and `calendar`, as
half-open UTC intervals `[start, end)` (`time.ts`). SQL never applies `AT TIME ZONE`,
and the database's and the browser's zones play no part. Jalali only changes where a
MONTH or YEAR begins and how a label is written; the Jalali label is presentation over
the same instant.

| Range             | Current `[start, end)`                                                                                          | Previous (nominal)                         |
| ----------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| TODAY             | local midnight today → next local midnight                                                                      | yesterday                                  |
| YESTERDAY         | yesterday                                                                                                       | the day before                             |
| LAST_7_DAYS       | 6 days before today → tomorrow (7 local days, today included)                                                   | the 7 days before                          |
| LAST_30_DAYS      | as above, 30 days                                                                                               | the 30 days before                         |
| THIS_MONTH        | first day of this calendar month → first day of next                                                            | the previous calendar month                |
| PREVIOUS_MONTH    | the previous calendar month                                                                                     | the month before it                        |
| THIS_YEAR         | first day of this calendar year → first day of next                                                             | the previous calendar year                 |
| CUSTOM `from..to` | local midnight of `from` → local midnight after `to` (dates in the TENANT's calendar, inclusive, 1 to 731 days) | the same number of days immediately before |

"Calendar month" and "calendar year" are in the tenant's calendar: Mehr 1405, not
September.

**One previous-period rule.** The previous period is the same span shifted back one unit
of the range: a day, N days, a calendar month or a calendar year.

**Comparisons (KPI cards) compare like with like.** When the current period contains
_now_, its figures run to _now_ and the previous period's run for the same elapsed
duration from its own start. So "today so far" is compared with "yesterday up to the
same time", and "this month so far" with "last month's first N days to the same hour".
When the current period is wholly past, both full periods are compared. For
PREVIOUS_MONTH and THIS_YEAR the two lengths can differ (a 31-day Jalali month against a
30-day one), and the response says so with `lengthsDiffer: true`. The UI shows a note
for it.

**Granularity** is decided by the number of local days D in the nominal current period:
D = 1 → hourly; D ≤ 31 → daily; D ≤ 186 (6 × 31) → weekly; otherwise monthly. TODAY and
YESTERDAY are hourly, the month presets daily and THIS_YEAR monthly.

**Bucket alignment.** Bucket _i_ of the current period is compared with bucket _i_ of
the previous period:

- hour _i_ of the day;
- day _i_ of the span (day _i_ of the month for the month presets);
- the _i_-th 7-day block from the period start (the last block may be short);
- the _i_-th calendar month.

Each series carries its own labels and bucket ranges, so the tooltip names both. A
current bucket that starts after _now_ is `null` (future), never `0`. The chart draws
the whole previous series.

**Percentages.** The server returns both raw values and never a ratio of zero. The UI
applies one pure rule:

- previous = 0 and current = 0 → `—`
- previous = 0 and current > 0 → "new"
- otherwise → a signed percentage in basis points, from integer arithmetic on the
  minor units

A movement is never coloured good or bad.

---

## 4. KPI source mapping

"Commercial purposes" means NEW_SERVICE, RENEW, ADD_TRAFFIC and ADD_TIME. It is
`ORDER_PURPOSES` minus TRIAL, decided by an exhaustive classifier.

| #   | Metric (registry name)                  | Classification                    | Derivation                                                                                                                                                    | Basis        |
| --- | --------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| 1   | Sales count `sales.count`               | SUPPORTED_WITH_DEFINED_DERIVATION | `count(*)` of orders with `state='PAID'`, `purpose ∈ commercial`, `settled_at ∈ period`                                                                       | PAID_AT      |
| 2   | Revenue `sales.revenue`                 | SUPPORTED_WITH_DEFINED_DERIVATION | `sum(total_amount)` over the same rows, grouped by `currency`                                                                                                 | PAID_AT      |
| 3   | Successful orders `orders.successful`   | SUPPORTED_WITH_DEFINED_DERIVATION | `count(*)` of `state='PAID'` orders of ANY purpose, `settled_at ∈ period`: sales plus trials granted                                                          | PAID_AT      |
| 4   | New users `customers.new`               | SUPPORTED_EXACTLY                 | `count(*)` of customers with `created_at ∈ period`                                                                                                            | CREATED_AT   |
| 5   | New services `services.new`             | SUPPORTED_WITH_DEFINED_DERIVATION | `count(*)` of services with `provisioned_at ∈ period`, split by the creating order's purpose (NEW_SERVICE, TRIAL)                                             | COMPLETED_AT |
| 6   | Renewals `sales.renewals`               | SUPPORTED_EXACTLY                 | as #1, with `purpose='RENEW'`                                                                                                                                 | PAID_AT      |
| 7   | Wallet top-up `wallet.topup`            | SUPPORTED_EXACTLY                 | `sum(amount)` and `count(*)` of CREDIT entries with reason ∈ TOPUP_*, `created_at ∈ period`, by currency                                                      | OCCURRED_AT  |
| 8   | Active services now `services.active`   | SUPPORTED_EXACTLY                 | `count(*)` of services with `state='ACTIVE'`, now (a gauge, with no comparison)                                                                               | —            |
| 9   | Active customers now `customers.active` | SUPPORTED_WITH_DEFINED_DERIVATION | distinct customers with an ACTIVE service OR a PAID commercial order with `settled_at ∈ [now−30 d, now)` (§4.5 of the spec). A top-up alone does not qualify. | —            |
| 10  | New buyers `customers.new_buyers`       | SUPPORTED_WITH_DEFINED_DERIVATION | customers whose EARLIEST PAID commercial order has `settled_at ∈ period`                                                                                      | PAID_AT      |
| 11  | Gross order value `sales.gross`         | SUPPORTED_EXACTLY                 | `sum(subtotal_amount)` over #1's rows                                                                                                                         | PAID_AT      |
| 12  | Discount granted `sales.discount`       | SUPPORTED_EXACTLY                 | `sum(discount_amount)` over #1's rows                                                                                                                         | PAID_AT      |

**Revenue rules**

- **After discount.** `total_amount` IS the final amount; `subtotal − discount = total`
  is a CHECK. The current product price is never read.
- **Top-up is not revenue.** A top-up is a payment with `order_id IS NULL` and a TOPUP_*
  ledger credit; it is not an order, so it cannot enter #1 or #2. A later wallet
  purchase is an order settled by a WALLET payment, and it is counted there exactly once.
- **Cashback, gifts and commissions are not revenue.** They are ledger entries only, and
  no revenue query reads `wallet_entries`.
- **One order, one sale.** The query counts ORDER rows, never payment rows. Retries are
  extra payment attempts on the same order and add nothing, and the idempotent
  settlement re-delivery cannot create a second PAID row for one order.
- **Refunded orders are not sales.** A REFUNDED order was not delivered (the automatic
  undeliverable refund) or its whole payment was returned. `state='PAID'` excludes it,
  so a full refund removes that order from the period it was settled in. A **partial**
  refund leaves the order PAID and is not netted: refund accounting is out of scope
  (§34), and the report states that revenue is not net of partial refunds.
- **Zero-total paid orders** (a 100 % discount) are sales with zero revenue. A TRIAL is
  never a sale.
- **Currency.** Money is grouped by `currency` and never summed across currencies. The
  trend chart plots one currency — the tenant's `sales.currency` unless another is
  asked for — and the response lists every currency present in the range.

---

## 5. Section mappings

### 5.1 Products (§9) — SUPPORTED_WITH_DEFINED_DERIVATION

Group PAID NEW_SERVICE and RENEW orders settled in the period by
`(product_id, line_title)`: `count(*)`, `sum(total_amount)` per currency, and
`sum(line_quantity)`. The ranking label is the SNAPSHOT `line_title`. A product renamed
after a sale therefore appears under the name it was sold as, and new sales appear
under the new name, as a separate row. The current product row is read for ONE fact
only, its current `status`, shown as a lifecycle badge (ACTIVE or INACTIVE — `PRODUCT_STATUSES` has no third).
Products cannot be deleted while orders reference them (`orders_product_fk`), so a
historical row always has a product to link to. The snapshot category name is shown
beside the title. Add-on purchases (ADD_TRAFFIC, ADD_TIME) are not products and are
reported under Services. Top 10 by count and top 10 by revenue; "View all" is paged.

### 5.2 Services (§10)

| Metric                                | Classification                    | Derivation                                                                                                                                                                                                                                                     |
| ------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New services                          | SUPPORTED_WITH_DEFINED_DERIVATION | #5 above                                                                                                                                                                                                                                                       |
| Currently active                      | SUPPORTED_EXACTLY                 | `state='ACTIVE'`                                                                                                                                                                                                                                               |
| Current state distribution            | SUPPORTED_EXACTLY                 | `count(*)` by `state`, now                                                                                                                                                                                                                                     |
| Renewals / extra traffic / extra time | SUPPORTED_EXACTLY                 | PAID orders by `purpose`, settled in the period: count and revenue                                                                                                                                                                                             |
| Traffic sold                          | SUPPORTED_WITH_DEFINED_DERIVATION | `sum(line_traffic_bytes × line_quantity)` over PAID NEW_SERVICE, RENEW and ADD_TRAFFIC orders settled in the period, EXCLUDING `line_traffic_bytes = 0`, which is `UNLIMITED_TRAFFIC_BYTES`. Unlimited lines are counted separately rather than added as zero. |
| Expired/inactive                      | SUPPORTED_EXACTLY                 | the EXPIRED, SUSPENDED and TERMINATED counts in the current distribution                                                                                                                                                                                       |

### 5.3 Provider / panel / location (§11) — no revenue

| Metric                          | Classification                    | Derivation                                                                                                                                                                                                                                                     |
| ------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Services created, by panel      | SUPPORTED_WITH_DEFINED_DERIVATION | services with `provisioned_at ∈ period`, grouped by `services.panel_id`                                                                                                                                                                                        |
| Active services, by panel       | SUPPORTED_EXACTLY                 | `state='ACTIVE'` grouped by `panel_id`                                                                                                                                                                                                                         |
| Traffic sold, by panel          | SUPPORTED_WITH_DEFINED_DERIVATION | §5.2's traffic rule grouped by `orders.panel_id`. Bytes only, never money.                                                                                                                                                                                     |
| Provisioning failures, by panel | SUPPORTED_WITH_DEFINED_DERIVATION | `provisioning_operations` with `type='PROVISION'`, `state ∈ {FAILED, ABANDONED}`, `completed_at ∈ period`                                                                                                                                                      |
| By provider                     | SUPPORTED_WITH_DEFINED_DERIVATION | the panel rows rolled up by `panels.provider_type`; one service has one panel, so there is no double count                                                                                                                                                     |
| **By location**                 | **NOT_SUPPORTED_BY_CURRENT_DATA** | Location is marketing text on the CURRENT product, not snapshotted, and a product may list several. Attributing a service to a location would either rewrite history from today's catalogue or count one service more than once. Omitted, and the UI says why. |

There is no money anywhere in this section. That is the spec's §28 and the dashboard's
"Revision 2".

### 5.4 Payments (§12)

A cohort of payment attempts **created** in the period, grouped by
`(method, gateway_provider, kind)`, where kind is ORDER (`order_id` not null) or TOPUP:

| Metric              | Classification                    | Derivation                                                                                                                                                                       |
| ------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Attempts            | SUPPORTED_EXACTLY                 | `count(*)`                                                                                                                                                                       |
| Successful          | SUPPORTED_EXACTLY                 | `state='CONFIRMED'`                                                                                                                                                              |
| Failed terminal     | SUPPORTED_WITH_DEFINED_DERIVATION | `state ∈ PAYMENT_RESOLVED_STATES` (FAILED, CANCELLED, EXPIRED), each shown separately as well                                                                                    |
| Pending / undecided | SUPPORTED_EXACTLY                 | PENDING and UNKNOWN, shown separately                                                                                                                                            |
| Success rate        | SUPPORTED_WITH_DEFINED_DERIVATION | `successful / (successful + failed terminal)`, where failed terminal = FAILED + CANCELLED + EXPIRED. PENDING and UNKNOWN are in neither term. Null when the denominator is zero. |
| Successful amount   | SUPPORTED_EXACTLY                 | `sum(amount)` of CONFIRMED rows, by currency                                                                                                                                     |

WALLET payments appear as their own method. The route name is the raw
`gateway_provider` code, with no provider-specific branch.

### 5.5 Wallet (§13)

| Metric                                  | Classification                    | Derivation                                                                                                                                                             |
| --------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Customer-funded top-up amount and count | SUPPORTED_EXACTLY                 | TOPUP_* credits, `created_at ∈ period`                                                                                                                                 |
| Receipt credited to wallet              | SUPPORTED_EXACTLY                 | RECEIPT_CREDIT credits (shown separately, not merged into top-up)                                                                                                      |
| Cashback / gift amount                  | SUPPORTED_EXACTLY                 | the groups in §1.3                                                                                                                                                     |
| Wallet spending                         | SUPPORTED_EXACTLY                 | PURCHASE debits                                                                                                                                                        |
| Aggregate balance                       | SUPPORTED_WITH_DEFINED_DERIVATION | Σ signed amount of every entry up to now, by currency — the same `signedMinor` rule. This is the stored-value liability; it can include a reseller's negative balance. |
| Per-reason detail                       | SUPPORTED_EXACTLY                 | every (reason, direction) row with count and amount                                                                                                                    |

### 5.6 Referral (§14)

| Metric                          | Classification                    | Derivation                                                                                                                                                                                         |
| ------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Referral signups                | SUPPORTED_EXACTLY                 | `referrals.created_at ∈ period`                                                                                                                                                                    |
| Converted buyers                | SUPPORTED_WITH_DEFINED_DERIVATION | a cohort: referees attributed in the period who have ≥ 1 PAID commercial order, at any time up to now                                                                                              |
| Conversion rate                 | SUPPORTED_WITH_DEFINED_DERIVATION | converted ÷ signups of the same cohort; null when there are no signups                                                                                                                             |
| Signup / membership gifts       | SUPPORTED_EXACTLY                 | REFERRAL_SIGNUP_GIFT credits in the period (amount and count, both parties)                                                                                                                        |
| Purchase commissions granted    | SUPPORTED_EXACTLY                 | REFERRAL_COMMISSION credits in the period; reversals are shown separately                                                                                                                          |
| Revenue from referred customers | SUPPORTED_WITH_DEFINED_DERIVATION | §4 revenue restricted to customers who are a `referrals.referee_id`                                                                                                                                |
| Top referrers                   | SUPPORTED_WITH_DEFINED_DERIVATION | per referrer: signups in the period, converted buyers from those signups, referred revenue in the period, commission credited in the period. Ranked by the chosen field; top 10 plus a paged view. |

Referral rewards are not revenue: every reward figure comes from the ledger, and revenue
comes from orders only.

### 5.7 Reseller (§15)

| Metric                       | Classification                    | Derivation                                                                                                                     |
| ---------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Order count                  | SUPPORTED_EXACTLY                 | PAID orders settled in the period that have an `order_reseller_terms` row, grouped by `reseller_customer_id`                   |
| Sales amount                 | SUPPORTED_EXACTLY                 | `sum(orders.total_amount)` over those orders — what the reseller was charged                                                   |
| Service count                | SUPPORTED_WITH_DEFINED_DERIVATION | services created from those orders (`services.order_id`) and provisioned in the period                                         |
| Credit in use                | SUPPORTED_WITH_DEFINED_DERIVATION | now: max(0, −balance) of the reseller's wallet in `credit_limit_currency`, beside the limit                                    |
| Profit / margin / settlement | NOT REPORTED                      | `order_reseller_terms.margin_amount` and `cost_amount` exist and are deliberately **never selected** (§15 and §27 of the spec) |

### 5.8 Failure summary (§16)

| Metric                          | Classification                    | Derivation                                                                                   |
| ------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------- |
| Failed payments                 | SUPPORTED_EXACTLY                 | `state='FAILED'`, `resolved_at ∈ period`; EXPIRED and CANCELLED beside it                    |
| Payments with unknown outcome   | SUPPORTED_EXACTLY                 | `state='UNKNOWN'` now                                                                        |
| Failed service provisioning     | SUPPORTED_EXACTLY                 | PROVISION operations FAILED or ABANDONED, `completed_at ∈ period`                            |
| Failed commercial operations    | SUPPORTED_EXACTLY                 | RENEW, ADD_TRAFFIC and ADD_TIME operations FAILED or ABANDONED, `completed_at ∈ period`      |
| Provider failures               | SUPPORTED_WITH_DEFINED_DERIVATION | failed operations of any type, `completed_at ∈ period`, grouped by structured `failure_kind` |
| Operations with unknown outcome | SUPPORTED_EXACTLY                 | `state='UNKNOWN'` now                                                                        |
| Orders refunded                 | SUPPORTED_EXACTLY                 | `refunded_at ∈ period` (any cause; the cause is not structured on the order)                 |
| Queue / outbox / worker health  | out of scope                      | WP16                                                                                         |

---

## 6. Drill-down

Keyset-paged, newest first, `(timestamp, id)` cursors, at most 100 rows a page.

- **Orders** (sales, renewals, a product row): PAID orders settled in the period, with
  optional `purpose` and `productId` filters. Each row carries the order id, `settled_at`,
  purpose, snapshot title and category, subtotal, discount, total, currency, the
  confirmed payment's method and route, and the customer id **as a link only**.
- **Payments** (a payment row): attempts created in the period, with optional `method`,
  `provider`, `kind` and `state`. Each row carries the payment id, reference, created
  at, method, route, kind, state, amount and order id.
- **Operations** (failed provisioning): FAILED or ABANDONED operations completed in the
  period, with optional `type`. Each row carries the operation id, service id, order id,
  panel name, type, state, `failure_kind` and `completed_at`. `failure_message` is NOT
  returned: it is provider text.

No drill-down returns a phone number, Telegram id, username, first or last name, a
credential, a subscription URL or a provider address. Each row links to the canonical
detail page (`/orders/:id`, `/payments/:id`, `/services/:id`, `/users/:id`), whose own
permissions govern what it shows.

---

## 7. Endpoints

All are `GET` under `/api/admin/v1/reports/…`, all are Super Admin (§2), all are
tenant-scoped by the session, and all take `range` (a preset or `CUSTOM` with
`from`/`to` as tenant-calendar dates `YYYY-MM-DD`).

| Path                                                           | Answers                                                   |
| -------------------------------------------------------------- | --------------------------------------------------------- |
| `summary`                                                      | KPI cards 1–12 with comparisons, plus the resolved period |
| `trend?metric=REVENUE\|SALES\|NEW_USERS\|RENEWALS[&currency=]` | aligned current and previous buckets                      |
| `products?by=COUNT\|REVENUE[&page=]`                           | ranking: top 10, then paged                               |
| `services`                                                     | §5.2                                                      |
| `infrastructure`                                               | §5.3                                                      |
| `payments`                                                     | §5.4                                                      |
| `wallet`                                                       | §5.5                                                      |
| `referrals[&by=SIGNUPS\|BUYERS\|REVENUE\|COMMISSION&page=]`    | §5.6                                                      |
| `resellers`                                                    | §5.7                                                      |
| `failures`                                                     | §5.8                                                      |
| `orders`, `payment-attempts`, `operations`                     | drill-downs (§6)                                          |
| `export?report=…&format=csv\|xlsx`                             | §8                                                        |

---

## 8. Export

Super Admin only, charged on `reports.export`. The selected report and range are
rendered server-side. Rows are capped at `REPORT_EXPORT_ROW_MAX` (10 000); a larger
result is refused with a validation error that says to narrow the range, never
silently truncated.

- **CSV:** UTF-8 with a BOM (Excel opens Persian correctly), CRLF line ends and RFC 4180
  quoting. A TEXT cell starting with `= + - @` is prefixed with `'` (formula
  injection); numbers are written raw.
- **XLSX:** a minimal OOXML workbook with one sheet, inline strings, and NUMERIC cells
  for counts, bytes and money (minor units scaled by `CURRENCY_EXPONENT`).
  Deterministic: fixed zip timestamps.
- **Columns:** Persian headers from `@nexa/i18n`. Each date column carries the Jalali
  display date AND an ISO-8601 UTC timestamp.
- **File name:** `nexa-<report>-<start>-to-<end>.<ext>` in the tenant calendar, e.g.
  `nexa-sales-1405-07-01-to-1405-07-30.csv`. A single day is `nexa-sales-1405-07-03.csv`
  and a whole calendar month `nexa-payments-1405-07.xlsx`. No tenant id or UUID appears.
- **Never included:** secrets, gateway configuration, provider URLs, customer profile
  fields, `failure_message`, reseller margin or cost.

---

## 9. Refresh

Every business query uses `refetchInterval: pollUnlessFinal(300_000)`, which is 5
minutes, and each card shows a manual refresh control and its last-updated time. The
operational cards keep 15 s and 60 s. Each section is its own query, so one slow report
does not block the dashboard.

---

## 10. Performance and migrations

Every aggregate is one SQL statement, bounded by `tenant_id` and a half-open time
range, and returns grouped rows. There is no N+1, and Node never sums raw rows. Buckets
are computed in SQL with `width_bucket(ts, $boundaries::timestamptz[])` over boundaries
built in Node from the tenant calendar, so a Jalali month needs no SQL calendar.

| Query                                | Index used today                                                          |
| ------------------------------------ | ------------------------------------------------------------------------- |
| customers by `created_at`            | a sequential scan of the tenant's customers (acceptable at current scale) |
| orders PAID by `settled_at`          | `orders_tenant_state_idx (tenant_id, state)`, then a filter               |
| payments by `created_at`             | `payments_tenant_created_idx`                                             |
| ledger by `created_at`               | `wallet_entries_tenant_created_idx`                                       |
| services by `provisioned_at` / state | `services_tenant_state_idx`, `services_tenant_created_idx`                |
| operations                           | the tenant filter; volume is small                                        |

**No cache.** Each query is bounded and indexed, and a 5-minute cadence from a handful
of owners is a trivial load. Adding Redis without a measurement is what §21 forbids. If
a cache is ever measured to be needed, it is keyed by tenant plus the canonical
parameters.

**No migration.** For the integration pass, where a measured plan warrants them:

- `CREATE INDEX CONCURRENTLY orders_tenant_settled_idx ON orders (tenant_id, settled_at) WHERE settled_at IS NOT NULL` — revenue, sales and the trend.
- `CREATE INDEX CONCURRENTLY customers_tenant_created_idx ON customers (tenant_id, created_at)` — new users.

---

## 11. Not supported, and why

| Requested                              | Why                                                                                                            |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Location breakdown                     | No snapshotted, unambiguous single location (§5.3).                                                            |
| Refund-netted revenue                  | Refund accounting is out of scope (spec §34). A partial refund is not netted; a full refund removes the order. |
| Profit, margin, cost                   | Forbidden (spec §27); `margin_amount` and `cost_amount` are never selected.                                    |
| Revenue by panel, provider or location | Forbidden (spec §28).                                                                                          |
| Refund cause on the order              | Not structured on `orders`; "orders refunded" is reported without a cause.                                     |
| Reseller settlement or debt            | Reseller Phase 2.                                                                                              |
