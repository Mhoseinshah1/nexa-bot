# Legacy migration — final reconciliation (Item 12)

**Status: procedure and queries written; NOT RUN on real data.** No legacy archive, no
RickPanel credentials and no staging server exist in the environment this was written in.
Every figure this page asks for is produced by a person running it on the staging
rehearsal (Item 11) and again on production after the import (Item 14). A run of the
rehearsal harness on the SYNTHETIC fixture checks these queries and the importer's code; it
is never a reconciliation result.

The reconciliation is a set of **equations between snapshots**, never a figure read on its
own. Three sources:

| Source                              | How it is read                                                                       | File                                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Legacy (MirzaBot `user`, `invoice`) | the restored final dump, `oldbot_ro`, `START TRANSACTION READ ONLY`, aggregates only | [`scripts/legacy-rehearsal-source.sql`](../../scripts/legacy-rehearsal-source.sql) |
| NEXA (destination truth)            | one `REPEATABLE READ READ ONLY` snapshot, tenant-scoped, aggregates only             | [`scripts/legacy-rehearsal-checks.sql`](../../scripts/legacy-rehearsal-checks.sql) |
| RickPanel (runtime truth)           | P7 `reconcile` through the read-only inventory (#169); never a write                 | P7 output                                                                          |

The NEXA snapshot is taken **three times**: `PRE` (after the pre-import backup, before
`import`), `POST` (after `reconcile`), and — only if a rollback happens — `RESTORED`.
`scripts/legacy-rehearsal.sh` takes them automatically and evaluates every equation below
as a recorded PASS/FAIL; on production the operator takes them with the commands in the
cutover runbook and fills the table at the end of this page.

## How to run the two snapshots

NEXA, in a deployed installation (the SQL file is read on stdin from the operator's
checkout of the APPROVED release's commit):

```bash
DC="docker compose --env-file /etc/nexa/deploy.env -f /opt/nexa/deploy/compose.yml"
sudo $DC exec -T postgres psql -U nexa -d nexa -X -q -At -F "$(printf '\t')" \
  -v tenant="$NEXA_TENANT" -f - < scripts/legacy-rehearsal-checks.sql > nexa-PRE.tsv
```

Legacy, against the restored final dump (never the live MirzaBot server):

```bash
mariadb --user=oldbot_ro --password --host=<restored-source-host> --database=<restored-schema> \
        --batch --skip-column-names --safe-updates < scripts/legacy-rehearsal-source.sql > legacy.tsv
```

Both files are `metric<TAB>value`, aggregates only, and safe to attach to the migration
report. Neither selects an id, username, phone, link or credential; do not add one.

`delta(k)` below means `POST[k] − PRE[k]`.

## 1. Customer-category closure

Every legacy user has **exactly one** decision, and the categories explain the legacy
total. The decision is the `legacy_import_map` row for `legacy_table = 'user'` (P4).

| Category                       | NEXA figure                                              |
| ------------------------------ | -------------------------------------------------------- |
| new NEXA customer created      | `delta(customers_total)`                                 |
| existing NEXA customer matched | `Σ map:user:IMPORTED:*` − `delta(customers_total)`       |
| skipped                        | `Σ map:user:SKIPPED:*` (per reason code)                 |
| manual review                  | `Σ map:user:MANUAL_REVIEW:*` (per reason code)           |
| failed                         | `Σ map:user:FAILED:*` — must be **0** on a completed run |

Equations:

- **C1** `legacy users_id_valid = Σ map:user:*` (every user with a valid key decided once; the primary key
  `(tenant, legacy_table, legacy_id)` makes "more than once" impossible, so a shortfall is
  a user the import never reached).
- **C2** `delta(customers_total) ≤ Σ map:user:IMPORTED:*` (a customer is created only by an
  import decision).
- **C3** `legacy users_id_valid = users_total`. A user id outside `^[1-9][0-9]{0,19}$`
  cannot carry a map row at all (the map's key CHECK refuses it). P7 counts those rows as
  `customers.blocked` and its own C1 includes them; C1 over the MAP is therefore
  `users_id_valid = Σ map:user:*`. A non-zero `blocked` is a population the owner must decide,
  never a row widened into the map.

The existing-customer split is derived from deltas, not from the `EXISTING_CUSTOMER`
reason code, because an `IMPORTED` row carries at most one warning and a matched customer
with a negative balance may carry `NEGATIVE_BALANCE` instead.

Single-record check (one at a time, locally, never pasted): pick one legacy user from
each category by aggregate selector — see `manual-acceptance.md` — and confirm the map row,
the customer row and the opening agree.

## 2. Wallet equation

The legacy wallet source is `user.Balance` and nothing else; `wallet_transaction` and the
payment history are **never replayed** (PROGRAM §2, §22). Each imported user with a
non-zero balance becomes exactly one `MIGRATION_OPENING_BALANCE` entry: `CREDIT` for a
positive balance, `DEBIT` of the magnitude for a negative one, additive onto whatever the
customer already held (`docs/migration-opening-balance.md`).

The program's equation:

```
Σ(pre-import NEXA balances) + Σ(legacy Balance of imported users) = Σ(post-import NEXA balances)
```

in snapshot terms:

- **W1** `PRE[wallet_signed_total_minor] + legacy_imported_balance_sum = POST[wallet_signed_total_minor]`
  — exact, negatives included (a negative legacy balance lowers the total).
- **W2** `delta(wallet_signed_total_minor) = delta(opening_signed_total_minor)` — nothing but
  openings moved the wallet during the import window.
- **W3** `delta(wallet_entries_total) = delta(opening_entries_total)`.
- **W4** `delta(opening_entries_total) = legacy_imported_nonzero_users` — one opening per
  imported user with a non-zero balance: none missing, none extra.
- **W5** `POST[opening_customers_with_duplicates] = 0` — **no duplicate openings** (the
  partial unique index `wallet_entries_migration_opening_customer_key` forbids it; this
  proves it held).
- **W6** `POST[opening_reference_mismatch] = 0` — every opening's reference is
  `legacy:opening:<that customer's telegram_user_id>`.
- **W7** `POST[opening_linked_to_money] = 0` — no opening names an order, payment, reversal
  or admin.
- **W8** `legacy balance_fractional_users = 0` and `balance_null_users` explained — IRT has
  zero minor digits; a fractional Toman balance is a decision the importer must have
  surfaced (manual review), never a rounding.

`legacy_imported_balance_sum` is `Σ user.Balance` over exactly the users the NEXA map
records as `IMPORTED`. The legacy schema is read-only, so the set of imported ids is
carried into a **separate scratch schema on the restored source instance** — never the
live server, never a temporary table in the legacy schema — through a pipe, without
touching disk:

```bash
# On the host that runs the restored source (the throwaway copy), as its root account.
mariadb -e "CREATE DATABASE nexa_reconcile;
            CREATE TABLE nexa_reconcile.imported (legacy_id VARCHAR(20) PRIMARY KEY)"
sudo $DC exec -T postgres psql -U nexa -d nexa -X -q -At -c "
  SELECT m.legacy_id FROM legacy_import_map m JOIN tenants t ON t.id = m.tenant_id
   WHERE t.slug = '$NEXA_TENANT' AND m.legacy_table = 'user' AND m.status = 'IMPORTED'" |
  awk 'BEGIN { print "INSERT INTO nexa_reconcile.imported VALUES (\"0\")" }
       NF { printf ",(\"%s\")", $1 } END { print ";" }' | mariadb
mariadb -N -B -e "
  SELECT 'imported_balance_sum', CAST(COALESCE(SUM(CAST(u.Balance AS DECIMAL(24,4))), 0) AS CHAR)
    FROM <restored-schema>.user u JOIN nexa_reconcile.imported i ON i.legacy_id = CAST(u.id AS CHAR)
  UNION ALL
  SELECT 'imported_nonzero_users', CAST(COUNT(*) AS CHAR)
    FROM <restored-schema>.user u JOIN nexa_reconcile.imported i ON i.legacy_id = CAST(u.id AS CHAR)
   WHERE CAST(u.Balance AS DECIMAL(24,4)) <> 0"
mariadb -e "DROP DATABASE nexa_reconcile"
```

With the cutover's throwaway container (cutover step 9), every bare `mariadb` above is
`sudo docker exec -i -e MYSQL_PWD="$LEGACY_ROOT_PW" nexa-legacy-src mariadb -uroot`, and
`<restored-schema>` is `oldbot`.

(`"0"` is a sentinel that keeps the statement valid when nothing was imported; it never
matches, because a legacy user id is `^[1-9][0-9]*$`.) The rehearsal harness runs exactly
this as its `legacy-imported-balance` stage.

And the closure of the legacy total: `legacy balance_sum = legacy_imported_balance_sum +
Σ Balance of the users NOT imported`. When every user is imported the two sums are equal and
W1 is the program's equation verbatim. When some are skipped or in manual review, their
balance is **not** in NEXA yet — it is reported as such (final report §wallet), and it
enters NEXA only when the review is resolved and that user's opening is posted.

**Residual traffic.** W2 and W3 assume no other wallet movement in the import window — the
cutover's maintenance window (stop-sales incident on every gateway and panel) is what makes
that true. If they fail, list what moved, by reason, and subtract it explicitly; never
absorb it:

```sql
-- psql -v tenant=<slug> -v since='<PRE snapshot time, UTC>'
SELECT w.reason, w.direction, count(*) AS entries, SUM(w.amount) AS amount_minor
FROM wallet_entries w JOIN tenants t ON t.id = w.tenant_id
WHERE t.slug = :'tenant' AND w.created_at >= :'since'::timestamptz
GROUP BY 1, 2 ORDER BY 1, 2;
```

### Opening is not revenue — the report exclusion

An opening is its own ledger reason (`MIGRATION_OPENING_BALANCE`) in its own report group
(`WALLET_REPORT_GROUP_OF.MIGRATION_OPENING_BALANCE = 'OPENING_BALANCE'`,
`packages/contracts/src/reporting.ts`). Sales and revenue are read from `orders` and
`payments`, never from the ledger, and only for `SALE_ORDER_ORIGINS = ['STANDARD']`; an
adoption order is `origin = 'LEGACY_ADOPTION'` with zero totals by CHECK
(`docs/migration-order-origin.md`). So:

- **R1** these are **identical** in `PRE` and `POST`: `sale_orders_paid`,
  `sale_orders_paid_total_minor`, `payments_total`, `wallet_topup_signed_total_minor`. An
  import creates no sale, no payment and no top-up.
- **R2** `POST[adoption_orders_nonzero_total] = 0`.
- **R3** the reports themselves exclude both. Run the same window through the revenue view
  the reports use and through the wallet grouping, and compare:

```sql
-- Revenue as the reports compute it: sale origins only. Must equal the PRE figure.
SELECT o.origin, count(*) AS orders, SUM(o.total_amount) AS total_minor
FROM orders o JOIN tenants t ON t.id = o.tenant_id
WHERE t.slug = :'tenant' AND o.state = 'PAID'
GROUP BY o.origin ORDER BY o.origin;
-- Expected: STANDARD unchanged by the import; LEGACY_ADOPTION present with total_minor = 0.

-- The wallet by report group: openings appear ONLY under OPENING_BALANCE.
SELECT CASE WHEN w.reason = 'MIGRATION_OPENING_BALANCE' THEN 'OPENING_BALANCE'
            WHEN w.reason LIKE 'TOPUP_%' THEN 'TOPUP' ELSE 'OTHER' END AS report_group,
       count(*) AS entries,
       SUM(CASE WHEN w.direction = 'CREDIT' THEN w.amount ELSE -w.amount END) AS signed_minor
FROM wallet_entries w JOIN tenants t ON t.id = w.tenant_id
WHERE t.slug = :'tenant' AND w.created_at >= :'since'::timestamptz
GROUP BY 1 ORDER BY 1;
-- Expected in the import window: OPENING_BALANCE only; TOPUP and OTHER absent.
```

Then open the Web Admin financial report for the import day and confirm by eye that sales
and revenue did not move and that the wallet section shows the openings under
«موجودی افتتاحیه (انتقال از ربات قبلی)». That is the manual half of R3.

## 3. Service-candidate closure

A service candidate is a legacy invoice in a **live** status (`active`, `disabled`,
`disabledn`, `disablebyadmin`, `end_of_volume` — the set every query in
`sql-evidence.md` uses), test or real. Each has exactly one decision: the
`legacy_import_map` row for `legacy_table = 'invoice'`, keyed by `id_invoice` (OQ-P4-01,
shape `^([1-9][0-9]{6})?([0-9a-f]{4}|[0-9a-f]{8})$`, MAP-REVIEW's contract change).

- **S1** `legacy live_invoices_total = Σ map:invoice:*`.
- **S2** `legacy live_invoices_key_unmappable = 0`. A live invoice whose key falls outside
  the evidenced shape cannot carry a map row, so S1 cannot close; the remedy is a forward
  migration decided from the archive's aggregate, never a widened guess.
- **S3** the categories. P7 decides each candidate into exactly one category
  (`importer.md` §5) and its report folds them into the program's (`final-report.ts`); P7's
  own `S3` equation is that closure:

| Program category (§16) | P7 category                                                                                                  | On the map                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| adopted                | `ADOPTION_ELIGIBLE`, adopted by P6                                                                           | `IMPORTED` (entity `SERVICE`); `delta(adopted_services)` equals it |
| already mapped         | — (P7 reports 0; a rerun's unchanged rows stay in their category)                                            | `IMPORTED`, unchanged                                              |
| test skipped           | `TEST_INVOICE_SKIPPED`, `TEST_PANEL_SKIPPED`                                                                 | `SKIPPED`                                                          |
| provider missing       | `PROVIDER_MISSING`                                                                                           | `MANUAL_REVIEW:PROVIDER_MISSING`                                   |
| ambiguous              | `AMBIGUOUS_PANEL`, `USERNAME_CASE_COLLISION`                                                                 | `MANUAL_REVIEW:<same>`                                             |
| missing mapping        | `PANEL_UNMAPPED`                                                                                             | `MANUAL_REVIEW:PANEL_UNMAPPED`                                     |
| product unresolved     | `PRODUCT_UNRESOLVED`                                                                                         | counted; recorded once MAP-REVIEW's code is on main                |
| unsupported            | `UNSUPPORTED_SHAPE`, `INVALID_USERNAME`, `INVALID_SOURCE_ROW`                                                | partly counted only, as above                                      |
| manual review (other)  | `ORPHAN`, `CUSTOMER_NOT_IMPORTED`, `INVOICE_KEY_INVALID`, and `ADOPTION_PENDING_P6` (eligible, P6 not wired) | key-invalid rows can never be recorded; pending ones wait for P6   |
| failed                 | `INVENTORY_INCOMPLETE` (nothing decided)                                                                     | none                                                               |

So **S1 is not yet an equation over map rows**: until P6 adopts and MAP-REVIEW's codes reach
main, `Σ map:invoice:*` is below the candidate count by exactly the counted-not-recorded
categories. The rehearsal harness records that gap as PENDING (`service_map_rows`), never as
a pass, and checks P7's `S3` closure and `services.candidates = live_invoices_total` exactly.

- **S4** `legacy live_real_orphan` ⊆ the orphan / customer-missing manual-review reason —
  an invoice with no owning user can never be adopted.
- **S5** `delta(adoption_orders) = delta(adopted_services)` — one order per adopted service,
  and `POST[adopted_services_state:*]` reflects RickPanel's runtime state, not the invoice's
  status snapshot.

## 4. Provider writes = 0

RickPanel is read-only in every migration path; adoption is not provisioning. NEXA reaches
a provider for a write only through a `provisioning_operations` row, so:

- **P1** `delta(provisioning_operations_total) = 0` over the import window.
- **P2** `POST[adopted_services_with_provisioning_operation] = 0`.
- **P3** P7's report states `provider.writes = 0` and `provider.reads > 0`
  ([`final-report.schema.json`](final-report.schema.json)); P7 holds only the read-only
  inventory surface (#169), whose three fixed requests are `GET`s and the token exchange.
- **P4** On RickPanel itself (read-only, aggregate): the account count per panel before
  and after the import window agrees within the drift a live panel allows, and no account's
  expiry, limit or status changed because of NEXA. P7 `reconcile` reports the per-panel
  comparison; spot-check two adopted accounts by hand in the panel UI.

Also: `delta(customer_notifications) = 0` — the import sends no customer message;
reminder thresholds already passed are **seeded**, not sent (Item 8,
`ServiceReminderService.seedPassedThresholds`). After the first reminder sweep following
the import, the count of reminder notifications must look like an ordinary day's, not a
burst (cutover runbook, observation step).

## 5. Products and trials (closure, not equations)

- `delta(legacy_product_shapes)` = the `MAPPABLE` rows of Q1b that had no shape yet;
  `POST[legacy_product_shapes_unresolved]` = the shapes still blocking adoption
  (`NO_CURRENT_TARIFF` / `AMBIGUOUS_TARIFF` / `NOT_YET_RESOLVED`), each a manual-review item.
- `delta(hidden_products) = delta(legacy_product_shapes)` (one hidden product per new shape).
- `POST[legacy_trial_decision:*]` sums to `delta(legacy_trial_eligibility)` and its split
  matches Q2b (`sql-evidence.md`) less customers who already held an override
  (`KEPT_EXISTING_OVERRIDE`).
- `delta(trial_grants) = 0` — no migrated customer was given a trial by the import.

## Result table (filled per run; aggregates only)

| equation | staging rehearsal | production | notes |
| -------- | ----------------- | ---------- | ----- |
| C1       |                   |            |       |
| C2       |                   |            |       |
| C3       |                   |            |       |
| W1       |                   |            |       |
| W2       |                   |            |       |
| W3       |                   |            |       |
| W4       |                   |            |       |
| W5       |                   |            |       |
| W6       |                   |            |       |
| W7       |                   |            |       |
| W8       |                   |            |       |
| R1       |                   |            |       |
| R2       |                   |            |       |
| R3       |                   |            |       |
| S1       |                   |            |       |
| S2       |                   |            |       |
| S3       |                   |            |       |
| S4       |                   |            |       |
| S5       |                   |            |       |
| P1       |                   |            |       |
| P2       |                   |            |       |
| P3       |                   |            |       |
| P4       |                   |            |       |

"Exact" means exact: a reconciliation that is off by one customer or one Toman is a
failed reconciliation with a named cause, and the production gate does not open on it.
