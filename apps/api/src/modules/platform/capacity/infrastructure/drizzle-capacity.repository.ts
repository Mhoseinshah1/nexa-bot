import { and, asc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { CapacityLimit, CapacityResource, HeavyJobKind, TenantStatus } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  heavyJobTickets,
  tenantCapacityLimits,
  tenants,
} from '../../../../infrastructure/persistence/schema.js';
import type {
  CapacityLimitRepository,
  CapacityTenantDirectory,
  CapacityTenantRow,
  HeavyJobQueueRepository,
  HeavyJobTicket,
} from '../application/ports.js';

function exec(db: Database, tx?: unknown): Executor {
  return (tx as TransactionScope | undefined)?.tx ?? db;
}

function limitOf(row: { mode: string; value: number | null }): CapacityLimit {
  return row.mode === 'UNLIMITED'
    ? { mode: 'UNLIMITED' }
    : { mode: 'LIMITED', value: row.value ?? 0 };
}

export class DrizzleCapacityLimitRepository
  implements CapacityLimitRepository, CapacityTenantDirectory
{
  constructor(private readonly db: Database) {}

  async storedFor(
    tenantId: string,
    tx?: unknown,
  ): Promise<ReadonlyMap<CapacityResource, CapacityLimit>> {
    const rows = await exec(this.db, tx)
      .select()
      .from(tenantCapacityLimits)
      .where(eq(tenantCapacityLimits.tenantId, tenantId));
    return new Map(rows.map((row) => [row.resource as CapacityResource, limitOf(row)]));
  }

  async storedForAll(
    tx?: unknown,
  ): Promise<ReadonlyMap<string, ReadonlyMap<CapacityResource, CapacityLimit>>> {
    const rows = await exec(this.db, tx).select().from(tenantCapacityLimits);
    const byTenant = new Map<string, Map<CapacityResource, CapacityLimit>>();
    for (const row of rows) {
      const map = byTenant.get(row.tenantId) ?? new Map<CapacityResource, CapacityLimit>();
      map.set(row.resource as CapacityResource, limitOf(row));
      byTenant.set(row.tenantId, map);
    }
    return byTenant;
  }

  async put(
    input: {
      readonly tenantId: string;
      readonly resource: CapacityResource;
      readonly limit: CapacityLimit | null;
      readonly now: Date;
      readonly adminId: string | null;
    },
    tx: unknown,
  ): Promise<CapacityLimit | null> {
    const executor = exec(this.db, tx);
    const where = and(
      eq(tenantCapacityLimits.tenantId, input.tenantId),
      eq(tenantCapacityLimits.resource, input.resource),
    );
    const [before] = await executor.select().from(tenantCapacityLimits).where(where).for('update');
    if (input.limit === null) {
      await executor.delete(tenantCapacityLimits).where(where);
    } else {
      const values = {
        mode: input.limit.mode,
        value: input.limit.mode === 'LIMITED' ? input.limit.value : null,
        updatedAt: input.now,
        updatedByAdminId: input.adminId,
      };
      await executor
        .insert(tenantCapacityLimits)
        .values({ tenantId: input.tenantId, resource: input.resource, ...values })
        .onConflictDoUpdate({
          target: [tenantCapacityLimits.tenantId, tenantCapacityLimits.resource],
          set: values,
        });
    }
    return before === undefined ? null : limitOf(before);
  }

  async all(tx?: unknown): Promise<readonly CapacityTenantRow[]> {
    const rows = await exec(this.db, tx)
      .select({ id: tenants.id, displayName: tenants.displayName, status: tenants.status })
      .from(tenants)
      .orderBy(asc(tenants.createdAt), asc(tenants.id));
    return rows.map((row) => ({ ...row, status: row.status as TenantStatus }));
  }

  async find(tenantId: string, tx?: unknown): Promise<CapacityTenantRow | null> {
    const [row] = await exec(this.db, tx)
      .select({ id: tenants.id, displayName: tenants.displayName, status: tenants.status })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    return row === undefined ? null : { ...row, status: row.status as TenantStatus };
  }
}

/**
 * The heavy-job queue. Every decision is taken inside one transaction holding a
 * transaction-scoped advisory lock: the queue is one installation-wide line, and two
 * worker replicas (or a worker and a CLI) deciding "am I first, is a slot free" at the same
 * moment must see each other's answers.
 */
export const HEAVY_JOB_QUEUE_LOCK_KEY = 0x6e_65_78_61_68_6a; // 'nexahj'

export class DrizzleHeavyJobQueueRepository implements HeavyJobQueueRepository {
  constructor(private readonly db: Database) {}

  async enqueue(input: {
    readonly id: string;
    readonly tenantId: string;
    readonly kind: HeavyJobKind;
    readonly priority: number;
    readonly now: Date;
    readonly leaseUntil: Date;
  }): Promise<void> {
    await this.db.insert(heavyJobTickets).values({
      id: input.id,
      tenantId: input.tenantId,
      kind: input.kind,
      state: 'QUEUED',
      priority: input.priority,
      enqueuedAt: input.now,
      leaseUntil: input.leaseUntil,
    });
  }

  async tryStart(
    id: string,
    input: { readonly now: Date; readonly leaseUntil: Date; readonly concurrency: number },
  ): Promise<HeavyJobTicket['state'] | null> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${HEAVY_JOB_QUEUE_LOCK_KEY})`);
      // A holder that stopped refreshing its lease is gone: its place is given up.
      await tx
        .update(heavyJobTickets)
        .set({ state: 'ABANDONED', finishedAt: input.now })
        .where(
          and(
            inArray(heavyJobTickets.state, ['QUEUED', 'RUNNING']),
            lt(heavyJobTickets.leaseUntil, input.now),
          ),
        );
      const [mine] = await tx.select().from(heavyJobTickets).where(eq(heavyJobTickets.id, id));
      if (mine === undefined) return null;
      if (mine.state !== 'QUEUED') {
        if (mine.state === 'RUNNING') {
          await tx
            .update(heavyJobTickets)
            .set({ leaseUntil: input.leaseUntil })
            .where(eq(heavyJobTickets.id, id));
        }
        return mine.state as HeavyJobTicket['state'];
      }
      const live = await tx
        .select({ id: heavyJobTickets.id, state: heavyJobTickets.state })
        .from(heavyJobTickets)
        .where(inArray(heavyJobTickets.state, ['QUEUED', 'RUNNING']))
        .orderBy(
          sql`${heavyJobTickets.priority} DESC`,
          asc(heavyJobTickets.enqueuedAt),
          asc(heavyJobTickets.id),
        );
      const running = live.filter((row) => row.state === 'RUNNING').length;
      const first = live.find((row) => row.state === 'QUEUED');
      if (running < input.concurrency && first?.id === id) {
        await tx
          .update(heavyJobTickets)
          .set({ state: 'RUNNING', startedAt: input.now, leaseUntil: input.leaseUntil })
          .where(and(eq(heavyJobTickets.id, id), eq(heavyJobTickets.state, 'QUEUED')));
        return 'RUNNING';
      }
      await tx
        .update(heavyJobTickets)
        .set({ leaseUntil: input.leaseUntil })
        .where(and(eq(heavyJobTickets.id, id), eq(heavyJobTickets.state, 'QUEUED')));
      return 'QUEUED';
    });
  }

  async heartbeat(id: string, leaseUntil: Date): Promise<void> {
    await this.db
      .update(heavyJobTickets)
      .set({ leaseUntil })
      .where(
        and(eq(heavyJobTickets.id, id), inArray(heavyJobTickets.state, ['QUEUED', 'RUNNING'])),
      );
  }

  async finish(id: string, now: Date): Promise<void> {
    await this.db
      .update(heavyJobTickets)
      .set({
        state: 'DONE',
        finishedAt: now,
        startedAt: sql`COALESCE(${heavyJobTickets.startedAt}, ${now})`,
      })
      .where(
        and(eq(heavyJobTickets.id, id), inArray(heavyJobTickets.state, ['QUEUED', 'RUNNING'])),
      );
  }

  async purgeFinished(before: Date): Promise<number> {
    const rows = await this.db
      .delete(heavyJobTickets)
      .where(
        and(
          inArray(heavyJobTickets.state, ['DONE', 'ABANDONED']),
          lt(heavyJobTickets.finishedAt, before),
        ),
      )
      .returning({ id: heavyJobTickets.id });
    return rows.length;
  }
}
