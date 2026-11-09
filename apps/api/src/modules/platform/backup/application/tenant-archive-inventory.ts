/**
 * Phase 6B (ADR-0039 § 1): every table of the schema, classified for a TENANT archive.
 *
 * The export engine is DRIVEN by this file: it archives exactly the `TENANT` tables, in the
 * load order it computes from the live catalogue, and writes the tenant's row count of every
 * `INSTALLATION` and `NEVER` table into the manifest's `notExported` with the reason given here.
 * A live table that is in none of the lists refuses the export
 * (`tenant_archive.unclassified_table`), and `tests/unit/tenant-archive-inventory.test.ts`
 * fails the build when a `pgTable` is added without a class — the classification is a
 * decision, never a default.
 *
 * Pure data: no database, no I/O.
 */

import { AGGREGATE_OWNERSHIP } from '@nexa/contracts';

export type TenantArchiveClass = 'TENANT' | 'INSTALLATION' | 'NEVER';

/**
 * The aggregate types whose counter is the INSTALLATION's, shared by every tenant
 * (`AGGREGATE_OWNERSHIP`): their `aggregate_sequences` rows are never exported, and a restore
 * renumbers the archive's outbox messages of them after the target's own counter.
 */
export const SHARED_AGGREGATE_TYPES: readonly string[] = Object.entries(AGGREGATE_OWNERSHIP)
  .filter(([, owner]) => owner === 'SHARED_KEY')
  .map(([type]) => type)
  .sort();
/** The same list as fixed SQL (contract constants, never input). */
const SHARED_AGGREGATES_SQL = SHARED_AGGREGATE_TYPES.map((type) => `'${type}'`).join(', ');

/**
 * The installation's own state, or the owner's register of what he hosts. Never in a tenant
 * archive. The register (`hosted_bots`, `hosted_bot_activations`) travels as the manifest's
 * HOST FACTS instead, and is written afresh by the target's restore.
 */
export const INSTALLATION_TABLES: Readonly<Record<string, string>> = {
  backup_runs: "the installation's archive history (no tenant)",
  backup_run_parts: "the installation's archive history (no tenant)",
  installation_keys: 'key management (no tenant)',
  process_runs: 'process state (no tenant)',
  hosted_bots: "the owner's register; carried as host facts",
  hosted_bot_activations: "the owner's register; carried as host facts",
  hosted_bot_activation_links: 'one-time links the owner issued; an unused one must not travel',
  hosting_totp_factors: "the owner's section factor",
  hosting_recovery_codes: "the owner's section factor",
  hosting_sessions: "the owner's section sessions",
  recovery_requests: 'whole-installation restores',
  secret_reentry_items: 'whole-installation restores',
  backup_archive_passwords: "the installation's own archive password",
  tenant_restores: "the owner's record of tenant restores into this installation",
};

/**
 * The tenant's rows, deliberately LEFT OUT of its archive: bound to this server's live
 * processes or to live access credentials, so restoring them anywhere is meaningless or
 * dangerous.
 */
export const NEVER_TABLES: Readonly<Record<string, string>> = {
  admin_sessions: 'live sign-in sessions; a restore anywhere signs everyone out',
  admin_login_challenges: 'minutes-long second-factor challenges',
  admin_login_throttle: 'sign-in counters (also excluded from the installation dump)',
  admin_read_windows: 'one-day bulk-read alert windows',
  ops_log_connect_codes: 'ten-minute group-connect codes',
  heavy_job_tickets: "this server's live queue (leases)",
  panel_probe_claims: 'connection-test cooldowns (also excluded from the installation dump)',
  tenant_capacity_limits: "the host's policy for this tenant; carried as host facts",
};

/**
 * TENANT tables selected by something other than `tenant_id = $1`. Each is a fixed SQL
 * predicate over the table, with `$1` the tenant id.
 *
 * - `tenants`: the tenant's own row.
 * - `processed_messages`: the consumers' dedupe rows for the outbox messages the archive
 *   carries (ADR-0025's example of a table that is not a cache).
 * - `aggregate_sequences`: the outbox counters of the aggregates the tenant's outbox names. A
 *   counter row is written ONLY beside an outbox message (`outbox-writer.ts`), so the join is
 *   complete; never `MAX(sequence)` (ADR-0025).
 */
export const TENANT_KEYED_OTHERWISE: Readonly<Record<string, string>> = {
  tenants: 'id = $1',
  processed_messages: 'message_id IN (SELECT o.id FROM outbox_messages o WHERE o.tenant_id = $1)',
  aggregate_sequences:
    `aggregate_type NOT IN (${SHARED_AGGREGATES_SQL}) AND ` +
    '(aggregate_type, aggregate_id) IN (SELECT o.aggregate_type, o.aggregate_id FROM outbox_messages o WHERE o.tenant_id = $1)',
};

/** Every TENANT table selected by `tenant_id` (ADR-0039 § 1, by schema file). */
export const TENANT_TABLES: readonly string[] = [
  // broadcasts.ts
  'frozen_audiences',
  'frozen_audience_members',
  'broadcasts',
  'broadcast_media',
  'broadcast_media_handles',
  'broadcast_recipients',
  'broadcast_bot_pacing',
  'bulk_operations',
  'bulk_operation_items',
  // business-chats.ts
  'telegram_wizards',
  'telegram_review_messages',
  'telegram_message_horizons',
  'telegram_business_connections',
  'business_conversations',
  'business_messages',
  'business_outbound_messages',
  'business_conversation_escalations',
  // catalogue.ts
  'product_categories',
  'products',
  'service_addons',
  'delivery_tutorials',
  'client_apps',
  'client_app_videos',
  // control-plane.ts
  'bot_appearance_slots',
  'template_overrides',
  'template_revisions',
  'setting_values',
  'main_menu_revisions',
  'main_menu_layouts',
  'feature_flag_states',
  'custom_menu_button_media',
  'custom_menu_buttons',
  'custom_menu_button_bots',
  // custom-services.ts
  'custom_service_locations',
  'custom_service_price_rules',
  'order_custom_service_terms',
  // customers.ts
  'customers',
  'customer_text_captures',
  'customer_location_change_overrides',
  'customer_direct_messages',
  'terms_versions',
  'terms_acceptances',
  'customer_captchas',
  'customer_tags',
  'customer_tag_assignments',
  'customer_notes',
  'miniapp_sessions',
  // eventing.ts
  'outbox_messages',
  'request_idempotency',
  'audit_logs',
  'operational_events',
  // gateway-invoices.ts
  'gateway_invoices',
  'gateway_invoice_cards',
  'gateway_card_changes',
  'gateway_provider_requests',
  'gateway_invoice_provider_facts',
  'gateway_receipt_captures',
  'gateway_receipt_submissions',
  // gateways.ts
  'payment_accounts',
  'payment_gateways',
  'payment_gateway_credentials',
  'gateway_customer_numbers',
  'payment_gateway_call_budgets',
  'fx_quotes',
  'fx_source_states',
  // identity.ts
  'admins',
  'roles',
  'role_permissions',
  'admin_roles',
  'admin_permission_overrides',
  'admin_known_ips',
  'admin_totp_factors',
  'admin_backup_codes',
  // legacy-history.ts
  'legacy_invoice_archive',
  'legacy_wallet_debts',
  'legacy_service_candidates',
  'legacy_cutover_approvals',
  'legacy_cutover_approval_revocations',
  'legacy_nxpkg_imports',
  'legacy_history_records',
  'legacy_compaction_runs',
  // legacy-import.ts
  'legacy_product_shapes',
  'legacy_trial_eligibility',
  'legacy_import_runs',
  'legacy_import_map',
  'legacy_import_run_inputs',
  'legacy_read_set_runs',
  'legacy_product_reviews',
  'legacy_invoice_archive_runs',
  'legacy_invoice_archive_staging',
  // marketing.ts
  'discounts',
  'discount_redemptions',
  'discount_code_captures',
  'cashback_rules',
  'order_cashback',
  'cashback_reversals',
  'campaigns',
  'campaign_actions',
  // notifications.ts
  'notifications',
  'notification_released_claims',
  'notification_delivery_attempts',
  'customer_notifications',
  'customer_notification_rate_windows',
  'customer_reminder_raise_counters',
  'ops_log_groups',
  'ops_log_topics',
  'admin_notification_reads',
  // ops.ts
  'incidents',
  'incident_targets',
  'incident_effects',
  'incident_events',
  'incident_communications',
  'incident_notices',
  'data_compaction_runs',
  // orders.ts
  'panel_capacity_reservations',
  'username_captures',
  'service_username_reservations',
  'orders',
  'order_panel_placements',
  // panels.ts
  'panels',
  'panel_credentials',
  'panel_health',
  'panel_policies',
  'panel_probe_budgets',
  'panel_monitor_schedule',
  'panel_monitor_tenants',
  'panel_trial_configs',
  'panel_setting_values',
  // payments.ts
  'payments',
  'receipt_captures',
  'payment_receipts',
  'payment_destinations',
  'payment_destination_switches',
  // provisioning.ts
  'provisioning_operations',
  'operation_card_messages',
  // referrals.ts
  'referrals',
  'referral_codes',
  'order_referral_commissions',
  'referral_commission_reversals',
  'referral_signup_gifts',
  // refunds.ts
  'refunds',
  'admin_amount_captures',
  'service_refund_requests',
  'service_refund_request_pushes',
  // resellers.ts
  'reseller_tiers',
  'reseller_tier_product_prices',
  'reseller_tier_grants',
  'resellers',
  'reseller_entitlement_overrides',
  'reseller_grant_overrides',
  'reseller_minimum_notices',
  'order_reseller_terms',
  'reseller_request_questions',
  'reseller_requests',
  'reseller_request_messages',
  'reseller_request_drafts',
  // service-lifecycle.ts
  'trial_resets',
  'trial_limit_overrides',
  'trial_grants',
  'service_ownership_transfers',
  'customer_account_transfers',
  'service_location_changes',
  'service_auto_renew_preferences',
  'service_auto_renew_runs',
  'service_auto_delete_runs',
  // services.ts
  'services',
  'service_reminders',
  'service_reminder_baselines',
  'service_usage_snapshots',
  'service_locations',
  'service_commercial_actions',
  // support.ts
  'support_faqs',
  'support_faq_seeds',
  'ticket_categories',
  'ticket_category_seeds',
  'tickets',
  'ticket_messages',
  'ticket_reply_files',
  // support-ai.ts
  'support_ai_configs',
  'support_ai_provider_credentials',
  'support_ai_runs',
  'support_ai_jobs',
  'support_ai_ticket_jobs',
  'support_ai_ticket_holds',
  'support_ai_image_outcomes',
  // support-knowledge.ts
  'support_learning_candidates',
  'support_knowledge_articles',
  'support_knowledge_revisions',
  'support_learning_jobs',
  'support_knowledge_builds',
  'support_knowledge_build_proposals',
  // tenancy.ts
  'bot_instances',
  'bot_command_syncs',
  'tenant_media_assets',
  // wallet.ts
  'wallet_entries',
  'wallet_history_imports',
  'receipt_credits',
  'receipt_review_pushes',
  'wallet_threshold_alerts',
  'gift_card_batches',
  'gift_card_codes',
  'gift_card_redemption_attempts',
];

/**
 * The unique keys of TENANT tables that do not include `tenant_id` — a value one tenant's
 * row holds that NO other tenant's row may hold. A restore refuses when any of them collides
 * with another tenant's row on the target (`tenant_archive.unique_collision`, naming the
 * table, never the value).
 *
 * `OWN_IDS` keys lead with the tenant's own row ids (a uuid of its own panel, bot, order or
 * conversation): they can collide only when the same tenant is present, which is refused
 * first (`tenant_archive.tenant_exists`). They are listed so the test can tell a key that was
 * considered from one that was not.
 */
export interface GlobalUniqueKey {
  readonly table: string;
  readonly index: string;
  readonly columns: readonly string[];
  /** The index's partial predicate, as fixed SQL, or null. */
  readonly where: string | null;
  readonly kind: 'GLOBAL' | 'OWN_IDS';
}

export const GLOBAL_UNIQUE_KEYS: readonly GlobalUniqueKey[] = [
  /*
   * The slug is a label, not an id (ADR-0039 § 4): a taken one is refused with
   * `hosting.slug_taken` and the restore asks for a new slug — never a merge. The restored row is
   * always HOSTED, so the one-PRIMARY key cannot collide; it is listed as considered.
   */
  { table: 'tenants', index: 'tenants_slug_key', columns: ['slug'], where: null, kind: 'GLOBAL' },
  {
    table: 'tenants',
    index: 'tenants_single_primary_key',
    columns: ['kind'],
    where: "kind = 'PRIMARY'",
    kind: 'OWN_IDS',
  },
  {
    table: 'bot_instances',
    index: 'bot_instances_username_key',
    columns: ['username'],
    where: null,
    kind: 'GLOBAL',
  },
  {
    table: 'bot_instances',
    index: 'bot_instances_telegram_bot_id_key',
    columns: ['telegram_bot_id'],
    where: 'telegram_bot_id IS NOT NULL',
    kind: 'GLOBAL',
  },
  {
    table: 'gateway_customer_numbers',
    index: 'gateway_customer_numbers_number_key',
    columns: ['provider', 'number'],
    where: null,
    kind: 'GLOBAL',
  },
  {
    table: 'gateway_invoices',
    index: 'gateway_invoices_centralpay_order_id_key',
    columns: ['provider_order_id'],
    where: "provider = 'CENTRALPAY'",
    kind: 'GLOBAL',
  },
  {
    table: 'legacy_nxpkg_imports',
    index: 'legacy_nxpkg_imports_one_applying_idx',
    columns: ['status'],
    where: "status = 'APPLYING'",
    kind: 'GLOBAL',
  },
  {
    table: 'operational_events',
    index: 'operational_events_dedupe_key',
    columns: ['dedupe_scope', 'dedupe_key'],
    where: null,
    kind: 'GLOBAL',
  },
  {
    table: 'outbox_messages',
    index: 'outbox_messages_aggregate_sequence_key',
    columns: ['aggregate_type', 'aggregate_id', 'sequence'],
    // A shared aggregate's messages are renumbered on restore, so cannot collide.
    where: `aggregate_type NOT IN (${SHARED_AGGREGATES_SQL})`,
    kind: 'GLOBAL',
  },
  {
    table: 'request_idempotency',
    index: 'request_idempotency_scope_key',
    columns: ['scope_ref', 'key'],
    where: null,
    kind: 'GLOBAL',
  },
  {
    table: 'service_username_reservations',
    index: 'service_username_reservations_name_key',
    columns: ['namespace_key', 'username'],
    where: null,
    kind: 'GLOBAL',
  },
  {
    table: 'aggregate_sequences',
    index: 'aggregate_sequences_pkey',
    columns: ['aggregate_type', 'aggregate_id'],
    where: null,
    kind: 'GLOBAL',
  },
  {
    table: 'processed_messages',
    index: 'processed_messages_pkey',
    columns: ['consumer', 'message_id'],
    where: null,
    kind: 'OWN_IDS',
  },
  {
    table: 'business_conversations',
    index: 'business_conversations_chat_key',
    columns: ['bot_instance_id', 'owner_telegram_user_id', 'chat_id'],
    where: null,
    kind: 'OWN_IDS',
  },
  {
    table: 'business_messages',
    index: 'business_messages_message_key',
    columns: ['conversation_id', 'telegram_message_id'],
    where: null,
    kind: 'OWN_IDS',
  },
  {
    table: 'payments',
    index: 'payments_order_confirmed_key',
    columns: ['order_id'],
    where: "state = 'CONFIRMED' AND order_id IS NOT NULL",
    kind: 'OWN_IDS',
  },
  {
    table: 'services',
    index: 'services_panel_subscription_ref_key',
    columns: ['panel_id', 'subscription_ref'],
    where: null,
    kind: 'OWN_IDS',
  },
  {
    table: 'services',
    index: 'services_panel_provider_username_key',
    columns: ['panel_id', 'provider_username'],
    where: "state <> 'TERMINATED'",
    kind: 'OWN_IDS',
  },
  {
    table: 'telegram_business_connections',
    index: 'telegram_business_connections_bot_connection_key',
    columns: ['bot_instance_id', 'connection_id'],
    where: null,
    kind: 'OWN_IDS',
  },
];

const TENANT_SET = new Set<string>([...TENANT_TABLES, ...Object.keys(TENANT_KEYED_OTHERWISE)]);

/** The class of `table`, or null when this release does not classify it. */
export function tenantArchiveClassOf(table: string): TenantArchiveClass | null {
  if (TENANT_SET.has(table)) return 'TENANT';
  if (Object.hasOwn(INSTALLATION_TABLES, table)) return 'INSTALLATION';
  if (Object.hasOwn(NEVER_TABLES, table)) return 'NEVER';
  return null;
}

/** Why a classified table is left out of a tenant archive, or null for a TENANT table. */
export function notExportedReason(table: string): string | null {
  return INSTALLATION_TABLES[table] ?? NEVER_TABLES[table] ?? null;
}

/** The fixed SQL predicate selecting the tenant's rows of a TENANT table (`$1` the tenant). */
export function tenantRowPredicate(table: string): string {
  if (tenantArchiveClassOf(table) !== 'TENANT') {
    throw new Error(`${table} is not a TENANT table of the tenant archive`);
  }
  // `audit_logs.tenant_id` is nullable: only the rows naming the tenant are its.
  return TENANT_KEYED_OTHERWISE[table] ?? 'tenant_id = $1';
}
