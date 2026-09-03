import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
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
  DELIVERY_OUTCOMES,
  NOTIFICATION_KINDS,
  NOTIFICATION_STATUSES,
  NOTIFICATION_TRANSPORTS,
  OPERATIONAL_SEVERITIES,
  PERMISSION_OVERRIDE_EFFECTS,
  SOURCE_SURFACES,
  TEMPLATE_REVISION_ACTIONS,
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
    // Exactly ONE primary tenant per database, enforced here rather than by
    // the code that inserts it.
    //
    // The primary tenant IS the installation: it is the only kind with no
    // parent, and every reseller bot hangs off it. Two of them is not a
    // degraded installation, it is two installations sharing a database.
    //
    // The provisioning CLI used to guard this with `SELECT ... FOR UPDATE`
    // inside a transaction, which locks nothing when it matches no rows — so
    // two first-run installers both saw an empty table and both inserted. With
    // the same slug one happened to die on `tenants_slug_key`, which is a
    // different invariant catching this one by accident; with different slugs
    // both committed.
    uniqueIndex('tenants_single_primary_key')
      .on(table.kind)
      .where(sql`kind = 'PRIMARY'`),
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
    /**
     * When the condition this row records was observed to have cleared.
     *
     * Set by a recovery event naming this row's code, and cleared again if the
     * condition recurs. NOTHING IS DELETED either way: the failure row keeps its
     * message, its counter and its first-seen time, and the recovery event
     * stands beside it. History is the sequence of events; this column is a
     * marker over it, so an operator can tell an ongoing incident from one that
     * was fixed at four in the morning.
     */
    resolvedAt: timestamptz('resolved_at'),
    /** The recovery event that closed it. */
    resolvedByEventId: uuid('resolved_by_event_id'),
  },
  (table) => [
    index('operational_events_tenant_seen_idx').on(table.tenantId, table.lastSeenAt),
    index('operational_events_code_idx').on(table.code),
    uniqueIndex('operational_events_dedupe_key').on(table.dedupeScope, table.dedupeKey),
    // There is deliberately no index on `resolved_at`. One was drafted for a
    // retention sweep, and the sweep turned out not to be able to exist (the
    // table refuses DELETE — ADR-0020). An index whose only query was removed is
    // a write cost with nothing on the other side of it, so it went too.
    check('operational_events_severity_check', enumCheck('severity', OPERATIONAL_SEVERITIES)),
    check('operational_events_occurrence_check', sql`occurrence_count >= 1`),
    // A resolver without a resolution time is nonsense in either direction. The
    // UPDATE guard in migration 0011 says the same thing for updates; this says
    // it for inserts, which a BEFORE UPDATE trigger never sees.
    check(
      'operational_events_resolution_check',
      sql`resolved_by_event_id IS NULL OR resolved_at IS NOT NULL`,
    ),
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

// ---------------------------------------------------------------------------
// Control plane — Phase 2
// ---------------------------------------------------------------------------

/**
 * A tenant's override of one template body.
 *
 * Current state, one row per `(tenant, key, locale)`. The RAW source, exactly as
 * an administrator typed it — never a rendered string. In the legacy system the
 * edit screen echoes the rendered text, so the raw template cannot be read back
 * from the screen that edits it, and a save from that view would store the
 * editor's own name where a placeholder was (TBR-TXT-004).
 *
 * `version` carries optimistic concurrency: an UPDATE matches on it and a zero
 * row count is a conflict, never a retry (ADR-0021).
 *
 * There is no `is_default` column and no copy of the default body. A tenant that
 * has not overridden a key has NO ROW, which is what lets an improved default
 * reach them.
 */
export const templateOverrides = pgTable(
  'template_overrides',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    templateKey: text('template_key').notNull(),
    locale: text('locale').notNull(),
    /** Raw source. Placeholders un-substituted. Never a rendered message. */
    body: text('body').notNull(),
    version: integer('version').notNull().default(1),
    /** The revision in `template_revisions` this body came from. */
    revision: integer('revision').notNull(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    updatedByAdminId: uuid('updated_by_admin_id'),
  },
  (table) => [
    uniqueIndex('template_overrides_key').on(table.tenantId, table.templateKey, table.locale),
    check('template_overrides_version_check', sql`version >= 1`),
    check('template_overrides_body_check', sql`length(body) BETWEEN 1 AND 4096`),
    // Only an administrator of this tenant can have edited this tenant's copy.
    foreignKey({
      name: 'template_overrides_tenant_admin_fk',
      columns: [table.tenantId, table.updatedByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
    }),
  ],
);

/**
 * Every change to a tenant's template body, including the reverts.
 *
 * Append-only. A revert deletes the override row and writes a revision here
 * saying so, which is why `body` is nullable: a REVERT revision has no body,
 * because reverting means going back to the default rather than storing a copy
 * of it.
 *
 * This is NOT the audit log and does not duplicate it. The audit row answers
 * "who changed what", is redacted, and is governed by a retention policy; this
 * table holds the content itself, is read by a product feature, and lives as
 * long as the tenant. Both are written in the same transaction.
 */
export const templateRevisions = pgTable(
  'template_revisions',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    templateKey: text('template_key').notNull(),
    locale: text('locale').notNull(),
    /** Monotonic per `(tenant, key, locale)`, starting at 1. */
    revision: integer('revision').notNull(),
    action: text('action').notNull(),
    /** Raw source for a SET. NULL for a REVERT. */
    body: text('body'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    createdByAdminId: uuid('created_by_admin_id'),
  },
  (table) => [
    uniqueIndex('template_revisions_key').on(
      table.tenantId,
      table.templateKey,
      table.locale,
      table.revision,
    ),
    check('template_revisions_action_check', enumCheck('action', TEMPLATE_REVISION_ACTIONS)),
    check('template_revisions_revision_check', sql`revision >= 1`),
    // A SET carries a body; a REVERT never does. Without this the two shapes
    // drift and "which revision restored the default" stops being answerable.
    check(
      'template_revisions_body_check',
      sql`(action = 'SET' AND body IS NOT NULL AND length(body) BETWEEN 1 AND 4096) OR (action = 'REVERT' AND body IS NULL)`,
    ),
    foreignKey({
      name: 'template_revisions_tenant_admin_fk',
      columns: [table.tenantId, table.createdByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
    }),
  ],
);

/**
 * A tenant's value for one registered setting.
 *
 * Absence means the default applies. That is the whole source-resolution rule,
 * and it is stored as absence rather than as a flag beside the value, because a
 * flag and a value can disagree and absence cannot.
 *
 * The value is `jsonb` because the registry's schemas are heterogeneous — a
 * string, an integer, an enum, a nullable integer. It is NOT a free-form
 * document: it is parsed by that key's declared zod schema on the way in and on
 * the way out, and a key that is not registered has no row and cannot get one.
 */
export const settingValues = pgTable(
  'setting_values',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    settingKey: text('setting_key').notNull(),
    value: jsonb('value').notNull(),
    version: integer('version').notNull().default(1),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    updatedByAdminId: uuid('updated_by_admin_id'),
  },
  (table) => [
    uniqueIndex('setting_values_key').on(table.tenantId, table.settingKey),
    check('setting_values_version_check', sql`version >= 1`),
    foreignKey({
      name: 'setting_values_tenant_admin_fk',
      columns: [table.tenantId, table.updatedByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
    }),
  ],
);

/**
 * A tenant's state for one registered feature flag.
 *
 * `enabled` is a boolean column, and that is a design constraint rather than an
 * incidental type: it gives configuration nowhere to hide. The legacy capability
 * screen has four shapes behind it (CBR-011), three of which are settings
 * wearing a toggle's clothes; those live in `setting_values`.
 */
export const featureFlagStates = pgTable(
  'feature_flag_states',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    flagKey: text('flag_key').notNull(),
    enabled: boolean('enabled').notNull(),
    version: integer('version').notNull().default(1),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    updatedByAdminId: uuid('updated_by_admin_id'),
    /** Mandatory for a TENANT_WIDE flag; the confirmation protocol records why. */
    reason: text('reason'),
  },
  (table) => [
    uniqueIndex('feature_flag_states_key').on(table.tenantId, table.flagKey),
    check('feature_flag_states_version_check', sql`version >= 1`),
    foreignKey({
      name: 'feature_flag_states_tenant_admin_fk',
      columns: [table.tenantId, table.updatedByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
    }),
  ],
);

/**
 * A notification INTENT.
 *
 * One row per thing that should be communicated, created inside the transaction
 * that produced it. Never one row per send: a retry appends to
 * `notification_delivery_attempts` and leaves this row alone.
 *
 * `dedupe_key` is the intent's identity within its tenant, and the unique index
 * is what makes "a retry must not create a second logical notification" a
 * property of the database rather than of the queue behaving well.
 *
 * `destination` is a SNAPSHOT taken when the intent was created, not a reference
 * to the setting that produced it: an attempt from March must still say which
 * chat it was addressed to after somebody repoints the destination in April.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    kind: text('kind').notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    /** The rendered destination, as it stood when the intent was created. */
    destination: jsonb('destination').notNull(),
    /** Typed values for the template this kind renders. Redacted like any log. */
    payload: jsonb('payload').notNull(),
    templateKey: text('template_key').notNull(),
    status: text('status').notNull().default('PENDING'),
    attemptCount: integer('attempt_count').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull(),
    correlationId: text('correlation_id'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    lastAttemptAt: timestamptz('last_attempt_at'),
    /**
     * The earliest moment the next attempt may run.
     *
     * Three jobs in one column: the initial "send now", the back-off after a
     * retryable failure, and the LEASE the dispatcher takes when it claims a
     * row. Pushing it forward before the send means an intent whose sender dies
     * mid-flight becomes eligible again on its own, instead of staying claimed
     * by a process that no longer exists.
     */
    nextAttemptAt: timestamptz('next_attempt_at').notNull().defaultNow(),
    /** When it reached SENT or FAILED. NULL while PENDING. */
    completedAt: timestamptz('completed_at'),
  },
  (table) => [
    // The candidate key a composite foreign key needs on the referenced side,
    // so a delivery attempt can say "the notification with this id, IN THIS
    // TENANT" rather than naming a globally unique id and hoping. Redundant
    // with the primary key on purpose (migration 0007 explains the pattern).
    unique('notifications_tenant_id_key').on(table.tenantId, table.id),
    uniqueIndex('notifications_dedupe_key').on(table.tenantId, table.dedupeKey),
    // The administrator-facing list: this tenant's notifications, newest first.
    index('notifications_tenant_created_idx').on(table.tenantId, table.createdAt),
    /**
     * The dispatcher's claim.
     *
     * `SELECT ... WHERE status = 'PENDING' AND next_attempt_at <= now ORDER BY
     * next_attempt_at FOR UPDATE SKIP LOCKED` — one query, run on a tick, and
     * the only reason this index exists.
     *
     * Partial, and it stays small: a row leaves the index the moment it reaches
     * SENT or FAILED, so it holds work in flight rather than all history.
     * Deliberately not led by `tenant_id` — the dispatcher runs for the
     * installation and has no tenant to fix, so a tenant-leading index would be
     * a scan.
     */
    index('notifications_pending_idx')
      .on(table.nextAttemptAt)
      .where(sql`status = 'PENDING'`),
    check('notifications_kind_check', enumCheck('kind', NOTIFICATION_KINDS)),
    check('notifications_status_check', enumCheck('status', NOTIFICATION_STATUSES)),
    check('notifications_attempts_check', sql`attempt_count >= 0 AND max_attempts >= 1`),
    // A terminal status has a completion time and a pending one does not. Two
    // fields that can contradict each other are a bug with a migration attached.
    check(
      'notifications_completed_check',
      sql`(status = 'PENDING' AND completed_at IS NULL) OR (status <> 'PENDING' AND completed_at IS NOT NULL)`,
    ),
  ],
);

/**
 * Claims handed back without ever reaching the transport.
 *
 * `attempt_count` on the intent counts claims ISSUED, and it is deliberately
 * monotonic: a claim whose process died with the socket open has to count, or a
 * crash-looping worker retries for ever. So capacity cannot be returned by
 * decrementing it, and the first attempt to do so was wrong in two ways at
 * once. A decrement matched on `attempt_count = attemptNumber` could only be
 * applied by whichever claim happened to be current, so two outstanding claims
 * releasing out of order silently lost one attempt's capacity; and it required
 * `status = 'PENDING'`, so a sweep that terminalised the row a moment earlier
 * made the hand-back impossible.
 *
 * A release is a FACT about one attempt number, recorded here. Spend is then
 * derived — `attempt_count` minus the releases — so order does not matter, a
 * repeated release is a no-op against the primary key, and a release can be
 * recorded after the intent has been written off.
 */
export const notificationReleasedClaims = pgTable(
  'notification_released_claims',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    notificationId: uuid('notification_id').notNull(),
    attemptNumber: integer('attempt_number').notNull(),
    releasedAt: timestamptz('released_at').notNull(),
    /** Why the claim was handed back. A machine code, never a sentence. */
    reason: text('reason').notNull(),
  },
  (table) => [
    // The identity of a release IS the attempt it releases. Idempotent by
    // construction: a retry after an ambiguous commit inserts nothing new,
    // which is what makes a release safe to repeat when its outcome is unknown.
    primaryKey({
      name: 'notification_released_claims_pk',
      columns: [table.tenantId, table.notificationId, table.attemptNumber],
    }),
    check('notification_released_claims_number_check', sql`attempt_number >= 1`),
    foreignKey({
      name: 'notification_released_claims_tenant_notification_fk',
      columns: [table.tenantId, table.notificationId],
      foreignColumns: [notifications.tenantId, notifications.id],
    }),
  ],
);

/**
 * One attempt to deliver one notification. Append-only.
 *
 * The record of what actually happened on the wire, which the legacy system does
 * not keep at all — it has no delivery-status field anywhere, which is why
 * whether its notification report means "sent" or "matched" is UNKNOWN
 * (UNK-LGR-015).
 *
 * `retry_after_ms` holds what the transport ASKED FOR, when it said anything. A
 * 429 that names a wait is honoured rather than second-guessed.
 */
export const notificationDeliveryAttempts = pgTable(
  'notification_delivery_attempts',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    notificationId: uuid('notification_id').notNull(),
    attemptNumber: integer('attempt_number').notNull(),
    transport: text('transport').notNull(),
    outcome: text('outcome').notNull(),
    startedAt: timestamptz('started_at').notNull(),
    finishedAt: timestamptz('finished_at').notNull(),
    /** A machine code from the transport, never a prose sentence. */
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    retryAfterMs: integer('retry_after_ms'),
  },
  (table) => [
    uniqueIndex('notification_delivery_attempts_key').on(
      table.tenantId,
      table.notificationId,
      table.attemptNumber,
    ),
    check('notification_delivery_attempts_outcome_check', enumCheck('outcome', DELIVERY_OUTCOMES)),
    check(
      'notification_delivery_attempts_transport_check',
      enumCheck('transport', NOTIFICATION_TRANSPORTS),
    ),
    check('notification_delivery_attempts_number_check', sql`attempt_number >= 1`),
    // A success carries no error; a failure carries a code. Otherwise "why did
    // this fail" is answered by an empty column half the time.
    check(
      'notification_delivery_attempts_error_check',
      sql`(outcome = 'SUCCEEDED' AND error_code IS NULL) OR (outcome <> 'SUCCEEDED' AND error_code IS NOT NULL)`,
    ),
    foreignKey({
      name: 'notification_delivery_attempts_tenant_notification_fk',
      columns: [table.tenantId, table.notificationId],
      foreignColumns: [notifications.tenantId, notifications.id],
    }),
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
  templateOverrides,
  templateRevisions,
  settingValues,
  featureFlagStates,
  notifications,
  notificationDeliveryAttempts,
  notificationReleasedClaims,
};

/** Tables the database itself refuses to UPDATE or DELETE. */
export const APPEND_ONLY_TABLES = [
  'audit_logs',
  'processed_messages',
  'template_revisions',
  'notification_delivery_attempts',
  // Load-bearing accounting, not just evidence: spend is `attempt_count` minus
  // these rows, so deleting one silently spends an attempt that was handed
  // back and adding one silently returns an attempt that was not.
  'notification_released_claims',
] as const;
