import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, tenantA, type TestContext } from './harness';
import { SEED_IDS } from '../../apps/api/src/infrastructure/persistence/seed';

/**
 * NEXA v0.9.7 (PR-2): the retention defaults the owner set, read through the real settings
 * registry, and the migration that moves an installation which STORED the old dry-run mode.
 *
 * The defaults: published outbox history, operations-lane notifications (with their delivery
 * attempts and released claims) and interactive idempotency keys 7 days; customer
 * notifications and closed receipt windows 30 days; the data compaction in APPLY («حذف»).
 */

const MIGRATION = join(__dirname, '../../apps/api/drizzle/0311_compaction_mode_apply.sql');

describe('v0.9.7 retention defaults', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestContext();
  }, 60_000);

  afterAll(async () => {
    await context.close();
  });

  beforeEach(async () => {
    await context.reset();
  });

  const value = <T>(key: string): Promise<T> =>
    context.container.settingsResolver.valueOf<T>(tenantA, key as never);

  it('the registry defaults are the owner’s: 7 / 7 / 7 / 30 / 30 days and APPLY', async () => {
    expect(await value<number>('retention.outbox_published_days')).toBe(7);
    expect(await value<number>('retention.idempotency_interactive_days')).toBe(7);
    expect(await value<number>('retention.ops_notifications_days')).toBe(7);
    expect(await value<number>('retention.customer_notifications_days')).toBe(30);
    expect(await value<number>('retention.receipt_windows_days')).toBe(30);
    expect(await value<string>('retention.compaction_mode')).toBe('APPLY');
  });

  async function store(tenantId: string, key: string, json: string): Promise<void> {
    await context.container.database.db.execute(sql`
      INSERT INTO setting_values (id, tenant_id, setting_key, value, version)
      VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, ${key}, ${json}::jsonb, 3)
    `);
  }

  async function runMigration(): Promise<void> {
    const text = readFileSync(MIGRATION, 'utf8');
    for (const statement of text.split('--> statement-breakpoint')) {
      await context.container.database.db.execute(sql.raw(statement));
    }
  }

  it('the migration moves a stored DRY_RUN to APPLY, audited, and touches nothing else', async () => {
    await store(SEED_IDS.tenantA, 'retention.compaction_mode', '"DRY_RUN"');
    await store(SEED_IDS.tenantA, 'retention.ops_notifications_days', '90');
    await store(SEED_IDS.tenantB, 'retention.compaction_mode', '"APPLY"');

    await runMigration();

    const rows = await context.container.database.db.execute<{
      tenant_id: string;
      setting_key: string;
      value: unknown;
      version: number;
      updated_by_admin_id: string | null;
    }>(sql`SELECT tenant_id, setting_key, value, version, updated_by_admin_id
             FROM setting_values ORDER BY tenant_id, setting_key`);
    const of = (tenant: string, key: string) =>
      rows.rows.find((row) => row.tenant_id === tenant && row.setting_key === key);
    expect(of(SEED_IDS.tenantA, 'retention.compaction_mode')).toMatchObject({
      value: 'APPLY',
      version: 4,
      updated_by_admin_id: null,
    });
    // A stored day is the operator's choice and keeps its meaning.
    expect(of(SEED_IDS.tenantA, 'retention.ops_notifications_days')).toMatchObject({
      value: 90,
      version: 3,
    });
    expect(of(SEED_IDS.tenantB, 'retention.compaction_mode')).toMatchObject({
      value: 'APPLY',
      version: 3,
    });
    expect(await value<string>('retention.compaction_mode')).toBe('APPLY');

    const audit = await context.container.database.db.execute<{
      tenant_id: string;
      before: unknown;
      after: unknown;
      actor_type: string;
    }>(sql`SELECT tenant_id, before, after, actor_type FROM audit_logs
            WHERE action = 'settings.set' AND entity_id = 'retention.compaction_mode'`);
    expect(audit.rows).toEqual([
      {
        tenant_id: SEED_IDS.tenantA,
        before: { value: 'DRY_RUN', source: 'TENANT' },
        after: { value: 'APPLY', source: 'TENANT' },
        actor_type: 'SYSTEM_JOB',
      },
    ]);
    // A migration announces nothing.
    const events = await context.container.database.db.execute(
      sql`SELECT 1 FROM outbox_messages WHERE event_type = 'SettingChanged'`,
    );
    expect(events.rows).toHaveLength(0);

    // Idempotent: a second application changes and audits nothing more.
    await runMigration();
    const again = await context.container.database.db.execute(
      sql`SELECT 1 FROM audit_logs WHERE action = 'settings.set'`,
    );
    expect(again.rows).toHaveLength(1);
  });
});
