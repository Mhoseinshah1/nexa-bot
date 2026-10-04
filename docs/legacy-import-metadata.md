# Legacy import metadata (Migration P4)

Two tables record what a legacy import **did**. They are not a staging copy of the
legacy database, and nothing in them can hold a raw source row, a credential, a phone
number, a subscription link or free text. The P7 importer that writes them is on HOLD;
this is the metadata it needs to resume, reconcile and rerun safely.

Code: `apps/api/src/modules/platform/legacy-import/` (port + Drizzle repository),
contracts in `packages/contracts/src/legacy-import.ts`, migrations
`0190_legacy_import_metadata.sql` and `0191_legacy_import_map_invoice_key.sql`.

## `legacy_import_runs`

| column                                                                  | meaning                                                                                                                                        |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `tenant_id`                                                       | the run, tenant-scoped (composite key `(tenant_id, id)`)                                                                                       |
| `mode`                                                                  | `DRY_RUN` or `APPLY` (CHECK from `LEGACY_IMPORT_RUN_MODES`)                                                                                    |
| `status`                                                                | `RUNNING`, `COMPLETED`, `FAILED`, `ABORTED` (CHECK)                                                                                            |
| `source_fingerprint`                                                    | SHA-256 hex of the source snapshot's identity                                                                                                  |
| `code_version`                                                          | importer commit or release, bounded charset                                                                                                    |
| `failure_code`                                                          | closed code (`LEGACY_IMPORT_RUN_FAILURE_CODES`); only on `FAILED`                                                                              |
| `rows_seen`                                                             | advanced monotonically by checkpoints                                                                                                          |
| `rows_imported` / `rows_skipped` / `rows_manual_review` / `rows_failed` | `APPLY`: snapshotted at the terminal transition from the map rows this run wrote. `DRY_RUN`: incremented per decision (`recordDryRunDecision`) |
| `started_at`, `last_progress_at`, `finished_at`                         | `timestamptz`; a CHECK pins each status to its stamps; `finished_at >= started_at` and `>= last_progress_at`                                   |

Rules:

- **One `RUNNING` run per tenant**, by the partial unique index
  `legacy_import_runs_one_running_idx` — not by a process. `startOrResume` with the same
  fingerprint RESUMES a running `APPLY` run; a different fingerprint or mode is refused
  (`legacy_import.run_conflict`). Two concurrent starts yield one `STARTED` and one
  `RESUMED` (tested).
- **A dry run counts without map rows, and never resumes.** Each decision is
  `recordDryRunDecision(status)`: one conditional UPDATE incrementing that status's counter,
  naming `RUNNING` and `DRY_RUN` (refused for an `APPLY` run, whose counters come from its
  map rows, and for a finished run). `finish` leaves a dry run's counters as incremented and
  snapshots an `APPLY` run's from the map. Because re-processing rows after a crash would
  count them twice, a running dry run is not resumed: a second start is refused with its id,
  and the caller aborts it and starts again (Codex P1 on #175; tested and mutation-checked).
- **`finish` is clamped to recorded progress**: `finished_at = GREATEST(started_at,
last_progress_at, now)`, so a skewed clock cannot finish a run before its last checkpoint;
  `legacy_import_runs_finish_after_progress_check` refuses the inversion from any writer
  (Codex P2 on #175).
- **Every transition is a conditional UPDATE naming `RUNNING`.** A finished run neither
  finishes again, checkpoints, nor writes map rows (`legacy_import.run_not_writable`).
- **`finish` locks the run row first and counts afterwards.** Every map write holds the
  run row `FOR SHARE`; the finish's `FOR UPDATE` waits for in-flight writes, and the count
  is a new statement whose snapshot sees them. Counting inside the UPDATE would use the
  snapshot from before the wait (mutation-checked: removing the lock fails
  `a finish waits for an in-flight map write and counts it`).

## `legacy_import_map`

Primary key **`(tenant_id, legacy_table, legacy_id)`** — one decision per legacy record,
for ever. Columns: `run_id` (the run that last wrote it; composite FK to the run, so it
cannot name another tenant's run), `checksum` (SHA-256 of the canonical source row),
`status` (`IMPORTED`, `SKIPPED`, `MANUAL_REVIEW`, `FAILED`), `reason_code` (closed set
`LEGACY_IMPORT_REASON_CODES`), `entity_type` + `entity_id` (what it became; no FK on
purpose — it names one of several tables), `attempts`, `created_at`, `updated_at`.

CHECKs: `checksum` is lowercase 64-hex; `IMPORTED` names exactly one entity and every other
status names none and carries a reason code; and the legacy key is a **closed table set
with one evidenced key shape per table** (`LEGACY_IMPORT_SOURCE_TABLES`,
`LEGACY_ID_PATTERNS`, mirrored by `legacy_import_map_legacy_key_check`; an integration test
runs the same samples through the contract and the database and requires the same answer):

| `legacy_table` | `legacy_id` shape                              | evidence                                                                                                                               |
| -------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `user`         | `^[1-9][0-9]{0,19}$`                           | `user.id` is the customer's Telegram id; all 197,461 values are numeric strings (program §19, `docs/legacy-migration/sql-evidence.md`) |
| `invoice`      | `^([1-9][0-9]{6})?([0-9a-f]{4}\|[0-9a-f]{8})$` | `invoice.id_invoice`; MirzaBot's public source, every revision (below). Added by `0191_legacy_import_map_invoice_key.sql`              |

Any other table is refused until its primary-key format is evidenced and added by a
forward migration — never a guessed shape.

### The `invoice` key (`OQ-P4-01`, resolved from public source)

The repository itself never evidenced it: `docs/legacy-migration/sql-evidence.md` joins
`invoice.id_user` to `user.id` but never shows the invoice's own key. The evidence is
MirzaBot's **public** source, read-only, full history, on 2026-10-04:

| repository                | revisions read                                                             | what it shows                                                                |
| ------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `mahdiMGF2/botmirzapanel` | all 535, `f52a84c` … `92c0ed06` (2023-08-18 … 2026-06-30)                  | `table.php`: `CREATE TABLE invoice (id_invoice varchar(200) PRIMARY KEY, …)` |
| `mahdiMGF2/mirza_pro`     | all 508, `f002b99` … `8e551ecf` (2025-10-15 … 2026-10-02, `version` 0.6.0) | `db/tables/invoice.php`: `id_invoice varchar(200) PRIMARY KEY`               |

At every `INSERT INTO invoice` in every revision (646 site-revisions in `botmirzapanel`'s
`index.php`/`admin.php`/`functions.php`, 1,630 site-revisions in `mirza_pro`'s `index.php`, `admin.php`,
`api/invoice.php`, `api/miniapp.php`, `vpnbot/*/index.php`), the value bound to
`id_invoice` is `$randomString`, and the only assignments reaching it are:

- `bin2hex(random_bytes(2))` — 4 lowercase hex (`botmirzapanel` from `652b9a8`; its
  `admin.php` manual add, e.g. `92c0ed06:admin.php:2439`);
- `bin2hex(random_bytes(4))` — 8 lowercase hex (`botmirzapanel` from `abdd5e7`,
  `92c0ed06:index.php:1441,1752`; every `mirza_pro` site, e.g. `8e551ecf:index.php:3888`);
- `$random_number . $randomString`, the collision fallback, where `$random_number` is
  `rand(1000000, 9999999)` or `random_int(1000000, 9999999)` — seven digits, no leading
  zero (`92c0ed06:index.php:1774-1776`, `8e551ecf:index.php:3889-3891`).

`bin2hex(random_bytes(3|5|6))` appear in the same files and never reach `id_invoice` (they
are usernames, payment ids and the web-admin password). So the shape is exactly the union,
no wider: `^([1-9][0-9]{6})?([0-9a-f]{4}|[0-9a-f]{8})$` (4, 8, 11 or 15 characters). The
contract (`LEGACY_ID_PATTERNS.invoice`) and the CHECK carry the same pattern; the unit test
pins the accepted and refused samples, the integration test runs them through both and
requires the same answer, and both were mutation-checked (widening the hex run, allowing a
leading-zero prefix, allowing uppercase, dropping the anchor, widening the SQL — each fails a
test).

**Caveat — the deployed revision is not one of these.** The archive's `invoice` carries
columns (`code_panel`, `is_test`, `is_custom`, `code_product`, `time_unit`; see the queries in
`sql-evidence.md`) that no public revision's `invoice` table declares, so the deployed code
is a revision or fork that was not read. Its key generator may differ. The importer
therefore **fails closed**: a key outside the shape is refused with a typed
`legacy_import.invalid` before SQL, and that row cannot be recorded at all — not as
`MANUAL_REVIEW`, not as anything. The importer's audit mode must count such keys (aggregate
only) before an `APPLY`; if any exist, the shape is widened in a forward migration from the
archive's own aggregate, never by guess. The confirming aggregate, for the runbook — it
returns counts, never a value:

```sql
SELECT
  SUM(BINARY id_invoice REGEXP '^([1-9][0-9]{6})?([0-9a-f]{4}|[0-9a-f]{8})$') AS conforming,
  SUM(NOT (BINARY id_invoice REGEXP '^([1-9][0-9]{6})?([0-9a-f]{4}|[0-9a-f]{8})$')) AS other,
  MIN(CHAR_LENGTH(id_invoice)) AS min_len,
  MAX(CHAR_LENGTH(id_invoice)) AS max_len
FROM invoice;
```

As with `user`, the shape cannot tell one short hex string from another. It does
guarantee that nothing with a letter beyond `f`, an uppercase letter, a separator, a
scheme or whitespace — `hunter2`, `password:hunter2`, a name, a subscription link — fits
(tested).

### The upsert (`recordDecision`)

Allowed only under a `RUNNING` `APPLY` run of the same tenant (a `DRY_RUN` writes no map
rows). Insert-or-nothing on the key, then the pure rule `decideMapWrite`:

| existing       | incoming                                   | outcome                                    |
| -------------- | ------------------------------------------ | ------------------------------------------ |
| none           | anything                                   | `INSERTED`                                 |
| `IMPORTED`     | same entity, same checksum                 | `UNCHANGED` (idempotent rerun)             |
| `IMPORTED`     | other entity, or any non-`IMPORTED` status | `REFUSED / IMPORTED_ENTITY_MISMATCH`       |
| `IMPORTED`     | same entity, different checksum            | `REFUSED / IMPORTED_SOURCE_CHANGED`        |
| not `IMPORTED` | identical                                  | `UNCHANGED`                                |
| not `IMPORTED` | anything else                              | `UPDATED` (`run_id` moves, `attempts + 1`) |

Provenance is never rewritten by a rerun, and source drift under an imported row is
surfaced for a human, never absorbed.

### Resume

`resumeDecision(existing, checksum)`: `SKIP` an `IMPORTED` row from the same source row,
`SOURCE_CHANGED` if the source row differs, otherwise `PROCESS`. A resumed run reads
`findByLegacyKeys` per batch first. A run that died leaves its map rows; the next run
skips what was imported and revisits `FAILED` / `MANUAL_REVIEW` / `SKIPPED` rows.

### Reconcile and manual review

`summarize` — counts by `(legacy_table, status, reason_code)`. `listManualReview` —
`MANUAL_REVIEW` rows keyset-paged by `(legacy_table, legacy_id)`, filterable by table and
reason; pages never repeat or skip a row (tested).

## Security

- No `jsonb`, `bytea` or free-text column; an integration test asserts the column types
  and names, and that a free-text reason and a non-hex checksum are refused by CHECK.
- **What the key CHECK does and does not guarantee.** It guarantees the map holds no
  credential and no free text: anything with a letter, separator, sign or whitespace —
  `hunter2`, `password:hunter2`, `+98912…`, a name — is refused for every table (tested).
  It does NOT, and cannot, tell one digit string from another: `user.id` IS the Telegram
  user id, which is the key and is expected here, and a phone number written without its
  `+` is also a digit string. The map stores identifiers by design; the rule is that it
  stores nothing else.
- Never store a source row: store its checksum.

## What the P7 importer must add (HOLD)

The repository takes the caller's transaction and does not authorize. The importer's
service is a write path like any other: permission through the guard, `ScopeContext` +
`ActorContext` (`SYSTEM_JOB` for a CLI), `ScopeActivityReader` **inside** the transaction,
an idempotency key per batch, an audit row, and the domain writes (customer, opening
balance, adoption) in the same transaction as the map row that records them.
