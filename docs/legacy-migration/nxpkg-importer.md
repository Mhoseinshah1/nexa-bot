# Mirza `.nxpkg` importer — Fresh Migration (design contract)

Status: **in development on branch `claude/mirza-nxpkg-importer` (Draft PR). Not deployed, not
run against any existing database, never against production or the current staging.**

The Mirza2Nexa converter (`Mhoseinshah1/mirza-to-nexa`) turns a Mirza MySQL backup into an
encrypted, versioned package (`.nxpkg`, container format `NXPKG_FORMAT.md`, content contract
`PACKAGE_CONTRACT.md` in that repository). This document is the contract between the parts of the
NEXA importer that consumes it. Everything here **extends** the existing legacy importer
(`importer.md`); nothing in it is rewritten.

## 0. Principles

1. **Fresh Migration only.** The importer runs only against a NEXA tenant whose operational data
   is empty (§6). A non-empty target stops the run (`FRESH_TARGET_NOT_EMPTY`); nothing is ever
   deleted, truncated or overwritten to make it empty.
2. **One import pipeline.** Customers, opening balances, legacy debts, products, trials, the
   invoice archive, service candidates and adoption are produced by the EXISTING
   `LegacyImporterService` (`prepare/audit/dryRun/apply/reconcile/finalReport`) reading a new
   source adapter, `NxpkgLegacySourceConnector` (§3). Its money rules, idempotency keys
   (`legacy:opening:<tg>`), resume, report v2 and invariants apply unchanged.
3. **History is archive.** Every other record type in the package goes to
   `legacy_history_records` (§5): visible, never operational, never money.
4. **RickPanel only, never provisioned.** The package's operator-selected target
   (`records/panel_target_mapping.jsonl`, contract ≥ 1.3.0) must be `provider_type = 'rickpanel'`
   (`PROVIDER_TYPES`, `packages/contracts/src/provider.ts:180`), and the NEXA panel it binds to
   must be an existing ACTIVE, non-archived `rickpanel` panel of the tenant. Any mismatch fails
   closed (`PANEL_TARGET_MISMATCH`). Provider writes during import = 0; adoption links existing
   accounts (P6), never creates, renews, resets, disables or deletes.
5. **No guess.** Ownership decisions from the converter's bulk review are verified and used as
   evidence, never recomputed (§7). Unknown values fail closed.
6. **Secrets.** The package key travels once, over the authenticated admin session, is sealed
   with the installation keyring (`infrastructure/crypto/secret-cipher.ts`) and erased when the
   import reaches a terminal state. It is never logged, returned or audited. Decrypted package
   content lives only in a private `0700` directory of the `migration` process and is deleted
   after each step.
7. **No long HTTP request.** The web surface uploads, records decisions and shows progress; the
   new `migration` process role (`apps/api/src/main.migration.ts`) does the work by polling
   `legacy_nxpkg_imports` with a lease (§4), the same pattern as `recovery` (ADR-0028).

## 1. Package requirements (fail closed)

| Check                                                                                                     | Code                                                           |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| container: magic, header canonical JSON, AES-256-GCM STREAM, key check, final chunk, no trailing bytes    | `NXPKG_CONTAINER_INVALID`, `NXPKG_WRONG_KEY`, `NXPKG_TAMPERED` |
| payload ZIP: deterministic, no traversal, sizes bounded, `checksums.json` matches every file              | `NXPKG_TAMPERED`                                               |
| `manifest.package_schema == "nexa.migration.mirza"`, major `1`, `package_schema_version >= 1.4.0`         | `NXPKG_UNSUPPORTED_VERSION`                                    |
| `manifest.readiness == "ready"` and no blockers                                                           | `NXPKG_NOT_READY`                                              |
| `source/catalog.json` + `source/tables/{user,invoice,product}.jsonl` present (contract 1.4.0)             | `NXPKG_SOURCE_SNAPSHOT_MISSING`                                |
| `money.declared_unit == "toman"`, `currency == "IRT"`, `rescaled == false`                                | `NXPKG_MONEY_UNIT`                                             |
| every `legacy_panel_target.target` has `provider_type == "rickpanel"`                                     | `PANEL_TARGET_MISMATCH`                                        |
| any record carrying a live-state flag set to `true` (`provision`, `affects_wallet`, `creates_payment`, …) | `NXPKG_LIVE_FLAG`                                              |

## 2. Contract additions (packages/contracts)

- `LegacySourceEngine` gains `'NXPKG'` (CHECKs in migrations 0193, 0219, 0223 extended by a new
  migration).
- Permissions (owner-only grant migration, like `0235_legacy_cutover_grants.sql`):
  - `legacy.migration.view` (MEDIUM) — see imports, reports;
  - `legacy.migration.manage` (HIGH) — upload, give the key, choose the panel, request a dry run;
  - `legacy.migration.apply` (CRITICAL) — approve a dry run and start the import;
  - `legacy.history.view` (MEDIUM) — the read-only Mirza history card on a customer.
- `LEGACY_NXPKG_IMPORT_STATUSES`: `UPLOADED, VERIFYING, VERIFIED, VERIFY_FAILED,
DRY_RUN_REQUESTED, DRY_RUN_RUNNING, DRY_RUN_DONE, DRY_RUN_FAILED, APPROVED, APPLYING,
COMPLETED, COMPLETED_WITH_DISCREPANCY, FAILED, CANCELLED`.
- `LEGACY_HISTORY_RECORD_TYPES`: the closed set of archive record types (§5).
- `LEGACY_MIGRATION_PROVIDER_INVENTORY_INCOMPLETE` and `legacyMigrationDryRunInventoryIncomplete`
  (v0.5.7): the dry run's incomplete-panel warning and the one rule that refuses its approval on a
  production-like target (§4a). No state, error code or column was added.
- `LEGACY_MIGRATION_PROVIDER_INVENTORY_CHURN` and `LEGACY_MIGRATION_PROVIDER_INVENTORY_UNRESOLVED`:
  the dry run's warnings for a production panel that changed while read and was decided one needed
  name at a time (informational), and for the needed names that stayed undecided (§4a). The rule
  above is unchanged. No state, error code or permission was added.

## 3. Source adapter

`legacy-importer/infrastructure/nxpkg-legacy-source.ts` implements `LegacySourceConnector` /
`LegacySourceSession` over a decrypted package directory, like `fixture-legacy-source.ts`:

- `descriptor = {engine: 'NXPKG', version: '<converter version> / contract <x.y.z>',
readOnlyProof: {kind: 'NOT_APPLICABLE'}}`;
- `columns()`, `tables()`, `catalogColumns()`, `countRows()` from `source/catalog.json`;
- `rows()` / `readSetRows()` from `source/tables/<table>.jsonl`, in primary-key byte order,
  refusing a table outside the snapshot or a column the snapshot does not carry;
- `readableColumns(table)`: the rows file's columns. The catalogue describes the dumped table
  (every column; the schema hash is over it), the rows file carries only the converter's
  `ALLOWLIST`. The importer (`resolveReadColumns`) reads an **optional** column the rows file
  does not carry as absent — as a source without it (converter 0.8.0 omitted
  `user.roll_Status`: everybody imports as "rules not accepted") — and refuses a **required**
  one before any row with `SOURCE_SCHEMA_MISSING_COLUMN`, naming `table.column`. The migration
  row shows it in its refusal counts (`SOURCE_SCHEMA_MISSING_COLUMN:user.Balance`), and so does
  `botctl cutover rehearse`'s failed step;
- `aggregate()` throws `EvidenceUnsupported`; `syntheticMarker()` returns the package's synthetic
  marker (`source/catalog.json.synthetic_marker`, null for a real backup).

CLI: `legacy-import ... --source nxpkg:<path> --package-key-env <NAME>` (key never on argv).

### 3a. The converter's snapshot allowlist (contract guard)

`tests/unit/nxpkg-converter-allowlist.test.ts` compares every column (required and optional)
of every read NEXA makes of `user`, `invoice` and `product` — the v1 vocabulary
(`IMPORT_READ_SET_V1`) and every `defineLegacyReadSet` — with a vendored copy of the
converter's `ALLOWLIST`, `tests/fixtures/legacy/converter-allowlist.json`. A column NEXA reads
that the converter does not carry fails CI ("add it to mirza-to-nexa ALLOWLIST"), before a
real package meets it. To refresh it from a new converter release:

1. In `mirza-to-nexa` at the release tag, copy `ALLOWLIST` from
   `src/mirza2nexa/source_snapshot.py`, verbatim and in its order, into the fixture's
   `allowlist`, and set `version` to the release.
2. `pnpm exec vitest run --project unit tests/unit/nxpkg-converter-allowlist.test.ts`.
3. A failure means the release dropped a column NEXA reads: fix the converter, never the
   fixture. A NEXA read that gains a column needs the converter release that carries it first.

For an `nxpkg:` source `runMode` — the one path the operator's CLI and the migration worker
share — adds, before the snapshot is read:

- **every mode** re-runs `checkNxpkgForImport` (§1) on the opened package; any problem refuses
  with its code (exit 65);
- **the panel map is the package's.** A given `--panel-map` (or the worker's map text) is
  accepted only if it is byte-for-byte in meaning (same fingerprint) the map
  `buildPanelMappingFromTargets` makes from the package's targets with the map's own `panels`
  as bindings and its `products` passed through (`validatePanelMappingAgainstTargets`): every
  targeted code bound to an ACTIVE, non-archived RickPanel of the tenant (a CONNECT_EXISTING
  target to its own id), no code bound without a target, no test or missing panels, the
  untargeted codes declared `OWNER_DECIDES_LATER` and nothing else. Otherwise
  `PANEL_TARGET_MISMATCH`. (Chosen over a separate `--panel-binding` flag: one rule for both
  callers, and the owner's `products` section still travels in the map.)
- `dry-run` and `import` refuse a tenant that is not fresh (§6, `FRESH_TARGET_NOT_EMPTY`), and
  `import` decides it again inside its start transaction;
- `import --expected-plan-tallies-digest HEX` (or the worker's `dryRunTalliesDigest`) binds the
  import to the approved dry run's `sections.planTalliesDigest` (`DRY_RUN_MISMATCH`). See §4a for
  what the digest binds and why the live RickPanel read is part of it.

## 4. Import lifecycle (`legacy_nxpkg_imports`, process role `migration`)

```
UPLOADED → VERIFYING → VERIFIED | VERIFY_FAILED
VERIFIED → DRY_RUN_REQUESTED → DRY_RUN_RUNNING → DRY_RUN_DONE | DRY_RUN_FAILED
DRY_RUN_DONE → APPROVED (binds dry_run_sha256) → APPLYING → COMPLETED | COMPLETED_WITH_DISCREPANCY | FAILED
any non-terminal → CANCELLED
```

- One non-terminal import per tenant (partial unique index).
- Worker lease: `claimed_by`, `lease_until`; a crashed worker's lease expires and the next one
  resumes — APPLYING resumes the same `legacy_import_runs` row (`importer.md` §6 resume) and the
  history ingest continues by idempotency key.
- APPLY re-checks: fresh target (§6), panel binding (§1), the package sha256 and the approved
  dry-run digest. Any difference → `FAILED` with a code, nothing written.
- After COMPLETED the worker requests a standard backup through the existing backup service
  (`container.backup.run('MANUAL')`, the same call `backup.cli.ts` makes; a system job may not
  call `BackupAdminService.run`, which needs `backup.run`), honouring the recovery quiesce lock;
  its run id is stored on the import.
- The worker runs exactly the existing CLI sequence, programmatically (`runMode` and the service
  methods; `docs/legacy-migration/rehearsal.md` order). **The dry run writes nothing durable for
  the read sets**: it OBSERVES the inventory, products and invoice-archive fingerprints
  (`expected = null`, digest only) and puts them in its report (`cutover`), beside the importer's
  dry run and the history counted with `dryRun`. **At the apply's start** — after the target
  acknowledgement, the approved-digest and package checks and the fresh guard, before the cutover
  approval is decided — the APPROVED reads run, each bound to the fingerprint the approved dry run
  observed: the inventory recorded, the products and the invoice archive ingested and recorded
  (`UNRESOLVED_RETAINED` needs the archive before the import). A source whose read sets now differ
  is `DRY_RUN_MISMATCH`, nothing ingested. On a production-like target the owner's cutover
  approval needs those read sets recorded, so it can be recorded once the import is APPROVED and
  the executor reports `CUTOVER_APPROVAL_MISSING`; it must name the seven values the dry run
  showed. Then import (resume on interruption), reconcile and the v2 final report.
- The dry run also compares the converter's own operational totals (`records/customers.jsonl`
  count, `wallet_opening_balances.jsonl` count and sum, `legacy_debts.jsonl` count and sum) with
  the importer's plan (importable users, positive and negative balances); any difference is
  `DRY_RUN_MISMATCH` with both numbers in `progress.refusalCounts`. A package without those files
  is refused on a production-like target and reported `CONVERTER_TOTALS_ABSENT` elsewhere.
- Then the same files PER CUSTOMER (`converter-wallet-crosscheck.ts`): every
  `wallet_opening_balances.jsonl` / `legacy_debts.jsonl` record, by its `telegram_user_id`
  (its `idempotency_key`, when present, must name the same customer), against the importer's
  own reading of the snapshot — the plan's rule, pinned to `planLegacyImport` by a unit test.
  Equal totals can hide two amounts swapped or a credit moved to the wrong person, so any
  `missing`, `unexpected`, `amountDiffers`, `duplicate` or `unidentified` record is
  `DRY_RUN_MISMATCH` exactly as a differing total is, with `per_customer:<file>:<kind>`
  counts (never an id or an amount). Streamed: one pass per file, one map in memory.
- The converter's wallet-history verdicts (`wallet_history_checks.jsonl`,
  `wallet_difference_analysis.jsonl`) are archived as history and never applied: the snapshot
  `Balance` is the opening figure. The dry run REPORTS them as warnings —
  `WALLET_HISTORY_NOT_MATCHING_SNAPSHOT` (every check whose verdict is not
  `MATCHES_SNAPSHOT`), `WALLET_HISTORY_CHECK:<verdict>`, `WALLET_DIFFERENCE_ANALYSED`,
  `WALLET_DIFFERENCE:<cause>`, `WALLET_HISTORY_OPENING_NOT_SNAPSHOT`,
  `WALLET_HISTORY_UNKNOWN_CUSTOMER`. A history that disagrees with the snapshot does not make
  the snapshot wrong, so it does not block. What blocks (`DRY_RUN_MISMATCH`,
  `wallet_history:snapshot_disagrees`) is a record whose own reading of the snapshot cell
  differs from the importer's: then the one figure every opening is taken from is in dispute
  between two readers of it. The verdict vocabulary beyond `MATCHES_SNAPSHOT` is `OQ-LWD-08`.
- COMPLETED means the importer's verdict is exactly `COMPLETED`, the reconcile is RECONCILED and
  the v2 final report holds (`finalV2.verdict`; its `failedSections` and `failedInvariants` are on
  the apply report). Anything else that finished is COMPLETED_WITH_DISCREPANCY. The verdict is
  recorded on the row as soon as the importer returns it, before the history phase. The production guard is unchanged: on a production-like
  target the operator must provide `NEXA_LEGACY_IMPORT_TARGET_ACK` to the `migration` process and
  the existing cutover approval (`legacy_cutover_approvals`, `legacy.cutover.approve`) binds the
  seven values; the admin page links to it at step 6. Nothing here weakens a gate. (Phase 7, §10:
  the restore page's approval carries the acknowledgement and records the cutover approval itself,
  and the import's write freeze stands for stop-sales.)

## 4a. The live RickPanel read (DRY_RUN_MISMATCH)

The plan is a function of the package AND of one input none of the seven cutover values binds:
a LIVE read of each production panel's accounts (`RickpanelInventorySource` → `listAll`). The dry
run reads the panels, and the import reads them again, minutes or hours later. Before v0.5.7 a
dry run that planned on an incomplete read — tens of thousands of invoices `INVENTORY_INCOMPLETE`
— could be approved, and an import whose own read came out complete planned another plan and
was refused `DRY_RUN_MISMATCH` (an owner's Web Admin import, 2026-10-13). The refusal was right;
reaching it was not.

- **Complete means two consecutive walks, each consistent with the panel's `total`, returning the
  identical set of exact provider spellings** (`docs/rickpanel-inventory.md`). Unchanged.
- **A panel that keeps selling while it is read is not a blocker** (owner requirement: the dry run
  must be approvable while Mirza sells on the live RickPanel). When the double walks are not one
  complete snapshot because the panel MOVED (`TOTAL_CHANGED`, `WALKS_DIFFER`), the Web Admin's importer
  decides each username the backup needs on that panel on its own — from the walks alone, and
  only on a GAP-FREE decision walk (rows oldest first by `created_at`, overlapping pages
  chained by name and creation time, no insertion ahead of the cursor missed, ended at its own
  total, both walks in one order: a snapshot of the panel as of its end; at most three walks).
  Gap-free is not survival, so a spelling the decision walk read is present only when a LATER
  walk returned the same row (same name and `created_at`). Two spellings seen in any walk are a
  collision; a confirmed spelling is present; none, in the decision walk and after it, is
  absent; anything else is unresolved. No exact lookup is sent — a 404 is
  never evidence. Every account on the panel that is not in the backup is ignored
  (`docs/rickpanel-inventory.md` §Per-name resolution). Such a read is reported complete, with a
  `resolution` in `sections.provider.panels[i]` (counts only). A needed name it could not decide
  leaves its invoice `INVENTORY_INCOMPLETE` and the panel `complete: false`, reason
  `UNRESOLVED`. A `COUNT_MISMATCH` with fewer names than a total that held still is NOT resolved
  per name: the list is withholding rows, and that panel stays incomplete — fail-closed.
- **A non-targeted read (none in the Web Admin today) attempts up to `INVENTORY_READ_ATTEMPTS` (3) double walks**,
  pausing 15 s and 45 s, when it came out INCOMPLETE (the panel moved). Only an attempt complete
  on its own is indexed. A transport failure, a 429 or a 5xx is not a reason to walk again from
  the start: the read session already asked that page again, within the read's one retry
  budget (see _Load on the panel_ below). The CLI and the rehearsal walk read once, as before
  (`inventoryAttempts`).
- **Load on the panel** (owner requirement, `docs/rickpanel-inventory.md` §Load protection):
  every read — Web Admin, CLI, rehearsal — is one read of that panel at a time in the whole
  installation (a PostgreSQL advisory lock per panel origin), one request in flight, at least
  `RICKPANEL_INVENTORY_REQUEST_INTERVAL_MS` (1000) between request starts and longer after a slow
  answer, on ONE login per read (a 401 mid-read buys one fresh login; a refused login is never
  asked again). A 429 waits the panel's `Retry-After` (over 2 minutes: not asked again); a
  timeout, an unreachable panel or a 5xx waits 2 / 5 / 15 / 30 s; all retries of a read draw on
  one budget of 4. The Web Admin asks `RICKPANEL_INVENTORY_PAGE_SIZE` (2000, the maximum) rows a page. The
  step's signal ends the read before its next request and ends every wait — a worker that lost
  its lease stops inside the importer's `prepare`, before the import's first write. Each read
  reports its cost in `diagnostics.load` (requests, logins, reuses, refreshes, retries, waits,
  queue time, duration, page size, largest page in bytes) — counts only.
- **The dry run says so**: `PROVIDER_INVENTORY_INCOMPLETE` (production panels whose read failed or
  decided nothing) and one `PROVIDER_INVENTORY_INCOMPLETE:<reason>` per reason; for a panel decided
  one name at a time, `PROVIDER_INVENTORY_CHURN` (panels), `PROVIDER_INVENTORY_CHURN:<reason>`
  and `PROVIDER_INVENTORY_UNRESOLVED` (needed names left undecided). The importer's `sections.provider.panels` carries each read's counts
  (`diagnostics`: attempts, and per walk the pages, rows, distinct spellings, duplicate rows, the
  panel's `total`, the first and last page's rows; `resolution`) — never a name. The restore page
  shows the churn as information, not as a refusal.
- **Production-like: a dry run with a panel read that failed, or with any candidate unresolved, is
  not approvable** (`legacy_migration.invalid_state`, `reason: PROVIDER_INVENTORY_INCOMPLETE`; one
  rule, `legacyMigrationDryRunInventoryIncomplete`, for the server and the restore page: it counts
  `PROVIDER_INVENTORY_INCOMPLETE` panels and any services `INVENTORY_INCOMPLETE`). A panel that
  changed while read with every needed name decided is not counted. The owner checks NEXA's access
  to the panel (a failure) and asks for the dry run again; sales do not need to stop. An approval
  recorded by an earlier release is stopped at the apply's TARGET precheck, before the protective
  backup (`DRY_RUN_MISMATCH`, `dryrun:panels:inventory_incomplete`).
- **Production-like: the import plans only on a read of its own that decides every candidate**
  (one complete snapshot, or every needed name resolved as above); anything else is
  `DRY_RUN_MISMATCH` before the digest and before any write — for every `.nxpkg` import and
  every import given a digest, whether or not the CLI was given `--expected-plan-tallies-digest`.
- **Production-like: a dry run that reported no plan digest is not approvable** (`reason:
PLAN_DIGEST_MISSING`), and the TARGET precheck refuses one approved earlier
  (`dryrun:plan:digest_missing`).
- **The digest (v2) binds every live invoice's service decision** — category and, for an eligible
  one, panel, exact spelling, product path and customer — beside the tallies: an account deleted
  and another created between the two reads could leave every count as it was and still adopt an
  account the owner never saw. Usage, state and links are NOT bound: they move by the minute and
  the import adopts from its own read.
- **The digest binds only the backup candidates' decisions**, never the panel's whole account
  list. An account an operator creates by hand, or a new Mirza sale, during or between the dry
  run's read and the import's does not move it. A candidate's account deleted or renamed between
  the dry run and the apply changes that candidate's decision, and the apply is refused
  `DRY_RUN_MISMATCH` before any write — nothing is written; dry-run again.
- **Upgrading**: a dry run approved before v0.5.7 carries the v1 digest. Its apply is refused
  `DRY_RUN_MISMATCH` with `plan:digest_format_outdated` (the importer recognises the v1 digest of
  the same plan — it is never accepted). Upgrade with no import APPROVED, and dry-run again.
- **What a mismatch records** (`progress.refusalCounts`): each number the approved report and the
  import's plan both carry, where they differ, as `dryrun:<key>` / `apply:<key>` pairs (services
  by category, new and importable customers, openings, debts, shapes, incomplete panels), or
  `plan:changed_beyond_compared_counts` when only the per-invoice decisions moved. Counts only.
- A FAILED import is final: the retry is the SAME `.nxpkg`, uploaded again (§6 lets its own read
  sets stand), dry-run and approved again.

## 5. History archive (`legacy_history_records`)

`(tenant_id, package_import_id, idempotency_key)` unique; `record_type`, `legacy_user_id`,
`customer_id` (resolved through `legacy_import_map` after the customers phase), `occurred_at`,
`payload jsonb` (the record exactly as packaged, minus nothing). Record types: payments,
wallet transactions, wallet history checks/difference analysis, service operations, cancellation
requests, manual config inventory (no configs), service ownership, panel registry/targets,
category catalogue, agents (profiles, tier prices, invoices, logs, usage, requests, state),
engagement (discounts, discount usage, referrals, wheel results, ad campaigns, program settings),
support (departments, messages, tickets, ticket messages), generic `archive/*` and
`configuration/*`. None of them changes a balance, an order, a service or a role.

Per-section counts: `source`, `imported`, `archived`, `skipped`, `quarantined`. The dry run
reports one `history:<record_type>` section per record type (every line of every history file
counted by the ingest's validating first pass), and one `table:<NEXA class>:<table>` section per
legacy table with the converter's own breakdown from `reports/coverage.json` (§5a). The ingest
refuses an unknown file under `records/`, an unknown or misfiled `record_type` and any live flag;
nothing is dropped silently.

## 5a. Every legacy table accounted for (`nxpkg-table-accounting.ts`)

The frozen catalogue (`LEGACY_TABLE_CLASSIFICATION`) names only the tables NEXA's read sets read
(`user`, `invoice`, `product`, the synthetic marker). A real Mirza backup has ~50 tables, and a
production-like import (and the cutover gate) refuses an inventory with an `UNCLASSIFIED` table.
For a `.nxpkg` source only, and only for a table the frozen catalogue does not name, NEXA derives
the class from the package's authenticated `reports/coverage.json` (the converter refuses to
write a package with a non-empty uncatalogued table or with rows it did not account for):

| converter class                  | condition                                                   | NEXA class       |
| -------------------------------- | ----------------------------------------------------------- | ---------------- |
| ARCHIVE / REVIEW / CONFIGURATION | row count equals `source/catalog.json`; every row accounted | `ARCHIVE`        |
| EXCLUDED, sensitivity `secret`   | row count equals; nothing carried                           | `SECRETS_MANUAL` |
| EXCLUDED, other sensitivity      | row count equals; nothing carried                           | `OWNER_DECISION` |
| none (unknown to the converter)  | the table is EMPTY                                          | `OWNER_DECISION` |
| anything else                    | —                                                           | `UNCLASSIFIED`   |

`ARCHIVE` means read-only history (`legacy_history_records`); no read set reads such a table's
rows from a package. A MySQL source never gets this: there a table stays `UNCLASSIFIED` until a
reviewed commit classifies it. The dry run warns `TABLE_INVENTORY_INCOMPLETE` on every target
(a production-like one refuses, naming the unclassified tables). The code was
`INVENTORY_INCOMPLETE` before v0.5.7, which is also the services category of a panel read that
was not complete (§4a); it was renamed so a warning names one thing. Pinned by
`tests/unit/nxpkg-table-accounting.test.ts`, including the converter-written fixture package's
50 tables (none unclassified).

## 6. Fresh target guard

Before DRY RUN and again inside APPLY: the tenant must have **zero** rows in
(`legacy-importer/application/fresh-target.ts`): customers, orders, services, payments,
payment_receipts, refunds, wallet_entries (the ledger), legacy_wallet_debts, trial_grants,
referrals; legacy_import_runs in APPLY mode (other than the run being started),
legacy_import_map, legacy_service_candidates, legacy_trial_eligibility, legacy_product_shapes,
legacy_history_records; and the read sets legacy_read_set_runs, legacy_product_reviews,
legacy_invoice_archive_runs, legacy_invoice_archive_staging, legacy_invoice_archive — where a
row recorded for the very source being imported (its own products / invoice-archive read sets,
taken just before) is not counted when the guard is given that source fingerprint. Panels and
products may exist: they are configuration (the RickPanel must, §1; the legacy product review
maps onto existing products and hidden shapes resolve to a current tariff). Otherwise
`FRESH_TARGET_NOT_EMPTY` with the counts — the importer never deletes anything to make room.

**Inside APPLY** means inside the transaction that starts the APPLY run
(`LegacyImporterService.apply`, mode IMPORT, outcome STARTED): the tenant row is taken
`FOR UPDATE` — which conflicts with the `FOR KEY SHARE` every foreign-key insert into the
tenant takes — and the counts are read again under it, so nothing lands between the check and
the run's start. Always for a source of engine `NXPKG` (`freshTarget: true` extends it to any
other engine). A RESUME of the same run is never refused by its own writes. History ingest
therefore runs after the importer's run has started, never before it.

## 7. Ownership decisions (`ownership-decisions.json`, optional)

Verified exactly as `NEXA_IMPORTER_DESIGN.md` §8.1 of the converter: HMAC under
`HKDF-SHA256(package master key, info = "nxpkg-v1/ownership-decisions")`, `import_id`,
`source_fingerprint`, `package_header_sha256`, `sealed`, `matches_seal`, `audit.ok`, and each
entry's `binding == sha256(canonical record)`. `ADMIN_APPROVED_UNVERIFIED` stays distinct from
`PROVEN`; `QUARANTINED` / `REJECTED` / `PENDING` / stale services are never adopted. Nothing is
recomputed.

**How it is applied (the hold).** The evidence can only REMOVE a live invoice from automatic
adoption, never add one (`legacy-importer/application/nxpkg-ownership.ts`). The importer takes a
set of held invoice keys (`LegacyImportInput.ownershipHold`, `ServiceReviewInputs.ownershipHold`);
`decideAllServices` turns a held invoice that NEXA would otherwise adopt into
`AMBIGUOUS_OWNERSHIP` — the existing category, map decision (`MANUAL_REVIEW`) and candidate row,
after NEXA's own ownership rule, so a held invoice still counts as a claim on its account. Held:

- with a verified decisions file: `QUARANTINED`, `REJECTED`, `PENDING` and every `stale` entry;
- without one: every ownership record not proven by evidence (`CONFIRMED_CURRENT_OWNER`,
  `CONFIRMED_TRANSFER`, `NO_CONFLICT`), i.e. the converter's `AMBIGUOUS_*` / orphan states;
- a `PROVEN` record whose proven owner is not the invoice's `id_user` (NEXA adopts onto `id_user`
  only), and a live invoice with no ownership record at all.

The two only ever add: held = decisionHold(entry) ∪ baselineHold(record), the baseline (not
proven by evidence, proven for another owner, no record) applying with a decisions file as much
as without one. `ADMIN_APPROVED_UNVERIFIED` is never promoted and never REMOVES a hold: an
attested invoice the evidence does not prove stays held; only one the evidence itself proves for
`invoice.id_user` is left to NEXA's own rules. It is reported as `ADMIN_ATTESTATION`
(`attested`), never as proven.

The same hold must be given to dry run, import, resume, reconcile and report of one package, and
the run enforces it: `legacy_import_run_inputs.ownership_hold_digest` (migration 0244) records
`ownershipHoldDigest(hold, decisions entries_digest | 'none')` when the run starts, and a resume,
reconcile or report under another digest is refused (`legacy_import.run_conflict`,
`OWNERSHIP_HOLD_MISMATCH: …`). The dry-run and import reports carry
`sections.ownershipHold = { invoices, changedCategory }` — the held live invoices, and of those
the ones whose category the hold changed (ADOPTION_ELIGIBLE → AMBIGUOUS_OWNERSHIP). This was chosen over pre-closing candidate
rows as `KEPT_AS_HISTORY`: a fresh target has no candidate rows to close, and "kept as history"
would also drop the invoice's claim on its account from the ownership rule.

## 8. Admin page «مهاجرت از میرزا»

(Phase 7: the flow moves into «بکاپ و بازیابی ← عملیات بازیابی», §10; the steps below are the
same API.)

Steps: 1 upload · 2 verify · 3 dry run · 4 panels and customers · 5 money and ownership review ·
6 final approval · 7 import · 8 report, reconciliation, audit and backup. Persian, RTL, mobile,
`legacy.migration.*` permissions. Customer 360 gains a read-only «سوابق میرزا» card
(`legacy.history.view`).

## 10. Phase 7 — the restore page's second source (`recovery` role)

The owner's flow has no migration page, no server command and no environment variable:
Mirza2Nexa produces the `.nxpkg` («فایل بکاپ NEXA برای بازیابی از میرزا»), and NEXA's
**بکاپ و بازیابی ← عملیات بازیابی** takes it beside a `.nxb`. A real `.nxb` is not possible
(its data key is wrapped under the installation's KEK and a restore REPLACES the whole
database; `docs/backup.md`), so the page drives this importer — the same rows, routes, executor
and adapters as §4 — with these differences:

- **Executor in the `recovery` role.** `main.recovery.ts` starts `container.migrationExecutor`
  beside the recovery executor and its heartbeat requires both loops to be fresh.
  `main.migration.ts` stays for the rehearsal kit; two replicas are safe (the lease).
- **Storage.** `deploy/compose.yml` mounts the named volume `legacymigration` at
  `/var/lib/nexa/legacy-migration` (`LEGACY_MIGRATION_WORK_DIR`) on every app role, so the api
  (upload) and the recovery role (executor) see the same files.
- **On by default.** `LEGACY_MIGRATION_ENABLED` defaults to `true`; `false` is the kill switch.
  Safety does not rest on the flag: the fresh-target guard (§6), the owner-only CRITICAL
  `legacy.migration.apply` (and `legacy.cutover.approve`), the typed phrase bound to the dry-run
  digest, the protective backup and the write freeze below.
- **The dry run needs no target acknowledgement** (it writes no customer and no money). A
  synthetic package is still refused on a production-like target.
- **One confirmation folds in the owner gates.** The approve request carries
  `targetAcknowledgement`; on a production-like target it must equal
  `targetAcknowledgement(target, tenant)` (`legacy_migration.target_ack_mismatch` otherwise) and
  is stored (`legacy_nxpkg_imports.target_ack`, migration 0245). The executor's production-like
  precheck accepts that stored value — re-derived for its own target and tenant — in place of the
  process environment's `NEXA_LEGACY_IMPORT_TARGET_ACK` (still accepted: CLI and rehearsal).
  The same transaction records the owner's CUTOVER approval of the dry run's seven values
  (`LegacyCutoverService.recordImportApproval`, reason «تأیید بازیابی از صفحه بکاپ و بازیابی»,
  reused when an identical unrevoked one exists). Its evidence is the dry run the executor
  recorded on the row; `decideImport` still requires the read sets recorded at the apply's start.
- **Mandatory protective backup before any write.** On claiming an APPROVED import, after the
  target, digest, package and fresh-target checks, the executor runs `BackupService.run('PRE_RESTORE')`
  (the recovery's emergency-backup trigger) with `deliver: false` (kept on this server, never
  sent to Telegram; the post-import backup likewise) and requires a run that SUCCEEDED with
  `verified_at`.
  Its id is recorded (`pre_import_backup_run_id`, view `preImportBackupRunId`) in the SAME
  conditional UPDATE that moves the import APPROVED → APPLYING (a CHECK requires it on every
  APPLYING row), so a resumed import never takes a second one. Not taken and verified →
  `FAILED` / `PRE_IMPORT_BACKUP_FAILED`, nothing written. A busy pipeline, or a confirmed
  recovery, is not a verdict: the import waits APPROVED. Restoring that backup on the same page
  is how the import is undone. The post-import backup is unchanged.
- **Installation-wide write freeze while APPLYING.** The container's write gate answers
  `legacy-migration:<id>` while any import is APPLYING, so every durable write in every process is
  refused with `recovery.quiesced` and the outbox relay idles (nothing is dispatched to anyone
  during the import). The one exemption is the import's own writer: the executor runs the apply
  inside `runAsLegacyMigration(id, …)` (an `AsyncLocalStorage`), and a write passes only when the
  freezing id is exactly that import's. Reads, readiness and the executor's own lease writes (the
  repository writes on the pool, outside the unit of work) are unaffected.
- **Stop-sales** holds when the tenant has an APPLYING import (`frozenByImport`), so no incident
  is needed. A blocker met while APPLYING (a revoked approval, a changed target) FAILS the import
  with the blocker on its progress: the freeze would refuse the very write that could clear it.
- **Mutual exclusion with a recovery.** A restore is not confirmed while an import is APPROVED or
  APPLYING (`recovery.legacy_migration_active`); an import is not approved
  (`legacy_migration.recovery_active`) and not started while a recovery is confirmed and
  unfinished.
- **No Telegram, no panel write.** No outbox consumer subscribes to an importer event
  (`CustomerImported`, the review queue's change), no customer notification is created, and the
  RickPanel sees GETs and the token exchange only — asserted after a full import and a relay pass.

### 10a. Review hardening (Phase 7 review)

- **A restore closes what it brought back (H1).** After a NEXA restore's cutover, every
  non-terminal import created before it is closed (`CANCELLED` / `SUPERSEDED_BY_RESTORE`, key
  erased) by the recovery executor, and again by the Mirza executor's tick (backstop, also when the
  recovery's sweep failed). Restoring the protective backup therefore never re-imports.
- **The image creates `/var/lib/nexa/legacy-migration` (H2)** for the node user, 0700.
- **The freeze is bounded (H3).** Every APPLYING attempt is counted BEFORE anything can throw (the
  first one in the APPROVED → APPLYING update), so a step-directory, key, read-set, unwired-port or
  unclassified error — and a `RUN_CONFLICT` — reaches `LEGACY_MIGRATION_MAX_APPLY_ATTEMPTS` (5) and
  FAILS the import, lifting the freeze. An attempt starting more than 48 h after the approval is
  failed too (`LEGACY_MIGRATION_APPLY_WINDOW_MS`; never mid-attempt).
- **One lock for the two confirmations (M1).** `approve` and the NEXA restore's `confirm` take the
  same transaction-scoped advisory lock (`restore-exclusion.ts`) and read the other's state inside
  their transaction. The recovery executor always claims a confirmed restore and, if a Mirza import
  holds the installation, fails it at once (`recovery.confirmation_invalid`); the import side waits
  with the blocker `RECOVERY_ACTIVE` shown.
- **The acknowledgement is decided once (M3)**, by `TARGET` before the first write; `APPLY` and
  every resume trust that decision, so a partly written import is never failed for it.
- **One APPLYING import per installation (M4):** blocker `ANOTHER_IMPORT_APPLYING` before the
  protective backup, and the partial unique index `legacy_nxpkg_imports_one_applying_idx` (0246).
- **Approval TTL.** An import APPROVED for more than `LEGACY_MIGRATION_APPROVAL_TTL_MS` (24 h)
  without starting is failed `APPROVAL_EXPIRED`, nothing written.
- **The cutover approval an import recorded is not revoked when the import ends without writes.**
  Harmless by construction: it binds the exact uploaded file (`finalDumpSha256`), its source and
  read-set fingerprints; a later import of that same file still needs its own dry run, approval
  (and on the restore page its own confirmation), and the fresh-target guard still decides. It is
  visible at `/legacy-cutover` and the owner may revoke it there.
- **What `targetAcknowledgement` proves.** The page echoes the value the capabilities returned, so
  it proves only that the client read this installation's capabilities before confirming — not an
  independent operator act like the CLI's environment variable. The owner's CRITICAL permission,
  the typed phrase and the digest binding are what authorise; the acknowledgement guards against a
  confirmation built for another installation or tenant.
- **Upgrading onto 0245 with an import APPLYING.** 0245's CHECK requires a protective backup id on
  every APPLYING row, so an installation upgraded from a pre-Phase-7 release while an import is
  APPLYING would fail that migration (and `botctl` rolls back). Let the import finish (or fail)
  before upgrading; no installation is known to be in that state (the feature was never deployed).
- The recovery role's Mirza loop ticks at start, so the role's heartbeat is fresh at once.

Tests: `tests/unit/legacy-migration.test.ts`, `tests/unit/legacy-migration-write-freeze.test.ts`,
`tests/integration/legacy-migration-nxpkg.test.ts` (the production-like restore-page case),
`tests/integration/legacy-migration-restore-page.test.ts` (the recovery role's executor, the
backup failure) and `tests/integration/recovery-executor.test.ts` (mutual exclusion).

### 10b. The "adopt approved" lane (a re-upload after a finished restore)

`docs/legacy-migration/service-review.md` §4b is the design and the record. On this page's
terms: the SAME package uploaded again after its restore finished is verified as any upload, but
— its source being one a COMPLETED / COMPLETED_WITH_DISCREPANCY import of this tenant came from —
the page requests no dry run (the tenant is not fresh) and offers the lane:
`VERIFIED → ADOPT_REQUESTED → ADOPT_RUNNING → ADOPT_DONE | FAILED` (migration `0249`; the
request is charged on the CRITICAL `legacy.migration.apply`). The `recovery` role runs it as the
importer's `ADOPT_APPROVED` run, bound to that finished import's apply run and its approved dry
run's inventory hold: it executes only the operators' ADOPT approvals, reads only the panels they
name (GETs), and writes no customer, wallet, debt, trial or shape. It holds no write freeze and
takes no backup; it WAITS (blocker shown, still cancellable) while any import is APPLYING, a
restore is confirmed, or another run is RUNNING. `ADOPT_RUNNING` is not cancellable (a claim may
be taken; the lane resumes its own run). Tests: `tests/unit/legacy-migration.test.ts` (the
lane's lifecycle, permission and waits) and `tests/integration/nxpkg-live-panel-inventory.test.ts`
(§4b, end to end).
