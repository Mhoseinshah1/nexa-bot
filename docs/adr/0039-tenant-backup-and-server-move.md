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
| `hosting_sessions`, `hosting_enter_tokens`       | the owner's section sessions and his one-time «ورود به پنل» tokens                                   |
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
      member is **verified against the live rows** (counts per table, and a SHA-256 over a
      CANONICAL form, read bound to that tenant) and must match — both were taken in the same
      freeze. The canonical form is NOT the stored bytes: secret columns are decrypted and
      compared as plaintext with key id and wrap metadata dropped (the member's installation-key
      ciphertext, the archive's fresh-key ciphertext and the destination's active-key rewrap all
      differ for identical plaintext), and columns the forward migration of a newer release
      legitimately changes are normalised by a per-table list kept with the migration that
      changes them. A tenant that is absent is restored through § 4. Any mismatch stops the
      import and names the tenant and table;
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
   `nexa_tenant_rewrite_allowed(OLD.tenant_id)` is true. The role check lives OUTSIDE the privileged
   function: the guard (`SECURITY INVOKER`, the trigger function) requires `current_user =
'nexa_system'` and a bound reason (`current_user` inside a `SECURITY DEFINER` function is the
   function owner, so it cannot authenticate the caller), then calls
   `nexa_tenant_rewrite_allowed(OLD.tenant_id)`. That function is `SECURITY DEFINER`, owned by the
   migration owner (which can read the authority tables), `EXECUTE` revoked from PUBLIC and
   granted to `nexa_system` only, with a pinned `search_path`; it only does the lookup: true
   when `nexa.tenant_rewrite` names an authority row (`tenant_erasures` or `tenant_restores`)
   that is APPLYING for exactly that tenant and was claimed by the current transaction id. UPDATE stays
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

## As built in PR-1 (`feat/6b-tenant-archive`)

Changes to the design above, each decided in PR-1 and binding on later PRs:

- **Aggregate counters (§ 1).** `AGGREGATE_OWNERSHIP` (contract, `events.ts`) marks each
  aggregate type `TENANT_ROW` or `SHARED_KEY`. Setting, Template, FeatureFlag and System are
  keyed by a key every tenant uses, and Tenant by a tenant id the installation also writes about,
  so their `aggregate_sequences` row is the INSTALLATION's: it is never exported, and a restore
  gives the archive's outbox messages of such an aggregate the next numbers of the TARGET's
  counter (locked for the transaction), in their order. The outbox's global key is checked for
  `TENANT_ROW` aggregates only, and the canonical digest compares a shared message without its
  sequence. Found when a second hosted bot of one source could not be restored beside the first.
- **The row format (§ 2).** Parts are COPY text format, produced from a `col::text` SELECT
  (escaped as `COPY … TO` escapes) and loaded by batched, typed `INSERT`s, in scratch as in the
  live database: the driver has no COPY stream and no dependency was added for one. The archive
  key's id is `archive-<archiveId>` (`:` is not used in envelope key ids).
- **The scratch (§ 3, § 5)** is migrated in process by the drizzle migrator over a copy of the
  folder whose journal is truncated at the archive's head; its online indexes and row-level
  security are not applied (an owner scratch needs neither).
- **An archive is untrusted input (§ 4)** — anyone with its password can write one (security
  review of PR-1):
  - the register takes NO expiry and NO capacity limits from the archive: the restored bot has
    no expiry and the installation's default limits until the owner sets them; the manifest's
    values are informational;
  - the owner admin the host facts name must be an admin of the archived tenant, or the dry run
    refuses; an activation bot the tenant does not hold is dropped;
  - the tenant row must be exactly one, with the manifest's id, and lands `HOSTED` whatever
    kind it carries;
  - identity sequences are shared by every tenant: a restored value more than 10,000,000
    above the live sequence, or past half the column type's range, refuses the restore;
  - the parts a manifest declares are capped before extraction by a limit that is not the
    archive's (32 GiB by default) and by the work volume's free space less 1 GiB; a
    self-referencing table is buffered within fixed bounds (200,000 rows, 256 MiB).
- **Unpublished outbox messages are never relayed on the target (§ 4).** They were the
  source's work at the source's moment; relaying them here would send customers stale
  notifications and repeat side effects. The restore inserts each unpublished message
  EXHAUSTED (`exhausted_at` = the restore, `last_error = 'tenant_archive.restored_not_relayed'`)
  — the mark the relay already respects, which also holds no sibling back — and the canonical
  digest compares such a row without its delivery marks. They stay as history in the tenant.
- **The dry run and the confirmation (§ 4).** A dry run leaves its `tenant_restores` row
  `VERIFIED` (it holds the installation's one restore slot); the confirmation names that row,
  is bound to the uploaded file's SHA-256, repeats the whole verification and applies. A
  `VERIFIED` row nobody confirms holds the slot: cancelling and expiring it is NOT built in
  PR-1 — PR-2's restore page must offer «لغو» and expire a stale `VERIFIED` row (open).
- **Replace — NOT DONE in PR-1** (built later, § As built: replace). `mode: 'REPLACE'` is refused
  (`tenant_archive.replace_unavailable`). The rewrite allowance of § 10 needs a DELETE branch
  and a refusing/accepting test in each of the 41 append-only guard functions; that was not
  built and proven in this PR, so a new-tenant restore is the only mode.
- **Not wired yet.** PR-1 builds the engine, the services, the request row and the queue rule;
  the recovery-role worker, the HTTP routes, the hosted password and schedule, delivery to the
  hosted group and retention under `hosted/<tenantId>/` are PR-2. The system-path reason
  `tenant archive: bind a hosted tenant for restore` is not used: the restore binds the
  restored tenant with `withTenantScopeIn` inside its one system-path transaction.
- **The older-head test** restores an archive taken at head N−2 onto N, migrating the scratch
  across both (`0327` onto `0329`, the first head that writes this format, when PR-1 merged;
  `0328` onto `0330` after the review fixes below).

## Security review of PR-1 (`fix/6b-tenant-archive-review`)

A read-only review of the merged engine found five problems; each fix has a test that fails
when it is reverted (`scripts/claude/tenant-archive-mutation.sh`):

- **No row data in a failure message.** A failed restore INSERT surfaces as drizzle's
  `Failed query: … params: <values>`. `tenant_restores.failure_message` and a tenant run's
  `backup_runs.failure_message` now hold a `NexaError`'s own message, or the error chain as
  `error-diagnostics.ts` describes it for a log (type, SQLSTATE, constraint, table, column, a
  message with its quoted spans blanked) — never a raw `error.message` (`stored-failure.ts`).
- **A killed run's plaintext and scratch are swept.** The orphan sweep (worker start, an
  installation backup) and the housekeeping debris sweep also walk `hosted/<tenant>/<run>/`;
  the orphan sweep judges such a directory only by a TENANT run row of exactly that tenant, and
  removes `plain/` and `verify/` (the whole directory for an unverified failure, as the run's
  own `catch` would). Inside an admitted archive or restore, the idle `nexa_tarc_<16 hex>`
  scratch databases on the verify server are dropped WITHOUT `FORCE`, so one with a session
  stays (reported, never cut off).
- **A crashed restore no longer holds the slot.** `tenant_restores` carries ADR-0025's lease
  (`lease_owner`, `lease_heartbeat_at`, migration `0330`), refreshed every minute; once admitted,
  a restore FAILS every in-progress request whose lease is 15 minutes stale
  (`tenant_archive.lease_expired`) — never adopts it — before taking the slot. A `VERIFIED` dry
  run is not reclaimed: its cancel and expiry stay PR-2's (above).
- **A restore refuses a connection that bypasses RLS** (`tenant_archive.rls_bypassed`), before
  anything is opened, as the export does: the copy relies on RLS `WITH CHECK`.
- **The confirmation is bound to the bytes read.** The restore copies the upload into its private
  work directory through a SHA-256 and reads only that copy; a copy whose hash is not the one
  the request or its confirmation names is refused before it is opened.

## As built in PR-2 (`feat/6b-hosted-backups`)

Changes to the design above, each decided in PR-2 and binding on later PRs:

- **F1 is closed, and was real.** `tests/integration/installation-only-scope.test.ts` was red on
  `main` in all four cases (a non-installation owner got the installation archive's path, wrote a
  backup password, started a whole-installation recovery upload, and held `recovery.restore`).
  Shipped first as its own PR (`fix/6b-installation-only-backup-perms`): the guard drops
  `INSTALLATION_ONLY_PERMISSIONS` outside the installation tenant (and everywhere while none is
  resolved), and `BackupAdminService`, `RecoveryService` and `BackupPasswordService` answer any
  other scope `backup.installation_only` (not-found) before reading. `BackupAdminService` also
  never answers a TENANT run by id.
- **«بکاپ الان» is a request, not a run (§ 7).** The press (fresh code) stamps
  `hosted_bot_backup_policies.run_requested_at`; the worker's `HostedBackupLoop` takes it, like a
  scheduled one, through the heavy-job queue. No archive is ever taken in an HTTP request.
- **Due rule.** A bot with a password is due when «بکاپ الان» is pending, or its schedule is on
  and its last FINISHED attempt started before today's slot (`latestDailySlot`, Asia/Tehran) —
  one attempt per slot, failures included; a queue that does not admit ends the pass.
- **The download is a POST** (it spends a fresh code); the answer's body is the archive.
- **Delivery (§ 7)** is `HostedGroupArchiveDelivery`, asked in the HOSTED tenant's scope only;
  it keeps the archive on the server (`NOT_ATTEMPTED`) with no group, an unusable group, the
  BACKUP_FILE log switched off, or a file above Telegram's bot ceiling (no split parts for
  hosted archives in 6B).
- **Restore from file (§ 4).** The upload lives in `RECOVERY_WORK_DIR/tenant-restores/<id>/`.
  The DRY RUN runs in the API request, through the heavy-job queue, exactly as the installation
  recovery's verification does: it writes nothing but its `tenant_restores` row. The APPLY runs
  only in the recovery role: the confirmation (fresh code) stamps
  `tenant_restores.confirm_requested_at`, and the role applies it with the password the dry run
  sealed into the upload directory under this server's active key (purpose
  `hosting.archive_password`, entity = the restore id). «لغو» and a 24-hour expiry withdraw an
  unconfirmed VERIFIED row (`tenant_archive.restore_cancelled` / `.dry_run_expired`), closing
  PR-1's open item; uploads are removed once their request finishes, orphans after a day (A3).
- **«بازیابی روی همین سرور» is NOT built** (built later, § As built: replace). On the same server the bot's tenant id is present, so
  only REPLACE could restore it, and REPLACE is not built (PR-1). The button is drawn disabled
  with that reason.
- **Password change** replaces the stored ciphertext; earlier archives open with the password
  they were sealed with (the owner is told so).

## As built in PR-3 (`feat/6b-data-export`) — the open data export

Decisions of PR-3, binding on later PRs (the design above, "The open data export", is unchanged):

- **Two doors, one service** (`DataExportService`). A hosted bot's owner, in their own Web Admin
  («خروجی داده», `/data-export`), holding `data.export` in their own tenant; the installation
  owner, from «میزبانی‌ها», inside a bot's card, with the section session and a FRESH code on the
  request. The request row belongs to the EXPORTED tenant (`tenant_data_exports.tenant_id`), so
  it is under that tenant's row-level security; the audit row belongs to the ACTOR's log: the
  owner's own for the host, the bot's own for its owner. The host's request writes NO row to the
  hosted tenant's audit log (D5). `requested_by_host` keeps the two apart: a hosted owner's list
  and download never show what the host asked for.
- **Who is "hosted".** The installation's own tenant is refused (`data_export.not_hosted`) and
  its session is not shown `data.export` (`withoutInstallationDataExport`, as `hosting.manage`
  is withheld from a hosted owner). Every other tenant is a hosted bot's, as in the capacity
  tiers. A SUSPENDED or DELETED hosted bot can still be exported by the host (its data is the
  reason to export it before a purge); a PURGED one is not found.
- **A column allow-list, not a filter.** `data-export-inventory.ts` decides EVERY column of
  every exported table: exported with its Persian description (the README is generated from the
  same data) or excluded with a reason. The export selects exactly the exported columns (never
  `SELECT *`), so a column added later is in no file until somebody decides it.
  `tests/unit/data-export-inventory.test.ts` fails the build for an undecided column and for an
  exported column whose name reads as a secret (hash, token, key, credential, bearer link) unless
  allowed by name. Left out on purpose: `services.subscription_url` (a bearer link),
  `subscription_ref` and `provider_client_id` (what the customer's configuration authenticates
  with), Telegram file ids, idempotency keys and request hashes, the pricing snapshot JSON and
  the import provenance JSON. Attachments are not exported, only their names, types and sizes.
- **Files.** `customers`, `wallet_ledger`, `wallet_balances` (the ledger's total per customer
  and currency: the balance is never stored), `orders`, `services`, `payments`, `products`,
  `product_categories`, `resellers`, `tickets`, `ticket_messages`, `ticket_categories`, and
  `README.fa.md`. Money is `col::text` of the stored `bigint`: exact minor units beside the
  currency column, proved past 2^53. Instants are ISO 8601 UTC. A text cell that starts with
  `= + - @` is written with a leading `'`; numbers are never guarded.
- **One snapshot, bound and named.** The ZIP is read in one `REPEATABLE READ READ ONLY`
  transaction under the tenant's scope (`nexa_app`, `app.current_tenant_id`) with
  `tenant_id = $1` in every statement. No system-path reason was needed for the read (the
  `data export: bind the exported tenant` reason of the list above is not used): the worker's
  four cross-tenant sweeps are scope-less `@ScopeBound` methods, pinned as
  `DrizzleDataExportRepository.claimNext`, `.expireDue`, `.failAbandoned` and `.pendingRemoval`.
- **The host door is on the system path.** The installation owner's door reads and writes a
  HOSTED tenant's export rows, so it never binds that tenant's scope: `hostList`, `hostFind`,
  `hostActive` and `hostInsert` run under the literal reasons `data-export: host lists the
exports of a hosted bot`, `…host finds an export of a hosted bot`, `…host checks the active
export of a hosted bot` and `…host requests an export for a hosted bot` (each pinned in
  `tests/unit/system-path-allowlist.ts`; `withSystemScope` on the pool, `withSystemScopeIn` on
  the owner's own transaction for the request), with the hosted tenant as the predicate of every
  statement. The hosted owner's own door stays tenant-bound. An integration probe (a trigger on
  the table) asserts the request is written as `nexa_system` under its reason; the mutation
  `host-tenant-bound` of `scripts/claude/data-export-mutation.sh` turns it red.
- **The worker** (`DataExportRunner`, in the worker role, 15 s tick, fresh while idle or working):
  expires and removes, fails abandoned work (three attempts), claims the oldest request
  (`FOR UPDATE SKIP LOCKED`, a lease it refreshes), waits for the heavy-job queue
  (`HeavyJobGate`, kind `EXPORT`, so never beside a backup or a restore), streams the ZIP to
  `<BACKUP_WORK_DIR>/data-exports/<tenant>/<id>.zip` (a streamed, deflated ZIP, no ZIP64: a
  file past 4 GiB fails with `data_export.too_large`), and ends READY with the SHA-256, the size
  and a deadline 24 h out. Not admitted: back to REQUESTED, still first in line. One export
  being made per tenant, by a partial unique index.
- **The 24 h link** is an authenticated, same-origin download route, not a bearer URL: the file
  is streamed with `no-store`, only to the requester's session, until `expires_at`; after it the
  answer is `data_export.expired` and the next worker pass removes the file (and retries a
  removal that failed). A file gone from disk under a READY row answers `expired` too.
- **Contract items** (each its own commit): the `data.export` permission (CRITICAL, owner, with
  the backfill migration `0331`), the states and the deadline, the error codes `not_ready`,
  `expired`, `not_found`, `not_hosted`, `in_progress` and the two failure codes `failed`,
  `too_large`, the routes and shapes, and the table `tenant_data_exports` (`0330`; the tenant
  archive inventory classes it NEVER: a file on this server means nothing on another).
- **Not done / open.** The installation owner's download uses the section session, not a second
  fresh code (the request spends the code). No template key was needed (Persian text is Web
  Admin chrome, `web.*`). The export carries no attachments and no files of the media library.

## As built in PR-4 (`feat/6b-server-move`) — the server move

Decisions of PR-4, binding on later PRs (operator guide: `docs/server-move.md`):

- **Bundle** as § 8, in `move-bundle.ts`: one 7z (AES-256, encrypted headers) with
  `move-manifest.json`, `checklist.fa.txt`, `installation/nexa-backup-*.7z`, `hosted/<id>.7z`. The
  open refuses any entry the format never writes and any member whose size or SHA-256 differs
  from the manifest (`move.bundle_malformed`, `move.member_checksum_mismatch`). The manifest
  carries non-secret configuration by VALUE from an allow-list and the re-enterable secrets
  (`BACKUP_TELEGRAM_BOT_TOKEN`, the S3 keys) by NAME only; the keyring and the webhook secret are
  never named.
- **One bundle password seals every member.** `BackupService.run('MOVE', { deliver: false,
sealPassword })` seals the installation member with it (no password id recorded) and its
  VERIFY_RESTORE opens it with exactly that password; `TenantArchiveService` never delivers a
  MOVE archive. Members are MOVED out of their run directories into the bundle (no second copy
  stays under retention); their runs remain as history with no archive on disk.
- **Freeze** is botctl's: `move export` records the application roles it stops in
  `/etc/nexa/move-frozen` before stopping them; `restart`, `update` and `rollback` refuse while it
  exists; `move abort` starts exactly those roles and removes it.
- **Import, step 1** (`move.cli.js import-installation`): head (`move.head_newer` /
  `.head_diverged`) and freshness (`move.target_not_fresh`, read across tenants on the system
  path) are checked, then `RecoveryService.requestMove` runs the upload chain (verify, restore
  test, trial decryption) and confirms the request as `source = 'MOVE'` with
  `confirmed_by_admin_id` NULL (migration `0336`: the confirmation CHECK is
  three-of-three for MOVE, four-of-four otherwise). The CLI waits for the executor (its reads are
  retried across the cutover).
- **Import, step 2** (`import-hosted`, a new process against the restored database): each hosted
  member is compared with its live tenant — read bound to it as `nexa_app`, over the ARCHIVE's
  columns — by row count and canonical SHA-256 per table (`archiveCanonicalDigests` against
  `canonicalDigests`, both through `canonicalMask`), and no live TENANT table may hold rows the
  archive lacks. The per-table normalisation list of § 8 is empty in this release (a newer
  release adds an entry with the migration that rewrites a column).
- **Not done: restoring an absent hosted tenant inside `move import`.** Under the freeze the
  installation backup always holds every hosted tenant, so an absent one is not expected; it is
  NOT restored automatically (the § 4 restore needs an actor admin and a `tenant_restores` row in
  the recovery role). Its member is kept in `BACKUP_WORK_DIR/move-unrestored/` and the operator
  restores it with «بازیابی ربات از فایل» and the bundle password; the import exits 2.
- **Activation marks** are cleared in the INSTALLATION's own scope (its rows), audited
  `hosting.move_marks_cleared` by a SYSTEM_JOB actor; the § Contract reason `move: clear
activation marks after import` was therefore not needed.
- **`botctl telegram register-hosted` is built.** After `botctl telegram register`, the operator
  signs in once as the installation owner, opens the existing hosting section with a fresh proof,
  and confirms the counted batch. Existing activation checks (token → DNS → SSL → webhook)
  run sequentially for eligible ACTIVE hosted children, with the stored encrypted token/domain,
  current lifecycle and owner/session checks, per-bot failures and safe queue-preserving retry.
  No configuration or activation-link proof is bypassed; those operations are never called.
  The command requires a terminal, takes no arguments, and refuses the old server's freeze.
  See `docs/server-move.md` for output/exit codes and concurrent-change limits.
  `move verify` reads every bot's `getWebhookInfo` and every domain's
  DNS (`judgeDns`) and TLS (`HttpsTlsProbe`); "here" is the host's own addresses plus
  `HOSTED_BOTS_SERVER_IPS` (and the CNAME target's addresses for a hosted domain).
- **System-path reasons** (pinned): `move: list hosted tenants for the bundle` (also read by
  `move verify`), `move: refuse an import into a running business`, `move: bind a hosted tenant
to verify it after import`.
- **Contract items**: `RECOVERY_SOURCES` + `MOVE`; `MOVE_ERROR_CODES`. No template key: the
  Persian text is the operator's CLI output, never a customer's.

## As built in PR-5 (`feat/6b-enter`, «ورود به پنل»)

§ 9 as designed, with these decisions (binding on later work):

- **Where the session lives.** The hosted Web Admin is reached on the hosted bot's own verified
  domain, which 6A PR-4 already routes (a request's Host resolves to the hosted tenant; the
  sign-in and the Origin check follow it). `POST /hosting/bots/:id/enter` therefore needs the bot
  `ACTIVE` with a domain whose DNS **and TLS** marks are set (the link is `https://`), else
  `hosting.enter_domain_required`. A bot with no verified domain cannot be entered in 6B.
- **Mint.** A fresh code, an idempotency key (a replay answers `url: null`: only the hash is
  kept, so a retry never mints a second token), the HOST principal ensured in the same
  transaction, `hosting.enter` in the owner's log with the token id, domain, expiry and proof.
  The token is bound to the minting section session.
- **Redeem.** `POST /auth/enter` on the hosted domain; the conditional UPDATE names the hash,
  the hosted tenant the Host resolves to, the host itself, unused and unexpired. Inside the
  same transaction the section session, the owner's Web Admin session, his `ACTIVE` status and
  his installation `owner` role must all hold; any failure rolls the spend back and answers
  `hosting.enter_token_invalid` (an unknown Host is refused earlier by the Origin check, 403).
  The entered session expires at `min(section expiry, now + SESSION_TTL)`; its opening is
  recorded as `hosting.enter_opened` in the owner's log.
- **Every request** of an entered session re-reads the same four facts (`ownerOf`, system path
  `hosting: entered session liveness`); when one fails the session is revoked on the spot
  (`entered_session_ended`). Closing or replacing the section also revokes the entered sessions
  at once (`entered_section_ended`). «خروج» is the ordinary sign-out of that session.
- **Permissions.** The resolver gives the HOST principal the whole catalogue only when the
  actor carries `impersonation` (and nothing otherwise, nor to an operator carrying it); the
  guard then drops `IMPERSONATION_DENIED_PERMISSIONS` and the installation-only keys.
- **Secret writers.** Each writer's public entry refuses an impersonated actor before it seals
  anything: bot token replacement, panel create and credentials, the three gateway secrets,
  the support-AI key, the legacy package key, the backup password, the hosting and sign-in
  TOTP enrolment, the refund card and — the safest reading of "every write that seals a new
  secret" — the gift-card batch export, so an entered session cannot create gift-card batches
  either. `tests/unit/impersonation-secret-writers.test.ts` walks `SECRET_COLUMNS` and every
  `.encrypt(` call site. Refusals of a secret writer are not audited (they throw before any
  transaction); permission denials are, in the owner's log.
- **Account security.** Password change, second-factor activation, disabling, backup codes and
  revoking other sessions refuse an entered session; reads stay open.
- **The HOST row** is listed in the admins table as «میزبان» with no controls; the admin
  service answers `admin.not_found` for any change aimed at it; the `nexa_host_admin_guard`
  trigger refuses any UPDATE or DELETE of it and any change of an admin's kind. INSERT stays
  open so a tenant restore can carry it.
- **Audit (D5).** `DrizzleAuditWriter` sends every entry of an impersonated actor to the
  installation's log (`tenant_id` = installation, actor = the owner, `acted_in_tenant_id` = the
  hosted tenant) on the same transaction via `withSystemScopeIn` (`audit: host owner acting in a
hosted tenant`). Outbox events and operational events of an entered session still carry the
  HOST principal's reference inside the hosted tenant (they are not the audit log).
- **Inventory.** `hosting_enter_tokens` is INSTALLATION (a live token must not travel).
- **Mutation checks:** `scripts/claude/hosting-enter-mutation.sh`.

## As built: replace (`feat/6b-tenant-replace`) — restoring over the same hosted bot

The owner added this to the phase: restoring a hosted archive over the SAME tenant on the same
server, a `DELETED` bot included. § 4's replace and § 10's tenant rewrite allowance are now
built; these decisions bind later work:

- **Who may be replaced.** Only a tenant that is a `HOSTED` child of THIS installation with a
  register row here, in any state but `PURGED` (`ACTIVE`, `SUSPENDED`, `EXPIRED`, `DELETED`);
  anything else is `tenant_archive.replace_target_missing` or `.purged`. The archive's tenant id
  IS the target — never another bot's. «بازیابی روی همین سرور» additionally requires the archive
  to be that bot's own (a verified, unpruned run of it, the path derived from the two ids).
- **Dry run.** Exactly a NEW restore's verification into scratch (open, head policy, load,
  byte compare, secrets read), then the replace's refusals: the bot, domain and every GLOBAL
  unique key may not be held by ANOTHER tenant (the bot's own rows are about to go). The slug
  is the live bot's; a NEW slug is ignored. Nothing is written but the request row (mode
  `REPLACE`), left VERIFIED. A confirmation is bound to the mode as well as the file's SHA-256.
- **Apply, in the recovery role, inside ONE admitted exclusive `RESTORE` ticket.** In order:
  1. **hold**: an `ACTIVE` bot's tenant is set `STOPPED` (every write path holds the tenant row
     `FOR SHARE`, so in-flight work finishes and new work is refused); the register is untouched;
  2. **PRE_REPLACE**: a tenant archive of the current rows through the unmodified pipeline
     (`runInsideAdmittedJob`: the same run row and stages, no second ticket — it would wait on
     the first forever), sealed with the bot's own backup password, kept under
     `hosted/<tenant>/<run>/` like any other of its archives and named on the request
     (`pre_replace_run_id`). No password, or anything short of a verified success:
     `tenant_archive.pre_replace_failed`, and nothing is replaced. **Deviation from § 4's
     order:** the PRE_REPLACE archive is taken BEFORE the uploaded archive is re-verified for
     the apply (the dry run already verified it once, and the apply repeats all of it after):
     a PRE_REPLACE run sweeps idle tenant scratch databases first, which would drop the
     replace's own scratch if it were already open;
  3. the archive is re-verified into scratch (as NEW);
  4. **ONE transaction** (system path, reason `tenant archive: replace a hosted tenant's rows`):
     locks the tenant and register rows `FOR UPDATE`; claims the allowance by writing
     `pg_current_xact_id()` into its own request row (APPLYING, REPLACE, this tenant) and
     naming it in `nexa.tenant_rewrite`; defers `hosted_bots_owner_admin_fk` (now `DEFERRABLE
INITIALLY IMMEDIATE`); deletes the tenant's NEVER rows that reference its rows (every
     sign-in session — the host's entered ones included — challenges, read windows, connect
     codes, probe claims) and expires the host's unspent «ورود به پنل» tokens for it; deletes
     every TENANT table's rows children first (`processed_messages` and `aggregate_sequences`
     first, through the outbox) — a table an append-only guard protects on the system path,
     where the guard admits only this tenant, and every other table bound to the tenant under
     row-level security; updates the `tenants` row's settings from the archive (never its id,
     kind, parent, slug or status); inserts every archive row exactly as a NEW restore does
     (bound to the tenant, secrets resealed under the active key, unpublished outbox messages
     landed exhausted, shared aggregates renumbered); points the register at the archive's
     owner admin when the current one is not in it, and the activation at the archive's bot
     (token and webhook marks cleared only when the bot changed; the domain and its DNS/TLS
     marks stay); sets the tenant's status to what its register state holds; compares counts
     and canonical digests of every table with the scratch; and only then commits. **Any
     failure at any point rolls the whole transaction back: the old rows stay until the new
     ones are in and counted**, and the PRE_REPLACE archive keeps them after a success.
- **The bot's status afterwards** is `HOSTED_BOT_TENANT_STATUS[register state]` — the state
  it had: an `ACTIVE` bot is `ACTIVE` again, a `DELETED` one stays `DELETED`/`DISABLED` until the
  owner activates it (the existing `DELETED → ACTIVE` step, with its token re-entry). After a
  failure the service releases the hold; after a crash the next admitted restore reconciles
  every hosted tenant of the installation to its register's status (only the hosting system
  path writes a hosted tenant's status, always to that mapping, so this undoes no decision).
- **The window cannot lose a row** (lead review of #454, Codex P1). Two locks, either enough
  alone:
  - the hold answers the register state it held, and a **snapshot** of the bot is read right
    after the hold and BEFORE the PRE_REPLACE archive: count and canonical digest of every
    TENANT table (secrets by plaintext; the outbox's relay bookkeeping left out, a held bot's
    messages may still be relayed). The replace's transaction, under its `FOR UPDATE` lock of
    the tenant and register rows, requires the same register state, the held status, and the
    same snapshot; anything else is `tenant_archive.changed_during_replace` and NOTHING is
    deleted — a row written after the archive's snapshot is never lost. Inside that
    transaction (READ COMMITTED) the comparison reads every row `FOR UPDATE`, so no compared
    row can change or go before it ends; a row INSERTED meanwhile is caught by the count each
    `DELETE` must report (exactly the compared rows, else the same refusal and a rollback) and
    by the bot's tables being empty after the deletes. Most tables also cannot take such an
    insert at all: their foreign key to `tenants` needs a KEY SHARE lock the replace's
    `FOR UPDATE` of the tenant row refuses until it ends; the rest (`audit_logs`,
    `operational_events`, `outbox_messages`, `request_idempotency`, and the two keyed through
    the outbox) are covered by the counts. A higher isolation level was not used: SSI detects
    nothing against a READ COMMITTED writer, and REPEATABLE READ would hide a concurrent
    insert from the very DELETE that must see it. A PRE_REPLACE archive
    is never delivered to the bot's group (delivery would write into the bot being compared);
  - while a REPLACE of a bot is `VERIFYING` or `APPLYING`, no hosting transition moves it:
    suspend, activate, delete and purge answer `hosting.replace_in_progress` (before the code
    and again in the transaction), and the register `UPDATE` itself refuses, so the expiry
    sweep leaves it too. Setting an expiry date is not a transition and stays allowed.
- **The allowance (§ 10), as built** (migration `0337`). `nexa_tenant_rewrite_allowed(uuid)`:
  `SECURITY DEFINER`, owned by the migration owner, `search_path = pg_catalog`, `EXECUTE`
  revoked from PUBLIC (and from nexa_app, re-asserted with the role grants after a `--no-acl`
  restore) and granted to nexa_system only; true only for a `tenant_restores` row named by
  `nexa.tenant_rewrite` that is REPLACE, APPLYING, for exactly that tenant and claimed by the
  current transaction. `nexa_tenant_rewrite_permits(uuid)`: `SECURITY INVOKER`, requires
  `current_user = 'nexa_system'` and the replace's literal reason before calling it (nested
  `IF`s: SQL does not order an `AND`). **12 guard functions fire on DELETE today** —
  `nexa_reject_mutation` and the table-specific ones (gateway invoice cards, legacy cleanup,
  legacy history, notification evidence, order cashback, order custom-service terms, order
  referral commissions, referenced products, system roles, published terms, and PR-5's HOST
  admin guard); each gained one branch at its top and is otherwise unchanged; UPDATE stays
  refused. ADR § 10's "41" counted every trigger function: the other 29 fire only on INSERT or
  UPDATE and cannot see a DELETE, so they are unchanged. The one other DELETE trigger, the
  last-owner check, is a deferred constraint trigger and keeps refusing: a replace must commit
  with an active owner. `tenant_erasures` is still not built; the function names only
  `tenant_restores`.
- **Proof.** `tests/integration/tenant-rewrite-allowance.test.ts` reads every (guard, table)
  pair that fires on DELETE from `pg_trigger` (so a guard added without the branch fails) and
  proves on a probe of each: refused outside the run; admitted inside; refused as nexa_app,
  under another reason, for another tenant's row, with the request not APPLYING, with another
  id named, and in a transaction that did not claim it; UPDATE refused inside. It also checks
  the lookup's definer/search_path/grants. `tests/integration/isolation-proof/tenant-replace.test.ts`
  replaces HOSTED_1 of the isolation world end to end (exact archive afterwards, the
  installation and HOSTED_2 unchanged table by table, the HOST principal and its entered
  session gone, PRE_REPLACE verified, the allowance dead after commit), fails a forged archive
  mid-transaction with every old row intact, replaces a `DELETED` bot, and refuses no password,
  `PURGED` and a foreign bot. Mutation checks: `scripts/claude/tenant-archive-mutation.sh`
  (twelve source, six SQL).
- **UI.** Each verified archive row in the bot's backups offers «بازیابی روی همین سرور» (fresh
  code and the archive's password: a later password change does not reopen older archives),
  which leaves a VERIFIED replace in «بازیابی ربات از فایل»; that page's dry run has
  «جایگزینی ربات موجود», shows each request's mode and PRE_REPLACE archive, and confirms a
  replace with its own warning. The owner's log records the dry run and the confirmation
  (with the mode and the bot); the hosted tenant's audit log receives nothing of it (D5).
- **Contract.** `tenant_archive.replace_unavailable` is removed; `.replace_target_missing`,
  `.pre_replace_failed`, `.changed_during_replace` and `hosting.replace_in_progress` added; the dry run's `mode`, the view's `mode`/`preReplaceRunId`, the
  `restoreHere` route; system-path reasons `tenant archive: replace a hosted tenant's rows`,
  `…: the hosted bot a replace writes over`, `…: hold a hosted bot still for its replace`,
  `…: return a hosted bot to its register status` (pinned).

## Open

- Off-site (S3) copies of hosted archives: the destination and its credentials are the owner's;
  whether hosted archives go there is his call (`docs/open-questions.md`).
- § 6 as above; § 10's erasure itself (the allowance is built for replace only).
- A hosted tenant with reseller children cannot be archived (`has_child_tenants`) until a subtree
  archive is designed.
