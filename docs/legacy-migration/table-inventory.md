# Legacy table inventory (Mirza migration PR1)

**Status: TEMPLATE. NOT RUN against any real data.** The tables below are to be filled by
the operator from the real staging copy, in a docs-only commit. Nothing in this repository
has seen the real Mirza database. The synthetic fixture's inventory, shown at the end, is
NOT evidence.

The importer reads three tables (`user`, `invoice`, `product`), through the frozen v1 import
read set (`IMPORT_READ_SET_V1`, `importer.md` §3). The legacy database has more tables than
that. Before any later read set touches one of them (products, the invoice archive), each
table needs a reviewed class:

| class            | meaning                                                                                                                                                                       |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SUPPORTED`      | a NEXA read set reads rows of it, from a column allowlist, and decides from them                                                                                              |
| `ARCHIVE`        | kept as read-only history, from an explicit column allowlist; never a decision                                                                                                |
| `SECRETS_MANUAL` | holds, or may hold, a credential (panel password, bot token, card number, gateway key, subscription link). Never read beyond its name, column names and count; moved by hand. |
| `OWNER_DECISION` | its meaning or its fate is the owner's call (an open question); nothing reads it until the call is made                                                                       |
| `UNCLASSIFIED`   | the default. **Fails closed**: the inventory verdict cannot be `COMPLETE`, and no read set may read its rows                                                                  |

The classes live in `packages/contracts/src/legacy-inventory.ts` (`LEGACY_TABLE_CLASSES`,
`LEGACY_TABLE_CLASSIFICATION`). A table joins the catalogue in its own reviewed commit,
which must name the evidence. A row of this document is not enough on its own.

## How to take the inventory

1. From the dump, before anything is loaded, list the column names per table:

   ```bash
   node scripts/legacy-archive-inspect.mjs --archive backup_YYYY-MM-DD.zip \
     --password-env LEGACY_ZIP_PASSWORD --engine mysql8 --require-class staging --columns
   ```

   `dump.tableColumns` holds names only, in declaration order. It never holds a value.

2. On the restored, read-only copy (`importer.md` §10 step 1), take the inventory. It is
   bound to the approved v1 fingerprint that `audit` printed:

   ```bash
   node apps/api/dist/legacy-import.cli.js inventory --tenant <slug> \
     --source env:LEGACY_SOURCE_DSN --target <nexa db> \
     --expected-fingerprint <v1 fingerprint from audit> [--format json] > inventory.md
   ```

   The command prints, for every table, its name, class, type, storage engine, charset,
   collation, text-column charsets, column count, a hash of its sorted `name:data_type`
   lines, the exact `COUNT(*)` and its findings. It also prints the
   `legacy-read-set:inventory:v1` fingerprint, the v1 check and the freeze statement. It
   never prints a row value.

   Counting runs inside the session's consistent snapshot. `information_schema.TABLES.TABLE_ROWS`
   is never used, because InnoDB only estimates it.

   Exit codes:

   - 0: `COMPLETE`.
   - 3: `UNCLASSIFIED_TABLES`, `BLOCKED` (a view, or a name no statement can carry) or
     `FINGERPRINT_UNBOUND` (no `--expected-fingerprint`).
   - 65: the source is not the approved one. Nothing is counted or written.

   With a bound fingerprint the observation is recorded in `legacy_read_set_runs`. That is
   the only write.

3. Fill in the tables below. For every table that is not yet classified, open an entry
   under `OQ-MZ-INV` in `docs/open-questions.md`. Then propose its class in a commit to the
   catalogue that names the evidence.

Findings per table:

- `UNCLASSIFIED`: no reviewed class.
- `NOT_A_BASE_TABLE`: a view, which blocks.
- `TABLE_NAME_UNSUPPORTED`: the name is not a plain identifier, which blocks.
- `NOT_SNAPSHOT_CONSISTENT`: not InnoDB, so its rows are not under the snapshot. The freeze
  covers it.
- `NOT_UTF8MB4`: the table or a text column uses another charset. Decide this before any
  read set keeps text from it (trap: mojibake).

## Inventory of the staging copy — NOT RUN

| field                                      | value   |
| ------------------------------------------ | ------- |
| dump file, SHA-256                         | NOT RUN |
| engine and version of the restored copy    | NOT RUN |
| v1 source fingerprint (from `audit`)       | NOT RUN |
| `legacy-read-set:inventory:v1` fingerprint | NOT RUN |
| `legacy_read_set_runs` id                  | NOT RUN |
| verdict                                    | NOT RUN |
| taken by / at (UTC)                        | NOT RUN |

Counts are the staging snapshot's and are dated baselines. They are never expected values:
the cutover snapshot is newer.

| table   | class (catalogue) | proposed class                       | columns | columns hash (16) | rows (COUNT\*) | engine | charset / collation | findings | column names (from `--columns`) | open question |
| ------- | ----------------- | ------------------------------------ | ------- | ----------------- | -------------- | ------ | ------------------- | -------- | ------------------------------- | ------------- |
| user    | SUPPORTED         | SUPPORTED                            |         |                   |                |        |                     |          |                                 |               |
| invoice | SUPPORTED         | SUPPORTED (+ ARCHIVE allowlist, PR3) |         |                   |                |        |                     |          |                                 |               |
| product | SUPPORTED         | SUPPORTED                            |         |                   |                |        |                     |          |                                 | OQ-LPR-01     |
| …       | UNCLASSIFIED      |                                      |         |                   |                |        |                     |          |                                 | OQ-MZ-INV-…   |

## Freeze proof

The cutover's freeze proof (`cutover-runbook.md` steps 7 and 9) is
`scripts/legacy-freeze-checksum.sql`: one `CHECKSUM TABLE` over every base table, so it
covers every table of every read set, not only `user` and `invoice`. The inventory prints
the same statement. Record the table list here once it is filled:

| at                           | tables covered | output file / SHA-256 |
| ---------------------------- | -------------- | --------------------- |
| freeze (step 7, legacy host) | NOT RUN        | NOT RUN               |
| restored copy (step 9)       | NOT RUN        | NOT RUN               |

## The synthetic fixture (NOT evidence)

`tests/fixtures/legacy/synthetic-legacy.ts` carries five tables:

- `user`, `invoice` and `product`: SUPPORTED.
- `nexa_synthetic_fixture`: SUPPORTED, NEXA's marker.
- `nexa_synthetic_unclassified`: UNCLASSIFIED, deliberately.

Its inventory verdict is therefore `UNCLASSIFIED_TABLES`, the fail-closed path. CI's
`legacy-mysql` matrix proves it on MariaDB 10.11 and MySQL 8.0
(`tests/legacy-mysql/legacy-mysql-inventory.test.ts`). The synthetic inventory fingerprint
is pinned in `tests/unit/legacy-inventory.test.ts`, and the synthetic v1 fingerprint in
`tests/unit/legacy-import-read-set-v1.test.ts`.
