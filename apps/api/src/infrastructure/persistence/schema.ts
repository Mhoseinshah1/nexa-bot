import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql, type SQL } from 'drizzle-orm';
import {
  ACTOR_TYPES,
  ADMIN_STATUSES,
  AUDIT_RESULTS,
  BOT_INSTANCE_STATUSES,
  CALENDARS,
  CURRENCY_CODES,
  OPERATIONAL_SEVERITIES,
  PERMISSION_OVERRIDE_EFFECTS,
  SOURCE_SURFACES,
  TENANT_KINDS,
  TENANT_STATUSES,
} from '@nexa/contracts';

/**
 * Builds a CHECK constraint from a contract enum, so the database rejects any
 * value the contract does not define. The legacy system encodes one service
 * status four different ways — `active`, `فعال`, and two emoji-prefixed Persian
 * phrases — because nothing constrained the column.
 */
function enumCheck(column: string, values: readonly string[]): SQL {
  // This is the only sql.raw in the codebase. Every argument today is a
  // compile-time literal from a contract enum, which is what makes it safe — so
  // assert that rather than trust it, and escape anyway. A runtime-derived list
  // would otherwise turn a DDL helper into an injection point.
  if (!/^[a-z_][a-z0-9_]*$/.test(column)) {
    throw new Error(`enumCheck: "${column}" is not a plain column name.`);
  }
  const list = values
    .map((value) => {
      if (!/^[A-Za-z0-9_-]+$/.test(value)) {
        throw new Error(`enumCheck: "${value}" is not a plain enum literal.`);
      }
      return `'${value.replace(/'/g, "''")}'`;
    })
    .join(', ');
  return sql.raw(`${column} IN (${list})`);
}

/**
 * Phase 0 schema — the foundation tables, and nothing else.
 *
 * Conventions, all enforced here rather than by memory:
 *   - `id` is UUIDv7, generated in the application so the value exists before
 *     the INSERT and can be written into an outbox row in the same statement.
 *   - every timestamp is `timestamptz`, stored UTC.
 *   - every status is a CHECK-constrained text column, never free text.
 *   - tenant-owned rows carry `tenant_id NOT NULL`; rows that genuinely belong
 *     to no tenant carry NULL and say so.
 *   - append-only tables are protected by a trigger, not by convention
 *     (see migrations/0001_foundation.sql).
 *
 * There is deliberately no `balance` column, no money column and no product
 * table here. Phase 0 has no business features.
 */

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

// ---------------------------------------------------------------------------
// Tenancy
// ---------------------------------------------------------------------------

export const tenants = pgTable(
  'tenants',
  {
    id: uuid('id').primaryKey(),
    kind: text('kind').notNull(),
    parentTenantId: uuid('parent_tenant_id'),
    slug: text('slug').notNull(),
    displayName: text('display_name').notNull(),
    status: text('status').notNull().default('ACTIVE'),
    locale: text('locale').notNull().default('fa'),
    displayTimezone: text('display_timezone').notNull().default('Asia/Tehran'),
    calendar: text('calendar').notNull().default('jalali'),
    currency: text('currency').notNull().default('IRT'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('tenants_slug_key').on(table.slug),
    check('tenants_kind_check', enumCheck('kind', TENANT_KINDS)),
    check('tenants_status_check', enumCheck('status', TENANT_STATUSES)),
    check('tenants_calendar_check', enumCheck('calendar', CALENDARS)),
    check('tenants_currency_check', enumCheck('currency', CURRENCY_CODES)),
    // A reseller sales bot is a tenant with a parent; a primary tenant has none.
    check(
      'tenants_parent_check',
      sql`(kind = 'PRIMARY' AND parent_tenant_id IS NULL) OR (kind <> 'PRIMARY' AND parent_tenant_id IS NOT NULL)`,
    ),
  ],
);

/**
 * A bot instance is a Telegram bot. It is NOT a tenant: one tenant may own
 * several, and a reseller sales bot is its own tenant that owns one.
 */
export const botInstances = pgTable(
  'bot_instances',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    username: text('username').notNull(),
    status: text('status').notNull().default('ACTIVE'),
    /** Envelope-encrypted. Never returned by any API, never logged. */
    tokenCiphertext: text('token_ciphertext').notNull(),
    tokenKeyId: text('token_key_id').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('bot_instances_username_key').on(table.username),
    index('bot_instances_tenant_idx').on(table.tenantId),
    check('bot_instances_status_check', enumCheck('status', BOT_INSTANCE_STATUSES)),
  ],
);

// ---------------------------------------------------------------------------
// Eventing — the transactional outbox
// ---------------------------------------------------------------------------

export const outboxMessages = pgTable(
  'outbox_messages',
  {
    id: uuid('id').primaryKey(),
    /** NULL for platform events that belong to no tenant. */
    tenantId: uuid('tenant_id'),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: text('aggregate_id').notNull(),
    /** Monotonic per aggregate. Ordering is guaranteed per aggregate only. */
    sequence: integer('sequence').notNull(),
    eventType: text('event_type').notNull(),
    eventVersion: integer('event_version').notNull().default(1),
    payload: jsonb('payload').notNull(),
    actor: jsonb('actor').notNull(),
    correlationId: text('correlation_id').notNull(),
    causationId: text('causation_id'),
    occurredAt: timestamptz('occurred_at').notNull(),
    publishedAt: timestamptz('published_at'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('outbox_messages_aggregate_sequence_key').on(
      table.aggregateType,
      table.aggregateId,
      table.sequence,
    ),
    // Partial index: keeps the relay's claim query O(unpublished), not O(table).
    index('outbox_messages_unpublished_idx')
      .on(table.occurredAt)
      .where(sql`published_at IS NULL`),
    // The same partial set, led by tenant.
    //
    // The index above orders ALL unpublished rows by time, which is right when
    // everything is dispatchable and wrong when it is not: a stopped tenant's
    // backlog had to be walked in full to prove it held nothing for an active
    // one. Leading with `tenant_id` lets the relay go straight to the rows it
    // may actually act on, and skip a paused tenant's entirely.
    index('outbox_messages_tenant_unpublished_idx')
      .on(table.tenantId, table.occurredAt)
      .where(sql`published_at IS NULL`),
    check('outbox_messages_sequence_check', sql`sequence >= 1`),
    check('outbox_messages_attempts_check', sql`attempts >= 0`),
  ],
);

/**
 * Consumer-side dedupe.
 *
 * The outbox gives at-least-once delivery. Effectively-once EFFECTS come from
 * each consumer recording the event ids it has already applied.
 */
export const processedMessages = pgTable(
  'processed_messages',
  {
    consumer: text('consumer').notNull(),
    messageId: uuid('message_id').notNull(),
    processedAt: timestamptz('processed_at').notNull().defaultNow(),
  },
  (table) => [uniqueIndex('processed_messages_pkey').on(table.consumer, table.messageId)],
);

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

export const requestIdempotency = pgTable(
  'request_idempotency',
  {
    id: uuid('id').primaryKey(),
    /**
     * The tenant id as text, or the literal 'SYSTEM'. A plain nullable
     * `tenant_id` cannot participate in a unique constraint, because Postgres
     * treats NULLs as distinct — which would silently allow duplicate keys.
     */
    scopeRef: text('scope_ref').notNull(),
    tenantId: uuid('tenant_id'),
    key: text('key').notNull(),
    /** Hash of the request payload. A reused key with different input is a bug. */
    requestHash: text('request_hash').notNull(),
    result: jsonb('result'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [uniqueIndex('request_idempotency_scope_key').on(table.scopeRef, table.key)],
);

// ---------------------------------------------------------------------------
// Audit — who changed what, with before and after
// ---------------------------------------------------------------------------

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id'),
    occurredAt: timestamptz('occurred_at').notNull(),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    /** Captured at action time so the record survives a later rename. */
    actorLabel: text('actor_label'),
    /** A machine code such as 'wallet.credit'. Never a prose sentence. */
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    /** Values, not references. Secrets are replaced by a marker before writing. */
    before: jsonb('before'),
    after: jsonb('after'),
    reason: text('reason'),
    correlationId: text('correlation_id').notNull(),
    requestId: text('request_id'),
    sourceSurface: text('source_surface').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    /** Denials are audited too. */
    result: text('result').notNull(),
  },
  (table) => [
    index('audit_logs_tenant_occurred_idx').on(table.tenantId, table.occurredAt),
    index('audit_logs_entity_idx').on(table.entityType, table.entityId),
    index('audit_logs_correlation_idx').on(table.correlationId),
    check('audit_logs_actor_type_check', enumCheck('actor_type', ACTOR_TYPES)),
    check('audit_logs_result_check', enumCheck('result', AUDIT_RESULTS)),
    check('audit_logs_surface_check', enumCheck('source_surface', SOURCE_SURFACES)),
  ],
);

// ---------------------------------------------------------------------------
// Operational events — what the system did
// ---------------------------------------------------------------------------

export const operationalEvents = pgTable(
  'operational_events',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id'),
    code: text('code').notNull(),
    severity: text('severity').notNull(),
    message: text('message').notNull(),
    context: jsonb('context'),
    /**
     * Which dedupe namespace this row belongs to: the tenant id, or 'SYSTEM'.
     *
     * Without it the unique index below is global, and two tenants recording
     * the same dedupe key collapse onto ONE row — a cross-tenant write that no
     * repository predicate can prevent, because the collision happens in the
     * index rather than in a query.
     */
    dedupeScope: text('dedupe_scope').notNull().default('SYSTEM'),
    /** Repeats within one scope collapse onto one row and increment the counter. */
    dedupeKey: text('dedupe_key'),
    occurrenceCount: integer('occurrence_count').notNull().default(1),
    firstSeenAt: timestamptz('first_seen_at').notNull(),
    lastSeenAt: timestamptz('last_seen_at').notNull(),
    correlationId: text('correlation_id'),
    /** Set when this event records recovery from an earlier failure code. */
    recoversCode: text('recovers_code'),
  },
  (table) => [
    index('operational_events_tenant_seen_idx').on(table.tenantId, table.lastSeenAt),
    index('operational_events_code_idx').on(table.code),
    uniqueIndex('operational_events_dedupe_key').on(table.dedupeScope, table.dedupeKey),
    check('operational_events_severity_check', enumCheck('severity', OPERATIONAL_SEVERITIES)),
    check('operational_events_occurrence_check', sql`occurrence_count >= 1`),
  ],
);

// ---------------------------------------------------------------------------
// Identity and RBAC — Phase 1
// ---------------------------------------------------------------------------

/**
 * Administrators.
 *
 * Scoped to the TENANT, not to a bot instance. `UNK-ADM-004` is unresolved, and
 * the tenant-wide model is the one that can be narrowed later — adding
 * `bot_instance_id` to `admin_roles` is additive, while removing a scope that
 * turned out to be wrong is not.
 *
 * An Admin is not a Customer. They will not share a table, an id space or a
 * status vocabulary, because in the legacy system they do and "is this person
 * an admin" is therefore the same row as "is this person a buyer".
 *
 * `username` is stored already lower-cased — the CHECK enforces it — so the
 * composite unique index is enough to stop `Owner` and `owner` becoming two
 * accounts, with no query needing to remember `lower()`.
 */
export const admins = pgTable(
  'admins',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    username: text('username').notNull(),
    displayName: text('display_name').notNull(),
    /**
     * The self-describing output of the PasswordHasher: algorithm, parameters,
     * salt and digest in one string. Never a plaintext, never a bare digest,
     * and never returned by any query a surface can reach.
     */
    passwordHash: text('password_hash').notNull(),
    passwordUpdatedAt: timestamptz('password_updated_at').notNull(),
    status: text('status').notNull().default('ACTIVE'),
    /**
     * The Telegram admin seam. A later Telegram admin surface attaches to THIS
     * identity rather than creating a second admin table — which is how the
     * legacy system ended up with two role vocabularies for one column.
     * Stored as text: Telegram ids exceed 2^53 and must not become floats.
     */
    telegramUserId: text('telegram_user_id'),
    lastLoginAt: timestamptz('last_login_at'),
    disabledAt: timestamptz('disabled_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    // Redundant with the primary key on `id` alone, and deliberately so: it is
    // the candidate key that lets a child row say "this admin, IN THIS TENANT".
    unique('admins_tenant_id_key').on(table.tenantId, table.id),
    uniqueIndex('admins_tenant_username_key').on(table.tenantId, table.username),
    // Partial: two tenants may each have an admin with no Telegram link.
    uniqueIndex('admins_tenant_telegram_key')
      .on(table.tenantId, table.telegramUserId)
      .where(sql`telegram_user_id IS NOT NULL`),
    index('admins_tenant_status_idx').on(table.tenantId, table.status),
    check('admins_status_check', enumCheck('status', ADMIN_STATUSES)),
    check('admins_username_lowercase_check', sql`username = lower(username)`),
    check('admins_username_shape_check', sql`username ~ '^[a-z0-9._-]{3,64}$'`),
    check(
      'admins_telegram_shape_check',
      sql`telegram_user_id IS NULL OR telegram_user_id ~ '^[0-9]{1,20}$'`,
    ),
    // A disabled admin has a disabling timestamp and an active one does not, so
    // the two columns cannot drift into disagreeing about the same fact.
    check(
      'admins_disabled_at_check',
      sql`(status = 'DISABLED' AND disabled_at IS NOT NULL) OR (status <> 'DISABLED' AND disabled_at IS NULL)`,
    ),
  ],
);

/**
 * Roles: a tenant-scoped, editable composition over the frozen permission
 * catalog. Never an enum — the legacy role column is one, which is why it holds
 * four values in one surface and seven in the other, cannot be changed, and
 * audits nothing.
 *
 * System roles are seeded from `ROLE_SEEDS` and cannot be deleted. An
 * installation that deleted its owner role would have no way back in.
 */
export const roles = pgTable(
  'roles',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    key: text('key').notNull(),
    name: text('name').notNull(),
    isSystem: boolean('is_system').notNull().default(false),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    unique('roles_tenant_id_key').on(table.tenantId, table.id),
    uniqueIndex('roles_tenant_key_key').on(table.tenantId, table.key),
    check('roles_key_shape_check', sql`key ~ '^[a-z][a-z0-9_]{1,63}$'`),
  ],
);

/**
 * Which permissions a role carries.
 *
 * `tenant_id` is carried here as well as on `roles`, and is part of the unique
 * index. It is denormalised on purpose: it makes every scoped query a
 * single-table predicate rather than a join the caller could forget, which is
 * the whole basis of application-level tenant isolation (ADR-0004).
 */
export const rolePermissions = pgTable(
  'role_permissions',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    roleId: uuid('role_id').notNull(),
    permissionKey: text('permission_key').notNull(),
  },
  (table) => [
    uniqueIndex('role_permissions_pkey').on(table.tenantId, table.roleId, table.permissionKey),
    index('role_permissions_role_idx').on(table.roleId),
    // Composite: the role must belong to THIS tenant. A single-column reference
    // would let a row name tenant A while granting tenant B's role.
    foreignKey({
      name: 'role_permissions_tenant_role_fk',
      columns: [table.tenantId, table.roleId],
      foreignColumns: [roles.tenantId, roles.id],
    }),
  ],
);

/** Role assignment. An admin may hold several roles; effective = the union. */
export const adminRoles = pgTable(
  'admin_roles',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    adminId: uuid('admin_id').notNull(),
    roleId: uuid('role_id').notNull(),
    assignedAt: timestamptz('assigned_at').notNull().defaultNow(),
    /**
     * The admin who granted this. NULL only for the installation bootstrap,
     * which has no acting administrator because none exists yet — a fabricated
     * actor there would be the invented identity this codebase refuses. The
     * audit row, with actor SYSTEM_JOB, carries the full story.
     */
    assignedByAdminId: uuid('assigned_by_admin_id'),
  },
  (table) => [
    uniqueIndex('admin_roles_pkey').on(table.tenantId, table.adminId, table.roleId),
    index('admin_roles_admin_idx').on(table.adminId),
    index('admin_roles_role_idx').on(table.roleId),
    foreignKey({
      name: 'admin_roles_tenant_admin_fk',
      columns: [table.tenantId, table.adminId],
      foreignColumns: [admins.tenantId, admins.id],
    }),
    foreignKey({
      name: 'admin_roles_tenant_role_fk',
      columns: [table.tenantId, table.roleId],
      foreignColumns: [roles.tenantId, roles.id],
    }),
    // Only an administrator of this tenant can have granted a role in it.
    foreignKey({
      name: 'admin_roles_tenant_assigned_by_fk',
      columns: [table.tenantId, table.assignedByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
    }),
  ],
);

/**
 * Per-admin overrides on top of their roles.
 *
 * Justified by the resolution rule already frozen in the contract
 * (`resolveEffectivePermissions`): effective = (roles ∪ GRANT) − DENY, DENY
 * always wins, and an expired override stops applying without anyone running a
 * cleanup job. A `reason` is mandatory — an unexplained standing exception is
 * indistinguishable from a mistake six months later.
 */
export const adminPermissionOverrides = pgTable(
  'admin_permission_overrides',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    adminId: uuid('admin_id').notNull(),
    permissionKey: text('permission_key').notNull(),
    effect: text('effect').notNull(),
    reason: text('reason').notNull(),
    expiresAt: timestamptz('expires_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    createdByAdminId: uuid('created_by_admin_id'),
  },
  (table) => [
    uniqueIndex('admin_permission_overrides_pkey').on(
      table.tenantId,
      table.adminId,
      table.permissionKey,
      table.effect,
    ),
    index('admin_permission_overrides_admin_idx').on(table.adminId),
    check(
      'admin_permission_overrides_effect_check',
      enumCheck('effect', PERMISSION_OVERRIDE_EFFECTS),
    ),
    foreignKey({
      name: 'admin_permission_overrides_tenant_admin_fk',
      columns: [table.tenantId, table.adminId],
      foreignColumns: [admins.tenantId, admins.id],
    }),
    foreignKey({
      name: 'admin_permission_overrides_tenant_created_by_fk',
      columns: [table.tenantId, table.createdByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
    }),
  ],
);

/**
 * Sessions.
 *
 * Only the SHA-256 of the token is stored, so reading this table cannot
 * impersonate anyone — a database backup, a log line or a support screenshot
 * carries nothing usable. The plaintext exists in exactly one response body and
 * is never recoverable afterwards.
 *
 * Revocation is a timestamp rather than a delete, so "when was this session
 * killed, and by what" survives.
 */
export const adminSessions = pgTable(
  'admin_sessions',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    adminId: uuid('admin_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    issuedAt: timestamptz('issued_at').notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
    lastSeenAt: timestamptz('last_seen_at').notNull(),
    revokedAt: timestamptz('revoked_at'),
    revokedReason: text('revoked_reason'),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (table) => [
    // Global rather than per-tenant: the token is the lookup key and is
    // presented before any tenant is known, so it must be unique everywhere.
    uniqueIndex('admin_sessions_token_key').on(table.tokenHash),
    index('admin_sessions_admin_idx').on(table.tenantId, table.adminId),
    index('admin_sessions_expiry_idx')
      .on(table.expiresAt)
      .where(sql`revoked_at IS NULL`),
    // Retention, and deliberately NOT partial.
    //
    // The index above is partial on `revoked_at IS NULL`, which is right for
    // finding live sessions and useless to the sweeper: retention collects
    // revoked rows too, so its query cannot imply that predicate and would fall
    // back to a sequential scan. Harmless on a small table, and not harmless at
    // all now that connections carry a statement timeout — a backlog big enough
    // to scan past it would have made every sweep fail, leaving growth an
    // attacker can drive permanent.
    index('admin_sessions_retention_idx').on(table.expiresAt),
    // The session lookup is the one read that is unscoped by necessity, and it
    // RETURNS the tenant everything downstream is scoped to. A row naming the
    // wrong tenant would hand a caller a scope that is not theirs.
    foreignKey({
      name: 'admin_sessions_tenant_admin_fk',
      columns: [table.tenantId, table.adminId],
      foreignColumns: [admins.tenantId, admins.id],
    }),
  ],
);

/**
 * Login throttling.
 *
 * Durable rather than in Redis, for two reasons: an attacker must not be able
 * to clear their own counter by waiting for a cache eviction or a restart, and
 * the tests must be deterministic — the window advances by the injected Clock,
 * not by sleeping.
 *
 * Keyed by subject rather than by admin id, so a username that does not exist
 * is throttled exactly like one that does. Throttling only real accounts would
 * turn the lockout itself into a username oracle.
 */
export const adminLoginThrottle = pgTable(
  'admin_login_throttle',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    subjectKind: text('subject_kind').notNull(),
    subject: text('subject').notNull(),
    failedCount: integer('failed_count').notNull().default(0),
    windowStartedAt: timestamptz('window_started_at').notNull(),
    lockedUntil: timestamptz('locked_until'),
    updatedAt: timestamptz('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('admin_login_throttle_pkey').on(table.tenantId, table.subjectKind, table.subject),
    // Retention. The unique index above leads with `tenant_id` and serves the
    // per-subject lookups; nothing supported the sweeper's predicate, so every
    // batch scanned the whole table — the one an unauthenticated caller can
    // grow at will, and the one a statement timeout then makes unsweepable.
    index('admin_login_throttle_retention_idx').on(table.windowStartedAt, table.lockedUntil),
    check('admin_login_throttle_kind_check', enumCheck('subject_kind', ['USERNAME', 'IP'])),
    check('admin_login_throttle_count_check', sql`failed_count >= 0`),
  ],
);

/** A counter that keeps the outbox `sequence` monotonic per aggregate. */
export const aggregateSequences = pgTable(
  'aggregate_sequences',
  {
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: text('aggregate_id').notNull(),
    lastSequence: bigint('last_sequence', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
  },
  (table) => [uniqueIndex('aggregate_sequences_pkey').on(table.aggregateType, table.aggregateId)],
);

export const schema = {
  tenants,
  botInstances,
  admins,
  roles,
  rolePermissions,
  adminRoles,
  adminPermissionOverrides,
  adminSessions,
  adminLoginThrottle,
  outboxMessages,
  processedMessages,
  requestIdempotency,
  auditLogs,
  operationalEvents,
  aggregateSequences,
};

/** Tables the database itself refuses to UPDATE or DELETE. */
export const APPEND_ONLY_TABLES = ['audit_logs', 'processed_messages'] as const;
