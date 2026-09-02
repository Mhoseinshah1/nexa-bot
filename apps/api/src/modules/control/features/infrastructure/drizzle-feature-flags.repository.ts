import { and, eq, sql } from 'drizzle-orm';
import type { FeatureFlagKey, ScopeContext } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import { featureFlagStates } from '../../../../infrastructure/persistence/schema.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import type { FeatureFlagRepository, StoredFeatureFlag } from '../application/ports.js';

type Row = typeof featureFlagStates.$inferSelect;

function toStored(row: Row): StoredFeatureFlag {
  return {
    key: row.flagKey as FeatureFlagKey,
    enabled: row.enabled,
    version: row.version,
    updatedAt: row.updatedAt,
    updatedByAdminId: row.updatedByAdminId,
    reason: row.reason,
  };
}

function executorOf(db: Database, tx?: unknown): Executor {
  return (tx as TransactionScope | undefined)?.tx ?? db;
}

export class DrizzleFeatureFlagRepository implements FeatureFlagRepository {
  constructor(private readonly db: Database) {}

  async findAll(scope: ScopeContext, tx?: unknown): Promise<StoredFeatureFlag[]> {
    const tenantId = requireTenantId(scope);
    const rows = await executorOf(this.db, tx)
      .select()
      .from(featureFlagStates)
      .where(eq(featureFlagStates.tenantId, tenantId));
    return rows.map(toStored);
  }

  async find(
    scope: ScopeContext,
    key: FeatureFlagKey,
    tx?: unknown,
  ): Promise<StoredFeatureFlag | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await executorOf(this.db, tx)
      .select()
      .from(featureFlagStates)
      .where(and(eq(featureFlagStates.tenantId, tenantId), eq(featureFlagStates.flagKey, key)))
      .limit(1);
    return row ? toStored(row) : null;
  }

  async upsert(
    scope: ScopeContext,
    input: {
      readonly id: string;
      readonly key: FeatureFlagKey;
      readonly enabled: boolean;
      readonly expectedVersion: number | null;
      readonly reason: string | null;
      readonly now: Date;
      readonly adminId: string | null;
    },
    tx?: unknown,
  ): Promise<StoredFeatureFlag | null> {
    const tenantId = requireTenantId(scope);
    const executor = executorOf(this.db, tx);

    if (input.expectedVersion === null) {
      const inserted = await executor
        .insert(featureFlagStates)
        .values({
          id: input.id,
          tenantId,
          flagKey: input.key,
          enabled: input.enabled,
          version: 1,
          updatedAt: input.now,
          updatedByAdminId: input.adminId,
          reason: input.reason,
        })
        .onConflictDoNothing()
        .returning();
      return inserted[0] ? toStored(inserted[0]) : null;
    }

    const updated = await executor
      .update(featureFlagStates)
      .set({
        enabled: input.enabled,
        version: sql`${featureFlagStates.version} + 1`,
        updatedAt: input.now,
        updatedByAdminId: input.adminId,
        reason: input.reason,
      })
      .where(
        and(
          eq(featureFlagStates.tenantId, tenantId),
          eq(featureFlagStates.flagKey, input.key),
          eq(featureFlagStates.version, input.expectedVersion),
        ),
      )
      .returning();
    return updated[0] ? toStored(updated[0]) : null;
  }
}
