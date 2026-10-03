# Legacy import metadata (Migration P4)

Two tables record what a legacy import **did**. They are not a staging copy of the
legacy database, and nothing in them can hold a raw source row, a credential, a phone
number, a subscription link or free text. The P7 importer that writes them is on HOLD;
this is the metadata it needs to resume, reconcile and rerun safely.

Code: `apps/api/src/modules/platform/legacy-import/` (port + Drizzle repository),
contracts in `packages/contracts/src/legacy-import.ts`, migration
`0190_legacy_import_metadata.sql`.

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

| `legacy_table` | `legacy_id` shape    | evidence                                                                                                                               |
| -------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `user`         | `^[1-9][0-9]{0,19}$` | `user.id` is the customer's Telegram id; all 197,461 values are numeric strings (program §19, `docs/legacy-migration/sql-evidence.md`) |

Any other table (`invoice` among them) is refused until its primary-key format is evidenced
(`OQ-P4-01`) and added by a forward migration — never a guessed shape.

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
