# Legacy SQL evidence — the final seven queries (Item 13)

**Status: MANUAL ACCEPTANCE.** The legacy MySQL database `oldbot` is not available in
the environment this runbook was written in, so **no result below has been run**. Every
result table is empty on purpose. Nothing in this repository may cite a figure from this
page until a person has run the queries against the restored archive and filled the
tables in, in a commit of its own.

The figures quoted in the program document (7,369 active-real productless invoices,
the five frequent shapes, the `limit_usertest` distribution) are the **earlier** audit's.
They are the reason these queries exist, not their answer.

## What the evidence is for

| Query | Feeds                                                                             |
| ----- | --------------------------------------------------------------------------------- |
| Q1    | Item 14 — how many hidden legacy products a tenant will need, and which           |
| Q1b   | Item 14 — the actual distinct-shape table (the input to `ensureShape`)            |
| Q1c   | Item 14 — which `time_unit` / `Volume` spellings the canonical key must accept    |
| Q2    | Item 15 — the trial decision table, row by row                                    |
| Q3    | evidence only: is `user.affiliates` a user id (referral import is OUT of Phase 1) |
| Q4    | P6 prerequisite — the agent (reseller) population and its negative balances       |
| Q5    | P6 prerequisite — products scoped to agent groups                                 |
| Q6    | P5/P6 — live invoices with no panel: the missing-panel matching workload          |
| Q7    | P6 — live real invoices with no owning user (cannot be adopted)                   |

Do not start P6 from these results. They refine Items 14–15 and the P6 prerequisites
list; P6 and P7 remain HOLD.

## Safety rules for running them

The legacy database is **source data only** and is **read-only** for this program.

1. **Use a read-only MySQL account.** Created once, by whoever restored the archive:

   ```sql
   CREATE USER 'oldbot_ro'@'localhost' IDENTIFIED BY '<generated, not written down here>';
   GRANT SELECT ON oldbot.* TO 'oldbot_ro'@'localhost';
   FLUSH PRIVILEGES;
   ```

   `SELECT` only. No `INSERT`, `UPDATE`, `DELETE`, `CREATE`, `DROP`, `LOCK TABLES` or
   `CREATE TEMPORARY TABLES` — a temporary table is a write, and none of these queries
   need one.

2. **And a read-only transaction, as a second wall.** Every session starts with:

   ```sql
   SET SESSION TRANSACTION READ ONLY;
   START TRANSACTION READ ONLY;
   -- ... the queries ...
   ROLLBACK;
   ```

   A write inside a `READ ONLY` transaction fails with `ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION`
   even if the grant were wrong.

3. **Run from a file, capture aggregate output only:**

   ```bash
   mysql --user=oldbot_ro --password --database=oldbot \
         --batch --safe-updates --raw < sql-evidence.sql > sql-evidence.tsv
   ```

   `--safe-updates` refuses an `UPDATE`/`DELETE` without a key even before the grant
   would, which is a third wall for a typing mistake in an interactive session.

4. **What may leave the machine:** the result tables below — counts, grouped shapes and
   sums. **Never** a Telegram id, phone number, username, `secret_code`, config link,
   subscription URL, panel credential or card number. Every query below is an aggregate
   by construction; do not add an `id` or `username` column to "check" a row in the
   shared report. A single record may be inspected locally while debugging and is never
   pasted.

5. Record, alongside the results: the archive's file name and SHA-256, the MySQL
   version, the date run, and who ran it. Not the password.

## The seven queries, exactly as specified

They are reproduced verbatim from the program (§16). Notes after each say what to watch
for when reading the answer; they do not change the query.

### Q1 — Distinct missing-product shapes

```sql
SELECT
  is_custom,
  COUNT(*) n,
  COUNT(DISTINCT code_panel, Volume, Service_time, time_unit, price_product) shapes
FROM invoice
WHERE Status IN ('active','disabled','disabledn','disablebyadmin','end_of_volume')
  AND is_test = 0
  AND (code_product IS NULL OR code_product = '')
GROUP BY 1;
```

> **Reading note.** MySQL's multi-column `COUNT(DISTINCT a, b, …)` **skips every row in
> which any of the columns is NULL.** The earlier audit found a large `code_panel IS NULL`
> population (`NULL / 20GB / 30d` alone was 961 invoices), so `shapes` here undercounts
> them, and it counts `price_product` as part of a shape, which Item 14 deliberately
> does not. Q1b is the shape table Item 14 consumes; Q1 is kept for comparability with
> the earlier audit.

| is_custom | n   | shapes |
| --------- | --- | ------ |
|           |     |        |

### Q1b — The distinct-shape table for Hidden Legacy Products (supplementary)

Aggregate counts only. Grouped by the five tariff dimensions Item 14 keys on —
`code_panel, Volume, Service_time, time_unit, is_custom` — with `price_product` reported
as **historical evidence**, never as a grouping column: two invoices of one shape bought
at two prices are one hidden product (`docs/legacy-migration/hidden-legacy-products.md`).

```sql
SELECT
  is_custom,
  NULLIF(TRIM(code_panel), '')      AS code_panel,
  Volume,
  Service_time,
  NULLIF(TRIM(time_unit), '')       AS time_unit,
  COUNT(*)                          AS n,
  COUNT(DISTINCT price_product)     AS distinct_historical_prices,
  MIN(CAST(price_product AS SIGNED)) AS min_historical_price,
  MAX(CAST(price_product AS SIGNED)) AS max_historical_price
FROM invoice
WHERE Status IN ('active','disabled','disabledn','disablebyadmin','end_of_volume')
  AND is_test = 0
  AND (code_product IS NULL OR code_product = '')
GROUP BY 1, 2, 3, 4, 5
ORDER BY n DESC;
```

`GROUP BY` keeps NULLs as their own group, unlike Q1's `COUNT(DISTINCT …)`.
`code_panel` is a panel CODE (for example `bac6`), not a credential, and may be reported.

| is_custom | code_panel | Volume | Service_time | time_unit | n   | distinct_historical_prices | min_historical_price | max_historical_price |
| --------- | ---------- | ------ | ------------ | --------- | --- | -------------------------- | -------------------- | -------------------- |
|           |            |        |              |           |     |                            |                      |                      |

Sanity check to record with it: `SUM(n)` over Q1b must equal `SUM(n)` over Q1.

### Q1c — Unit and volume spellings (supplementary)

The canonical shape key (`legacyShapeKey`) accepts only spellings this evidence has
shown. It refuses anything else as `UNMAPPABLE` rather than guessing what an unknown
unit means — so this inventory is what decides whether the accepted set must grow.

```sql
SELECT NULLIF(TRIM(time_unit), '') AS time_unit, COUNT(*) AS n,
       MIN(CAST(Service_time AS SIGNED)) AS min_time, MAX(CAST(Service_time AS SIGNED)) AS max_time
FROM invoice
WHERE Status IN ('active','disabled','disabledn','disablebyadmin','end_of_volume')
  AND is_test = 0
  AND (code_product IS NULL OR code_product = '')
GROUP BY 1 ORDER BY n DESC;

SELECT (Volume REGEXP '^[0-9]+$') AS whole_gb, (CAST(Volume AS DECIMAL(20,4)) = 0) AS zero, COUNT(*) AS n
FROM invoice
WHERE Status IN ('active','disabled','disabledn','disablebyadmin','end_of_volume')
  AND is_test = 0
  AND (code_product IS NULL OR code_product = '')
GROUP BY 1, 2;
```

| time_unit | n   | min_time | max_time |
| --------- | --- | -------- | -------- |
|           |     |          |          |

| whole_gb | zero | n   |
| -------- | ---- | --- |
|          |      |     |

### Q2 — Trial eligibility × actual trial history

```sql
SELECT
  u.limit_usertest,
  (EXISTS (
    SELECT 1 FROM invoice i
    WHERE i.id_user = u.id AND i.is_test = 1
  )) had_trial,
  COUNT(*)
FROM user u
GROUP BY 1,2;
```

> **Reading note.** `had_trial` counts a test invoice in ANY status, including removed
> ones. That is the evidence Item 15 wants: a trial that was used and has since expired
> was still used. If the archive has an index on `invoice(id_user)` this runs in seconds;
> without one, expect a long scan on ~200k users and do not add an index (a write).

| limit_usertest | had_trial | COUNT(*) |
| -------------- | --------- | -------- |
|                |           |          |

### Q3 — Is `affiliates` a user ID?

```sql
SELECT
  (a.id IS NOT NULL) is_user_id,
  COUNT(*),
  COUNT(DISTINCT u.affiliates)
FROM user u
LEFT JOIN user a ON a.id = u.affiliates
GROUP BY 1;
```

Evidence only. Referral import remains out of Phase 1 (§19).

| is_user_id | COUNT(*) | COUNT(DISTINCT u.affiliates) |
| ---------- | -------- | ---------------------------- |
|            |          |                              |

### Q4 — Final agent distribution

```sql
SELECT
  agent,
  COUNT(*),
  SUM(CAST(Balance AS SIGNED) < 0) negatives,
  SUM(CAST(Balance AS SIGNED))
FROM user
GROUP BY 1;
```

> **Reading note.** `CAST(… AS SIGNED)` truncates a fractional balance toward zero. If
> the column holds decimals, a `-0.5` balance counts as non-negative here. Record
> whether `Balance` is an integer column (`SHOW COLUMNS FROM user LIKE 'Balance'`)
> alongside the result. NEXA has no reseller credit (`docs/reseller-phase3-closure.md`):
> a negative legacy balance is evidence for P2's opening-balance rule, not something
> to recreate.

| agent | COUNT(*) | negatives | SUM(Balance) |
| ----- | -------- | --------- | ------------ |
|       |          |           |              |

### Q5 — Product agent groups

```sql
SELECT agent, COUNT(*)
FROM product
GROUP BY 1;
```

| agent | COUNT(*) |
| ----- | -------- |
|       |          |

### Q6 — Missing-panel live split test/real

```sql
SELECT is_test, COUNT(*)
FROM invoice
WHERE Status IN ('active','disabled','disabledn','disablebyadmin','end_of_volume')
  AND (code_panel IS NULL OR code_panel = '')
GROUP BY 1;
```

| is_test | COUNT(*) |
| ------- | -------- |
|         |          |

### Q7 — Orphan real live users

```sql
SELECT COUNT(*)
FROM invoice i
LEFT JOIN user u ON u.id = i.id_user
WHERE i.Status IN ('active','disabled','disabledn','disablebyadmin','end_of_volume')
  AND i.is_test = 0
  AND u.id IS NULL;
```

| COUNT(*) |
| -------- |
|          |

## How each result feeds Items 14 and 15

### Item 14 — Hidden Legacy Products

- **Q1b is the input.** Each row becomes at most one `legacy_product_shapes` row per
  tenant, through `LegacyProductService.ensureShape`, keyed by
  `legacyShapeKey({ codePanel, volume, serviceTime, timeUnit, isCustom })`. Rows that
  differ only in `price_product` collapse into one shape — the reason Q1b reports prices
  as min/max/distinct rather than grouping on them.
- **Q1c decides the canonical key's accepted spellings.** Today the key accepts a NULL
  or empty unit and `day`/`days`/`d` (case-insensitive) as days, and a positive decimal
  GB figure. Any other unit, a zero volume and a zero duration come back `UNMAPPABLE`
  with a reason, and no hidden product is created for them. If Q1c shows, say,
  `month`, the owner decides what a month is (30 days? calendar?) and the accepted set
  grows in a reviewed commit — it is never inferred.
- **What to check after running:** the number of distinct Q1b rows is the number of
  hidden products per tenant; the `is_custom=1` rows are the custom services that must
  stay renewable; every shape whose `(Volume, Service_time)` has no current public NEXA
  product at the same traffic and duration will resolve `UNRESOLVED/NO_CURRENT_TARIFF`
  and block that service from P6 until an operator states a current tariff.

### Item 15 — Trial eligibility

The Q2 rows map onto `decideLegacyTrial` one-to-one:

| Q2 `limit_usertest`                    | Q2 `had_trial` | Decision                  | NEXA effect                                |
| -------------------------------------- | -------------- | ------------------------- | ------------------------------------------ |
| `0` (or negative)                      | any            | `LEGACY_NO_TRIALS`        | `trial_limit_overrides.trial_limit = 0`    |
| `≥ 1`                                  | `1`            | `LEGACY_TRIAL_CONSUMED`   | `trial_limit_overrides.trial_limit = 0`    |
| `≥ 1`                                  | `0`            | `INHERIT_NEXA_POLICY`     | no override; NEXA's current policy applies |
| NULL / unreadable                      | any            | `LEGACY_LIMIT_UNREADABLE` | `trial_limit_overrides.trial_limit = 0`    |
| (customer already has a NEXA override) | any            | `KEPT_EXISTING_OVERRIDE`  | untouched                                  |

**What to check after running:** the sum of the `0`-limit rows and the `had_trial=1`
rows is the number of overrides the import will write per tenant; any row whose
`limit_usertest` is not a non-negative integer (NULL, text) is counted as unreadable and
gets no trial. If Q2 shows a large `limit_usertest ≥ 1, had_trial = 0` population, that
population gets NEXA's current trial — the decision recorded in
`docs/legacy-migration/trial-eligibility.md` §3, which is the one row to re-read
against the evidence before P7.

## Filling this page in

1. Run the file above under the read-only account and transaction.
2. Paste the aggregate output into the tables — counts only.
3. Fill in the run record (archive SHA-256, MySQL version, date, who).
4. Commit the result as its own commit: `docs(legacy): record SQL evidence Q1–Q7`.
5. Re-read Item 14's and Item 15's docs against the numbers and record any decision
   the numbers change in `docs/open-questions.md`, not by editing code silently.

### Run record

| field               | value |
| ------------------- | ----- |
| archive file        |       |
| archive SHA-256     |       |
| MySQL version       |       |
| run at (UTC)        |       |
| run by              |       |
| read-only user used |       |
