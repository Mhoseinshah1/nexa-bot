import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { ScopeContext, SettingKey } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import { panelSettingValues } from '../../../../infrastructure/persistence/schema.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import type { PanelSettingRepository, StoredSetting } from '../application/ports.js';

/**
 * Track 3 §2: `panel_setting_values`, read and written exactly as `DrizzleSettingRepository`
 * reads and writes `setting_values` — the value encoded once on the way in and read as text
 * and parsed once on the way out (that repository says why drizzle's own `jsonb` mapping
 * cannot round-trip a JSON string), and the version check inside the write's statement.
 */
function encodeValue(value: unknown): SQL {
  return sql`${JSON.stringify(value ?? null)}::jsonb`;
}

const SELECTION = {
  settingKey: panelSettingValues.settingKey,
  valueText: sql<string>`${panelSettingValues.value}::text`,
  version: panelSettingValues.version,
  updatedAt: panelSettingValues.updatedAt,
  updatedByAdminId: panelSettingValues.updatedByAdminId,
} as const;

interface SelectedRow {
  settingKey: string;
  valueText: string;
  version: number;
  updatedAt: Date;
  updatedByAdminId: string | null;
}

function toStored(row: SelectedRow): StoredSetting {
  return {
    key: row.settingKey as SettingKey,
    value: JSON.parse(row.valueText) as unknown,
    version: row.version,
    updatedAt: row.updatedAt,
    updatedByAdminId: row.updatedByAdminId,
  };
}

function executorOf(db: Database, tx?: unknown): Executor {
  return (tx as TransactionScope | undefined)?.tx ?? db;
}

export class DrizzlePanelSettingRepository implements PanelSettingRepository {
  constructor(private readonly db: Database) {}

  async findAll(scope: ScopeContext, panelId: string, tx?: unknown): Promise<StoredSetting[]> {
    const tenantId = requireTenantId(scope);
    const rows = await executorOf(this.db, tx)
      .select(SELECTION)
      .from(panelSettingValues)
      .where(
        and(eq(panelSettingValues.tenantId, tenantId), eq(panelSettingValues.panelId, panelId)),
      );
    return rows.map(toStored);
  }

  async find(
    scope: ScopeContext,
    panelId: string,
    key: SettingKey,
    tx?: unknown,
  ): Promise<StoredSetting | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await executorOf(this.db, tx)
      .select(SELECTION)
      .from(panelSettingValues)
      .where(
        and(
          eq(panelSettingValues.tenantId, tenantId),
          eq(panelSettingValues.panelId, panelId),
          eq(panelSettingValues.settingKey, key),
        ),
      )
      .limit(1);
    return row ? toStored(row) : null;
  }

  async upsert(
    scope: ScopeContext,
    input: {
      readonly id: string;
      readonly panelId: string;
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
    // A first write: `ON CONFLICT DO NOTHING`, so a row that appeared since the caller read
    // "no value" comes back as zero rows — a conflict — rather than being overwritten.
    if (input.expectedVersion === null) {
      const inserted = await executor
        .insert(panelSettingValues)
        .values({
          id: input.id,
          tenantId,
          panelId: input.panelId,
          settingKey: input.key,
          value: encodeValue(input.value),
          version: 1,
          updatedAt: input.now,
          updatedByAdminId: input.adminId,
        })
        .onConflictDoNothing()
        .returning(SELECTION);
      return inserted[0] ? toStored(inserted[0]) : null;
    }
    const updated = await executor
      .update(panelSettingValues)
      .set({
        value: encodeValue(input.value),
        version: sql`${panelSettingValues.version} + 1`,
        updatedAt: input.now,
        updatedByAdminId: input.adminId,
      })
      .where(
        and(
          eq(panelSettingValues.tenantId, tenantId),
          eq(panelSettingValues.panelId, input.panelId),
          eq(panelSettingValues.settingKey, input.key),
          eq(panelSettingValues.version, input.expectedVersion),
        ),
      )
      .returning(SELECTION);
    return updated[0] ? toStored(updated[0]) : null;
  }
}
