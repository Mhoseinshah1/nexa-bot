# ADR-0039 — Hosted-bot backups, restore, open export, server move, enter and erasure

**Status:** Accepted (Phase 6B PR-0, 2026-11-09), owner decisions D5, D6 and D7. Refines
[ADR-0038](0038-hosted-bots.md) § «ورود به پنل», § Backups and § Open. Keeps
[ADR-0025](0025-backup-pipeline.md) and [ADR-0037](0037-row-level-security.md) unchanged — the one
place this phase would have had to amend ADR-0025 (§ 6) is recorded as **not done** instead. The
number is provisional; the lead renumbers it at merge if another PR claims it.

Every later Phase 6B PR follows this record, and any change to the design is made here, in that
same PR.

## Context

One installation hosts the owner's bot and any number of hosted bots, each a `HOSTED` tenant
(ADR-0038). Today a backup is `pg_dump` of the whole database (ADR-0025): every tenant is in it,
and nothing can be restored one tenant at a time. The owner decided (binding, phase prompt):

- he sets every hosted bot's backup password; hosted owners cannot change it;
- hosted backups must not pile into his own archive files or his Telegram backup topic;
- every hosted backup restores on ANOTHER Nexa install with only the archive and its password;
- a hosted bot's data is exportable in plain, documented formats;
- the whole server can move to another data centre;
- he has full access to every hosted install, and his actions there write no row to that
  tenant's audit log (they go to his own);
- billing is out of scope.

What this record builds on, read for it (paths under `apps/api/src/`):

| Piece                                      | Where                                                                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| The six-stage pipeline, one `run()`        | `modules/platform/backup/application/backup.service.ts`                                                                   |
| 7z with the password, parts, memory limits | `modules/platform/backup/infrastructure/{archiver,seven-zip,seven-zip-levels,archive-parts}.ts`                           |
| The key bundle, tenant-agnostic            | `infrastructure/crypto/key-bundle.ts` (`sealKeyBundle`, `openKeyBundle`; "the per-tenant backups of Phase 6B reuse them") |
| Secrets, AAD `purpose‖tenantId‖entityId`   | `infrastructure/crypto/secret-cipher.ts`, `secret-registry.ts` (every ciphertext column)                                  |
| Row exclusions (two tables, whole)         | `modules/platform/backup/infrastructure/backup-exclusions.ts`                                                             |
| Restore, migrate-forward, cutover          | `modules/platform/recovery/application/recovery-executor.ts`, `infrastructure/persistence/migration-state.ts`             |
| The heavy-job queue                        | `modules/platform/capacity/application/heavy-job-gate.ts`, `heavy_job_tickets`                                            |
| Cross-tenant port, system path             | `modules/platform/hosting/infrastructure/drizzle-hosted-tenant-system-path.ts`, `tests/unit/system-path-allowlist.ts`     |
| Audit writer (tenant from the scope)       | `modules/platform/audit/infrastructure/drizzle-audit-writer.ts`                                                           |
| Hosted domains, activation steps           | `hosted_bot_activations`, `modules/platform/hosting/application/hosted-activation.service.ts`, `docs/deployment.md`       |
| `botctl`                                   | `deploy/bin/botctl`, `deploy/bin/nexa-lib.sh`                                                                             |

## 1. Inventory: every table, classified

Generated from the schema (`apps/api/src/infrastructure/persistence/schema/*.ts`, every
`pgTable`) on `origin/main` `1e48c0d6`: **226 tables**. **219 carry a `tenant_id` column**, and
`tenants` is keyed by the tenant's own `id`, so **220 are tenant-keyed**. The six with no tenant
at all are `aggregate_sequences`, `backup_runs`, `backup_run_parts`, `installation_keys`,
`process_runs` and `processed_messages` — exactly ADR-0037's list.

Three classes, decided per table for a **tenant archive** (the installation backup is still the
whole database, § 6):

- **TENANT** — exported in a tenant archive: the tenant's rows, selected by `tenant_id`, or by a
  stated join for the three tables keyed otherwise.
- **INSTALLATION** — the installation's own state or the owner's register of what he hosts. Never
  in a tenant archive. A hosted tenant's rows in a tenant-keyed one (there should be none) are not
  exported, and their count is written into the manifest's `notExported`, with the reason.
- **NEVER** — the tenant's rows, deliberately left out of its archive: bound to this server's live
  processes or to live access credentials, so restoring them anywhere is meaningless or
  dangerous. Their counts are written into `notExported` too.

### INSTALLATION (13)

| Table                                            | Why                                                                                                  |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `backup_runs`, `backup_run_parts`                | the installation's archive history (no tenant)                                                       |
| `installation_keys`, `process_runs`              | key management and process state (no tenant)                                                         |
| `hosted_bots`, `hosted_bot_activations`          | the owner's register (`tenant_id` = installation). Carried as **host facts** in the manifest, § 2    |
| `hosted_bot_activation_links`                    | one-time links the owner issued; an unused one must not travel                                       |
| `hosting_totp_factors`, `hosting_recovery_codes` | the owner's section factor                                                                           |
| `hosting_sessions`                               | the owner's section sessions                                                                         |
| `recovery_requests`, `secret_reentry_items`      | whole-installation restores                                                                          |
| `backup_archive_passwords`                       | the installation's own archive password; a hosted bot's password lives in an installation table, § 7 |

### NEVER (8)

| Table                    | Why leaving it out is right                                                                                                               |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `admin_sessions`         | live sign-in sessions (a token hash, globally unique). A restore anywhere signs everyone out; carrying them would resurrect cookies       |
| `admin_login_challenges` | minutes-long second-factor challenges                                                                                                     |
| `admin_login_throttle`   | sign-in counters; already excluded from the installation dump for the same reason (`backup-exclusions.ts`)                                |
| `admin_read_windows`     | one-day bulk-read alert windows; a restore restarts the window and costs one possible duplicate alert                                     |
| `ops_log_connect_codes`  | ten-minute group-connect codes                                                                                                            |
| `heavy_job_tickets`      | this server's live queue (leases)                                                                                                         |
| `panel_probe_claims`     | connection-test cooldowns; already excluded from the installation dump                                                                    |
| `tenant_capacity_limits` | the HOST's policy for this tenant (set in «میزبانی‌ها»), not the tenant's data: carried in the manifest's host facts, applied by the host |

### TENANT, keyed otherwise (3)

| Table                 | Selected by                                                                                                                                                                                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tenants`             | `id` = the tenant. A tenant with children (`parent_tenant_id` = it) is refused (`tenant_archive.has_child_tenants`): no production path creates one under a hosted tenant today, and a subtree archive is a separate decision                   |
| `processed_messages`  | `message_id` ∈ the tenant's `outbox_messages.id` — the consumers' dedupe rows for the messages the archive carries (ADR-0025's own example of a table that is not a cache)                                                                      |
| `aggregate_sequences` | `(aggregate_type, aggregate_id)` owned by the tenant, through an `AGGREGATE_OWNERSHIP` map (each `AGGREGATE_TYPES` member → the tenant table its id is a row of, or `NOT_TENANT_OWNED` with a reason). Never `MAX(sequence)`: ADR-0025 says why |

### TENANT (202)

Everything else, selected by `tenant_id` (and, for `audit_logs`, whose `tenant_id` is nullable,
only rows naming the tenant):

| Schema file            | n   | Tables                                                                                                                                                                                                                                                                                                             |
| ---------------------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `broadcasts.ts`        | 9   | `frozen_audiences`, `frozen_audience_members`, `broadcasts`, `broadcast_media`, `broadcast_media_handles`, `broadcast_recipients`, `broadcast_bot_pacing`, `bulk_operations`, `bulk_operation_items`                                                                                                               |
| `business-chats.ts`    | 8   | `telegram_wizards`, `telegram_review_messages`, `telegram_message_horizons`, `telegram_business_connections`, `business_conversations`, `business_messages`, `business_outbound_messages`, `business_conversation_escalations`                                                                                     |
| `catalogue.ts`         | 6   | `product_categories`, `products`, `service_addons`, `delivery_tutorials`, `client_apps`, `client_app_videos`                                                                                                                                                                                                       |
| `control-plane.ts`     | 10  | `bot_appearance_slots`, `template_overrides`, `template_revisions`, `setting_values`, `main_menu_revisions`, `main_menu_layouts`, `feature_flag_states`, `custom_menu_button_media`, `custom_menu_buttons`, `custom_menu_button_bots`                                                                              |
| `custom-services.ts`   | 3   | `custom_service_locations`, `custom_service_price_rules`, `order_custom_service_terms`                                                                                                                                                                                                                             |
| `customers.ts`         | 11  | `customers`, `customer_text_captures`, `customer_location_change_overrides`, `customer_direct_messages`, `terms_versions`, `terms_acceptances`, `customer_captchas`, `customer_tags`, `customer_tag_assignments`, `customer_notes`, `miniapp_sessions`                                                             |
| `eventing.ts`          | 4   | `outbox_messages`, `request_idempotency`, `audit_logs`, `operational_events`                                                                                                                                                                                                                                       |
| `gateway-invoices.ts`  | 7   | `gateway_invoices`, `gateway_invoice_cards`, `gateway_card_changes`, `gateway_provider_requests`, `gateway_invoice_provider_facts`, `gateway_receipt_captures`, `gateway_receipt_submissions`                                                                                                                      |
| `gateways.ts`          | 7   | `payment_accounts`, `payment_gateways`, `payment_gateway_credentials`, `gateway_customer_numbers`, `payment_gateway_call_budgets`, `fx_quotes`, `fx_source_states`                                                                                                                                                 |
| `identity.ts`          | 8   | `admins`, `roles`, `role_permissions`, `admin_roles`, `admin_permission_overrides`, `admin_known_ips`, `admin_totp_factors`, `admin_backup_codes`                                                                                                                                                                  |
| `legacy-history.ts`    | 8   | `legacy_invoice_archive`, `legacy_wallet_debts`, `legacy_service_candidates`, `legacy_cutover_approvals`, `legacy_cutover_approval_revocations`, `legacy_nxpkg_imports`, `legacy_history_records`, `legacy_compaction_runs`                                                                                        |
| `legacy-import.ts`     | 9   | `legacy_product_shapes`, `legacy_trial_eligibility`, `legacy_import_runs`, `legacy_import_map`, `legacy_import_run_inputs`, `legacy_read_set_runs`, `legacy_product_reviews`, `legacy_invoice_archive_runs`, `legacy_invoice_archive_staging`                                                                      |
| `marketing.ts`         | 8   | `discounts`, `discount_redemptions`, `discount_code_captures`, `cashback_rules`, `order_cashback`, `cashback_reversals`, `campaigns`, `campaign_actions`                                                                                                                                                           |
| `notifications.ts`     | 9   | `notifications`, `notification_released_claims`, `notification_delivery_attempts`, `customer_notifications`, `customer_notification_rate_windows`, `customer_reminder_raise_counters`, `ops_log_groups`, `ops_log_topics`, `admin_notification_reads`                                                              |
| `ops.ts`               | 7   | `incidents`, `incident_targets`, `incident_effects`, `incident_events`, `incident_communications`, `incident_notices`, `data_compaction_runs`                                                                                                                                                                      |
| `orders.ts`            | 5   | `panel_capacity_reservations`, `username_captures`, `service_username_reservations`, `orders`, `order_panel_placements`                                                                                                                                                                                            |
| `panels.ts`            | 9   | `panels`, `panel_credentials`, `panel_health`, `panel_policies`, `panel_probe_budgets`, `panel_monitor_schedule`, `panel_monitor_tenants`, `panel_trial_configs`, `panel_setting_values`                                                                                                                           |
| `payments.ts`          | 5   | `payments`, `receipt_captures`, `payment_receipts`, `payment_destinations`, `payment_destination_switches`                                                                                                                                                                                                         |
| `provisioning.ts`      | 2   | `provisioning_operations`, `operation_card_messages`                                                                                                                                                                                                                                                               |
| `referrals.ts`         | 5   | `referrals`, `referral_codes`, `order_referral_commissions`, `referral_commission_reversals`, `referral_signup_gifts`                                                                                                                                                                                              |
| `refunds.ts`           | 4   | `refunds`, `admin_amount_captures`, `service_refund_requests`, `service_refund_request_pushes`                                                                                                                                                                                                                     |
| `resellers.ts`         | 12  | `reseller_tiers`, `reseller_tier_product_prices`, `reseller_tier_grants`, `resellers`, `reseller_entitlement_overrides`, `reseller_grant_overrides`, `reseller_minimum_notices`, `order_reseller_terms`, `reseller_request_questions`, `reseller_requests`, `reseller_request_messages`, `reseller_request_drafts` |
| `service-lifecycle.ts` | 9   | `trial_resets`, `trial_limit_overrides`, `trial_grants`, `service_ownership_transfers`, `customer_account_transfers`, `service_location_changes`, `service_auto_renew_preferences`, `service_auto_renew_runs`, `service_auto_delete_runs`                                                                          |
| `services.ts`          | 6   | `services`, `service_reminders`, `service_reminder_baselines`, `service_usage_snapshots`, `service_locations`, `service_commercial_actions`                                                                                                                                                                        |
| `support.ts`           | 7   | `support_faqs`, `support_faq_seeds`, `ticket_categories`, `ticket_category_seeds`, `tickets`, `ticket_messages`, `ticket_reply_files`                                                                                                                                                                              |
| `support-ai.ts`        | 7   | `support_ai_configs`, `support_ai_provider_credentials`, `support_ai_runs`, `support_ai_jobs`, `support_ai_ticket_jobs`, `support_ai_ticket_holds`, `support_ai_image_outcomes`                                                                                                                                    |
| `support-knowledge.ts` | 6   | `support_learning_candidates`, `support_knowledge_articles`, `support_knowledge_revisions`, `support_learning_jobs`, `support_knowledge_builds`, `support_knowledge_build_proposals`                                                                                                                               |
| `tenancy.ts`           | 3   | `bot_instances`, `bot_command_syncs`, `tenant_media_assets`                                                                                                                                                                                                                                                        |
| `wallet.ts`            | 8   | `wallet_entries`, `wallet_history_imports`, `receipt_credits`, `receipt_review_pushes`, `wallet_threshold_alerts`, `gift_card_batches`, `gift_card_codes`, `gift_card_redemption_attempts`                                                                                                                         |

13 + 8 + 3 + 202 = 226. Notes on the choices that look surprising:

- **Dedupe and replay ledgers are exported**, never "cleaned": `request_idempotency`,
  `processed_messages`, `miniapp_sessions` (its expired rows are what refuse a replayed launch),
  `notification_released_claims`, the rate windows and budgets. ADR-0025's rule — a table's name
  is not evidence of its role — applies to tenant archives too.
- **Blobs are rows.** Every uploaded file is `bytea` in the database (`broadcast_media`,
  `client_app_videos`, `custom_menu_button_media`, `tenant_media_assets`, `ticket_reply_files`, a
  product image, a customer capture). The only file paths are `legacy_nxpkg_imports.file_path` and
  `decisions_file_path`: the uploaded package of a FINISHED import, not carried; the rows are.
- A RUNNING lifecycle row (`data_compaction_runs`, `legacy_compaction_runs`,
  `service_auto_renew_runs`, the support-AI jobs) restores with a lease no process holds, and each
  is already taken over by FAILING it when stale — never adopted (ADR-0025).

**The test (PR-1, because PR-0 is docs only).** `tenant-archive-inventory.ts` (the classification
above, as data; the export engine is driven by it) and `tests/unit/tenant-archive-inventory.test.ts`,
which fails when a `pgTable` in `schema.ts` has no class, when a class names a table that does not
exist, and when the tenant-keyed count differs from the `tenant_id` columns. The integration
suite adds the same check against `pg_catalog`, and the exporter refuses at run time
(`tenant_archive.unclassified_table`) a live table the release does not classify.

## 2. The tenant archive format

**A logical export of one tenant, not `pg_dump`.** `pg_dump` has no row filter
(`backup-exclusions.ts` says so), so a tenant cannot be dumped by it.

- **One snapshot.** Every table is read in ONE `REPEATABLE READ READ ONLY` transaction, so the
  archive is one instant of the tenant, as `pg_dump` gives the whole database.
- **Bound to the tenant, and named.** The export runs as `nexa_app` with the hosted tenant bound
  (`app.current_tenant_id`), and every statement also carries `WHERE tenant_id = $1`. Row-level
  security therefore makes a missed predicate return nothing instead of another tenant's rows —
  the isolation proof is in the database, not only in the SQL. An export whose connection
  bypasses RLS (still on the owner role, ADR-0037 rollout) is refused
  (`tenant_archive.rls_bypassed`): hosted bots require RLS already (ADR-0038 production gate).
  Binding another tenant's scope from installation work is itself pinned as a system-path entry
  (§ Cross-cutting).
- **Parts.** One `COPY (SELECT <columns> … ORDER BY <primary key>) TO STDOUT` per table, in
  PostgreSQL's text format, with the session pinned (`TimeZone=UTC`, `DateStyle=ISO`,
  `extra_float_digits=3`, `bytea_output=hex`, `client_encoding=UTF8`) so the bytes are a
  function of the data. Tables in FK-safe order (parents first), computed from `pg_catalog` at
  export and recorded; the FK graph among TENANT tables must be acyclic apart from
  self-references (the inventory test asserts it), and a self-referencing table orders its rows
  parents first.
- **Secrets are re-sealed under a per-archive key, never the installation's.** Each
  `SECRET_REGISTRY` column of the tenant's rows is decrypted with this server's keyring and
  encrypted again under a fresh random 256-bit **archive key** (key id `archive:<archiveId>`),
  with the SAME `SecretContext` (purpose, tenant id, entity id) — ids are kept (§ 4), so the AAD
  stays valid. `keys.json` is `sealKeyBundle({ keys: [archiveKey], password, backupId })`,
  unchanged code. **Why not bundle the keyring as the installation backup does:** that bundle
  carries this server's own KEK (`docs/backup.md`: the archive plus its password expose it). A
  hosted archive is meant to leave the server, may sit in the hosted bot's own operations group
  (§ 7) and restores on strangers' installs; carrying the KEK would make one leaked hosted
  password a key to every tenant's secrets in any copy of the installation dump. The archive key
  opens this tenant's secrets and nothing else.
- **7z**, through the existing archiver: AES-256 with the hosted bot's backup password (§ 7),
  encrypted headers (`-mhe=on`), LZMA2 with the same memory-bounded levels
  (`seven-zip-levels.ts`), non-solid, split into ≤ 45 MiB parts as installation archives are. The
  password reaches 7-Zip on stdin. It opens in 7-Zip on Windows with the password alone; the
  CSVs inside are PostgreSQL text-format COPY, documented in the manifest (columns, types).

Entries:

```
manifest.json      format "nexa.tenant-archive", formatVersion 1
data/NNNN-<table>.copy   one per TENANT table with rows, NNNN = load order
keys.json          the key bundle: ONE archive key
```

`manifest.json` holds, and nothing else:

- `archiveId` (the run id), `createdAt` (the snapshot's start, UTC);
- `source`: the installation id, the release (version and image digest), PostgreSQL version;
- `migrations`: the head as `migration-state.ts` reads it — count, last tag, last hash;
- `tenant`: id, kind (`HOSTED`), slug, display name, locale, timezone, calendar, currency;
- `host` (the host facts, from the INSTALLATION register): the register state and expiry, the
  domain (no DNS/TLS/webhook marks: they were earned on this server), bot username and Telegram
  bot id, and the `tenant_capacity_limits` rows;
- `tables`: per table in load order — name, columns with types, row count, SHA-256 of its part;
- `notExported`: per INSTALLATION/NEVER table with tenant rows — name, count, reason;
- `secrets`: count per purpose (never an id or a value), the archive key's id;
- `exclusions: []` (ADR-0025's array, kept for the same reason).

The manifest is inside the encrypted container: it names a domain and a bot.

## 3. Schema-version policy for restore

The archive's head is compared with the target's by `compareMigrations`
(`migration-state.ts`), the function the recovery executor already uses.

| Verdict                           | Decision                                                                                                                                                                                                                                                                            |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| equal                             | restore directly: scratch at the target head (§ 5), then copy                                                                                                                                                                                                                       |
| archive older (target is AHEAD)   | create the scratch database, migrate it to the **archive's** head (the target ships every earlier migration: the migrator is run against a migrations folder whose journal is truncated at the archive's tag), load the rows, migrate the scratch **up** to the target's head, copy |
| archive newer (target is BEHIND)  | refuse, `tenant_archive.head_newer`, «اول نکسای مقصد را به‌روز کنید»                                                                                                                                                                                                                |
| diverged (same index, other hash) | refuse, `tenant_archive.head_diverged`: the two installs ran different code under one migration number; nothing guessed                                                                                                                                                             |

Migrating the scratch up runs the release's migrations against ONE tenant's rows: a backfill that
assumes the installation tenant exists finds none there and must not fail for it (PR-1 runs the
oldest supported archive head through every later migration in a test). The scratch is never the
live database: the executor's `migrateCandidate` refuses the live name, and so does this.

## 4. Restore target

- **A new `HOSTED` child of the target installation, keeping every id.** Ids are UUIDv7 and
  globally unique, so a kept id means the same tenant. The tenant row's `parent_tenant_id` becomes
  the target's installation tenant; `tenants_parent_check` holds and no FK names the parent.
- **The register is created in the target installation tenant** from the manifest's host facts: a
  `hosted_bots` row (state **SUSPENDED**, the tenant row **STOPPED**), a `hosted_bot_activations`
  row with the domain and NO marks, and the capacity limits. A restored bot always lands stopped:
  its webhook still points at wherever it ran, and the owner activates it through the existing
  steps (token → DNS → TLS → webhook), which SFR A5's `hosting.token_reentry_required` already
  demands after a stop.
- **Refusals in the dry run, before any write** (read through the system path, § Cross-cutting):
  - the tenant id exists → `tenant_archive.tenant_exists`, «این ربات همین حالا روی این سرور هست»;
    never a merge;
  - the slug is taken by another tenant → the form asks for a new slug (validated by
    `hostedBotSlugSchema`); the slug is a label, not an id, so this is not a merge;
  - the bot (`bot_instances` username or `telegram_bot_id`) belongs to another tenant →
    `tenant_archive.bot_taken`; Telegram has one webhook per bot;
  - the domain is another hosted bot's → `tenant_archive.domain_taken`;
  - any other globally unique key collides (`gateway_customer_numbers` `(provider, number)`,
    `gateway_invoices.provider_order_id`, `service_username_reservations` `(namespace, username)`,
    `outbox_messages` `(aggregate_type, aggregate_id, sequence)`, `request_idempotency`
    `(scope_ref, key)`, `operational_events` `(dedupe_scope, dedupe_key)`) →
    `tenant_archive.unique_collision`, naming the table, never the value. The list comes from the
    unique indexes that do not lead with `tenant_id` (generated from the schema; the inventory test
    fails when a new one is not on it).
- **Replace** (restore over an existing hosted tenant) only for the SAME tenant id, never from
  `PURGED` (terminal, ADR-0038), after a fresh code:
  1. the archive is verified in scratch exactly as a new restore (§ 5);
  2. a **PRE_REPLACE** tenant archive of the current rows is taken through the unmodified tenant
     pipeline and must reach a verified success, or nothing happens (ADR-0028's pre-restore
     backup, per tenant);
  3. ONE transaction deletes the tenant's rows (children first) and inserts the archive's (parents
     first), then compares counts with the manifest; any failure rolls back, so **the old rows stay
     until the new ones are in and counted**, and the PRE_REPLACE archive keeps them after.
     Step 3 deletes from append-only tables, which every guard refuses today. It runs under the
     **tenant rewrite allowance** (§ 10) — the one piece of the erasure design that 6B builds, scoped
     to a delete that is reinserted in the same transaction. If PR-1 cannot make every guard accept
     it with a test per guard, replace is refused (`tenant_archive.replace_unavailable`) and recorded
     not done; a new-tenant restore does not depend on it.
- **Writes into the live database are INSERTs, as the tenant.** `COPY FROM` is not supported on a
  table with row-level security for a non-bypassing role, so the copy is batched multi-row
  `INSERT` as `nexa_app` bound to the restored tenant (RLS `WITH CHECK` then refuses any row of
  another tenant), and only the `tenants` row, the register and the three otherwise-keyed tables
  go through the system path. Table triggers fire: public codes are kept (`nexa_assign_public_code`
  returns a supplied code), product numbers are kept. A guard that refuses a faithful historical
  insert gets an explicit, reviewed allowance named in the inventory, with its own test — never a
  `session_replication_role` switch on the live database.
- **Where it runs.** In the `recovery` process role, from a `tenant_restores` request row (§
  Contract), never in the HTTP request: ADR-0028's rule that no request restores into the database
  serving it, applied per tenant. Upload limits and the upload sweeper are the recovery page's.

## 5. Verification

The tenant pipeline is the six stages of ADR-0025, on the same `backup_runs` row machinery
(`archive_scope = 'TENANT'`, § Contract), and **DELIVER is reachable only from a VERIFY_RESTORE
that passed**:

```
DUMP (logical export, § 2) → CHECKSUM (per part + manifest) → ENCRYPT (7z, keys.json)
  → VERIFY_RESTORE → DELIVER (§ 7) → CLEANUP
```

VERIFY_RESTORE opens the ENCRYPTED archive through the same function the restore uses
(`openTenantArchive`), with the password, on the `backup-verify` server (never the live one in
production, never by falling back to it), and:

1. creates an EMPTY scratch database, migrates it to the archive's head;
2. loads every part in order (`COPY FROM` as the scratch's owner: the scratch has no RLS
   policies, and the owner bypasses them);
3. re-reads every table with the same pinned session and the same `ORDER BY` and compares its
   row count and SHA-256 with the manifest — byte equality, so a lost row, a changed value and a
   wrong column order all fail;
4. opens `keys.json` and decrypts every secret in the scratch under the archive key with its
   context (a bundle that does not open what it claims is a failed archive);
5. drops the scratch; a drop that fails is reported on the run row.

A run that fails verification deletes its archive. The restore repeats 1–4 on the target before
the owner confirms (the dry run), and after migrating an older archive up compares row counts
only — a migration may legitimately rewrite values.

## 6. The owner's installation backup excluding hosted rows — NOT DONE in 6B

**Decision: the installation backup stays the whole database in this phase.** The owner's
decision is honoured for his Telegram backup topic (§ 7: no hosted archive is ever delivered
there), and NOT for his archive files: they still contain hosted tenants' rows.

The mechanism that would keep ADR-0025's **stage order**, evaluated:

```
pg_dump live → pg_restore --section=pre-data,data into scratch → DELETE hosted rows
  → pg_restore --section=post-data → pg_dump scratch = the DUMP
  → CHECKSUM → ENCRYPT → VERIFY_RESTORE → DELIVER → CLEANUP
```

Deleting before `post-data` avoids every trigger and FK (both are post-data), and the delivered
archive is still the one VERIFY_RESTORE restored, so the order itself would hold. It is not done
because it breaks three other things ADR-0025 and ADR-0028 stand on, none fixable inside this
phase:

1. **ADR-0025's exclusion rule.** Rows may leave a dump only when "losing every row of it on a
   restore costs nothing but a retry" (`backup-exclusions.ts`). Hosted rows are customers, money
   and evidence. They would be safe only if a verified hosted archive AT LEAST AS NEW were
   guaranteed, and hosted archives run on their own schedule and can fail on their own: the
   filter would turn one guaranteed restore into a dependency on another pipeline's freshness.
2. **ADR-0028's recovery.** A Web Admin recovery cuts the whole database over by rename. From a
   filtered archive it would take every hosted bot offline until each is restored from its own
   file. Carrying hosted tenants across the cutover (export from the outgoing database while
   quiesced, import into the candidate) is a change to the most destructive path in the codebase.
3. **Cost and references.** Two restores and two dumps per backup instead of one of each, on a
   CPU-capped verify server; and the owner's register rows (`hosted_bots`,
   `hosted_bot_activations` → hosted `bot_instances`) reference the deleted rows, so the register
   would have to leave his backup too.

**What doing it later needs**, in order: the recovery carry-across (2); a freshness gate (a hosted
tenant is filtered out only while its newest verified archive is no older than the installation
run); the register moved into the host facts; an ADR-0025 amendment with a new manifest exclusion
kind. Until then the move bundle (§ 8) verifies hosted archives against the restored installation
rather than restoring them.

## 7. Delivery and storage of hosted archives

- **Password.** Set and changed by the owner only, in «میزبانی‌ها», with a fresh code, stored in
  a new INSTALLATION-owned table `hosted_bot_backup_policies` (one row per hosted tenant, the
  owner's `tenant_id`), sealed under a new secret purpose `hosting.archive_password` (a real
  ciphertext column, so `secret-registry.test.ts` covers it). Not in the hosted tenant's
  `backup_archive_passwords`: RLS would put it in the hosted owner's scope, and his own backup
  page writes that table. Changing it affects future archives only. A bot with no password set
  takes no archive (`hosting.backup_password_required`, shown on its card) — an archive the owner
  cannot open is not a backup.
- **Schedule** (same table): on/off, a daily time (`TimeField24`, the installation's zone), keep N.
  Defaults on, 04:30, 7. Each due bot takes a heavy-job ticket (kind `BACKUP`, `tenant_id` = the
  hosted tenant, the hosted priority); one at a time (§ Cross-cutting).
- **Storage.** `BACKUP_WORK_DIR/hosted/<hostedTenantId>/<runId>/`, 0700, its own retention: the
  newest N verified archives are kept, never the newest verified one deleted, and the installation
  housekeeping (`backup.archive_keep_*`, `backup.local_copies_keep`) never touches this tree.
  Hosted archives count toward the backup disk alert and the disk-room check before a run.
- **Download.** By the owner from the bot's card in «میزبانی‌ها», with a fresh code, audited in his
  log, announced like every export (Phase 6A D0 owner alerts).
- **Delivery.** Optional, only to the hosted bot's OWN operations group's «💾 بکاپ‌ها» topic,
  posted by that group's own bot, if that bot connected one; the caption is a new template key
  `ops.log.hosted_backup_caption` rendered in the hosted tenant (no restore command: they cannot
  restore). **Never** the owner's group and **never** the `BACKUP_TELEGRAM_*` fallback chat (that
  fallback is the owner's): with no hosted group the archive stays on the server, delivery
  `NOT_ATTEMPTED`. ADR-0025's three outcomes and per-part rules hold. The hosted operators get the
  file, not the password.
- **Off-site.** Hosted archives are not copied to the owner's S3 destination in 6B (§ Open).
- **The hosted owner's own view.** His backup page says backups are managed by the host and shows
  the last verified archive's time (and «خاموش» when the owner turned them off). No list, no
  password, no download, no restore.

## 8. Server move (D6)

### What a move bundle is

`nexa-move.7z`, AES-256 with the **bundle password**, encrypted headers:

```
move-manifest.json         format "nexa.move-bundle", formatVersion 1
installation/<file>.7z     a fresh installation backup (trigger MOVE), verified
hosted/<tenantId>.7z       a fresh tenant archive of every non-PURGED hosted bot, verified
checklist.fa.txt           the steps below, filled in
```

`move-manifest.json`: created-at; the source release (version, image digest) and migration
head; the installation id; every member's path, kind, tenant id, bytes and SHA-256; the owner's
domains (`WEB_ADMIN_ORIGINS` host names) and the old `HOSTED_BOTS_CNAME_TARGET` /
`HOSTED_BOTS_SERVER_IPS`; per bot (installation and hosted) the tenant id, bot username, Telegram
bot id and hosted domain — what re-pointing DNS and webhooks needs; and the environment: values
of an allowlist of non-secret keys, and only the NAMES of the secret ones the old server had set
(`BACKUP_TELEGRAM_BOT_TOKEN`, the S3 keys …) for the operator to enter again. `/etc/nexa/nexa.env`
itself never travels: the new server makes its own KEK, database and webhook secrets.

### Which secrets: one bundle password

The members are sealed for the move with the **bundle password** itself (the archiver's seal
takes it for these runs only; the stored installation and hosted passwords are neither used nor
carried). One secret to type on the new server, and no wrapped list of passwords. The members are
transient move artifacts: trigger `MOVE`, never delivered, never retained by the schedules.
Asked twice, hidden, on the terminal; given to the CLIs on stdin. Each member's own `keys.json`
is wrapped by it, so the new server rewraps every secret under its own active key on restore — the
installation through the existing self-contained restore, hosted bots through § 2.

The installation member must be self-contained (a 7z with `keys.json`), which this gives by
construction.

### Old server: `botctl move export --out FILE`

1. **Freeze.** Stops every application role (api, worker, monitor, provisioner, assistant,
   recovery); PostgreSQL and `backup-verify` stay up. Nothing writes after this point. Telegram
   keeps a failing webhook's updates for a day, so the move must finish within 24 h; a gateway
   callback in the window is not the approval path (approval is by inquiry), so the new server's
   inquiry settles it.
2. Asks the bundle password twice; refuses a short one by the backup password's own rule.
3. Disk check: free space ≥ 2 × (database size) or refuse.
4. Takes the installation backup, then each hosted archive, one at a time through the heavy-job
   queue, from one-off containers (`backup.cli.js`, `tenant-archive.cli.js`); every member must
   reach VERIFY_RESTORE success or the export fails and deletes the partial bundle.
5. Writes the manifest and checklist, seals the bundle, prints its size, SHA-256 and the next
   steps in Persian. The old server stays frozen: restarting it with the same bot tokens would
   race the new one. `botctl move abort` (the only way back) restarts the roles.

### New server, in this order

1. `install.sh` of the SAME or a newer release (owner domain as before; its certificate waits for
   DNS).
2. `botctl move import FILE`:
   1. opens the bundle, checks every member's SHA-256 and the manifest;
   2. refuses a bundle whose head is NEWER than this release («اول نکسای مقصد را به‌روز کنید»),
      and a target that is not fresh (any hosted tenant, or any customer, order or wallet entry):
      `move import` never merges into a running business;
   3. `botctl roles disable provisioner monitor`;
   4. restores the installation through the EXISTING recovery path — a `recovery_requests` row
      with source `MOVE` (verify, restore-test, pre-restore backup of the empty install, quiesce,
      candidate, migrate forward if behind, rename cutover, readiness). The CLI on a root shell
      with the typed bundle password is the confirmation, as ADR-0025 records for `botctl
restore`; the confirmation is still bound to the member's SHA-256;
   5. for each hosted member: its tenant is already in the restored installation (§ 6), so the
      member is **verified against the live rows** (counts and SHA-256 per table, read bound to
      that tenant) and must match exactly — both were taken in the same freeze. A tenant that is
      absent is restored through § 4. Any mismatch stops the import and names the tenant;
   6. clears every hosted activation's DNS/TLS/webhook marks (earned on the old server) through
      the system path;
   7. prints the checklist.
3. The operator changes DNS: the owner's names (A/AAAA) and every hosted domain (CNAME to this
   server's `HOSTED_BOTS_CNAME_TARGET`, or its addresses).
4. `botctl move verify` until each name resolves here and TLS answers.
5. `botctl telegram register` (the installation bot) and `botctl telegram register-hosted` (new,
   no arguments: re-runs the activation steps DNS → TLS → webhook for every `ACTIVE` hosted bot
   from its stored token, one line per bot). The new server's `TELEGRAM_WEBHOOK_SECRET` differs,
   so every webhook is re-registered anyway (`webhook_secret_fingerprint`).
6. `botctl move verify` again: each bot's `getWebhookInfo` points here; a Persian table of what is
   ready.
7. Re-enter the secret environment values the manifest named; `botctl roles enable provisioner
monitor` when ready. Decommission the old server only now.

## 9. Enter («ورود به پنل», D5) — ADR-0038 confirmed, refined in four places

Confirmed: a fresh code mints a 15-minute, single-use, audience-bound token recorded in the
OWNER's log; it opens a Web Admin session in the hosted tenant marked as the host's, with the
banner «در حال مشاهده به‌عنوان میزبان» and an exit; no row in the hosted tenant's audit log; no
change to its admins, second factors or secrets; it ends with the section session.

**Refinement 1 — the session's principal is a real HOST admin of the hosted tenant, not the
owner's id.** The code forbids the alternative: 61 foreign keys on 53 tables reference admins
by the composite `(tenant_id, admin_id)`, so the owner's installation admin id cannot be written
into a hosted row, and an `admin_sessions` row needs a hosted admin. Writing the hosted owner's id
instead would be a fabricated actor. So each hosted tenant gets ONE admin of `kind = 'HOST'`
(created on first enter, inside the owner's transaction, on the system path): no password (it
cannot sign in — the sign-in treats it as an unknown user, timing included), no role, not
editable, disableable or deletable by the tenant's admins (a guard trigger), listed read-only as
«میزبان». Rows the host writes say «میزبان» did it, which is true and stays inside the tenant's
archive.

**Refinement 2 — the token crosses domains.** The hosted Web Admin lives on the hosted domain
(Host → tenant), where the owner's cookies do not reach. `POST /hosting/bots/:id/enter` (fresh
code; the bot `ACTIVE` with a verified domain, else `hosting.enter_domain_required`) stores
SHA-256 of 256 random bits in `hosting_enter_tokens` (installation-owned: hosted tenant, domain,
owner admin, section session, expiry by the `Clock`, `used_at`) and answers
`https://<domain>/enter#<token>` — a fragment, so no server or log sees it. That page posts it
to `POST /auth/enter`; the API spends it by one conditional UPDATE only if the request's resolved
tenant AND host are the token's audience, it is unexpired, and the section session and the owner's
Web Admin session are both live. Every failure is ONE code, `hosting.enter_token_invalid` (as
`backup.archive_auth_failed` collapses its causes). It then creates the `admin_sessions` row for
the HOST principal with `impersonated_by_admin_id` and `impersonation_hosting_session_id` (plain
uuids, no FK: `admin_sessions` is NEVER exported), expiring with the section session, and sets
the ordinary session cookie on that domain.

**Refinement 3 — permissions and secrets.** The session holds ALL permissions minus
`IMPERSONATION_DENIED_PERMISSIONS` (`admins.edit`, `admins.permissions.edit`,
`panels.credentials.rotate`, `backup.run`, `backup.download`, `recovery.restore`,
`hosting.manage`), and **every write that seals a new secret value** refuses an impersonated actor
(`identity.impersonation_forbidden`): the bot token, panel and gateway credentials, support-AI
keys, a second factor. A permission alone cannot say this — the bot token is under
`settings.edit` — so the check sits in each secret writer, and a test walks `SECRET_REGISTRY` so a
new secret column without it fails. The account-security endpoints refuse the HOST kind.

**Refinement 4 — the audit row is the owner's.** `ActorContext` gains optional `impersonation`
(installation tenant, owner admin id and label, the enter session). `DrizzleAuditWriter`, seeing
it, writes the row with `tenant_id` = the installation, the owner as actor and a new
`audit_logs.acted_in_tenant_id` = the hosted tenant, through `withSystemScopeIn` on the SAME
transaction (so the change and its record still commit together), under the reason
`audit: host owner acting in a hosted tenant`. Denials go the same way. The hosted tenant's
`audit_logs` receive nothing. Each request re-checks the section session; closing it, its expiry,
or «خروج» revokes the impersonated session.

## 10. Purge erasure — design only, NOT built in 6B

Purge closes a tenant for good (ADR-0038); its rows stay. Erasing them needs:

1. **An authority row.** INSTALLATION-owned `tenant_erasures` (hosted tenant, requested by,
   fresh-code proof, state, counts per table, started/finished, failure code), one active per
   installation, run through the heavy-job queue.
2. **Preconditions.** The tenant is `PURGED`, at least a waiting period after the purge (an owner
   setting), and a verified tenant archive was taken AFTER the purge and downloaded or delivered —
   or the owner typed an explicit waiver. Erasure is the only operation that destroys evidence.
3. **The tenant rewrite allowance** (shared with replace, § 4). Every append-only guard
   (`nexa_reject_mutation` and the table-specific guard functions, from
   `0001_append_only_guards.sql` on; 41 distinct trigger functions exist today) gains one DELETE branch that returns `OLD` when
   `nexa_tenant_rewrite_allowed(OLD.tenant_id)` is true. That `SECURITY DEFINER` function is true
   only on the system path (`current_user = 'nexa_system'`, so a reason is bound), when
   `nexa.tenant_rewrite` names an authority row (`tenant_erasures` or `tenant_restores`) that is
   APPLYING for exactly that tenant and was claimed by the current transaction id. UPDATE stays
   refused. A test per guard proves it refuses without the allowance and accepts with it.
4. **Order and batches.** Children first (the inventory's load order reversed), in short batches,
   resumable from a cursor like the legacy compaction; `processed_messages` and
   `aggregate_sequences` through their joins; the owner's register rows stay as a tombstone with
   the counts.
5. **What it cannot erase.** Copies in earlier installation backups (whole-database, § 6) until
   their retention removes them; archives already delivered to the hosted group or downloaded. The
   owner is told so before confirming.
6. **Its own record** in the owner's log; the tenant's audit rows are among the rows erased.

## The open data export (PR-3), because it reuses the inventory

Not one of the ten points, recorded so PR-3 builds on the same inventory:

- a ZIP of CSV files (UTF-8 with BOM, so Excel shows Persian) plus `README.fa.md` describing every
  column, for customers, wallets and the ledger, orders, services, payments, products, resellers,
  tickets and messages — TENANT tables only, read bound to the tenant as § 2;
- **never a secret**: the inventory classifies every column of an exported table, and a column is
  left out when it is a `SECRET_REGISTRY` ciphertext or a hash, token, code or key column
  (`password_hash`, `token_hash`, `code_hash`, second-factor and backup-code material). The PR-3
  test fails when a new column of an exported table is neither listed nor excluded;
- through the heavy-job queue (kind `EXPORT`), a download link valid 24 h, an audit row; the
  hosted owner reaches it with the new `data.export`, the installation owner from «میزبانی‌ها»
  with a fresh code (audited in his own log).

## Cross-cutting

**Load.** Dumps, archives, restores, data exports and move members take a `heavy_job_tickets`
ticket. Because `INSTALLATION_HEAVY_JOB_CONCURRENCY` may be 2, the kinds `BACKUP` and the new
`RESTORE` become **exclusive**: the gate starts one only when no other ticket runs, and starts
nothing beside it (`EXCLUSIVE_HEAVY_JOB_KINDS`, decided under the gate's existing installation
lock). Tenant archive runs also share `backup_runs_single_active_idx`, so the database refuses a
second RUNNING archive of either scope.

**RLS and the system path.** Tenant rows are read and written bound to the tenant (§ 2, § 4); the
system path is used only for the genuinely cross-tenant statements, each under its own literal
reason, pinned in `tests/unit/system-path-allowlist.ts` (list below). Binding a hosted tenant's
scope from installation work goes through one helper whose reason is pinned too. No new unscoped
query.

**Isolation proof.** PR-1 extends `tests/integration/isolation-proof`: tenant A's archive has no
row of tenant B (every table, by `tenant_id` and by the join for the three); restoring A changes
no row of B (a table-by-table checksum of B before and after); run as `nexa_app` with RLS on.

## Finding F1 — pre-existing, security: a hosted owner reaches the installation backup

Found while grounding § 7, by reading (not yet proven by a test): the seeded `owner` role holds
ALL permissions in every tenant (`permissions.ts`), including a hosted one; hosted owners sign in
on their own domains; `BackupAdminService` checks only the permission (no installation-scope check,
despite its header comment) over `backup_runs`, which has no tenant; and `RecoveryService` scopes
a request to the caller's tenant only, while the executor restores the whole database. If that
reading holds, a hosted owner can list and download the installation's encrypted archive, set a
backup password in his own tenant (the owner decision says he cannot), and confirm a whole-server
restore from an upload. **PR-2 must open with a failing test for each and close them**:
`INSTALLATION_ONLY_PERMISSIONS` (`backup.run`, `backup.download`, `recovery.restore`,
`hosting.manage`) dropped from every non-installation session and refused by the guard, and the
installation backup and recovery routes refusing a non-installation scope with not-found. The lead
should treat this as urgent, ahead of PR-2's product work.

## Contract items later PRs need (each its own commit, with its reason)

| PR  | Kind             | Item                                                                                                                                                                                                                                                                                                                                                                     |
| --- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | enum             | `BACKUP_ARCHIVE_SCOPES = ['INSTALLATION', 'TENANT']`; `BACKUP_TRIGGERS` + `PRE_REPLACE`, `MOVE`; `HEAVY_JOB_KINDS` + `RESTORE`; `EXCLUSIVE_HEAVY_JOB_KINDS`; `TENANT_RESTORE_MODES = ['NEW', 'REPLACE']`, `TENANT_RESTORE_STATES`; `AGGREGATE_OWNERSHIP`                                                                                                                 |
| 1   | error codes      | `tenant_archive.head_newer`, `.head_diverged`, `.tenant_exists`, `.bot_taken`, `.domain_taken`, `.unique_collision`, `.verification_failed`, `.has_child_tenants`, `.not_hosted`, `.purged`, `.replace_unavailable`, `.unclassified_table`, `.rls_bypassed` (crypto failures reuse `backup.archive_auth_failed` / `backup.archive_malformed`)                            |
| 1   | tables / columns | `backup_runs.archive_scope`, `backup_runs.subject_tenant_id` (+ CHECK: TENANT ⇔ not null); `tenant_restores` (INSTALLATION-owned request row: hosted tenant, mode, state, stage, artifact SHA-256, dry-run summary, confirmed-at, pre-replace run id, failure code; single-active partial unique index); the tenant rewrite allowance function and guard branches (§ 10) |
| 2   | permissions      | `INSTALLATION_ONLY_PERMISSIONS` (F1); no new permission (hosting actions are `hosting.manage` + a fresh code)                                                                                                                                                                                                                                                            |
| 2   | table / secret   | `hosted_bot_backup_policies`; `SECRET_PURPOSES` + `hosting.archive_password`                                                                                                                                                                                                                                                                                             |
| 2   | error codes      | `hosting.backup_password_required`, `hosting.archive_not_found`, `backup.installation_only`                                                                                                                                                                                                                                                                              |
| 2   | template key     | `ops.log.hosted_backup_caption`                                                                                                                                                                                                                                                                                                                                          |
| 3   | permission       | `data.export` (CRITICAL, the hosted tenant's `owner`; a backfill migration like `0031` for existing owner roles)                                                                                                                                                                                                                                                         |
| 3   | table            | `tenant_data_exports` (tenant-owned: requested by, state, SHA-256, bytes, expires-at = +24 h)                                                                                                                                                                                                                                                                            |
| 3   | error codes      | `data_export.not_ready`, `data_export.expired`                                                                                                                                                                                                                                                                                                                           |
| 4   | enum             | `RECOVERY_SOURCES` + `MOVE`                                                                                                                                                                                                                                                                                                                                              |
| 5   | contract field   | `ActorContext.impersonation?`; `IMPERSONATION_DENIED_PERMISSIONS`; `ADMIN_KINDS = ['OPERATOR', 'HOST']`                                                                                                                                                                                                                                                                  |
| 5   | tables / columns | `hosting_enter_tokens`; `admins.kind` (+ `password_hash` nullable only for HOST, one HOST per tenant); `admin_sessions.impersonated_by_admin_id`, `.impersonation_hosting_session_id`; `audit_logs.acted_in_tenant_id`                                                                                                                                                   |
| 5   | error codes      | `hosting.enter_domain_required`, `hosting.enter_token_invalid`, `identity.impersonation_forbidden` (and `hosting.enter_not_implemented` removed)                                                                                                                                                                                                                         |
| —   | feature flags    | none: hosted backups are on by the owner's per-bot schedule, enter by `hosting.manage`                                                                                                                                                                                                                                                                                   |
| —   | not built        | `tenant_erasures` (§ 10)                                                                                                                                                                                                                                                                                                                                                 |

System-path reasons (literal, each pinned): `tenant archive: bind a hosted tenant for export`,
`tenant archive: bind a hosted tenant for restore`, `tenant archive: global key collisions before
restore`, `tenant archive: create the restored tenant and its register`, `tenant archive: replace a
hosted tenant's rows`, `hosting: hosted backup schedule, every hosted tenant`, `hosting: last
hosted archive for the hosted owner's view`, `hosting: deliver a hosted archive to its own group`,
`hosting: ensure the host principal of a hosted tenant`, `hosting: open an entered session in a
hosted tenant`, `hosting: entered session liveness`, `hosting: revoke entered sessions with the
section`, `audit: host owner acting in a hosted tenant`, `data export: bind the exported tenant`,
`move: list hosted tenants for the bundle`, `move: clear activation marks after import`.

## Deviations from the phase prompt

- **§ 6 not done** (above): the installation backup stays whole. Consequence for PR-4: hosted
  members are verified against the restored installation, not restored (a missing one is).
- **The inventory test** moves to PR-1: PR-0 is docs only.
- **The count:** 219 tables carry `tenant_id`, not 220; `tenants` is the 220th tenant-keyed one.
- **Hosted archives do not carry this server's keyring** (§ 2) — the prompt's "wrapped keys"
  holds, with one archive key instead of the KEK, so the hosted password protects one tenant.
- **Every restored bot lands SUSPENDED** (§ 4), the safest reading of "restored as a new child".
- **Replace** depends on the rewrite allowance and is recorded not done if PR-1 cannot prove every
  guard (§ 4).

## Open

- Off-site (S3) copies of hosted archives: the destination and its credentials are the owner's;
  whether hosted archives go there is his call (`docs/open-questions.md`).
- § 6 and § 10 as above.
- A hosted tenant with reseller children cannot be archived (`has_child_tenants`) until a subtree
  archive is designed.
