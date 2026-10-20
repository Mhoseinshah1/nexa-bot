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

## What the worker does, in order

1. **ARCHIVING** — a full, verified backup through the ordinary pipeline, titled «آرشیو ربات
   قبلی», delivered to the BACKUPS topic in parts. **Nothing is deleted unless every part has
   a recorded Telegram message id.** A failed backup or an incomplete delivery FAILS the run
   with nothing changed (`legacy_compaction.archive_failed` / `.archive_not_delivered`).
2. **MEASURING** — total relation size per table, rows per record type ("before").
3. **DROPPING** — deletes the record types the read map (below) found **unread**.
4. **DEDUPING** — deletes `archive_row` records of the invoice table whose invoice has a twin
   in `legacy_invoice_archive` (the copy every invoice reader reads). An archive row of any
   other table, or without a twin, stays.
5. **STRIPPING** — removes the top-level live-state flags (`affects_wallet`,
   `applies_to_live_state`, `grants_credit`, `creates_payment`, `redeemable`, …) from the kept
   payloads; every one is `false` on a stored record (a `true` was refused at ingest).
6. **VACUUMING** — `VACUUM (FULL, ANALYZE)` of `legacy_history_records` and
   `legacy_invoice_archive_staging`. **Maintenance window**: it takes an ACCESS EXCLUSIVE lock,
   so the legacy history pages wait; the Web Admin card says so, and
   `maintenance.legacy_compaction_vacuum` is recorded.
7. **COMPLETED** — the "after" sizes and counts beside the "before" on the card.

Steps 3–5 run in **keyset batches of 5000** by id: each batch, its cursor and **one audit row**
(`legacy.compaction.batch`: stage, rows, cursor — never a value) commit in one unit-of-work
transaction, which the recovery quiesce refuses and which checks scope activity. A restarted
worker (any replica, after the 15-minute lease) resumes after the last committed batch.
Migration 0262 keeps `legacy_history_records` append-only for everything else: an update or
delete is accepted only inside a transaction that named (`set_config`, transaction-local) a
compaction run of the row's tenant that is in DROPPING, DEDUPING or STRIPPING, and an update
may change the payload only.

## The read map

Built by searching the source for each record type by name and reading every hit; held to the
source by `tests/unit/legacy-compaction-read-map.test.ts` (a dropped type named in any API or
Web Admin file fails it). The tenant-wide «سوابق و تنظیمات» browser and the customer's history
card list whatever rows exist — a viewer of the archive, not a reader of a type; the archive
backup keeps every removed row restorable.

| Record type                                                                   | Read by                                                                         | Decision                           |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------- |
| payment                                                                       | money-history reader (customer money history); payment-history materialize step | keep                               |
| wallet_transaction                                                            | money-history reader; wallet-history step                                       | keep                               |
| wallet_history_check                                                          | money-history reader; money reconciliation                                      | **keep** (owner listed it)         |
| wallet_difference                                                             | money-history reader (reconciliation view)                                      | **keep** (owner listed it)         |
| service_operation                                                             | money-history reader; service history (records repository)                      | keep                               |
| service_cancellation_request                                                  | service history                                                                 | keep                               |
| service_ownership                                                             | service history (by invoice key)                                                | **keep** (owner listed it)         |
| panel_registry                                                                | records page: inactive panels                                                   | **keep** (owner listed it)         |
| category_catalogue                                                            | products materialize step                                                       | **keep** (owner listed it)         |
| product_mapping_proposal                                                      | products materialize step                                                       | **keep** (owner listed it)         |
| agent_profile, agent_price_level                                              | resellers materialize step                                                      | keep                               |
| agent_state                                                                   | resellers materialize step                                                      | **keep** (owner listed it)         |
| discount, discount_usage                                                      | discounts step; discount-usage history; money-history reader                    | keep                               |
| referral, wheel_result                                                        | money-history reader; referral / wallet steps                                   | keep                               |
| support_message, ticket, ticket_message                                       | ticket history (Customer 360, bot); ticket step                                 | keep                               |
| archive_row                                                                   | no type reader                                                                  | keep; **dedup** invoice twins only |
| panel_target, panel_mapping_template, configuration_row                       | none                                                                            | **drop**                           |
| manual_config_inventory, agent_invoice, agent_log, agent_usage, agent_request | none                                                                            | **drop**                           |
| ad_campaign, program_setting, support_department                              | none                                                                            | **drop**                           |

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
- **No table is dropped.** `legacy_service_candidates` is read by the service review/adoption
  lane; `legacy_invoice_archive_staging` is written by the invoice archive. Both stay (expand/
  contract); the staging table is vacuumed.
