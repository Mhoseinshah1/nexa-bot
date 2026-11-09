import { and, asc, desc, eq, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import {
  DATA_EXPORT_ACTIVE_STATES,
  DATA_EXPORT_ERROR_CODES,
  errors,
  type DataExportState,
  type TenantContext,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import { ScopeBound } from '../../../../infrastructure/persistence/database-scope.js';
import { tenantDataExports } from '../../../../infrastructure/persistence/schema.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import type { DataExportRepository, DataExportRow } from '../application/ports.js';

function executorOf(db: Database, tx?: unknown): Executor {
  return (tx as TransactionScope | undefined)?.tx ?? db;
}

type Row = typeof tenantDataExports.$inferSelect;

function toRow(row: Row): DataExportRow {
  return {
    id: row.id,
    tenantId: row.tenantId,
    state: row.state as DataExportState,
    requestedByAdminId: row.requestedByAdminId,
    requestedByHost: row.requestedByHost,
    requestedAt: row.requestedAt,
    leaseOwner: row.leaseOwner,
    heartbeatAt: row.heartbeatAt,
    attempts: row.attempts,
    fileName: row.fileName,
    bytes: row.bytes,
    sha256: row.sha256,
    readyAt: row.readyAt,
    expiresAt: row.expiresAt,
    removedAt: row.removedAt,
    failureCode: row.failureCode,
    updatedAt: row.updatedAt,
  };
}

const ACTIVE = DATA_EXPORT_ACTIVE_STATES as readonly string[];

/**
 * Phase 6B PR-3: the `tenant_data_exports` rows. A method with a scope runs bound to the
 * EXPORTED tenant (row-level security confines it to that tenant's rows); the five with none
 * are the worker's sweeps across tenants, which `@ScopeBound` runs on the system path under
 * the reason `DrizzleDataExportRepository.<method>`, pinned in the allow-list. Every state
 * change is a conditional UPDATE naming its `from` state and, for the worker's, its lease.
 */
@ScopeBound()
export class DrizzleDataExportRepository implements DataExportRepository {
  constructor(private readonly db: Database) {}

  async insert(
    scope: TenantContext,
    row: {
      readonly id: string;
      readonly requestedByAdminId: string;
      readonly requestedByHost: boolean;
      readonly now: Date;
    },
    tx?: unknown,
  ): Promise<void> {
    try {
      await executorOf(this.db, tx)
        .insert(tenantDataExports)
        .values({
          id: row.id,
          tenantId: requireTenantId(scope),
          state: 'REQUESTED',
          requestedByAdminId: row.requestedByAdminId,
          requestedByHost: row.requestedByHost,
          requestedAt: row.now,
          updatedAt: row.now,
        });
    } catch (error) {
      // The partial unique index: another request won the race to the one active slot.
      if ((error as { code?: unknown }).code === '23505') {
        throw errors.conflict(
          DATA_EXPORT_ERROR_CODES.IN_PROGRESS,
          'An export of this data is already being made.',
        );
      }
      throw error;
    }
  }

  async find(scope: TenantContext, id: string, tx?: unknown): Promise<DataExportRow | null> {
    const [row] = await executorOf(this.db, tx)
      .select()
      .from(tenantDataExports)
      .where(
        and(eq(tenantDataExports.tenantId, requireTenantId(scope)), eq(tenantDataExports.id, id)),
      )
      .limit(1);
    return row === undefined ? null : toRow(row);
  }

  async list(
    scope: TenantContext,
    limit: number,
    tx?: unknown,
    filter?: { readonly requestedByHost?: boolean },
  ): Promise<DataExportRow[]> {
    const rows = await executorOf(this.db, tx)
      .select()
      .from(tenantDataExports)
      .where(
        and(
          eq(tenantDataExports.tenantId, requireTenantId(scope)),
          filter?.requestedByHost === undefined
            ? undefined
            : eq(tenantDataExports.requestedByHost, filter.requestedByHost),
        ),
      )
      .orderBy(desc(tenantDataExports.requestedAt), desc(tenantDataExports.id))
      .limit(limit);
    return rows.map(toRow);
  }

  async active(scope: TenantContext, tx?: unknown): Promise<DataExportRow | null> {
    const [row] = await executorOf(this.db, tx)
      .select()
      .from(tenantDataExports)
      .where(
        and(
          eq(tenantDataExports.tenantId, requireTenantId(scope)),
          inArray(tenantDataExports.state, [...ACTIVE]),
        ),
      )
      .limit(1);
    return row === undefined ? null : toRow(row);
  }

  async claimNext(input: {
    readonly now: Date;
    readonly staleBefore: Date;
    readonly leaseOwner: string;
    readonly maxAttempts: number;
  }): Promise<DataExportRow | null> {
    const claimable = or(
      eq(tenantDataExports.state, 'REQUESTED'),
      and(
        eq(tenantDataExports.state, 'RUNNING'),
        lt(tenantDataExports.heartbeatAt, input.staleBefore),
        lt(tenantDataExports.attempts, input.maxAttempts),
      ),
    );
    const [row] = await this.db
      .update(tenantDataExports)
      .set({
        state: 'RUNNING',
        leaseOwner: input.leaseOwner,
        heartbeatAt: input.now,
        attempts: sql`${tenantDataExports.attempts} + 1`,
        updatedAt: input.now,
      })
      .where(
        sql`${tenantDataExports.id} = (
          SELECT id FROM tenant_data_exports
           WHERE ${claimable}
           ORDER BY requested_at, id
           LIMIT 1
           FOR UPDATE SKIP LOCKED)`,
      )
      .returning();
    return row === undefined ? null : toRow(row);
  }

  async failAbandoned(input: {
    readonly now: Date;
    readonly staleBefore: Date;
    readonly maxAttempts: number;
  }): Promise<number> {
    const rows = await this.db
      .update(tenantDataExports)
      .set({
        state: 'FAILED',
        failureCode: DATA_EXPORT_ERROR_CODES.FAILED,
        leaseOwner: null,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(tenantDataExports.state, 'RUNNING'),
          lt(tenantDataExports.heartbeatAt, input.staleBefore),
          sql`${tenantDataExports.attempts} >= ${input.maxAttempts}`,
        ),
      )
      .returning({ id: tenantDataExports.id });
    return rows.length;
  }

  async heartbeat(
    scope: TenantContext,
    input: { readonly id: string; readonly leaseOwner: string; readonly now: Date },
  ): Promise<boolean> {
    const rows = await this.db
      .update(tenantDataExports)
      .set({ heartbeatAt: input.now, updatedAt: input.now })
      .where(this.leased(scope, input))
      .returning({ id: tenantDataExports.id });
    return rows.length === 1;
  }

  async markReady(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly leaseOwner: string;
      readonly fileName: string;
      readonly bytes: number;
      readonly sha256: string;
      readonly now: Date;
      readonly expiresAt: Date;
    },
  ): Promise<boolean> {
    const rows = await this.db
      .update(tenantDataExports)
      .set({
        state: 'READY',
        fileName: input.fileName,
        bytes: input.bytes,
        sha256: input.sha256,
        readyAt: input.now,
        expiresAt: input.expiresAt,
        leaseOwner: null,
        updatedAt: input.now,
      })
      .where(this.leased(scope, input))
      .returning({ id: tenantDataExports.id });
    return rows.length === 1;
  }

  async markFailed(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly leaseOwner: string;
      readonly failureCode: string;
      readonly now: Date;
    },
  ): Promise<boolean> {
    const rows = await this.db
      .update(tenantDataExports)
      .set({
        state: 'FAILED',
        failureCode: input.failureCode,
        leaseOwner: null,
        updatedAt: input.now,
      })
      .where(this.leased(scope, input))
      .returning({ id: tenantDataExports.id });
    return rows.length === 1;
  }

  async release(
    scope: TenantContext,
    input: { readonly id: string; readonly leaseOwner: string; readonly now: Date },
  ): Promise<boolean> {
    const rows = await this.db
      .update(tenantDataExports)
      .set({ state: 'REQUESTED', leaseOwner: null, heartbeatAt: null, updatedAt: input.now })
      .where(this.leased(scope, input))
      .returning({ id: tenantDataExports.id });
    return rows.length === 1;
  }

  async expireDue(now: Date): Promise<number> {
    const rows = await this.db
      .update(tenantDataExports)
      .set({ state: 'EXPIRED', updatedAt: now })
      .where(and(eq(tenantDataExports.state, 'READY'), lte(tenantDataExports.expiresAt, now)))
      .returning({ id: tenantDataExports.id });
    return rows.length;
  }

  async pendingRemoval(limit: number): Promise<DataExportRow[]> {
    const rows = await this.db
      .select()
      .from(tenantDataExports)
      .where(and(eq(tenantDataExports.state, 'EXPIRED'), isNull(tenantDataExports.removedAt)))
      .orderBy(asc(tenantDataExports.expiresAt))
      .limit(limit);
    return rows.map(toRow);
  }

  async markRemoved(scope: TenantContext, id: string, now: Date): Promise<void> {
    await this.db
      .update(tenantDataExports)
      .set({ removedAt: now, updatedAt: now })
      .where(
        and(
          eq(tenantDataExports.tenantId, requireTenantId(scope)),
          eq(tenantDataExports.id, id),
          eq(tenantDataExports.state, 'EXPIRED'),
        ),
      );
  }

  async statesOf(ids: readonly string[]) {
    if (ids.length === 0) return [];
    const rows = await this.db
      .select({
        id: tenantDataExports.id,
        state: tenantDataExports.state,
        fileName: tenantDataExports.fileName,
      })
      .from(tenantDataExports)
      .where(inArray(tenantDataExports.id, [...ids]));
    return rows.map((r) => ({ id: r.id, state: r.state as DataExportState, fileName: r.fileName }));
  }

  /** The row, still RUNNING and still this worker's. */
  private leased(
    scope: TenantContext,
    input: { readonly id: string; readonly leaseOwner: string },
  ) {
    return and(
      eq(tenantDataExports.tenantId, requireTenantId(scope)),
      eq(tenantDataExports.id, input.id),
      eq(tenantDataExports.state, 'RUNNING'),
      eq(tenantDataExports.leaseOwner, input.leaseOwner),
    );
  }
}
