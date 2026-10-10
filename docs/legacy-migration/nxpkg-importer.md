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

| Check | Code |
|---|---|
| container: magic, header canonical JSON, AES-256-GCM STREAM, key check, final chunk, no trailing bytes | `NXPKG_CONTAINER_INVALID`, `NXPKG_WRONG_KEY`, `NXPKG_TAMPERED` |
| payload ZIP: deterministic, no traversal, sizes bounded, `checksums.json` matches every file | `NXPKG_TAMPERED` |
| `manifest.package_schema == "nexa.migration.mirza"`, major `1`, `package_schema_version >= 1.4.0` | `NXPKG_UNSUPPORTED_VERSION` |
| `manifest.readiness == "ready"` and no blockers | `NXPKG_NOT_READY` |
| `source/catalog.json` + `source/tables/{user,invoice,product}.jsonl` present (contract 1.4.0) | `NXPKG_SOURCE_SNAPSHOT_MISSING` |
| `money.declared_unit == "toman"`, `currency == "IRT"`, `rescaled == false` | `NXPKG_MONEY_UNIT` |
| every `legacy_panel_target.target` has `provider_type == "rickpanel"` | `PANEL_TARGET_MISMATCH` |
| any record carrying a live-state flag set to `true` (`provision`, `affects_wallet`, `creates_payment`, …) | `NXPKG_LIVE_FLAG` |

## 2. Contract additions (packages/contracts)

* `LegacySourceEngine` gains `'NXPKG'` (CHECKs in migrations 0193, 0219, 0223 extended by a new
  migration).
* Permissions (owner-only grant migration, like `0235_legacy_cutover_grants.sql`):
  * `legacy.migration.view` (MEDIUM) — see imports, reports;
  * `legacy.migration.manage` (HIGH) — upload, give the key, choose the panel, request a dry run;
  * `legacy.migration.apply` (CRITICAL) — approve a dry run and start the import;
  * `legacy.history.view` (MEDIUM) — the read-only Mirza history card on a customer.
* `LEGACY_NXPKG_IMPORT_STATUSES`: `UPLOADED, VERIFYING, VERIFIED, VERIFY_FAILED,
  DRY_RUN_REQUESTED, DRY_RUN_RUNNING, DRY_RUN_DONE, DRY_RUN_FAILED, APPROVED, APPLYING,
  COMPLETED, COMPLETED_WITH_DISCREPANCY, FAILED, CANCELLED`.
* `LEGACY_HISTORY_RECORD_TYPES`: the closed set of archive record types (§5).

## 3. Source adapter

`legacy-importer/infrastructure/nxpkg-legacy-source.ts` implements `LegacySourceConnector` /
`LegacySourceSession` over a decrypted package directory, like `fixture-legacy-source.ts`:

* `descriptor = {engine: 'NXPKG', version: '<converter version> / contract <x.y.z>',
  readOnlyProof: {kind: 'NOT_APPLICABLE'}}`;
* `columns()`, `tables()`, `catalogColumns()`, `countRows()` from `source/catalog.json`;
* `rows()` / `readSetRows()` from `source/tables/<table>.jsonl`, in primary-key byte order,
  refusing a table outside the snapshot or a column the snapshot does not carry;
* `aggregate()` throws `EvidenceUnsupported`; `syntheticMarker()` returns the package's synthetic
  marker (`source/catalog.json.synthetic_marker`, null for a real backup).

CLI: `legacy-import ... --source nxpkg:<path> --package-key-env <NAME>` (key never on argv).

## 4. Import lifecycle (`legacy_nxpkg_imports`, process role `migration`)

```
UPLOADED → VERIFYING → VERIFIED | VERIFY_FAILED
VERIFIED → DRY_RUN_REQUESTED → DRY_RUN_RUNNING → DRY_RUN_DONE | DRY_RUN_FAILED
DRY_RUN_DONE → APPROVED (binds dry_run_sha256) → APPLYING → COMPLETED | COMPLETED_WITH_DISCREPANCY | FAILED
any non-terminal → CANCELLED
```

* One non-terminal import per tenant (partial unique index).
* Worker lease: `claimed_by`, `lease_until`; a crashed worker's lease expires and the next one
  resumes — APPLYING resumes the same `legacy_import_runs` row (`importer.md` §6 resume) and the
  history ingest continues by idempotency key.
* APPLY re-checks: fresh target (§6), panel binding (§1), the package sha256 and the approved
  dry-run digest. Any difference → `FAILED` with a code, nothing written.
* After COMPLETED the worker requests a standard backup through the existing backup service
  (`container.backup.run('MANUAL')`, the same call `backup.cli.ts` makes; a system job may not
  call `BackupAdminService.run`, which needs `backup.run`), honouring the recovery quiesce lock;
  its run id is stored on the import.
* The worker runs exactly the existing CLI sequence, programmatically (`runMode` and the service
  methods; `docs/legacy-migration/rehearsal.md` order): products read set and invoice-archive read
  set before the import (`UNRESOLVED_RETAINED`), then dry run, import (resume on interruption),
  reconcile and the v2 final report. The production guard is unchanged: on a production-like
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

Before DRY RUN and again inside APPLY: the tenant must have **zero** customers, orders, services,
payments, ledger entries, wallet debts, legacy import runs in APPLY mode, and history records.
Panels may exist (the RickPanel must, §1). Otherwise `FRESH_TARGET_NOT_EMPTY` with the counts —
the importer never deletes anything to make room.

## 7. Ownership decisions (`ownership-decisions.json`, optional)

Verified exactly as `NEXA_IMPORTER_DESIGN.md` §8.1 of the converter: HMAC under
`HKDF-SHA256(package master key, info = "nxpkg-v1/ownership-decisions")`, `import_id`,
`source_fingerprint`, `package_header_sha256`, `sealed`, `matches_seal`, `audit.ok`, and each
entry's `binding == sha256(canonical record)`. `ADMIN_APPROVED_UNVERIFIED` stays distinct from
`PROVEN`; `QUARANTINED` / `REJECTED` / `PENDING` / stale services are never adopted. Nothing is
recomputed.

## 8. Admin page «مهاجرت از میرزا»

Steps: 1 upload · 2 verify · 3 dry run · 4 panels and customers · 5 money and ownership review ·
6 final approval · 7 import · 8 report, reconciliation, audit and backup. Persian, RTL, mobile,
`legacy.migration.*` permissions. Customer 360 gains a read-only «سوابق میرزا» card
(`legacy.history.view`).
