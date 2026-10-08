import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import type { LegacyWalletDebtState, TenantContext } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import { legacyWalletDebts } from '../../../../infrastructure/persistence/schema.js';
import type {
  LegacyWalletDebtAggregate,
  LegacyWalletDebtDecisionChange,
  LegacyWalletDebtFacts,
  LegacyWalletDebtListFilter,
  LegacyWalletDebtRecord,
  LegacyWalletDebtRepository,
} from '../application/ports.js';

type Row = typeof legacyWalletDebts.$inferSelect;

function toRecord(row: Row): LegacyWalletDebtRecord {
  return {
    id: row.id,
    customerId: row.customerId,
    legacyUserId: row.legacyUserId,
    amountMinor: row.amountMinor,
    currency: row.currency as 'IRT',
    sourceFingerprint: row.sourceFingerprint,
    rowChecksum: row.rowChecksum,
    runId: row.runId,
    synthetic: row.synthetic,
    state: row.state as LegacyWalletDebtState,
    decisionReason: row.decisionReason,
    decidedByAdminId: row.decidedByAdminId,
    decidedAt: row.decidedAt,
    version: row.version,
    recordedAt: row.recordedAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Mirza migration PR4 — `legacy_wallet_debts`. Every statement is tenant-scoped; the only
 * UPDATE is the conditional decision (0227 refuses any change to a recorded fact) and there
 * is no DELETE.
 */
export class DrizzleLegacyWalletDebtRepository implements LegacyWalletDebtRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: TransactionScope): Executor {
    return tx?.tx ?? this.db;
  }

  private async findOne(
    scope: TenantContext,
    where: ReturnType<typeof eq>,
    tx?: TransactionScope,
    forUpdate = false,
  ): Promise<LegacyWalletDebtRecord | null> {
    const tenantId = requireTenantId(scope);
    const query = this.exec(tx)
      .select()
      .from(legacyWalletDebts)
      .where(and(eq(legacyWalletDebts.tenantId, tenantId), where))
      .limit(1);
    const rows = forUpdate ? await query.for('update') : await query;
    return rows[0] === undefined ? null : toRecord(rows[0]);
  }

  findById(
    scope: TenantContext,
    id: string,
    tx?: TransactionScope,
    options: { readonly forUpdate?: boolean } = {},
  ): Promise<LegacyWalletDebtRecord | null> {
    return this.findOne(scope, eq(legacyWalletDebts.id, id), tx, options.forUpdate === true);
  }

  findByCustomer(
    scope: TenantContext,
    customerId: string,
    tx: TransactionScope,
  ): Promise<LegacyWalletDebtRecord | null> {
    return this.findOne(scope, eq(legacyWalletDebts.customerId, customerId), tx);
  }

  findByLegacyUserId(
    scope: TenantContext,
    legacyUserId: string,
    tx: TransactionScope,
  ): Promise<LegacyWalletDebtRecord | null> {
    return this.findOne(scope, eq(legacyWalletDebts.legacyUserId, legacyUserId), tx);
  }

  async insertIfAbsent(
    scope: TenantContext,
    facts: LegacyWalletDebtFacts,
    tx: TransactionScope,
  ): Promise<{ readonly debt: LegacyWalletDebtRecord; readonly inserted: boolean }> {
    const tenantId = requireTenantId(scope);
    const inserted = await this.exec(tx)
      .insert(legacyWalletDebts)
      .values({
        ...facts,
        tenantId,
        state: 'PENDING_REVIEW',
        decisionReason: null,
        decidedByAdminId: null,
        decidedAt: null,
        version: 1,
        updatedAt: facts.recordedAt,
      })
      // Either key: one debt per customer, one per legacy user id.
      .onConflictDoNothing()
      .returning();
    if (inserted[0] !== undefined) return { debt: toRecord(inserted[0]), inserted: true };
    const existing =
      (await this.findByCustomer(scope, facts.customerId, tx)) ??
      (await this.findByLegacyUserId(scope, facts.legacyUserId, tx));
    if (existing === null) {
      throw new Error('legacy wallet debt insert conflicted, yet no row holds either key');
    }
    return { debt: existing, inserted: false };
  }

  async decide(
    scope: TenantContext,
    id: string,
    guard: { readonly from: readonly LegacyWalletDebtState[]; readonly version: number },
    change: LegacyWalletDebtDecisionChange,
    tx: TransactionScope,
  ): Promise<LegacyWalletDebtRecord | null> {
    if (guard.from.length === 0) throw new Error('a transition names its from-states');
    const tenantId = requireTenantId(scope);
    const updated = await this.exec(tx)
      .update(legacyWalletDebts)
      .set({
        state: change.state,
        decisionReason: change.decisionReason,
        decidedByAdminId: change.decidedByAdminId,
        decidedAt: change.decidedAt,
        updatedAt: change.updatedAt,
        version: sql`${legacyWalletDebts.version} + 1`,
      })
      .where(
        and(
          eq(legacyWalletDebts.tenantId, tenantId),
          eq(legacyWalletDebts.id, id),
          inArray(legacyWalletDebts.state, [...guard.from]),
          eq(legacyWalletDebts.version, guard.version),
        ),
      )
      .returning();
    return updated[0] === undefined ? null : toRecord(updated[0]);
  }

  async list(
    scope: TenantContext,
    filter: LegacyWalletDebtListFilter,
  ): Promise<readonly LegacyWalletDebtRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.db
      .select()
      .from(legacyWalletDebts)
      .where(
        and(
          eq(legacyWalletDebts.tenantId, tenantId),
          ...(filter.state === undefined ? [] : [eq(legacyWalletDebts.state, filter.state)]),
          ...(filter.legacyUserId === undefined
            ? []
            : [eq(legacyWalletDebts.legacyUserId, filter.legacyUserId)]),
          ...(filter.after === undefined ? [] : [gt(legacyWalletDebts.id, filter.after)]),
        ),
      )
      .orderBy(asc(legacyWalletDebts.id))
      .limit(filter.limit);
    return rows.map(toRecord);
  }

  async aggregate(
    scope: TenantContext,
  ): Promise<Readonly<Partial<Record<LegacyWalletDebtState, LegacyWalletDebtAggregate>>>> {
    const tenantId = requireTenantId(scope);
    const rows = await this.db
      .select({
        state: legacyWalletDebts.state,
        count: sql<number>`count(*)::int`,
        sumMinor: sql<string>`COALESCE(sum(${legacyWalletDebts.amountMinor}), 0)::text`,
      })
      .from(legacyWalletDebts)
      .where(eq(legacyWalletDebts.tenantId, tenantId))
      .groupBy(legacyWalletDebts.state);
    const out: Partial<Record<LegacyWalletDebtState, LegacyWalletDebtAggregate>> = {};
    for (const row of rows) {
      out[row.state as LegacyWalletDebtState] = {
        count: Number(row.count),
        sumMinor: BigInt(row.sumMinor),
      };
    }
    return out;
  }
}
