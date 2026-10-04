import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  featureFlagDefinition,
  settingDefinition,
  type BotInstanceId,
  type Clock,
  type FeatureFlagKey,
  type SettingKey,
} from '@nexa/contracts';
import { DrizzleCustomerNotificationRepository } from '../../apps/api/src/modules/commerce/messaging/infrastructure/drizzle-customer-notification.repository';
import { CustomerNotifier } from '../../apps/api/src/modules/commerce/messaging/application/customer-notifier';
import { DrizzleServiceReminderRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service-reminder.repository';
import { ServiceReminderService } from '../../apps/api/src/modules/commerce/provisioning/application/service-reminder.service';
import { AudienceFixtures } from './audience-fixtures';
import { createTestContext, SEED_IDS, tenantA, tenantB, type TestContext } from './harness';

/**
 * Migration P6, Item 8 — reminder burst protection (`docs/migration-p6-service-adoption.md`
 * §6). An adopted service arrives part-way through its period; `seedPassedThresholds`
 * records every threshold already behind it as raised, with no message, on the existing
 * reminder lane. These cases prove that the FIRST sweep after an adoption sends nothing
 * historical and that the next genuine threshold still fires.
 *
 * The sweep and the seed are built here with a controllable clock and the registry's
 * default thresholds (7/3/1 days, the day itself, expired; 80/90/95 % used), on the real
 * repository, notifier and tenant row.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const GIB = 1_073_741_824n;
const LIMIT = 50n * GIB;
const DAY_MS = 86_400_000;

describe('Migration P6: reminder burst seed', () => {
  let ctx: TestContext;
  let fx: AudienceFixtures;
  let panel: string;
  let customer: string;
  let n = 0;
  const T0 = new Date('2026-10-04T08:00:00.000Z');

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 600_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    fx = new AudienceFixtures(ctx, tenantA.tenantId as string);
    // UTC calendar days, so the day-of rung in the cases below is plain arithmetic; the
    // timezone case sets its own.
    await ctx.container.database.db.execute(
      sql`UPDATE tenants SET display_timezone = 'UTC' WHERE id = ${tenantA.tenantId}`,
    );
    panel = await fx.panel('seed');
    customer = await fx.customer({ telegramUserId: `81000${String((n += 1)).padStart(4, '0')}` });
  });

  const at = (ms: number): Clock => ({ now: () => new Date(ms) });

  function lane(ms: number): ServiceReminderService {
    const db = ctx.container.database.db;
    return new ServiceReminderService({
      reminders: new DrizzleServiceReminderRepository(db),
      settings: {
        valueOf: async <T>(_scope: unknown, key: SettingKey) =>
          settingDefinition(key).defaultValue as T,
      },
      features: {
        isEnabled: async (_scope: unknown, key: FeatureFlagKey) =>
          featureFlagDefinition(key).defaultEnabled,
      },
      notifier: new CustomerNotifier({
        notifications: new DrizzleCustomerNotificationRepository(db),
        bots: { botFor: async () => BOT_A },
        ids: ctx.container.ids,
      }),
      scopeActivity: ctx.container.tenants,
      uow: ctx.container.uow,
      clock: at(ms),
      ids: ctx.container.ids,
    });
  }

  const seed = (serviceId: string, ms = T0.getTime(), tenant = tenantA) =>
    ctx.container.uow.run(tenant, (tx) => lane(ms).seedPassedThresholds(tenant, serviceId, tx));
  const sweep = (ms = T0.getTime()) => lane(ms).runOnce(tenantA);

  /** A live service whose figures are what the panel reported at adoption. */
  async function service(input: {
    readonly expiresAt: Date | null;
    readonly usedBytes?: bigint;
    readonly limitBytes?: bigint;
    readonly state?: 'ACTIVE' | 'SUSPENDED' | 'EXPIRED';
  }): Promise<string> {
    const id = await fx.service({
      customerId: customer,
      panelId: panel,
      state: input.state ?? 'ACTIVE',
      expiresAt: input.expiresAt,
      trafficLimitBytes: input.limitBytes ?? LIMIT,
    });
    await ctx.container.database.db.execute(sql`
      UPDATE services SET traffic_used_bytes = ${input.usedBytes ?? 0n},
                          usage_synced_at = ${T0}::timestamptz
       WHERE id = ${id}`);
    return id;
  }

  const kinds = async (serviceId: string): Promise<string[]> =>
    (
      (
        await ctx.container.database.db.execute(
          sql`SELECT kind FROM service_reminders WHERE service_id = ${serviceId} ORDER BY kind`,
        )
      ).rows as { kind: string }[]
    ).map((row) => row.kind);
  const notified = async (): Promise<string[]> =>
    (
      (
        await ctx.container.database.db.execute(
          sql`SELECT kind FROM customer_notifications ORDER BY kind`,
        )
      ).rows as { kind: string }[]
    ).map((row) => row.kind);

  it('near expiry: records the week and three-day warnings, and the first sweep sends nothing', async () => {
    const id = await service({ expiresAt: new Date(T0.getTime() + 2.5 * DAY_MS) });
    const result = await seed(id);
    expect(result.passed).toEqual(['EXPIRY_EARLY', 'EXPIRY_FIRST']);
    expect(result.seeded).toEqual(['EXPIRY_EARLY', 'EXPIRY_FIRST']);
    expect(await sweep()).toEqual({ expiry: 0, usage: 0 });
    expect(await notified()).toEqual([]);
  });

  it('the next genuine threshold still fires, once, after the seed', async () => {
    const id = await service({ expiresAt: new Date(T0.getTime() + 2.5 * DAY_MS) });
    await seed(id);
    // 22:24 UTC the day before the deadline: inside one day, before the deadline's own
    // calendar day — EXPIRY_SECOND is genuinely due.
    const later = T0.getTime() + 1.6 * DAY_MS;
    expect(await sweep(later)).toEqual({ expiry: 1, usage: 0 });
    expect(await notified()).toEqual(['SERVICE_EXPIRY_SECOND']);
    expect(await sweep(later)).toEqual({ expiry: 0, usage: 0 });
    expect(await notified()).toEqual(['SERVICE_EXPIRY_SECOND']);
  });

  it('several passed volume thresholds: all recorded, none sent, the next one fires', async () => {
    const id = await service({
      expiresAt: new Date(T0.getTime() + 20 * DAY_MS),
      usedBytes: (LIMIT * 92n) / 100n,
    });
    const result = await seed(id);
    expect(result.passed).toEqual(['USAGE_FIRST', 'USAGE_SECOND']);
    expect(await sweep()).toEqual({ expiry: 0, usage: 0 });
    expect(await notified()).toEqual([]);

    // A later usage sync reports 96 %: USAGE_FINAL is a genuine crossing.
    await ctx.container.database.db.execute(
      sql`UPDATE services SET traffic_used_bytes = ${(LIMIT * 96n) / 100n} WHERE id = ${id}`,
    );
    expect(await sweep()).toEqual({ expiry: 0, usage: 1 });
    expect(await notified()).toEqual(['SERVICE_USAGE_FINAL']);
  });

  it('expired at adoption: every expiry rung is recorded and the expired notice is never sent', async () => {
    const id = await service({
      expiresAt: new Date(T0.getTime() - 3 * DAY_MS),
      state: 'EXPIRED',
      usedBytes: LIMIT,
    });
    const result = await seed(id);
    expect(result.passed).toEqual([
      'EXPIRY_EARLY',
      'EXPIRY_FIRST',
      'EXPIRY_SECOND',
      'EXPIRY_DAY',
      'EXPIRED',
      'USAGE_FIRST',
      'USAGE_SECOND',
      'USAGE_FINAL',
    ]);
    expect(await sweep()).toEqual({ expiry: 0, usage: 0 });
    expect(await sweep(T0.getTime() + 10 * DAY_MS)).toEqual({ expiry: 0, usage: 0 });
    expect(await notified()).toEqual([]);
  });

  it('healthy at adoption: nothing is recorded, and its first real threshold fires', async () => {
    const id = await service({
      expiresAt: new Date(T0.getTime() + 20 * DAY_MS),
      usedBytes: (LIMIT * 10n) / 100n,
    });
    const result = await seed(id);
    expect(result).toEqual({ passed: [], seeded: [] });
    expect(await kinds(id)).toEqual([]);
    expect(await sweep(T0.getTime() + 14 * DAY_MS)).toEqual({ expiry: 1, usage: 0 });
    expect(await notified()).toEqual(['SERVICE_EXPIRY_EARLY']);
  });

  it('a renewal after adoption is a new period: its reminders are owed again', async () => {
    const id = await service({ expiresAt: new Date(T0.getTime() + 2.5 * DAY_MS) });
    await seed(id);
    // The renewal moves the deadline (the basis); a period 2.5 days from its new end.
    await ctx.container.database.db.execute(sql`
      UPDATE services SET expires_at = expires_at + interval '30 days' WHERE id = ${id}`);
    expect(await sweep(T0.getTime() + 30 * DAY_MS)).toEqual({ expiry: 1, usage: 0 });
    expect(await notified()).toEqual(['SERVICE_EXPIRY_FIRST']);
  });

  it('a rerun writes nothing and answers the same passed set', async () => {
    const id = await service({
      expiresAt: new Date(T0.getTime() + 0.5 * DAY_MS),
      usedBytes: (LIMIT * 85n) / 100n,
    });
    const first = await seed(id);
    const before = await kinds(id);
    const second = await seed(id);
    expect(second.passed).toEqual(first.passed);
    expect(second.seeded).toEqual([]);
    expect(await kinds(id)).toEqual(before);
    expect(before.length).toBe(first.passed.length);
  });

  it('two seeds racing write each threshold exactly once', async () => {
    const id = await service({
      expiresAt: new Date(T0.getTime() + 2.5 * DAY_MS),
      usedBytes: (LIMIT * 91n) / 100n,
    });
    const [a, b] = await Promise.all([seed(id), seed(id)]);
    const written = [...a.seeded, ...b.seeded].sort();
    expect(written).toEqual([...a.passed].sort());
    expect(await kinds(id)).toEqual([...a.passed].sort());
    expect(await notified()).toEqual([]);
  });

  it('the day of expiry is the rung the sweep then finds already raised (tenant timezone)', async () => {
    await ctx.container.database.db.execute(
      sql`UPDATE tenants SET display_timezone = 'Asia/Tehran' WHERE id = ${tenantA.tenantId}`,
    );
    // The deadline is 04:00 Tehran on 5 October (00:30 UTC). At 00:30 Tehran (21:00 UTC on
    // the 4th) the deadline's TEHRAN day has begun while its UTC day has not: the rung is
    // EXPIRY_DAY only in the tenant's own timezone.
    const id = await service({ expiresAt: new Date('2026-10-05T00:30:00.000Z') });
    const now = new Date('2026-10-04T21:00:00.000Z').getTime();
    const result = await seed(id, now);
    expect(result.passed).toEqual(['EXPIRY_EARLY', 'EXPIRY_FIRST', 'EXPIRY_SECOND', 'EXPIRY_DAY']);
    expect(await sweep(now)).toEqual({ expiry: 0, usage: 0 });
    // The deadline passing is a genuine event after adoption: the expired notice is owed.
    expect(await sweep(new Date('2026-10-05T00:31:00.000Z').getTime())).toEqual({
      expiry: 1,
      usage: 0,
    });
    expect(await notified()).toEqual(['SERVICE_EXPIRED']);
  });

  it('an unmeasured usage figure seeds no usage kind, as the usage query would not either', async () => {
    const id = await service({ expiresAt: null });
    await ctx.container.database.db.execute(
      sql`UPDATE services SET usage_synced_at = NULL WHERE id = ${id}`,
    );
    expect(await seed(id)).toEqual({ passed: [], seeded: [] });
  });

  it('refuses a service of another tenant and writes nothing', async () => {
    const id = await service({ expiresAt: new Date(T0.getTime() - DAY_MS), state: 'EXPIRED' });
    await expect(seed(id, T0.getTime(), tenantB)).rejects.toMatchObject({
      code: 'commerce.service_not_found',
    });
    expect(await kinds(id)).toEqual([]);
  });

  it('refuses a stopped scope inside the transaction', async () => {
    const id = await service({ expiresAt: new Date(T0.getTime() - DAY_MS), state: 'EXPIRED' });
    await ctx.container.database.db.execute(
      sql`UPDATE tenants SET status = 'STOPPED' WHERE id = ${tenantA.tenantId}`,
    );
    await expect(seed(id)).rejects.toMatchObject({ code: 'commerce.request_invalid' });
    expect(await kinds(id)).toEqual([]);
  });
});
