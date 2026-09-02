import { and, eq, sql } from 'drizzle-orm';
import type { ScopeContext, SettingKey } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import { settingValues } from '../../../../infrastructure/persistence/schema.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import type { SettingRepository, StoredSetting } from '../application/ports.js';

type Row = typeof settingValues.$inferSelect;

function toStored(row: Row): StoredSetting {
  return {
    key: row.settingKey as SettingKey,
    value: row.value,
    version: row.version,
    updatedAt: row.updatedAt,
    updatedByAdminId: row.updatedByAdminId,
  };
}

function executorOf(db: Database, tx?: unknown): Executor {
  return (tx as TransactionScope | undefined)?.tx ?? db;
}

export class DrizzleSettingRepository implements SettingRepository {
  constructor(private readonly db: Database) {}

  async findAll(scope: ScopeContext, tx?: unknown): Promise<StoredSetting[]> {
    const tenantId = requireTenantId(scope);
    const rows = await executorOf(this.db, tx)
      .select()
      .from(settingValues)
      .where(eq(settingValues.tenantId, tenantId));
    return rows.map(toStored);
  }

  async find(scope: ScopeContext, key: SettingKey, tx?: unknown): Promise<StoredSetting | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await executorOf(this.db, tx)
      .select()
      .from(settingValues)
      .where(and(eq(settingValues.tenantId, tenantId), eq(settingValues.settingKey, key)))
      .limit(1);
    return row ? toStored(row) : null;
  }

  async upsert(
    scope: ScopeContext,
    input: {
      readonly id: string;
      readonly key: SettingKey;
      readonly value: unknown;
      readonly expectedVersion: number | null;
      readonly now: Date;
      readonly adminId: string | null;
    },
    tx?: unknown,
  ): Promise<StoredSetting | null> {
    const tenantId = requireTenantId(scope);
    const executor = executorOf(this.db, tx);

    // A first write. `ON CONFLICT DO NOTHING` rather than a prior SELECT: if a
    // row appeared between the caller reading "no value" and this statement,
    // zero rows come back and the caller reports the conflict. A SELECT would
    // have decided the answer before the window it is trying to close.
    if (input.expectedVersion === null) {
      const inserted = await executor
        .insert(settingValues)
        .values({
          id: input.id,
          tenantId,
          settingKey: input.key,
          value: input.value,
          version: 1,
          updatedAt: input.now,
          updatedByAdminId: input.adminId,
        })
        .onConflictDoNothing()
        .returning();
      return inserted[0] ? toStored(inserted[0]) : null;
    }

    const updated = await executor
      .update(settingValues)
      .set({
        value: input.value,
        version: sql`${settingValues.version} + 1`,
        updatedAt: input.now,
        updatedByAdminId: input.adminId,
      })
      .where(
        and(
          eq(settingValues.tenantId, tenantId),
          eq(settingValues.settingKey, input.key),
          eq(settingValues.version, input.expectedVersion),
        ),
      )
      .returning();
    return updated[0] ? toStored(updated[0]) : null;
  }
}
