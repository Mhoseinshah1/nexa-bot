/**
 * Database schema — the open data export: one row per request for a ZIP of a tenant's data.
 *
 * One part of `../schema.ts`, which re-exports every part; import from there.
 */
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { DATA_EXPORT_ACTIVE_STATES, DATA_EXPORT_STATES } from '@nexa/contracts';
import { enumCheck, timestamptz } from './_shared.js';
import { tenants } from './tenancy.js';

/**
 * Phase 6B PR-3 (ADR-0039, "The open data export"): the request for one export, and what the
 * worker made of it.
 *
 * TENANT-OWNED: `tenant_id` is the EXPORTED tenant — the hosted bot whose rows the file holds —
 * whoever asked. The request is `REQUESTED`; the worker claims it (`RUNNING`, a lease it
 * refreshes), writes `<work dir>/data-exports/<tenant>/<id>.zip` through the heavy-job queue and
 * ends `READY` with the file's size, SHA-256 and a deadline 24 h out; the sweep ends it
 * `EXPIRED` and removes the file. `requested_by_admin_id` carries NO foreign key: when the
 * installation owner asks from «میزبانی‌ها» the administrator belongs to the installation
 * tenant, not the exported one (`requested_by_host`).
 *
 * Never in a tenant archive (`tenant-archive-inventory.ts`, NEVER): a file on THIS server and a
 * 24 h link mean nothing anywhere else.
 */
export const tenantDataExports = pgTable(
  'tenant_data_exports',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    state: text('state').notNull(),
    requestedByAdminId: uuid('requested_by_admin_id').notNull(),
    requestedByHost: boolean('requested_by_host').notNull(),
    requestedAt: timestamptz('requested_at').notNull(),
    /** The worker that holds the RUNNING row, and when it last said so (stale = reclaimable). */
    leaseOwner: text('lease_owner'),
    heartbeatAt: timestamptz('heartbeat_at'),
    attempts: integer('attempts').notNull().default(0),
    /** READY: where the file is, relative to the export directory, and what it is. */
    fileName: text('file_name'),
    bytes: bigint('bytes', { mode: 'number' }),
    sha256: text('sha256'),
    readyAt: timestamptz('ready_at'),
    expiresAt: timestamptz('expires_at'),
    /** When the sweep removed the file (EXPIRED). */
    removedAt: timestamptz('removed_at'),
    failureCode: text('failure_code'),
    updatedAt: timestamptz('updated_at').notNull(),
  },
  (table) => [
    check('tenant_data_exports_state_check', enumCheck('state', DATA_EXPORT_STATES)),
    check('tenant_data_exports_sha_check', sql`sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'`),
    check('tenant_data_exports_attempts_check', sql`attempts >= 0`),
    // READY holds a file and a deadline; a FAILED export a reason; nothing else holds either.
    check(
      'tenant_data_exports_ready_check',
      sql`(state IN ('READY', 'EXPIRED')) = (file_name IS NOT NULL AND sha256 IS NOT NULL AND expires_at IS NOT NULL AND ready_at IS NOT NULL)`,
    ),
    check(
      'tenant_data_exports_failure_check',
      sql`(state = 'FAILED') = (failure_code IS NOT NULL)`,
    ),
    // One export being made per tenant: the database refuses a second request.
    uniqueIndex('tenant_data_exports_single_active_idx')
      .on(table.tenantId)
      .where(sql`state IN (${sql.raw(DATA_EXPORT_ACTIVE_STATES.map((s) => `'${s}'`).join(', '))})`),
    index('tenant_data_exports_tenant_requested_idx').on(table.tenantId, table.requestedAt),
    // The sweeps: what is waiting for a worker, and what is past its deadline.
    index('tenant_data_exports_queue_idx')
      .on(table.state, table.requestedAt)
      .where(sql`state IN ('REQUESTED', 'RUNNING')`),
    index('tenant_data_exports_expiry_idx')
      .on(table.expiresAt)
      .where(sql`state = 'READY'`),
  ],
);
