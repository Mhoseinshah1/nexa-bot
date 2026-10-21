import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  settingDefinition,
  type BotInstanceId,
  type Clock,
  type FeatureFlagKey,
  type SettingKey,
  type TenantContext,
} from '@nexa/contracts';
import { DrizzleCustomerNotificationRepository } from '../../apps/api/src/modules/commerce/messaging/infrastructure/drizzle-customer-notification.repository';
import { CustomerNotifier } from '../../apps/api/src/modules/commerce/messaging/application/customer-notifier';
import { DrizzleServiceReminderRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service-reminder.repository';
import { DrizzleServiceRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service.repository';
import { ServiceReminderService } from '../../apps/api/src/modules/commerce/provisioning/application/service-reminder.service';
import { AudienceFixtures } from './audience-fixtures';
import { createTestContext, SEED_IDS, tenantA, type TestContext } from './harness';

/**
 * Round 5C-2 group A — the usage notices that followed the R5A-2 backfill.
 *
 * The backfill used to write the figure ON THE ROW as the baseline whenever the service had
 * ever been measured (`usage_synced_at IS NOT NULL`). For an installation imported weeks
 * earlier that figure is the import's, weeks old; the first SYNC_USAGE on the new release then
 * read the panel's CURRENT figure, which had crossed 80 / 90 / 100 % since, and the sweep
 * announced it as a crossing. The rule (R5A PR-1) is that the first figure RECORDED after the
 * takeover is silent and marks every threshold it has reached as passed; only a later sync
 * that crosses a new threshold is told. Synthetic data only.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const GIB = 1_073_741_824n;
const LIMIT = 50n * GIB;
const DAY_MS = 86_400_000;
const T0 = new Date('2026-09-01T08:00:00.000Z'); // the import, weeks ago
const T1 = T0.getTime() + 40 * DAY_MS; // the worker starts on the R5A-2 release (backfill)
const pct = (p: bigint): bigint => (LIMIT * p) / 100n;

describe('Round 5C-2 A: the first usage figure after the backfill is silent', () => {
  let ctx: TestContext;
  let fx: AudienceFixtures;
  let panel: string;
  let product: string;

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 600_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    fx = new AudienceFixtures(ctx, tenantA.tenantId as string);
    await ctx.container.database.db.execute(
      sql`UPDATE tenants SET display_timezone = 'UTC', calendar = 'gregorian' WHERE id = ${tenantA.tenantId}`,
    );
    panel = await fx.panel('import');
    product = await fx.product(panel);
  }, 300_000);

  const at = (ms: number): Clock => ({ now: () => new Date(ms) });
  const settings = {
    valueOf: async <T>(_scope: unknown, key: SettingKey) =>
      settingDefinition(key).defaultValue as T,
  };
  const features = { isEnabled: async (_scope: unknown, _key: FeatureFlagKey) => true };
  const lane = (ms: number): ServiceReminderService =>
    new ServiceReminderService({
      reminders: new DrizzleServiceReminderRepository(ctx.container.database.db),
      settings,
      features,
      notifier: new CustomerNotifier({
        notifications: new DrizzleCustomerNotificationRepository(ctx.container.database.db),
        bots: { botFor: async () => BOT_A },
        ids: ctx.container.ids,
      }),
      scopeActivity: ctx.container.tenants,
      uow: ctx.container.uow,
      clock: at(ms),
      ids: ctx.container.ids,
      audit: ctx.container.audit,
    });
  const servicesRepo = () => new DrizzleServiceRepository(ctx.container.database.db);
  const exec = (query: ReturnType<typeof sql>) => ctx.container.database.db.execute(query);
  const kindsSent = async (): Promise<string[]> =>
    (
      (await exec(sql`SELECT kind FROM customer_notifications ORDER BY kind`)).rows as {
        kind: string;
      }[]
    ).map((row) => row.kind);

  /** One imported service (source MIRZA), no baseline row, as a pre-baseline release left it. */
  async function importOne(n: number, measuredBytes: bigint | null): Promise<string> {
    const result = await exec(sql`
      WITH ids AS (SELECT gen_random_uuid() AS c, gen_random_uuid() AS o, gen_random_uuid() AS s),
      cu AS (
        INSERT INTO customers (id, tenant_id, telegram_user_id, status, first_seen_at, created_at)
        SELECT c, ${tenantA.tenantId}, ${String(7300000000 + n)}, 'ACTIVE', ${T0}, ${T0} FROM ids
        RETURNING id
      ),
      od AS (
        INSERT INTO orders
          (id, tenant_id, customer_id, state, purpose, product_id, panel_id, line_title,
           line_duration_days, line_traffic_bytes, line_unit_price_amount, line_quantity,
           subtotal_amount, discount_amount, total_amount, currency, quote, settled_at,
           confirmed_at)
        SELECT o, ${tenantA.tenantId}, c, 'PAID', 'NEW_SERVICE', ${product}, ${panel}, 'plan',
               90, ${LIMIT}::bigint, 250000, 1, 250000, 0, 250000, 'IRT', '{}'::jsonb, ${T0}, ${T0}
          FROM ids
        RETURNING id
      )
      INSERT INTO services
        (id, tenant_id, customer_id, order_id, panel_id, product_id, provider_username, state,
         delivery_state, traffic_limit_bytes, traffic_used_bytes, usage_synced_at, expires_at,
         provisioned_at, delivered_at, created_at, updated_at, source, source_ref)
      SELECT s, ${tenantA.tenantId}, c, o, ${panel}, ${product}, ${'imp' + n}, 'ACTIVE',
             'DELIVERED', ${LIMIT}::bigint, ${measuredBytes ?? 0n}::bigint,
             ${measuredBytes === null ? null : T0}::timestamptz,
             ${new Date(T0.getTime() + 365 * DAY_MS)},
             ${T0}, ${T0}, ${T0}, ${T0}, 'MIRZA', ${'invoice:' + n}
        FROM ids
      RETURNING id`);
    return (result.rows as { id: string }[])[0]?.id ?? '';
  }

  /** The panel's answer to a SYNC_USAGE, written the way the provisioner writes it. */
  async function sync(id: string, usedBytes: bigint, ms: number): Promise<void> {
    await ctx.container.uow.run(tenantA, async (tx) => {
      await servicesRepo().recordUsage(tenantA, id, { usedBytes, syncedAt: new Date(ms) }, tx);
    });
  }

  async function sweep(ms: number): Promise<number> {
    const report = await lane(ms).runOnce(tenantA as TenantContext);
    return report.usage;
  }

  it('backfill with no usage figure, then a 90 % sync: 0 notices; a later crossing: exactly 1', async () => {
    const id = await importOne(1, null);
    await lane(T1).reconcileImportedNotices(tenantA as TenantContext, { unbounded: true });
    expect(await sweep(T1 + 1_000)).toBe(0);

    await sync(id, pct(90n), T1 + 60_000);
    expect(await sweep(T1 + 61_000)).toBe(0);
    expect(await kindsSent()).toEqual([]);

    await sync(id, pct(100n), T1 + 120_000);
    expect(await sweep(T1 + 121_000)).toBe(1);
    expect(await kindsSent()).toEqual(['SERVICE_USAGE_FINAL']);
  }, 120_000);

  it('backfill of a service measured WEEKS ago at 30 %, then a 92 % sync: 0 notices; a later crossing: exactly 1', async () => {
    // The row holds the import's stale figure: usage_synced_at = T0, long before the takeover.
    const id = await importOne(2, pct(30n));
    await lane(T1).reconcileImportedNotices(tenantA as TenantContext, { unbounded: true });
    expect(await sweep(T1 + 1_000)).toBe(0);

    // The first figure recorded after the takeover has crossed FIRST and SECOND since the
    // import: history, recorded as passed, never announced.
    await sync(id, pct(92n), T1 + 60_000);
    expect(await sweep(T1 + 61_000)).toBe(0);
    expect(await kindsSent()).toEqual([]);
    // The baseline now carries the first post-takeover figure, not the import's.
    const baseline = (
      (
        await exec(sql`SELECT used_bytes::text AS u FROM service_reminder_baselines
                       WHERE service_id = ${id}`)
      ).rows as { u: string }[]
    )[0]?.u;
    expect(baseline).toBe(pct(92n).toString());

    await sync(id, pct(100n), T1 + 120_000);
    expect(await sweep(T1 + 121_000)).toBe(1);
    expect(await kindsSent()).toEqual(['SERVICE_USAGE_FINAL']);
    // And nothing more on the same figure.
    expect(await sweep(T1 + 180_000)).toBe(0);
  }, 120_000);

  it('NO baseline row at all (the provisioner syncs before the backfill ran): a 92 % sync over a 30 % import figure is silent and is the baseline; a later crossing: exactly 1', async () => {
    const id = await importOne(6, pct(30n));
    // No reconcile: the INSERT path of the baseline is the one taken.
    await sync(id, pct(92n), T1 + 60_000);
    expect(await sweep(T1 + 61_000)).toBe(0);
    expect(await kindsSent()).toEqual([]);
    const baseline = (
      (
        await exec(sql`SELECT used_bytes::text AS u FROM service_reminder_baselines
                       WHERE service_id = ${id}`)
      ).rows as { u: string }[]
    )[0]?.u;
    expect(baseline).toBe(pct(92n).toString());

    await sync(id, pct(100n), T1 + 120_000);
    expect(await sweep(T1 + 121_000)).toBe(1);
    expect(await kindsSent()).toEqual(['SERVICE_USAGE_FINAL']);
  }, 120_000);

  it('a stale 85 % row reading 100 % at the first sync is silent too', async () => {
    const id = await importOne(3, pct(85n));
    await lane(T1).reconcileImportedNotices(tenantA as TenantContext, { unbounded: true });
    await sync(id, pct(100n), T1 + 60_000);
    expect(await sweep(T1 + 61_000)).toBe(0);
    expect(await kindsSent()).toEqual([]);
  }, 120_000);

  it('migration 0269: a stale backfill baseline is reset, its PENDING usage notice is SUPERSEDED with an audit row, and a sync-written baseline is left alone', async () => {
    const leaked = await importOne(4, pct(30n));
    const synced = await importOne(5, pct(30n));
    // What the OLD backfill left: one instant, a stale figure, and its batch audit row.
    await exec(sql`
      INSERT INTO service_reminder_baselines
        (tenant_id, service_id, baseline_at, basis_expires_at, basis_traffic_limit_bytes,
         used_bytes, created_at)
      SELECT tenant_id, id, ${new Date(T1)}, expires_at, traffic_limit_bytes,
             traffic_used_bytes, ${new Date(T1)}
        FROM services WHERE id = ${leaked}`);
    // A baseline the sync itself wrote (created after the baseline_at it carries): not the backfill's.
    await exec(sql`
      INSERT INTO service_reminder_baselines
        (tenant_id, service_id, baseline_at, basis_expires_at, basis_traffic_limit_bytes,
         used_bytes, created_at)
      SELECT tenant_id, id, created_at, expires_at, traffic_limit_bytes,
             traffic_used_bytes, ${new Date(T1 + 60_000)}
        FROM services WHERE id = ${synced}`);
    await exec(sql`
      INSERT INTO audit_logs (id, tenant_id, occurred_at, actor_type, actor_label, action,
                              entity_type, correlation_id, source_surface, result)
      VALUES (gen_random_uuid(), ${tenantA.tenantId}, ${new Date(T1)}, 'SYSTEM_JOB',
              'job:service-reminders', 'service_reminder.imported_baselines_backfilled',
              'Service', 'test', 'WORKER', 'SUCCESS')`);
    // The notice the first post-backfill sync queued.
    const row = (
      await exec(sql`SELECT customer_id, expires_at::text AS e, traffic_limit_bytes::text AS l
                       FROM services WHERE id = ${leaked}`)
    ).rows[0] as { customer_id: string; e: string; l: string };
    const reminderId = ctx.container.ids.uuid();
    await ctx.container.uow.run(tenantA, async (tx) => {
      await new DrizzleServiceReminderRepository(ctx.container.database.db).raise(
        tenantA,
        {
          id: reminderId,
          serviceId: leaked,
          kind: 'USAGE_FIRST',
          basis: { expiresAt: row.e, trafficLimitBytes: BigInt(row.l) },
          snapshot: { serviceLabel: 'x', remainingDays: 300, usedBytes: pct(85n) },
        },
        new Date(T1 + 60_000),
        tx,
      );
      await new CustomerNotifier({
        notifications: new DrizzleCustomerNotificationRepository(ctx.container.database.db),
        bots: { botFor: async () => BOT_A },
        ids: ctx.container.ids,
      }).notify(
        tenantA,
        row.customer_id as never,
        'SERVICE_USAGE_FIRST',
        reminderId,
        new Date(T1 + 60_000),
        tx,
      );
    });
    expect((await exec(sql`SELECT state FROM customer_notifications`)).rows).toEqual([
      { state: 'PENDING' },
    ]);

    const migration = readFileSync(
      join(__dirname, '../../apps/api/drizzle/0269_backfill_baselines_unmeasured.sql'),
      'utf8',
    );
    for (const statement of migration.split('--> statement-breakpoint')) {
      await exec(sql.raw(statement));
    }

    const figures = (await exec(sql`SELECT service_id, used_bytes FROM service_reminder_baselines`))
      .rows as { service_id: string; used_bytes: string | null }[];
    expect(figures.find((r) => r.service_id === leaked)?.used_bytes).toBeNull();
    expect(figures.find((r) => r.service_id === synced)?.used_bytes).not.toBeNull();
    expect(
      (
        await exec(sql`SELECT before->>'baselinesWithFigure' AS b, after->>'baselinesWithFigure' AS a
                         FROM audit_logs
                        WHERE action = 'service_reminder.backfill_baselines_reset_to_unmeasured'`)
      ).rows,
    ).toEqual([{ b: '1', a: '0' }]);

    // The worker start: the existing reconcile moves the queued notice, one audit row per batch.
    await lane(T1 + 120_000).reconcileImportedNotices(tenantA as TenantContext, {
      unbounded: true,
    });
    expect((await exec(sql`SELECT state FROM customer_notifications`)).rows).toEqual([
      { state: 'SUPERSEDED' },
    ]);
    expect(
      (
        await exec(sql`SELECT count(*)::int AS n FROM audit_logs
                         WHERE action = 'service_reminder.imported_usage_notices_superseded'`)
      ).rows,
    ).toEqual([{ n: 1 }]);
  }, 120_000);
});
