/**
 * Database schema — the reseller web panel (PR-4): one-time sign-in links, sessions, the
 * devices a reseller signed in from, their optional TOTP factor, their notification
 * preferences, and the connection-file fetch counter.
 *
 * One part of `../schema.ts`, which re-exports every part; import from there.
 *
 * Every table belongs to the reseller's tenant and names the reseller's customer through the
 * composite `(tenant_id, customer_id)` key the reseller row itself is keyed by, so row-level
 * security confines each to its tenant like every other tenant table. No raw IP address is
 * kept here: a session holds the /24 (or /48) network it opened from, and the audit row of the
 * sign-in is where the address lives, for as long as the audit rule keeps it.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
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
import {
  RESELLER_WEB_SESSION_END_REASONS,
  RESELLER_WEB_SESSION_STATES,
  RESELLER_WEB_TOTP_STATES,
} from '@nexa/contracts';
import { enumCheck, timestamptz } from './_shared.js';
import { botInstances, tenants } from './tenancy.js';
import { customers } from './customers.js';

/**
 * A one-time link «ورود به پنل وب» issued in the bot. Only a domain-separated SHA-256 of the
 * token is stored; the token lives in the link's fragment. Spent by ONE conditional UPDATE
 * (`used_at IS NULL AND expires_at > now`), which records the session it opened.
 */
export const resellerWebLoginTokens = pgTable(
  'reseller_web_login_tokens',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    customerId: uuid('customer_id').notNull(),
    /** The bot the reseller asked from: the session acts in its scope, as the bot's turn does. */
    botInstanceId: uuid('bot_instance_id')
      .notNull()
      .references(() => botInstances.id),
    tokenHash: text('token_hash').notNull(),
    createdAt: timestamptz('created_at').notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
    usedAt: timestamptz('used_at'),
    sessionId: uuid('session_id'),
  },
  (table) => [
    uniqueIndex('reseller_web_login_tokens_token_key').on(table.tokenHash),
    index('reseller_web_login_tokens_customer_idx').on(
      table.tenantId,
      table.customerId,
      table.createdAt,
    ),
    check('reseller_web_login_tokens_expiry_check', sql`expires_at > created_at`),
    check('reseller_web_login_tokens_used_check', sql`(used_at IS NULL) = (session_id IS NULL)`),
    foreignKey({
      name: 'reseller_web_login_tokens_customer_fk',
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
    }),
  ],
);

/**
 * A reseller panel session. Its own table and its own cookie: an admin session never
 * authorises a reseller route and this never authorises an admin one. `PENDING_SECOND_FACTOR`
 * authorises the code step and nothing else.
 */
export const resellerWebSessions = pgTable(
  'reseller_web_sessions',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    customerId: uuid('customer_id').notNull(),
    botInstanceId: uuid('bot_instance_id')
      .notNull()
      .references(() => botInstances.id),
    tokenHash: text('token_hash').notNull(),
    state: text('state').notNull(),
    createdAt: timestamptz('created_at').notNull(),
    lastSeenAt: timestamptz('last_seen_at').notNull(),
    /** 90 days after opening (or five minutes while the second factor is pending). */
    absoluteExpiresAt: timestamptz('absolute_expires_at').notNull(),
    endedAt: timestamptz('ended_at'),
    endReason: text('end_reason'),
    /** SHA-256 of (user-agent family, network): what «a new device» is decided by. */
    deviceFingerprint: text('device_fingerprint').notNull(),
    deviceLabel: text('device_label').notNull(),
    network: text('network'),
    secondFactorAttempts: integer('second_factor_attempts').notNull().default(0),
  },
  (table) => [
    uniqueIndex('reseller_web_sessions_token_key').on(table.tokenHash),
    index('reseller_web_sessions_customer_idx').on(
      table.tenantId,
      table.customerId,
      table.lastSeenAt,
    ),
    check('reseller_web_sessions_state_check', enumCheck('state', RESELLER_WEB_SESSION_STATES)),
    check(
      'reseller_web_sessions_end_check',
      sql`(ended_at IS NULL) = (end_reason IS NULL) AND (end_reason IS NULL OR ${enumCheck(
        'end_reason',
        RESELLER_WEB_SESSION_END_REASONS,
      )})`,
    ),
    check('reseller_web_sessions_expiry_check', sql`absolute_expires_at > created_at`),
    check(
      'reseller_web_sessions_label_check',
      sql`char_length(device_label) BETWEEN 1 AND 80 AND (network IS NULL OR char_length(network) <= 64)`,
    ),
    foreignKey({
      name: 'reseller_web_sessions_customer_fk',
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
    }),
  ],
);

/** The device fingerprints a reseller has signed in from: «اعلان ورود جدید» fires once per row. */
export const resellerWebDevices = pgTable(
  'reseller_web_devices',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    customerId: uuid('customer_id').notNull(),
    fingerprint: text('fingerprint').notNull(),
    firstSeenAt: timestamptz('first_seen_at').notNull(),
  },
  (table) => [
    primaryKey({
      name: 'reseller_web_devices_pkey',
      columns: [table.tenantId, table.customerId, table.fingerprint],
    }),
    foreignKey({
      name: 'reseller_web_devices_customer_fk',
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
    }),
  ],
);

/**
 * The reseller's optional TOTP factor — the Web Admin's algorithm and replay rule
 * (`identity/application/totp.ts`), its secret sealed by `SecretCipher`, never in clear.
 */
export const resellerWebTotpFactors = pgTable(
  'reseller_web_totp_factors',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    customerId: uuid('customer_id').notNull(),
    state: text('state').notNull(),
    ciphertext: text('ciphertext').notNull(),
    keyId: text('key_id').notNull(),
    lastUsedStep: integer('last_used_step'),
    activationAttempts: integer('activation_attempts').notNull().default(0),
    createdAt: timestamptz('created_at').notNull(),
    activatedAt: timestamptz('activated_at'),
  },
  (table) => [
    uniqueIndex('reseller_web_totp_factors_customer_key').on(table.tenantId, table.customerId),
    check('reseller_web_totp_factors_state_check', enumCheck('state', RESELLER_WEB_TOTP_STATES)),
    check(
      'reseller_web_totp_factors_active_check',
      sql`(state = 'ACTIVE') = (activated_at IS NOT NULL)`,
    ),
    foreignKey({
      name: 'reseller_web_totp_factors_customer_fk',
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
    }),
  ],
);

/** The reseller's own switches. No row means every default (`RESELLER_PREFERENCE_DEFAULTS`). */
export const resellerWebPreferences = pgTable(
  'reseller_web_preferences',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    customerId: uuid('customer_id').notNull(),
    newDeviceAlert: boolean('new_device_alert').notNull(),
    expiringDigest: boolean('expiring_digest').notNull(),
    dailySalesReport: boolean('daily_sales_report').notNull(),
    ticketReply: boolean('ticket_reply').notNull(),
    updatedAt: timestamptz('updated_at').notNull(),
  },
  (table) => [
    primaryKey({
      name: 'reseller_web_preferences_pkey',
      columns: [table.tenantId, table.customerId],
    }),
    foreignKey({
      name: 'reseller_web_preferences_customer_fk',
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
    }),
  ],
);

/**
 * One row per connection-file fetch from the panel, for the 10-per-10-minutes bound. It
 * records THAT a fetch happened — never a name, a size or a byte of what came back.
 */
export const resellerWebFileFetches = pgTable(
  'reseller_web_file_fetches',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    customerId: uuid('customer_id').notNull(),
    serviceId: uuid('service_id').notNull(),
    fetchedAt: timestamptz('fetched_at').notNull(),
  },
  (table) => [
    index('reseller_web_file_fetches_window_idx').on(
      table.tenantId,
      table.customerId,
      table.serviceId,
      table.fetchedAt,
    ),
    foreignKey({
      name: 'reseller_web_file_fetches_customer_fk',
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
    }),
  ],
);
