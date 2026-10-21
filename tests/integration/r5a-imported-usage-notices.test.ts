import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  settingDefinition,
  type BotInstanceId,
  type Clock,
  type FeatureFlagKey,
  type ServiceReminderKind,
  type SettingKey,
  type TenantContext,
} from '@nexa/contracts';
import { DrizzleCustomerNotificationRepository } from '../../apps/api/src/modules/commerce/messaging/infrastructure/drizzle-customer-notification.repository';
import { DrizzleNotificationSubjectReader } from '../../apps/api/src/modules/commerce/messaging/infrastructure/drizzle-notification-subject.reader';
import { CustomerNotifier } from '../../apps/api/src/modules/commerce/messaging/application/customer-notifier';
import { DrizzleServiceReminderRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service-reminder.repository';
import { DrizzleServiceRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service.repository';
import { ServiceReminderService } from '../../apps/api/src/modules/commerce/provisioning/application/service-reminder.service';
import { AudienceFixtures } from './audience-fixtures';
import { createTestContext, SEED_IDS, tenantA, type TestContext } from './harness';

/**
 * Round 5A item 1 — an imported service never produces a usage notice for a state that
 * already existed at its import.
 *
 * The services are written the way the `.nxpkg` import writes them: source `MIRZA`, born at
 * the import with NO usage measurement (`usage_synced_at` NULL, nothing used), each handed to
 * the import's reminder step. The first `SYNC_USAGE` after the import is what reads their
 * real figures — already used, near the limit, used up — and before this item that first read
 * was announced to the customer as «SERVICE_USAGE_FIRST». Synthetic data only.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const GIB = 1_073_741_824n;
const LIMIT = 50n * GIB;
const DAY_MS = 86_400_000;
const T0 = new Date('2026-10-04T08:00:00.000Z');
const FIRST_SYNC = T0.getTime() + 10 * 60_000;

describe('Round 5A item 1: imported services and usage notices', () => {
  let ctx: TestContext;
  let fx: AudienceFixtures;
  let panel: string;
  let product: string;
  const overrides: Record<string, unknown> = {};

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 600_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    for (const key of Object.keys(overrides)) delete overrides[key];
    fx = new AudienceFixtures(ctx, tenantA.tenantId as string);
    await ctx.container.database.db.execute(
      sql`UPDATE tenants SET display_timezone = 'UTC' WHERE id = ${tenantA.tenantId}`,
    );
    panel = await fx.panel('import');
    product = await fx.product(panel);
  });

  const at = (ms: number): Clock => ({ now: () => new Date(ms) });
  const settings = {
    valueOf: async <T>(_scope: unknown, key: SettingKey) =>
      (key in overrides ? overrides[key] : settingDefinition(key).defaultValue) as T,
  };
  const features = { isEnabled: async (_scope: unknown, _key: FeatureFlagKey) => true };
  const notifier = () =>
    new CustomerNotifier({
      notifications: new DrizzleCustomerNotificationRepository(ctx.container.database.db),
      bots: { botFor: async () => BOT_A },
      ids: ctx.container.ids,
    });
  const remindersRepo = () => new DrizzleServiceReminderRepository(ctx.container.database.db);
  const servicesRepo = () => new DrizzleServiceRepository(ctx.container.database.db);

  function lane(ms: number): ServiceReminderService {
    return new ServiceReminderService({
      reminders: remindersRepo(),
      settings,
      features,
      notifier: notifier(),
      scopeActivity: ctx.container.tenants,
      uow: ctx.container.uow,
      clock: at(ms),
      ids: ctx.container.ids,
      audit: ctx.container.audit,
    });
  }

  const exec = (query: ReturnType<typeof sql>) => ctx.container.database.db.execute(query);
  const count = async (query: ReturnType<typeof sql>): Promise<number> =>
    Number(((await exec(query)).rows[0] as { n: number | string }).n);
  const notifications = () => count(sql`SELECT count(*)::int AS n FROM customer_notifications`);
  const kindsSent = async (): Promise<string[]> =>
    (
      (await exec(sql`SELECT kind FROM customer_notifications ORDER BY kind`)).rows as {
        kind: string;
      }[]
    ).map((row) => row.kind);

  async function drain(ms: number): Promise<number> {
    let sent = 0;
    for (let passes = 0; passes < 400; passes += 1) {
      const before = await count(sql`SELECT count(*)::int AS n FROM service_reminders`);
      const report = await lane(ms).runOnce(tenantA as TenantContext);
      sent += report.expiry + report.usage;
      if ((await count(sql`SELECT count(*)::int AS n FROM service_reminders`)) === before) break;
    }
    return sent;
  }

  /**
   * `n` services as the `.nxpkg` import writes them: unmeasured. A third are already EXPIRED,
   * a third ACTIVE with 0.3 to 6.2 days left, a third ACTIVE with a month left.
   */
  async function importUnmeasured(n: number, offset = 0): Promise<string[]> {
    const ids: string[] = [];
    for (let done = 0; done < n; done += 1_000) {
      const size = Math.min(1_000, n - done);
      const result = await exec(sql`
        WITH ids AS (
          SELECT g, gen_random_uuid() AS c, gen_random_uuid() AS o, gen_random_uuid() AS s
            FROM generate_series(${offset + done + 1}::int, ${offset + done + size}::int) g
        ),
        cu AS (
          INSERT INTO customers (id, tenant_id, telegram_user_id, status, first_seen_at, created_at)
          SELECT c, ${tenantA.tenantId}, (7100000000 + g)::text, 'ACTIVE', ${T0}, ${T0} FROM ids
          RETURNING id
        ),
        od AS (
          INSERT INTO orders
            (id, tenant_id, customer_id, state, purpose, product_id, panel_id, line_title,
             line_duration_days, line_traffic_bytes, line_unit_price_amount, line_quantity,
             subtotal_amount, discount_amount, total_amount, currency, quote, settled_at,
             confirmed_at)
          SELECT o, ${tenantA.tenantId}, c, 'PAID', 'NEW_SERVICE', ${product}, ${panel}, 'plan',
                 30, ${LIMIT}::bigint, 250000, 1, 250000, 0, 250000, 'IRT', '{}'::jsonb, ${T0}, ${T0}
            FROM ids
          RETURNING id
        )
        INSERT INTO services
          (id, tenant_id, customer_id, order_id, panel_id, product_id, provider_username, state,
           delivery_state, traffic_limit_bytes, traffic_used_bytes, usage_synced_at, expires_at,
           provisioned_at, delivered_at, created_at, updated_at, source, source_ref)
        SELECT s, ${tenantA.tenantId}, c, o, ${panel}, ${product}, 'imp' || g,
               CASE WHEN g % 3 = 0 THEN 'EXPIRED' ELSE 'ACTIVE' END,
               'DELIVERED', ${LIMIT}::bigint, 0, NULL,
               CASE WHEN g % 3 = 0 THEN ${T0}::timestamptz - make_interval(days => 1 + g % 5)
                    WHEN g % 3 = 1 THEN ${T0}::timestamptz
                                        + make_interval(secs => (0.3 + (g % 60) / 10.0) * 86400)
                    ELSE ${T0}::timestamptz + interval '30 days' END,
               ${T0}, ${T0}, ${T0}, ${T0}, 'MIRZA', 'invoice:' || g
          FROM ids
        RETURNING id`);
      ids.push(...(result.rows as { id: string }[]).map((row) => row.id));
    }
    return ids;
  }

  async function seedAll(ids: readonly string[]): Promise<void> {
    const seeder = lane(T0.getTime());
    for (let i = 0; i < ids.length; i += 500) {
      await ctx.container.uow.run(tenantA, async (tx) => {
        for (const id of ids.slice(i, i + 500)) await seeder.seedPassedThresholds(tenantA, id, tx);
      });
    }
  }

  /** The panel's answer to a SYNC_USAGE, written the way the provisioner writes it. */
  async function sync(rows: readonly { id: string; usedBytes: bigint }[], ms: number) {
    for (let i = 0; i < rows.length; i += 500) {
      await ctx.container.uow.run(tenantA, async (tx) => {
        for (const row of rows.slice(i, i + 500)) {
          await servicesRepo().recordUsage(
            tenantA,
            row.id,
            { usedBytes: row.usedBytes, syncedAt: new Date(ms) },
            tx,
          );
        }
      });
    }
  }

  it('10,000 imported services, used / near the limit / expired: the first sync and every sweep queue 0 customer messages', async () => {
    const ids = await importUnmeasured(10_000);
    await seedAll(ids);
    const active = (
      (
        await exec(sql`SELECT id, expires_at, provider_username FROM services
                       WHERE state = 'ACTIVE' ORDER BY provider_username`)
      ).rows as {
        id: string;
        provider_username: string;
      }[]
    ).map((row) => ({
      id: row.id,
      // 80..99 percent used for the near-expiry third, a used-up allowance for the rest.
      usedBytes:
        Number(row.provider_username.slice(3)) % 3 === 1
          ? (LIMIT * BigInt(80 + (Number(row.provider_username.slice(3)) % 20))) / 100n
          : LIMIT,
    }));
    expect(active.length).toBeGreaterThan(6_000);

    await sync(active, FIRST_SYNC);
    // The sync recorded usage and nothing else: the figures are on the rows, the baseline too.
    expect(
      await count(sql`SELECT count(*)::int AS n FROM services WHERE usage_synced_at IS NOT NULL`),
    ).toBe(active.length);
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM service_reminder_baselines WHERE used_bytes IS NOT NULL`,
      ),
    ).toBe(active.length);

    expect(await drain(FIRST_SYNC + 60_000)).toBe(0);
    expect(await notifications()).toBe(0);
    // Every threshold moved, as an owner matching the previous bot does: still nothing.
    Object.assign(overrides, {
      'reminders.usage_first_percent': 60,
      'reminders.usage_second_percent': 70,
      'reminders.usage_final_percent': 75,
      'reminders.expiry_first_days': 5,
    });
    expect(await drain(FIRST_SYNC + 120_000)).toBe(0);
    expect(await notifications()).toBe(0);
  }, 1_800_000);

  it('a later first-use transition is told exactly once, as for a service Nexa sold', async () => {
    const [id] = await importUnmeasured(1, 1); // g = 2: ACTIVE, a month left
    await seedAll([id ?? '']);
    // The first sync reads 10 %: recorded, nothing owed.
    await sync([{ id: id ?? '', usedBytes: LIMIT / 10n }], FIRST_SYNC);
    expect(await drain(FIRST_SYNC + 60_000)).toBe(0);
    expect(await notifications()).toBe(0);
    // A week later the customer has used 85 %: that is a transition observed after the import.
    const week = T0.getTime() + 7 * DAY_MS;
    await sync([{ id: id ?? '', usedBytes: (LIMIT * 85n) / 100n }], week);
    expect(await drain(week + 60_000)).toBe(1);
    expect(await kindsSent()).toEqual(['SERVICE_USAGE_FIRST']);
    // And once: another pass, another sync at the same level, tell nothing more.
    await sync([{ id: id ?? '', usedBytes: (LIMIT * 86n) / 100n }], week + 120_000);
    expect(await drain(week + 180_000)).toBe(0);
    expect(await notifications()).toBe(1);
  });

  it('an imported service synced before the sync wrote the baseline is not announced by the sweep, and its next sync arms the baseline', async () => {
    const [id] = await importUnmeasured(1, 1);
    // No baseline row, the way an earlier release left it; its first sync (90 %) already ran.
    await exec(sql`UPDATE services SET traffic_used_bytes = ${(LIMIT * 90n) / 100n},
                                        usage_synced_at = ${new Date(FIRST_SYNC)}
                    WHERE id = ${id ?? ''}`);
    expect(await drain(FIRST_SYNC + 60_000)).toBe(0);
    expect(await notifications()).toBe(0);
    // The next sync sets the baseline figure (85 %: the first figure observed after the fix).
    await sync([{ id: id ?? '', usedBytes: (LIMIT * 85n) / 100n }], FIRST_SYNC + 3_600_000);
    expect(await drain(FIRST_SYNC + 3_700_000)).toBe(0);
    // A figure past the baseline's thresholds, later, is a transition.
    await sync([{ id: id ?? '', usedBytes: LIMIT }], FIRST_SYNC + 7_200_000);
    expect(await drain(FIRST_SYNC + 7_300_000)).toBe(1);
    expect(await kindsSent()).toEqual(['SERVICE_USAGE_FINAL']);
  });

  /** Queues a usage notice for a service as the sweep of an earlier release did. */
  async function queueNotice(
    serviceId: string,
    kind: ServiceReminderKind,
    notificationKind: Parameters<CustomerNotifier['notify']>[2],
  ): Promise<string> {
    const row = (
      await exec(sql`SELECT customer_id, expires_at::text AS e, traffic_limit_bytes::text AS l
                      FROM services WHERE id = ${serviceId}`)
    ).rows[0] as { customer_id: string; e: string | null; l: string };
    const reminderId = ctx.container.ids.uuid();
    await ctx.container.uow.run(tenantA, async (tx) => {
      await remindersRepo().raise(
        tenantA,
        {
          id: reminderId,
          serviceId,
          kind,
          basis: { expiresAt: row.e, trafficLimitBytes: BigInt(row.l) },
          snapshot: { serviceLabel: 'x', remainingDays: 3, usedBytes: 1n },
        },
        new Date(FIRST_SYNC),
        tx,
      );
      await notifier().notify(
        tenantA,
        row.customer_id as never,
        notificationKind,
        reminderId,
        new Date(FIRST_SYNC),
        tx,
      );
    });
    return reminderId;
  }

  it('notices the first sync queued before this fix are SUPERSEDED, with one audit row per batch, and nothing else is touched', async () => {
    const imported = await importUnmeasured(2_000, 100); // g % 3 != 0 are ACTIVE
    const activeImported = (
      (await exec(sql`SELECT id FROM services WHERE state = 'ACTIVE' ORDER BY provider_username`))
        .rows as { id: string }[]
    ).map((row) => row.id);
    expect(imported.length).toBe(2_000);
    // Each queued the way the old first sync did: an imported service, 90 % read after the import.
    await exec(sql`UPDATE services SET traffic_used_bytes = ${(LIMIT * 90n) / 100n},
                                        usage_synced_at = ${new Date(FIRST_SYNC)}
                    WHERE state = 'ACTIVE'`);
    const stale: string[] = [];
    for (const id of activeImported.slice(0, 1_100)) {
      stale.push(await queueNotice(id, 'USAGE_FIRST', 'SERVICE_USAGE_FIRST'));
    }

    // The ones that must NOT move: a service Nexa sold, an imported one whose import measured a
    // figure (a genuine crossing since), one already claimed for a send, one already delivered.
    const customer = await fx.customer({ telegramUserId: '7199999991' });
    const native = await fx.service({
      customerId: customer,
      panelId: panel,
      state: 'ACTIVE',
      expiresAt: new Date(T0.getTime() + 30 * DAY_MS),
    });
    await queueNotice(native, 'USAGE_FIRST', 'SERVICE_USAGE_FIRST');
    const measured = activeImported[1_100] ?? '';
    /*
     * The baseline holds the figure the service is at now, so the sweep in the same pass sees
     * no new crossing. A baseline of 1 byte made the 90 % figure a genuine second-threshold
     * crossing, and whether the sweep's 200-row batch reached this service depended on the ids'
     * order — one extra PENDING notice on some runs (CI on #304).
     */
    await exec(sql`INSERT INTO service_reminder_baselines
                     (tenant_id, service_id, baseline_at, basis_expires_at,
                      basis_traffic_limit_bytes, used_bytes, created_at)
                   SELECT tenant_id, id, created_at, expires_at, traffic_limit_bytes,
                          traffic_used_bytes, created_at
                     FROM services WHERE id = ${measured}`);
    // R5A-2: written at the import's own instant, as the seed writes it (\`created_at\` =
    // \`baseline_at\`); a row created later is a late baseline and proves nothing earlier.

    await queueNotice(measured, 'USAGE_FIRST', 'SERVICE_USAGE_FIRST');
    const claimed = activeImported[1_101] ?? '';
    await queueNotice(claimed, 'USAGE_FIRST', 'SERVICE_USAGE_FIRST');
    await exec(sql`UPDATE customer_notifications SET send_started_at = now()
                    WHERE subject_id IN (SELECT id FROM service_reminders WHERE service_id = ${claimed})`);
    const delivered = activeImported[1_102] ?? '';
    await queueNotice(delivered, 'USAGE_SECOND', 'SERVICE_USAGE_SECOND');
    await exec(sql`UPDATE customer_notifications SET state = 'DELIVERED', resolved_at = now()
                    WHERE kind = 'SERVICE_USAGE_SECOND'`);

    const total = await notifications();
    const runAt = FIRST_SYNC + 120_000;
    await lane(runAt).runOnce(tenantA as TenantContext);

    // The reconcile moved exactly the stale ones, to the lane's own unsent terminal state.
    expect(
      await count(sql`SELECT count(*)::int AS n FROM customer_notifications
                       WHERE state = 'SUPERSEDED' AND resolved_at IS NOT NULL`),
    ).toBe(stale.length);
    expect(
      await count(sql`SELECT count(*)::int AS n FROM customer_notifications
                       WHERE state = 'PENDING'`),
    ).toBe(3); // native, measured, claimed
    expect(await notifications()).toBe(total); // never a delete, never a new row
    // One audit row per batch of 500: 500 + 500 + 100.
    const audits = (
      await exec(sql`SELECT after FROM audit_logs
                      WHERE action = 'service_reminder.imported_usage_notices_superseded'
                      ORDER BY occurred_at`)
    ).rows as { after: { count: number; byKind: Record<string, number> } }[];
    expect(audits.map((row) => row.after.count).sort((a, b) => a - b)).toEqual([100, 500, 500]);
    expect(audits.every((row) => row.after.byKind['SERVICE_USAGE_FIRST'] !== undefined)).toBe(true);
    // Idempotent: a second pass finds nothing and writes no audit row.
    await lane(runAt + 60_000).runOnce(tenantA as TenantContext);
    expect(
      await count(sql`SELECT count(*)::int AS n FROM audit_logs
                       WHERE action = 'service_reminder.imported_usage_notices_superseded'`),
    ).toBe(3);
  }, 900_000);

  it('the send-time precondition refuses the same notices before the reconcile has run', async () => {
    const [id] = await importUnmeasured(1, 1);
    await exec(sql`UPDATE services SET traffic_used_bytes = ${(LIMIT * 90n) / 100n},
                                        usage_synced_at = ${new Date(FIRST_SYNC)}
                    WHERE id = ${id ?? ''}`);
    const stale = await queueNotice(id ?? '', 'USAGE_FIRST', 'SERVICE_USAGE_FIRST');
    const customer = await fx.customer({ telegramUserId: '7199999992' });
    const native = await fx.service({
      customerId: customer,
      panelId: panel,
      state: 'ACTIVE',
      expiresAt: new Date(T0.getTime() + 30 * DAY_MS),
    });
    const owed = await queueNotice(native, 'USAGE_FIRST', 'SERVICE_USAGE_FIRST');
    const reader = new DrizzleNotificationSubjectReader(ctx.container.database.db);
    const now = new Date(FIRST_SYNC + 60_000);
    expect(await reader.stillHolds(tenantA, 'SERVICE_USAGE_FIRST', stale, now)).toBe(false);
    expect(await reader.stillHolds(tenantA, 'SERVICE_USAGE_FIRST', owed, now)).toBe(true);
  });
});
