/**
 * Database schema — ops: incidents, capacity guards, data compaction.
 *
 * One part of `../schema.ts`, which re-exports every part; import from there.
 */
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
  ACTOR_TYPES,
  CAPACITY_LIMIT_MODES,
  CAPACITY_RESOURCES,
  HEAVY_JOB_KINDS,
  HEAVY_JOB_STATES,
  DATA_COMPACTION_MODES,
  DATA_COMPACTION_RUN_STATES,
  DATA_COMPACTION_STOP_REASONS,
  DATA_COMPACTION_TRIGGERS,
  INCIDENT_KINDS,
  INCIDENT_SEVERITIES,
  INCIDENT_STATUSES,
  INCIDENT_TARGET_KINDS,
  INCIDENT_EFFECT_KINDS,
  INCIDENT_EFFECT_STATES,
  INCIDENT_EVENT_KINDS,
  INCIDENT_TITLE_MAX_LENGTH,
  INCIDENT_CUSTOMER_MESSAGE_MAX_LENGTH,
} from '@nexa/contracts';
import { enumCheck, nullableEnumCheck, timestamptz } from './_shared.js';
import { tenants } from './tenancy.js';
import { admins } from './identity.js';
import { customers } from './customers.js';

// --- Phase E3: incidents and maintenance ------------------------------------------------

/**
 * An incident or maintenance window (`docs/incidents.md`): the operator's record of it,
 * its scope (`incident_targets`), the effects run on that scope through the owning
 * modules (`incident_effects`), its append-only timeline (`incident_events`) and what
 * customers were told (`incident_communications`, `incident_notices`).
 *
 * Every status change is a conditional UPDATE naming its `from` statuses and bumping
 * `version`; there is no setter. The CHECKs pin each status to the stamps it implies.
 */
export const incidents = pgTable(
  'incidents',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    kind: text('kind').notNull(),
    severity: text('severity').notNull(),
    status: text('status').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    /** What customers read when an operator sends a notice; null means nothing to send. */
    customerMessage: text('customer_message'),
    stopSales: boolean('stop_sales').notNull().default(false),
    adminBanner: boolean('admin_banner').notNull().default(true),
    scheduledStartAt: timestamptz('scheduled_start_at'),
    scheduledEndAt: timestamptz('scheduled_end_at'),
    startedAt: timestamptz('started_at'),
    resolvedAt: timestamptz('resolved_at'),
    version: integer('version').notNull().default(1),
    createdByAdminId: uuid('created_by_admin_id'),
    createdAt: timestamptz('created_at').notNull(),
    updatedAt: timestamptz('updated_at').notNull(),
  },
  (table) => [
    unique('incidents_tenant_id_key').on(table.tenantId, table.id),
    index('incidents_tenant_status_idx').on(table.tenantId, table.status, table.createdAt),
    /** The scheduler's walk: SCHEDULED windows by start, across tenants. */
    index('incidents_scheduled_idx')
      .on(table.scheduledStartAt)
      .where(sql`status = 'SCHEDULED'`),
    foreignKey({
      columns: [table.tenantId, table.createdByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
      name: 'incidents_created_by_fk',
    }),
    check('incidents_kind_check', enumCheck('kind', INCIDENT_KINDS)),
    check('incidents_severity_check', enumCheck('severity', INCIDENT_SEVERITIES)),
    check('incidents_status_check', enumCheck('status', INCIDENT_STATUSES)),
    check(
      'incidents_title_check',
      sql`length(btrim(title)) BETWEEN 1 AND ${sql.raw(String(INCIDENT_TITLE_MAX_LENGTH))}`,
    ),
    check(
      'incidents_message_check',
      sql`customer_message IS NULL OR length(customer_message) BETWEEN 1 AND ${sql.raw(String(INCIDENT_CUSTOMER_MESSAGE_MAX_LENGTH))}`,
    ),
    check('incidents_version_check', sql`version >= 1`),
    /** Each status carries exactly the stamps it implies. */
    check(
      'incidents_status_stamps_check',
      sql`CASE status
            WHEN 'SCHEDULED' THEN scheduled_start_at IS NOT NULL AND started_at IS NULL AND resolved_at IS NULL
            WHEN 'ACTIVE' THEN started_at IS NOT NULL AND resolved_at IS NULL
            WHEN 'RESOLVED' THEN started_at IS NOT NULL AND resolved_at IS NOT NULL
            WHEN 'CANCELLED' THEN started_at IS NULL AND resolved_at IS NOT NULL
          END`,
    ),
    check(
      'incidents_window_check',
      sql`scheduled_end_at IS NULL OR scheduled_start_at IS NULL OR scheduled_end_at > scheduled_start_at`,
    ),
  ],
);

/** The incident's scope: exactly the things it is about, and nothing else. */
export const incidentTargets = pgTable(
  'incident_targets',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    incidentId: uuid('incident_id').notNull(),
    kind: text('kind').notNull(),
    /** A panel, location or product id, or a gateway's provider code. */
    ref: text('ref').notNull(),
  },
  (table) => [
    primaryKey({
      name: 'incident_targets_pk',
      columns: [table.tenantId, table.incidentId, table.kind, table.ref],
    }),
    foreignKey({
      columns: [table.tenantId, table.incidentId],
      foreignColumns: [incidents.tenantId, incidents.id],
      name: 'incident_targets_incident_fk',
    }),
    check('incident_targets_kind_check', enumCheck('kind', INCIDENT_TARGET_KINDS)),
  ],
);

/**
 * One effect, once per incident and subject: the unique key is what makes a second
 * "apply" — a double click, two operators, a retry — change nothing.
 */
export const incidentEffects = pgTable(
  'incident_effects',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    incidentId: uuid('incident_id').notNull(),
    kind: text('kind').notNull(),
    targetKind: text('target_kind').notNull(),
    targetRef: text('target_ref').notNull(),
    /** What was actually changed: the panel for a location, else the target. */
    subjectRef: text('subject_ref').notNull(),
    state: text('state').notNull(),
    errorCode: text('error_code'),
    createdAt: timestamptz('created_at').notNull(),
    updatedAt: timestamptz('updated_at').notNull(),
  },
  (table) => [
    primaryKey({
      name: 'incident_effects_pk',
      columns: [table.tenantId, table.incidentId, table.kind, table.subjectRef],
    }),
    foreignKey({
      columns: [table.tenantId, table.incidentId],
      foreignColumns: [incidents.tenantId, incidents.id],
      name: 'incident_effects_incident_fk',
    }),
    check('incident_effects_kind_check', enumCheck('kind', INCIDENT_EFFECT_KINDS)),
    check('incident_effects_target_kind_check', enumCheck('target_kind', INCIDENT_TARGET_KINDS)),
    check('incident_effects_state_check', enumCheck('state', INCIDENT_EFFECT_STATES)),
  ],
);

/** The timeline. Append-only: a trigger refuses UPDATE and DELETE (migration tail). */
export const incidentEvents = pgTable(
  'incident_events',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    incidentId: uuid('incident_id').notNull(),
    kind: text('kind').notNull(),
    actorType: text('actor_type').notNull(),
    /** An administrator's id, or a system job's name — as `audit_logs.actor_id` holds it. */
    actorId: text('actor_id'),
    actorLabel: text('actor_label'),
    /** Structured and non-sensitive: what changed, how many were told. Never a message. */
    detail: jsonb('detail'),
    occurredAt: timestamptz('occurred_at').notNull(),
  },
  (table) => [
    index('incident_events_incident_idx').on(
      table.tenantId,
      table.incidentId,
      table.occurredAt,
      table.id,
    ),
    foreignKey({
      columns: [table.tenantId, table.incidentId],
      foreignColumns: [incidents.tenantId, incidents.id],
      name: 'incident_events_incident_fk',
    }),
    check('incident_events_kind_check', enumCheck('kind', INCIDENT_EVENT_KINDS)),
    check('incident_events_actor_type_check', enumCheck('actor_type', ACTOR_TYPES)),
  ],
);

/** One customer communication: the message as sent, frozen, and how many it reached. */
export const incidentCommunications = pgTable(
  'incident_communications',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    incidentId: uuid('incident_id').notNull(),
    message: text('message').notNull(),
    recipients: integer('recipients').notNull(),
    sentByAdminId: uuid('sent_by_admin_id'),
    createdAt: timestamptz('created_at').notNull(),
  },
  (table) => [
    unique('incident_communications_tenant_id_key').on(table.tenantId, table.id),
    foreignKey({
      columns: [table.tenantId, table.incidentId],
      foreignColumns: [incidents.tenantId, incidents.id],
      name: 'incident_communications_incident_fk',
    }),
    check('incident_communications_recipients_check', sql`recipients >= 0`),
  ],
);

/** One customer of one communication: the subject of its INCIDENT_NOTICE lane row. */
export const incidentNotices = pgTable(
  'incident_notices',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    communicationId: uuid('communication_id').notNull(),
    incidentId: uuid('incident_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    createdAt: timestamptz('created_at').notNull(),
  },
  (table) => [
    unique('incident_notices_customer_key').on(
      table.tenantId,
      table.communicationId,
      table.customerId,
    ),
    foreignKey({
      columns: [table.tenantId, table.communicationId],
      foreignColumns: [incidentCommunications.tenantId, incidentCommunications.id],
      name: 'incident_notices_communication_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'incident_notices_customer_fk',
    }),
  ],
);

/**
 * Round 9 C3: one pass of the data compaction (`@nexa/contracts` `data-compaction.ts`) — the
 * RECORDED RESULT of every dry run and every applied pass, worker or CLI. `counts` is rows per
 * table (what would go in a DRY_RUN, what went in an APPLY), advanced inside each batch's own
 * transaction so a crash loses at most the batch in flight; `cutoffs` is the instant per class
 * the pass was bounded by, fixed when it began. The nightly report sums the APPLY passes of
 * its day.
 *
 * ONE RUNNING pass per tenant is a partial unique index, not a process: two worker replicas
 * are normal on every rolling update. A RUNNING row whose heartbeat went stale is FAILED by the
 * next pass (`ABANDONED`), never adopted. Every state change is a conditional UPDATE naming
 * `RUNNING` as its `from`.
 */
export const dataCompactionRuns = pgTable(
  'data_compaction_runs',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    trigger: text('trigger').notNull(),
    mode: text('mode').notNull(),
    state: text('state').notNull(),
    startedAt: timestamptz('started_at').notNull(),
    heartbeatAt: timestamptz('heartbeat_at').notNull(),
    finishedAt: timestamptz('finished_at'),
    cutoffs: jsonb('cutoffs').notNull(),
    counts: jsonb('counts')
      .notNull()
      .default(sql`'{}'::jsonb`),
    stopReason: text('stop_reason'),
  },
  (table) => [
    check('data_compaction_runs_trigger_check', enumCheck('trigger', DATA_COMPACTION_TRIGGERS)),
    check('data_compaction_runs_mode_check', enumCheck('mode', DATA_COMPACTION_MODES)),
    check('data_compaction_runs_state_check', enumCheck('state', DATA_COMPACTION_RUN_STATES)),
    check(
      'data_compaction_runs_stop_reason_check',
      nullableEnumCheck('stop_reason', DATA_COMPACTION_STOP_REASONS),
    ),
    check('data_compaction_runs_finished_check', sql`(state = 'RUNNING') = (finished_at IS NULL)`),
    check(
      'data_compaction_runs_counts_check',
      sql`jsonb_typeof(counts) = 'object' AND jsonb_typeof(cutoffs) = 'object'`,
    ),
    uniqueIndex('data_compaction_runs_one_running_idx')
      .on(table.tenantId)
      .where(sql`state = 'RUNNING'`),
    index('data_compaction_runs_tenant_started_idx').on(table.tenantId, table.startedAt),
  ],
);

// ---------------------------------------------------------------------------
// Phase 6A PR-2 — capacity guards
// ---------------------------------------------------------------------------

/**
 * The owner's per-bot capacity limits (`packages/contracts/src/capacity.ts`). One row per
 * (tenant, resource) the OWNER changed; an absent row is the tier's default, so a new
 * hosted bot is limited from its first update with nothing written. Keyed by `tenant_id`
 * like every tenant-owned table, so row-level security covers it; written only by
 * `CapacityLimitsService`, which refuses every scope but the installation's own owner.
 *
 * `updated_by_admin_id` is the installation's administrator, NOT one of this tenant's, so
 * it carries no tenant-composite foreign key; the audit row names the actor in full.
 */
export const tenantCapacityLimits = pgTable(
  'tenant_capacity_limits',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    resource: text('resource').notNull(),
    mode: text('mode').notNull(),
    /** The limit for `LIMITED`; NULL for `UNLIMITED` (never a sentinel number). */
    value: integer('value'),
    updatedAt: timestamptz('updated_at').notNull(),
    updatedByAdminId: uuid('updated_by_admin_id'),
  },
  (table) => [
    primaryKey({ name: 'tenant_capacity_limits_pkey', columns: [table.tenantId, table.resource] }),
    check('tenant_capacity_limits_resource_check', enumCheck('resource', CAPACITY_RESOURCES)),
    check('tenant_capacity_limits_mode_check', enumCheck('mode', CAPACITY_LIMIT_MODES)),
    check(
      'tenant_capacity_limits_value_check',
      sql`(mode = 'UNLIMITED' AND value IS NULL) OR (mode = 'LIMITED' AND value IS NOT NULL AND value >= 0)`,
    ),
  ],
);

/**
 * The ONE installation-wide queue of heavy jobs (backup, import, export, large report): at
 * most `INSTALLATION_HEAVY_JOB_CONCURRENCY` RUNNING at once, the rest QUEUED in priority
 * order (the owner's own bot first) and then arrival. A ticket is a lease: a waiter or a
 * runner that stops refreshing it is ABANDONED by the next caller, so a killed process
 * never holds the queue. `tenant_id` is the bot the job is for.
 */
export const heavyJobTickets = pgTable(
  'heavy_job_tickets',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    kind: text('kind').notNull(),
    state: text('state').notNull(),
    priority: integer('priority').notNull(),
    enqueuedAt: timestamptz('enqueued_at').notNull(),
    startedAt: timestamptz('started_at'),
    finishedAt: timestamptz('finished_at'),
    leaseUntil: timestamptz('lease_until').notNull(),
  },
  (table) => [
    index('heavy_job_tickets_tenant_idx').on(table.tenantId, table.enqueuedAt),
    index('heavy_job_tickets_live_idx')
      .on(table.state, table.priority, table.enqueuedAt)
      .where(sql`state IN ('QUEUED', 'RUNNING')`),
    check('heavy_job_tickets_kind_check', enumCheck('kind', HEAVY_JOB_KINDS)),
    check('heavy_job_tickets_state_check', enumCheck('state', HEAVY_JOB_STATES)),
    check('heavy_job_tickets_priority_check', sql`priority >= 0`),
    check(
      'heavy_job_tickets_started_check',
      sql`(state = 'QUEUED') = (started_at IS NULL) OR state = 'ABANDONED'`,
    ),
  ],
);
