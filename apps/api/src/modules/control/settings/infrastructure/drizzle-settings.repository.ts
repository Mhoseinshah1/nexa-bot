import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { ScopeContext, SettingKey } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import { settingValues } from '../../../../infrastructure/persistence/schema.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import type { SettingRepository, StoredSetting } from '../application/ports.js';

/**
 * The `jsonb` value column, encoded and decoded explicitly.
 *
 * Drizzle's own `jsonb` mapping cannot round-trip a JSON string, and the failure
 * is silent. `mapFromDriverValue` re-parses anything that comes back as a
 * string — but `pg` has ALREADY parsed the column, so a stored `"-1001234567890"`
 * arrives as the JS string `-1001234567890`, gets JSON.parsed a second time, and
 * becomes the NUMBER -1001234567890. It then fails its own `z.string()` schema,
 * the resolver falls back to the default exactly as it should for a value that
 * no longer parses, and the API answers 201 for a setting that is not set.
 *
 * That is the legacy "reports success for a write that did not happen" pattern,
 * arrived at honestly. Every setting whose value is a string — a chat id, an
 * enum — would have been affected, and a value of `'true'` or `'{}'` would have
 * come back as a boolean or an object.
 *
 * So both directions are explicit here: encode once on the way in, and read the
 * column as text and parse it once on the way out. The stored shape stays the
 * value itself rather than a wrapper, so `select value from setting_values` in a
 * database client still shows something a person can read.
 */
function encodeValue(value: unknown): SQL {
  return sql`${JSON.stringify(value ?? null)}::jsonb`;
}

const VALUE_AS_TEXT = sql<string>`${settingValues.value}::text`;

function decodeValue(text: string): unknown {
  return JSON.parse(text) as unknown;
}

/** The columns every read returns, with the value in its text form. */
const SELECTION = {
  settingKey: settingValues.settingKey,
  valueText: VALUE_AS_TEXT,
  version: settingValues.version,
  updatedAt: settingValues.updatedAt,
  updatedByAdminId: settingValues.updatedByAdminId,
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
    value: decodeValue(row.valueText),
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
      .select(SELECTION)
      .from(settingValues)
      .where(eq(settingValues.tenantId, tenantId));
    return rows.map(toStored);
  }

  async find(scope: ScopeContext, key: SettingKey, tx?: unknown): Promise<StoredSetting | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await executorOf(this.db, tx)
      .select(SELECTION)
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
      .update(settingValues)
      .set({
        value: encodeValue(input.value),
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
      .returning(SELECTION);
    return updated[0] ? toStored(updated[0]) : null;
  }
}
