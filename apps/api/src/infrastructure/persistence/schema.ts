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
  PRODUCT_SORT_MAX,
  PRODUCT_SORT_MIN,
  PRODUCT_CATEGORY_EMOJI_MAX_CODE_POINTS,
  PRODUCT_CATEGORY_NAME_MAX_LENGTH,
  PRODUCT_CATEGORY_STATUSES,
  PRODUCT_CATEGORY_VISIBILITIES,
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
  SERVICE_ADDON_KINDS,
  SERVICE_ADDON_STATUSES,
  COMMERCIAL_ORDER_PURPOSES,
  ORDER_PURPOSES,
  ORDER_SETTLED_STATES,
  ORDER_STATES,
  PAYMENT_GATEWAY_PROVIDERS,
  REFUND_CHANNELS,
  REFUND_STATES,
  PAYMENT_GATEWAY_STATUSES,
  PAYMENT_RECEIPT_KINDS,
  RECEIPT_CAPTURE_CLOSE_REASONS,
  PAYMENT_STATES,
  PAYMENT_METHODS,
  PAYMENT_EVIDENCE_KINDS,
  PAYMENT_RESOLVED_STATES,
  LEDGER_DIRECTIONS,
  LEDGER_REASONS,
  SERVICE_DELIVERY_STATES,
  CUSTOMER_NOTIFICATION_KINDS,
  CUSTOMER_NOTIFICATION_STATES,
  SERVICE_STATES,
  SERVICE_REMINDER_KINDS,
  DEFAULT_USERNAME_PREFIX,
  DEFAULT_USERNAME_STRATEGY,
  SERVICE_USERNAME_MODES,
  USERNAME_STRATEGIES,
  USERNAME_CAPTURE_CLOSE_REASONS,
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
    /**
     * A digest of the command menu Telegram was last given, as hex.
     *
     * `OQ-4H-02`: `setMyCommands` ran inside `execute` and nowhere else, and
     * `execute` returns ALREADY_COMPLETE before reaching it on an installation
     * whose webhook is current. So an installation that UPGRADES into a release
     * carrying a new command keeps whatever menu it had — for most, none — and
     * the discoverability 4H shipped applied to fresh installs only.
     *
     * A digest rather than a hand-bumped version number, for the reason
     * `webhook_secret_fingerprint` above is one: a number somebody has to
     * remember to increment is a number that will be forgotten in exactly the
     * release that changed the list. It covers the rendered menu — the commands
     * AND their descriptions — so a catalogue rewording re-registers too.
     *
     * NULL means "unknown", never "matches". A row written before this column
     * needs one registration to become knowable, and one unnecessary
     * `setMyCommands` is a far cheaper mistake than a silent claim. It is the
     * same argument the fingerprint above makes, and the same answer.
     */
    commandsRevision: text('commands_revision'),
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
    /**
     * The most services this panel may carry, or NULL for no limit.
     *
     * Phase 6B, and NULL is the honest default rather than a large number: this
     * installation does not know what any given panel can take. The number is an
     * operator's judgement about their own machine, so the absence of one means
     * "nobody has said", not "unlimited is proven safe".
     *
     * A SOFT cap. Lowering it below current usage refuses new sales and terminates
     * nothing — a limit that could delete a customer's service because somebody
     * mistyped a number is not a limit, it is an outage with a form field.
     */
    maxServices: integer('max_services'),
    /**
     * Which username modes a customer buying on this panel may use.
     *
     * Both default to true, so every panel that exists when this migration runs keeps
     * offering everything and nothing an operator configured changes underneath them.
     * `panels_username_policy_check` refuses both being false: a panel a customer
     * cannot name a service on is a panel nothing can be bought from, and it would
     * fail at their purchase rather than at the operator's save.
     */
    allowCustomUsername: boolean('allow_custom_username').notNull().default(true),
    allowAutomaticUsername: boolean('allow_automatic_username').notNull().default(true),
    /**
     * Which of the four presets generates an AUTOMATIC name here.
     *
     * NOT NULL with a real default, and that is the correction 0094 carries. A
     * nullable column meaning "nobody has configured this, so something else decides"
     * is a migration state in a vocabulary every surface has to render, and it makes
     * the generator unreadable: an operator could not answer "what will the next
     * customer be called" without knowing what the absence falls back to.
     *
     * `PREFIX_RANDOM` with the prefix `nx` renders twelve characters —
     * `DEFAULT_USERNAME_PATTERN`. Existing services are not renamed.
     */
    usernameStrategy: text('username_strategy').notNull().default(DEFAULT_USERNAME_STRATEGY),
    /**
     * The `PREFIX_RANDOM` prefix. NULL under any other strategy.
     *
     * Defaulted, and it HAS to be: `username_strategy` defaults to PREFIX_RANDOM, and
     * `panels_username_prefix_check` is a biconditional, so a prefix with no default
     * makes a panel created without a policy unstorable. 0095 is that correction —
     * found by the integration case that creates a panel and names no policy, which
     * is the commonest way an operator makes one.
     */
    usernamePrefix: text('username_prefix').default(DEFAULT_USERNAME_PREFIX),
    /** The `CUSTOM_TEMPLATE` template. NULL under any other strategy. */
    usernameTemplate: text('username_template'),
    /** Set when the panel is archived, so the event has a time and not just a state. */
    archivedAt: timestamptz('archived_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('panels_tenant_status_idx').on(table.tenantId, table.status),
    /**
     * At least one username mode, always.
     *
     * A CHECK rather than a service-layer rule because it is the kind of invariant a
     * direct write, a restore or a future surface can break, and a panel with no mode
     * is only discovered by a customer trying to buy.
     */
    check(
      'panels_username_policy_check',
      sql`${table.allowCustomUsername} OR ${table.allowAutomaticUsername}`,
    ),
    check('panels_username_strategy_check', enumCheck('username_strategy', USERNAME_STRATEGIES)),
    /**
     * A preset and the configuration it needs, or neither. Not "or something".
     *
     * Two biconditionals rather than two one-way implications, so a template left
     * behind by a strategy change cannot sit in the row pretending to be inert: the
     * one-checkbox edit that re-selects `CUSTOM_TEMPLATE` would then go live against
     * a value nobody looked at. The service nulls the other field on every write.
     */
    check(
      'panels_username_prefix_check',
      sql`(${table.usernameStrategy} = 'PREFIX_RANDOM') = (${table.usernamePrefix} IS NOT NULL)`,
    ),
    check(
      'panels_username_template_check',
      sql`(${table.usernameStrategy} = 'CUSTOM_TEMPLATE') = (${table.usernameTemplate} IS NOT NULL)`,
    ),
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
     * A cap is a positive number or it is absent.
     *
     * Zero is the interesting case and it is refused rather than accepted as "sell
     * nothing": an operator who wants a panel to stop taking business has
     * `DISABLED`, which says so, stops the probes and reads as a decision. A zero
     * cap would be a second way to spell it that nothing else in the system
     * recognises — the health view would still say `HEALTHY`, the panel would still
     * be probed, and the catalogue would go quiet with no state anywhere naming why.
     */
    check('panels_max_services_check', sql`max_services IS NULL OR max_services > 0`),
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
    /**
     * Consecutive probes that concluded an UNUSABLE state, reset to zero by any
     * probe that did not.
     *
     * Named for what it measures rather than `consecutive_failures`, and that is
     * deliberate: `panel_monitor_schedule` already has a column by that name whose
     * own docblock calls it "scheduler state, not health" and which is discarded
     * whenever the health row does not describe a failure. Two columns with one
     * name in one module, meaning different things and reset on different rules, is
     * how the wrong one comes to answer the question.
     *
     * UNUSABLE, not failing: `PANEL_UNUSABLE_HEALTH_STATES` is `UNREACHABLE` and
     * `AUTH_FAILED` only. A `DEGRADED` probe RESETS this, because that state means
     * the credentials were accepted and the panel is up — it is worrying, not
     * unusable, and a panel that is up must keep selling.
     *
     * Written by the same conditional upsert that guards `checked_at`, so a probe
     * whose answer arrives out of order cannot advance it.
     */
    unusableStreak: integer('unusable_streak').notNull().default(0),
    /**
     * The connection identity this probe ran against, or NULL for a row written
     * before the column existed.
     *
     * What `panels.status` may be enabled on the strength of. A test that
     * succeeded against one base URL, one activation and one set of credentials
     * says nothing about a different one, and an operator who fixes a password
     * after a green test must not be able to enable on the strength of the test
     * that preceded the fix.
     *
     * NOT `configurationFingerprint`, which exists for a different job — cancelling
     * an in-flight probe whose panel changed under it — and which includes `status`
     * and `updated_at`. Both of those move when a panel is enabled, so reusing it
     * here would invalidate every validation the moment it was acted on, and force
     * a fresh probe on every routine re-enable after maintenance.
     */
    validatedIdentity: text('validated_identity'),
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
 * A slot on a panel, held for one order while the customer decides whether to pay.
 *
 * Phase 6B. The alternative — counting services and comparing against the cap —
 * is wrong in exactly one place and it is the place that matters: between a
 * customer confirming an order and their payment settling there is no service
 * row, so two customers reaching for the last slot both count the same n-1 and
 * are both sold it. The row is what makes the last slot exclusive, and it exists
 * for precisely the window in which nothing else represents that customer's
 * claim on the panel.
 *
 * It is released the moment something else does represent it. Settlement writes
 * the service inside the same transaction that deletes this row, so the slot is
 * held continuously and counted once, never twice and never briefly by nobody.
 * Every other exit — the payment expiring, being rejected, the order cancelled —
 * deletes it and gives the slot back.
 *
 * DELETED rather than marked, and that is the design. A `RELEASED` state would
 * make the capacity query filter on it, and a query that must exclude rows is a
 * query one caller will forget to write that way; a row that is gone cannot be
 * counted by accident. What the release MEANT is in the audit trail and the
 * order's own history, which is where a reader looks for it anyway.
 */
export const panelCapacityReservations = pgTable(
  'panel_capacity_reservations',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    panelId: uuid('panel_id').notNull(),
    /**
     * The order this slot is being held for. UNIQUE, and that is the idempotency.
     *
     * A confirmation replayed by a retry, a double-tapped button or a second
     * replica collides here rather than taking a second slot from a panel that
     * may only have one left.
     */
    orderId: uuid('order_id').notNull(),
    /**
     * When this hold stops counting, whatever else has happened.
     *
     * The backstop for the release that never ran — a process killed between the
     * payment and the delete, a lane that lost its work. Without it an abandoned
     * checkout holds somebody else's slot until an operator notices, which on a
     * single-slot panel means the panel is full and nothing says why.
     *
     * The capacity query filters on this rather than a sweep deleting rows,
     * because a sweep is a process and this must be true without one running.
     */
    expiresAt: timestamptz('expires_at').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    /** A child row may not name another tenant's panel. */
    foreignKey({
      columns: [table.tenantId, table.panelId],
      foreignColumns: [panels.tenantId, panels.id],
      name: 'panel_capacity_reservations_tenant_panel_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.orderId],
      foreignColumns: [orders.tenantId, orders.id],
      name: 'panel_capacity_reservations_order_fk',
    }),
    /** One slot per order. The collision IS the replay defence. */
    uniqueIndex('panel_capacity_reservations_order_key').on(table.tenantId, table.orderId),
    /**
     * The counting scan: for ONE panel, the holds that have not expired.
     *
     * Leads with the panel because that is what capacity is asked about, and
     * carries `expires_at` so the predicate is served by the same index rather
     * than by a filter over every hold the panel has ever taken.
     */
    index('panel_capacity_reservations_panel_idx').on(
      table.tenantId,
      table.panelId,
      table.expiresAt,
    ),
  ],
);

/**
 * A service username somebody is in the middle of buying.
 *
 * The hold that stops two customers paying for one name. It exists because the
 * decision moved: a username used to be derived from the service id — minted after the
 * money, unique by construction, impossible to contend for — and a customer-chosen or
 * template-rendered name is none of those things. It is chosen BEFORE the payment, and
 * between that choice and the provider account there is a window in which the name
 * belongs to nobody unless a row says otherwise.
 *
 * ## Why this is not `panel_capacity_reservations` with a different column
 *
 * The lifecycles differ where it matters most, and `docs/phase6c-audit.md` A-6 records
 * the difference: capacity is freed by `expires_at` so an abandoned checkout cannot
 * hold a slot for ever, and **a funded username must never be freed that way**. A TTL
 * that expired a paid name would let a second customer reserve a name the first already
 * has an account for on the panel — two services, one provider account, and the usage
 * figures of both meaningless.
 *
 * So `funded_at` is the switch. While it is null the row is an abandoned checkout and
 * `expires_at` may reap it; once it is set the row is protected until the order reaches
 * a terminal outcome — FULFILLED, which consumes the name into
 * `services.provider_username`, or REFUNDED, which releases it. An `UNRECONCILED`
 * service is neither: the remote account may exist, so the name stays held.
 *
 * ## Why the key is a namespace rather than a panel
 *
 * `services_panel_provider_username_key` is per panel, and two panel rows may point at
 * the same provider host — `panels` constrains only the name, never `base_url`. Those
 * panels share one account namespace, so a per-panel hold would let two customers
 * reserve one name on one real panel. `namespace_key` is derived from the provider type
 * and the normalised host and port, so they contend as they should.
 *
 * A definitive conflict that survives both — an account an operator made by hand — is a
 * definitive non-delivery and follows the money rules. It is never adopted.
 */
/**
 * The window in which an ordinary message means "this is my username".
 *
 * Modelled on `receipt_captures` deliberately, down to the partial unique index,
 * because it answers the same dangerous question: when may a plain message the customer
 * typed be read as an answer rather than as conversation? The legacy system answered it
 * with a stateful prompt that outlived its question and overwrote a production gateway
 * setting with somebody's ordinary message (INCIDENT-FIN-001).
 *
 * Two things bound the damage, and neither is the deadline. First, the window is a ROW:
 * it is explicit, it has an owner, and a redelivered message either finds it or does
 * not. Second, and more important, the only thing an open window can DO is validate a
 * name against the one draft order it names, for the one customer it names. There is no
 * branch in which it reaches a setting, a payment or another order — so even a window
 * that outlived its question is confined to the question.
 */
export const usernameCaptures = pgTable(
  'username_captures',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** WHICH bot, for the reason `receipt_captures.bot_instance_id` states. */
    botInstanceId: uuid('bot_instance_id')
      .notNull()
      .references(() => botInstances.id),
    customerId: uuid('customer_id').notNull(),
    orderId: uuid('order_id').notNull(),
    openedAt: timestamptz('opened_at').notNull().defaultNow(),
    expiresAt: timestamptz('expires_at').notNull(),
    /** Null while open. The partial unique index below is keyed on exactly this. */
    closedAt: timestamptz('closed_at'),
    closeReason: text('close_reason'),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'username_captures_customer_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.orderId],
      foreignColumns: [orders.tenantId, orders.id],
      name: 'username_captures_order_fk',
    }),
    /**
     * ONE open window per customer per bot, decided by the database.
     *
     * Two taps on two different drafts arriving together both read "nothing open", and
     * the name the customer then types attaches to whichever row the planner returns
     * first — a username reserved against an order they were not looking at, on a panel
     * they were not buying from.
     */
    uniqueIndex('username_captures_open_key')
      .on(table.tenantId, table.botInstanceId, table.customerId)
      .where(sql`closed_at IS NULL`),
    /** The sweep's index: windows past their deadline that nobody has closed. */
    index('username_captures_due_idx')
      .on(table.tenantId, table.expiresAt)
      .where(sql`closed_at IS NULL`),
    check(
      'username_captures_close_reason_check',
      nullableEnumCheck('close_reason', USERNAME_CAPTURE_CLOSE_REASONS),
    ),
    /** A closed window has a reason, and an open one has neither. Both halves. */
    check('username_captures_closed_check', sql`(closed_at IS NULL) = (close_reason IS NULL)`),
    check('username_captures_expiry_check', sql`expires_at > opened_at`),
  ],
);

export const serviceUsernameReservations = pgTable(
  'service_username_reservations',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /**
     * The provider account namespace this name is held in.
     *
     * Derived, not entered: `<provider_type>:<host>[:<port>]`, lowercased. Stored rather
     * than computed at query time so the unique index below can be a plain index on a
     * column, and so a panel whose address is later edited does not silently move every
     * hold it took.
     */
    namespaceKey: text('namespace_key').notNull(),
    username: text('username').notNull(),
    panelId: uuid('panel_id').notNull(),
    orderId: uuid('order_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    /** Which mode produced it, so an audit can tell a typed name from a rendered one. */
    mode: text('mode').notNull(),
    /**
     * When the money for this name committed, or null while the checkout is unfunded.
     *
     * The single field that decides whether `expires_at` may reap this row. See the
     * table docblock: a TTL that frees a funded name is two services on one account.
     */
    fundedAt: timestamptz('funded_at'),
    /**
     * The backstop for an abandoned checkout, and ONLY for one.
     *
     * Every query that treats a row as held must also require `funded_at IS NOT NULL OR
     * expires_at > now()`. Expiry alone is not release: a funded row past its expiry is
     * still held, which is the whole difference from the capacity table.
     */
    expiresAt: timestamptz('expires_at').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.panelId],
      foreignColumns: [panels.tenantId, panels.id],
      name: 'service_username_reservations_tenant_panel_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.orderId],
      foreignColumns: [orders.tenantId, orders.id],
      name: 'service_username_reservations_order_fk',
    }),
    /**
     * One name per namespace, and the collision IS the refusal.
     *
     * Deliberately NOT scoped by tenant: two tenants pointing at one provider host
     * share its account namespace whether or not they know about each other, and a name
     * one of them created is a name the other cannot have. The row exposes nothing
     * across the boundary — a caller learns only that the name is unavailable, which is
     * the same answer the provider would eventually give.
     */
    uniqueIndex('service_username_reservations_name_key').on(table.namespaceKey, table.username),
    /** One name per order. A duplicate callback finds its own row rather than taking a second. */
    uniqueIndex('service_username_reservations_order_key').on(table.tenantId, table.orderId),
    /** The reaper's scan: unfunded holds that have run out. */
    index('service_username_reservations_expiry_idx').on(table.fundedAt, table.expiresAt),
    check('service_username_reservations_mode_check', enumCheck('mode', SERVICE_USERNAME_MODES)),
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
/**
 * A group a customer browses before they browse products.
 *
 * Tenant-scoped like everything a tenant owns, and it carries the same two dimensions a
 * product does — `status` and `visibility` — for the reason `catalog.ts` gives: a
 * category with its own vocabulary would be a second way to say "stop selling this",
 * and two vocabularies for one idea disagree the first time somebody edits only one.
 *
 * `emoji` is nullable and ordinary when absent. It is short text with a CHECK that
 * bounds its length and refuses control characters, and deliberately no check that it
 * IS an emoji — `isValidCategoryEmoji` says why, and the short version is that the
 * stronger check is an icon library wearing a regex.
 *
 * There is no `is_empty` column and no product counter. An empty category is one with no
 * customer-visible product in it, which is a property of the products, and a cached
 * count is a second answer to that question that goes stale the moment a product is
 * deactivated. `nexa-conventions` has the same rule about balances for the same reason.
 */
/**
 * The control characters a rendered label may not contain, as a PostgreSQL regex.
 *
 * Built from code points rather than written as a literal, because writing the class
 * inline in a template literal is how the first version of this constraint shipped
 * broken: TypeScript interpreted the `\u` escapes and `drizzle-kit` wrote the resulting
 * RAW CONTROL CHARACTERS into the migration file, producing a constraint no reviewer
 * could read and a `.sql` file carrying a literal DEL byte. Caught by reading the
 * generated SQL, which is the artifact under review.
 *
 * `U&'...'` is PostgreSQL's Unicode string literal syntax, so the escapes are resolved
 * by the SERVER from text that stays ASCII all the way through the file.
 *
 * NUL is deliberately absent: PostgreSQL `text` cannot hold one at all, so a term for it
 * would be a check against a value the type system already refuses.
 */
const CONTROL_CHARACTER_CLASS = String.raw`U&'[\0001-\001f\007f\0085\2028\2029]'`;

export const productCategories = pgTable(
  'product_categories',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    name: text('name').notNull(),
    description: text('description'),
    /** Optional. Absence is ordinary, never an error. */
    emoji: text('emoji'),
    status: text('status').notNull().default('ACTIVE'),
    visibility: text('visibility').notNull().default('VISIBLE'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    /**
     * The customer's order, and it matches the ORDER BY exactly.
     *
     * `(tenant, sort_order, id)` rather than `(tenant, sort_order, created_at, id)`,
     * because the owner specified `sort_order ASC, id ASC` for the paged customer
     * surfaces and an index whose columns are a superset still leaves the planner
     * sorting on `id` within each `sort_order` group. Added by 0098 for that reason;
     * 0097 shipped the four-column shape, which was right for the ordering assumed
     * before the paging decision and wrong for the one specified after it.
     */
    index('product_categories_tenant_sort_id_idx').on(table.tenantId, table.sortOrder, table.id),
    /** The admin list's keyset, on the IMMUTABLE pair. Migration 0026's lesson. */
    index('product_categories_tenant_created_idx').on(table.tenantId, table.createdAt, table.id),
    check('product_categories_status_check', enumCheck('status', PRODUCT_CATEGORY_STATUSES)),
    check(
      'product_categories_visibility_check',
      enumCheck('visibility', PRODUCT_CATEGORY_VISIBILITIES),
    ),
    check(
      'product_categories_name_check',
      sql`length(name) > 0 AND length(name) <= ${sql.raw(String(PRODUCT_CATEGORY_NAME_MAX_LENGTH))}`,
    ),
    /*
     * The emoji's shape, at the database.
     *
     * Bounded in CHARACTERS, which is what PostgreSQL's `length()` counts for `text` —
     * code points, not UTF-16 units — so this is the same measure
     * `isValidCategoryEmoji` uses and the two cannot disagree about a family emoji.
     *
     * The control-character term is the one that matters for a surface: this value is
     * rendered into a Telegram inline-keyboard label, and a newline there is a broken
     * button. `~` with a character class is refused rather than accepted, so a row
     * carrying one cannot be written at all.
     */
    check(
      'product_categories_emoji_check',
      sql`emoji IS NULL OR (
        length(emoji) > 0
        AND length(emoji) <= ${sql.raw(String(PRODUCT_CATEGORY_EMOJI_MAX_CODE_POINTS))}
        AND btrim(emoji) <> ''
        AND emoji !~ ${sql.raw(CONTROL_CHARACTER_CLASS)}
      )`,
    ),
    check(
      'product_categories_sort_check',
      sql`sort_order >= ${sql.raw(String(PRODUCT_SORT_MIN))} AND sort_order <= ${sql.raw(String(PRODUCT_SORT_MAX))}`,
    ),
    /** What a composite foreign key from `products` needs to point at. */
    unique('product_categories_tenant_id_key').on(table.tenantId, table.id),
  ],
);

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
    /**
     * The category a customer browses this product under.
     *
     * NULLABLE at the database, and that is not the same as "optional to the product".
     * Migration 0097 creates one category per tenant that has products and backfills
     * every row, so no product reaches a customer uncategorised. The column stays
     * nullable for two reasons: a NOT NULL on this table is a rewrite-and-lock during a
     * rolling update, and the release still running during that update writes products
     * without the column at all — expand only.
     *
     * The foreign key is `ON DELETE NO ACTION`, deliberately, and that is what makes
     * "a category holding products cannot be deleted" true at the DATABASE rather than
     * only in a service. `SET NULL` was considered and is worse: it would let the
     * delete succeed and silently strand every product in it uncategorised, which is
     * the shape where an operator's tidy-up empties a shop.
     *
     * The application refuses to sell a product with no category. The database's job
     * here is to stop the pointer being wrong, not to decide the sale.
     */
    categoryId: uuid('category_id'),
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
    /**
     * The pair again, for the same reason `products_tenant_panel_fk` is a pair: a
     * single-column reference would let a product name ANOTHER TENANT'S category, and
     * every reader downstream — the catalogue's grouping, the order snapshot — would
     * have believed it. MATCH SIMPLE means a NULL `category_id` is still legal.
     */
    foreignKey({
      columns: [table.tenantId, table.categoryId],
      foreignColumns: [productCategories.tenantId, productCategories.id],
      name: 'products_tenant_category_fk',
    }),
    /**
     * The customer's page within one category, matching `sort_order ASC, id ASC`.
     *
     * Every predicate the paged query applies is either in this index's leading
     * columns or cheap on the rows it returns — the point being that the LIMIT applies
     * to rows already filtered, never to rows a surface filters afterwards. §1.4 of
     * `docs/wp5-categories-audit.md` is the failure this shape exists to prevent.
     */
    index('products_tenant_category_sort_id_idx').on(
      table.tenantId,
      table.categoryId,
      table.sortOrder,
      table.id,
    ),
    unique('products_tenant_id_key').on(table.tenantId, table.id),
  ],
);

/**
 * A configured quantity a customer can buy for a service they already own.
 *
 * Not a product: a product is provisioned into a new account, and one of these is
 * applied to an account that exists. They share almost no columns for that reason —
 * there is no panel, no audience, no device limit and no description, because none of
 * them means anything about a quantity added to something already running.
 *
 * ## Why rows rather than a per-unit rate
 *
 * The legacy system prices these per unit, per panel, and takes a free-text quantity
 * (`TBR-009`, `PBR-009`). This bot has no FSM and no conversation state — the rule with
 * `INCIDENT-FIN-001` behind it, where the legacy prompt capture swallowed an ordinary
 * message and overwrote a production gateway setting — so there is nowhere for a typed
 * number to arrive, and a callback carries an intent and an identifier rather than a
 * quantity. The amounts a customer may buy therefore have to be rows they select.
 * `OQ-4F-05` records that as a deliberate divergence and what would have to exist for
 * the per-unit form to come back.
 *
 * ## The two amount columns are a union
 *
 * `kind` decides which one means anything, and `service_addons_amount_matches_kind`
 * makes the other one NULL rather than zero. Zero would be readable as
 * `UNLIMITED_TRAFFIC_BYTES`, which is what it means on a product, and an unlimited
 * amount is not a thing that can be ADDED to an allowance.
 */
export const serviceAddons = pgTable(
  'service_addons',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    status: text('status').notNull().default('INACTIVE'),
    sortOrder: integer('sort_order').notNull().default(0),
    /** Bytes added to the allowance. Set for `ADD_TRAFFIC`, NULL otherwise. */
    trafficBytes: bigint('traffic_bytes', { mode: 'bigint' }),
    /** Days added to the window. Set for `ADD_TIME`, NULL otherwise. */
    durationDays: integer('duration_days'),
    priceAmount: bigint('price_amount', { mode: 'bigint' }),
    priceCurrency: text('price_currency'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('service_addons_tenant_status_idx').on(table.tenantId, table.status),
    /** The operator's list, and its keyset: kind, then sort, then created, then id. */
    index('service_addons_tenant_sort_idx').on(
      table.tenantId,
      table.kind,
      table.sortOrder,
      table.createdAt,
      table.id,
    ),
    check('service_addons_kind_check', enumCheck('kind', SERVICE_ADDON_KINDS)),
    check('service_addons_status_check', enumCheck('status', SERVICE_ADDON_STATUSES)),
    check(
      'service_addons_price_currency_check',
      nullableEnumCheck('price_currency', CURRENCY_CODES),
    ),
    /** A price is an amount AND a currency, or it is absent. The products rule. */
    check(
      'service_addons_price_pair_check',
      sql`(price_amount IS NULL) = (price_currency IS NULL)`,
    ),
    check('service_addons_price_positive_check', sql`price_amount IS NULL OR price_amount > 0`),
    /**
     * The union, as a constraint rather than as application discipline.
     *
     * An `ADD_TRAFFIC` row whose bytes sit in `duration_days` would be sold for a
     * quantity of nothing, and the surface reading it would show a plausible price
     * beside an amount it could not find. Both halves are asserted — the field the kind
     * reads is positive, and the other is NULL — so neither a swap nor a stray write can
     * produce one.
     */
    check(
      'service_addons_amount_matches_kind',
      sql`(kind = 'ADD_TRAFFIC' AND traffic_bytes IS NOT NULL AND traffic_bytes > 0 AND duration_days IS NULL)
          OR (kind = 'ADD_TIME' AND duration_days IS NOT NULL AND duration_days > 0 AND traffic_bytes IS NULL)`,
    ),
    check(
      'service_addons_duration_bound_check',
      sql`duration_days IS NULL OR duration_days <= 3650`,
    ),
    unique('service_addons_tenant_id_key').on(table.tenantId, table.id),
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
    /**
     * What this order is FOR, and the column settlement dispatches on.
     *
     * `PaymentService.confirmAndSettle` used to end in an unconditional
     * `planForSettledOrder`, so every settled order wrote a service and a `PROVISION`.
     * A renewal is a NEW order against the SAME service — `services.order_id` says so —
     * and through that path it would have settled and then created a SECOND provider
     * account. `services_tenant_order_key` does not catch it: the index is unique on
     * `(tenant_id, order_id)` and a renewal has its own order id.
     *
     * The DEFAULT is what makes this expand-only. The release running beside this one
     * during a rolling update writes orders without the column and gets `NEW_SERVICE`,
     * which is exactly the behaviour it already had —
     * `migration-compatibility.test.ts` requires that and would fail a NOT NULL with no
     * default.
     *
     * WHICH service a commercial order acts on is not here. It is on
     * `service_commercial_actions`, one row per commercial order, declared after
     * `services` so that it can carry the CUSTOMER in both of its references — an order
     * that named service A while claiming customer B is the bypass
     * `orders_tenant_id_customer_key` describes, in the direction that puts a renewal
     * somebody paid for onto another account. A column here could not express that: it
     * would have to point back at a table that already points at this one, and a
     * composite foreign key cannot be written in either direction of a cycle.
     */
    purpose: text('purpose').notNull().default('NEW_SERVICE'),

    /** Navigation only. The snapshot below is the truth about this purchase. */
    productId: uuid('product_id').notNull(),
    panelId: uuid('panel_id').notNull(),
    lineTitle: text('line_title').notNull(),
    lineDurationDays: integer('line_duration_days').notNull(),
    lineTrafficBytes: bigint('line_traffic_bytes', { mode: 'bigint' }).notNull(),
    lineDeviceLimit: integer('line_device_limit'),
    lineUnitPriceAmount: bigint('line_unit_price_amount', { mode: 'bigint' }).notNull(),
    lineQuantity: integer('line_quantity').notNull().default(1),

    /*
     * The category this order was bought from, snapshotted — and NULLABLE, where every
     * other `line_*` column is NOT NULL.
     *
     * The nullability is the whole point and it is a decision, not a convenience. Orders
     * placed before categories existed have no category, and the owner's instruction is
     * that they must not be given one: a product's category TODAY is not evidence of
     * what a customer browsed months ago, so migration 0097 adds these columns and
     * backfills NOTHING. A null here means UNKNOWN, never "uncategorised".
     *
     * That is also why there is no `line_category_id` foreign key. The category may
     * since have been deleted — deletion is permitted for an EMPTY category — and a
     * reference would either block that deletion or cascade the order's history away.
     * The id is kept for navigation on the same terms as `product_id`: the name and
     * emoji beside it are the truth about the purchase.
     *
     * No CHECK ties the three together. A half-written snapshot is impossible because
     * one statement writes all three at confirmation, and a CHECK requiring
     * `(id IS NULL) = (name IS NULL)` would have to be satisfied by every pre-existing
     * row — which it is, all three being null — but would then forbid the only shape a
     * future reader might legitimately need: an id whose display text was redacted.
     */
    lineCategoryId: uuid('line_category_id'),
    /** The category's name as it read at confirmation. Null on a pre-WP5 order. */
    lineCategoryName: text('line_category_name'),
    /** Its emoji as it read at confirmation. Null when absent AND when unknown. */
    lineCategoryEmoji: text('line_category_emoji'),

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
    check('orders_purpose_check', enumCheck('purpose', ORDER_PURPOSES)),
    /**
     * What the line snapshot MEANS, per purpose, as a constraint rather than a comment.
     *
     * Zero is `UNLIMITED_TRAFFIC_BYTES` and `UNLIMITED_DURATION_DAYS` on a product
     * snapshot, and on a quantity purchase the same zero has to mean "no time was
     * bought" instead. That overload is a real trap for a reader, so the shape is
     * pinned: an `ADD_TRAFFIC` order carries positive bytes and zero days, an `ADD_TIME`
     * order the reverse, and neither can be written the other way round. `NEW_SERVICE`
     * and `RENEW` are unconstrained here — both carry a product specification, where
     * zero keeps its usual meaning.
     */
    check(
      'orders_quantity_line_check',
      sql`purpose NOT IN ('ADD_TRAFFIC', 'ADD_TIME')
          OR (purpose = 'ADD_TRAFFIC' AND line_traffic_bytes > 0 AND line_duration_days = 0)
          OR (purpose = 'ADD_TIME' AND line_duration_days > 0 AND line_traffic_bytes = 0)`,
    ),
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
    /*
     * Built from `ORDER_SETTLED_STATES`, not from a list typed out here.
     *
     * The contract's own predicate for "the money for this order arrived", so a
     * reconciliation query and this constraint cannot come to disagree about which
     * states that is — and a state added to one without the other fails the drift
     * check rather than quietly excluding revenue from a report.
     */
    check(
      'orders_settled_at_check',
      // Through `enumCheck`, which is the codebase's one `sql.raw` and the only
      // form that reaches the generated migration as LITERALS. A `sql` template
      // with parameters generates `state IN ($1, $2, $3)` into the DDL, which is
      // a constraint no database will ever evaluate the way it reads.
      sql`(${enumCheck('state', ORDER_SETTLED_STATES)}) = (settled_at IS NOT NULL)`,
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
    /**
     * When the payment ended WITHOUT money: rejected, withdrawn or expired.
     *
     * The mirror of `confirmed_at` and deliberately a SECOND column rather than a
     * reuse of it. `payments_confirmed_check` binds `confirmed_at` to CONFIRMED, so a
     * rejection written there could not commit — and a schema that made it commit
     * would be one where a query for "when did the money arrive" answers with the
     * moment somebody decided it never would.
     */
    resolvedAt: timestamptz('resolved_at'),
    /**
     * Which administrator resolved it, when a person did.
     *
     * Null for an expiry, because nobody decided that — a deadline did — and null for
     * a customer's own withdrawal. `payments_resolution_reviewer_check` holds the
     * narrower half of that: an admin id may appear only on a FAILED payment, which is
     * the only human-made resolution this release can produce.
     */
    resolvedByAdminId: uuid('resolved_by_admin_id').references(() => admins.id),
    /**
     * Why, in the operator's own words. Same rules as `evidence_note`: never the
     * customer's own message text and never a gateway response body.
     */
    resolutionNote: text('resolution_note'),
    /**
     * When the customer said they had sent the transfer. Their CLAIM, never evidence.
     *
     * `docs/phase4h-audit.md` §4 measured the gap: the bot hands out a reference and
     * bank details and the flow is then silent in both directions, so an operator
     * learns of a transfer from their bank rather than from the product.
     *
     * A separate column rather than a state, and that is the load-bearing decision.
     * `PAYMENT_STATES` classifies what this installation KNOWS about the money, and a
     * customer saying they paid is not knowledge — `PAYMENT_EVIDENCE_KINDS` stays
     * `OPERATOR_REVIEW` and confirmation is unchanged. A `SIGNALLED` state would put a
     * customer's assertion on the same axis as a reviewed one, which is the legacy
     * receipt review's defect (`PRBR-004`) with a new name.
     *
     * Stamped ONCE. The conditional UPDATE that writes it requires it to be null, so a
     * customer tapping twice does not move the moment they first claimed to have paid.
     */
    customerSignalledAt: timestamptz('customer_signalled_at'),
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
    /**
     * At most ONE open top-up per customer, and for the same reason as the index above.
     *
     * `requestWalletTopup` reads `findOpenTopup`, finds none, and inserts. Two callbacks
     * carrying DIFFERENT idempotency keys — a double tap, or two Telegram clients — both
     * read null inside their own transaction and both insert; the idempotency store has
     * nothing to replay because the keys differ. The customer then holds two live
     * references, each independently confirmable, and one bank transfer is credited
     * twice.
     *
     * The service takes a per-customer lock so the ordinary racing pair serialises and
     * neither sees an error. This is what holds when a lock is bypassed, forgotten, or
     * outlived by a new code path — and two api replicas is the normal case on every
     * rolling update, so the database is the only place both of them share.
     *
     * The predicate is `findOpenTopup`'s WHERE clause exactly. The two must stay in step.
     */
    uniqueIndex('payments_open_topup_key')
      .on(table.tenantId, table.customerId)
      .where(sql`state = 'PENDING' AND order_id IS NULL AND method = 'MANUAL_TRANSFER'`),
    /** The reconciliation queue: payments whose outcome nobody knows. */
    index('payments_unknown_idx')
      .on(table.tenantId, table.createdAt)
      .where(sql`state = 'UNKNOWN'`),
    /**
     * The expiry sweep's own index, and the counterpart of `orders_expiry_idx`.
     *
     * That one has existed since 0032 with NO reader — a partial index is a statement
     * about a query somebody meant to write, and `docs/phase4g-audit.md` records that
     * nothing was ever written against it. This one arrives WITH its reader.
     *
     * Leading with `tenant_id` where the orders index does not, because this sweep is
     * tenant-scoped like every other write path here and a scan ordered by deadline
     * across all tenants would be one tenant's backlog delaying another's.
     */
    index('payments_pending_expiry_idx')
      .on(table.tenantId, table.expiresAt)
      .where(sql`state = 'PENDING'`),
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
    /**
     * A payment that ended without money has a time. The mirror of the check above.
     *
     * Both halves, as an equality rather than an implication, for the reason that one
     * gives: an implication lets a CONFIRMED payment also carry a resolution time, and
     * then "was this rejected" is answered by two columns that can disagree.
     *
     * The state list is `PAYMENT_RESOLVED_STATES` rendered by the same helper every
     * other status check here uses, so adding a state to the contract and forgetting
     * this constraint is a drift the generator catches rather than a silent hole.
     */
    check(
      'payments_resolved_check',
      sql`(state IN (${sql.join(
        PAYMENT_RESOLVED_STATES.map((state) => sql.raw(`'${state}'`)),
        sql`, `,
      )})) = (resolved_at IS NOT NULL)`,
    ),
    /**
     * An administrator may appear only on a rejection.
     *
     * `FAILED` is the only resolution a person makes in this release: an expiry is a
     * deadline and a cancellation is the customer's own. Writing an admin id onto
     * either would make "who decided this" answerable with somebody who did not, which
     * is the failure 0035 exists to prevent one state later.
     *
     * The release that adds a gateway keeps this constraint unchanged and relies on
     * its other half: a gateway-driven FAILED carries a null admin id, which is how the
     * two are told apart without a parallel enum.
     */
    check(
      'payments_resolution_reviewer_check',
      sql`resolved_by_admin_id IS NULL OR state = 'FAILED'`,
    ),
    /** A note about a resolution that did not happen is not evidence of anything. */
    check(
      'payments_resolution_note_check',
      sql`resolution_note IS NULL OR resolved_at IS NOT NULL`,
    ),
    /**
     * Only an out-of-band transfer can be claimed as sent.
     *
     * A wallet settlement commits its debit in the same transaction and a gateway is
     * reached over the wire; in neither case is there anything for a customer to assert
     * that this installation does not already know. The constraint says so where a
     * later surface cannot disagree with it.
     */
    check(
      'payments_customer_signal_check',
      sql`customer_signalled_at IS NULL OR method = 'MANUAL_TRANSFER'`,
    ),
    unique('payments_tenant_id_key').on(table.tenantId, table.id),
  ],
);

/**
 * Where a manual transfer goes: the tenant's configuration, mutable at any time.
 *
 * The FIRST of two tables, and the split is the whole design. This one an operator
 * edits; `payment_destinations` is the frozen copy a customer was actually shown. Until
 * Phase 5 there was neither, and the only place a card number could live was inside an
 * overridden template body — so editing it rewrote what every already-issued instruction
 * said, and `docs/phase5-audit.md` §1 measures the rest of what that cost.
 *
 * There is no `deleted_at` and no delete path. `customers` states the rule this follows —
 * a block is not a deletion — and it holds harder here: `payment_destinations.account_id`
 * names the row a payment was issued against, and a deleted account is a payment whose
 * provenance is a dangling id. Disable and edit cover every reason an operator reaches
 * for delete.
 *
 * The card number is NOT a credential and is deliberately not stored like one. This
 * installation PUBLISHES it, to every customer who chooses to pay out of band; an
 * encrypted column would mean an operator could not read back what they had configured,
 * which is the write-only settings defect `docs/conventions.md` names.
 */
export const paymentAccounts = pgTable(
  'payment_accounts',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** Operator-facing. Never rendered to a customer; it names the account. */
    label: text('label').notNull(),
    bankName: text('bank_name').notNull(),
    holderName: text('holder_name').notNull(),
    /** Sixteen ASCII digits, normalised and Luhn-checked at the trust boundary. */
    cardNumber: text('card_number').notNull(),
    /** `IR` and twenty-four digits, or NULL. The one field a destination may lack. */
    iban: text('iban'),
    enabled: boolean('enabled').notNull().default(true),
    /**
     * Which account a new payment is issued against.
     *
     * A boolean with a PARTIAL UNIQUE INDEX rather than a `default_account_id` column on
     * the tenant, and the reason is the one the panels module learned: a pointer from
     * the parent can name a row that has since been disabled, and nothing in the schema
     * notices. Here the two rules that matter are both constraints —
     * at most one per tenant, and a default is always enabled.
     */
    isDefault: boolean('is_default').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    /** The operator's list, in the order it is rendered: sort, then created, then id. */
    index('payment_accounts_tenant_sort_idx').on(
      table.tenantId,
      table.sortOrder,
      table.createdAt,
      table.id,
    ),
    /**
     * ONE default per tenant, decided by the database.
     *
     * Two operators promoting different accounts at the same moment both read "this one
     * is not the default yet". A service-level check answers both of them yes; this
     * index answers one of them with a unique violation, which the service turns into a
     * conflict the operator can act on.
     */
    uniqueIndex('payment_accounts_tenant_default_key')
      .on(table.tenantId)
      .where(sql`is_default`),
    /**
     * One ENABLED account per card number.
     *
     * Scoped to enabled rows, because re-adding a card that was disabled last month is
     * ordinary. Two LIVE accounts for one card are not: they then differ only in a label
     * or a holder name, and nothing decides which a customer is shown.
     */
    uniqueIndex('payment_accounts_tenant_card_key')
      .on(table.tenantId, table.cardNumber)
      .where(sql`enabled`),
    /**
     * A default is enabled. The other half of "a disabled account cannot be selected".
     *
     * Without it the rule is defeated from the far end: disable the default, and the row
     * a new payment is issued against is one the operator said to stop using.
     */
    check('payment_accounts_default_enabled_check', sql`NOT is_default OR enabled`),
    /*
     * The same structural checks the contract applies, restated where a hand-written
     * UPDATE cannot skip them. Not duplication for its own sake: `paymentAccountInputSchema`
     * guards the HTTP boundary and these guard the table, and a repair script run at 3am
     * only meets the second.
     *
     * SHAPE only, and the check digits are NOT here: `nexa_luhn_ok` and `nexa_iban_ir_ok`
     * are functions, drizzle-kit models neither them nor a CHECK that calls one, so
     * `payment_accounts_card_luhn_check` and `payment_accounts_iban_mod97_check` live in
     * migration 0065 and are invisible to the drift check by construction. They exist
     * because these two were the whole of the table's defence and a sixteen-digit string
     * with a wrong Luhn digit satisfied them — the Codex review of PR #34.
     */
    check('payment_accounts_card_number_check', sql`card_number ~ '^[0-9]{16}$'`),
    check('payment_accounts_iban_check', sql`iban IS NULL OR iban ~ '^IR[0-9]{24}$'`),
    check('payment_accounts_label_check', sql`length(btrim(label)) BETWEEN 1 AND 80`),
    check('payment_accounts_bank_name_check', sql`length(btrim(bank_name)) BETWEEN 1 AND 80`),
    check('payment_accounts_holder_name_check', sql`length(btrim(holder_name)) BETWEEN 1 AND 120`),
    check('payment_accounts_sort_order_check', sql`sort_order BETWEEN 0 AND 100000`),
    unique('payment_accounts_tenant_id_key').on(table.tenantId, table.id),
  ],
);

/**
 * The payment ROUTES a tenant offers, one row per route it has configured.
 *
 * ## The key is the route, and there is no id
 *
 * `(tenant_id, provider)` IS the primary key. That is the legacy roster's own shape —
 * `WEB-BR-012` counts a fixed eleven with no Add Gateway — expressed as a constraint
 * rather than as a unique index bolted onto a surrogate key, and it buys two things a
 * uuid would not. A surface addresses a route with a value from a CLOSED enum, so a
 * crafted identifier fails at the schema instead of reaching a query that has to
 * remember its tenant filter. And the audit row's `entity_id` is the provider name, so
 * "who switched card-to-card off, and when" reads as that.
 *
 * ## What is NOT here
 *
 * No credential column, no cashback percent, no button colour, and no currency.
 * `packages/contracts/src/payment-gateways.ts` carries the reason for each; the short
 * form is that the first has no route that needs it, the next two have nothing that
 * would honour them, and the fourth would be a second denomination with no conversion
 * to reach it. A column added here later has to arrive with the thing that reads it.
 */
export const paymentGateways = pgTable(
  'payment_gateways',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** From `PAYMENT_GATEWAY_PROVIDERS`. Code, not data — the row cannot invent one. */
    provider: text('provider').notNull(),
    status: text('status').notNull(),
    /**
     * The label the route is chosen by, or NULL for the product's own name.
     *
     * Nullable so that a route can exist before an operator has typed anything — the
     * upgrade that gives a tenant its manual route writes no copy, because a Persian
     * label in a SQL file is a customer-facing string in the one place the template
     * rule cannot reach it.
     */
    displayName: text('display_name'),
    /** The route's own tutorial, stored RAW. NULL means the route adds nothing. */
    instructions: text('instructions'),
    /**
     * The bounds, in minor units, with `0` meaning unbounded on that side.
     *
     * `bigint` with `mode: 'bigint'`, never a float and never a `number`: `pg` hands
     * back `int8` as a string and the parser this codebase installs turns it into a
     * `bigint`, which is what keeps an amount above 2^53 exact.
     *
     * The companion `currency` column is `bounds_currency` below — added by 0077 after
     * the payment batch's review, and a correction to what this comment used to say.
     * The bounds were stored bare and relabelled with whatever `sales.currency` was at
     * COMPARISON time, so an operator switching the installation from IRT to IRR made
     * every route's `1000000` silently mean a tenth of what it had, with nobody editing
     * a bound. Storing the denomination the bounds were WRITTEN in is what lets the
     * comparison fail closed on a mismatch — the case `PaymentGatewayService` always
     * named and could never reach.
     */
    minAmountMinor: bigint('min_amount_minor', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    maxAmountMinor: bigint('max_amount_minor', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    /**
     * The denomination the two bounds were written in — the installation's
     * `sales.currency` at the moment an operator saved them, or at the moment the zero
     * row was provisioned. Compared against the amount's currency in `offer`, and a
     * disagreement refuses the route until an operator re-saves it under the new
     * currency, rather than reinterpreting the numbers. Backfilled by 0078 from each
     * tenant's setting.
     *
     * Nullable THIS release, on purpose: the previous release still writes this table
     * without the column, for the length of a rolling update, and `SET NOT NULL` would
     * refuse those writes — `migration-compatibility.test.ts` states the rule. A NULL
     * therefore means "written by the previous release", and the readers fall back to
     * the installation's current currency for it, which is exactly the relabelling
     * that release performed. The contract step — a second backfill and NOT NULL — is
     * the release after this one; `docs/open-questions.md` OQ-5H-05 carries it.
     */
    boundsCurrency: text('bounds_currency'),
    /**
     * The three eligibility thresholds, where `0` is the condition switched OFF.
     *
     * `WEB-BR-014` reads that semantics off the legacy form's own instruction text, so
     * it is evidenced rather than chosen — and it is why these are plain integers
     * rather than nullable ones. A nullable column would give "off" two spellings, and
     * the one a migration wrote would be the one nothing tested.
     */
    activateAfterPayments: integer('activate_after_payments').notNull().default(0),
    deactivateAfterPayments: integer('deactivate_after_payments').notNull().default(0),
    activateAfterAccountDays: integer('activate_after_account_days').notNull().default(0),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'payment_gateways_pk',
      columns: [table.tenantId, table.provider],
    }),
    /** The operator's list and the customer's, in the order both render: sort, provider. */
    index('payment_gateways_tenant_sort_idx').on(table.tenantId, table.sortOrder, table.provider),
    check('payment_gateways_provider_check', enumCheck('provider', PAYMENT_GATEWAY_PROVIDERS)),
    check('payment_gateways_status_check', enumCheck('status', PAYMENT_GATEWAY_STATUSES)),
    check(
      'payment_gateways_bounds_currency_check',
      nullableEnumCheck('bounds_currency', CURRENCY_CODES),
    ),
    /*
     * The same structural rules the contract applies, restated where a hand-written
     * UPDATE cannot skip them — the argument `payment_accounts` states: the schema
     * guards the HTTP boundary and these guard the table, and a repair script run at
     * 3am only meets the second.
     *
     * The window check is the one worth reading twice. A maximum below the minimum
     * yields a route that is configured, switched on, and impossible to pay through,
     * and it says so nowhere an operator would look. `FBR-008` could not establish what
     * a legacy installation does when limits conflict, so this refuses the state rather
     * than resolving it.
     */
    check(
      'payment_gateways_amount_window_check',
      sql`max_amount_minor = 0 OR max_amount_minor >= min_amount_minor`,
    ),
    check('payment_gateways_min_amount_check', sql`min_amount_minor >= 0`),
    check('payment_gateways_max_amount_check', sql`max_amount_minor >= 0`),
    /*
     * And the same for the payment-count pair. Crossed bounds are a route no customer
     * is ever eligible for; `0` on either side is the condition off, which is why the
     * check is written to admit a zero rather than to compare unconditionally.
     */
    check(
      'payment_gateways_payment_window_check',
      sql`activate_after_payments = 0
          OR deactivate_after_payments = 0
          OR deactivate_after_payments > activate_after_payments`,
    ),
    check(
      'payment_gateways_thresholds_check',
      sql`activate_after_payments BETWEEN 0 AND 100000
          AND deactivate_after_payments BETWEEN 0 AND 100000
          AND activate_after_account_days BETWEEN 0 AND 100000`,
    ),
    check(
      'payment_gateways_display_name_check',
      sql`display_name IS NULL OR length(btrim(display_name)) BETWEEN 1 AND 60`,
    ),
    check(
      'payment_gateways_instructions_check',
      sql`instructions IS NULL OR length(instructions) BETWEEN 1 AND 1000`,
    ),
    check('payment_gateways_sort_order_check', sql`sort_order BETWEEN 0 AND 100000`),
  ],
);

/**
 * Money going back, as a row with a lifecycle.
 *
 * ## Why this is a table and not a column on `payments`
 *
 * A payment can be refunded MORE THAN ONCE — partially, by different operators, at
 * different times — so "was this refunded" is a sum rather than a flag. A boolean would
 * answer it wrongly the first time somebody refunds half.
 *
 * ## The refundable balance is derived, never stored
 *
 * There is no `refunded_amount` column on `payments`, deliberately, and it is the same
 * rule `CLAUDE.md` states about a wallet balance: the amount consumed is
 * `SUM(amount) WHERE state IN REFUND_CONSUMING_STATES`, computed inside the transaction
 * that needs it. A cached total is a second place for the truth to live, and the legacy
 * system's mutable balance column is the failure that rule exists to prevent.
 *
 * ## What the append-only guard allows and forbids
 *
 * A refund's state DOES change — that is its whole life — so this table is not
 * `payment_receipts`, which forbids UPDATE outright. `nexa_refunds_guard` freezes
 * everything that says WHAT was refunded (the payment, the customer, the amount, the
 * currency, the channel, the requester) and lets the lifecycle columns move. A refund
 * whose amount could be edited after the fact is a reviewer's evidence changing
 * underneath the decision made on it.
 */
export const refunds = pgTable(
  'refunds',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** The CONFIRMED payment this reverses. A refund with no payment has nothing to bound it. */
    paymentId: uuid('payment_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    /** Copied from the payment, so a refund report needs no join to say what was bought. */
    orderId: uuid('order_id'),
    state: text('state').notNull().default('REQUESTED'),
    /** Derived from the payment's method by `REFUND_METHOD_SUPPORT`, never operator-chosen. */
    channel: text('channel').notNull(),
    /**
     * Minor units, positive, with its currency beside it.
     *
     * The currency is STORED rather than joined from the payment, and that is the
     * money-convention rule rather than denormalisation for speed: `CLAUDE.md` says
     * never an amount without a currency, and a refund row that had to reach for one
     * could be read in isolation and misunderstood.
     */
    amount: bigint('amount', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),
    /** The operator's own words. Required — a refund with no reason is unreviewable. */
    reason: text('reason').notNull(),
    /** Who decided. Null only for a refund no administrator requested, which nothing produces. */
    requestedByAdminId: uuid('requested_by_admin_id'),
    /**
     * Who recorded that the money actually left, and when.
     *
     * For the manual channel these two are the ONLY evidence the transfer happened, and
     * they are why `AWAITING_EXTERNAL` exists: this installation has no bank API, so a
     * person is the mechanism and their name and the time are the record of it.
     */
    completedByAdminId: uuid('completed_by_admin_id'),
    completedAt: timestamptz('completed_at'),
    /** The bank reference, when there is one. A cash refund across a counter has none. */
    externalReference: text('external_reference'),
    /** What the completing operator wrote, or why a refund was abandoned. */
    completionNote: text('completion_note'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    /** The payment's refund history, and the SUM the refundable balance is derived from. */
    index('refunds_tenant_payment_idx').on(table.tenantId, table.paymentId, table.createdAt),
    /** A customer's refunds, for the account view. */
    index('refunds_tenant_customer_idx').on(table.tenantId, table.customerId, table.createdAt),
    check('refunds_state_check', enumCheck('state', REFUND_STATES)),
    check('refunds_channel_check', enumCheck('channel', REFUND_CHANNELS)),
    check('refunds_currency_check', enumCheck('currency', CURRENCY_CODES)),
    /**
     * A refund is for a POSITIVE amount. Zero is not a refund and negative is a charge.
     *
     * `refundFitsWithin` refuses both at the boundary; this is the same rule where a
     * hand-written UPDATE meets it, which is the argument `payment_accounts` makes about
     * a repair script run at 3am.
     */
    check('refunds_amount_check', sql`amount > 0`),
    check('refunds_reason_check', sql`length(btrim(reason)) BETWEEN 3 AND 500`),
    check(
      'refunds_external_reference_check',
      sql`external_reference IS NULL OR length(btrim(external_reference)) BETWEEN 1 AND 140`,
    ),
    /**
     * COMPLETED means completed AT a time. Always.
     *
     * The rule `payments_confirmed_check` states for a confirmation, applied to the one
     * transition that means money is gone: a row cannot claim COMPLETED with no
     * timestamp, which is the "money marked returned because a refund was requested"
     * defect this whole lifecycle exists to prevent.
     */
    check('refunds_completed_check', sql`(state = 'COMPLETED') = (completed_at IS NOT NULL)`),
    /**
     * And BY somebody, when somebody asked for it.
     *
     * Split from the check above, because the two halves stopped being one rule.
     * A refund an OPERATOR requested is completed by an operator, and naming them is
     * the whole audit value — that half is unchanged and is enforced here.
     *
     * An AUTOMATIC refund has no operator on either side. Nobody requested it: a
     * settlement or a provisioner discovered that what a customer paid for cannot be
     * delivered, and the money went back in that transaction.
     * `requested_by_admin_id IS NULL` is what identifies one, and it cannot be an
     * operator's refund with the field forgotten — `RefundService.request` is guarded
     * by `refunds.issue`, which `SYSTEM_JOB_PERMISSIONS` does not carry, so every
     * operator refund has an administrator behind it by construction.
     *
     * Writing an admin id into an automatic refund to satisfy the old single check
     * was the alternative, and it is the one this codebase forbids outright: a
     * fabricated actor on a money record, attributing a decision to whoever happened
     * to press approve on an unrelated transfer.
     */
    check(
      'refunds_operator_completion_check',
      sql`(state = 'COMPLETED' AND requested_by_admin_id IS NOT NULL) = (completed_by_admin_id IS NOT NULL)`,
    ),
    foreignKey({
      name: 'refunds_payment_fk',
      columns: [table.tenantId, table.paymentId],
      foreignColumns: [payments.tenantId, payments.id],
    }),
    unique('refunds_tenant_id_key').on(table.tenantId, table.id),
  ],
);

/**
 * The window in which a photo from this customer attaches to a payment.
 *
 * A ROW rather than a column on `payments`, and that is the load-bearing choice: a
 * customer may hold several pending payments, so "which payment does this image belong
 * to" has to be answerable from the CUSTOMER — which is what an inbound Telegram photo
 * identifies — rather than from a payment somebody guessed.
 *
 * ## Why this is not the prompt capture that destroyed a production setting
 *
 * `INCIDENT-FIN-001` records an ADMIN prompt that swallowed a typed navigation string
 * and overwrote a gateway's tutorial text, and earlier directives forbade conversational
 * prompt capture in its general form. They still do. Four properties make this narrower,
 * and all four are in the schema rather than in a docstring:
 *
 * 1. it names ONE payment, stored here, so there is no "current prompt" a later message
 *    can land in;
 * 2. it can attach a PHOTO or a DOCUMENT and nothing else — the routing never consults
 *    it for a text message, so `/start`, the menu labels and every other typed thing
 *    route exactly as they do today;
 * 3. it is customer-side: the only thing it can write is a `payment_receipts` row;
 * 4. it EXPIRES, and `receipt_captures_expiry_check` refuses a window that outlives its
 *    own opening.
 *
 * One open window per customer per bot is a partial unique index, not a service rule.
 * Opening a second closes the first as SUPERSEDED in the same transaction.
 */
export const receiptCaptures = pgTable(
  'receipt_captures',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /**
     * WHICH bot the customer is talking to.
     *
     * A tenant may run a public bot and a reseller bot, and a window opened in one must
     * not be filled by a photo sent to the other: the customer is a different chat there
     * and the file id belongs to a different bot.
     */
    botInstanceId: uuid('bot_instance_id')
      .notNull()
      .references(() => botInstances.id),
    customerId: uuid('customer_id').notNull(),
    paymentId: uuid('payment_id').notNull(),
    openedAt: timestamptz('opened_at').notNull().defaultNow(),
    expiresAt: timestamptz('expires_at').notNull(),
    /** Null while open. The partial unique index below is keyed on exactly this. */
    closedAt: timestamptz('closed_at'),
    closeReason: text('close_reason'),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'receipt_captures_customer_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.paymentId],
      foreignColumns: [payments.tenantId, payments.id],
      name: 'receipt_captures_payment_fk',
    }),
    /**
     * ONE open window per customer per bot, decided by the database.
     *
     * Two taps on two different invoices arriving together both read "nothing open". A
     * service check answers both yes and the second photo attaches to whichever row the
     * planner returns first, which is a receipt filed against a payment the customer was
     * not looking at.
     */
    uniqueIndex('receipt_captures_open_key')
      .on(table.tenantId, table.botInstanceId, table.customerId)
      .where(sql`closed_at IS NULL`),
    /** The sweep's index: windows past their deadline that nobody has closed. */
    index('receipt_captures_due_idx')
      .on(table.tenantId, table.expiresAt)
      .where(sql`closed_at IS NULL`),
    check(
      'receipt_captures_close_reason_check',
      nullableEnumCheck('close_reason', RECEIPT_CAPTURE_CLOSE_REASONS),
    ),
    /** A closed window has a reason, and an open one has neither. Both halves. */
    check('receipt_captures_closed_check', sql`(closed_at IS NULL) = (close_reason IS NULL)`),
    check('receipt_captures_expiry_check', sql`expires_at > opened_at`),
    unique('receipt_captures_tenant_id_key').on(table.tenantId, table.id),
  ],
);

/**
 * One receipt a customer sent, bound to exactly one payment.
 *
 * The BINDING lives here; the bytes live at Telegram. This installation stores the two
 * identifiers Telegram gives it — `file_id`, which `getFile` takes and which is scoped to
 * one bot, and `file_unique_id`, which is stable and is what the dedupe is keyed on — and
 * the Web Admin fetches the image through the API, which holds the bot token.
 *
 * That is a real limitation written down rather than discovered: a backup carries this
 * row and not the image, and a revoked bot token makes an old file unfetchable. The
 * alternative is a blob store this deployment does not have.
 *
 * Append-only by trigger. A receipt is evidence somebody will look at when deciding
 * whether money arrived, and evidence that can be edited afterwards is the legacy
 * `/admin/logs` with a picture attached.
 */
export const paymentReceipts = pgTable(
  'payment_receipts',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    botInstanceId: uuid('bot_instance_id')
      .notNull()
      .references(() => botInstances.id),
    customerId: uuid('customer_id').notNull(),
    paymentId: uuid('payment_id').notNull(),
    kind: text('kind').notNull(),
    /** What `getFile` takes. Bot-scoped, and never returned to a browser. */
    fileId: text('file_id').notNull(),
    /** Stable across re-sends of the same file, and the dedupe key. */
    fileUniqueId: text('file_unique_id').notNull(),
    mimeType: text('mime_type'),
    fileSize: bigint('file_size', { mode: 'bigint' }),
    fileName: text('file_name'),
    /** Which message carried it, so an operator can find it in the chat if they must. */
    telegramMessageId: bigint('telegram_message_id', { mode: 'bigint' }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'payment_receipts_customer_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.paymentId],
      foreignColumns: [payments.tenantId, payments.id],
      name: 'payment_receipts_payment_fk',
    }),
    /**
     * The SAME file attaches once.
     *
     * Telegram redelivers an update whose reply this installation did not acknowledge in
     * time, and a customer who taps forward twice sends the same file twice.
     * `file_unique_id` is stable across both, so this is what makes an upload
     * effectively-once without a second idempotency mechanism.
     */
    uniqueIndex('payment_receipts_file_key').on(
      table.tenantId,
      table.paymentId,
      table.fileUniqueId,
    ),
    /** The reviewer's read: everything filed against one payment, oldest first. */
    index('payment_receipts_payment_idx').on(table.tenantId, table.paymentId, table.createdAt),
    check('payment_receipts_kind_check', enumCheck('kind', PAYMENT_RECEIPT_KINDS)),
    check('payment_receipts_size_check', sql`file_size IS NULL OR file_size > 0`),
    unique('payment_receipts_tenant_id_key').on(table.tenantId, table.id),
  ],
);

/**
 * What ONE customer was told, frozen at the moment the payment was issued.
 *
 * A separate table rather than columns on `payments`, and not by taste. A CHECK binding a
 * destination to `method = 'MANUAL_TRANSFER'` would have to be an IMPLICATION rather than
 * an equality, because every manual-transfer payment issued before this migration has no
 * destination — and an implication is exactly the "two columns that can disagree" shape
 * `payments_confirmed_check` exists to refuse. Here the absence is the absence of a row.
 *
 * Append-only by trigger, like `audit_logs` (see the migration). A destination that could
 * be edited after issuance is the defect this whole subphase removes, reintroduced one
 * layer down.
 *
 * `account_id` is provenance and nothing else. Every field a customer needs is COPIED
 * here, so the rendering never joins back to a row an operator may since have changed.
 */
export const paymentDestinations = pgTable(
  'payment_destinations',
  {
    /** One destination per payment. The payment IS the identity. */
    paymentId: uuid('payment_id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** Which account this was taken from. Never read to render; read to reconcile. */
    accountId: uuid('account_id').notNull(),
    label: text('label').notNull(),
    bankName: text('bank_name').notNull(),
    holderName: text('holder_name').notNull(),
    cardNumber: text('card_number').notNull(),
    iban: text('iban'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    /*
     * The payment travels WITH its tenant, and so does the account.
     *
     * Two composite foreign keys rather than two plain ones, for the reason
     * `payments_order_fk` gives: without the tenant column in the key, a destination row
     * could name one tenant's payment and another tenant's account, and the render would
     * print a card number belonging to somebody else's installation.
     */
    foreignKey({
      columns: [table.tenantId, table.paymentId],
      foreignColumns: [payments.tenantId, payments.id],
      name: 'payment_destinations_payment_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.accountId],
      foreignColumns: [paymentAccounts.tenantId, paymentAccounts.id],
      name: 'payment_destinations_account_fk',
    }),
    /** The operator's question: which payments were issued against this account? */
    index('payment_destinations_account_idx').on(table.tenantId, table.accountId),
    check('payment_destinations_card_number_check', sql`card_number ~ '^[0-9]{16}$'`),
    check('payment_destinations_iban_check', sql`iban IS NULL OR iban ~ '^IR[0-9]{24}$'`),
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
    /**
     * A top-up credit names the payment that funded it.
     *
     * `TOPUP_RECEIPT` is the ledger's answer to "where did this money come from", and
     * without the payment it answers "a transfer, some time, decided by somebody". The
     * column has existed since 4C; this is what makes it required for the one reason
     * whose whole meaning is the payment.
     */
    check(
      'wallet_entries_topup_payment_check',
      sql`reason <> 'TOPUP_RECEIPT' OR payment_id IS NOT NULL`,
    ),
    /**
     * ONE top-up credit per payment, decided by the database.
     *
     * The rule 5B rests on, and it is keyed on the PAYMENT rather than on the
     * confirming command: two operators pressing approve together, a redelivered
     * request, a retry after a crash between the confirm and the append — and a future
     * gateway callback funding the same top-up — all name the same payment, so all but
     * one of them conflict here. The derived reference in `WalletTopupService` produces
     * the same guarantee from the other direction; this is the one a convenience
     * refactor cannot remove by accident.
     */
    uniqueIndex('wallet_entries_topup_payment_key')
      .on(table.tenantId, table.paymentId)
      .where(sql`reason = 'TOPUP_RECEIPT'`),
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
 * `provider_username` is the name the ORDER reserved — chosen or drawn under
 * `service-username.ts` and frozen before the money moved — and is unique per PANEL,
 * which is the constraint that makes adoption after an unknown outcome safe: a
 * reconcile asks the panel for the name THIS ROW carries, and the index guarantees at
 * most one service claims it. It used to be derived from the service id, which cannot
 * work once a name has to exist before the service does.
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
    /** The order's reserved name, frozen before payment. Unique per panel, for adoption. */
    providerUsername: text('provider_username').notNull(),
    /**
     * The `subId` the panel serves this customer's configuration under. A CAPABILITY.
     *
     * Random, 128 bits, chosen HERE and written in the settling transaction. The
     * username beside it is stored in the same transaction but is a different kind of
     * thing, and the distinction is the whole reason this column exists: the username
     * appears in an operator's client list and may be a name the customer picked, while
     * anybody holding this value can fetch the customer's configuration from
     * `https://<subscription domain>/sub/<this>` with no authentication at all.
     *
     * It was derived, through an unkeyed SHA-256 of the service id — and the service id
     * travels in `operational_events.context`, in `audit_logs.entity_id` and in
     * `outbox_messages.aggregate_id`, none of which are places for a credential. Worse,
     * the username was then a reversible encoding of the id rather than a hash, so
     * reading a name off a panel screen recovered the id and therefore the link. The
     * docblocks claimed the opposite in both directions.
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
    /**
     * A provisioned service has a time; one that never was does not — and a
     * TERMINATED one may be either.
     *
     * The equality without that third clause is a rule `SERVICE_MACHINE`
     * contradicts. The machine has `PENDING_PROVISION -> TERMINATED` and
     * `UNRECONCILED -> TERMINATED`, and `OPERATION_LEGAL_FROM.TERMINATE` names both
     * states deliberately — "a service an operator or a customer has decided to end
     * must be endable whatever went wrong on the way, including one stuck in
     * `UNRECONCILED` after a lost create". Both of those states have a null
     * `provisioned_at` by this very check, so taking either edge moved the state to
     * one side of the equality and left the timestamp on the other, and the UPDATE
     * raised.
     *
     * Nothing had taken those edges. The automatic refund is the first caller: a
     * create that definitively failed leaves a `PENDING_PROVISION` row occupying a
     * capacity slot, and terminating it is how the panel gets the slot back. The
     * suite found this on the first full run, which is the argument for running it.
     *
     * The clause is a carve-out for TERMINATED rather than a loosening of the whole
     * rule: for every state a service can be USED in, the equality still holds, and
     * `services_terminated_at_check` still forces `terminated_at`. What a terminated
     * service's null `provisioned_at` now says is true and worth saying — this one
     * never reached a panel.
     */
    check(
      'services_provisioned_at_check',
      sql`state = 'TERMINATED'
          OR (state = 'PENDING_PROVISION' OR state = 'UNRECONCILED') = (provisioned_at IS NULL)`,
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
    /**
     * Redundant against the primary key, and the target of a CUSTOMER-bearing
     * composite reference — exactly as `orders_tenant_id_customer_key` is.
     *
     * `service_commercial_actions` names a service and a customer, and a two-column
     * `(tenant_id, service_id)` reference would let the pair disagree: a renewal one
     * customer paid for, recorded against another customer's account. The three-column
     * form makes that unrepresentable rather than merely unlikely, and it needs this
     * index to point at.
     */
    unique('services_tenant_id_customer_key').on(table.tenantId, table.id, table.customerId),
  ],
);

/**
 * One row per (service, reminder kind, period): "we told them this, about that period".
 *
 * A FACT, not a flag, and the distinction is what makes renewal work. The row records
 * the BASIS the reminder was raised against — both the deadline and the allowance the
 * service had at that moment — and the lane skips a service whose stored basis still
 * equals its current one. A RENEW moves `expires_at`, an ADD_TRAFFIC moves
 * `traffic_limit_bytes`, either makes the bases differ, and the reminder is due again.
 * Nothing is deleted to re-arm anything, which matters: deleting rows to make a reminder
 * fire again is how an audit trail loses the record of what a customer was actually
 * told. A row is written once and never updated: an occurrence keeps the id the
 * notification named it by.
 *
 * The two columns are read by DIFFERENT kinds. An expiry reminder compares the deadline
 * alone, so buying extra traffic does not re-send "expires in three days". A usage
 * reminder compares both, because a renewal is what resets the panel's usage counter and
 * therefore starts the allowance over even when the allowance itself is unchanged.
 *
 * It is also the SUBJECT of the notification this reminder produces. Every other kind
 * in `CUSTOMER_NOTIFICATION_KINDS` names an order, a payment or a service, and
 * `customer_notifications_subject_key` then guarantees one delivery per subject for
 * ever — right for a rejection, fatal for a reminder. Naming this row instead makes
 * each occurrence its own subject and keeps the guarantee exactly where it belongs.
 */
export const serviceReminders = pgTable(
  'service_reminders',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    serviceId: uuid('service_id').notNull(),
    /** One of `SERVICE_REMINDER_KINDS`. */
    kind: text('kind').notNull(),
    /**
     * The deadline the service had when this reminder was raised. Null means unlimited
     * validity, which is a real answer and not a missing one.
     *
     * Written on EVERY row, expiry and usage alike, because it is what a RENEW moves and
     * a renewal is the event that starts a new usage period too. Kept apart from
     * `basis_traffic_limit_bytes` rather than folded into one opaque column, because the
     * two are compared against different columns of `services` and a single `basis text`
     * would be a value whose meaning depends on the row's kind — which is the shape
     * `subject_type` was refused for on `customer_notifications`.
     */
    basisExpiresAt: timestamptz('basis_expires_at'),
    /**
     * The allowance the service had when this reminder was raised. Zero is unlimited,
     * the sentinel `services.traffic_limit_bytes` already uses.
     *
     * NOT NULL, and written on every row for the same reason the column above is: an
     * ADD_TRAFFIC moves it, and a reminder raised against fifty gigabytes says nothing
     * about a service that now has eighty.
     */
    basisTrafficLimitBytes: bigint('basis_traffic_limit_bytes', { mode: 'bigint' }).notNull(),
    /*
     * WHAT THE CUSTOMER IS TOLD, frozen at the moment the reminder was raised.
     *
     * The three columns below are the only reason this table has a snapshot at all, and
     * the alternative is what makes them necessary: rendering the message from
     * `services` at SEND time. The two moments are minutes apart on a good day and a
     * queue-length apart on a bad one, and in between a renewal moves the deadline, a
     * usage sync moves the figure, and the customer reads a sentence whose numbers
     * contradict the threshold that produced it. `docs/conventions.md` already requires
     * a snapshot for anything that will appear in a historical report; a message to a
     * customer is one.
     *
     * `snapshot_used_bytes` is NOT NULL and is never a stand-in for a figure nobody has
     * read: the usage sweep refuses a service whose `usage_synced_at` is NULL, and the
     * three expiry kinds render no traffic at all. Zero here means the panel said zero.
     */
    snapshotServiceLabel: text('snapshot_service_label').notNull(),
    /** Whole days left when it was raised. NULL for the usage kinds, which render none. */
    snapshotRemainingDays: integer('snapshot_remaining_days'),
    snapshotUsedBytes: bigint('snapshot_used_bytes', { mode: 'bigint' }).notNull(),
    raisedAt: timestamptz('raised_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.serviceId],
      foreignColumns: [services.tenantId, services.id],
      name: 'service_reminders_service_fk',
    }),
    /**
     * ONE row per service per kind PER PERIOD, and the insert on it is what makes the
     * pass safe.
     *
     * Two worker replicas is the normal case on every rolling update, and both will
     * find the same due service. The conditional insert is the decision: the winner
     * writes the row and enqueues the notification in the same transaction, the loser's
     * `ON CONFLICT DO NOTHING` returns nothing and it enqueues nothing.
     *
     * The BASIS is in the key, which is what makes a row an occurrence rather than a
     * slot. An occurrence keeps its id for ever, so the `customer_notifications` row
     * that names it as its subject still resolves years later; a per-kind slot rewritten
     * on each renewal would have to change its own primary key to earn a fresh subject,
     * and every earlier notification would then point at nothing.
     *
     * NULLS NOT DISTINCT, because `basis_expires_at` is NULL for unlimited validity and
     * Postgres treats NULLs in a unique key as distinct by default — which would let
     * every pass insert another row for the same service and send the same reminder for
     * ever. It is a UNIQUE CONSTRAINT rather than a unique index only because that is
     * where drizzle exposes the option.
     *
     * Both basis columns are in the key, so an ADD_TRAFFIC re-arms the three EXPIRY
     * kinds as well as the three usage ones. That is a deliberate, stated cost: the
     * customer may be told "expires soon" once more after buying traffic. Splitting it
     * into two partial unique indexes would avoid the extra message and would make the
     * arbiter of every insert depend on which kind it carries. This lane exists to speak
     * up, and an extra true sentence is the failure to prefer over a missed one.
     */
    unique('service_reminders_period_key')
      .on(
        table.tenantId,
        table.serviceId,
        table.kind,
        table.basisExpiresAt,
        table.basisTrafficLimitBytes,
      )
      .nullsNotDistinct(),
    /** The sweep reads by tenant and orders by when it last spoke. */
    index('service_reminders_raised_idx').on(table.tenantId, table.raisedAt),
    check('service_reminders_kind_check', enumCheck('kind', SERVICE_REMINDER_KINDS)),
    /**
     * Exactly one basis, and which one is decided by the kind.
     *
     * A row with neither could never be compared against anything and would suppress
     * its reminder for ever; a row with both would be two answers to "what was this
     * about". The CHECK is the only thing standing between a future caller and either.
     */
    /**
     * An allowance is a size, and a negative one is not a size.
     *
     * This replaces an exclusive `(expires_at IS NULL) <> (limit IS NULL)` that migration
     * 0090 shipped and 0091 removes. That constraint encoded a wrong model: it made each
     * reminder carry exactly ONE basis, expiry or allowance, and a usage reminder whose
     * only basis was the allowance is a usage reminder a renewal cannot re-arm. A
     * customer who renews a fifty-gigabyte plan, has their usage reset on the panel and
     * climbs back past eighty percent would never be told again, for the life of the
     * service — which is precisely the silence this whole lane exists to break.
     */
    check('service_reminders_basis_check', sql`${table.basisTrafficLimitBytes} >= 0`),
  ],
);

/**
 * One commercial action bought against a service that already exists.
 *
 * The immutable evidence a renewal, an extra-traffic purchase or an extra-time purchase
 * leaves behind, and the answer to every question an operator or an accountant can ask
 * about one: which tenant, which customer, which service, what kind, what was paid, in
 * what currency, how much was bought, where the price came from, and which order settled
 * it. A row is written in the SAME transaction that confirms the order and is never
 * updated afterwards — `nexa_service_commercial_actions_immutable` is the guard.
 *
 * ## Why a table rather than columns on `orders`
 *
 * Two reasons, and the second is the one that decided it.
 *
 * The legacy system has the same shape: `/invoice/service` is an append-only ancillary
 * ledger with seven operation types, separate from `/invoice/`, and the log topics for
 * purchases and for renewals are disjoint — "orders exclude renewals, add-ons and tests"
 * (`LGR-REC-004`). A renewal produces a new financial record and no new service.
 *
 * And a column on `orders` could not carry the customer. Every child row that names an
 * order also names a customer, and a two-column reference lets the pair disagree —
 * which here would put a renewal one customer paid for onto another customer's account.
 * The three-column form is what makes that unrepresentable, and it needs `services` to
 * be declared already. `services` references `orders`, so a column on `orders` would be
 * the other side of a cycle and a composite key cannot be written in either direction of
 * one.
 *
 * ## What is NOT here
 *
 * The absolute target the panel is asked to make true. That is on the operation row,
 * because it is a different fact: this row says what the customer BOUGHT — thirty days,
 * fifty gigabytes — and the operation says what the account should then READ as. The
 * second is computed from the first plus the service's state at settlement, once, and
 * a replay of the operation must reproduce it exactly.
 */
export const serviceCommercialActions = pgTable(
  'service_commercial_actions',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    customerId: uuid('customer_id').notNull(),
    serviceId: uuid('service_id').notNull(),
    /** One per order, and the order is what was paid. */
    orderId: uuid('order_id').notNull(),
    /** `RENEW`, `ADD_TRAFFIC` or `ADD_TIME` — the `OrderPurpose` minus `NEW_SERVICE`. */
    kind: text('kind').notNull(),
    /**
     * Where the price came from, as a row id, so the operator can navigate.
     *
     * A renewal names the product it was quoted from; a quantity purchase names the
     * add-on. Exactly one is set, and neither is how the purchase is reconstructed — the
     * amounts below and the order's own quote are.
     */
    productId: uuid('product_id'),
    addonId: uuid('addon_id'),
    /** What was bought. Bytes for traffic, days for time; zero where nothing was. */
    purchasedTrafficBytes: bigint('purchased_traffic_bytes', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    purchasedDurationDays: integer('purchased_duration_days').notNull().default(0),
    /** What was paid, with its currency. Never an amount without one. */
    amount: bigint('amount', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'service_commercial_actions_customer_fk',
    }),
    /** The customer travels with the service, or a renewal lands on the wrong account. */
    foreignKey({
      columns: [table.tenantId, table.serviceId, table.customerId],
      foreignColumns: [services.tenantId, services.id, services.customerId],
      name: 'service_commercial_actions_service_fk',
    }),
    /** And with the order, so the money and the effect cannot name two people. */
    foreignKey({
      columns: [table.tenantId, table.orderId, table.customerId],
      foreignColumns: [orders.tenantId, orders.id, orders.customerId],
      name: 'service_commercial_actions_order_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.productId],
      foreignColumns: [products.tenantId, products.id],
      name: 'service_commercial_actions_product_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.addonId],
      foreignColumns: [serviceAddons.tenantId, serviceAddons.id],
      name: 'service_commercial_actions_addon_fk',
    }),
    /**
     * ONE action per order, as a constraint rather than as worker discipline.
     *
     * The exactly-once rule, in the same shape `services_tenant_order_key` gives the
     * original purchase: the row is written inside the transaction that confirms the
     * order, so a replayed confirmation, a second replica and a double-tapped button all
     * lose here rather than each buying the customer a renewal.
     */
    uniqueIndex('service_commercial_actions_order_key').on(table.tenantId, table.orderId),
    index('service_commercial_actions_service_idx').on(table.serviceId, table.createdAt, table.id),
    index('service_commercial_actions_customer_idx').on(
      table.customerId,
      table.createdAt,
      table.id,
    ),
    check('service_commercial_actions_kind_check', enumCheck('kind', COMMERCIAL_ORDER_PURPOSES)),
    check('service_commercial_actions_currency_check', enumCheck('currency', CURRENCY_CODES)),
    check('service_commercial_actions_amount_check', sql`amount >= 0`),
    /**
     * The price came from exactly one place.
     *
     * A row naming both a product and an add-on could be read as either, and the two
     * answer "what did this cost and why" differently. A row naming neither cannot
     * answer it at all — which is the legacy defect where a deleted product collapses a
     * historical line to «محصول حذف‌شده».
     */
    check(
      'service_commercial_actions_source_check',
      sql`(product_id IS NULL) <> (addon_id IS NULL)`,
    ),
    /**
     * What each kind may have bought, pinned so the amounts cannot be swapped.
     *
     * A renewal buys a period and an allowance together — the pinned Marzban leaves a
     * traffic-exhausted account exhausted when only time is extended, so a renewal that
     * sent one field would take the money and leave the customer cut off. A quantity
     * purchase buys exactly one of them, and the other is zero.
     */
    check(
      'service_commercial_actions_purchased_check',
      sql`(kind = 'RENEW')
          OR (kind = 'ADD_TRAFFIC' AND purchased_traffic_bytes > 0 AND purchased_duration_days = 0)
          OR (kind = 'ADD_TIME' AND purchased_duration_days > 0 AND purchased_traffic_bytes = 0)`,
    ),
    unique('service_commercial_actions_tenant_id_key').on(table.tenantId, table.id),
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
    /**
     * The customer who ASKED for this, or NULL when nobody did.
     *
     * Phase 6A, and it exists because the customer notification lane needs to tell
     * "the thing you asked for happened" from "an operator changed your service".
     * Before the operator action path there was no difference to record: `SUSPEND`,
     * `RESUME` and `TERMINATE` could only be reached from the customer's own detail
     * screen, so `CUSTOMER_REQUESTABLE_OPERATIONS` could decide the announcement from
     * the TYPE alone. It cannot any more — an operator suspend is the same type —
     * and deciding from the type would tell a customer their own request succeeded
     * when they made none, or invite them to retry a terminate an operator ordered.
     *
     * NULL is the honest value for everything a person did not ask for: a reconcile,
     * a usage sync, the retry of a lost create, and every operator action. An operator
     * IS recorded — in the audit row `planRequestedOperation` writes, where the actor
     * names the person. This column answers a narrower question: is a customer owed a
     * sentence about the outcome.
     */
    requestedByCustomerId: uuid('requested_by_customer_id'),
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
    /**
     * What this operation is trying to make TRUE on the panel.
     *
     * Absolute, and written once — in the transaction that settles the order that bought
     * it — rather than computed when the worker runs. That placement is the whole reason
     * `RENEW`, `ADD_TRAFFIC` and `ADD_TIME` may sit in `IDEMPOTENT_MUTATIONS`: a target
     * derived at execution time from whatever the panel currently holds would differ
     * between the first attempt and its replay, and the arithmetic would compound into a
     * customer receiving two renewals for one payment. A stored target replays to the
     * same two numbers for ever.
     *
     * NULL means this operation did not BUY that field, and the provider call omits the
     * key — which the pinned Marzban treats as no change rather than as a reset
     * (`scripts/marzban-allowance-check.sh`, row 3). So an `ADD_TIME` carries an expiry
     * and no limit, an `ADD_TRAFFIC` the reverse, and a `RENEW` both.
     *
     * NULL is NOT "unlimited". Unlimited traffic is zero, the same sentinel
     * `services.traffic_limit_bytes` and `products.traffic_bytes` already use.
     */
    targetExpiresAt: timestamptz('target_expires_at'),
    targetTrafficLimitBytes: bigint('target_traffic_limit_bytes', { mode: 'bigint' }),
    /** The provider's own reference for the effect, when it gave one. */
    providerReference: text('provider_reference'),
    /** A kind from the EXISTING provider taxonomy. Never a new vocabulary. */
    failureKind: text('failure_kind'),
    /** Bounded, redacted diagnostic. Never a raw provider response. */
    failureMessage: text('failure_message'),
    completedAt: timestamptz('completed_at'),
    /**
     * When the customer was answered about this operation — or NULL, meaning
     * nobody has answered for it yet.
     *
     * This is the claim surface for the sweep that closes the crash window
     * `docs/phase4j-audit.md` names: the executor terminalises an operation in
     * one transaction and `OperationOutcomeAnnouncer.announce` enqueues the
     * message in the NEXT one, and a process that dies between them leaves an
     * operation that is terminal, un-announced, and that nothing will ever call
     * `announce` for again. The loop has moved on and there is exactly one call
     * site.
     *
     * NULL means UNANSWERED, never "no answer was owed". The announcer stamps
     * this even when it decides the operation says nothing — a `SYNC_USAGE`, a
     * `PROVISION` whose link goes out through `DeliveryService` — because a row
     * left NULL is a row the sweep re-reads for ever. The one exit that must NOT
     * stamp is a state that is not terminal: a `FAILED` with attempts left goes
     * back to `PLANNED`, and marking it answered before it has finished is the
     * same silence from the other direction.
     *
     * Deliberately NOT part of `provisioning_operations_completed_check`. That
     * constraint binds the terminal states to `completed_at`; binding this one
     * too would make the stamp a property of the STATE rather than of whether
     * anybody has spoken, and the whole point is that those are different facts
     * that a crash can separate.
     */
    announcedAt: timestamptz('announced_at'),
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
    /** A child row may not name a customer of another tenant. */
    foreignKey({
      columns: [table.tenantId, table.requestedByCustomerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'provisioning_operations_requested_by_fk',
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
    /**
     * ONE open COMMERCIAL action per service, for the reason the PROVISION index above
     * exists and a different failure than the one it prevents.
     *
     * A commercial target is ABSOLUTE and is computed once, in the transaction that
     * settles the order, from the service as it stood when the money moved. Two
     * purchases that settle before the first reaches the panel therefore read the same
     * allowance and plan the same number: two five-gigabyte packages against a
     * ten-gigabyte service each plan FIFTEEN, both are charged, and the account ends
     * where one purchase would have left it.
     *
     * `claimDue` already refuses to run two operations for one service at once, and
     * that is not this: serialising EXECUTION does not help when both rows were
     * computed from the same reading. The refusal has to be at PLAN time, which is why
     * it is an index rather than a check in a service — two API replicas settling two
     * orders in the same instant is exactly the case a read-then-write loses.
     *
     * All three types together rather than one index each: a renewal's target is
     * computed from the same two columns an add-on's is, so a renewal in flight
     * interferes with a top-up exactly as another top-up would.
     *
     * The two NON-TERMINAL states only, as above. A `FAILED` action has written nothing
     * to the service, so the next purchase reads an unchanged row and is safe.
     */
    uniqueIndex('provisioning_operations_open_commercial_key')
      .on(table.tenantId, table.serviceId)
      .where(
        sql`type IN ('RENEW', 'ADD_TRAFFIC', 'ADD_TIME') AND state IN ('PLANNED', 'IN_FLIGHT')`,
      ),
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
    /**
     * Only a commercial operation may carry a target.
     *
     * A `SUSPEND` with a desired expiry is a row nothing reads and the next reviewer has
     * to decide the meaning of — and the reading they would reach for, that the suspend
     * should also set it, is the one that would silently widen what a management action
     * does. Refused here so it cannot be written at all.
     */
    check(
      'provisioning_operations_target_check',
      sql`type IN ('RENEW', 'ADD_TRAFFIC', 'ADD_TIME')
          OR (target_expires_at IS NULL AND target_traffic_limit_bytes IS NULL)`,
    ),
    /**
     * And a commercial operation must carry at least one, or it asks the panel for
     * nothing while an order records that a customer paid for something.
     */
    check(
      'provisioning_operations_target_present_check',
      sql`type NOT IN ('RENEW', 'ADD_TRAFFIC', 'ADD_TIME')
          OR target_expires_at IS NOT NULL
          OR target_traffic_limit_bytes IS NOT NULL`,
    ),
    check(
      'provisioning_operations_target_traffic_check',
      sql`target_traffic_limit_bytes IS NULL OR target_traffic_limit_bytes >= 0`,
    ),
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

/**
 * The queue of things to tell a customer that they did not ask for.
 *
 * `ADR 0030` decides the shape and `docs/phase4h-audit.md` §1 measures the absence it
 * fills: before Phase 4H this product could tell a customer exactly ONE such thing, the
 * subscription link, whose lane is two columns on `services` and a state table about a
 * subscription link. Phases 4D–4G created several more facts a customer needs and none
 * of them had anywhere to travel.
 *
 * Its own table rather than more columns on the subjects, because the subjects are four
 * different tables and a column pair per table is four copies of one state machine. Its
 * own table rather than `notifications`, because that one's destinations are OPERATOR
 * channels and its `DELIVERY_OUTCOMES` enum is pinned by a CHECK constraint — an
 * operator alert that arrives late is still useful and a duplicate is merely noise, and
 * for a customer neither is true. Not the outbox either: that carries domain EVENTS and
 * freezes their content, and a customer message is an EFFECT of an event.
 *
 * There is no `values` column, and its absence is a decision rather than an omission.
 * Every one of the eight kinds renders a template that declares NO placeholders, so there
 * is nothing to carry; a jsonb column with no producer is the empty table this
 * repository refuses elsewhere. The first kind that needs one adds it, in the migration
 * that needs it.
 */
export const customerNotifications = pgTable(
  'customer_notifications',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    customerId: uuid('customer_id').notNull(),
    /**
     * Which bot to send from, and never "the tenant's active bot".
     *
     * `CustomerMessenger`'s port states the rule and the reason: a customer wrote to a
     * specific bot, and a reply from a different one arrives from an account they have
     * never heard of — which, for a tenant running a public bot and a reseller bot,
     * leaks the relationship between them. So the producer resolves it at enqueue time
     * from the subject, and the dispatcher does not get to choose.
     */
    botInstanceId: uuid('bot_instance_id').notNull(),
    /** One of `CUSTOMER_NOTIFICATION_KINDS`. The kind decides the template AND the table `subject_id` names. */
    kind: text('kind').notNull(),
    /**
     * The row this notification is about, in the table its `kind` implies.
     *
     * Deliberately NOT accompanied by a `subject_type` column. The kind already
     * determines the table — `PAYMENT_REJECTED` names a payment and nothing else — and a
     * second column saying so is a second source of truth that can disagree with the
     * first. `CUSTOMER_NOTIFICATION_PRECONDITIONS` is keyed on kind for the same reason.
     *
     * No foreign key, and that is deliberate too: the four possible targets are four
     * different tables, and a column cannot reference all of them. What protects it is
     * that the producer writes this row in the SAME transaction as the fact, so a
     * subject that never existed cannot have produced one.
     */
    subjectId: uuid('subject_id').notNull(),
    state: text('state').notNull().default('PENDING'),
    /**
     * Definite refusals observed for THIS message.
     *
     * A rate limit is not one. `CUSTOMER_NOTIFICATION_MAX_ATTEMPTS` states why at
     * length: an attempt is an outcome somebody observed about this message, and
     * Telegram declining to look at it yet is not that. Spending attempts on rate limits
     * fails messages that were never rejected on their merits, in exactly the conditions
     * that produce rate limits.
     */
    attempts: integer('attempts').notNull().default(0),
    /** When the dispatcher may next try. Null means now. */
    nextAttemptAt: timestamptz('next_attempt_at'),
    /**
     * When a send was handed to Telegram with no outcome recorded yet.
     *
     * `services.delivery_send_started_at` for this lane, and it exists for the identical
     * reason: it is the one fact distinguishing "this process died BEFORE sending" from
     * "this process died AFTER sending", and only the second must never be repeated
     * automatically. Without it a dispatcher killed mid-send leaves a row `PENDING`
     * behind nothing but a lease, and the next pass tells the customer again.
     *
     * Cleared by every recorded outcome, so a set value always means an unresolved send.
     */
    sendStartedAt: timestamptz('send_started_at'),
    /**
     * When this row stopped being `PENDING`, whatever it became.
     *
     * One stamp rather than one per terminal state. `state` already says WHICH outcome,
     * and a `delivered_at` beside a `failed_at` beside a `superseded_at` is three
     * columns that can disagree with the one that decides.
     */
    resolvedAt: timestamptz('resolved_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'customer_notifications_customer_fk',
    }),
    check('customer_notifications_kind_check', enumCheck('kind', CUSTOMER_NOTIFICATION_KINDS)),
    check('customer_notifications_state_check', enumCheck('state', CUSTOMER_NOTIFICATION_STATES)),
    /**
     * A resolved row has a stamp and a `PENDING` one does not, as an equality.
     *
     * The same shape as `orders_cancelled_at_check`, which the 4G audit found had made
     * its own state unwritable — so this one is stated as an equality over the state
     * rather than a one-way implication, and 4H-2's tests write every terminal state
     * through it rather than trusting that they can.
     */
    check(
      'customer_notifications_resolved_check',
      sql`(state <> 'PENDING') = (resolved_at IS NOT NULL)`,
    ),
    /**
     * One notification of one kind per subject, for ever.
     *
     * This is the idempotency of the whole lane and it is a CONSTRAINT rather than a
     * check in a service: the producers enqueue inside the transaction that produced the
     * fact, two worker replicas are the normal case on every rolling update, and a
     * redelivered outbox message replays its effect. "Payment X was rejected" is told
     * once whichever of those happens.
     */
    unique('customer_notifications_subject_key').on(table.tenantId, table.kind, table.subjectId),
    /** The dispatcher's claim: queued rows whose backoff has elapsed, oldest first. */
    index('customer_notifications_due_idx')
      .on(table.nextAttemptAt)
      .where(sql`state = 'PENDING'`),
  ],
);
