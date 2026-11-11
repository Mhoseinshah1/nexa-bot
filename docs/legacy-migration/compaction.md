# Compacting the imported legacy data («فشرده‌سازی داده‌های ربات قبلی»)

Round 4 PR-E, E1. An **owner** action, **irreversible**, in the Web Admin («بکاپ و بازیابی»
→ «فشرده‌سازی داده‌های ربات قبلی»). Code: `apps/api/src/modules/platform/legacy-compaction/`.

## When it is offered

- `legacy.migration.apply` (CRITICAL, owner; the permission that started the import);
- an import `COMPLETED` / `COMPLETED_WITH_DISCREPANCY` / `ADOPT_DONE`, and **no import in
  flight** — decided again inside the request's transaction;
- the typed phrase `COMPACT LEGACY DATA`;
- once: a second request after a completed compaction is refused.

The request writes one `legacy_compaction_runs` row (REQUESTED) and a CRITICAL audit row.
The **worker** does the work (`LegacyCompactionExecutor`), never an HTTP request.

## Automatic, after a clean import (v0.9.7, «پاک‌سازی داده‌های انتقال»)

The owner refused a manual «پایان انتقال» button. The worker requests the run by itself
(`LegacyCleanupScheduler`, asked on every executor tick, evaluated at most hourly, as
`SYSTEM_JOB` under `maintenance.run`) when, for the tenant's latest finished import:

- the import is `COMPLETED` / `COMPLETED_WITH_DISCREPANCY` / `ADOPT_DONE` and none is in flight;
- its **balance reconciliation is clean**: the apply's REPORT step runs the cutover's
  reconciliation (`reconcileCutover`, the `cutover-reconcile` CLI's own code) while the package
  is open and the installation still frozen, and records the counts by kind in
  `apply_report.balanceReconciliation`. Clean = recorded and zero `BALANCE_DIFFERS`,
  `MISSING_IN_NEXA`, `AGENT_CREDIT_IN_WALLET` (`LEGACY_CLEANUP_BLOCKING_DIFFERENCES`). A missing
  one (an import recorded before v0.9.7, or one that could not be computed) is NOT clean. Not
  clean → nothing requested, one `maintenance.legacy_cleanup_reconciliation_differs`.
  `beginArchiving` decides the same rule again under the import lock, for the owner's request
  too (`legacy_compaction.reconciliation_not_clean`, before any archive is taken);
- a **backup destination** exists (`BackupService.deliveryDestination() !== 'NONE'`). None →
  nothing requested, one open `maintenance.legacy_cleanup_awaiting_backup_destination`
  («پاک‌سازی داده‌های انتقال منتظر تنظیم مقصد بکاپ است»), repeated at most daily; a destination
  appearing recovers it (`…_backup_destination_ready`) and the run is requested;
- no run since that import finished is active or COMPLETED **under the current rules**
  (`LEGACY_CLEANUP_REVISION`, PR-L: 2), and none FAILED in the last day (a failed run is retried
  daily). A later import is cleaned up in its own turn.

**Supplementary run («پاک‌سازی تکمیلی», PR-L).** Every run before PR-L is revision 1: its vacuum
was never proven (see VACUUMING), and it neither deduped the archive twins nor dropped the
wheel. A tenant whose import has a COMPLETED run of an older revision gets ONE more run, by the
same scheduler and under every rule above — the archive backup first, nothing deleted unless
every part reached Telegram — as a NEW row with `reason = SUPPLEMENTARY`, shown on the card as
«پاک‌سازی تکمیلی». The old row is never edited. Raise the revision only with a rule an
already-cleaned install must apply too.

## What the worker does, in order

1. **ARCHIVING** — a full, verified backup through the ordinary pipeline, titled «آرشیو ربات
   قبلی», delivered to the BACKUPS topic in parts. **Nothing is deleted unless every part has
   a recorded Telegram message id.** A failed backup or an incomplete delivery FAILS the run
   with nothing changed (`legacy_compaction.archive_failed` / `.archive_not_delivered`).
2. **MEASURING** — `ANALYZE` of the history (owner session, PR-L; a session that may not
   maintain the tables FAILS the run here, `legacy_compaction.vacuum_failed`, before any
   delete), then total relation size per table, rows per record type ("before").
3. **DEDUPING** (PR-L: before DROPPING, so a twin of a type DROPPING deletes still counts) —
   deletes an `archive_row` only when its twin exists for the same source key: an invoice in
   `legacy_invoice_archive` (the copy every invoice reader reads), or a typed record of
   `LEGACY_COMPACTION_ARCHIVE_TWINS` (`Payment_report`→`payment`, `wheel_list`→`wheel_result`,
   `service_other`→`service_operation`, `reagent_report`→`referral`,
   `wallet_transaction`→`wallet_transaction`, `discount_sell_used`→`discount_usage`,
   `Requestagent`/`requestagent`→`agent_request`) of the same tenant whose `provenance` names the
   SAME table (exact spelling) and the SAME `source_pk`. The type alone is not enough
   (`discount_usage` also carries `Giftcodeconsumed` rows). No twin: the row stays. The probe is
   an index lookup (`legacy_history_records_source_key_idx`, an online index).
4. **DROPPING** — deletes the record types the read map (below) found **unread**, and the raw
   archive rows of `LEGACY_COMPACTION_DROP_ARCHIVE_TABLES` (`wheel_list`: no lucky wheel).
5. **STRIPPING** — removes the top-level live-state flags (`affects_wallet`,
   `applies_to_live_state`, `grants_credit`, `creates_payment`, `redeemable`, …) from the kept
   payloads; every one is `false` on a stored record (a `true` was refused at ingest).
6. **CLEARING** (v0.9.7) — empties, for THIS tenant only, in batches, the import's working
   tables (`LEGACY_CLEANUP_CLEARED_TABLES`, in order): `legacy_trial_eligibility` (lifting, in
   the same statement, the trial limit of 0 the import itself imposed — still 0 and not set
   since; an operator's override is kept: owner decision, an imported customer MAY take a Nexa
   trial), `legacy_service_candidates`, `legacy_import_map`, and `legacy_invoice_archive_staging`
   rows of FINISHED archive runs. One audit row per batch (table, rows, trial limits lifted).
   Migration 0312 lets the candidates' and trial decisions' delete guard accept a delete only
   inside a transaction that named a run of the row's tenant in CLEARING.
7. **VACUUMING** — `VACUUM (FULL, ANALYZE)` of `legacy_history_records` and the four cleared
   tables. **Maintenance window**: it takes an ACCESS EXCLUSIVE lock,
   so the legacy history pages wait; the Web Admin card says so, and
   `maintenance.legacy_compaction_vacuum` is recorded. It runs on its own session without
   the statement timeout (`lock_timeout` kept), because a VACUUM FULL of a multi-GB table cannot
   finish within `DATABASE_STATEMENT_TIMEOUT_MS` (15 s default), which failed v0.9.7's runs.
   **PR-L: as the tables' owner (`DATABASE_URL`), and proven.** PostgreSQL 16 lets only a
   table's owner vacuum it and answers anyone else with `WARNING: permission denied to vacuum
…, skipping it` and success. The processes connect as `nexa_app` (ADR-0037), which owns no
   table, so until PR-L the stage vacuumed nothing and the run COMPLETED anyway (the owner's
   v0.9.13 run: every "after" size byte-identical to "before"). Now each table must be owned by
   the session, a WARNING is a failure, and the table must have been rewritten (its file node
   changed); otherwise the run FAILS with `legacy_compaction.vacuum_failed` (a `lock_timeout`
   is retried three times first) and is retried daily. One audit row names the tables proven.
8. **COMPLETED** — `vacuumed_at` set (a CHECK refuses a revision-2 run COMPLETED without it);
   the "after" sizes, measured AFTER the vacuum, and counts beside the "before" on the card, and
   the operations group's `maintenance.legacy_compaction_completed` carries `sizes`
   (`history 1952→410 · map 162→0 · …`, MiB).

Steps 3–5 run in **keyset batches of 5000** by id (step 6 in batches of 5000 that each delete
what they picked, so it needs no cursor): each batch, its cursor and **one audit row**
(`legacy.compaction.batch`: stage, rows, cursor — never a value) commit in one unit-of-work
transaction, which the recovery quiesce refuses and which checks scope activity. A restarted
worker (any replica, after the 15-minute lease) resumes after the last committed batch.
Migration 0266 keeps `legacy_history_records` append-only for everything else: an update or
delete is accepted only inside a transaction that named (`set_config`, transaction-local) a
compaction run of the row's tenant that is in DROPPING, DEDUPING or STRIPPING, and an update
may change the payload only.

## The read map

Built by searching the source for each record type by name and reading every hit; held to the
source by `tests/unit/legacy-compaction-read-map.test.ts` (a dropped type named in any API or
Web Admin file fails it). The tenant-wide «سوابق و تنظیمات» browser and the customer's history
card list whatever rows exist — a viewer of the archive, not a reader of a type; the archive
backup keeps every removed row restorable.

| Record type                                                                   | Read by                                                                           | Decision                                                                                         |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| payment                                                                       | money-history reader (customer money history); payment-history materialize step   | keep                                                                                             |
| wallet_transaction                                                            | money-history reader; wallet-history step                                         | keep                                                                                             |
| wallet_history_check                                                          | money-history reader; money reconciliation                                        | **keep** (owner listed it)                                                                       |
| wallet_difference                                                             | money-history reader (reconciliation view)                                        | **keep** (owner listed it)                                                                       |
| service_operation                                                             | money-history reader; service history (records repository)                        | keep                                                                                             |
| service_cancellation_request                                                  | service history                                                                   | keep                                                                                             |
| service_ownership                                                             | service history (by invoice key)                                                  | **keep** (owner listed it)                                                                       |
| panel_registry                                                                | records page: inactive panels                                                     | **keep** (owner listed it)                                                                       |
| category_catalogue                                                            | products materialize step                                                         | **keep** (owner listed it)                                                                       |
| product_mapping_proposal                                                      | products materialize step                                                         | **keep** (owner listed it)                                                                       |
| agent_profile, agent_price_level                                              | resellers materialize step                                                        | keep                                                                                             |
| agent_state                                                                   | resellers materialize step                                                        | **keep** (owner listed it)                                                                       |
| discount, discount_usage                                                      | discounts step; discount-usage history; money-history reader                      | keep                                                                                             |
| referral                                                                      | money-history reader; referral step                                               | keep                                                                                             |
| wheel_result                                                                  | none (PR-L: the money history, reconciliation and wallet step stopped reading it) | **drop** (owner: no lucky wheel)                                                                 |
| support_message, ticket, ticket_message                                       | ticket history (Customer 360, bot); ticket step                                   | keep                                                                                             |
| archive_row                                                                   | no type reader                                                                    | keep; **dedup** rows with a twin (invoice, `LEGACY_COMPACTION_ARCHIVE_TWINS`); drop `wheel_list` |
| panel_target, panel_mapping_template, configuration_row                       | none                                                                              | **drop**                                                                                         |
| manual_config_inventory, agent_invoice, agent_log, agent_usage, agent_request | none                                                                              | **drop**                                                                                         |
| ad_campaign, program_setting, support_department                              | none                                                                              | **drop**                                                                                         |

Re-run safety: the materialize steps that read by type keep their types; the importer's
idempotency keys (`legacy-import:*`, `legacy:*` in `request_idempotency`) are never pruned (E3).

## What it deliberately does NOT do

- **`*_raw` / `*_note` keys are kept.** `fields_raw`, `owner_value_raw` and `parse_note` are
  read by the materialize steps and the redaction allowlists; stripping them would break a
  re-run and change what the history card shows.
- **`schema`, `provenance`, `idempotency_key`, `semantics`, `owner_relation_basis`,
  `review_codes` are kept.** `summaryOf` reads `schema` and `provenance.source_table`, the
  reseller step reads `idempotency_key`, and the rest are shown by the history card.
- **Payment payloads are not reduced** to "what the payments table lacks": the history card
  shows the redacted payload and the money-history reader reads payload paths; no reduction is
  safe without an owner review of that card (open follow-up).
- **No table is dropped** (expand/contract): CLEARING empties rows, the tables stay.
- **`legacy_invoice_archive` is never cleared** (every invoice reader, the customer's history
  card), nor customers, wallets, the ledger, services, resellers, products, orders, payments,
  `wallet_history_imports`, `legacy_import_runs` or the importer's idempotency keys.

## Readers of the cleared tables (v0.9.7)

Each answers once the rows are gone; `tests/integration/legacy-import-cleanup.test.ts` holds it.

| Reader                                                         | After the cleanup                                  |
| -------------------------------------------------------------- | -------------------------------------------------- |
| terms exemption (`drizzle-terms.repository.ts`)                | `customers.source = 'MIRZA'` still says imported   |
| service history `invoiceKeysOfService`, `adoptionsForCustomer` | `services.source_ref = 'invoice:<key>'` fallback   |
| customer's invoices card (`invoicesForCustomer`)               | invoice shown, its candidate `null`                |
| held-services review / adopt lane, manual-review queue         | empty lists                                        |
| per-invoice outcome (`importOutcome`)                          | `null` (the card is removed in PR-5)               |
| customer bot link (`countEligible`)                            | 0 — the import links its customers itself          |
| trial check (`trialAllowanceFor`)                              | never read the decision table; the limit is lifted |
| importer, materialize, cutover CLI, fresh-target guard         | import-time only; a new import is a fresh target   |
