import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  REMINDER_BURST_CLEARED_CODE,
  REMINDER_BURST_CODE,
  featureFlagDefinition,
  settingDefinition,
  type BotInstanceId,
  type Clock,
  type FeatureFlagKey,
  type SettingKey,
  type UserId,
} from '@nexa/contracts';
import { DrizzleCustomerNotificationRepository } from '../../apps/api/src/modules/commerce/messaging/infrastructure/drizzle-customer-notification.repository';
import {
  DrizzleReminderRaiseCounter,
  DrizzleReminderRateWindowStore,
} from '../../apps/api/src/modules/commerce/messaging/infrastructure/drizzle-reminder-rate-window.store';
import type { ReminderRateWindowStore } from '../../apps/api/src/modules/commerce/messaging/application/reminder-rate';
import { CustomerNotificationService } from '../../apps/api/src/modules/commerce/messaging/application/customer-notification.service';
import { CustomerNotifier } from '../../apps/api/src/modules/commerce/messaging/application/customer-notifier';
import type { CustomerMessage } from '../../apps/api/src/modules/commerce/messaging/application/ports';
import { DrizzleCustomerRepository } from '../../apps/api/src/modules/commerce/customers/infrastructure/drizzle-customer.repository';
import { DrizzlePaymentRepository } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-payment.repository';
import { DrizzleWalletRepository } from '../../apps/api/src/modules/commerce/wallet/infrastructure/drizzle-wallet.repository';
import { DrizzleNotificationSubjectReader } from '../../apps/api/src/modules/commerce/messaging/infrastructure/drizzle-notification-subject.reader';
import { DrizzleCustomerReminderFactsReader } from '../../apps/api/src/modules/commerce/messaging/infrastructure/drizzle-customer-reminder-facts.reader';
import {
  DrizzleServiceReminderRepository,
  DrizzleServiceReminderSnapshotReader,
} from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service-reminder.repository';
import { ServiceReminderService } from '../../apps/api/src/modules/commerce/provisioning/application/service-reminder.service';
import { AudienceFixtures } from './audience-fixtures';
import { createTestContext, SEED_IDS, tenantA, type TestContext } from './harness';

/**
 * Round 4 PR-H — the ceiling on automatic reminders and the burst alarm, over the real
 * lane, the real tables and the real operational-event recorder. Only the messenger is a
 * recorder. Synthetic data only.
 *
 *   1. At most `reminders.max_per_minute` reminders leave in a minute; the rest wait for
 *      the next minute and none is lost.
 *   2. A reply or an outcome is never held by it.
 *   3. Two dispatchers (two worker replicas) share ONE ceiling.
 *   4. More fresh reminders in an hour than `reminders.burst_alarm_per_hour` opens ONE
 *      condition in the ERRORS topic; an hour that ends below it closes it, once.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

describe('Round 4 PR-H: the reminder ceiling and the burst alarm', () => {
  let ctx: TestContext;
  let fx: AudienceFixtures;
  let panel: string;
  let sends: CustomerMessage[] = [];
  let limits = { perMinute: 5, burstPerHour: 0 };
  /** The reminder flags switched off for the dispatcher's kill switch; every other is on. */
  let flagsOff = new Set<string>();
  let base = 0;
  let n = 0;

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 600_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    sends = [];
    limits = { perMinute: 5, burstPerHour: 0 };
    flagsOff = new Set<string>();
    fx = new AudienceFixtures(ctx, tenantA.tenantId as string);
    panel = await fx.panel('ceiling');
    base = Date.now();
  });

  const at = (ms: number): Clock => ({ now: () => new Date(ms) });

  function dispatcher(
    ms: number,
    windows: ReminderRateWindowStore = new DrizzleReminderRateWindowStore(),
  ): CustomerNotificationService {
    const db = ctx.container.database.db;
    const people = new DrizzleCustomerRepository(db);
    return new CustomerNotificationService({
      notifications: new DrizzleCustomerNotificationRepository(db),
      refundFigures: new DrizzleWalletRepository(db),
      paymentCredits: new DrizzleWalletRepository(db),
      rejectionReasons: new DrizzlePaymentRepository(db),
      reminderSnapshots: new DrizzleServiceReminderSnapshotReader(db),
      reminderFacts: new DrizzleCustomerReminderFactsReader(db),
      contacts: {
        contactFor: async (scope, customerId, tx) => {
          const found = await people.findById(scope, customerId, tx);
          if (found === null) return { kind: 'NONE' };
          return { kind: 'CONTACT', contact: { chatId: found.telegramUserId } };
        },
      },
      subjects: new DrizzleNotificationSubjectReader(db),
      messenger: {
        send: async (_scope, message) => {
          sends.push(message);
          return { outcome: 'DELIVERED' };
        },
        acknowledge: async () => undefined,
        sendFile: async () => ({ outcome: 'REFUSED' }),
      },
      uow: ctx.container.uow,
      clock: at(ms),
      scopeIsActive: async () => true,
      reminderRate: {
        windows,
        limits: async () => limits,
        opsLog: ctx.container.opsLog,
        raises: new DrizzleReminderRaiseCounter(),
        isEnabled: async (_scope, key) => flagsOff.has(key) === false,
      },
      logger: { info: () => {}, error: () => {} },
    });
  }
  const deliver = (offsetMs = 0) => dispatcher(base + offsetMs).deliverDue(tenantA, 200);

  /** `count` services 2.5 days from their deadline, and the one pass that raises them. */
  async function raiseReminders(count: number): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      const customer = await fx.customer({
        telegramUserId: `95${String((n += 1)).padStart(6, '0')}`,
      });
      await fx.service({
        customerId: customer,
        panelId: panel,
        expiresAt: new Date(base + 2.5 * DAY_MS),
      });
    }
    const db = ctx.container.database.db;
    const lane = new ServiceReminderService({
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
        raises: new DrizzleReminderRaiseCounter(),
      }),
      scopeActivity: ctx.container.tenants,
      uow: ctx.container.uow,
      clock: at(base),
      ids: ctx.container.ids,
    });
    expect((await lane.runOnce(tenantA)).expiry).toBe(count);
  }

  const pending = async (): Promise<number> =>
    Number(
      (
        (
          await ctx.container.database.db.execute(
            sql`SELECT count(*)::int AS n FROM customer_notifications WHERE state = 'PENDING'`,
          )
        ).rows[0] as { n: number }
      ).n,
    );

  const events = async (code: string) =>
    (
      await ctx.container.database.db.execute(
        sql`SELECT occurrence_count, resolved_at FROM operational_events WHERE code = ${code}`,
      )
    ).rows as { occurrence_count: number; resolved_at: string | null }[];

  it('lets at most the ceiling leave in a minute, and the rest in the minutes after, none lost', async () => {
    await raiseReminders(12);
    expect(await deliver()).toMatchObject({ claimed: 5, delivered: 5 });
    // The same minute: the ceiling is spent.
    expect(await deliver(20_000)).toMatchObject({ claimed: 0 });
    expect(await deliver(59_000)).toMatchObject({ claimed: 0 });
    expect(await pending()).toBe(7);
    // The next minute, and the one after.
    expect(await deliver(MINUTE_MS)).toMatchObject({ claimed: 5, delivered: 5 });
    expect(await deliver(2 * MINUTE_MS + 1_000)).toMatchObject({ claimed: 2, delivered: 2 });
    expect(sends).toHaveLength(12);
    expect(await pending()).toBe(0);
  });

  it('never holds a reply or an outcome: an immediate kind is claimed with the ceiling spent', async () => {
    await raiseReminders(6);
    expect(await deliver()).toMatchObject({ claimed: 5 });
    const customer = await fx.customer({ telegramUserId: '95999999' });
    await ctx.container.uow.run(tenantA, (tx) =>
      new DrizzleCustomerNotificationRepository(ctx.container.database.db).enqueue(
        tenantA,
        {
          id: ctx.container.ids.uuid(),
          customerId: customer as UserId,
          botInstanceId: BOT_A,
          kind: 'ORDER_CANCELLED',
          subjectId: ctx.container.ids.uuid(),
        },
        new Date(base + 10_000),
        tx,
      ),
    );
    // Inside the spent minute: the outcome is claimed, the sixth reminder is not.
    const report = await deliver(15_000);
    expect(report.claimed).toBe(1);
    const rows = (
      await ctx.container.database.db.execute(sql`
        SELECT kind, state FROM customer_notifications
         WHERE state = 'PENDING' ORDER BY kind`)
    ).rows as { kind: string }[];
    expect(rows.map((row) => row.kind)).toEqual(['SERVICE_EXPIRY_FIRST']);
  });

  it('two dispatchers at once share one ceiling: the second waits on the first one’s row', async () => {
    // The window row exists already (an earlier, empty pass), so the first-ever insert cannot
    // be what serialises them — only the row lock can.
    await deliver(-2 * MINUTE_MS);
    await raiseReminders(12);

    // A takes the row and holds it until B has read the window (or 1.5 s pass); B returns
    // its read only once A has finished. With the lock, B's read cannot happen until A has
    // committed, so A waits out the 1.5 s, commits, and B reads A's count. Without it, B
    // reads the empty minute at once and claims a second ceiling's worth.
    let aLocked!: () => void;
    const aHasLocked = new Promise<void>((resolve) => (aLocked = resolve));
    let bRead!: () => void;
    const bHasRead = new Promise<void>((resolve) => (bRead = resolve));
    let aDone!: () => void;
    const aHasFinished = new Promise<void>((resolve) => (aDone = resolve));
    const real = new DrizzleReminderRateWindowStore();
    const first: ReminderRateWindowStore = {
      lock: async (scope, now, tx) => {
        const window = await real.lock(scope, now, tx);
        aLocked();
        await Promise.race([bHasRead, new Promise((resolve) => setTimeout(resolve, 1_500))]);
        return window;
      },
      save: (scope, window, now, tx) => real.save(scope, window, now, tx),
    };
    const second: ReminderRateWindowStore = {
      lock: async (scope, now, tx) => {
        const window = await real.lock(scope, now, tx);
        bRead();
        await aHasFinished;
        return window;
      },
      save: (scope, window, now, tx) => real.save(scope, window, now, tx),
    };
    const a = dispatcher(base, first)
      .deliverDue(tenantA, 200)
      .finally(() => aDone());
    await aHasLocked;
    const b = dispatcher(base + 10, second).deliverDue(tenantA, 200);
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.claimed + rb.claimed).toBe(5);
    expect(sends).toHaveLength(5);
  });

  it('opens one burst condition for the ERRORS topic, keeps it while the hour stays high, and closes it once an hour ends quiet', async () => {
    limits = { perMinute: 5, burstPerHour: 3 };
    // The lane is running before the sweep raises anything, as it is from a worker's boot.
    await deliver(-1_000);
    await raiseReminders(12);
    expect(await events(REMINDER_BURST_CODE)).toEqual([]);

    await deliver();
    const opened = await events(REMINDER_BURST_CODE);
    expect(opened).toHaveLength(1);
    expect(opened[0]?.resolved_at).toBeNull();

    // Still above it in the same hour: no second announcement, no second row.
    await deliver(MINUTE_MS);
    await deliver(2 * MINUTE_MS);
    expect(await events(REMINDER_BURST_CODE)).toHaveLength(1);
    expect((await events(REMINDER_BURST_CODE))[0]?.occurrence_count).toBe(1);
    expect(await events(REMINDER_BURST_CLEARED_CODE)).toEqual([]);

    // The burst hour ends: it was above the threshold, so the condition stays open.
    await deliver(61 * MINUTE_MS);
    expect(await events(REMINDER_BURST_CLEARED_CODE)).toEqual([]);
    // The next hour ends quiet: closed, once.
    await deliver(122 * MINUTE_MS);
    expect(await events(REMINDER_BURST_CLEARED_CODE)).toHaveLength(1);
    expect((await events(REMINDER_BURST_CODE))[0]?.resolved_at).not.toBeNull();
    await deliver(123 * MINUTE_MS);
    await deliver(190 * MINUTE_MS);
    expect(await events(REMINDER_BURST_CLEARED_CODE)).toHaveLength(1);
  });

  it('counts reminders as they are RAISED: a ceiling far below the threshold still opens the alarm, and a backlog claimed later never keeps it open', async () => {
    // Codex review of PR #296: one a minute could never claim more than 60 in an hour, so a
    // claim-based count would never pass a threshold of 100.
    limits = { perMinute: 1, burstPerHour: 100 };
    await deliver(-1_000);
    await raiseReminders(130);
    expect(await deliver()).toMatchObject({ claimed: 1 });
    expect(await events(REMINDER_BURST_CODE)).toHaveLength(1);
    // The backlog keeps leaving at one a minute, and those claims are not new raises: the
    // hour after the burst one is quiet, so the condition closes while the backlog drains.
    for (let minute = 1; minute <= 122; minute += 1) await deliver(minute * MINUTE_MS);
    expect(await events(REMINDER_BURST_CLEARED_CODE)).toHaveLength(1);
    expect(await pending()).toBeGreaterThan(0);
  }, 900_000);

  it('closes a stale burst after a gap: a whole quiet hour has passed with no pass at all', async () => {
    // Codex review of PR #296: a worker down for over two hours must not judge the alarm on
    // the burst hour's count when it comes back.
    limits = { perMinute: 50, burstPerHour: 3 };
    await deliver(-1_000);
    await raiseReminders(8);
    await deliver();
    expect(await events(REMINDER_BURST_CODE)).toHaveLength(1);
    await deliver(130 * MINUTE_MS);
    expect(await events(REMINDER_BURST_CLEARED_CODE)).toHaveLength(1);
    expect((await events(REMINDER_BURST_CODE))[0]?.resolved_at).not.toBeNull();
  });

  it('holds a queued reminder whose flag is switched off: not claimed, not sent, released when it is back on', async () => {
    // Codex review of PR #296: the burst alarm's advice is to switch the flags off, so
    // switching them off must halt what is already queued, not only what is raised next.
    limits = { perMinute: 50, burstPerHour: 0 };
    await raiseReminders(4);
    flagsOff = new Set(['service_expiry_reminders']);
    expect(await deliver()).toMatchObject({ claimed: 0 });
    expect(await deliver(MINUTE_MS)).toMatchObject({ claimed: 0 });
    expect(sends).toHaveLength(0);
    expect(await pending()).toBe(4);
    // Another family's switch does not hold these.
    flagsOff = new Set(['service_usage_reminders']);
    expect(await deliver(2 * MINUTE_MS)).toMatchObject({ claimed: 4, delivered: 4 });
    expect(sends).toHaveLength(4);
  });
});
