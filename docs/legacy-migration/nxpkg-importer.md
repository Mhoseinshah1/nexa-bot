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

## 3. Source adapter

`legacy-importer/infrastructure/nxpkg-legacy-source.ts` implements `LegacySourceConnector` /
`LegacySourceSession` over a decrypted package directory, like `fixture-legacy-source.ts`:

- `descriptor = {engine: 'NXPKG', version: '<converter version> / contract <x.y.z>',
readOnlyProof: {kind: 'NOT_APPLICABLE'}}`;
- `columns()`, `tables()`, `catalogColumns()`, `countRows()` from `source/catalog.json`;
- `rows()` / `readSetRows()` from `source/tables/<table>.jsonl`, in primary-key byte order,
  refusing a table outside the snapshot or a column the snapshot does not carry;
- `aggregate()` throws `EvidenceUnsupported`; `syntheticMarker()` returns the package's synthetic
  marker (`source/catalog.json.synthetic_marker`, null for a real backup).

CLI: `legacy-import ... --source nxpkg:<path> --package-key-env <NAME>` (key never on argv).

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
  import to the approved dry run's `sections.planTalliesDigest` (`DRY_RUN_MISMATCH`).

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
- COMPLETED means the importer's verdict is exactly `COMPLETED`, the reconcile is RECONCILED and
  the v2 final report holds (`finalV2.verdict`; its `failedSections` and `failedInvariants` are on
  the apply report). Anything else that finished is COMPLETED_WITH_DISCREPANCY. The verdict is
  recorded on the row as soon as the importer returns it, before the history phase. The production guard is unchanged: on a production-like
  target the operator must provide `NEXA_LEGACY_IMPORT_TARGET_ACK` to the `migration` process and
  the existing cutover approval (`legacy_cutover_approvals`, `legacy.cutover.approve`) binds the
  seven values; the admin page links to it at step 6. Nothing here weakens a gate.

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

Per-section counts in the final report: `source`, `imported`, `archived`, `skipped`,
`quarantined` — from the converter's coverage plus NEXA's own map. Nothing is dropped silently.

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

Steps: 1 upload · 2 verify · 3 dry run · 4 panels and customers · 5 money and ownership review ·
6 final approval · 7 import · 8 report, reconciliation, audit and backup. Persian, RTL, mobile,
`legacy.migration.*` permissions. Customer 360 gains a read-only «سوابق میرزا» card
(`legacy.history.view`).
