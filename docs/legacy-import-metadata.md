# Legacy import metadata (Migration P4)

Two tables record what a legacy import **did**. They are not a staging copy of the
legacy database, and nothing in them can hold a raw source row, a credential, a phone
number, a subscription link or free text. The P7 importer that writes them is on HOLD;
this is the metadata it needs to resume, reconcile and rerun safely.

Code: `apps/api/src/modules/platform/legacy-import/` (port + Drizzle repository),
contracts in `packages/contracts/src/legacy-import.ts`, migration
`0190_legacy_import_metadata.sql`.

## `legacy_import_runs`

| column                                                                  | meaning                                                                 |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `id`, `tenant_id`                                                       | the run, tenant-scoped (composite key `(tenant_id, id)`)                |
| `mode`                                                                  | `DRY_RUN` or `APPLY` (CHECK from `LEGACY_IMPORT_RUN_MODES`)             |
| `status`                                                                | `RUNNING`, `COMPLETED`, `FAILED`, `ABORTED` (CHECK)                     |
| `source_fingerprint`                                                    | SHA-256 hex of the source snapshot's identity                           |
| `code_version`                                                          | importer commit or release, bounded charset                             |
| `failure_code`                                                          | closed code (`LEGACY_IMPORT_RUN_FAILURE_CODES`); only on `FAILED`       |
| `rows_seen`                                                             | advanced monotonically by checkpoints                                   |
| `rows_imported` / `rows_skipped` / `rows_manual_review` / `rows_failed` | snapshotted at the terminal transition from the map rows this run wrote |
| `started_at`, `last_progress_at`, `finished_at`                         | `timestamptz`; a CHECK pins each status to its stamps                   |

Rules:

- **One `RUNNING` run per tenant**, by the partial unique index
  `legacy_import_runs_one_running_idx` — not by a process. `startOrResume` with the same
  fingerprint and mode RESUMES the running run; a different fingerprint or mode is refused
  (`legacy_import.run_conflict`). Two concurrent starts yield one `STARTED` and one
  `RESUMED` (tested).
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

CHECKs: `legacy_table` is a plain identifier, `legacy_id` is `[A-Za-z0-9_.:-]{1,128}`,
`checksum` is lowercase 64-hex, `IMPORTED` names exactly one entity and every other status
names none and carries a reason code.

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
  and names, and that a free-text reason, a non-hex checksum and a phone-shaped legacy id
  are refused by CHECK.
- Never store a source row: store its checksum.

## What the P7 importer must add (HOLD)

The repository takes the caller's transaction and does not authorize. The importer's
service is a write path like any other: permission through the guard, `ScopeContext` +
`ActorContext` (`SYSTEM_JOB` for a CLI), `ScopeActivityReader` **inside** the transaction,
an idempotency key per batch, an audit row, and the domain writes (customer, opening
balance, adoption) in the same transaction as the map row that records them.
