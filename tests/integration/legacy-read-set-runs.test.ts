import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { systemJobActor, type CorrelationId } from '@nexa/contracts';
import { runInventory } from '../../apps/api/src/legacy-import-inventory';
import { readImportV1Identity } from '../../apps/api/src/modules/platform/legacy-importer/application/source-snapshot';
import { FixtureLegacySourceConnector } from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/fixture-legacy-source';
import { buildSyntheticLegacyDataset } from '../fixtures/legacy/synthetic-legacy';
import { changedTables, databaseFingerprint } from '../support/database-fingerprint';
import { createTestContext, tenantA, tenantB, type TestContext } from './harness';

/**
 * Mirza migration PR1 — `legacy_read_set_runs` and `legacy-import inventory` against
 * PostgreSQL, on the SYNTHETIC fixture. NOT EVIDENCE about the legacy archive.
 */

describe('Mirza PR1: read set runs', () => {
  let ctx: TestContext;
  const actor = systemJobActor('legacy-import:inventory', 'corr-inventory' as CorrelationId);
  const connector = () => new FixtureLegacySourceConnector(buildSyntheticLegacyDataset() as never);
  const db = () => ctx.container.database.db;
  let approved: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    approved = (await readImportV1Identity(await connector().open())).fingerprint;
  }, 600_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
  });

  const inventory = (expectedFingerprint: string | null, scope = tenantA) =>
    runInventory(
      ctx.container.legacyImporter(),
      connector(),
      { expectedFingerprint },
      { scope, actor, productionLikeTarget: false },
    );

  /** The database's own refusal, under the driver's `Failed query` wrapper. */
  async function refusal(write: Promise<unknown>): Promise<string> {
    try {
      await write;
    } catch (error) {
      const e = error as { message?: string; cause?: { message?: string; constraint?: string } };
      return `${e.cause?.message ?? ''} ${e.cause?.constraint ?? ''} ${e.message ?? ''}`;
    }
    return 'ACCEPTED';
  }

  async function rows(tenantId: string) {
    const result = await db().execute<Record<string, unknown>>(
      sql`SELECT read_set, read_set_version, fingerprint_version, read_set_fingerprint,
                 source_fingerprint, source_engine, synthetic, table_count, row_count::text AS row_count
            FROM legacy_read_set_runs WHERE tenant_id = ${tenantId} ORDER BY recorded_at`,
    );
    return result.rows;
  }

  it('a bound inventory writes exactly one read set row and its audit row — nothing else', async () => {
    const before = await databaseFingerprint(db());
    const outcome = await inventory(approved);
    expect(outcome.recorded?.created).toBe(true);
    expect(Object.keys(changedTables(before, await databaseFingerprint(db()))).sort()).toEqual([
      'audit_logs',
      'legacy_read_set_runs',
    ]);
    expect(await rows(tenantA.tenantId as string)).toEqual([
      {
        read_set: 'inventory',
        read_set_version: 1,
        fingerprint_version: 'legacy-read-set:inventory:v1',
        read_set_fingerprint: outcome.inventory.fingerprint,
        source_fingerprint: approved,
        source_engine: 'SYNTHETIC_FIXTURE',
        synthetic: true,
        table_count: 5,
        row_count: '38',
      },
    ]);
    const audit = await db().execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM audit_logs
           WHERE action = 'legacy_import.read_set.record' AND result = 'SUCCESS'
             AND entity_id = ${outcome.recorded?.run.id ?? ''}`,
    );
    expect(audit.rows[0]?.n).toBe(1);
  });

  it('an unbound inventory writes nothing at all', async () => {
    const before = await databaseFingerprint(db());
    const outcome = await inventory(null);
    expect(outcome.recorded).toBeNull();
    expect(outcome.inventory.verdict).toBe('UNCLASSIFIED_TABLES');
    expect(changedTables(before, await databaseFingerprint(db()))).toEqual({});
  });

  it('a mismatching source writes nothing at all', async () => {
    const before = await databaseFingerprint(db());
    await expect(inventory('d'.repeat(64))).rejects.toThrow(/SOURCE_FINGERPRINT_MISMATCH/u);
    expect(changedTables(before, await databaseFingerprint(db()))).toEqual({});
  });

  it('observing the same thing again records no second row; another tenant has its own', async () => {
    const first = await inventory(approved);
    const second = await inventory(approved);
    expect(second.recorded?.created).toBe(false);
    expect(second.recorded?.run.id).toBe(first.recorded?.run.id);
    expect(await rows(tenantA.tenantId as string)).toHaveLength(1);
    const other = await inventory(approved, tenantB);
    expect(other.recorded?.created).toBe(true);
    expect(await rows(tenantB.tenantId as string)).toHaveLength(1);
  });

  it('a stopped tenant records nothing', async () => {
    await db().execute(sql`UPDATE tenants SET status = 'STOPPED' WHERE id = ${tenantA.tenantId}`);
    await expect(inventory(approved)).rejects.toThrow();
    expect(await rows(tenantA.tenantId as string)).toHaveLength(0);
  });

  it('the table refuses an UPDATE, a DELETE, an unknown read set and a forged version', async () => {
    await inventory(approved);
    expect(
      await refusal(db().execute(sql`UPDATE legacy_read_set_runs SET table_count = 0`)),
    ).toMatch(/append-only/u);
    expect(await refusal(db().execute(sql`DELETE FROM legacy_read_set_runs`))).toMatch(
      /append-only/u,
    );
    const insert = (readSet: string, version: string) =>
      db().execute(sql`
        INSERT INTO legacy_read_set_runs (id, tenant_id, read_set, read_set_version,
          fingerprint_version, read_set_fingerprint, source_fingerprint, source_schema_hash,
          source_engine, synthetic, table_count, row_count, recorded_at)
        VALUES (gen_random_uuid(), ${tenantA.tenantId}, ${readSet}, 1, ${version},
          ${'a'.repeat(64)}, ${'b'.repeat(64)}, ${'c'.repeat(64)}, 'MYSQL', false, 1, 1, now())`);
    // `invoice-archive` joined the set in Mirza PR3; a name no read set has is still refused.
    expect(await refusal(insert('payments', 'legacy-read-set:payments:v1'))).toMatch(
      /legacy_read_set_runs_read_set_check/u,
    );
    expect(await refusal(insert('invoice-archive', 'legacy-read-set:invoice-archive:v1'))).toBe(
      'ACCEPTED',
    );
    expect(await refusal(insert('inventory', 'legacy-read-set:inventory:v2'))).toMatch(
      /legacy_read_set_runs_version_check/u,
    );
    expect(await refusal(insert('inventory', 'legacy-read-set:inventory:v1'))).toBe('ACCEPTED');
  });
});
