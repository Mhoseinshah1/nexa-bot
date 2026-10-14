# Mirza → NEXA Fresh Migration: what moves, where it lands, what does not

Status: **built and tested on synthetic packages only.** No real backup has been imported. This
page is the coverage the importer on this branch implements, with the code that decides each
line. Design: [`nxpkg-importer.md`](nxpkg-importer.md); rehearsal: [`nxpkg-real-rehearsal.md`](nxpkg-real-rehearsal.md).

## 1. Three paths, and nothing else

A row of the Mirza backup reaches NEXA through exactly one of them:

| Path                     | Package files                                                       | NEXA                                                                                                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Source snapshot**   | `source/catalog.json`, `source/tables/{user,invoice,product}.jsonl` | NEXA's existing legacy importer re-derives customers, opening balances, legacy debts, trial eligibility, the product review, service candidates (and adoption) and the invoice archive from the raw rows. |
| **B. Operational files** | `records/{customers,wallet_opening_balances,legacy_debts}.jsonl`    | Never written to NEXA: compared, count and sum, with the importer's own plan at the dry run. Any difference is `DRY_RUN_MISMATCH` and stops the migration.                                                |
| **C. History records**   | every other `records/**.jsonl`                                      | `legacy_history_records`, read-only, shown on the customer's «سوابق میرزا» card. Never a balance, ledger entry, order, payment, service, ticket, discount, referral or role.                              |

Every legacy table is also accounted for by name in the dry run: one `table:<class>:<name>`
section each, with the converter's own row breakdown (§5a of the design). A production-like
import refuses a package with any table NEXA cannot classify (`TABLE_INVENTORY_INCOMPLETE`).

## 2. The categories asked about

| Category                                    | Mirza source (converter evidence)                                                                                                               | Converter output                                                                          | NEXA destination                                                                                                                                                                                                                             | Counted in the dry run                                        |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **Purchase / invoice history**              | `invoice` (all statuses)                                                                                                                        | snapshot `invoice.jsonl` (+ `records/invoices.jsonl`, compared nowhere)                   | `legacy_invoice_archive`: **every** invoice row, any status, test or not                                                                                                                                                                     | `invoice_archive`, `table:SUPPORTED:invoice`                  |
| **Wallet / balance history**                | `wallet_transaction` (ARCHIVE)                                                                                                                  | `wallet_history.jsonl`, `wallet_history_checks.jsonl`, `wallet_difference_analysis.jsonl` | history `wallet_transaction`, `wallet_history_check`, `wallet_difference`. The **balance itself** is the opening balance from `user.Balance` (path A), never replayed                                                                        | `history:wallet_*`, `wallet_openings`, `legacy_debts`         |
| **Payment records**                         | `Payment_report` (ARCHIVE) — the only payment-row table                                                                                         | `payments.jsonl`                                                                          | history `payment` only. **No** NEXA `payments` row, ledger entry or revenue (a Fresh target must have zero payments)                                                                                                                         | `history:payment`, `table:ARCHIVE:Payment_report`             |
| **Service history**                         | `service_other`, `cancel_service` (ARCHIVE)                                                                                                     | `service_operations.jsonl`, `service_cancellation_requests.jsonl`                         | history `service_operation`, `service_cancellation_request`                                                                                                                                                                                  | `history:service_*`                                           |
| **Live services**                           | `invoice` with a live status (`active`, `disabled`, `disabledn`, `disablebyadmin`, `end_of_volume`)                                             | snapshot rows                                                                             | `legacy_service_candidates`; adopted onto the bound RickPanel **only** when the panel inventory proves the account (never created on the panel); otherwise review/history                                                                    | `services` (imported = adopted, archived, quarantined = held) |
| **Test (trial) services**                   | `invoice.is_test = 1`                                                                                                                           | snapshot rows                                                                             | **never adopted** (`TEST_INVOICE_SKIPPED`); kept in `legacy_invoice_archive`; the user's trial use goes to `legacy_trial_eligibility` (no second free trial)                                                                                 | `services` (archived), `trials`                               |
| **Expired / removed services**              | `invoice` with any non-live status                                                                                                              | snapshot rows                                                                             | `legacy_invoice_archive` only: no candidate, no service                                                                                                                                                                                      | `invoice_archive`                                             |
| **Agency / reseller**                       | `user.agent`; `agent_manage`, `agent_invoice`, `agent_log`, `agent_usage_snapshot`, `custom_service_tier_prices`, `Requestagent`/`requestagent` | `records/agents/*.jsonl`                                                                  | the agent is an **ordinary customer** (reported `legacyIsAgent`); history `agent_profile`, `agent_invoice`, `agent_log`, `agent_usage`, `agent_price_level`, `agent_request`, `agent_state`. **No** NEXA reseller row, tier, price or credit | `history:agent_*`                                             |
| **Support tickets**                         | `support_message` (ARCHIVE), `departman` (CONFIGURATION), `ticket`, `ticket_message` (REVIEW)                                                   | `records/support/*.jsonl`                                                                 | history `support_department`, `support_message`, `ticket`, `ticket_message` (text redacted on display). **No** NEXA ticket is opened                                                                                                         | `history:support_*`, `history:ticket*`                        |
| **Discounts, gift codes, referrals, wheel** | `Discount`, `DiscountSell`, `discount_sell(_used)`, `Giftcodeconsumed`, `reagent_report`, `wheel_list`, `affiliates`, `ad_campaign`             | `records/engagement/*.jsonl` (codes themselves are not carried)                           | history only; no redeemable discount, no referral attribution, no commission                                                                                                                                                                 | `history:discount*`, `history:referral`, …                    |
| **Configuration**                           | `setting`, `PaySetting` (allow-listed keys), `shopSetting`, `textbot`, `channels`, `help`, `app`, `protocol`                                    | `records/configuration/*.jsonl`                                                           | history `configuration_row`: reference for the operator, **never applied**                                                                                                                                                                   | `history:configuration_row`                                   |
| **Panels**                                  | `marzban_panel` (credentials never read)                                                                                                        | `panel_registry.jsonl`, `panel_target_mapping.jsonl`                                      | history; the panel is **bound by the admin** to an existing RickPanel in NEXA; no credential comes from the package                                                                                                                          | `history:panel_*`                                             |

## 3. Not supported (explicitly)

1. **Not carried at all** (counted by name and rows, `SECRETS_MANUAL` / `OWNER_DECISION`):
   `admin` (web-panel logins), `botsaz` (sub-bot tokens), `card_number`, `logs_api`,
   `topicid`, `global_hidden_gateways`, `ai_business_chat`; every secret column (tokens,
   passwords, subscription links, UUIDs); discount and gift **code strings**.
2. **`user` columns the converter does not stage** (listed in its `coverage.json` as
   `unmapped_columns`): e.g. the referrer id, `score`, `lang`, `verify`, `register`,
   `description_blocking`, `cardpayment`. Not in NEXA.
3. **History only, never operational**: payments, wallet transactions, service operations,
   reseller data, discounts, referrals, tickets, configuration. Re-creating any of them as live
   NEXA data (a reseller tier, an open ticket, a redeemable code) is a manual act after the
   migration, by an owner decision.
4. **Trials** are never adopted as services; expired services are never re-created.
5. **A service is adopted only when the RickPanel inventory proves it.** In the isolated
   rehearsal the panel is a read-only stand-in with an EMPTY inventory unless one is supplied,
   so live services are reported but not adopted there (see the rehearsal guide, Stage B).
6. Rows of a fork table that has no storable column are counted `review` by the converter
   (`TABLE_NOT_STAGED`) and reach no record; they show as `quarantined` in their
   `table:` section.

## 4. Where a count could be lost, and what stops it

| Risk                                                                       | Guard                                                                                                                                                        |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A table nobody classified                                                  | Converter: `UNCLASSIFIED_TABLE` blocks the package. NEXA: `TABLE_INVENTORY_INCOMPLETE` warning; refused on a production-like target and by the cutover gate. |
| Rows of a classified table not accounted                                   | Converter: `COVERAGE_INCOMPLETE` blocks. NEXA: such a table stays `UNCLASSIFIED` (rule in §5a).                                                              |
| A file or record type NEXA does not know                                   | The history ingest refuses an unknown file under `records/`, an unknown or misfiled `record_type` and any live flag, before writing (`record-map.ts`).       |
| A package altered after conversion                                         | AES-256-GCM STREAM per chunk, a manifest of SHA-256 per file; any change fails `VERIFY` (`NXPKG_*`).                                                         |
| The converter's customers / openings / debts differ from NEXA's derivation | `DRY_RUN_MISMATCH` (count and sum).                                                                                                                          |
| History written partially                                                  | Two passes: the second writes only after the first validated every line; written must equal validated (`source_changed` otherwise); idempotent keys.         |

Not cross-checked today (an owner decision, listed in the rehearsal guide §9): NEXA does not
compare its service-candidate and invoice-archive counts with the converter's
`services.jsonl` / `invoices.jsonl` (the same rows feed both through path A), and does not read
the converter's `reconciliation.json`. The operator compares them by hand in the rehearsal
(§6 of the rehearsal guide).
