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
  doublePrecision,
} from 'drizzle-orm/pg-core';
import { sql, type SQL } from 'drizzle-orm';
import {
  ACTOR_TYPES,
  ADMIN_STATUSES,
  BACKUP_DELIVERY_STATES,
  BACKUP_RUN_STATES,
  BACKUP_STAGES,
  BACKUP_TRIGGERS,
  AUDIT_RESULTS,
  BOT_INSTANCE_STATUSES,
  CALENDARS,
  CURRENCY_CODES,
  DELIVERY_OUTCOMES,
  NOTIFICATION_KINDS,
  NOTIFICATION_STATUSES,
  NOTIFICATION_TRANSPORTS,
  OPERATIONAL_SEVERITIES,
  PANEL_HEALTH_STATES,
  MONITOR_DEFERRAL_REASONS,
  PANEL_STATUSES,
  PERMISSION_OVERRIDE_EFFECTS,
  PROVIDER_FAILURE_KINDS,
  PROVIDER_TYPES,
  SOURCE_SURFACES,
  RECOVERY_ACTIVE_DESTRUCTIVE_STATES,
  RECOVERY_FAILURE_CODES,
  RECOVERY_SOURCES,
  RECOVERY_STAGES,
  RECOVERY_STATES,
  TEMPLATE_REVISION_ACTIONS,
  TENANT_KINDS,
  TENANT_STATUSES,
  // Phase 4. Every CHECK below is built from one of these, so the database's
  // vocabulary cannot drift from the contract's.
  CUSTOMER_STATUSES,
  PRODUCT_STATUSES,
  PRODUCT_AUDIENCES,
  ORDER_STATES,
  PAYMENT_STATES,
  PAYMENT_METHODS,
  PAYMENT_EVIDENCE_KINDS,
  LEDGER_DIRECTIONS,
  LEDGER_REASONS,
  SERVICE_DELIVERY_STATES,
  SERVICE_STATES,
  OPERATION_STATES,
  OPERATION_TYPES,
  DISCOUNT_TYPES,
  DISCOUNT_STATUSES,
  REFERRAL_TRIGGERS,
  RESELLER_STATUSES,
  RESELLER_PRICING_MODES,
} from '@nexa/contracts';

/**
 * Builds a CHECK constraint from a contract enum, so the database rejects any
 * value the contract does not define. The legacy system encodes one service
 * status four different ways — `active`, `فعال`, and two emoji-prefixed Persian
 * phrases — because nothing constrained the column.
 */
/**
 * What an enum literal may contain.
 *
 * Letters, digits, underscore, hyphen and DOT. The dot arrived with
 * `RECOVERY_FAILURE_CODES`, whose members are dotted (`recovery.cutover_failed`)
 * for the same reason error codes and operational event codes are — they are
 * namespaced, and flattening them to match a character class would make the
 * database's vocabulary differ from the contract's.
 *
 * Widening it is safe for the reason the original class was narrow: this is not
 * the escaping. The `'` doubling below is the escaping, and it still runs. This
 * pattern is the assertion that the input is a compile-time enum literal and
 * not something derived at runtime, and a dot does not weaken that — a quote, a
 * backslash, a space, a semicolon and a comment marker are all still refused,
 * which `tests/unit/schema-ddl-guards.test.ts` asserts one character at a time.
 */
const ENUM_LITERAL = /^[A-Za-z0-9_.-]+$/;

export function enumCheck(column: string, values: readonly string[]): SQL {
  // This is the only sql.raw in the codebase. Every argument today is a
  // compile-time literal from a contract enum, which is what makes it safe — so
  // assert that rather than trust it, and escape anyway. A runtime-derived list
  // would otherwise turn a DDL helper into an injection point.
  if (!/^[a-z_][a-z0-9_]*$/.test(column)) {
    throw new Error(`enumCheck: "${column}" is not a plain column name.`);
  }
  const list = values
    .map((value) => {
      if (!ENUM_LITERAL.test(value)) {
        throw new Error(`enumCheck: "${value}" is not a plain enum literal.`);
      }
      return `'${value.replace(/'/g, "''")}'`;
    })
    .join(', ');
  return sql.raw(`${column} IN (${list})`);
}

/**
 * The same constraint for a column that is allowed to be NULL.
 *
 * `column IN (...)` is NULL — not false — when the column is NULL, and a CHECK
 * passes on NULL. Relying on that is correct SQL and completely invisible to a
 * reader, so it is stated: this column holds one of these values, or nothing.
 */
export function nullableEnumCheck(column: string, values: readonly string[]): SQL {
  if (!/^[a-z_][a-z0-9_]*$/.test(column)) {
    throw new Error(`nullableEnumCheck: "${column}" is not a plain column name.`);
  }
  const list = values
    .map((value) => {
      if (!ENUM_LITERAL.test(value)) {
        throw new Error(`nullableEnumCheck: "${value}" is not a plain enum literal.`);
      }
      return `'${value.replace(/'/g, "''")}'`;
    })
    .join(', ');
  return sql.raw(`${column} IS NULL OR ${column} IN (${list})`);
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
    /**
     * Telegram's own numeric id for this bot, as a decimal STRING.
     *
     * The identity a rerun is decided against. A username can be changed in BotFather
     * and a token can be rotated; this cannot, so it is what says whether a second
     * bootstrap is rotating THIS bot's token or repointing the installation at a
     * different bot — the refusal ADR-0029 records, because repointing would leave
     * every stored `telegram_user_id` attached to conversations that bot never had.
     *
     * Text rather than bigint for the reason every other id on the wire is text: JSON
     * has one numeric type, and a value stored and compared for the life of an
     * installation must not be able to lose a digit in transit.
     *
     * Nullable because rows created before the bootstrap existed have no way to know
     * it. `getMe` fills it the first time a bootstrap runs against such a row.
     */
    telegramBotId: text('telegram_bot_id'),
    /**
     * When Telegram last ACCEPTED a `setWebhook` for this bot, and the URL it took.
     *
     * Separate from the row existing, because the two fail independently and the whole
     * recovery story depends on telling them apart. A crash between the local commit
     * and `setWebhook` leaves a row with this NULL: the rerun decrypts the stored token
     * and retries the registration, and never asks for a token again. A crash after
     * Telegram accepted but before this was written leaves the same NULL, and the rerun
     * re-registers and then marks it. Both crashes converge, which is why the marker is
     * written AFTER the call rather than with the row.
     *
     * A repeat `setWebhook` is NOT a no-op — an earlier version of this comment said it
     * was. It replaces the registration, and it discards whatever Telegram has queued if
     * the caller asks it to, which is why `dropPendingUpdates` is true only on a first
     * registration.
     *
     * It is also what `--status` reports, and therefore what stops an installer
     * claiming a Telegram-enabled installation is complete while the bot cannot
     * receive a single update.
     */
    webhookRegisteredAt: timestamptz('webhook_registered_at'),
    webhookUrl: text('webhook_url'),
    /**
     * SHA-256 of the secret the webhook was registered WITH, as hex.
     *
     * Not a credential: it is a one-way digest of one, and it is here because
     * the marker above records what was registered and the secret is the other
     * half of what `setWebhook` carried. Without it a rotated
     * `TELEGRAM_WEBHOOK_SECRET` produces an installation that reports itself
     * ready while the route refuses every update Telegram signs — the operator
     * followed the rotation procedure the template documents, and the only
     * remedy was SQL.
     *
     * A digest rather than the value, because nothing needs to read it back:
     * the question is only "is this the same secret", and a stored plaintext
     * would be a second copy of a credential that already lives in exactly one
     * file. Nullable for the rows that predate it; a NULL means "unknown", and
     * an unknown fingerprint is treated as needing registration rather than as
     * matching.
     */
    webhookSecretFingerprint: text('webhook_secret_fingerprint'),
    status: text('status').notNull().default('ACTIVE'),
    /** Envelope-encrypted. Never returned by any API, never logged. */
    tokenCiphertext: text('token_ciphertext').notNull(),
    tokenKeyId: text('token_key_id').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('bot_instances_username_key').on(table.username),
    /**
     * One Telegram bot, one row. The identity, not the display name.
     *
     * `bot_instances_username_key` looked like it already held this and does not:
     * a username is changed in BotFather at will, and the stored copy goes stale
     * the moment it is (OQ-TG-02). So bootstrapping a SECOND tenant with the same
     * token after a rename passes the username index — `getMe` returns the new
     * name, which collides with nothing — and writes a second row carrying the
     * same `telegram_bot_id`. Telegram has one webhook per bot, so the second
     * registration moves it, and the first row goes on reporting `ready` for a
     * URL that no longer receives anything.
     *
     * PARTIAL, because the column is nullable for rows that predate migration
     * 0038 and a unique index would otherwise make at most one of them legal.
     * `getMe` fills those in the first time a bootstrap runs against them, which
     * is the point at which the constraint should start applying to them — and
     * does.
     *
     * Deliberately NOT scoped to the tenant. Cross-tenant is the case: two
     * tenants on one installation binding the same bot is exactly the collision,
     * and a `(tenant_id, telegram_bot_id)` index would permit it.
     */
    uniqueIndex('bot_instances_telegram_bot_id_key')
      .on(table.telegramBotId)
      .where(sql`telegram_bot_id IS NOT NULL`),
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
// ---------------------------------------------------------------------------
// Panels — a tenant's connections to the provider software it sells access to
// ---------------------------------------------------------------------------

/**
 * A panel: what to call, and what an operator calls it.
 *
 * Three tables rather than one, and the split is by LIFETIME rather than by
 * tidiness. This row changes when an operator edits configuration.
 * `panel_credentials` changes when a credential is replaced, which is a
 * different permission and a different audit action. `panel_health` changes on
 * every probe — many times an hour once Phase 3C schedules them — and putting
 * that in this row would move `updated_at` on a row nobody edited, make every
 * probe contend with every operator edit for the same tuple lock, and drag
 * ciphertext through the buffer pool on every list query.
 *
 * There is no `priority` or `sort` column. The legacy corpus does not evidence
 * one (it is NOT_EXPOSED, which is not the same as absent), nothing in Phase 3
 * orders panels, and panel SELECTION is Phase 4's problem. An integer column
 * added then is a one-line additive migration; a column added now is a column
 * whose meaning gets decided by whoever first writes to it.
 *
 * There is no customer-visibility flag either, and that is deliberate rather
 * than forgotten. The legacy system gates a panel behind FOUR independent
 * conditions — a display toggle, a tier-group set, a per-customer hidden list,
 * and a separate delivery toggle (PBR-005) — and collapsing those into one
 * boolean now is exactly the decision Phase 4 would have to undo. `status`
 * here is operational: whether THIS installation uses the panel at all.
 */
export const panels = pgTable(
  'panels',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    name: text('name').notNull(),
    /**
     * A value from `PROVIDER_TYPES`, constrained by the database.
     *
     * The CHECK is the outer half of a pair. It stops an unknown provider being
     * written; `providerAdapter()` refuses to instantiate one if a migration or
     * a direct write ever gets one past it. Either alone would leave a row that
     * names an adapter nothing can build.
     */
    providerType: text('provider_type').notNull(),
    baseUrl: text('base_url').notNull(),
    status: text('status').notNull().default('ACTIVE'),
    /**
     * The per-panel configuration this provider needs before it can build a config.
     *
     * `requiredActivationFields` on the descriptor has named this since Phase 3 and
     * nothing stored a value, so a 3X-UI panel could be connected, probed and reported
     * healthy while being unable to produce the one thing a customer buys.
     *
     * Validated against `PANEL_ACTIVATION_SCHEMAS[providerType]` at the application
     * boundary, never here: the shape is per provider and a CHECK constraint cannot
     * know which provider a row is. Null means unset, which is a real state a fresh
     * panel is in and which `PANEL_NOT_OPERABLE` names rather than guesses past.
     */
    activation: jsonb('activation'),
    /** Set when the panel is archived, so the event has a time and not just a state. */
    archivedAt: timestamptz('archived_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('panels_tenant_status_idx').on(table.tenantId, table.status),
    /**
     * Unique among a tenant's LIVE panels only.
     *
     * Archiving releases the name, which is the behaviour an operator expects:
     * a panel replaced by a rebuilt one should be able to keep its label. A
     * plain unique index would make the archive permanent in a way archiving is
     * not supposed to be.
     */
    uniqueIndex('panels_tenant_name_live_key')
      .on(table.tenantId, table.name)
      .where(sql`status <> 'ARCHIVED'`),
    /*
     * The list's page-key traversal is NOT declared here.
     *
     * `panels_tenant_created_page_idx` — `(tenant_id, created_at, id)` over
     * live panels — is built concurrently, outside the migrator's transaction,
     * by `online-indexes.ts`. Declaring it here would have drizzle-kit generate
     * an ordinary `CREATE INDEX` migration for it, which is the blocking build
     * that arrangement exists to avoid, and the drift check would never come
     * back clean while both existed.
     *
     * `panels_tenant_page_idx` was that index on `(tenant_id, name, id)`, and
     * it is retired by 0026: the keyset moved off `name`, which an operator can
     * edit and which therefore cannot order a stable traversal.
     */
    check('panels_status_check', enumCheck('status', PANEL_STATUSES)),
    check('panels_provider_type_check', enumCheck('provider_type', PROVIDER_TYPES)),
    /** An archived panel has a time; a live one does not. Neither state can lie. */
    check('panels_archived_at_check', sql`(status = 'ARCHIVED') = (archived_at IS NOT NULL)`),
    /**
     * Redundant against the primary key, and the target of a composite
     * reference rather than a lookup path.
     *
     * `panel_credentials` and `panel_health` carry a denormalised `tenant_id`,
     * and two separate foreign keys let a child row name panel A while
     * claiming tenant B — the database accepted exactly that. The rewrap
     * rebuilds a credential's Secret Envelope v2 context from the CHILD row's
     * tenant, so such a row would re-encrypt the secret under a context its
     * owner cannot reproduce, and the credential would be unreadable for good.
     * A composite foreign key needs something unique to point at; this is it.
     */
    unique('panels_tenant_id_key').on(table.tenantId, table.id),
  ],
);

/**
 * A panel's credentials, envelope-encrypted, one row per panel.
 *
 * Every column here is either ciphertext, the key id that decrypts it, or the
 * time it was last replaced. There is no plaintext column and no column that
 * could hold one. The legacy web admin rendered a panel's stored password as
 * readable text on its detail page (WEB-BR-007) — a shape where the value
 * exists in the clear anywhere is a shape where some page eventually shows it.
 *
 * `tenant_id` is denormalised from the panel deliberately. It is what the
 * secret registry's rewrap reads to rebuild the AEAD context, and a rewrap that
 * had to join to find the tenant would be one join away from re-encrypting a
 * row under the wrong context.
 *
 * Each credential is nullable because providers differ: Marzban uses a username
 * and a password, and a token-shaped provider uses neither. A NULL ciphertext
 * and a NULL key id travel together — the CHECKs below refuse a half-written
 * credential, which is what an interrupted write would otherwise leave.
 */
export const panelCredentials = pgTable(
  'panel_credentials',
  {
    panelId: uuid('panel_id')
      .primaryKey()
      .references(() => panels.id),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    usernameCiphertext: text('username_ciphertext'),
    usernameKeyId: text('username_key_id'),
    usernameSetAt: timestamptz('username_set_at'),
    passwordCiphertext: text('password_ciphertext'),
    passwordKeyId: text('password_key_id'),
    passwordSetAt: timestamptz('password_set_at'),
    apiTokenCiphertext: text('api_token_ciphertext'),
    apiTokenKeyId: text('api_token_key_id'),
    apiTokenSetAt: timestamptz('api_token_set_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('panel_credentials_tenant_idx').on(table.tenantId),
    /**
     * The pair, not the two halves.
     *
     * `panel_id` and `tenant_id` each had their own foreign key, which
     * constrained them individually and said nothing about them agreeing. A
     * row naming another tenant's panel satisfied both and violated the
     * invariant every query in the repository relies on.
     */
    foreignKey({
      columns: [table.tenantId, table.panelId],
      foreignColumns: [panels.tenantId, panels.id],
      name: 'panel_credentials_tenant_panel_fk',
    }),

    check(
      'panel_credentials_username_check',
      sql`(username_ciphertext IS NULL) = (username_key_id IS NULL)
          AND (username_ciphertext IS NULL) = (username_set_at IS NULL)`,
    ),
    check(
      'panel_credentials_password_check',
      sql`(password_ciphertext IS NULL) = (password_key_id IS NULL)
          AND (password_ciphertext IS NULL) = (password_set_at IS NULL)`,
    ),
    check(
      'panel_credentials_api_token_check',
      sql`(api_token_ciphertext IS NULL) = (api_token_key_id IS NULL)
          AND (api_token_ciphertext IS NULL) = (api_token_set_at IS NULL)`,
    ),
  ],
);

/**
 * The LATEST health of a panel. One row, overwritten.
 *
 * Not a history table, and that is an argued decision rather than a shortcut.
 * A history of probes is unbounded by construction — Phase 3C probes on a
 * schedule — and the legacy system's own failure mode was a log group holding
 * 36 + 15 + 8 + 1 identical TLS errors in one day with no way to collapse them.
 * What an operator needs from history is "this condition started at T and is
 * still going", and `operational_events` already answers exactly that, with a
 * dedupe key and an occurrence counter and a resolution event. So health
 * TRANSITIONS become operational events and the current state lives here.
 *
 * The absence of a row means never probed. That is why `state` has no
 * `UNCHECKED` value: inventing a row to record that nothing has happened makes
 * a never-checked panel indistinguishable from a checked one at a glance, which
 * is the mistake behind the legacy statistics screen counting CONFIGURED panels
 * and labelling them connected (RSV2-BR-021).
 */
export const panelHealth = pgTable(
  'panel_health',
  {
    panelId: uuid('panel_id')
      .primaryKey()
      .references(() => panels.id),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    state: text('state').notNull(),
    checkedAt: timestamptz('checked_at').notNull(),
    latencyMs: integer('latency_ms').notNull(),
    /** The normalized failure kind. NULL exactly when the state is HEALTHY or DEGRADED. */
    failure: text('failure'),
    /** The upstream HTTP status, when there was one. A number, never a body. */
    statusCode: integer('status_code'),
    providerVersion: text('provider_version'),
    /**
     * When this panel last answered successfully.
     *
     * Carried forward across failures on purpose: "unreachable, last worked
     * four minutes ago" and "unreachable, last worked in March" are the same
     * state and completely different problems.
     */
    lastHealthyAt: timestamptz('last_healthy_at'),
  },
  (table) => [
    index('panel_health_tenant_idx').on(table.tenantId),
    /**
     * The pair, not the two halves.
     *
     * `panel_id` and `tenant_id` each had their own foreign key, which
     * constrained them individually and said nothing about them agreeing. A
     * row naming another tenant's panel satisfied both and violated the
     * invariant every query in the repository relies on.
     */
    foreignKey({
      columns: [table.tenantId, table.panelId],
      foreignColumns: [panels.tenantId, panels.id],
      name: 'panel_health_tenant_panel_fk',
    }),

    check('panel_health_state_check', enumCheck('state', PANEL_HEALTH_STATES)),
    check('panel_health_failure_check', nullableEnumCheck('failure', PROVIDER_FAILURE_KINDS)),
    /** A failing state names its failure; a succeeding one does not. */
    check(
      'panel_health_failure_presence_check',
      sql`(state IN ('HEALTHY', 'DEGRADED')) = (failure IS NULL)`,
    ),
  ],
);

/**
 * One row per panel: the last time a connection test was allowed to start, and
 * what the panel looked like when it was.
 *
 * Separate from `panel_health` on purpose. Health is the RESULT of a probe and
 * a probe result is the only thing allowed to change it; a claim is the
 * permission to make one. Folding the claim into the health row would mean
 * writing to health without a probe, and would need a health row to exist
 * before a panel has ever been tested — a fabricated state, which
 * `UNCHECKED` deliberately is not.
 *
 * `configuration` is a digest of the panel's address, status and the three
 * credential-set timestamps. Never a credential and never a URL: a claim row
 * is not a place to keep a copy of the configuration, only a way to tell one
 * configuration from another.
 */
export const panelProbeClaims = pgTable(
  'panel_probe_claims',
  {
    panelId: uuid('panel_id')
      .primaryKey()
      .references(() => panels.id),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** sha256 of the configuration identity. Opaque, and comparable. */
    configuration: text('configuration').notNull(),
    /** When the probe that holds this claim STARTED, not when it finished. */
    claimedAt: timestamptz('claimed_at').notNull(),
  },
  (table) => [
    index('panel_probe_claims_tenant_idx').on(table.tenantId),
    foreignKey({
      columns: [table.tenantId, table.panelId],
      foreignColumns: [panels.tenantId, panels.id],
      name: 'panel_probe_claims_tenant_panel_fk',
    }),
  ],
);

/**
 * One row per tenant: how many real outbound provider probes it may still
 * make right now.
 *
 * A token bucket, refilled continuously: `tokens` as of `refilled_at`, and the
 * take that reads it adds what has accrued since, caps at the capacity, and
 * subtracts one — in ONE statement under the row lock, so two API processes
 * racing for the last token cannot both get it. The capacity and the refill
 * rate are configuration, not columns; the row holds only what cannot be
 * recomputed.
 *
 * Nothing about any panel is here — no address, no name, no configuration —
 * and that is the point: the per-panel cooldown is deliberately reset by a
 * configuration change, and this bound is deliberately not.
 */
export const panelProbeBudgets = pgTable(
  'panel_probe_budgets',
  {
    tenantId: uuid('tenant_id')
      .primaryKey()
      .references(() => tenants.id),
    /** Whole and fractional tokens; fractional because refill is continuous. */
    tokens: doublePrecision('tokens').notNull(),
    /** When `tokens` was last true. Refill is computed forward from here. */
    refilledAt: timestamptz('refilled_at').notNull(),
  },
  () => [check('panel_probe_budgets_tokens_check', sql`tokens >= 0`)],
);

/**
 * When the background monitor may next consider a panel, and why not sooner.
 *
 * SCHEDULING state, deliberately separate from `panel_health`. Health is the
 * latest thing a provider actually said; this is the loop's own bookkeeping,
 * and conflating them cost us twice in the first Phase 3C design. A scheduler
 * column on the health row meant a panel with no health row had no schedule
 * either, so a panel that could never be probed — no credential, a refused
 * address — was rediscovered on every tick for ever and occupied its tenant's
 * slot while doing nothing. And it meant the only way to defer such a panel was
 * to invent a health row saying something no provider had said.
 *
 * Nothing here is a secret and nothing here is provider output. A row is three
 * timestamps, a counter and an enum naming why the loop stepped back. There is
 * no column a credential, a cookie, a CSRF token or a response body could go
 * into.
 *
 * One row per panel, created with the panel and kept in step with it by the
 * same transactions that write the panel: creating, updating, re-crediting or
 * re-enabling a panel makes it eligible at once, and disabling or archiving one
 * makes it eligible never (`'infinity'`). That is what keeps the discovery scan
 * honest — a `DISABLED` panel is not skipped by the query, it is not in the
 * range the query reads.
 */
export const panelMonitorSchedule = pgTable(
  'panel_monitor_schedule',
  {
    panelId: uuid('panel_id')
      .primaryKey()
      .references(() => panels.id),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /**
     * The earliest moment the monitor may consider this panel.
     *
     * `'infinity'` for a panel that is not ACTIVE. A finite time in the past
     * means due now. Every cadence, backoff and deferral decision lands here,
     * so the discovery query is one range scan and never a CASE over policy.
     */
    nextEligibleAt: timestamptz('next_eligible_at').notNull(),
    /**
     * Consecutive FAILED probes, for backoff. Scheduler state, not health.
     *
     * Read together with the health row and discarded when that row does not
     * describe a failure — an older release that predates this table can
     * complete a successful manual probe, write only the health row, and leave
     * this counter behind; inheriting it would back a working panel off as if
     * it had been failing all along.
     */
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    /**
     * Why the loop last stepped back, when it did so without probing.
     *
     * Operational, and an enum rather than free text: a panel with no
     * credential and a panel whose address the policy refuses are different
     * operator jobs, and neither is a statement about what the provider said.
     */
    deferredReason: text('deferred_reason'),
    updatedAt: timestamptz('updated_at').notNull(),
  },
  (table) => [
    /**
     * The discovery scan, and the reason it is bounded.
     *
     * `(tenant_id, next_eligible_at, panel_id)` is read as a range: for ONE
     * tenant, the earliest eligible panels, `LIMIT n`. The planner walks n
     * index entries and stops. The previous design ranked every due panel on
     * the installation with a window function and then took fifty of them,
     * which is work proportional to the backlog on every tick.
     *
     * `panel_id` is in the index for the tiebreaker, and it is not decoration.
     * The scan orders by `(next_eligible_at, panel_id)` so the order is total
     * and stable; without the second column the index supplies only the first
     * key and PostgreSQL must sort every row that TIES on it before it can take
     * five. Ties are not hypothetical — a migration backfill and a mass
     * re-enable both make a tenant's whole fleet eligible at the same instant —
     * and the plan regression test measured exactly that: five hundred rows
     * read to return five. With the tiebreaker in the index there is no sort at
     * all.
     */
    index('panel_monitor_schedule_due_idx').on(table.tenantId, table.nextEligibleAt, table.panelId),
    /**
     * The pair, not the two halves — the same rule `panel_health` follows. Two
     * separate foreign keys would let a row name panel A while claiming tenant
     * B, and this row decides which tenant's fairness slot a panel occupies.
     */
    foreignKey({
      columns: [table.tenantId, table.panelId],
      foreignColumns: [panels.tenantId, panels.id],
      name: 'panel_monitor_schedule_tenant_panel_fk',
    }),
    check(
      'panel_monitor_schedule_deferred_reason_check',
      nullableEnumCheck('deferred_reason', MONITOR_DEFERRAL_REASONS),
    ),
  ],
);

/**
 * One row per tenant: when this tenant last had a turn, and the earliest its
 * panels might be eligible.
 *
 * The fairness mechanism, and it is a table rather than a cursor in a process
 * because a cursor in a process is wrong the moment there are two processes —
 * and there being two, briefly, is what a rolling update is.
 *
 * A tick claims the least-recently-served due tenants with
 * `FOR UPDATE SKIP LOCKED`, so two monitor replicas take DISJOINT tenant sets
 * rather than racing over one. Every claimed tenant's `last_served_at` moves,
 * which is what bounds the wait: with `t` tenants claimed per tick and `d` due
 * tenants, no tenant waits longer than `ceil(d / t)` ticks. That bound holds
 * whatever the backlog inside any one tenant is, which is the property that a
 * global "oldest first" ordering cannot offer at all.
 *
 * `next_eligible_at` here is a LOWER BOUND on the tenant's earliest eligible
 * panel, never an exact minimum. Keeping it exact would mean recomputing a MIN
 * on every schedule write; keeping it a lower bound means one cheap
 * `LEAST(...)` on the write path, and a claim that finds nothing due repairs
 * the bound from the index it just read. Stale-low costs one wasted claim;
 * stale-high would lose a tenant, so the direction is chosen deliberately.
 */
export const panelMonitorTenants = pgTable(
  'panel_monitor_tenants',
  {
    tenantId: uuid('tenant_id')
      .primaryKey()
      .references(() => tenants.id),
    /** A lower bound on this tenant's earliest eligible panel. Never later than the truth. */
    nextEligibleAt: timestamptz('next_eligible_at').notNull(),
    /** When this tenant last had a turn. The rotation order. */
    lastServedAt: timestamptz('last_served_at').notNull(),
  },
  (table) => [
    /**
     * The claim: due tenants, least recently served first.
     *
     * One row per TENANT, so this scan is bounded by how many tenants an
     * installation has — tens, on the deployment model this repository
     * produces — and not by how many panels are due, which is the number that
     * grows.
     */
    index('panel_monitor_tenants_rotation_idx').on(table.nextEligibleAt, table.lastServedAt),
  ],
);

/**
 * One row per backup run, and the row IS the installation's backup lock.
 *
 * INSTALLATION-scoped, so there is deliberately no `tenant_id`. A dump is of
 * the whole database; giving it a tenant column would invite a per-tenant
 * backup that this pipeline does not produce and cannot restore.
 *
 * The exclusivity is `backup_runs_single_active_idx`, a partial unique index on
 * a constant over `state = 'RUNNING'`. One RUNNING row can exist in the whole
 * table, enforced by PostgreSQL rather than by any process — which is the only
 * form of "one at a time" that survives two worker replicas, which is the
 * normal case on every rolling update. An in-memory flag would have bounded
 * exactly one process, and a `pg_advisory_xact_lock` would have to be held for
 * the length of a dump inside a transaction that `idle_in_transaction_session_
 * timeout` is configured to kill.
 *
 * A lock nothing can release is a lock that outlives its owner's crash, so the
 * claim is a LEASE: `lease_owner` names the process, `lease_heartbeat_at` is
 * refreshed while it works, and a run whose heartbeat has gone stale may be
 * taken over — by transitioning it to FAILED, never by silently adopting it,
 * because its temporary files belong to a process that may still be writing.
 *
 * Nothing here holds key material. `checksum` is a digest of the plaintext
 * dump, which is not a secret and is what makes the artifact verifiable later.
 * `delivery_detail` and `failure_message` carry redacted operator-facing text;
 * the bot token they could otherwise leak lives in the URL path of the Telegram
 * call and never reaches this table.
 */
export const backupRuns = pgTable(
  'backup_runs',
  {
    /** UUIDv7. This is the backup id in the manifest and in the caption. */
    id: uuid('id').primaryKey(),
    trigger: text('trigger').notNull(),
    state: text('state').notNull(),
    /** The stage in flight, or — once terminal — the stage the run ended in. */
    stage: text('stage').notNull(),
    startedAt: timestamptz('started_at').notNull(),
    finishedAt: timestamptz('finished_at'),

    /**
     * Who holds the lease and when they last proved it.
     *
     * `lease_owner` is a process identity, not a credential: role plus PID plus
     * a random suffix, so two replicas of the same role are distinguishable.
     */
    leaseOwner: text('lease_owner').notNull(),
    leaseHeartbeatAt: timestamptz('lease_heartbeat_at').notNull(),

    /** Bytes of the plaintext dump, and of the encrypted archive. */
    dumpBytes: bigint('dump_bytes', { mode: 'bigint' }),
    archiveBytes: bigint('archive_bytes', { mode: 'bigint' }),
    /** SHA-256 of the plaintext dump, lowercase hex. Not a secret. */
    checksum: text('checksum'),
    /**
     * When a real pg_restore into a real empty scratch database succeeded.
     *
     * Null on any run that did not get that far, which is what makes
     * "verified" a fact rather than an inference from `state`.
     */
    verifiedAt: timestamptz('verified_at'),

    /**
     * What we know about the Telegram delivery. See BACKUP_DELIVERY_STATES.
     *
     * `OUTCOME_UNKNOWN` is durable and nothing resends on it automatically.
     */
    deliveryState: text('delivery_state').notNull(),
    deliveryAttemptedAt: timestamptz('delivery_attempted_at'),
    /** Redacted operator-facing detail. Never a token, never a chat payload. */
    deliveryDetail: text('delivery_detail'),

    /** Set on FAILED. The stage is in `stage`; this says what went wrong. */
    failureCode: text('failure_code'),
    failureMessage: text('failure_message'),

    /**
     * Whether cleanup completed, and what was left behind if not.
     *
     * A column rather than a log line because a cleanup failure means plaintext
     * dump bytes are still on disk, or a scratch database still exists. Both
     * are things an operator must be told about explicitly; neither is visible
     * from a run that otherwise reports success.
     */
    cleanupOk: boolean('cleanup_ok').notNull(),
    cleanupDetail: text('cleanup_detail'),
  },
  (table) => [
    check('backup_runs_trigger_check', enumCheck('trigger', BACKUP_TRIGGERS)),
    check('backup_runs_state_check', enumCheck('state', BACKUP_RUN_STATES)),
    check('backup_runs_stage_check', enumCheck('stage', BACKUP_STAGES)),
    check('backup_runs_delivery_state_check', enumCheck('delivery_state', BACKUP_DELIVERY_STATES)),
    /**
     * A terminal run has an end; a RUNNING one does not.
     *
     * Both directions, because only one of them is the interesting failure: a
     * RUNNING row with `finished_at` set is a run something forgot to close,
     * and it would hold the installation's lock until its lease expired.
     */
    check('backup_runs_finished_at_check', sql`(state = 'RUNNING') = (finished_at IS NULL)`),
    /**
     * The installation-wide backup lock, enforced by the database.
     *
     * A partial unique index over a constant: at most one row may have
     * `state = 'RUNNING'`, whatever process inserted it. A second starter's
     * INSERT raises a unique violation, which the repository turns into a
     * truthful BUSY rather than a second dump.
     */
    uniqueIndex('backup_runs_single_active_idx')
      .on(sql`(true)`)
      .where(sql`state = 'RUNNING'`),
    /** The operator's list, and the scheduler's "when did we last succeed". */
    index('backup_runs_started_at_idx').on(table.startedAt),
  ],
);

/**
 * A recovery request: one attempt to make this installation be a backup again.
 *
 * Separate from `backup_runs` on purpose, and `docs/disaster-recovery-audit.md`
 * § MISSING-2 records the reasoning: a backup run is an artifact's history and a
 * recovery request is an operation against the installation, and the backup
 * lock is a partial unique index over `state = 'RUNNING'` that a recovery row
 * would contend with for no reason.
 *
 * `tenant_id NOT NULL` even though a backup covers every tenant. A backup is a
 * dump of the whole database, so "which tenant may act on it" has one
 * defensible answer — the tenant that IS the installation — and making that a
 * column rather than a convention is what turns cross-scope isolation into a
 * row-level predicate a test can guess against.
 */
export const recoveryRequests = pgTable(
  'recovery_requests',
  {
    /** UUIDv7. Appears in a URL, a confirmation binding and a journal file. */
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    source: text('source').notNull(),
    state: text('state').notNull(),
    stage: text('stage').notNull(),
    createdAt: timestamptz('created_at').notNull(),
    updatedAt: timestamptz('updated_at').notNull(),
    finishedAt: timestamptz('finished_at'),

    /**
     * Who asked, captured as a label at the time.
     *
     * A label as well as an id, so the row still names somebody after a rename
     * or a deletion — the same rule the audit log follows, and for the same
     * reason: a recovery is read long after the fact.
     */
    requestedByAdminId: uuid('requested_by_admin_id'),
    requestedByLabel: text('requested_by_label'),
    correlationId: text('correlation_id'),

    /**
     * The lease, exactly as `backup_runs` holds one.
     *
     * A recovery outlives any request, and two executor replicas are the normal
     * case on a rolling update. A stale lease is taken over by FAILING the
     * abandoned request, never by adopting it: its candidate database and its
     * workspace belong to a process that may still be writing them.
     */
    leaseOwner: text('lease_owner'),
    leaseHeartbeatAt: timestamptz('lease_heartbeat_at'),

    /**
     * Where the uploaded bytes live while this request is alive.
     *
     * A path on the installation's own disk, under `RECOVERY_WORK_DIR`, with a
     * random directory name. Recorded so a crashed executor's debris is
     * nameable; removed on every terminal path. Not a secret, and not derived
     * from anything a caller sent.
     */
    workspacePath: text('workspace_path'),
    /** Bytes received, and the digest of the ENCRYPTED container as received. */
    uploadBytes: bigint('upload_bytes', { mode: 'bigint' }),
    uploadSha256: text('upload_sha256'),
    /**
     * What the browser called the file. Recorded, and acted on NOWHERE.
     *
     * Not the path, not the format decision, not the content type. It exists so
     * an operator can recognise which file they sent, and it is bounded and
     * sanitised before storage because it is attacker-chosen text that gets
     * rendered.
     */
    clientFilename: text('client_filename'),

    /** From the manifest, once the archive has been authenticated. */
    backupId: uuid('backup_id'),
    artifactChecksum: text('artifact_checksum'),
    archiveKeyId: text('archive_key_id'),
    verifiedAt: timestamptz('verified_at'),
    /** The verification and restore-test facts, as recorded. */
    verification: jsonb('verification'),
    restoreTest: jsonb('restore_test'),

    /**
     * The confirmation BINDING. The phrase itself is never stored.
     *
     * The phrase is a constant, so storing it would prove nothing; what has to
     * be durable is what the confirmation was for. `confirmed_checksum` is
     * re-compared against the artifact at execution time, which is what makes a
     * confirmation for backup A unable to restore backup B.
     */
    confirmedAt: timestamptz('confirmed_at'),
    confirmedByAdminId: uuid('confirmed_by_admin_id'),
    confirmedSessionId: uuid('confirmed_session_id'),
    confirmedChecksum: text('confirmed_checksum'),
    confirmationExpiresAt: timestamptz('confirmation_expires_at'),

    /** The mandatory pre-restore backup of the installation being replaced. */
    preRestoreBackupId: uuid('pre_restore_backup_id'),

    /**
     * The candidate database, and the name the outgoing one was renamed to.
     *
     * `displaced_database` is the single most important field on this row after
     * a cutover: it is how an operator knows production is the new database and
     * where the old one still is. Not a secret — it is a database name on their
     * own server — and without it a manual rollback is guesswork.
     */
    candidateDatabase: text('candidate_database'),
    displacedDatabase: text('displaced_database'),
    cutoverAt: timestamptz('cutover_at'),

    /** A value from `RECOVERY_FAILURE_CODES`. Never a message. */
    failureCode: text('failure_code'),
  },
  (table) => [
    check('recovery_requests_source_check', enumCheck('source', RECOVERY_SOURCES)),
    check('recovery_requests_state_check', enumCheck('state', RECOVERY_STATES)),
    check('recovery_requests_stage_check', enumCheck('stage', RECOVERY_STAGES)),
    check(
      'recovery_requests_failure_code_check',
      nullableEnumCheck('failure_code', RECOVERY_FAILURE_CODES),
    ),
    /**
     * A terminal request has an end; a live one does not. Both directions.
     *
     * The interesting failure is the second: a live request with `finished_at`
     * set is a request something forgot to close, and while it is in a
     * quiescing state it is holding the installation's writes shut.
     */
    check(
      'recovery_requests_finished_at_check',
      sql`(state IN ('SUCCEEDED', 'FAILED')) = (finished_at IS NOT NULL)`,
    ),
    /**
     * A cutover implies a displaced database. NOT the reverse.
     *
     * These two are how an operator learns which database is production, and the
     * dangerous direction is the one this refuses: `cutover_at` set with no
     * displaced name is a row saying production is the restored candidate and not
     * saying where the data it replaced went.
     *
     * The reverse IS representable, because it is a state the cutover genuinely
     * reaches. `ALTER DATABASE` cannot run in a transaction, so between the two
     * renames the outgoing database has MOVED and the candidate has not taken its
     * name — `CutoverError.outgoingRenamed`, journal phase `RENAMED_OUT`. A
     * recovery that ends there has a displaced database and no cutover, and both
     * reconstruction paths in `recovery-executor.ts` write exactly that row: the
     * failure path in `execute`, and `reconcileCutovers` for a journal nothing
     * recorded. The first version of this check made both of those rows
     * unrepresentable, so the reconstruction raised 23514 — which left the
     * recovery unrecorded, the journal uncleared, and every later tick throwing
     * in `reconcileCutovers` before it could claim anything at all.
     *
     * `purgeFinishedBefore` keeps a row with either field set, so the name of the
     * database holding the operator's previous data survives retention in both
     * shapes.
     */
    check(
      'recovery_requests_cutover_check',
      sql`cutover_at IS NULL OR displaced_database IS NOT NULL`,
    ),
    /**
     * A confirmation is all four fields or none of them.
     *
     * The binding is the security property, so a partial binding must not be
     * representable: a row with `confirmed_at` and no `confirmed_checksum`
     * would be a confirmation for anything.
     */
    check(
      'recovery_requests_confirmation_check',
      sql`num_nonnulls(confirmed_at, confirmed_by_admin_id, confirmed_checksum, confirmation_expires_at) IN (0, 4)`,
    ),
    /**
     * ONE destructive recovery at a time, enforced by PostgreSQL.
     *
     * A partial unique index over a constant, exactly like the backup lock. Two
     * executor replicas is the normal case on every rolling update and two
     * operators pressing at once is the normal case in an incident; neither has
     * to agree with the other about anything, because the second INSERT or
     * UPDATE raises a unique violation.
     *
     * The predicate is the DESTRUCTIVE state set, not the live one: an
     * artifact being verified or restore-tested changes nothing about the
     * installation, so several of those at once are fine and only the chain
     * past the confirmation is exclusive.
     */
    uniqueIndex('recovery_requests_single_destructive_idx')
      .on(sql`(true)`)
      .where(
        sql.raw(
          `state IN (${RECOVERY_ACTIVE_DESTRUCTIVE_STATES.map((state) => `'${state}'`).join(', ')})`,
        ),
      ),
    /**
     * The operator's list keyset: `(tenant_id, created_at, id)`, scope first.
     *
     * Declared HERE and not in `ONLINE_INDEXES`, unlike the panels and alerts
     * keysets, and the difference is the table rather than the index. Those build
     * concurrently because `botctl update` migrates while the outgoing release is
     * still serving, so an ordinary `CREATE INDEX` lands a SHARE lock on a live
     * table. This table is CREATED by the same migration: there is no live data
     * to lock and nothing else can see it yet, so the build is instant and
     * drizzle-kit's drift check can see the index — which the online ones
     * deliberately cannot.
     *
     * `id` is in the index because it is in the ORDER BY. A btree serves the
     * DESC scan of an ASC index backwards, so this one index covers both the
     * ordering and the `ROW(created_at, id) < ROW(...)` continuation.
     */
    index('recovery_requests_tenant_created_idx').on(table.tenantId, table.createdAt, table.id),
  ],
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
  panels,
  panelCredentials,
  panelHealth,
  panelProbeClaims,
  panelProbeBudgets,
  panelMonitorSchedule,
  panelMonitorTenants,
  backupRuns,
  recoveryRequests,
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

// ---------------------------------------------------------------------------
// Phase 4 — customers, catalogue, commerce, settlement and provisioning
//
// Three rules run through every table below, each of which the legacy system
// breaks and pays for:
//
//   - Money is `bigint` minor units plus an explicit currency column, always as a
//     pair, and a CHECK refuses half a pair. There is no `doublePrecision` money
//     column anywhere and there is no `balance` column at all: a balance is
//     `SUM(signed amount)` over `wallet_entries`, which `check-boundaries.sh`
//     enforces by rejecting a migration that adds one.
//   - A historical fact is a SNAPSHOT, not a join. An order carries the title,
//     specification and price it was confirmed at; reading them back from
//     `products` is how «محصول حذف‌شده» happens and how renaming a plan rewrites
//     last month's report.
//   - Uniqueness that matters is a CONSTRAINT, not a count. One trial per
//     customer, one redemption per order, one attribution per referee and one
//     provider user per panel are partial or composite unique indexes, because a
//     count is a read followed by a write and two concurrent requests both read
//     zero.
// ---------------------------------------------------------------------------

/**
 * The customer.
 *
 * Keyed on `(tenant_id, telegram_user_id)` and deliberately not on the bot
 * instance: one tenant's several bots must converge on one customer, or a wallet
 * balance differs per bot and nobody can explain why. `first_bot_instance_id`
 * records where they arrived, which is reporting rather than identity — and it is
 * nullable because a customer created by an operator import has no such bot.
 *
 * `telegram_user_id` is TEXT. Every use of it is identity, never arithmetic, and
 * `provider-note.ts` already fixes the same choice for the same value.
 *
 * There is no `deleted_at`. A block is not a deletion: the orders, payments,
 * ledger entries and services survive it because they are facts, and a soft-delete
 * column would give two ways to express "not served" that every query would have to
 * know about.
 */
export const customers = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    telegramUserId: text('telegram_user_id').notNull(),
    /** Mutable metadata. Never identity, and nothing resolves a customer by it. */
    username: text('username'),
    firstName: text('first_name'),
    lastName: text('last_name'),
    /** Recorded and deliberately not yet consulted — the product ships one catalogue. */
    languageCode: text('language_code'),
    status: text('status').notNull().default('ACTIVE'),
    /** Where this customer first arrived. Reporting, not identity, hence nullable. */
    firstBotInstanceId: uuid('first_bot_instance_id').references(() => botInstances.id),
    firstSeenAt: timestamptz('first_seen_at').notNull().defaultNow(),
    lastSeenAt: timestamptz('last_seen_at').notNull().defaultNow(),
    blockedAt: timestamptz('blocked_at'),
    /**
     * Why an operator blocked this customer.
     *
     * An operator note, and it is never rendered to the customer — `bot.blocked`
     * carries no placeholder. A reason shown to the person it is about is a reason an
     * operator will stop writing honestly.
     */
    blockedReason: text('blocked_reason'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    /** The identity. Per tenant, so the same human may be a customer of two. */
    uniqueIndex('customers_tenant_telegram_key').on(table.tenantId, table.telegramUserId),
    /** The list's deterministic keyset: created_at then id, never a mutable column. */
    index('customers_tenant_created_idx').on(table.tenantId, table.createdAt, table.id),
    /**
     * Username search, lowercased, with `text_pattern_ops`.
     *
     * An expression index rather than a lowercased column, because storing a second
     * copy of a mutable field is a second thing to keep in step. Searches are
     * case-insensitive because a customer telling an operator their username does not
     * preserve case.
     *
     * `text_pattern_ops` is the part that makes it READABLE, and it was missing.
     * `/users?username=` is a PREFIX search, and a default-collation btree cannot
     * serve `LIKE 'x%'` at all — measured on 20 000 rows, the planner ignored this
     * index, walked `customers_tenant_created_idx` instead and discarded 12 289 rows
     * to return 26, at 364 shared buffers. With the operator class it is an Index
     * Cond carrying the prefix range: 111 rows and 31 buffers, and the gap grows with
     * the tenant's customer count. The repository's comment claimed this index served
     * the search all along, which made it a promise the plan did not keep — and an
     * index with no reader is the `callback_refs` situation from migration 0002.
     *
     * `customers-plan.test.ts` pins the plan, because a claim about an index that no
     * test reads is the claim that drifts.
     */
    index('customers_tenant_username_idx').on(
      table.tenantId,
      sql`lower(username) text_pattern_ops`,
    ),
    check('customers_status_check', enumCheck('status', CUSTOMER_STATUSES)),
    /** A blocked customer has a time; an active one does not. Neither state can lie. */
    check('customers_blocked_at_check', sql`(status = 'BLOCKED') = (blocked_at IS NOT NULL)`),
    /** The target of the composite references the child tables use. */
    unique('customers_tenant_id_key').on(table.tenantId, table.id),
  ],
);

/**
 * A product — one sellable plan.
 *
 * `price_amount` and `price_currency` are NULLABLE together, and that is the
 * "do not invent a value" rule expressed in DDL: a tenant that has not priced a plan
 * has an unpriced plan, not a free one. `PRODUCT_NOT_PRICED` is the refusal, and it
 * fires at order confirmation where an operator can read it.
 *
 * `panel_id` is nullable for the same reason: a product an operator is still
 * configuring cannot be fulfilled, and the honest encoding of that is an absent
 * panel rather than a pointer to an arbitrary one.
 */
export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    title: text('title').notNull(),
    description: text('description'),
    status: text('status').notNull().default('INACTIVE'),
    audience: text('audience').notNull().default('EVERYONE'),
    sortOrder: integer('sort_order').notNull().default(0),
    /**
     * Where a purchase of this plan is fulfilled. Null until configured.
     *
     * The single-column reference is KEPT alongside the composite one below, and that
     * is not an oversight. It is implied by `products_tenant_panel_fk` and therefore
     * redundant — but 0032 shipped it, and `migration-compatibility.test.ts` requires
     * every dropped constraint to be re-added by the same file: a migration that
     * removed it would take a constraint away from the release still running during a
     * rolling update. Expand only.
     */
    panelId: uuid('panel_id').references(() => panels.id),
    /** 0 means no time limit (`UNLIMITED_DURATION_DAYS`). */
    durationDays: integer('duration_days').notNull(),
    /** 0 means no traffic limit (`UNLIMITED_TRAFFIC_BYTES`). Bytes, never gigabytes. */
    trafficBytes: bigint('traffic_bytes', { mode: 'bigint' }).notNull(),
    /** Null means "the provider's default", which is not the same as a cap of zero. */
    deviceLimit: integer('device_limit'),
    priceAmount: bigint('price_amount', { mode: 'bigint' }),
    priceCurrency: text('price_currency'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('products_tenant_status_idx').on(table.tenantId, table.status),
    /** The catalogue's order, and the list's keyset: sort, then created, then id. */
    index('products_tenant_sort_idx').on(
      table.tenantId,
      table.sortOrder,
      table.createdAt,
      table.id,
    ),
    check('products_status_check', enumCheck('status', PRODUCT_STATUSES)),
    check('products_audience_check', enumCheck('audience', PRODUCT_AUDIENCES)),
    check('products_price_currency_check', nullableEnumCheck('price_currency', CURRENCY_CODES)),
    /**
     * A price is an amount AND a currency, or it is absent.
     *
     * Half a price is the shape that makes a total meaningless, and it is exactly what
     * an interrupted edit or a partial import leaves behind.
     */
    check('products_price_pair_check', sql`(price_amount IS NULL) = (price_currency IS NULL)`),
    check('products_price_positive_check', sql`price_amount IS NULL OR price_amount > 0`),
    check('products_duration_check', sql`duration_days >= 0 AND duration_days <= 3650`),
    check('products_traffic_check', sql`traffic_bytes >= 0`),
    check('products_device_limit_check', sql`device_limit IS NULL OR device_limit > 0`),
    /**
     * The pair, not the two halves. The same defect 0018 fixed for panel children.
     *
     * `panel_id` alone referenced `panels(id)`, which constrained it to SOME panel in
     * the installation and said nothing about it being THIS tenant's. A product could
     * therefore name another tenant's panel, and every downstream reader — the
     * catalogue's fulfillable predicate, the order snapshot, and eventually the
     * provisioning call that dials it — would have believed the pointer.
     *
     * MATCH SIMPLE is what makes this work with a nullable column: a composite foreign
     * key is not enforced when any of its columns is NULL, so an unconfigured product
     * (`panel_id IS NULL`) is still legal, exactly as `payments_order_fk` above.
     */
    foreignKey({
      columns: [table.tenantId, table.panelId],
      foreignColumns: [panels.tenantId, panels.id],
      name: 'products_tenant_panel_fk',
    }),
    unique('products_tenant_id_key').on(table.tenantId, table.id),
  ],
);

/**
 * An order — one commercial intent and its snapshot of what was bought.
 *
 * Every `line_*` column is a snapshot taken at confirmation. `product_id` and
 * `panel_id` are kept so an operator can navigate, and are explicitly NOT how the
 * purchase is reconstructed.
 *
 * `quote` is the full `PriceQuote` including its mandatory trace, so the order can
 * always answer "why this number" — the question the legacy system cannot answer for
 * any of its prices. It is `jsonb` because it is a document read as a whole and never
 * queried by its parts.
 */
export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    customerId: uuid('customer_id').notNull(),
    state: text('state').notNull().default('DRAFT'),

    /** Navigation only. The snapshot below is the truth about this purchase. */
    productId: uuid('product_id').notNull(),
    panelId: uuid('panel_id').notNull(),
    lineTitle: text('line_title').notNull(),
    lineDurationDays: integer('line_duration_days').notNull(),
    lineTrafficBytes: bigint('line_traffic_bytes', { mode: 'bigint' }).notNull(),
    lineDeviceLimit: integer('line_device_limit'),
    lineUnitPriceAmount: bigint('line_unit_price_amount', { mode: 'bigint' }).notNull(),
    lineQuantity: integer('line_quantity').notNull().default(1),

    subtotalAmount: bigint('subtotal_amount', { mode: 'bigint' }).notNull(),
    discountAmount: bigint('discount_amount', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    totalAmount: bigint('total_amount', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),
    /** The full quote with its trace. A quote without one is refused by the contract. */
    quote: jsonb('quote').notNull(),
    /** Normalised upper case, or null. At most one per order (`MAX_DISCOUNT_CODES_PER_ORDER`). */
    discountCode: text('discount_code'),

    expiresAt: timestamptz('expires_at'),
    confirmedAt: timestamptz('confirmed_at'),
    settledAt: timestamptz('settled_at'),
    cancelledAt: timestamptz('cancelled_at'),
    refundedAt: timestamptz('refunded_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    /** A child row may not name a customer of another tenant. */
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'orders_customer_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.productId],
      foreignColumns: [products.tenantId, products.id],
      name: 'orders_product_fk',
    }),
    index('orders_tenant_created_idx').on(table.tenantId, table.createdAt, table.id),
    index('orders_tenant_state_idx').on(table.tenantId, table.state),
    index('orders_customer_created_idx').on(table.customerId, table.createdAt, table.id),
    /** The expiry sweeper's only path: unpaid orders, oldest deadline first. */
    index('orders_expiry_idx')
      .on(table.expiresAt)
      .where(sql`state = 'AWAITING_PAYMENT'`),
    check('orders_state_check', enumCheck('state', ORDER_STATES)),
    check('orders_currency_check', enumCheck('currency', CURRENCY_CODES)),
    /**
     * A total is never negative, and the parts agree with the whole.
     *
     * `clampDiscount` enforces the first in the application; this is the half that
     * survives a direct write and a future code path that forgets.
     */
    check(
      'orders_amounts_check',
      sql`subtotal_amount >= 0 AND discount_amount >= 0 AND total_amount >= 0`,
    ),
    check('orders_total_consistent_check', sql`total_amount = subtotal_amount - discount_amount`),
    check('orders_discount_bounded_check', sql`discount_amount <= subtotal_amount`),
    check('orders_quantity_check', sql`line_quantity >= 1`),
    /** Each lifecycle timestamp exists exactly when its state has been reached. */
    check(
      'orders_settled_at_check',
      sql`(state = 'PAID' OR state = 'REFUNDED') = (settled_at IS NOT NULL)`,
    ),
    check('orders_refunded_at_check', sql`(state = 'REFUNDED') = (refunded_at IS NOT NULL)`),
    check('orders_cancelled_at_check', sql`(state = 'CANCELLED') = (cancelled_at IS NOT NULL)`),
    unique('orders_tenant_id_key').on(table.tenantId, table.id),
    /**
     * Redundant against the primary key, and the target of a CUSTOMER-bearing
     * composite reference.
     *
     * `payments`, `services` and `discount_redemptions` each carry their own
     * `customer_id` beside an `order_id`, and a two-column `(tenant_id, order_id)`
     * foreign key lets a child row name order A while claiming customer B. Every one of
     * those is a real bypass: a payment that settles another customer's order, a service
     * that appears in the wrong customer's list, and — the one that motivated this — a
     * discount redemption whose `(discount_id, customer_id)` pair is a fiction, which
     * makes a per-customer redemption limit advisory rather than enforced.
     *
     * So the children reference `(tenant_id, id, customer_id)` and the agreement becomes
     * impossible to express rather than merely unlikely. Found by the automated security
     * review of the schema commit, which is exactly the class of thing a reviewer sees
     * and an author does not: each FK looked correct on its own.
     */
    unique('orders_tenant_id_customer_key').on(table.tenantId, table.id, table.customerId),
  ],
);

/**
 * A payment — one attempt to settle money.
 *
 * `reference` is the string a customer quotes and an operator searches, unique per
 * tenant, and it is what makes a manual transfer reconcilable at all. It is generated,
 * never customer-supplied.
 *
 * `external_reference` holds a gateway's own identifier. There is no gateway adapter in
 * this release, so the column is empty — and it is here rather than added later because
 * a payment without a place to record external identity is a payment that cannot be
 * reconciled, and the first gateway would have to migrate live rows to get one.
 */
export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    customerId: uuid('customer_id').notNull(),
    /** Null for a wallet top-up, which settles no order. */
    orderId: uuid('order_id'),
    state: text('state').notNull().default('PENDING'),
    method: text('method').notNull(),
    amount: bigint('amount', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),
    /** Generated, unique per tenant, quoted by the customer. Never customer-supplied. */
    reference: text('reference').notNull(),
    /** What a confirmation rests on. Null until confirmed. */
    evidenceKind: text('evidence_kind'),
    /**
     * An operator's note about the evidence, bounded.
     *
     * Never the customer's own message text and never a gateway response body: the
     * first is arbitrary third-party text and the second routinely carries a token.
     */
    evidenceNote: text('evidence_note'),
    /** The gateway's own id. Unused in this release; see the docblock. */
    externalReference: text('external_reference'),
    confirmedAt: timestamptz('confirmed_at'),
    /** Which administrator confirmed it, for an `OPERATOR_REVIEW`. */
    confirmedByAdminId: uuid('confirmed_by_admin_id').references(() => admins.id),
    expiresAt: timestamptz('expires_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'payments_customer_fk',
    }),
    /*
     * The customer travels WITH the order.
     *
     * `order_id` is nullable — a wallet top-up settles no order — and a MATCH SIMPLE
     * composite foreign key is not enforced when any of its columns is NULL, which is
     * exactly the behaviour wanted here: a top-up has no order to agree with, and every
     * payment that names one must name its owner too. Without the third column a wallet
     * debit could settle another customer's order.
     */
    foreignKey({
      columns: [table.tenantId, table.orderId, table.customerId],
      foreignColumns: [orders.tenantId, orders.id, orders.customerId],
      name: 'payments_order_fk',
    }),
    uniqueIndex('payments_tenant_reference_key').on(table.tenantId, table.reference),
    index('payments_tenant_created_idx').on(table.tenantId, table.createdAt, table.id),
    index('payments_tenant_state_idx').on(table.tenantId, table.state),
    index('payments_customer_created_idx').on(table.customerId, table.createdAt, table.id),
    /**
     * At most ONE confirmed payment per order.
     *
     * A partial unique index rather than an application check, because two concurrent
     * confirmations both read "no confirmed payment yet". This is the constraint that
     * makes a double charge impossible rather than unlikely.
     */
    uniqueIndex('payments_order_confirmed_key')
      .on(table.orderId)
      .where(sql`state = 'CONFIRMED' AND order_id IS NOT NULL`),
    /** The reconciliation queue: payments whose outcome nobody knows. */
    index('payments_unknown_idx')
      .on(table.tenantId, table.createdAt)
      .where(sql`state = 'UNKNOWN'`),
    check('payments_state_check', enumCheck('state', PAYMENT_STATES)),
    check('payments_method_check', enumCheck('method', PAYMENT_METHODS)),
    check('payments_currency_check', enumCheck('currency', CURRENCY_CODES)),
    check(
      'payments_evidence_kind_check',
      nullableEnumCheck('evidence_kind', PAYMENT_EVIDENCE_KINDS),
    ),
    check('payments_amount_check', sql`amount > 0`),
    /**
     * A confirmed payment has a time AND evidence. Both, together.
     *
     * A confirmation with no recorded evidence is the legacy receipt review, which
     * records neither reviewer nor time (UNK-PR-010) — so "was this approved by a
     * human" is unanswerable there.
     */
    check(
      'payments_confirmed_check',
      sql`(state = 'CONFIRMED') = (confirmed_at IS NOT NULL AND evidence_kind IS NOT NULL)`,
    ),
    unique('payments_tenant_id_key').on(table.tenantId, table.id),
  ],
);

/**
 * The wallet ledger — append-only, and the only authority on a balance.
 *
 * There is no balance column anywhere in this schema. A balance is
 * `SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END)` over a customer's
 * entries, and the index below is what makes that a single ranged scan. The legacy
 * system's mutable balance column with no ledger is what produces its unexplained
 * 916,550 residual.
 *
 * `amount` is always POSITIVE and `direction` carries the sign, which `ledger.ts`
 * fixes. A signed amount column would let a CREDIT of -500 express a debit, and then
 * two representations of one movement exist.
 *
 * `reference` is the idempotency identity of a MOVEMENT, unique per tenant. It is what
 * makes a double debit impossible under a retried command: the second insert violates
 * the index and the whole transaction rolls back.
 *
 * The table is append-only by trigger, like `audit_logs` — see the migration. A reversal
 * is a new entry naming the original in `reverses_entry_id`, never an edit.
 */
export const walletEntries = pgTable(
  'wallet_entries',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    customerId: uuid('customer_id').notNull(),
    direction: text('direction').notNull(),
    reason: text('reason').notNull(),
    /** Always positive. The sign lives in `direction`. */
    amount: bigint('amount', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),
    /** The movement's idempotency identity, unique per tenant. */
    reference: text('reference').notNull(),
    /** Set for a `REVERSAL_REASONS` entry, naming the entry it reverses. */
    reversesEntryId: uuid('reverses_entry_id'),
    orderId: uuid('order_id'),
    paymentId: uuid('payment_id'),
    /** Who caused it, when that was an administrator rather than a flow. */
    actorAdminId: uuid('actor_admin_id').references(() => admins.id),
    /** Bounded operator note. Never customer text. */
    note: text('note'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'wallet_entries_customer_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.orderId],
      foreignColumns: [orders.tenantId, orders.id],
      name: 'wallet_entries_order_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.paymentId],
      foreignColumns: [payments.tenantId, payments.id],
      name: 'wallet_entries_payment_fk',
    }),
    /** The one thing that makes a double debit impossible rather than unlikely. */
    uniqueIndex('wallet_entries_tenant_reference_key').on(table.tenantId, table.reference),
    /**
     * The balance scan, and the history page, in one index.
     *
     * `(customer_id, created_at, id)` — the sum reads the whole of a customer's slice
     * and the page reads the tail of it, so one index serves both and neither needs a
     * sort.
     */
    index('wallet_entries_customer_created_idx').on(table.customerId, table.createdAt, table.id),
    index('wallet_entries_tenant_created_idx').on(table.tenantId, table.createdAt, table.id),
    check('wallet_entries_direction_check', enumCheck('direction', LEDGER_DIRECTIONS)),
    check('wallet_entries_reason_check', enumCheck('reason', LEDGER_REASONS)),
    check('wallet_entries_currency_check', enumCheck('currency', CURRENCY_CODES)),
    /** Positive, always. This is the invariant the whole ledger rests on. */
    check('wallet_entries_amount_check', sql`amount > 0`),
    unique('wallet_entries_tenant_id_key').on(table.tenantId, table.id),
  ],
);

/**
 * A service — what the customer is entitled to, as Nexa knows it.
 *
 * Nexa is the authority on the entitlement; the provider holds external reality that
 * is RECONCILED into `traffic_used_bytes` and `usage_synced_at`. Both halves matter: a
 * provider treated as authoritative means a panel outage deletes an entitlement, and a
 * provider ignored means billing for something that does not exist.
 *
 * `provider_username` is derived from the service id (`providerUsernameFor`) and unique
 * per PANEL, which is the constraint that makes adoption after an unknown outcome safe:
 * a reconcile asks the panel for that exact name, and the index guarantees at most one
 * service claims it.
 *
 * `usage_synced_at` is nullable and is rendered to the customer beside the figure,
 * because a usage number with no "as of" is a number a customer reads as live.
 */
export const services = pgTable(
  'services',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    customerId: uuid('customer_id').notNull(),
    /** The order that created it. A renewal is a NEW order against the SAME service. */
    orderId: uuid('order_id').notNull(),
    panelId: uuid('panel_id').notNull(),
    /** Navigation and reporting. The snapshot of what was bought is on the order. */
    productId: uuid('product_id').notNull(),
    state: text('state').notNull().default('PENDING_PROVISION'),
    /** Derived from this row's own id. Unique per panel, which is what adoption needs. */
    providerUsername: text('provider_username').notNull(),
    /**
     * The `subId` the panel serves this customer's configuration under. A CAPABILITY.
     *
     * Random, 128 bits, chosen HERE and written in the settling transaction — not
     * derived from the service id like the username beside it. The two are different
     * kinds of thing and the distinction is the whole reason this column exists: the
     * username appears in an operator's client list and is meant to be recoverable,
     * while anybody holding this value can fetch the customer's configuration from
     * `https://<subscription domain>/sub/<this>` with no authentication at all.
     *
     * It was derived, through an unkeyed SHA-256 of the service id — and the service id
     * travels in `operational_events.context`, in `audit_logs.entity_id` and in
     * `outbox_messages.aggregate_id`, none of which are places for a credential. Worse,
     * `providerUsernameFor` is a reversible encoding rather than a hash, so reading a
     * name off a panel screen recovered the id and therefore the link. The docblocks
     * claimed the opposite in both directions.
     *
     * Stored rather than derived loses nothing: it is written BEFORE any provider call,
     * so a create whose answer was lost can still be reconciled against it — which is
     * the only property the derivation was there to provide.
     *
     * The DEFAULT is the rollback window, not a convenience. `NOT NULL` with no default
     * would narrow what the release before this one can write, which
     * `migration-compatibility.test.ts` forbids by name — so a release rolled back onto
     * this schema keeps inserting, and any row it writes gets a distinct random value
     * rather than a null or a shared sentinel. `ServiceDraft` requires both fields, so
     * nothing in THIS release ever relies on the default.
     */
    subscriptionRef: text('subscription_ref')
      .notNull()
      .default(sql`md5(gen_random_uuid()::text)`),
    /**
     * The client UUID a panel that keys clients by one assigns this service. A
     * CREDENTIAL.
     *
     * 3X-UI's VLESS client id, which the customer's configuration authenticates with.
     * Random and stored for exactly the reasons above; formatted as a v4 UUID because
     * that is what the panels validate.
     */
    providerClientId: uuid('provider_client_id')
      .notNull()
      .default(sql`gen_random_uuid()`),
    /** The provider's own identifier, once a provider has told us one. */
    providerUserId: text('provider_user_id'),
    /**
     * The subscription URL the customer receives.
     *
     * Delivered to its owner by design, so it is stored in the clear — but it is a
     * bearer capability for that one service, which is why no list endpoint returns it
     * and only the owner's own detail view does.
     */
    subscriptionUrl: text('subscription_url'),
    expiresAt: timestamptz('expires_at'),
    /** 0 means unlimited, matching the product snapshot it came from. */
    trafficLimitBytes: bigint('traffic_limit_bytes', { mode: 'bigint' }).notNull(),
    trafficUsedBytes: bigint('traffic_used_bytes', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    usageSyncedAt: timestamptz('usage_synced_at'),
    /**
     * Whether the customer has been told. A separate axis from `state`, deliberately.
     *
     * A failed Telegram send must leave a paid-for, provider-side account `ACTIVE`;
     * anything else invites re-provisioning a service that already exists.
     */
    deliveryState: text('delivery_state').notNull().default('PENDING'),
    deliveryAttempts: integer('delivery_attempts').notNull().default(0),
    deliveredAt: timestamptz('delivered_at'),
    /** When the delivery sweep may next try. Null means it may try now. */
    deliveryNextAttemptAt: timestamptz('delivery_next_attempt_at'),
    /**
     * When a send was handed to Telegram and no outcome has been recorded yet.
     *
     * `provisioning_operations.call_started_at` for the announcement half, and it exists
     * for the same reason: it is the one fact that distinguishes "this process died
     * before sending" from "this process died after sending", and only the second must
     * never be repeated automatically.
     *
     * Without it a sweep that was killed between the send and `recordDelivery` left the
     * row `PENDING` behind nothing but a lease — so when the lease expired the automatic
     * lane announced again, which is precisely the duplicate the `UNCONFIRMED` state was
     * introduced to prevent. An ordinary container restart was enough.
     *
     * Cleared by every recorded outcome, so a set value always means an unresolved send.
     */
    deliverySendStartedAt: timestamptz('delivery_send_started_at'),
    provisionedAt: timestamptz('provisioned_at'),
    terminatedAt: timestamptz('terminated_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'services_customer_fk',
    }),
    /** The customer travels with the order, or a service lands in the wrong list. */
    foreignKey({
      columns: [table.tenantId, table.orderId, table.customerId],
      foreignColumns: [orders.tenantId, orders.id, orders.customerId],
      name: 'services_order_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.panelId],
      foreignColumns: [panels.tenantId, panels.id],
      name: 'services_panel_fk',
    }),
    /**
     * One provider user per panel.
     *
     * Not per tenant: two tenants may legitimately use the same panel, and the name
     * they would collide on is derived from a service id, so a collision here means two
     * services claim one provider account — which is the duplicate that makes usage
     * figures meaningless.
     */
    uniqueIndex('services_panel_provider_username_key').on(table.panelId, table.providerUsername),
    /**
     * And the subscription reference, for the same reason one step further along.
     *
     * 128 random bits will not collide, and an index is what makes that a guarantee
     * rather than an expectation: two services sharing a `subId` would serve one
     * customer the other's configuration, which is the worst outcome this table has.
     */
    uniqueIndex('services_panel_subscription_ref_key').on(table.panelId, table.subscriptionRef),
    index('services_tenant_created_idx').on(table.tenantId, table.createdAt, table.id),
    index('services_tenant_state_idx').on(table.tenantId, table.state),
    index('services_customer_created_idx').on(table.customerId, table.createdAt, table.id),
    /** The expiry sweeper, and the reconciliation queue, each their own partial index. */
    index('services_expiry_idx')
      .on(table.expiresAt)
      .where(sql`state = 'ACTIVE' OR state = 'SUSPENDED'`),
    index('services_unreconciled_idx')
      .on(table.tenantId, table.createdAt)
      .where(sql`state = 'UNRECONCILED'`),
    check('services_state_check', enumCheck('state', SERVICE_STATES)),
    check('services_traffic_check', sql`traffic_limit_bytes >= 0 AND traffic_used_bytes >= 0`),
    /** The format the panels accept, pinned so a bad generator fails at the write. */
    check('services_subscription_ref_check', sql`subscription_ref ~ '^[0-9a-f]{32}$'`),
    /** A provisioned service has a time; one that never was does not. */
    check(
      'services_provisioned_at_check',
      sql`(state = 'PENDING_PROVISION' OR state = 'UNRECONCILED') = (provisioned_at IS NULL)`,
    ),
    check(
      'services_terminated_at_check',
      sql`(state = 'TERMINATED') = (terminated_at IS NOT NULL)`,
    ),
    /** A usage figure and its "as of" travel together, or the figure is a lie. */
    check(
      'services_usage_synced_check',
      sql`traffic_used_bytes = 0 OR usage_synced_at IS NOT NULL`,
    ),
    check('services_delivery_state_check', enumCheck('delivery_state', SERVICE_DELIVERY_STATES)),
    check(
      'services_delivery_attempts_check',
      sql`delivery_attempts >= 0 AND delivery_attempts <= 100`,
    ),
    /** A delivery time and the state that claims one travel together, or neither is true. */
    check(
      'services_delivered_at_check',
      sql`(delivery_state = 'DELIVERED') = (delivered_at IS NOT NULL)`,
    ),
    /**
     * ONE service per order, as a constraint rather than as worker discipline.
     *
     * This is the exactly-once rule. The service row is written inside the SAME
     * transaction that takes `SETTLE`, so an order settles once and this index says an
     * order produces at most one service — two workers, a replayed command and a
     * double-tapped button all lose here rather than each creating a provider account
     * the customer pays for once and occupies twice.
     *
     * On `(tenant_id, order_id)` and NOT on `(tenant_id, customer_id, product_id)`,
     * because a renewal is a NEW order against the SAME service: a customer may hold
     * two services bought from one product, and must.
     */
    uniqueIndex('services_tenant_order_key').on(table.tenantId, table.orderId),
    /** The delivery sweep: undelivered services whose backoff has elapsed. */
    index('services_delivery_due_idx')
      .on(table.deliveryNextAttemptAt)
      .where(sql`delivery_state = 'PENDING'`),
    unique('services_tenant_id_key').on(table.tenantId, table.id),
  ],
);

/**
 * One attempt at one external effect.
 *
 * `operation_id` is the 16-hex value DERIVED from the idempotency key under the
 * `provider` namespace, and it is unique per tenant. That is what makes the whole design
 * work: two workers retrying one command derive the same id with no lookup, so the
 * second insert loses on this index rather than starting a second provider call.
 *
 * `call_started_at` is the column that decides whether a crashed operation may be
 * released. Set immediately BEFORE the provider call and committed on its own — so if
 * the process dies during the call, the row says a call was started and the lease expiry
 * must not hand it to another worker as though nothing had happened.
 */
export const provisioningOperations = pgTable(
  'provisioning_operations',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** Derived, never generated. 16 lowercase hex characters. */
    operationId: text('operation_id').notNull(),
    serviceId: uuid('service_id').notNull(),
    /** Null for an operation not caused by an order — a reconcile, a usage sync. */
    orderId: uuid('order_id'),
    panelId: uuid('panel_id').notNull(),
    type: text('type').notNull(),
    state: text('state').notNull().default('PLANNED'),
    attempts: integer('attempts').notNull().default(0),
    /**
     * The earliest a claim may take this row. Null means now.
     *
     * Backoff, and the reason it is a column rather than a sleep: the retry delay has to
     * survive the process that decided it. Without this a `FAILED` attempt is re-claimed
     * on the very next tick, which is a hot loop of authentication attempts against
     * somebody else's panel — and 3X-UI blocks an IP-and-username pair after enough of
     * them, so the loop ends by locking the installation out of its own provider.
     */
    nextAttemptAt: timestamptz('next_attempt_at'),
    /** Who holds the claim, and until when. Both null when unclaimed. */
    claimedBy: text('claimed_by'),
    leaseUntil: timestamptz('lease_until'),
    /**
     * Set before the provider call and committed separately.
     *
     * The one fact that distinguishes "a worker died before calling" from "a worker died
     * during a call", and therefore the one fact that decides whether a release is safe.
     */
    callStartedAt: timestamptz('call_started_at'),
    /** The provider's own reference for the effect, when it gave one. */
    providerReference: text('provider_reference'),
    /** A kind from the EXISTING provider taxonomy. Never a new vocabulary. */
    failureKind: text('failure_kind'),
    /** Bounded, redacted diagnostic. Never a raw provider response. */
    failureMessage: text('failure_message'),
    completedAt: timestamptz('completed_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.serviceId],
      foreignColumns: [services.tenantId, services.id],
      name: 'provisioning_operations_service_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.orderId],
      foreignColumns: [orders.tenantId, orders.id],
      name: 'provisioning_operations_order_fk',
    }),
    /** The derivation's whole purpose: a retry collides here instead of calling twice. */
    uniqueIndex('provisioning_operations_tenant_operation_key').on(
      table.tenantId,
      table.operationId,
    ),
    /**
     * The worker's claim scan: due work, oldest first, nothing else read.
     *
     * Leads with `next_attempt_at` because that is what the scan filters on; a row whose
     * backoff has not elapsed is not due, and ordering by creation date alone would put
     * the oldest permanently-failing operation at the front of every tick.
     */
    index('provisioning_operations_due_idx')
      .on(table.nextAttemptAt, table.createdAt)
      .where(sql`state = 'PLANNED'`),
    /** Expired leases, for the release sweep. */
    index('provisioning_operations_lease_idx')
      .on(table.leaseUntil)
      .where(sql`state = 'IN_FLIGHT'`),
    index('provisioning_operations_service_idx').on(table.serviceId, table.createdAt, table.id),
    /**
     * ONE open PROVISION per service, enforced by the database rather than by a check.
     *
     * "One at a time is a partial unique index, not a process" — the rule CLAUDE.md
     * states about backups, applied to the operation that spends a customer's money on
     * somebody else's panel. Two open creates for one service means two provider calls;
     * the derived username makes the second collide rather than duplicate the account,
     * but a collision is a `PROVIDER_ERROR`, which classifies UNKNOWN on a mutating
     * call, which strands the service in `UNRECONCILED`. So a double-click on the
     * operator's retry button corrupted a service it was meant to rescue.
     *
     * Only the two NON-TERMINAL states, so the ordinary sequence still works: a create
     * that FAILED may be retried, and the re-plan after a provably-absent reconcile is
     * legal because the operation it follows is `UNKNOWN`. `SUCCEEDED` is excluded for
     * the same reason — a renewal is a different operation type.
     */
    uniqueIndex('provisioning_operations_open_provision_key')
      .on(table.tenantId, table.serviceId)
      .where(sql`type = 'PROVISION' AND state IN ('PLANNED', 'IN_FLIGHT')`),
    index('provisioning_operations_unknown_idx')
      .on(table.tenantId, table.createdAt)
      .where(sql`state = 'UNKNOWN'`),
    check('provisioning_operations_state_check', enumCheck('state', OPERATION_STATES)),
    check('provisioning_operations_type_check', enumCheck('type', OPERATION_TYPES)),
    check(
      'provisioning_operations_failure_kind_check',
      nullableEnumCheck('failure_kind', PROVIDER_FAILURE_KINDS),
    ),
    check('provisioning_operations_operation_id_check', sql`operation_id ~ '^[0-9a-f]{16}$'`),
    check('provisioning_operations_attempts_check', sql`attempts >= 0 AND attempts <= 100`),
    /** A claim is a holder AND a deadline, together or not at all. */
    check('provisioning_operations_claim_check', sql`(claimed_by IS NULL) = (lease_until IS NULL)`),
    /** Terminal states have a completion time; live ones do not. */
    check(
      'provisioning_operations_completed_check',
      sql`(state IN ('SUCCEEDED', 'FAILED', 'ABANDONED')) = (completed_at IS NOT NULL)`,
    ),
    unique('provisioning_operations_tenant_id_key').on(table.tenantId, table.id),
  ],
);

/**
 * A discount code.
 *
 * `value` is whole percent for `PERCENTAGE` and minor units for `FIXED_AMOUNT`, and
 * `currency` is required for the second and forbidden for the first — a percentage with
 * a currency is a category error that would eventually be read as an amount.
 *
 * `redemption_count` is a counter and NOT the authority on whether the limit is
 * exhausted: the authority is the conditional UPDATE that increments it
 * (`WHERE redemption_count < limit`), so two concurrent redemptions cannot both pass.
 * The counter exists so a list can show usage without aggregating.
 */
export const discounts = pgTable(
  'discounts',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** Normalised to upper case before storage, so case cannot split a counter. */
    code: text('code').notNull(),
    type: text('type').notNull(),
    status: text('status').notNull().default('INACTIVE'),
    /** Whole percent, or minor units. See the docblock. */
    value: bigint('value', { mode: 'bigint' }).notNull(),
    currency: text('currency'),
    startsAt: timestamptz('starts_at'),
    endsAt: timestamptz('ends_at'),
    /** Null means unlimited. Two limits, because "100 uses" and "1 each" differ. */
    totalRedemptionsLimit: integer('total_redemptions_limit'),
    perCustomerLimit: integer('per_customer_limit'),
    minimumSubtotalAmount: bigint('minimum_subtotal_amount', { mode: 'bigint' }),
    redemptionCount: integer('redemption_count').notNull().default(0),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('discounts_tenant_code_key').on(table.tenantId, table.code),
    index('discounts_tenant_created_idx').on(table.tenantId, table.createdAt, table.id),
    check('discounts_type_check', enumCheck('type', DISCOUNT_TYPES)),
    check('discounts_status_check', enumCheck('status', DISCOUNT_STATUSES)),
    check('discounts_currency_check', nullableEnumCheck('currency', CURRENCY_CODES)),
    check('discounts_value_check', sql`value > 0`),
    /** A percentage is 1..100 and carries no currency; a fixed amount carries one. */
    check(
      'discounts_percentage_check',
      sql`type <> 'PERCENTAGE' OR (value <= 100 AND currency IS NULL)`,
    ),
    check('discounts_fixed_check', sql`type <> 'FIXED_AMOUNT' OR currency IS NOT NULL`),
    check(
      'discounts_window_check',
      sql`starts_at IS NULL OR ends_at IS NULL OR starts_at < ends_at`,
    ),
    check(
      'discounts_limits_check',
      sql`(total_redemptions_limit IS NULL OR total_redemptions_limit > 0) AND (per_customer_limit IS NULL OR per_customer_limit > 0)`,
    ),
    check('discounts_count_check', sql`redemption_count >= 0`),
    /** The code is ASCII and upper case in the database, not only in the application. */
    check('discounts_code_shape_check', sql`code ~ '^[A-Z0-9_-]{3,40}$'`),
    unique('discounts_tenant_id_key').on(table.tenantId, table.id),
  ],
);

/**
 * One redemption — the fact that a code was applied to an order.
 *
 * Unique on `(tenant_id, order_id)` so an order cannot redeem twice even if a retry
 * re-enters the discount step, and indexed on `(discount_id, customer_id)` so the
 * per-customer limit is a bounded count rather than a scan.
 */
export const discountRedemptions = pgTable(
  'discount_redemptions',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    discountId: uuid('discount_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    orderId: uuid('order_id').notNull(),
    /** What it actually took off, snapshotted — the code may be re-tuned later. */
    amount: bigint('amount', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.discountId],
      foreignColumns: [discounts.tenantId, discounts.id],
      name: 'discount_redemptions_discount_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'discount_redemptions_customer_fk',
    }),
    /**
     * The customer travels with the order.
     *
     * This is the one the review found. The per-customer redemption limit is counted over
     * `(discount_id, customer_id)`, so a row whose customer does not own its order makes
     * the limit advisory — a customer could redeem a once-per-person code repeatedly by
     * attributing each redemption elsewhere.
     */
    foreignKey({
      columns: [table.tenantId, table.orderId, table.customerId],
      foreignColumns: [orders.tenantId, orders.id, orders.customerId],
      name: 'discount_redemptions_order_fk',
    }),
    /** One redemption per order, as a constraint rather than a check-then-write. */
    uniqueIndex('discount_redemptions_order_key').on(table.tenantId, table.orderId),
    index('discount_redemptions_discount_customer_idx').on(table.discountId, table.customerId),
    check('discount_redemptions_currency_check', enumCheck('currency', CURRENCY_CODES)),
    check('discount_redemptions_amount_check', sql`amount > 0`),
  ],
);

/**
 * A referral attribution.
 *
 * Unique on `(tenant_id, referee_id)`: a customer is attributed to at most one referrer,
 * ever, and the constraint is what makes that true under concurrent `/start` commands
 * carrying different codes.
 *
 * `reward_entry_id` names the ledger entry that paid it, so "did this pay out" is a
 * column rather than a search. Null until the trigger fires, which for
 * `ON_FIRST_PAID_ORDER` may be much later than the attribution.
 */
export const referrals = pgTable(
  'referrals',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    referrerId: uuid('referrer_id').notNull(),
    refereeId: uuid('referee_id').notNull(),
    /** The policy in force when the attribution was made, snapshotted. */
    trigger: text('trigger').notNull(),
    rewardEntryId: uuid('reward_entry_id'),
    rewardedAt: timestamptz('rewarded_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.referrerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'referrals_referrer_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.refereeId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'referrals_referee_fk',
    }),
    /** One attribution per referee, for ever. */
    uniqueIndex('referrals_referee_key').on(table.tenantId, table.refereeId),
    index('referrals_referrer_idx').on(table.referrerId, table.createdAt, table.id),
    /** Unrewarded attributions, for the payout pass. */
    index('referrals_unrewarded_idx')
      .on(table.tenantId, table.createdAt)
      .where(sql`rewarded_at IS NULL`),
    check('referrals_trigger_check', enumCheck('trigger', REFERRAL_TRIGGERS)),
    /** Self-referral is impossible in the database too, not only in the service. */
    check('referrals_not_self_check', sql`referrer_id <> referee_id`),
    /** A reward has an entry and a time, or neither. */
    check('referrals_reward_pair_check', sql`(reward_entry_id IS NULL) = (rewarded_at IS NULL)`),
  ],
);

/**
 * A trial grant.
 *
 * One row per customer per tenant, enforced by a unique index — `TRIALS_PER_CUSTOMER`.
 * `CLAUDE.md` records the same reasoning for the backup lease: one at a time is an
 * index, not a process, because a count is a read followed by a write.
 *
 * `service_id` is set once provisioning has a service to point at, so a grant is the
 * record of the decision and the service is the record of the thing — and a failed
 * provisioning does not let the customer take a second trial, which is the abuse a
 * nullable service would otherwise open.
 */
export const trialGrants = pgTable(
  'trial_grants',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    customerId: uuid('customer_id').notNull(),
    /** The product configured as the trial when the grant was made, snapshotted. */
    productId: uuid('product_id').notNull(),
    serviceId: uuid('service_id'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'trial_grants_customer_fk',
    }),
    /** One trial per customer. The index IS the rule. */
    uniqueIndex('trial_grants_customer_key').on(table.tenantId, table.customerId),
    index('trial_grants_tenant_created_idx').on(table.tenantId, table.createdAt, table.id),
  ],
);

/**
 * A reseller — a customer with a pricing policy and, possibly, a credit line.
 *
 * `credit_limit_amount` defaults to ZERO, which is `RESELLER_DEFAULT_CREDIT_LIMIT_MINOR`
 * and the owner's instruction: a credit feature defaults to no credit, because the other
 * default means a tenant discovers it has extended unsecured credit to everyone it ever
 * marked a reseller. The limit is stored POSITIVE and means "the balance may reach minus
 * this", so no comparison is a double negative.
 *
 * `discount_percentage` is required for `PERCENTAGE_DISCOUNT` and forbidden for
 * `LIST_PRICE`, checked by the database. There is no default margin.
 */
export const resellers = pgTable(
  'resellers',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    customerId: uuid('customer_id').notNull(),
    status: text('status').notNull().default('ACTIVE'),
    pricingMode: text('pricing_mode').notNull().default('LIST_PRICE'),
    /** Whole percent off list. Null unless the mode is PERCENTAGE_DISCOUNT. */
    discountPercentage: integer('discount_percentage'),
    /** Positive, and zero by default. See the docblock. */
    creditLimitAmount: bigint('credit_limit_amount', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    creditLimitCurrency: text('credit_limit_currency').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'resellers_customer_fk',
    }),
    /** A customer is a reseller once, or not at all. */
    uniqueIndex('resellers_customer_key').on(table.tenantId, table.customerId),
    index('resellers_tenant_created_idx').on(table.tenantId, table.createdAt, table.id),
    check('resellers_status_check', enumCheck('status', RESELLER_STATUSES)),
    check('resellers_pricing_mode_check', enumCheck('pricing_mode', RESELLER_PRICING_MODES)),
    check('resellers_credit_currency_check', enumCheck('credit_limit_currency', CURRENCY_CODES)),
    /** Stored positive, so every comparison against it reads forwards. */
    check('resellers_credit_limit_check', sql`credit_limit_amount >= 0`),
    check(
      'resellers_discount_mode_check',
      sql`(pricing_mode = 'PERCENTAGE_DISCOUNT') = (discount_percentage IS NOT NULL)`,
    ),
    check(
      'resellers_discount_range_check',
      sql`discount_percentage IS NULL OR (discount_percentage >= 1 AND discount_percentage <= 100)`,
    ),
  ],
);
