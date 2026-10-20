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
import { ServiceReminderService } from '../../apps/api/src/modules/commerce/provisioning/application/service-reminder.service';
import { WalletLowBalanceService } from '../../apps/api/src/modules/commerce/wallet/application/wallet-low-balance.service';
import { DrizzleWalletThresholdAlertRepository } from '../../apps/api/src/modules/commerce/wallet/infrastructure/drizzle-wallet-threshold-alert.repository';
import { AudienceFixtures } from './audience-fixtures';
import { createTestContext, SEED_IDS, tenantA, type TestContext } from './harness';

/**
 * Round 4 PR-H — post-import safety: after a bulk import, the first reminder sweeps send no
 * historical notice. Synthetic data only.
 *
 * The services are written the way the one-time import writes an adopted service (source
 * `MIRZA`, born at the import, its figures the panel's), and each is handed to the import's
 * own reminder step (`seedPassedThresholds`, which the adoption runs in its transaction).
 * Then every sweep that can tell a customer something unprompted runs until it has nothing
 * left to look at, and the lane's table — every customer message of this lane is a row
 * there — must be empty. Then the operator moves every threshold, which is what an owner
 * matching the previous bot's settings does after an import, and it must STILL be empty:
 * that is the per-service baseline's job, not the seed's.
 *
 * And the other half, so the lane is not simply muted: a change observed after the import
 * — a figure measured higher, a deadline reached, a renewal — is still told, once.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const GIB = 1_073_741_824n;
const LIMIT = 50n * GIB;
const DAY_MS = 86_400_000;
const T0 = new Date('2026-10-04T08:00:00.000Z');

/** Thresholds an owner might set after the import, every one wider than the defaults. */
const WIDENED: Readonly<Record<string, number>> = {
  'reminders.expiry_early_days': 10,
  'reminders.expiry_first_days': 5,
  'reminders.expiry_second_days': 2,
  'reminders.usage_first_percent': 60,
  'reminders.usage_second_percent': 70,
  'reminders.usage_final_percent': 75,
};

describe('Round 4 PR-H: the first sweeps after an import send nothing historical', () => {
  let ctx: TestContext;
  let fx: AudienceFixtures;
  let panel: string;
  let product: string;
  let overrides: Record<string, unknown> = {};

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 600_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    overrides = {};
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
  // Every reminder family ON, whatever the defaults are: the strongest pull on the lane.
  const features = { isEnabled: async (_scope: unknown, _key: FeatureFlagKey) => true };
  const notifier = () =>
    new CustomerNotifier({
      notifications: new DrizzleCustomerNotificationRepository(ctx.container.database.db),
      bots: { botFor: async () => BOT_A },
      ids: ctx.container.ids,
    });

  function reminders(ms: number): ServiceReminderService {
    return new ServiceReminderService({
      reminders: new DrizzleServiceReminderRepository(ctx.container.database.db),
      settings,
      features,
      notifier: notifier(),
      scopeActivity: ctx.container.tenants,
      uow: ctx.container.uow,
      clock: at(ms),
      ids: ctx.container.ids,
    });
  }

  function wallet(ms: number): WalletLowBalanceService {
    return new WalletLowBalanceService({
      alerts: new DrizzleWalletThresholdAlertRepository(ctx.container.database.db),
      settings,
      features,
      notifier: notifier(),
      scopeActivity: ctx.container.tenants,
      uow: ctx.container.uow,
      clock: at(ms),
      ids: ctx.container.ids,
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

  const IMPORT_BATCH = 1_000;

  /**
   * `n` services as the import writes them, one customer each, born at `T0`: half already
   * EXPIRED (their deadline one to five days behind them, the allowance used up), half
   * ACTIVE and near the end (0.3 to 6.2 days left, 80 to 99 percent used). The usage figure
   * is the panel's, read a minute before the import wrote it.
   */
  async function importServices(n: number, offset = 0): Promise<string[]> {
    // In statements of at most 1,000 services. One statement of 10,000 (30,000 rows and
    // their foreign-key checks) takes about 1.5 s on its own, and it ran past the 15 s
    // statement_timeout in CI's integration shard 7 — and once locally in the same shard —
    // cancelled inside a foreign-key check on `customers`. The rows are the same either way;
    // no statement here should depend on the database being idle.
    const ids: string[] = [];
    for (let done = 0; done < n; done += IMPORT_BATCH) {
      ids.push(...(await importBatch(Math.min(IMPORT_BATCH, n - done), offset + done)));
    }
    return ids;
  }

  async function importBatch(n: number, offset: number): Promise<string[]> {
    const result = await exec(sql`
      WITH ids AS (
        SELECT g, gen_random_uuid() AS c, gen_random_uuid() AS o, gen_random_uuid() AS s
          FROM generate_series(${offset + 1}::int, ${offset + n}::int) g
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
             CASE WHEN g % 2 = 0 THEN 'EXPIRED' ELSE 'ACTIVE' END,
             'DELIVERED', ${LIMIT}::bigint,
             CASE WHEN g % 2 = 0 THEN ${LIMIT}::bigint
                  ELSE ${LIMIT}::bigint * (80 + g % 20) / 100 END,
             ${T0}::timestamptz - interval '1 minute',
             CASE WHEN g % 2 = 0 THEN ${T0}::timestamptz - make_interval(days => 1 + g % 5)
                  ELSE ${T0}::timestamptz + make_interval(secs => (0.3 + (g % 60) / 10.0) * 86400)
             END,
             ${T0}, ${T0}, ${T0}, ${T0}, 'MIRZA', 'invoice:' || g
        FROM ids
      RETURNING id`);
    return (result.rows as { id: string }[]).map((row) => row.id);
  }

  /** The import's own reminder step, in the adoption's place, at the import's moment. */
  async function seedAll(ids: readonly string[], ms = T0.getTime()): Promise<void> {
    const lane = reminders(ms);
    for (let i = 0; i < ids.length; i += 500) {
      await ctx.container.uow.run(tenantA, async (tx) => {
        for (const id of ids.slice(i, i + 500)) await lane.seedPassedThresholds(tenantA, id, tx);
      });
    }
  }

  /** Every service reminder pass there is to run at `ms`, until one finds nothing new. */
  async function drain(ms: number): Promise<{ readonly sent: number; readonly passes: number }> {
    let sent = 0;
    let passes = 0;
    for (;;) {
      const before = await count(sql`SELECT count(*)::int AS n FROM service_reminders`);
      const report = await reminders(ms).runOnce(tenantA as TenantContext);
      passes += 1;
      sent += report.expiry + report.usage;
      const after = await count(sql`SELECT count(*)::int AS n FROM service_reminders`);
      if (after === before || passes > 400) return { sent, passes };
    }
  }

  it('10,000 imported services, expired or near expiry: the first sweeps send 0 messages, even after every threshold moves', async () => {
    const ids = await importServices(10_000);
    expect(ids).toHaveLength(10_000);
    await seedAll(ids);
    expect(await count(sql`SELECT count(*)::int AS n FROM service_reminder_baselines`)).toBe(
      10_000,
    );

    // Their opening balances, as the import writes them: credits and a debt, nothing after.
    await exec(sql`
      INSERT INTO wallet_entries (id, tenant_id, customer_id, direction, reason, amount,
                                  currency, reference)
      SELECT gen_random_uuid(), ${tenantA.tenantId}, s.customer_id,
             CASE WHEN row_number() OVER (ORDER BY s.id) % 3 = 0 THEN 'DEBIT' ELSE 'CREDIT' END,
             'MIGRATION_OPENING_BALANCE',
             CASE WHEN row_number() OVER (ORDER BY s.id) % 2 = 0 THEN 500000 ELSE 5000 END,
             'IRT', 'legacy:opening:' || s.source_ref
        FROM services s WHERE s.tenant_id = ${tenantA.tenantId}`);
    overrides['wallet.low_balance.threshold'] = { amountMinor: '100000', currency: 'IRT' };
    overrides['sales.currency'] = 'IRT';

    // The first passes after the import, five minutes in.
    const first = T0.getTime() + 5 * 60_000;
    const service = await drain(first);
    expect(service.sent).toBe(0);
    expect((await wallet(first).runOnce(tenantA)).alerts).toBe(0);
    expect(await notifications()).toBe(0);

    // The owner matches the previous bot's settings: every threshold further out. Without
    // the baseline, every one of these services now has an unrecorded crossing.
    Object.assign(overrides, WIDENED);
    const later = await drain(first + 60_000);
    expect(later.sent).toBe(0);
    expect(later.passes).toBeGreaterThan(1);
    expect(await notifications()).toBe(0);
    // Recorded, so nothing is left to be told later either.
    expect((await drain(first + 120_000)).sent).toBe(0);

    // And the lane still speaks. Ten and a half hours on, some imported deadlines have
    // passed and some services have crossed a threshold they had not crossed at the import
    // (five or two days left, under the widened settings): each of those — and only those —
    // is told, once, its most urgent kind.
    const now = T0.getTime() + 0.45 * DAY_MS;
    const owed = await count(sql`
      SELECT count(*)::int AS n FROM services
       WHERE tenant_id = ${tenantA.tenantId} AND state = 'ACTIVE' AND (
             expires_at <= ${new Date(now)}::timestamptz
          OR (expires_at - interval '2 days' > ${T0}::timestamptz
              AND expires_at - interval '2 days' <= ${new Date(now)}::timestamptz)
          OR (expires_at - interval '5 days' > ${T0}::timestamptz
              AND expires_at - interval '5 days' <= ${new Date(now)}::timestamptz))`);
    expect(owed).toBeGreaterThan(0);
    expect((await drain(now)).sent).toBe(owed);
    expect(await notifications()).toBe(owed);
    // Every one of them is a crossing AFTER the import, and nothing about an expired one.
    expect(
      await count(sql`
        SELECT count(*)::int AS n FROM customer_notifications n
          JOIN service_reminders r ON r.id = n.subject_id
          JOIN services s ON s.id = r.service_id
         WHERE s.state = 'EXPIRED'
            OR (n.kind = 'SERVICE_EXPIRED' AND s.expires_at <= ${T0}::timestamptz)
            OR (n.kind = 'SERVICE_EXPIRY_SECOND' AND s.expires_at - interval '2 days' <= ${T0}::timestamptz)
            OR (n.kind = 'SERVICE_EXPIRY_FIRST' AND s.expires_at - interval '5 days' <= ${T0}::timestamptz)
            OR n.kind NOT IN ('SERVICE_EXPIRED', 'SERVICE_EXPIRY_SECOND', 'SERVICE_EXPIRY_FIRST')`),
    ).toBe(0);
  }, 1_200_000);

  it('a threshold moved after the import does not announce a crossing the previous bot owned', async () => {
    // Eight days out and 65 % used at the import: nothing passed under the defaults, so the
    // seed recorded nothing — only the baseline knows this service's state at the import.
    const [id] = await importServices(1, 20_000);
    await exec(sql`
      UPDATE services SET state = 'ACTIVE',
                          expires_at = ${new Date(T0.getTime() + 8 * DAY_MS)},
                          traffic_used_bytes = ${(LIMIT * 65n) / 100n}
       WHERE id = ${id ?? ''}`);
    await seedAll([id ?? '']);
    expect(await count(sql`SELECT count(*)::int AS n FROM service_reminders`)).toBe(0);

    Object.assign(overrides, WIDENED);
    expect(await drain(T0.getTime() + 60_000)).toMatchObject({ sent: 0 });
    expect(await notifications()).toBe(0);
    // ...recorded as raised, so it is not re-decided on every pass.
    expect(await count(sql`SELECT count(*)::int AS n FROM service_reminders`)).toBeGreaterThan(0);

    // The deadline then genuinely comes within five days: that is after the import, told.
    expect(await drain(T0.getTime() + 3.5 * DAY_MS)).toMatchObject({ sent: 1 });
    expect(await kindsSent()).toEqual(['SERVICE_EXPIRY_FIRST']);
  });

  it('a figure synced after the import, then a lower threshold: the import figure decides, not the latest one', async () => {
    // 65 % at the import, 66 % at the first sync after it: nothing crossed under the defaults.
    const [id] = await importServices(1, 60_000);
    await exec(sql`
      UPDATE services SET state = 'ACTIVE',
                          expires_at = ${new Date(T0.getTime() + 25 * DAY_MS)},
                          traffic_used_bytes = ${(LIMIT * 65n) / 100n}
       WHERE id = ${id ?? ''}`);
    await seedAll([id ?? '']);
    await exec(sql`
      UPDATE services SET traffic_used_bytes = ${(LIMIT * 66n) / 100n},
                          usage_synced_at = ${new Date(T0.getTime() + 10 * 60_000)}
       WHERE id = ${id ?? ''}`);
    expect(await drain(T0.getTime() + 11 * 60_000)).toMatchObject({ sent: 0 });

    // The owner sets the first usage warning at 60 %: the import's 65 % had reached it.
    overrides['reminders.usage_first_percent'] = 60;
    expect(await drain(T0.getTime() + 12 * 60_000)).toMatchObject({ sent: 0 });
    expect(await notifications()).toBe(0);

    // 71 % measured later crosses a 70 % second warning the import figure had not reached.
    overrides['reminders.usage_second_percent'] = 70;
    await exec(sql`
      UPDATE services SET traffic_used_bytes = ${(LIMIT * 71n) / 100n},
                          usage_synced_at = ${new Date(T0.getTime() + 60 * 60_000)}
       WHERE id = ${id ?? ''}`);
    expect(await drain(T0.getTime() + 61 * 60_000)).toMatchObject({ sent: 1 });
    expect(await kindsSent()).toEqual(['SERVICE_USAGE_SECOND']);
  });

  it('added traffic after the import is a new period too: its re-armed expiry reminder is told (Codex, PR #296)', async () => {
    // Eight days out at the import: nothing behind it under the defaults.
    const [id] = await importServices(1, 70_000);
    await exec(sql`
      UPDATE services SET state = 'ACTIVE',
                          expires_at = ${new Date(T0.getTime() + 8 * DAY_MS)},
                          traffic_used_bytes = 0
       WHERE id = ${id ?? ''}`);
    await seedAll([id ?? '']);
    // The customer buys traffic after the import: the allowance moves, the deadline does not.
    await exec(sql`UPDATE services SET traffic_limit_bytes = ${LIMIT * 2n}::bigint
                    WHERE id = ${id ?? ''}`);
    // A week-out warning at ten days is now due for this new period. It was "already behind"
    // the service at the import only for the OLD period, so it is told.
    overrides['reminders.expiry_early_days'] = 10;
    expect(await drain(T0.getTime() + 60_000)).toMatchObject({ sent: 1 });
    expect(await kindsSent()).toEqual(['SERVICE_EXPIRY_EARLY']);
  });

  it('a renewal after the import is a new period, and its reminders are told', async () => {
    const [id] = await importServices(1, 30_000);
    await exec(sql`UPDATE services SET state = 'EXPIRED',
                                       expires_at = ${new Date(T0.getTime() - 2 * DAY_MS)}
                    WHERE id = ${id ?? ''}`);
    await seedAll([id ?? '']);
    expect(await drain(T0.getTime() + 60_000)).toMatchObject({ sent: 0 });

    // Renewed for a short period: its deadline is no longer the imported one, and the panel
    // reset its usage counter, as a renewal does.
    await exec(sql`UPDATE services SET state = 'ACTIVE',
                                       expires_at = ${new Date(T0.getTime() + 2.5 * DAY_MS)},
                                       traffic_used_bytes = 0
                    WHERE id = ${id ?? ''}`);
    expect(await drain(T0.getTime() + 2 * 60_000)).toMatchObject({ sent: 1 });
    expect(await kindsSent()).toEqual(['SERVICE_EXPIRY_FIRST']);
  });

  it('a service an earlier release imported (no baseline row, no seed) still sends nothing historical; a native one is told', async () => {
    const [imported] = await importServices(1, 40_000);
    await exec(sql`UPDATE services SET expires_at = ${new Date(T0.getTime() - DAY_MS)},
                                       state = 'EXPIRED'
                    WHERE id = ${imported ?? ''}`);
    expect(await drain(T0.getTime() + 60_000)).toMatchObject({ sent: 0 });
    expect(await notifications()).toBe(0);

    // The same facts on a service this installation sold: the expired notice is owed.
    const customer = await fx.customer({ telegramUserId: '7199999999' });
    const native = await fx.service({
      customerId: customer,
      panelId: panel,
      state: 'EXPIRED',
      expiresAt: new Date(T0.getTime() - DAY_MS),
    });
    expect(native).toBeDefined();
    expect(await drain(T0.getTime() + 2 * 60_000)).toMatchObject({ sent: 1 });
    expect(await kindsSent()).toEqual(['SERVICE_EXPIRED']);
  });

  it('the baseline is the import’s: a later seed of the same service keeps the first row', async () => {
    const [id] = await importServices(1, 50_000);
    await seedAll([id ?? '']);
    await seedAll([id ?? ''], T0.getTime() + 3 * DAY_MS);
    const rows = (
      await exec(
        sql`SELECT baseline_at FROM service_reminder_baselines WHERE service_id = ${id ?? ''}`,
      )
    ).rows as { baseline_at: string }[];
    expect(rows).toHaveLength(1);
    expect(new Date(rows[0]?.baseline_at ?? '').toISOString()).toBe(T0.toISOString());
  });
});
