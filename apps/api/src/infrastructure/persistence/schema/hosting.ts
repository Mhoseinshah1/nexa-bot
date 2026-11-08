/**
 * Database schema — hosting: the creator panel «میزبانی‌ها» and hosted-bot activation.
 *
 * One part of `../schema.ts`, which re-exports every part; import from there.
 */
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { HOSTED_ACTIVATION_STEPS, HOSTED_BOT_STATES } from '@nexa/contracts';
import { enumCheck, timestamptz } from './_shared.js';
import { tenants } from './tenancy.js';
import { admins } from './identity.js';

// ---------------------------------------------------------------------------
// Phase 6A PR-3 (D1): the creator panel, «میزبانی‌ها»
// ---------------------------------------------------------------------------

/**
 * The installation owner's register of hosted bots: one row per hosted tenant.
 *
 * OWNED BY THE INSTALLATION TENANT (`tenant_id`), not by the hosted one: it is the owner's
 * record of what he hosts, written and read in his scope, and a hosted bot's own operators
 * never see it. `hosted_tenant_id` is the hosted tenant (kind `HOSTED`).
 *
 * `state` says WHY the hosted tenant is (or is not) running; the hosted TENANT row's `status`
 * is what actually stops it (`HOSTED_BOT_TENANT_STATUS`), and the two are written in one
 * transaction by `HostingService` alone.
 */
export const hostedBots = pgTable(
  'hosted_bots',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    hostedTenantId: uuid('hosted_tenant_id')
      .notNull()
      .references(() => tenants.id),
    state: text('state').notNull(),
    /** NULL = no expiry. */
    expiresAt: timestamptz('expires_at'),
    /** The hosted bot's first Web Admin owner, created with it. */
    ownerAdminId: uuid('owner_admin_id').notNull(),
    createdByAdminId: uuid('created_by_admin_id').notNull(),
    createdAt: timestamptz('created_at').notNull(),
    stateChangedAt: timestamptz('state_changed_at').notNull(),
    deletedAt: timestamptz('deleted_at'),
    purgedAt: timestamptz('purged_at'),
    updatedAt: timestamptz('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ name: 'hosted_bots_pkey', columns: [table.tenantId, table.hostedTenantId] }),
    // A tenant is hosted by one installation, once.
    uniqueIndex('hosted_bots_hosted_tenant_key').on(table.hostedTenantId),
    index('hosted_bots_tenant_state_idx').on(table.tenantId, table.state),
    // The expiry sweep's read: live rows whose date has passed.
    index('hosted_bots_tenant_expiry_idx')
      .on(table.tenantId, table.expiresAt)
      .where(sql`state = 'ACTIVE' AND expires_at IS NOT NULL`),
    check('hosted_bots_state_check', enumCheck('state', HOSTED_BOT_STATES)),
    check('hosted_bots_not_self_check', sql`tenant_id <> hosted_tenant_id`),
    check(
      'hosted_bots_deleted_check',
      sql`(state IN ('DELETED', 'PURGED')) = (deleted_at IS NOT NULL)`,
    ),
    check('hosted_bots_purged_check', sql`(state = 'PURGED') = (purged_at IS NOT NULL)`),
    foreignKey({
      name: 'hosted_bots_owner_admin_fk',
      columns: [table.hostedTenantId, table.ownerAdminId],
      foreignColumns: [admins.tenantId, admins.id],
    }),
    foreignKey({
      name: 'hosted_bots_created_by_fk',
      columns: [table.tenantId, table.createdByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
    }),
  ],
);

/**
 * The creator panel's OWN second factor: one RFC 6238 secret per installation owner,
 * separate from the Web Admin sign-in factor (`admin_totp_factors`) so neither can open the
 * other. The secret is sealed under `hosting.totp_secret`, the entity being this row's id.
 *
 * `failed_attempts` / `locked_until` are the section's code throttle: every code attempt —
 * activation, opening the section, a sensitive action, a recovery code — reserves one under
 * this row's lock and commits BEFORE the code is checked; a success resets it.
 */
export const hostingTotpFactors = pgTable(
  'hosting_totp_factors',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    adminId: uuid('admin_id').notNull(),
    state: text('state').notNull(),
    totpSecretCiphertext: text('totp_secret_ciphertext').notNull(),
    totpSecretKeyId: text('totp_secret_key_id').notNull(),
    lastUsedStep: integer('last_used_step'),
    failedAttempts: integer('failed_attempts').notNull().default(0),
    lockedUntil: timestamptz('locked_until'),
    /** The Web Admin session the pending secret was shown to: activation must come from it. */
    enrolledSessionId: uuid('enrolled_session_id'),
    createdAt: timestamptz('created_at').notNull(),
    activatedAt: timestamptz('activated_at'),
    updatedAt: timestamptz('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('hosting_totp_factors_admin_key').on(table.tenantId, table.adminId),
    check('hosting_totp_factors_state_check', enumCheck('state', ['PENDING', 'ACTIVE'])),
    check(
      'hosting_totp_factors_activated_check',
      sql`(state = 'ACTIVE') = (activated_at IS NOT NULL)`,
    ),
    check('hosting_totp_factors_step_check', sql`last_used_step IS NULL OR last_used_step >= 0`),
    check('hosting_totp_factors_attempts_check', sql`failed_attempts >= 0`),
    foreignKey({
      name: 'hosting_totp_factors_tenant_admin_fk',
      columns: [table.tenantId, table.adminId],
      foreignColumns: [admins.tenantId, admins.id],
    }),
  ],
);

/** The section's one-time recovery codes: hashes only, spent by a conditional update. */
export const hostingRecoveryCodes = pgTable(
  'hosting_recovery_codes',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    adminId: uuid('admin_id').notNull(),
    codeHash: text('code_hash').notNull(),
    createdAt: timestamptz('created_at').notNull(),
    usedAt: timestamptz('used_at'),
  },
  (table) => [
    uniqueIndex('hosting_recovery_codes_hash_key').on(
      table.tenantId,
      table.adminId,
      table.codeHash,
    ),
    foreignKey({
      name: 'hosting_recovery_codes_tenant_admin_fk',
      columns: [table.tenantId, table.adminId],
      foreignColumns: [admins.tenantId, admins.id],
    }),
  ],
);

/**
 * An opened creator-panel section: 12 hours, bound to the Web Admin session it was opened
 * from (a sign-out or another browser does not inherit it). The token is a cookie of its
 * own; only its SHA-256 is stored.
 */
export const hostingSessions = pgTable(
  'hosting_sessions',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    adminId: uuid('admin_id').notNull(),
    adminSessionId: uuid('admin_session_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    createdAt: timestamptz('created_at').notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
    revokedAt: timestamptz('revoked_at'),
  },
  (table) => [
    uniqueIndex('hosting_sessions_token_key').on(table.tokenHash),
    index('hosting_sessions_tenant_admin_idx').on(table.tenantId, table.adminId, table.expiresAt),
    check('hosting_sessions_expiry_check', sql`expires_at > created_at`),
    foreignKey({
      name: 'hosting_sessions_tenant_admin_fk',
      columns: [table.tenantId, table.adminId],
      foreignColumns: [admins.tenantId, admins.id],
    }),
  ],
);

// ---------------------------------------------------------------------------
// Phase 6A PR-4 (D2): the activation of a hosted bot
// ---------------------------------------------------------------------------

/**
 * Where one hosted bot's activation stands: the domain the hosted owner pointed at this server,
 * the bot instance holding the token, and when each setup step last succeeded.
 *
 * OWNED BY THE INSTALLATION TENANT, like `hosted_bots` (the owner's own record, read and
 * written in his scope); `hosted_tenant_id` is the hosted tenant. The bot token itself is NOT
 * here: it lives encrypted on the hosted tenant's `bot_instances` row, `bot_instance_id`.
 *
 * `domain` is unique across the installation (one hosted bot per name) and lowercase. A
 * domain is TRUSTED (resolves a request's Host to this tenant, and is approved for a
 * certificate) only while `dns_verified_at` is set; changing the domain clears the DNS, SSL
 * and webhook marks together, so no mark ever names a domain it was not earned for.
 * `last_error_*` is the newest failed step's closed code, cleared when that step next succeeds.
 */
export const hostedBotActivations = pgTable(
  'hosted_bot_activations',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    hostedTenantId: uuid('hosted_tenant_id')
      .notNull()
      .references(() => tenants.id),
    botInstanceId: uuid('bot_instance_id'),
    domain: text('domain'),
    tokenVerifiedAt: timestamptz('token_verified_at'),
    dnsVerifiedAt: timestamptz('dns_verified_at'),
    tlsVerifiedAt: timestamptz('tls_verified_at'),
    webhookRegisteredAt: timestamptz('webhook_registered_at'),
    lastErrorStep: text('last_error_step'),
    lastErrorCode: text('last_error_code'),
    lastErrorAt: timestamptz('last_error_at'),
    /** The hosted owner redeemed a link and chose their credentials. */
    ownerActivatedAt: timestamptz('owner_activated_at'),
    createdAt: timestamptz('created_at').notNull(),
    updatedAt: timestamptz('updated_at').notNull(),
  },
  (table) => [
    primaryKey({
      name: 'hosted_bot_activations_pkey',
      columns: [table.tenantId, table.hostedTenantId],
    }),
    foreignKey({
      name: 'hosted_bot_activations_hosted_fk',
      columns: [table.tenantId, table.hostedTenantId],
      foreignColumns: [hostedBots.tenantId, hostedBots.hostedTenantId],
    }),
    uniqueIndex('hosted_bot_activations_domain_key')
      .on(table.domain)
      .where(sql`domain IS NOT NULL`),
    check(
      'hosted_bot_activations_domain_shape_check',
      sql`domain IS NULL OR (domain = lower(domain) AND char_length(domain) BETWEEN 4 AND 253)`,
    ),
    check(
      'hosted_bot_activations_error_step_check',
      sql`last_error_step IS NULL OR last_error_step IN (${sql.raw(
        HOSTED_ACTIVATION_STEPS.map((step) => `'${step}'`).join(', '),
      )})`,
    ),
    check(
      'hosted_bot_activations_error_check',
      sql`(last_error_step IS NULL) = (last_error_code IS NULL) AND (last_error_step IS NULL) = (last_error_at IS NULL)`,
    ),
    // A mark a step could not have earned without its predecessor.
    check(
      'hosted_bot_activations_order_check',
      sql`(tls_verified_at IS NULL OR dns_verified_at IS NOT NULL)
        AND (dns_verified_at IS NULL OR domain IS NOT NULL)
        AND (webhook_registered_at IS NULL OR (tls_verified_at IS NOT NULL AND token_verified_at IS NOT NULL))`,
    ),
  ],
);

/**
 * The one-time links a hosted owner activates their Web Admin with.
 *
 * Only `token_hash` (SHA-256 of 256 random bits) is stored: a database read cannot be replayed
 * as a link. A link is good while `used_at` and `revoked_at` are NULL and `expires_at` has not
 * passed; it is spent by one conditional UPDATE, so two redemptions cannot both succeed, and a
 * newer link revokes the older unused ones. Owned by the installation tenant (the creator made
 * it); `hosted_tenant_id` is the tenant it activates.
 */
export const hostedBotActivationLinks = pgTable(
  'hosted_bot_activation_links',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    hostedTenantId: uuid('hosted_tenant_id')
      .notNull()
      .references(() => tenants.id),
    tokenHash: text('token_hash').notNull(),
    createdByAdminId: uuid('created_by_admin_id').notNull(),
    createdAt: timestamptz('created_at').notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
    usedAt: timestamptz('used_at'),
    revokedAt: timestamptz('revoked_at'),
  },
  (table) => [
    uniqueIndex('hosted_bot_activation_links_token_key').on(table.tokenHash),
    index('hosted_bot_activation_links_hosted_idx').on(
      table.tenantId,
      table.hostedTenantId,
      table.createdAt,
    ),
    check('hosted_bot_activation_links_expiry_check', sql`expires_at > created_at`),
    foreignKey({
      name: 'hosted_bot_activation_links_hosted_fk',
      columns: [table.tenantId, table.hostedTenantId],
      foreignColumns: [hostedBots.tenantId, hostedBots.hostedTenantId],
    }),
    foreignKey({
      name: 'hosted_bot_activation_links_created_by_fk',
      columns: [table.tenantId, table.createdByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
    }),
  ],
);
