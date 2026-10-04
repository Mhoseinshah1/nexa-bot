# Financial Reports V2 (Phase E2)

Program §20. A financial statement on `/reports?tab=finance`, built only from rows the
installation already records: orders, payments, refunds and the wallet ledger. No migration,
no new table, no cache. Same gate as every WP12 report: the owner role AND `reports.view`
(`reports.export` for the file), charged by the service before anything is read.

This document is the definition. Each figure below is registered by name in
`METRIC_DEFINITIONS` (`finance.*`), computed by one statement in
`drizzle-reporting.repository.ts`, and filed into lines by the pure
`application/financial-statement.ts`.

## 1. Audit — what exists, and what does not

| Fact                           | Where                                                                                                                          | Used for         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| A sale                         | `orders`: `state` PAID or REFUNDED, `settled_at`, `subtotal/discount/total_amount`, `currency`                                 | Sales            |
| The payment that settled it    | `payments`: at most ONE `CONFIRMED` per order (`payments_order_confirmed_key`), `method`, `gateway_provider`                   | Sales by channel |
| Money from outside             | `payments` `CONFIRMED`, `method <> 'WALLET'`, `confirmed_at`, `amount` (principal)                                             | Cash             |
| Gateway fee the customer bore  | `payments.customer_fee_amount`, `payable_amount = amount + fee` (WP18, CHECK-pinned, gateway only)                             | Cash             |
| A receipt credited to a wallet | `wallet_entries` `RECEIPT_CREDIT` (its payment is FAILED, `docs/payments-file02-design.md` D2)                                 | Cash             |
| A refund                       | `refunds` `COMPLETED`, `completed_at`, `channel` (WALLET_CREDIT, EXTERNAL_MANUAL, PROVIDER); partial refunds are separate rows | Sales            |
| Stored value                   | `wallet_entries`, append-only, signed by direction; reasons grouped by `WALLET_REPORT_GROUP_OF`                                | Wallet           |
| Reseller orders                | `order_reseller_terms` (one row per reseller order)                                                                            | Reseller sales   |
| Tenant calendar and zone       | `tenants.display_timezone`, `tenants.calendar`, through `IntlReportPeriodResolver`                                             | Buckets          |

**Not recorded, so not reported:**

- **The fee a provider deducted.** WP18 stores the customer's fee; a provider's own amounts
  are diagnostics only and no deduction is stored anywhere. So the _fee borne by the
  platform_ and _net received after provider fees_ are not computed. The response carries
  `providerFeeRecorded: false` and the page says so in a sentence.
- **Cost.** Products carry a price and nothing else; no server, panel or purchase cost is
  attributable to a sale. `order_reseller_terms.cost_amount` is the reseller's price, not the
  installation's cost, and is never read. So there is **no profit**: `profitSupported: false`
  and a sentence on the page. No metric is named profit, margin or cost
  (`contracts-invariants.test.ts`).
- **A refund of a top-up.** `RefundService` refuses it (`TOPUP_CREDITED_TO_WALLET`), so every
  refund names an order payment.
- `PURCHASE_REVERSAL`, `RESELLER_*`, `CHARGEBACK`, `LOTTERY_WIN`, `LUCK_WHEEL_WIN` are in the
  ledger vocabulary and written by nothing today. They are still filed (§4), so a writer added
  later lands in a group rather than nowhere.

## 2. Definitions

Three sections. **No figure adds two sections together.**

### Sales — revenue recognised at settlement (`finance.sales`, `finance.refunds`, `finance.net_sales`)

- **Sales** — orders of a sale purpose (never TRIAL) whose money was taken in the bucket:
  `state IN ('PAID','REFUNDED')`, by `settled_at`. Gross (`subtotal`), discount and sales
  (`total` = gross − discount, by CHECK). One row per ORDER, never per payment attempt.
- **Refunds** — `COMPLETED` refunds by `completed_at`, split into _to the wallet_
  (WALLET_CREDIT) and _paid out_ (EXTERNAL_MANUAL, PROVIDER). Partial refunds are separate
  rows and sum to at most the payment.
- **Net sales** = sales − refunds, per currency, same bucket.

**Why REFUNDED orders stay sales.** WP12's dashboard revenue counts only orders still PAID
_now_, so a refund rewrites the month the sale was in. A statement must not change after the
fact: here the sale stays in its own period and the refund is a line in the period it
completed. A sale in September refunded in October is +X in September and −X in October,
never "nothing" in both. Pinned by _"keeps a closed period as it was"_.

### Cash from customers (`finance.customer_paid`, `finance.receipt_credits`)

Money that arrived from **outside**, before any provider deduction:

- **Principal received** — `Σ payments.amount`, CONFIRMED, `method <> 'WALLET'`, by
  `confirmed_at`, for orders AND top-ups.
- **Gateway fee borne by the customer** — `Σ customer_fee_amount`. Gateway only; non-
  refundable; never inside sales, never credited to a wallet (WP18 O7–O9).
- **Gross customer-paid** — `Σ coalesce(payable_amount, amount)` = principal + customer fee.
- **Receipt credited to a wallet** — `RECEIPT_CREDIT` entries: transfer money a reviewer
  credited instead of confirming. Its payment is FAILED and so is not in the lines above.
- **Fee borne by the platform / net received** — not recorded (§1).

### Wallet — the stored value the tenant owes (`finance.wallet_liability`)

Per currency: **opening** (Σ signed entries before the period), the **movement** of each
`WALLET_REPORT_GROUPS` group in the period, and **closing** = opening + Σ movements. The
statement's lines also show, per bucket: top-ups (TOPUP credits), wallet spending
(PURCHASE debits, as a positive amount), cashback net of its reversals, referral commission
net of its reversals, and gifts. Cashback, commissions and gifts are promotional credits the
installation funds — liabilities, not revenue and not a reduction of it.

## 3. Wallet movements vs revenue — never double counted

| Event                               | Sales          | Cash                               | Wallet                   |
| ----------------------------------- | -------------- | ---------------------------------- | ------------------------ |
| Top-up 500 000 by card              | —              | +500 000                           | TOPUP +500 000           |
| Wallet purchase 300 000             | +300 000       | —                                  | SPENDING −300 000        |
| Card purchase 400 000               | +400 000       | +400 000                           | —                        |
| Gateway purchase 200 000, 2 % fee   | +200 000       | principal +200 000, fee +4 000     | —                        |
| Full refund of it to the wallet     | refund 200 000 | —                                  | REFUND +200 000          |
| Re-purchase 150 000 from the wallet | +150 000       | —                                  | SPENDING −150 000        |
| Partial refund 100 000 paid out     | refund 100 000 | — (money out; shown as _paid out_) | —                        |
| Cashback 20 000, reversed 7 500     | —              | —                                  | CASHBACK +12 500 net     |
| Account transfer 100 000 (pair)     | —              | —                                  | TRANSFER 0               |
| Legacy opening balance 250 000      | —              | —                                  | OPENING_BALANCE +250 000 |

- A **top-up is a liability movement**: cash in, wallet up. It is not an order, so the sales
  statement cannot see it.
- The **wallet purchase is revenue**: an order, settled by a WALLET payment. It is never cash —
  the cash statement excludes `method = 'WALLET'` — because that money already arrived once,
  as the top-up.
- A **refund to the wallet** is a sales refund and a wallet credit; the re-purchase from it is a
  new sale and a wallet debit. The ledger's REFUND entry is deliberately in no income line
  (`financial-statement.ts` files it on the wallet only).
- An **account transfer** is a DEBIT and a CREDIT of the same amount: zero.
- A **legacy opening balance** (`MIGRATION_OPENING_BALANCE`, Migration P2) is a liability the
  installation inherited: no money arrived and nothing was sold, so it is on the wallet
  section only, as its own `OPENING_BALANCE` movement (negative for a legacy debt).
  `docs/migration-opening-balance.md`.

Each row of this table is an assertion in `tests/integration/financial-reports.test.ts`
(and, as pure filing rules, in `tests/unit/financial-statement.test.ts`).

## 4. Buckets, timezone and edges

- The period is any WP12 range (presets or a CUSTOM tenant-calendar range), resolved by the
  one resolver in the tenant's zone and calendar, half-open `[start, end)`.
- Granularity: `DAY`, `WEEK` or `MONTH`, chosen on the page and sent as `granularity`.
  Absent, the WP12 length rule decides, with an hour read as a day. **WEEK** is 7-day blocks
  from the period's first day (the last may be short), as WP12's weekly buckets are — not
  calendar weeks. **MONTH** is the tenant calendar's month (a Jalali month).
- Each fact is bucketed on its own timestamp by `width_bucket` over explicit thresholds — no
  `AT TIME ZONE` in SQL. A row exactly on a boundary belongs to the LATER bucket; a row at the
  period's end instant is outside. A running period is read to _now_; buckets that have not
  begun are `lines: null`, never zero.
- **Totals are the exact sum of the buckets**: they are computed from the same grouped rows.

## 5. Breakdowns

- **Sales by channel** — the order's one CONFIRMED payment's method and route; `null` when no
  payment was needed. Adds up to sales.
- **Cash by route** — method, route and kind (ORDER or TOPUP). Adds up to gross customer-paid.
- **By product** — sales by `(product_id, snapshot line_title, currency)`, with the refunds of
  those products' orders completed in the period beside them. At most
  `REPORT_ENTITY_ROWS_MAX` rows, by sales; `byProductTruncated` says when cut.
- **Reseller sales** — the part of sales with an `order_reseller_terms` row: what resellers
  were charged. Margin and cost are never selected.

Money is `bigint` minor units with its currency everywhere; currencies are columns side by
side on the page and are never summed together.

## 6. Export

`GET /reports/export?report=FINANCIAL&format=csv|xlsx&granularity=…` — the existing writers,
headers and file naming (`nexa-financial-<range>.csv`). One row per begun bucket and
currency, exactly the cells of the page's bucket table, with **no total row**: a spreadsheet
column sum is the period total, and a total row inside the data would be summed into it. The
integration suite holds every money column's sum to the displayed totals, for the same range
and granularity. `granularity` on any other export is a 400.

## 7. Tests

- `tests/integration/financial-reports.test.ts` — three Tehran days seeded with every
  double-counting shape in §3, bucket edges (a row on the first instant, on a midnight, at
  the end instant), a refund in a later period, multi-currency, tenant isolation, owner-only,
  the wallet identity against an independent balance, channel/route/product sums, and export
  = display. Mutation-checked: dropping `method <> 'WALLET'`, dropping REFUNDED from sales,
  reading `amount` for customer-paid, bucketing refunds off `completed_at`, dropping the tenant
  predicate, filing a wallet REFUND as a top-up, not netting reversals, not netting refunds,
  and ignoring the opening balance each fail it.
- `tests/unit/financial-statement.test.ts` — the filing rules, pure. Filing TRANSFER as
  spending survives the integration suite (the pair nets to zero inside one bucket, so the
  mutation changes no figure there) and fails the unit case that files one half alone.
- `tests/web/financial-report.test.tsx` — the tab, the granularity in the URL and in the export
  link, the export gate, unbegun buckets, and the two honest absences.

## 8. Limitations and manual acceptance

- Provider fees and costs are not recorded; the page says so rather than estimating.
- A wallet balance that went negative before reseller credit was removed is a legacy debt and
  is included in the liability as it is (`docs/reseller-phase3-closure.md`).
- Manual: open `/reports?tab=finance` as the owner on a real installation at 390px and on a
  desktop, switch day/week/month, export CSV and XLSX and confirm the Persian headers and
  that the column sums equal the page.
