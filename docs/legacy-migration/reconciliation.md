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
POSITIVE balance becomes exactly one `MIGRATION_OPENING_BALANCE` `CREDIT`, additive onto
whatever the customer already held. A NEGATIVE balance is **not** a ledger entry (owner
decision 6, 2026-10-07): it is one legacy debt in `legacy_wallet_debts`, held for the
owner's review and never collected (`docs/migration-opening-balance.md` §Negative balances).
Before that decision a negative balance was a `DEBIT`; the equations below are the ones
after it.

The program's equation:

```
Σ(pre-import NEXA balances) + Σ(POSITIVE legacy Balance of imported users) = Σ(post-import NEXA balances)
Σ(|NEGATIVE legacy Balance| of imported users) = Σ(legacy_wallet_debts.amount_minor)
```

in snapshot terms:

- **W1** `PRE[wallet_signed_total_minor] + legacy_imported_balance_sum = POST[wallet_signed_total_minor]`
  — exact; `legacy_imported_balance_sum` is over POSITIVE balances only (a negative one
  moves no wallet).
- **W2** `delta(wallet_signed_total_minor) = delta(opening_signed_total_minor)` — nothing but
  openings moved the wallet during the import window.
- **W3** `delta(wallet_entries_total) = delta(opening_entries_total)`.
- **W4** `delta(opening_entries_total) = legacy_imported_nonzero_users` — one opening per
  imported user with a POSITIVE balance (the metric keeps its name; it counts `Balance > 0`):
  none missing, none extra.
- **W9** `POST[opening_debit_entries] = 0` — no ledger DEBIT opening exists (rehearsal
  check `no_debit_openings`).
- **W10** `delta(legacy_debts_total) = legacy imported_negative_users` and
  `delta(legacy_debts_sum_minor) = imported_negative_magnitude` — one debt per imported user
  with a negative balance, of exactly its magnitude (`legacy_debts_one_per_negative_user`,
  `legacy_debts_equal_negative_magnitude`).
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

`legacy_imported_balance_sum` is `Σ user.Balance > 0` over exactly the users the NEXA map
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
   WHERE CAST(u.Balance AS DECIMAL(24,4)) > 0
  UNION ALL
  SELECT 'imported_nonzero_users', CAST(COUNT(*) AS CHAR)
    FROM <restored-schema>.user u JOIN nexa_reconcile.imported i ON i.legacy_id = CAST(u.id AS CHAR)
   WHERE CAST(u.Balance AS DECIMAL(24,4)) > 0
  UNION ALL
  SELECT 'imported_negative_users', CAST(COUNT(*) AS CHAR)
    FROM <restored-schema>.user u JOIN nexa_reconcile.imported i ON i.legacy_id = CAST(u.id AS CHAR)
   WHERE CAST(u.Balance AS DECIMAL(24,4)) < 0
  UNION ALL
  SELECT 'imported_negative_magnitude', CAST(COALESCE(-SUM(CAST(u.Balance AS DECIMAL(24,4))), 0) AS CHAR)
    FROM <restored-schema>.user u JOIN nexa_reconcile.imported i ON i.legacy_id = CAST(u.id AS CHAR)
   WHERE CAST(u.Balance AS DECIMAL(24,4)) < 0"
mariadb -e "DROP DATABASE nexa_reconcile"
```

With the cutover's throwaway container (cutover step 9), every bare `mariadb` above is
`legacy_root` from cutover step 9 (`MYSQL_PWD` set for one `sudo --preserve-env=MYSQL_PWD
docker exec -e MYSQL_PWD …` and passed by name — never a password on a command line), and
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

| Program category (§16) | P7 category                                                                  | On the map                                                              |
| ---------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| adopted                | `ADOPTION_ELIGIBLE`, P6 `ADOPTED` / `ALREADY_ADOPTED`                        | `IMPORTED` (entity `SERVICE`); `delta(adopted_services)` equals it      |
| already mapped         | — (P7 reports 0; a rerun's unchanged rows stay in their category)            | `IMPORTED`, unchanged                                                   |
| test skipped           | `TEST_INVOICE_SKIPPED`, `TEST_PANEL_SKIPPED`, P6 `SKIPPED`                   | `SKIPPED`                                                               |
| provider missing       | `PROVIDER_MISSING`                                                           | `MANUAL_REVIEW:PROVIDER_MISSING`                                        |
| ambiguous              | `AMBIGUOUS_PANEL`, `USERNAME_CASE_COLLISION`, `AMBIGUOUS_OWNERSHIP` (PR5)    | `MANUAL_REVIEW:<same>`; ownership: `CONFLICTING_EXISTING_ENTITY`        |
| missing mapping        | `PANEL_UNMAPPED`, `NO_PANEL` (PR5, owner decision 8)                         | `MANUAL_REVIEW:PANEL_UNMAPPED`                                          |
| product unresolved     | `PRODUCT_UNRESOLVED` (a `code_product` not in the products map)              | `MANUAL_REVIEW:PRODUCT_MAPPING_UNRESOLVED`                              |
| unsupported            | `UNSUPPORTED_SHAPE`, `INVALID_USERNAME`, `INVALID_SOURCE_ROW`                | `MANUAL_REVIEW:<closed reason>`                                         |
| manual review (other)  | `ORPHAN`, `CUSTOMER_NOT_IMPORTED`, P6 `MANUAL_REVIEW`, `INVOICE_KEY_INVALID` | `MANUAL_REVIEW:<closed reason>`; key-invalid rows can never be recorded |
| failed                 | `INVENTORY_INCOMPLETE`, P6 `FAILED` (`PROVIDER_READ_FAILED`)                 | `FAILED` where recorded                                                 |

A row a person closed in the review queue is `REVIEW_CLOSED` to the importer: counted,
never retried, never overwritten. `ADOPTION_PENDING_P6` (eligible, no map row) appears only
from an importer built without P6.

So **S1 holds as `live_invoices_total = Σ map:invoice:* + live_invoices_key_unmappable`**:
every candidate has one map row except those whose key the map's CHECK cannot hold
(OQ-P4-01), which P7 counts as `INVOICE_KEY_INVALID` and only the owner can decide. The
rehearsal harness checks that equation exactly (`service_closure_map_plus_invalid_keys`),
records any key-invalid population as PENDING, and checks P7's `S3` closure and
`services.candidates = live_invoices_total`.

- **S4** `legacy live_real_orphan` ⊆ the orphan / customer-missing manual-review reason —
  an invoice with no owning user can never be adopted.
- **S5** `delta(adoption_orders) = delta(adopted_services) = services.adopted = ADOPTION_ELIGIBLE`
  (from the dry-run) — every eligible candidate adopted, one order per adopted service,
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
  **Machine check (WP-D4):** the rehearsal walks every `productionPanels` panel through the
  importer's own read-only inventory port before the audit and after the resume
  (`tests/support/legacy-rehearsal-panel-state.ts`) and records `panel_state_unchanged`:
  per panel, the account count and a hash over every account's admin-controlled facts —
  lower(username), data limit, expiry, sha256 of the subscription link — must be equal;
  added / removed / changed accounts are counted on failure. State and used bytes move on
  a live panel by themselves, so they are hashed separately and never compared. Nothing
  under `--out` names an account: per-account digests are HMACs under a per-run key that
  is deleted on exit. **Not detected:** a `sub_updated_at` bump that leaves the link
  unchanged (the read-only inventory does not expose the field), and on staging any write
  MirzaBot itself makes during the window — run it frozen (cutover step 7), or read the
  counts. Also `panel_state_walk_reads_only`: the walk's guard refused no write.

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

## 6. Users and wallets — the `usersWallets` section (Mirza PR4)

`legacy-import reconcile` prints it in its JSON `sections.usersWallets` (and as a check,
`users_wallets.section`); `legacy-import report` renders it after the v1 final report in
markdown only, because `final-report.schema.json` v1 is closed. **PR6 folds this section,
unchanged, into the final report's schema version 2.** Built by
`apps/api/src/modules/platform/legacy-importer/application/users-wallets-reconciliation.ts`
from the plan, the `user` map rows, the openings and the debts. Counts, sums and opaque map
refs only — never a Telegram id, a username or one person's amount.

Shape (`LEGACY_USERS_WALLETS_SECTION_VERSION` = `nexa-legacy-users-wallets/v1`):

```jsonc
{
  "version": "nexa-legacy-users-wallets/v1",
  "sourceFingerprint": "<v1 fingerprint of the snapshot reconciled>",
  "users": {
    "sourceRows": 0,
    // one key per LEGACY_USER_OUTCOMES, all present: IMPORTED_NEW, IMPORTED_EXISTING,
    // SKIPPED_INVALID_IDENTITY, SKIPPED_BALANCE_UNREADABLE, SKIPPED_BALANCE_OUT_OF_RANGE,
    // SKIPPED_DUPLICATE_SOURCE_ID, SKIPPED_REVIEW_CLOSED, SOURCE_CHANGED, NOT_YET_IMPORTED
    "outcomes": { "IMPORTED_NEW": 0 },
    "agents": { "sourceRows": 0, "importedAsCustomers": 0, "resellerGrants": "NONE" },
  },
  "wallet": {
    "currency": "IRT",
    "positive": { "users": 0, "sumMinor": "0", "openingEntries": 0, "openingSumMinor": "0" },
    "zero": { "users": 0 },
    "legacyDebts": {
      "users": 0,
      "sumMinor": "0", // negative balances imported from THIS snapshot
      "recorded": 0,
      "recordedSumMinor": "0", // every debt of the tenant
      "byState": { "PENDING_REVIEW": { "count": 0, "sumMinor": "0" } },
      "synthetic": 0,
    },
    "ledgerDebitOpenings": 0,
    "perUser": {
      "matching": 0,
      "missingOpening": 0,
      "missingDebt": 0,
      "priorDebitOpening": 0,
      "conflicting": 0,
    },
    "carried": {
      // recorded from an earlier snapshot, never re-applied
      "changedOpenings": { "count": 0, "sumMinor": "0" },
      "changedDebts": { "count": 0, "sumMinor": "0" },
      "absentOpenings": { "count": 0, "sumMinor": "0" },
      "absentDebts": { "count": 0, "sumMinor": "0" },
    },
  },
  "sourceChanged": {
    "users": 0,
    // one key per LEGACY_BALANCE_CHANGE_CLASSES: PROFILE_ONLY, POSITIVE_CHANGED,
    // NEGATIVE_CHANGED, POSITIVE_TO_NEGATIVE, NEGATIVE_TO_POSITIVE, TO_ZERO, FROM_ZERO,
    // UNREADABLE_NOW — each { count, recordedSumMinor, sourceSumMinor, differenceMinor }
    "byClass": {},
    // the sign flips, for the owner: sorted legacy_import_map.ref uuids, never an id
    "ownerReview": { "POSITIVE_TO_NEGATIVE": [], "NEGATIVE_TO_POSITIVE": [] },
  },
  "checks": [{ "id": "U1", "what": "…", "holds": true, "expected": "…", "actual": "…" }],
  "holds": true,
}
```

The checks:

- **U1** every source user row is in exactly one outcome (Σ outcomes = source rows).
- **U2/U3** Σ and count of openings = the positive balances imported from this snapshot +
  the openings carried by SOURCE_CHANGED users and by users this snapshot no longer has.
- **U4/U5** the same for legacy debts against the negative balances.
- **U6** no ledger DEBIT opening (owner decision 6).
- **U7** per imported user, NEXA holds exactly the source figure (a CREDIT, a debt, or
  nothing for zero); a missing opening, a missing debt, a prior DEBIT or any other value
  fails it.
- **U8** no debt recorded from a synthetic source, unless the snapshot reconciled is
  synthetic (PR3's review lesson on recorded state).

**A newer snapshot (owner constraint 4).** A user whose row changed since the snapshot NEXA
imported from is `SOURCE_CHANGED`: the customers phase skips it, so no second opening, no
second debt and no adjustment is ever written (in the plan a changed figure is a
`CONFLICT`). The section classes each such user by how the balance moved and sums the
recorded figure, the source figure and the difference. The two sign flips are listed by
opaque map ref for the owner; resolving a ref to a person is a terminal-only step on the
target (`SELECT legacy_id FROM legacy_import_map WHERE ref = '<ref>'`, never pasted into a
ticket). Applying a changed balance would need a new ledger reason and an owner instruction
(`OQ-LWD-02`). The top-level reconcile checks (`wallet.*`) still compare the NEW snapshot's
balances with the ledger and so report `DISCREPANCY` on a changed snapshot — honestly; the
section is what explains the difference, to the Toman.

## 7. Service outcomes — the `serviceOutcomes` section (Mirza PR5)

Every live invoice has exactly ONE outcome per APPLY run on `legacy_service_candidates`
([`service-review.md`](service-review.md)). `reconcile` prints the section
`nexa-legacy-service-outcomes/v1` and checks it; `report` prints it beside the closed v1
document. It reads the candidate rows of the snapshot's live invoices and asserts only what
it read. Aggregates only — never an invoice key, a username or a Telegram id.

- **O1** (`services.outcomes.closure`, a reconcile check — `DISCREPANCY` when it fails):
  `candidates = recorded`, `Σ outcomes = candidates`, every row decided by the latest APPLY
  run (`decidedByAnotherRun = 0`) from this source (`fromAnotherSource = 0`) and this row
  (`checksumDiffers = 0`), and no key the table cannot hold (`unrecordable = 0`).
- **O2** `adopted = outcomes.ADOPTED + outcomes.ALREADY_ADOPTED` = the adopted services the
  map names (S5).
- **O3** `archivedHistory.notAdopted = candidates − adopted`; `notLinkedToArchive = 0` when
  `invoices-read` ran before the import (every invoice not adopted is archived history).
- **O4** `outcomes.NO_PANEL` invoices are never services unless their review state is
  `ADOPTED` through an explicit approval (owner decision 8); the count is a dated baseline,
  never an expected value.

## 8. The final report v2 — seven invariants over every section (Mirza PR6)

`legacy-import report --format json` prints schema version 2
([`final-report-v2.schema.json`](final-report-v2.schema.json)): the v1 document unchanged as
`core`, and the sections of PR1–PR6 — `inventory`, `products`, `invoiceArchive`,
`usersWallets`, `serviceOutcomes`, `cutover`, `applyRun` — each with its version. Its verdict
is the AND of every section and of these invariants, each an AND of checks the sections
already carry:

| invariant              | holds when                                                                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `USERS_ACCOUNTED`      | v1 C1 and PR4 U1: every source user row is in exactly one outcome                                                                                                                           |
| `INVOICES_ACCOUNTED`   | A1 the latest COMPLETED archive run of this source read exactly the snapshot's invoice rows; A2 promoted = source rows; A3 archived = source rows + no longer in snapshot                   |
| `PRODUCTS_ACCOUNTED`   | PR1 a products read set recorded for this source; PR2 every distinct source code has a present review row; PR3 no present row names a code the source lacks                                 |
| `WALLETS_RECONCILED`   | v1 W1, W4, W5 and PR4 U2–U8 — debts (count, Σ), conflicts and source-changed users are REPORTED in its evidence, never netted                                                               |
| `SERVICES_ONE_OUTCOME` | PR5's closure and v1 S3                                                                                                                                                                     |
| `UNRESOLVED_RETAINED`  | A5 nothing archived was removed; every unadopted candidate linked to its archive revision; one debt recorded per negative user                                                              |
| `RERUN_NO_DUPLICATES`  | at most one opening, one debt per customer; one customer per Telegram id; one invoice per adopted service; adoption orders = mapped services; no archive revision repeats the one before it |

The `applyRun` section holds only when the run's leftovers were RECORDED with its finish
(PR5's `withdrawnDuringRun`, `unconfirmed` and every attention count) and no adoption is
ADOPTION_UNCONFIRMED; `cutover` holds only when no earlier source is superseded
unacknowledged. `tests/unit/legacy-final-report-v2.test.ts` flips the verdict through every
invariant and every section, one fact at a time.

## Result table (filled per run; aggregates only)

**Generated, not transcribed (WP-D5).** `scripts/legacy-rehearsal-reconciliation.mjs`
turns a rehearsal's `summary.json` into this table — each equation with the harness checks
that evidence it and a state: `HOLDS` (every mapped check PASSED in every cycle), `FAILS`
(naming the failed checks), `PENDING` (an owner decision, never a pass) or `MISSING` (a
mapped check was never recorded). The harness writes it to `--out/reconciliation.md` at the
end of every run; paste the staging run's states here as their own commit. R3 and P4 also
carry a manual half, marked NOT RUN until a person has done it. Since WP-D5 every equation
has a machine check: C2 `customers_created_le_imported`; W8
`fractional_balances_never_imported` (a fractional balance is held for review, never
rounded) plus `legacy_balance_{fractional,null}_users` (PENDING when non-zero: the owner
decides the population); R3 `revenue_view_standard_unchanged`,
`revenue_view_adoption_zero`, `wallet_window_openings_only`; S2 is recorded as a PASS when
zero; S4 `orphans_in_customer_missing` (exact: the legacy orphans are compared invoice by
invoice with the CUSTOMER_MISSING review rows, in the throwaway engine's scratch schema);
§5's `delta(trial_grants) = 0` as `no_trial_grants`.

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
| W9       |                   |            |       |
| W10      |                   |            |       |
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
