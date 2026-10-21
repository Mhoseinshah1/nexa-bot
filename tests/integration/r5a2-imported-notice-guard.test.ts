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
import { DrizzleReportingRepository } from '../../apps/api/src/modules/commerce/reporting/infrastructure/drizzle-reporting.repository';
import { DrizzleResellerRepository } from '../../apps/api/src/modules/commerce/resellers/infrastructure/drizzle-reseller.repository';
import { ResellerMinimumService } from '../../apps/api/src/modules/commerce/resellers/application/reseller-minimum.service';
import { CachedTenantPresentationReader } from '../../apps/api/src/modules/control/templates/infrastructure/cached-tenant-presentation.reader';
import { TenantMonthlyPeriods } from '../../apps/api/src/infrastructure/time/monthly-period';
import { AudienceFixtures } from './audience-fixtures';
import { createTestContext, SEED_IDS, tenantA, type TestContext } from './harness';

/**
 * Round 5A-2 items 1-4 — an installation imported BEFORE the baselines existed (Round 4 PR-H)
 * must not tell its imported customers anything about a state it never observed.
 *
 * The services are written the way an earlier release left them: source `MIRZA`, born at the
 * import (T0) with a usage figure already measured, and NO `service_reminder_baselines` row.
 * Synthetic data only.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const GIB = 1_073_741_824n;
const LIMIT = 50n * GIB;
const DAY_MS = 86_400_000;
const T0 = new Date('2026-10-04T08:00:00.000Z'); // the import
const T1 = T0.getTime() + 3 * DAY_MS; // the worker starts on the new release
const T2 = T1 + 3.5 * DAY_MS; // a real transition, later

describe('Round 5A-2: imported services and reseller periods are not announced', () => {
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
  const notifier = () =>
    new CustomerNotifier({
      notifications: new DrizzleCustomerNotificationRepository(ctx.container.database.db),
      bots: { botFor: async () => BOT_A },
      ids: ctx.container.ids,
    });
  const remindersRepo = () => new DrizzleServiceReminderRepository(ctx.container.database.db);
  const servicesRepo = () => new DrizzleServiceRepository(ctx.container.database.db);

  /** `audit: false` is a lane whose reconcile cannot run — the sweep alone, as a race would leave it. */
  function lane(ms: number, withReconcile = true): ServiceReminderService {
    return new ServiceReminderService({
      reminders: remindersRepo(),
      settings,
      features,
      notifier: notifier(),
      scopeActivity: ctx.container.tenants,
      uow: ctx.container.uow,
      clock: at(ms),
      ids: ctx.container.ids,
      ...(withReconcile ? { audit: ctx.container.audit } : {}),
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

  async function drain(ms: number, withReconcile = true): Promise<number> {
    let sent = 0;
    for (let passes = 0; passes < 400; passes += 1) {
      const before = await count(sql`SELECT count(*)::int AS n FROM service_reminders`);
      const report = await lane(ms, withReconcile).runOnce(tenantA as TenantContext);
      sent += report.expiry + report.usage;
      if ((await count(sql`SELECT count(*)::int AS n FROM service_reminders`)) === before) break;
    }
    return sent;
  }

  /**
   * `n` services as a pre-PR-H import left them (no baseline, no reminder row), by `g % 4`:
   * 0 already EXPIRED; 1 ACTIVE and expiring 4 to 9 days after the import (so thresholds were
   * crossed between the import and T1); 2 ACTIVE at 96 % used; 3 ACTIVE, a month left, 10 % used.
   */
  async function importOld(n: number, offset = 0): Promise<string[]> {
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
          SELECT c, ${tenantA.tenantId}, (7200000000 + g)::text, 'ACTIVE', ${T0}, ${T0} FROM ids
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
        SELECT s, ${tenantA.tenantId}, c, o, ${panel}, ${product}, 'old' || g,
               CASE WHEN g % 4 = 0 THEN 'EXPIRED' ELSE 'ACTIVE' END,
               'DELIVERED', ${LIMIT}::bigint,
               CASE g % 4 WHEN 2 THEN (${LIMIT}::bigint * 96) / 100
                          WHEN 3 THEN ${LIMIT}::bigint / 10 ELSE 0 END,
               ${T0},
               CASE g % 4
                 WHEN 0 THEN ${T0}::timestamptz - make_interval(days => 1 + g % 5)
                 WHEN 1 THEN ${T0}::timestamptz + make_interval(secs => (4 + (g % 50) / 10.0) * 86400)
                 ELSE ${T0}::timestamptz + interval '30 days' END,
               ${T0}, ${T0}, ${T0}, ${T0}, 'MIRZA', 'invoice:' || g
          FROM ids
        RETURNING id`);
      ids.push(...(result.rows as { id: string }[]).map((row) => row.id));
    }
    return ids;
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

  it('10,000 imported services without baselines: the worker-start reconcile, every sweep and a usage sync queue 0 customer messages', async () => {
    await importOld(10_000);
    expect(await count(sql`SELECT count(*)::int AS n FROM service_reminder_baselines`)).toBe(0);

    // The worker starts on the new release.
    const report = await lane(T1).reconcileImportedNotices(tenantA as TenantContext, {
      unbounded: true,
    });
    expect(report.baselines).toBe(10_000);
    expect(await count(sql`SELECT count(*)::int AS n FROM service_reminder_baselines`)).toBe(
      10_000,
    );
    // One audit row per batch of 500, and none for the empty batch that ended the walk.
    expect(
      await count(sql`SELECT count(*)::int AS n FROM audit_logs
                       WHERE action = 'service_reminder.imported_baselines_backfilled'`),
    ).toBe(20);
    // Silent: what the services had already reached is recorded, never announced.
    expect(await notifications()).toBe(0);
    expect(await count(sql`SELECT count(*)::int AS n FROM service_reminders`)).toBeGreaterThan(
      10_000,
    );

    // Every sweep (expiry and usage, the lane's whole pass) — nothing.
    expect(await drain(T1 + 60_000)).toBe(0);
    // A usage sync that reads each active service where it already was.
    const active = (
      (
        await exec(sql`SELECT id, provider_username, traffic_used_bytes::text AS used
                        FROM services WHERE state = 'ACTIVE'`)
      ).rows as {
        id: string;
        provider_username: string;
        used: string;
      }[]
    ).map((row) => ({ id: row.id, usedBytes: BigInt(row.used) + GIB / 10n }));
    await sync(active, T1 + 600_000);
    expect(await drain(T1 + 660_000)).toBe(0);
    expect(await notifications()).toBe(0);

    // Idempotent: a second walk writes nothing and audits nothing.
    expect(
      (
        await lane(T1 + 700_000).reconcileImportedNotices(tenantA as TenantContext, {
          unbounded: true,
        })
      ).baselines,
    ).toBe(0);
    expect(
      await count(sql`SELECT count(*)::int AS n FROM audit_logs
                       WHERE action = 'service_reminder.imported_baselines_backfilled'`),
    ).toBe(20);
  }, 1_800_000);

  it('a sweep that runs before any baseline exists is silent for an imported service (the unproven rule)', async () => {
    await importOld(1_200);
    // `withReconcile = false`: the lane has no audit writer, so nothing is baselined first.
    expect(await drain(T1, false)).toBe(0);
    expect(await notifications()).toBe(0);
    expect(await count(sql`SELECT count(*)::int AS n FROM service_reminder_baselines`)).toBe(0);
  }, 900_000);

  it('a real transition after the reconcile is told exactly once, as for a service Nexa sold', async () => {
    const imported = await importOld(8); // g 1..8
    const nearExpiry = (
      (await exec(sql`SELECT id FROM services WHERE provider_username = 'old1'`)).rows as {
        id: string;
      }[]
    )[0]?.id;
    const usageOne = (
      (await exec(sql`SELECT id FROM services WHERE provider_username = 'old3'`)).rows as {
        id: string;
      }[]
    )[0]?.id;
    expect(imported.length).toBe(8);
    // Every other service is out of the way: a month left, nothing to cross.
    await exec(sql`UPDATE services SET expires_at = ${new Date(T0.getTime() + 60 * DAY_MS)}
                    WHERE state = 'ACTIVE' AND id NOT IN (${nearExpiry ?? ''}::uuid, ${usageOne ?? ''}::uuid)`);
    // Expiring 4.1 days after the import: at T1 about 1.1 days remain, i.e. EARLY and FIRST
    // are behind it. Move it to 9 days so that T2 is the first crossing after the baseline.
    await exec(sql`UPDATE services SET expires_at = ${new Date(T0.getTime() + 9 * DAY_MS)}
                    WHERE id = ${nearExpiry ?? ''}`);
    // A service Nexa sold, expiring on the same day.
    const customer = await fx.customer({ telegramUserId: '7299999991' });
    const native = await fx.service({
      customerId: customer,
      panelId: panel,
      state: 'ACTIVE',
      expiresAt: new Date(T0.getTime() + 9 * DAY_MS),
    });

    await lane(T1).reconcileImportedNotices(tenantA as TenantContext, { unbounded: true });
    // T1: the imported service (6 days left) is silent; the Nexa one is told EARLY, once.
    expect(await drain(T1 + 60_000)).toBe(1);
    expect(await kindsSent()).toEqual(['SERVICE_EXPIRY_EARLY']);
    await exec(sql`DELETE FROM customer_notifications`);

    // T2: 2.5 days left for both — the first threshold after the baseline. One notice each.
    expect(await drain(T2)).toBe(2);
    expect(await kindsSent()).toEqual(['SERVICE_EXPIRY_FIRST', 'SERVICE_EXPIRY_FIRST']);
    expect(
      await count(sql`SELECT count(DISTINCT customer_id)::int AS n FROM customer_notifications`),
    ).toBe(2);
    expect(native).toBeTruthy();
    // And again: nothing more.
    expect(await drain(T2 + 60_000)).toBe(0);

    // Round 5C-2: the FIRST figure recorded after the backfill (10 % at the import, 85 % now) is
    // the baseline - silent. A crossing observed by the NEXT sync (85 % -> 92 %) is told once.
    await exec(sql`DELETE FROM customer_notifications`);
    await sync([{ id: usageOne ?? '', usedBytes: (LIMIT * 85n) / 100n }], T2 + 120_000);
    expect(await drain(T2 + 180_000)).toBe(0);
    await sync([{ id: usageOne ?? '', usedBytes: (LIMIT * 92n) / 100n }], T2 + 240_000);
    expect(await drain(T2 + 300_000)).toBe(1);
    expect(await kindsSent()).toEqual(['SERVICE_USAGE_SECOND']);
    // The dispatcher's precondition holds for the legitimate ones.
    const reader = new DrizzleNotificationSubjectReader(ctx.container.database.db);
    const owed = (
      (await exec(sql`SELECT subject_id FROM customer_notifications`)).rows as {
        subject_id: string;
      }[]
    )[0]?.subject_id;
    expect(
      await reader.stillHolds(tenantA, 'SERVICE_USAGE_SECOND', owed ?? '', new Date(T2 + 360_000)),
    ).toBe(true);
  }, 600_000);

  /** Queues a notice for a service as an earlier release's sweep did, at `ms`. */
  async function queueNotice(
    serviceId: string,
    kind: ServiceReminderKind,
    notificationKind: Parameters<CustomerNotifier['notify']>[2],
    ms: number,
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
        new Date(ms),
        tx,
      );
      await notifier().notify(
        tenantA,
        row.customer_id as never,
        notificationKind,
        reminderId,
        new Date(ms),
        tx,
      );
    });
    return reminderId;
  }

  it('queued notices of imported services without a proven baseline become SUPERSEDED; nothing else changes', async () => {
    await importOld(1_600, 1_000);
    const ids = (
      (await exec(sql`SELECT id FROM services WHERE state = 'ACTIVE' ORDER BY provider_username`))
        .rows as { id: string }[]
    ).map((row) => row.id);
    expect(ids.length).toBeGreaterThan(900);
    const kinds: [ServiceReminderKind, Parameters<CustomerNotifier['notify']>[2]][] = [
      ['EXPIRY_EARLY', 'SERVICE_EXPIRY_EARLY'],
      ['EXPIRY_FIRST', 'SERVICE_EXPIRY_FIRST'],
      ['EXPIRY_SECOND', 'SERVICE_EXPIRY_SECOND'],
      ['EXPIRY_DAY', 'SERVICE_EXPIRY_DAY'],
      ['EXPIRED', 'SERVICE_EXPIRED'],
    ];
    const queuedAt = T0.getTime() + DAY_MS;
    const stale: string[] = [];
    for (let i = 0; i < 1_100; i += 1) {
      const [reminderKind, notificationKind] = kinds[i % kinds.length] ?? kinds[0]!;
      stale.push(await queueNotice(ids[i] ?? '', reminderKind, notificationKind, queuedAt));
    }
    // Usage notices the same release queued.
    const usageStale = [
      await queueNotice(ids[1_100] ?? '', 'USAGE_FIRST', 'SERVICE_USAGE_FIRST', queuedAt),
      await queueNotice(ids[1_101] ?? '', 'USAGE_FINAL', 'SERVICE_USAGE_FINAL', queuedAt),
    ];

    // What must not move.
    const customer = await fx.customer({ telegramUserId: '7299999992' });
    const native = await fx.service({
      customerId: customer,
      panelId: panel,
      state: 'ACTIVE',
      expiresAt: new Date(T0.getTime() + 9 * DAY_MS),
    });
    const nativeNotice = await queueNotice(
      native,
      'EXPIRY_FIRST',
      'SERVICE_EXPIRY_FIRST',
      queuedAt,
    );
    // An imported service that HAS a proven baseline (the import's own seed shape), notice after it.
    const seeded = ids[1_102] ?? '';
    await exec(sql`INSERT INTO service_reminder_baselines
                     (tenant_id, service_id, baseline_at, basis_expires_at,
                      basis_traffic_limit_bytes, used_bytes, created_at)
                   SELECT tenant_id, id, created_at, expires_at, traffic_limit_bytes,
                          traffic_used_bytes, created_at
                     FROM services WHERE id = ${seeded}`);
    const seededNotice = await queueNotice(
      seeded,
      'EXPIRY_FIRST',
      'SERVICE_EXPIRY_FIRST',
      queuedAt,
    );
    const failed = await queueNotice(
      ids[1_103] ?? '',
      'EXPIRY_FIRST',
      'SERVICE_EXPIRY_FIRST',
      queuedAt,
    );
    await exec(sql`UPDATE customer_notifications SET state = 'FAILED', resolved_at = now()
                    WHERE subject_id = ${failed}`);
    const delivered = await queueNotice(
      ids[1_104] ?? '',
      'EXPIRY_SECOND',
      'SERVICE_EXPIRY_SECOND',
      queuedAt,
    );
    await exec(sql`UPDATE customer_notifications SET state = 'DELIVERED', resolved_at = now()
                    WHERE subject_id = ${delivered}`);
    const claimed = await queueNotice(
      ids[1_105] ?? '',
      'EXPIRY_FIRST',
      'SERVICE_EXPIRY_FIRST',
      queuedAt,
    );
    await exec(sql`UPDATE customer_notifications SET send_started_at = now()
                    WHERE subject_id = ${claimed}`);

    const snapshot = async () =>
      (
        await exec(sql`SELECT id, state, resolved_at, updated_at, send_started_at, attempts
                         FROM customer_notifications WHERE subject_id = ANY(${sql.param([
                           nativeNotice,
                           seededNotice,
                           failed,
                           delivered,
                           claimed,
                         ])}::uuid[]) ORDER BY id`)
      ).rows;
    const untouchedBefore = await snapshot();
    const total = await notifications();

    await lane(T1).reconcileImportedNotices(tenantA as TenantContext, { unbounded: true });

    expect(await notifications()).toBe(total); // never a delete, never a new row
    expect(
      await count(sql`SELECT count(*)::int AS n FROM customer_notifications
                       WHERE state = 'SUPERSEDED' AND resolved_at IS NOT NULL`),
    ).toBe(stale.length + usageStale.length);
    expect(
      await count(sql`SELECT count(*)::int AS n FROM customer_notifications
                       WHERE subject_id = ANY(${sql.param(stale)}::uuid[]) AND state = 'SUPERSEDED'`),
    ).toBe(stale.length);
    expect(await snapshot()).toEqual(untouchedBefore);
    expect(
      await count(sql`SELECT count(*)::int AS n FROM customer_notifications
                       WHERE state = 'PENDING'`),
    ).toBe(3); // native, seeded, claimed
    // One audit row per batch of 500: 500 + 500 + 100 expiry-family notices.
    const audits = (
      await exec(sql`SELECT after FROM audit_logs
                      WHERE action = 'service_reminder.imported_notices_superseded'
                      ORDER BY occurred_at`)
    ).rows as { after: { count: number } }[];
    expect(audits.map((row) => row.after.count).sort((a, b) => a - b)).toEqual([100, 500, 500]);
    // Idempotent.
    await lane(T1 + 60_000).reconcileImportedNotices(tenantA as TenantContext, { unbounded: true });
    expect(
      await count(sql`SELECT count(*)::int AS n FROM audit_logs
                       WHERE action = 'service_reminder.imported_notices_superseded'`),
    ).toBe(3);
  }, 900_000);

  it('the send-time precondition refuses the same notices before the reconcile has run', async () => {
    const [id] = await importOld(1, 4); // g = 5: ACTIVE, expiring ~4.5 days after the import
    const stale = await queueNotice(
      id ?? '',
      'EXPIRY_FIRST',
      'SERVICE_EXPIRY_FIRST',
      T0.getTime() + DAY_MS,
    );
    const customer = await fx.customer({ telegramUserId: '7299999993' });
    const native = await fx.service({
      customerId: customer,
      panelId: panel,
      state: 'ACTIVE',
      expiresAt: new Date(T0.getTime() + 9 * DAY_MS),
    });
    const owed = await queueNotice(
      native,
      'EXPIRY_FIRST',
      'SERVICE_EXPIRY_FIRST',
      T0.getTime() + DAY_MS,
    );
    const reader = new DrizzleNotificationSubjectReader(ctx.container.database.db);
    const now = new Date(T0.getTime() + 2 * DAY_MS);
    expect(await reader.stillHolds(tenantA, 'SERVICE_EXPIRY_FIRST', stale, now)).toBe(false);
    expect(await reader.stillHolds(tenantA, 'SERVICE_EXPIRY_FIRST', owed, now)).toBe(true);
  });

  // =========================================================================
  // Item 4 — the reseller monthly minimum
  // =========================================================================

  describe('reseller monthly minimum for an imported reseller', () => {
    const periods = new TenantMonthlyPeriods();
    const OCT_WINDOW = Date.parse('2026-10-29T12:00:00.000Z');
    const NOV_WINDOW = Date.parse('2026-11-29T12:00:00.000Z');
    const IMPORTED_AT = '2026-10-10T09:00:00.000Z';

    function resellerLane(ms: number): ResellerMinimumService {
      const db = ctx.container.database.db;
      const clock = at(ms);
      return new ResellerMinimumService({
        resellers: new DrizzleResellerRepository(db),
        sales: new DrizzleReportingRepository(db),
        periods,
        presentation: new CachedTenantPresentationReader(ctx.container.tenants, clock),
        settings: {
          valueOf: async <T>(_scope: unknown, key: SettingKey) =>
            (key === 'reminders.reseller_minimum_days'
              ? 3
              : settingDefinition(key).defaultValue) as T,
        },
        features: {
          isEnabled: async (_scope: unknown, flag: FeatureFlagKey) =>
            flag === 'reseller_minimum_reminders' || flag === 'reseller_minimum_achieved_notices',
        },
        notifier: notifier(),
        guard: ctx.container.guard,
        scopeActivity: ctx.container.tenants,
        uow: ctx.container.uow,
        clock,
        ids: ctx.container.ids,
        audit: ctx.container.audit,
      });
    }

    async function twoResellers() {
      const tier = await fx.tier('minimum');
      await exec(sql`UPDATE reseller_tiers SET monthly_minimum_amount = 100000,
                                               monthly_minimum_currency = 'IRT'
                      WHERE id = ${tier}`);
      const imported = await fx.customer({ telegramUserId: '7399999991' });
      const native = await fx.customer({ telegramUserId: '7399999992' });
      await fx.reseller(imported, tier);
      await fx.reseller(native, tier);
      await exec(sql`UPDATE resellers SET source = 'MIRZA', source_ref = 'agent:1',
                                          created_at = ${new Date(IMPORTED_AT)}
                      WHERE customer_id = ${imported}`);
      await exec(sql`UPDATE resellers SET created_at = ${new Date('2026-09-01T00:00:00.000Z')}
                      WHERE customer_id = ${native}`);
      return { imported, native };
    }

    it('no reminder for the month the import fell in; one for the next; a native reseller as before', async () => {
      const { imported, native } = await twoResellers();
      // Month of the import: only the native reseller is behind.
      const first = await resellerLane(OCT_WINDOW).runOnce(tenantA as TenantContext);
      expect(first).toBe(1);
      expect(
        (await exec(sql`SELECT customer_id FROM customer_notifications`)).rows as {
          customer_id: string;
        }[],
      ).toEqual([{ customer_id: native }]);
      expect(
        await count(sql`SELECT count(*)::int AS n FROM reseller_minimum_notices
                         WHERE customer_id = ${imported}`),
      ).toBe(0);
      // The next month began after the import: now it is told, once.
      expect(await resellerLane(NOV_WINDOW).runOnce(tenantA as TenantContext)).toBe(2);
      expect(
        await count(sql`SELECT count(*)::int AS n FROM customer_notifications
                         WHERE customer_id = ${imported}`),
      ).toBe(1);
      expect(await resellerLane(NOV_WINDOW + 60_000).runOnce(tenantA as TenantContext)).toBe(0);
    });

    it('queued monthly-minimum notices for the pre-import month become SUPERSEDED, and the send-time rule refuses them', async () => {
      const { imported, native } = await twoResellers();
      const octStart = new Date('2026-10-01T00:00:00.000Z');
      const octEnd = new Date('2026-11-01T00:00:00.000Z');
      const queue = async (
        customer: string,
        kind: 'REMINDER' | 'ACHIEVED',
        start: Date,
        end: Date,
      ) => {
        const id = ctx.container.ids.uuid();
        await ctx.container.uow.run(tenantA, async (tx) => {
          await new DrizzleResellerRepository(ctx.container.database.db).raiseNotice(
            tenantA,
            {
              id,
              customerId: customer,
              kind,
              periodStart: start,
              periodEnd: end,
              minimum: { amountMinor: 100_000n, currency: 'IRT' } as never,
              achieved: kind === 'ACHIEVED' ? 150_000n : 0n,
            },
            new Date(OCT_WINDOW),
            tx,
          );
          await notifier().notify(
            tenantA,
            customer as never,
            kind === 'REMINDER' ? 'RESELLER_MINIMUM_REMINDER' : 'RESELLER_MINIMUM_ACHIEVED',
            id,
            new Date(OCT_WINDOW),
            tx,
          );
        });
        return id;
      };
      const staleReminder = await queue(imported, 'REMINDER', octStart, octEnd);
      const staleAchieved = await queue(imported, 'ACHIEVED', octStart, octEnd);
      const nativeNotice = await queue(native, 'REMINDER', octStart, octEnd);
      const novStart = new Date('2026-11-01T00:00:00.000Z');
      const novNotice = await queue(
        imported,
        'REMINDER',
        novStart,
        new Date('2026-12-01T00:00:00.000Z'),
      );
      const reader = new DrizzleNotificationSubjectReader(ctx.container.database.db);
      const now = new Date(NOV_WINDOW);
      expect(
        await reader.stillHolds(
          tenantA,
          'RESELLER_MINIMUM_REMINDER',
          staleReminder,
          new Date(OCT_WINDOW),
        ),
      ).toBe(false);
      expect(
        await reader.stillHolds(
          tenantA,
          'RESELLER_MINIMUM_ACHIEVED',
          staleAchieved,
          new Date(OCT_WINDOW),
        ),
      ).toBe(false);
      expect(await reader.stillHolds(tenantA, 'RESELLER_MINIMUM_REMINDER', novNotice, now)).toBe(
        true,
      );

      const total = await notifications();
      expect(
        await resellerLane(OCT_WINDOW).reconcileImportedPeriodNotices(tenantA as TenantContext),
      ).toBe(2);
      expect(await notifications()).toBe(total);
      const states = (
        await exec(
          sql`SELECT subject_id, state FROM customer_notifications ORDER BY state, subject_id`,
        )
      ).rows as { subject_id: string; state: string }[];
      const stateOf = (id: string) => states.find((row) => row.subject_id === id)?.state;
      expect(stateOf(staleReminder)).toBe('SUPERSEDED');
      expect(stateOf(staleAchieved)).toBe('SUPERSEDED');
      expect(stateOf(nativeNotice)).toBe('PENDING');
      expect(stateOf(novNotice)).toBe('PENDING');
      expect(
        await count(sql`SELECT count(*)::int AS n FROM audit_logs
                         WHERE action = 'reseller_minimum.imported_period_notices_superseded'`),
      ).toBe(1);
    });
  });
});
