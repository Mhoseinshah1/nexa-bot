import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  ActorContext,
  BotInstanceId,
  Clock,
  CorrelationId,
  CustomerNotificationKind,
  UserId,
} from '@nexa/contracts';
import { DrizzleCustomerNotificationRepository } from '../../apps/api/src/modules/commerce/messaging/infrastructure/drizzle-customer-notification.repository';
import {
  CustomerNotificationService,
  type QuietHoursReader,
} from '../../apps/api/src/modules/commerce/messaging/application/customer-notification.service';
import type {
  CustomerMessage,
  CustomerSendResult,
} from '../../apps/api/src/modules/commerce/messaging/application/ports';
import { DrizzleCustomerRepository } from '../../apps/api/src/modules/commerce/customers/infrastructure/drizzle-customer.repository';
import { DrizzlePaymentRepository } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-payment.repository';
import { DrizzleWalletRepository } from '../../apps/api/src/modules/commerce/wallet/infrastructure/drizzle-wallet.repository';
import { DrizzleNotificationSubjectReader } from '../../apps/api/src/modules/commerce/messaging/infrastructure/drizzle-notification-subject.reader';
import { DrizzleCustomerReminderFactsReader } from '../../apps/api/src/modules/commerce/messaging/infrastructure/drizzle-customer-reminder-facts.reader';
import { DrizzleServiceReminderSnapshotReader } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service-reminder.repository';
import { SettingsQuietHoursReader } from '../../apps/api/src/modules/commerce/messaging/infrastructure/settings-quiet-hours.reader';
import { CachedTenantPresentationReader } from '../../apps/api/src/modules/control/templates/infrastructure/cached-tenant-presentation.reader';
import { QuietHoursGuard } from '../../apps/api/src/modules/control/settings/application/quiet-hours.guard';
import { DrizzleQuietHoursLock } from '../../apps/api/src/modules/control/settings/infrastructure/drizzle-quiet-hours.lock';
import { DrizzleSettingRepository } from '../../apps/api/src/modules/control/settings/infrastructure/drizzle-settings.repository';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  SEED_IDS,
  tenantA,
  type TestContext,
} from './harness';

/**
 * HF-A9: quiet hours for customer reminders, over the real lane and the real tables.
 *
 * The owner's rules, each asserted against production readers and repositories — only the
 * messenger is a recorder:
 *
 *   1. A reminder that falls due inside the window is HELD — not dropped, not sent — until
 *      the window ends, in the tenant's own timezone.
 *   2. Holding it creates nothing: the same row, the same subject, no second notification,
 *      and the producers raise nothing new while it waits.
 *   3. When it is released, it is re-checked: a payment that lapsed, a wallet topped up or
 *      a service renewed while it waited supersedes it, and nothing is sent.
 *   4. Only reminders are held. A reply or an outcome goes at once.
 *   5. Off (the default) holds nothing.
 *
 * The window is placed around the REAL clock, in the seeded tenant's zone (Asia/Tehran),
 * because the producers and the fixtures use the database's own `now()` — a fixed instant
 * for the dispatcher would disagree with every deadline the fixtures wrote.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const GIGABYTE = 1_073_741_824n;
const ALLOWANCE = 50n * GIGABYTE;
const DAY = 86_400;
const MINUTE_MS = 60_000;
const TEHRAN = 'Asia/Tehran';

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

/** The wall-clock minute of the day an instant reads in a zone. */
function localMinute(at: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value);
  return hour * 60 + minute;
}

const hhmm = (minuteOfDay: number): string => {
  const wrapped = ((minuteOfDay % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
};

describe('quiet hours for customer reminders (HF-A9)', () => {
  let ctx: TestContext;
  let owner: ActorContext;
  let panelA: string;
  let productA: string;
  let customerA: UserId;
  let n = 0;
  const key = (): string => `hfa9-quiet-${(n += 1)}`;
  let sends: CustomerMessage[] = [];
  /** What the next sends answer; DELIVERED once empty. */
  let outcomes: CustomerSendResult[] = [];

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    sends = [];
    outcomes = [];
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-hfa9', roleKeys: ['owner'] }),
    );
    panelA = ctx.container.ids.uuid();
    productA = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelA}, ${tenantA.tenantId}, 'Panel A', 'sanaei', 'https://a.example.test', 'ACTIVE')`);
    await ctx.container.database.db.execute(sql`
      INSERT INTO products (id, tenant_id, title, description, audience, sort_order, panel_id,
                            duration_days, traffic_bytes, device_limit, price_amount,
                            price_currency, status)
      VALUES (${productA}, ${tenantA.tenantId}, 'پلن', 'یک ماهه', 'EVERYONE', 10, ${panelA},
              30, ${ALLOWANCE}, 2, 250000, 'IRT', 'ACTIVE')`);
    const { customer } = await ctx.container.customers.resolveFromUpdate(
      tenantA,
      systemActor('resolve-941001'),
      {
        idempotencyKey: 'resolve-941001',
        telegramUserId: '941001',
        from: { id: 941001, first_name: 'زهرا' },
        botInstanceId: BOT_A,
      },
    );
    customerA = customer.id;
  });

  // -------------------------------------------------------------------------
  // Fixtures, in the shapes `wp-a9-reminders.test.ts` writes
  // -------------------------------------------------------------------------

  async function order(state: string, expiresInMinutes: number | null = 60): Promise<string> {
    const id = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO orders (id, tenant_id, customer_id, state, product_id, panel_id, purpose,
                          line_title, line_duration_days, line_traffic_bytes,
                          line_device_limit, line_unit_price_amount, line_quantity,
                          subtotal_amount, discount_amount, total_amount, currency, quote,
                          confirmed_at, settled_at, cancelled_at, expires_at)
      VALUES (${id}, ${tenantA.tenantId}, ${customerA}, ${state},
              ${productA}, ${panelA}, 'NEW_SERVICE', 'پلن', 30, ${ALLOWANCE}, 2, 250000, 1,
              250000, 0, 250000, 'IRT', '{"trace":[]}'::jsonb,
              now() - interval '30 minutes',
              ${state === 'PAID' ? sql`now()` : sql`NULL`},
              ${state === 'CANCELLED' ? sql`now()` : sql`NULL`},
              ${
                expiresInMinutes === null
                  ? sql`NULL`
                  : sql`now() + make_interval(secs => ${expiresInMinutes * 60})`
              })`);
    return id;
  }

  async function service(expiresInDays: number, usedBytes = 0n): Promise<string> {
    const orderId = await order('PAID');
    const id = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO services (id, tenant_id, customer_id, order_id, panel_id, product_id,
                            provider_username, subscription_ref, provider_client_id,
                            traffic_limit_bytes, traffic_used_bytes, usage_synced_at,
                            state, provisioned_at, terminated_at, expires_at)
      VALUES (${id}, ${tenantA.tenantId}, ${customerA}, ${orderId}, ${panelA}, ${productA},
              ${'u' + Math.random().toString(16).slice(2, 12)},
              ${Math.random().toString(16).slice(2).padEnd(32, '0').slice(0, 32)},
              ${ctx.container.ids.uuid()}, ${ALLOWANCE}, ${usedBytes}, now(), 'ACTIVE', now(),
              NULL, now() + make_interval(secs => ${expiresInDays * DAY}))`);
    return id;
  }

  async function pendingPayment(expiresInMinutes: number): Promise<string> {
    const id = ctx.container.ids.uuid();
    const orderId = await order('AWAITING_PAYMENT', 60);
    await ctx.container.database.db.execute(sql`
      INSERT INTO payments (id, tenant_id, customer_id, order_id, state, method, amount, currency,
                            reference, expires_at, created_at)
      VALUES (${id}, ${tenantA.tenantId}, ${customerA}, ${orderId}, 'PENDING',
              'MANUAL_TRANSFER', 250000, 'IRT', ${`NX-${key()}`},
              now() + make_interval(secs => ${expiresInMinutes * 60}),
              now() - interval '20 minutes')`);
    return id;
  }

  async function ledger(direction: 'CREDIT' | 'DEBIT', amount: bigint) {
    await ctx.container.database.db.execute(sql`
      INSERT INTO wallet_entries (id, tenant_id, customer_id, direction, reason, amount,
                                  currency, reference)
      VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, ${customerA}, ${direction},
              ${direction === 'CREDIT' ? 'ADMIN_CREDIT' : 'ADMIN_DEBIT'}, ${amount}, 'IRT',
              ${`ref-${key()}`})`);
  }

  async function setSetting(settingKey: string, value: unknown): Promise<string | null> {
    try {
      const before = await ctx.container.settingsService.get(tenantA, owner, settingKey);
      await ctx.container.settingsService.set(tenantA, owner, {
        idempotencyKey: key(),
        key: settingKey,
        value,
        expectedVersion: before.version,
      });
      return null;
    } catch (error: unknown) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  async function setFlag(flagKey: string, enabled: boolean): Promise<void> {
    const before = (await ctx.container.featureFlags.list(tenantA, owner)).find(
      (flag) => flag.key === flagKey,
    );
    if (before === undefined) throw new Error(`no such feature flag: ${flagKey}`);
    await ctx.container.featureFlags.set(tenantA, owner, {
      idempotencyKey: key(),
      key: flagKey,
      enabled,
      expectedVersion: before.version,
    });
  }

  /**
   * Turns quiet hours on with a window that holds the real clock NOW, in Tehran: from
   * `startOffset` minutes before now until `endOffset` minutes after it. Returns the instant
   * the window ends, computed independently of the code under test (Tehran has no daylight
   * saving, so a wall-clock minute is a fixed offset from UTC).
   */
  async function quietAroundNow(
    startOffset = -60,
    endOffset = 120,
    timezone = TEHRAN,
  ): Promise<Date> {
    const now = ctx.container.clock.now();
    const local = localMinute(now, timezone);
    expect(await setSetting('reminders.quiet_hours_start', hhmm(local + startOffset))).toBeNull();
    expect(await setSetting('reminders.quiet_hours_end', hhmm(local + endOffset))).toBeNull();
    await setFlag('reminder_quiet_hours', true);
    const minuteStart = Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS;
    const ahead = ((((local + endOffset) % 1440) + 1440) % 1440) - local;
    return new Date(minuteStart + (((ahead % 1440) + 1440) % 1440) * MINUTE_MS);
  }

  const servicePass = () => ctx.container.serviceReminderSweep.runOnce(tenantA);
  const walletPass = () => ctx.container.walletLowBalanceSweep.runOnce(tenantA);
  const pendingPass = () => ctx.container.pendingPaymentReminderSweep.runOnce(tenantA);

  /**
   * The dispatcher, with every production reader and the CONTAINER's own quiet-hours reader
   * — the instance the worker's lane is given — unless a test passes another.
   */
  function dispatcher(
    clock: Clock,
    quietHours: QuietHoursReader = ctx.container.reminderQuietHours,
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
          if (found.status !== 'ACTIVE') return { kind: 'BLOCKED' };
          return { kind: 'CONTACT', contact: { chatId: found.telegramUserId } };
        },
      },
      subjects: new DrizzleNotificationSubjectReader(db),
      messenger: {
        send: async (_scope, message) => {
          sends.push(message);
          return outcomes.shift() ?? { outcome: 'DELIVERED' };
        },
        acknowledge: async () => undefined,
        sendFile: async () => ({ outcome: 'REFUSED' }),
      },
      quietHours,
      uow: ctx.container.uow,
      clock,
      scopeIsActive: async () => true,
      logger: { info: () => {}, error: () => {} },
    });
  }
  const at = (instant: Date): Clock => ({ now: () => new Date(instant.getTime()) });
  const deliver = (clock: Clock = ctx.container.clock) =>
    dispatcher(clock).deliverDue(tenantA, 200);

  interface Row {
    readonly id: string;
    readonly kind: string;
    readonly subjectId: string;
    readonly state: string;
    readonly attempts: number;
    readonly nextAttemptAt: Date | null;
  }
  async function notifications(): Promise<readonly Row[]> {
    const result = await ctx.container.database.db.execute(sql`
      SELECT id, kind, subject_id, state, attempts, next_attempt_at FROM customer_notifications
       ORDER BY created_at ASC, kind ASC`);
    return (result.rows as unknown as Record<string, unknown>[]).map((row) => ({
      id: row.id as string,
      kind: row.kind as string,
      subjectId: row.subject_id as string,
      state: row.state as string,
      attempts: Number(row.attempts),
      nextAttemptAt: row.next_attempt_at === null ? null : new Date(row.next_attempt_at as string),
    }));
  }

  async function count(table: 'service_reminders' | 'customer_notifications') {
    const result = await ctx.container.database.db.execute(
      sql`SELECT COUNT(*)::int AS n FROM ${sql.raw(table)}`,
    );
    return Number((result.rows[0] as { n: number }).n);
  }

  // =========================================================================

  it('holds a reminder due inside the window until the window ends, then sends it once', async () => {
    const end = await quietAroundNow();
    await service(2.5);
    expect(await servicePass()).toEqual({ expiry: 1, usage: 0 });

    const held = await deliver();
    expect(held).toMatchObject({ claimed: 1, quietHours: 1, delivered: 0 });
    expect(sends).toHaveLength(0);
    const [row] = await notifications();
    // Not dropped, not spent: the same row, still PENDING, waiting for the window's end.
    expect(row).toMatchObject({ kind: 'SERVICE_EXPIRY_FIRST', state: 'PENDING', attempts: 0 });
    expect(row?.nextAttemptAt?.toISOString()).toBe(end.toISOString());

    // Until the window ends it is not even claimed.
    expect(await deliver()).toMatchObject({ claimed: 0 });
    expect(await deliver(at(new Date(end.getTime() - 1_000)))).toMatchObject({ claimed: 0 });

    // At the end it is sent — once.
    expect(await deliver(at(end))).toMatchObject({ claimed: 1, delivered: 1, quietHours: 0 });
    expect(sends.map((one) => one.templateKey)).toEqual(['bot.service.expiry_first']);
    expect((await notifications())[0]).toMatchObject({ state: 'DELIVERED', attempts: 1 });
    expect(await deliver(at(new Date(end.getTime() + MINUTE_MS)))).toMatchObject({ claimed: 0 });
    expect(sends).toHaveLength(1);
  });

  /*
   * Codex review of PR #107: a hold stores the window's end as it was. Shortening the window
   * or switching quiet hours off must release the held rows by the new schedule — and must
   * never pull forward a row waiting for any other reason.
   */
  it('sends a held reminder at the NEW end when the window is shortened', async () => {
    const oldEnd = await quietAroundNow(-60, 120);
    await service(2.5);
    await servicePass();
    expect(await deliver()).toMatchObject({ quietHours: 1 });
    expect((await notifications())[0]?.nextAttemptAt?.toISOString()).toBe(oldEnd.toISOString());

    // The operator moves the end an hour earlier (08:00 -> 07:00, say, while it is 06:00).
    // The new end is derived from the OLD end, the one instant this test placed the window
    // around — never from a second read of the real clock. Re-reading it here once made
    // the setting a minute later than `newEnd` whenever the fixtures above crossed a
    // wall-clock minute (main CI, 2be49230: expected 20:55, stored 20:56).
    expect(
      await setSetting('reminders.quiet_hours_end', hhmm(localMinute(oldEnd, TEHRAN) - 60)),
    ).toBeNull();
    const newEnd = new Date(oldEnd.getTime() - 60 * MINUTE_MS);

    // The next pass re-holds it to the new end, and does not send it early. It runs in the
    // wall-clock minute AFTER the one the window was placed in — pinned, so that boundary
    // is crossed on every run rather than on the runs that happen to be slow.
    const nextMinute = new Date(oldEnd.getTime() - 119 * MINUTE_MS);
    expect(await deliver(at(nextMinute))).toMatchObject({ quietReleased: 1, claimed: 0 });
    expect((await notifications())[0]?.nextAttemptAt?.toISOString()).toBe(newEnd.toISOString());
    expect(await deliver(at(new Date(newEnd.getTime() - 1_000)))).toMatchObject({ claimed: 0 });
    expect(await deliver(at(newEnd))).toMatchObject({ claimed: 1, delivered: 1 });
    expect(sends).toHaveLength(1);
  });

  it('sends held reminders on the next pass once quiet hours are switched off', async () => {
    await quietAroundNow();
    await service(2.5);
    await service(2.6);
    await servicePass();
    expect(await deliver()).toMatchObject({ quietHours: 2 });

    await setFlag('reminder_quiet_hours', false);
    expect(await deliver()).toMatchObject({ quietReleased: 2, claimed: 2, delivered: 2 });
    expect(sends).toHaveLength(2);
    expect((await notifications()).every((row) => row.state === 'DELIVERED')).toBe(true);
  });

  it('never pulls forward a reminder waiting on a retry backoff or a rate limit', async () => {
    // Quiet hours off: every pass asks the lane to release holds to NOW, the strongest pull.
    await service(2.5);
    await service(2.6);
    await servicePass();
    outcomes = [{ outcome: 'REFUSED' }, { outcome: 'RATE_LIMITED', retryAfterMs: 3_600_000 }];
    expect(await deliver()).toMatchObject({ pending: 1, rateLimited: 1 });
    const before = await notifications();
    expect(before.every((row) => (row.nextAttemptAt?.getTime() ?? 0) > Date.now())).toBe(true);

    expect(await deliver()).toMatchObject({ quietReleased: 0, claimed: 0 });
    const after = await notifications();
    expect(after.map((row) => [row.id, row.nextAttemptAt?.toISOString(), row.attempts])).toEqual(
      before.map((row) => [row.id, row.nextAttemptAt?.toISOString(), row.attempts]),
    );
    expect(sends).toHaveLength(2);
  });

  it('creates no duplicate while a reminder is held, however often the sweeps run', async () => {
    const end = await quietAroundNow();
    await service(2.5);
    await pendingPayment(8);
    await setFlag('wallet_low_balance_reminders', true);
    expect(
      await setSetting('wallet.low_balance.threshold', { amountMinor: '50000', currency: 'IRT' }),
    ).toBeNull();
    await ledger('CREDIT', 100_000n);
    await ledger('DEBIT', 70_000n);

    await servicePass();
    await walletPass();
    await pendingPass();
    const before = await notifications();
    expect(before.map((row) => row.kind).sort()).toEqual([
      'PAYMENT_PENDING_REMINDER',
      'SERVICE_EXPIRY_FIRST',
      'WALLET_LOW_BALANCE',
    ]);
    const reminders = await count('service_reminders');

    expect(await deliver()).toMatchObject({ claimed: 3, quietHours: 3 });
    // The worker restarts and every sweep and the lane run again, inside the window.
    for (let pass = 0; pass < 3; pass += 1) {
      await servicePass();
      await walletPass();
      await pendingPass();
      expect(await deliver()).toMatchObject({ claimed: 0 });
    }
    const after = await notifications();
    expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
    expect(after.every((row) => row.state === 'PENDING' && row.attempts === 0)).toBe(true);
    expect(after.every((row) => row.nextAttemptAt?.getTime() === end.getTime())).toBe(true);
    expect(await count('service_reminders')).toBe(reminders);
    expect(sends).toHaveLength(0);
  });

  it('does not send a held reminder that expired or stopped being true while it waited', async () => {
    const end = await quietAroundNow();
    // A payment eight minutes from its deadline: reminded, then held two hours past it.
    await pendingPayment(8);
    // A wallet below its threshold: reminded, then topped up while it waits.
    await setFlag('wallet_low_balance_reminders', true);
    expect(
      await setSetting('wallet.low_balance.threshold', { amountMinor: '50000', currency: 'IRT' }),
    ).toBeNull();
    await ledger('CREDIT', 100_000n);
    await ledger('DEBIT', 70_000n);
    // A service three days out: reminded, then renewed while it waits.
    const renewed = await service(2.5);
    // And one that nothing happens to, so the pass is seen to send what still holds.
    await service(2.6);

    await pendingPass();
    await walletPass();
    await servicePass();
    expect(await deliver()).toMatchObject({ claimed: 4, quietHours: 4 });

    await ledger('CREDIT', 100_000n);
    await ctx.container.database.db.execute(
      sql`UPDATE services SET expires_at = expires_at + interval '30 days' WHERE id = ${renewed}`,
    );

    const released = await deliver(at(end));
    expect(released).toMatchObject({ claimed: 4, superseded: 3, delivered: 1, quietHours: 0 });
    expect(sends.map((one) => one.templateKey)).toEqual(['bot.service.expiry_first']);
    const states = new Map((await notifications()).map((row) => [row.kind, row.state]));
    expect(states.get('PAYMENT_PENDING_REMINDER')).toBe('SUPERSEDED');
    expect(states.get('WALLET_LOW_BALANCE')).toBe('SUPERSEDED');
  });

  it('releases one low-balance alert, not two, for a wallet that fell twice while held', async () => {
    const end = await quietAroundNow();
    await setFlag('wallet_low_balance_reminders', true);
    expect(
      await setSetting('wallet.low_balance.threshold', { amountMinor: '50000', currency: 'IRT' }),
    ).toBeNull();
    await ledger('CREDIT', 100_000n);
    await ledger('DEBIT', 60_000n); // 40,000: below
    expect(await walletPass()).toEqual({ alerts: 1 });
    expect(await deliver()).toMatchObject({ quietHours: 1 });

    await ledger('CREDIT', 20_000n); // 60,000: recovered
    expect(await walletPass()).toEqual({ alerts: 0 });
    await ledger('DEBIT', 30_000n); // 30,000: a second fall, its own alert, also held
    expect(await walletPass()).toEqual({ alerts: 1 });
    expect(await deliver()).toMatchObject({ quietHours: 1 });

    expect(await deliver(at(end))).toMatchObject({ claimed: 2, delivered: 1, superseded: 1 });
    expect(sends).toHaveLength(1);
    expect(sends[0]?.values).toMatchObject({ balance: { amountMinor: 30_000n, currency: 'IRT' } });
  });

  it('holds a window that crosses midnight until its end tomorrow', async () => {
    // From an hour ago until ninety minutes ago: a window that holds now and ends almost a
    // day later, so for all but half an hour of the day its start is later than its end.
    const end = await quietAroundNow(-60, -90);
    const hoursAway = (end.getTime() - ctx.container.clock.now().getTime()) / 3_600_000;
    expect(hoursAway).toBeGreaterThan(22);
    expect(hoursAway).toBeLessThanOrEqual(22.5);

    await service(2.5);
    await servicePass();
    expect(await deliver()).toMatchObject({ quietHours: 1 });
    expect((await notifications())[0]?.nextAttemptAt?.toISOString()).toBe(end.toISOString());
    expect(await deliver(at(end))).toMatchObject({ delivered: 1 });
  });

  /** A reader with a fresh presentation cache, for a case that moves the tenant's zone. */
  const freshReader = () =>
    new SettingsQuietHoursReader({
      settings: ctx.container.settingsResolver,
      features: ctx.container.featureFlagResolver,
      presentation: new CachedTenantPresentationReader(ctx.container.tenants, ctx.container.clock),
    });

  /** Moves tenant A to a whole-hour zone whose wall clock reads about `hour` now. */
  async function pinLocalHour(hour: number): Promise<string> {
    let offset = hour - ctx.container.clock.now().getUTCHours();
    while (offset > 14) offset -= 24;
    while (offset < -12) offset += 24;
    const zone =
      offset === 0 ? 'Etc/UTC' : `Etc/GMT${offset > 0 ? '-' : '+'}${String(Math.abs(offset))}`;
    await ctx.container.database.db.execute(
      sql`UPDATE tenants SET display_timezone = ${zone} WHERE id = ${tenantA.tenantId}`,
    );
    return zone;
  }

  it('does not release a held usage warning once a more urgent one was raised for the period', async () => {
    const end = await quietAroundNow();
    const id = await service(30, (ALLOWANCE * 85n) / 100n);
    expect(await servicePass()).toEqual({ expiry: 0, usage: 1 });
    expect(await deliver()).toMatchObject({ quietHours: 1 });

    // Overnight the customer uses almost everything: the final warning is raised, and held.
    await ctx.container.database.db.execute(
      sql`UPDATE services SET traffic_used_bytes = ${(ALLOWANCE * 97n) / 100n} WHERE id = ${id}`,
    );
    expect(await servicePass()).toEqual({ expiry: 0, usage: 1 });
    expect(await deliver()).toMatchObject({ quietHours: 1 });

    // At the window's end the customer is told how things stand NOW — 5% left — and not,
    // in the same breath, the stale "20% left" that was queued first.
    expect(await deliver(at(end))).toMatchObject({ claimed: 2, delivered: 1, superseded: 1 });
    expect(sends.map((one) => one.templateKey)).toEqual(['bot.service.usage_final']);
    const states = new Map((await notifications()).map((row) => [row.kind, row.state]));
    expect(states.get('SERVICE_USAGE_FIRST')).toBe('SUPERSEDED');
    expect(states.get('SERVICE_USAGE_FINAL')).toBe('DELIVERED');
  });

  it('does not release "expires tomorrow" once "expires today" has been raised', async () => {
    try {
      // Local 20:00; quiet from 19:00 to 22:00. A deadline 23 hours out is tomorrow.
      const zone = await pinLocalHour(20);
      await quietAroundNow(-60, 120, zone);
      await service(23 / 24);
      expect(await servicePass()).toEqual({ expiry: 1, usage: 0 });
      expect(
        await dispatcher(ctx.container.clock, freshReader()).deliverDue(tenantA, 200),
      ).toMatchObject({ quietHours: 1 });

      // The tenant's clock reaches the deadline's own date: "expires today" is raised, and
      // outside this zone's window it is sent at once. The move also takes the held "expires
      // tomorrow" out of the window, so the same pass releases it — and, now false, it is
      // superseded rather than sent beside "expires today".
      await pinLocalHour(0);
      expect(await servicePass()).toEqual({ expiry: 1, usage: 0 });
      expect(
        await dispatcher(ctx.container.clock, freshReader()).deliverDue(tenantA, 200),
      ).toMatchObject({ quietReleased: 1, claimed: 2, delivered: 1, superseded: 1, quietHours: 0 });
      expect(sends.map((one) => one.templateKey)).toEqual(['bot.service.expiry_day']);
    } finally {
      await ctx.container.database.db.execute(
        sql`UPDATE tenants SET display_timezone = ${TEHRAN} WHERE id = ${tenantA.tenantId}`,
      );
    }
  });

  it('follows the tenant’s own timezone', async () => {
    // The window holds now in Tehran; the tenant moves to a zone twelve hours away, where
    // the same wall-clock window does not.
    await quietAroundNow();
    await ctx.container.database.db.execute(
      sql`UPDATE tenants SET display_timezone = 'Pacific/Kiritimati' WHERE id = ${tenantA.tenantId}`,
    );
    // A fresh presentation cache, so the move is read now rather than in a minute.
    const reader = new SettingsQuietHoursReader({
      settings: ctx.container.settingsResolver,
      features: ctx.container.featureFlagResolver,
      presentation: new CachedTenantPresentationReader(ctx.container.tenants, ctx.container.clock),
    });
    try {
      await service(2.5);
      await servicePass();
      expect(await dispatcher(ctx.container.clock, reader).deliverDue(tenantA, 200)).toMatchObject({
        delivered: 1,
        quietHours: 0,
      });
    } finally {
      await ctx.container.database.db.execute(
        sql`UPDATE tenants SET display_timezone = ${TEHRAN} WHERE id = ${tenantA.tenantId}`,
      );
    }
  });

  /** Queues one notification directly, as a producer's transaction would. */
  const enqueueNow = (kind: CustomerNotificationKind, subjectId: string) =>
    ctx.container.uow.run(tenantA, (tx) =>
      ctx.container.customerNotifications.enqueue(
        tenantA,
        {
          id: ctx.container.ids.uuid(),
          customerId: customerA,
          botInstanceId: BOT_A,
          kind,
          subjectId,
        },
        ctx.container.clock.now(),
        tx,
      ),
    );

  it('sends an immediate kind ahead of a released reminder backlog larger than the pass', async () => {
    // Codex review of PR #107: at the window's end every held reminder is due at once, and
    // a bounded oldest-first claim let that backlog fill the pass ahead of a payment outcome.
    const end = await quietAroundNow();
    for (let one = 0; one < 3; one += 1) await service(2.5 + one / 10);
    expect(await servicePass()).toEqual({ expiry: 3, usage: 0 });
    expect(await deliver()).toMatchObject({ quietHours: 3 });
    // An outcome the customer is waiting on, queued LAST — the youngest row of all.
    expect(await enqueueNow('ORDER_CANCELLED', await order('CANCELLED', null))).toBe(true);

    // A pass bounded to two, at the window's end: four rows are due.
    const pass = await dispatcher(at(end)).deliverDue(tenantA, 2);
    expect(pass).toMatchObject({ claimed: 2, delivered: 2 });
    expect(sends[0]?.templateKey).toBe('bot.order.cancelled');
    // The backlog is not lost: the next pass takes the rest.
    expect(await dispatcher(at(end)).deliverDue(tenantA, 2)).toMatchObject({ delivered: 2 });
    expect(sends).toHaveLength(4);
  });

  it('never holds a reply or an outcome, only reminders', async () => {
    await quietAroundNow();
    const cancelled = await order('CANCELLED', null);
    await service(2.5);
    await servicePass();
    const now = ctx.container.clock.now();
    const enqueue = (kind: CustomerNotificationKind, subjectId: string) =>
      ctx.container.uow.run(tenantA, (tx) =>
        ctx.container.customerNotifications.enqueue(
          tenantA,
          {
            id: ctx.container.ids.uuid(),
            customerId: customerA,
            botInstanceId: BOT_A,
            kind,
            subjectId,
          },
          now,
          tx,
        ),
      );
    expect(await enqueue('ORDER_CANCELLED', cancelled)).toBe(true);

    expect(await deliver()).toMatchObject({ claimed: 2, delivered: 1, quietHours: 1 });
    expect(sends.map((one) => one.templateKey)).toEqual(['bot.order.cancelled']);
    const states = new Map((await notifications()).map((row) => [row.kind, row.state]));
    expect(states.get('ORDER_CANCELLED')).toBe('DELIVERED');
    expect(states.get('SERVICE_EXPIRY_FIRST')).toBe('PENDING');
  });

  it('holds nothing while quiet hours are off, which is the default', async () => {
    // The window would hold now; the switch has never been turned on.
    const now = ctx.container.clock.now();
    const local = localMinute(now, TEHRAN);
    expect(await setSetting('reminders.quiet_hours_start', hhmm(local - 60))).toBeNull();
    expect(await setSetting('reminders.quiet_hours_end', hhmm(local + 120))).toBeNull();
    expect(await ctx.container.reminderQuietHours.scheduleFor(tenantA)).toBeNull();

    await service(2.5);
    await servicePass();
    expect(await deliver()).toMatchObject({ delivered: 1, quietHours: 0 });

    // Turned on and off again: still nothing held.
    await setFlag('reminder_quiet_hours', true);
    expect(await ctx.container.reminderQuietHours.scheduleFor(tenantA)).not.toBeNull();
    await setFlag('reminder_quiet_hours', false);
    await service(2.6);
    await servicePass();
    expect(await deliver()).toMatchObject({ delivered: 1, quietHours: 0 });
    expect(sends).toHaveLength(2);
  });

  it('refuses the second of two concurrent writes that would make start equal end', async () => {
    // Codex review of PR #107: under READ COMMITTED each write read the OTHER boundary's
    // old value, so both passed and an equal pair was committed. Deterministic here: the
    // first write holds its transaction open after its guard ran and its row was written.
    const settings = ctx.container.settingsResolver;
    const lock = new DrizzleQuietHoursLock();
    const startGuard = new QuietHoursGuard('reminders.quiet_hours_start', settings, lock);
    const endGuard = new QuietHoursGuard('reminders.quiet_hours_end', settings, lock);
    const rows = new DrizzleSettingRepository(ctx.container.database.db);

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstReady: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      firstReady = resolve;
    });
    // First: the start moves onto 07:00 (the end is still 08:00, so it passes) and waits.
    const first = ctx.container.uow.run(tenantA, async (tx) => {
      const refusal = await startGuard.refuseChange(tenantA, { from: '23:00', to: '07:00' }, tx);
      await rows.upsert(
        tenantA,
        {
          id: ctx.container.ids.uuid(),
          key: 'reminders.quiet_hours_start',
          value: '07:00',
          expectedVersion: null,
          now: ctx.container.clock.now(),
          adminId: null,
        },
        tx,
      );
      firstReady();
      await gate;
      return refusal;
    });
    await ready;
    // Second, concurrently: the end moves onto 07:00. It must wait for the first to commit.
    let secondDone = false;
    const second = ctx.container.uow
      .run(tenantA, (tx) => endGuard.refuseChange(tenantA, { from: '08:00', to: '07:00' }, tx))
      .finally(() => {
        secondDone = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const waited = !secondDone;
    // Released whatever was observed, so a failure here cannot leave a transaction open.
    release();

    expect(await first).toBeNull();
    expect(await second).toMatch(/یکسان/);
    expect(waited, 'the second guard waited for the first write').toBe(true);
  });

  it('commits exactly one of two concurrent writes that would make start equal end', async () => {
    const [start, end] = await Promise.all([
      setSetting('reminders.quiet_hours_start', '07:00'),
      setSetting('reminders.quiet_hours_end', '07:00'),
    ]);
    expect([start, end].filter((refusal) => refusal === null)).toHaveLength(1);
    expect([start, end].find((refusal) => refusal !== null)).toMatch(/یکسان/);
    const settings = ctx.container.settingsResolver;
    expect(await settings.valueOf(tenantA, 'reminders.quiet_hours_start')).not.toBe(
      await settings.valueOf(tenantA, 'reminders.quiet_hours_end'),
    );
  });

  it('refuses a window whose start and end are the same, in Persian', async () => {
    expect(await setSetting('reminders.quiet_hours_start', '08:00')).toMatch(/یکسان/);
    expect(await setSetting('reminders.quiet_hours_end', '23:00')).toMatch(/یکسان/);
    expect(await setSetting('reminders.quiet_hours_start', '8:00')).not.toBeNull();
    // Any other pair is a window, crossing midnight or not.
    expect(await setSetting('reminders.quiet_hours_start', '01:00')).toBeNull();
    expect(await setSetting('reminders.quiet_hours_end', '06:30')).toBeNull();
    const settings = ctx.container.settingsResolver;
    expect(await settings.valueOf(tenantA, 'reminders.quiet_hours_start')).toBe('01:00');
    expect(await settings.valueOf(tenantA, 'reminders.quiet_hours_end')).toBe('06:30');
  });
});
