import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  featureFlagDefinition,
  settingDefinition,
  type ActorContext,
  type Clock,
  type FeatureFlagKey,
  type SettingKey,
  type BotInstanceId,
  type CorrelationId,
  type UserId,
} from '@nexa/contracts';
import { DrizzleCustomerNotificationRepository } from '../../apps/api/src/modules/commerce/messaging/infrastructure/drizzle-customer-notification.repository';
import { CustomerNotificationService } from '../../apps/api/src/modules/commerce/messaging/application/customer-notification.service';
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
import { DrizzleServiceReminderRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service-reminder.repository';
import { ServiceReminderService } from '../../apps/api/src/modules/commerce/provisioning/application/service-reminder.service';
import { CustomerNotifier } from '../../apps/api/src/modules/commerce/messaging/application/customer-notifier';
import { DrizzleWalletThresholdAlertRepository } from '../../apps/api/src/modules/commerce/wallet/infrastructure/drizzle-wallet-threshold-alert.repository';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  SEED_IDS,
  tenantA,
  tenantB,
  type TestContext,
} from './harness';

/**
 * WP-A9: reminders that are useful, configurable, durable, and never a spam loop.
 *
 * What this file proves, beyond `service-reminders.test.ts` (the lane's own mechanics) and
 * `reminder-settings.test.ts` (configuration through both surfaces):
 *
 *   1. **The owner's defaults.** 7, 3 and 1 days before, the day of expiry in the
 *      tenant's own timezone, and after; 20%, 10% and 5% of the traffic REMAINING.
 *   2. **Once per instance, and nothing per idle scan.** A second and third pass, a
 *      "restarted" sweep and a delivery that is refused and retried produce no second
 *      reminder and no new row.
 *   3. **Eligibility follows authoritative state.** A renewal or added traffic between the
 *      raise and the send SUPERSEDES the message — no "expires tomorrow" after a renewal
 *      — and the next period re-arms.
 *   4. **Wallet low balance.** Off by default; once per crossing; armed again only after
 *      the balance has been back at or above the threshold; never for a wallet that never
 *      held it; superseded at send time by a top-up.
 *   5. **Pending payments and orders.** Reminded once inside the lead, never when settled,
 *      cancelled, expired, receipted or signalled, and superseded at send time.
 *   6. **Backward compatibility.** A tenant's stored thresholds keep their meaning, and
 *      its older keys stay editable whatever the new slot says.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const GIGABYTE = 1_073_741_824n;
const ALLOWANCE = 50n * GIGABYTE;
const DAY = 86_400;

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

describe('WP-A9 reminders', () => {
  let ctx: TestContext;
  let owner: ActorContext;
  let panelA: string;
  let productA: string;
  let customerA: UserId;
  let n = 0;
  const key = (): string => `wpa9-reminder-${(n += 1)}`;

  /** Every send the fake messenger saw, and what the next ones answer. */
  let sends: CustomerMessage[] = [];
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
      await createAdmin(ctx.container, tenantA, { username: 'owner-wpa9', roleKeys: ['owner'] }),
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
    customerA = await customer('931001');
  });

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  async function customer(telegramUserId: string): Promise<UserId> {
    const { customer: record } = await ctx.container.customers.resolveFromUpdate(
      tenantA,
      systemActor(`resolve-${telegramUserId}`),
      {
        idempotencyKey: `resolve-${telegramUserId}`,
        telegramUserId,
        from: { id: Number(telegramUserId), first_name: 'زهرا' },
        botInstanceId: BOT_A,
      },
    );
    return record.id;
  }

  /** An order row, written directly in the shape `reminder-settings.test.ts` uses. */
  async function order(options: {
    readonly customerId?: UserId;
    readonly state: string;
    /** Minutes until the order's own deadline; null for none. */
    readonly expiresInMinutes?: number | null;
    /** How long ago it was confirmed, in minutes. */
    readonly confirmedMinutesAgo?: number;
  }): Promise<string> {
    const id = ctx.container.ids.uuid();
    const expires = options.expiresInMinutes ?? null;
    const confirmedAgo = options.confirmedMinutesAgo ?? 30;
    await ctx.container.database.db.execute(sql`
      INSERT INTO orders (id, tenant_id, customer_id, state, product_id, panel_id, purpose,
                          line_title, line_duration_days, line_traffic_bytes,
                          line_device_limit, line_unit_price_amount, line_quantity,
                          subtotal_amount, discount_amount, total_amount, currency, quote,
                          confirmed_at, settled_at, cancelled_at, expires_at)
      VALUES (${id}, ${tenantA.tenantId}, ${options.customerId ?? customerA}, ${options.state},
              ${productA}, ${panelA}, 'NEW_SERVICE', 'پلن', 30, ${ALLOWANCE}, 2, 250000, 1,
              250000, 0, 250000, 'IRT', '{"trace":[]}'::jsonb,
              now() - make_interval(mins => ${confirmedAgo}),
              ${options.state === 'PAID' ? sql`now()` : sql`NULL`},
              ${options.state === 'CANCELLED' ? sql`now()` : sql`NULL`},
              ${expires === null ? sql`NULL` : sql`now() + make_interval(secs => ${expires * 60})`})`);
    return id;
  }

  /** A live service, written directly, for the reason `service-reminders.test.ts` gives. */
  async function service(options: {
    readonly expiresInDays: number | null;
    /** An exact deadline, overriding `expiresInDays`. */
    readonly expiresAt?: Date;
    readonly usedBytes?: bigint;
    readonly limitBytes?: bigint;
    readonly state?: string;
  }): Promise<string> {
    const orderId = await order({ state: 'PAID' });
    const id = ctx.container.ids.uuid();
    const days = options.expiresInDays;
    await ctx.container.database.db.execute(sql`
      INSERT INTO services (id, tenant_id, customer_id, order_id, panel_id, product_id,
                            provider_username, subscription_ref, provider_client_id,
                            traffic_limit_bytes, traffic_used_bytes, usage_synced_at,
                            state, provisioned_at, terminated_at, expires_at)
      VALUES (${id}, ${tenantA.tenantId}, ${customerA}, ${orderId}, ${panelA}, ${productA},
              ${'u' + Math.random().toString(16).slice(2, 12)},
              ${Math.random().toString(16).slice(2).padEnd(32, '0').slice(0, 32)},
              ${ctx.container.ids.uuid()},
              ${options.limitBytes ?? ALLOWANCE}, ${options.usedBytes ?? 0n}, now(),
              ${options.state ?? 'ACTIVE'}, now(), NULL,
              ${
                options.expiresAt !== undefined
                  ? sql`${options.expiresAt}::timestamptz`
                  : days === null
                    ? sql`NULL`
                    : sql`now() + make_interval(secs => ${days * DAY})`
              })`);
    return id;
  }

  /** A manual transfer, written directly, in whichever state a case needs. */
  async function payment(options: {
    readonly state: string;
    readonly expiresInMinutes: number;
    readonly createdMinutesAgo?: number;
    readonly signalled?: boolean;
    readonly orderId?: string;
  }): Promise<string> {
    const id = ctx.container.ids.uuid();
    const orderId =
      options.orderId ?? (await order({ state: 'AWAITING_PAYMENT', expiresInMinutes: 60 }));
    const confirmed = options.state === 'CONFIRMED';
    const resolved = ['FAILED', 'CANCELLED', 'EXPIRED'].includes(options.state);
    await ctx.container.database.db.execute(sql`
      INSERT INTO payments (id, tenant_id, customer_id, order_id, state, method, amount, currency,
                            reference, evidence_kind, confirmed_at, resolved_at,
                            customer_signalled_at, expires_at, created_at)
      VALUES (${id}, ${tenantA.tenantId}, ${customerA}, ${orderId}, ${options.state},
              'MANUAL_TRANSFER', 250000, 'IRT', ${`NX-${key()}`},
              ${confirmed ? 'OPERATOR_REVIEW' : null}, ${confirmed ? sql`now()` : sql`NULL`},
              ${resolved ? sql`now()` : sql`NULL`},
              ${options.signalled === true ? sql`now()` : sql`NULL`},
              now() + make_interval(secs => ${options.expiresInMinutes * 60}),
              now() - make_interval(mins => ${options.createdMinutesAgo ?? 20}))`);
    return id;
  }

  /** One ledger movement. The ledger is the only authority on a balance. */
  async function ledger(customerId: UserId, direction: 'CREDIT' | 'DEBIT', amount: bigint) {
    await ctx.container.database.db.execute(sql`
      INSERT INTO wallet_entries (id, tenant_id, customer_id, direction, reason, amount,
                                  currency, reference)
      VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, ${customerId}, ${direction},
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
      confirmKey: flagKey,
      reason: 'test toggle of a reminder switch',
    });
  }

  /** Pins tenant A's wall clock to about `hour` now. See `service-reminders.test.ts`. */
  async function pinLocalHour(hour: number): Promise<void> {
    let offset = hour - ctx.container.clock.now().getUTCHours();
    while (offset > 14) offset -= 24;
    while (offset < -12) offset += 24;
    const zone =
      offset === 0 ? 'Etc/UTC' : `Etc/GMT${offset > 0 ? '-' : '+'}${String(Math.abs(offset))}`;
    await ctx.container.database.db.execute(
      sql`UPDATE tenants SET display_timezone = ${zone} WHERE id = ${tenantA.tenantId}`,
    );
  }

  const servicePass = () => ctx.container.serviceReminderSweep.runOnce(tenantA);
  const walletPass = () => ctx.container.walletLowBalanceSweep.runOnce(tenantA);
  const pendingPass = () => ctx.container.pendingPaymentReminderSweep.runOnce(tenantA);

  /**
   * The dispatcher, with the REAL subject reader, the real snapshot and facts readers, and
   * a messenger that records what it was asked to send. The readers are the point: every
   * supersession below is decided by the production query over the production tables.
   */
  function dispatcher(clock: Clock = ctx.container.clock): CustomerNotificationService {
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
      uow: ctx.container.uow,
      clock,
      scopeIsActive: async () => true,
      logger: { info: () => {}, error: () => {} },
    });
  }
  const deliver = (clock?: Clock) => dispatcher(clock).deliverDue(tenantA, 200);
  const at = (ms: number): Clock => ({ now: () => new Date(ms) });

  interface Row {
    readonly kind: string;
    readonly subjectId: string;
    readonly state: string;
    readonly attempts: number;
  }
  async function notifications(): Promise<readonly Row[]> {
    const result = await ctx.container.database.db.execute(sql`
      SELECT kind, subject_id, state, attempts FROM customer_notifications
       ORDER BY created_at ASC, kind ASC`);
    return (result.rows as unknown as Record<string, unknown>[]).map((row) => ({
      kind: row.kind as string,
      subjectId: row.subject_id as string,
      state: row.state as string,
      attempts: Number(row.attempts),
    }));
  }

  async function count(
    table: 'service_reminders' | 'customer_notifications' | 'wallet_threshold_alerts',
  ) {
    const result = await ctx.container.database.db.execute(
      sql`SELECT COUNT(*)::int AS n FROM ${sql.raw(table)}`,
    );
    return Number((result.rows[0] as { n: number }).n);
  }

  /** The notification kind each service was told about, by service id. */
  async function toldAbout(): Promise<ReadonlyMap<string, string>> {
    const result = await ctx.container.database.db.execute(sql`
      SELECT r.service_id, n.kind FROM customer_notifications n
      JOIN service_reminders r ON r.id = n.subject_id`);
    return new Map(
      (result.rows as unknown as { service_id: string; kind: string }[]).map((row) => [
        row.service_id,
        row.kind,
      ]),
    );
  }

  // =========================================================================
  // 1. The owner's defaults
  // =========================================================================

  it('warns at 7, 3 and 1 days, on the day itself in the tenant’s timezone, and after', async () => {
    // Local 02:00, so a deadline twelve hours out is this afternoon — the day of expiry —
    // and one twenty-three hours out is just after midnight TOMORROW: the one-day warning.
    await pinLocalHour(2);
    const week = await service({ expiresInDays: 6.5 });
    const three = await service({ expiresInDays: 2.5 });
    const one = await service({ expiresInDays: 23 / 24 });
    const today = await service({ expiresInDays: 0.5 });
    const gone = await service({ expiresInDays: -0.1, state: 'EXPIRED' });
    const far = await service({ expiresInDays: 7.5 });

    expect(await servicePass()).toEqual({ expiry: 5, usage: 0 });
    const told = await toldAbout();
    expect(told.get(week)).toBe('SERVICE_EXPIRY_EARLY');
    expect(told.get(three)).toBe('SERVICE_EXPIRY_FIRST');
    expect(told.get(one)).toBe('SERVICE_EXPIRY_SECOND');
    expect(told.get(today)).toBe('SERVICE_EXPIRY_DAY');
    expect(told.get(gone)).toBe('SERVICE_EXPIRED');
    expect(told.has(far), 'beyond seven days nothing is due').toBe(false);
  });

  it('decides "today" by the tenant’s own calendar day, not by twenty-four hours', async () => {
    // Local 20:00: twelve hours out is TOMORROW morning, so it is the one-day warning.
    await pinLocalHour(20);
    const tomorrow = await service({ expiresInDays: 0.5 });
    // And three hours out is still today.
    const tonight = await service({ expiresInDays: 3 / 24 });

    await servicePass();
    const told = await toldAbout();
    expect(told.get(tomorrow)).toBe('SERVICE_EXPIRY_SECOND');
    expect(told.get(tonight)).toBe('SERVICE_EXPIRY_DAY');
  });

  it('sends "today" after "tomorrow" once the local day of expiry begins', async () => {
    /*
     * The ordinary sequence, and the one a query that forgot the calendar rung would
     * break: the one-day warning is raised yesterday, so a candidate query whose ladder
     * stopped at EXPIRY_SECOND would find it raised and never return the service again —
     * and "your service expires today" would never be sent.
     */
    await pinLocalHour(20);
    const id = await service({ expiresInDays: 23 / 24 });
    expect(await servicePass()).toEqual({ expiry: 1, usage: 0 });
    expect((await toldAbout()).get(id)).toBe('SERVICE_EXPIRY_SECOND');

    // The tenant's clock reaches the deadline's own date (a zone where it is now ~00:30).
    await pinLocalHour(0);
    expect(await servicePass()).toEqual({ expiry: 1, usage: 0 });
    const result = await ctx.container.database.db.execute(sql`
      SELECT n.kind FROM customer_notifications n
      JOIN service_reminders r ON r.id = n.subject_id
      WHERE r.service_id = ${id} ORDER BY n.created_at`);
    expect((result.rows as { kind: string }[]).map((row) => row.kind)).toEqual([
      'SERVICE_EXPIRY_SECOND',
      'SERVICE_EXPIRY_DAY',
    ]);
    expect(await servicePass()).toEqual({ expiry: 0, usage: 0 });
  });

  it('warns at 20%, 10% and 5% remaining, and says so in the message', async () => {
    const below = await service({ expiresInDays: 30, usedBytes: (ALLOWANCE * 79n) / 100n });
    const twenty = await service({ expiresInDays: 30, usedBytes: (ALLOWANCE * 80n) / 100n });
    const ten = await service({ expiresInDays: 30, usedBytes: (ALLOWANCE * 90n) / 100n });
    const five = await service({ expiresInDays: 30, usedBytes: (ALLOWANCE * 95n) / 100n });

    expect(await servicePass()).toEqual({ expiry: 0, usage: 3 });
    const told = await toldAbout();
    expect(told.has(below)).toBe(false);
    expect(told.get(twenty)).toBe('SERVICE_USAGE_FIRST');
    expect(told.get(ten)).toBe('SERVICE_USAGE_SECOND');
    expect(told.get(five)).toBe('SERVICE_USAGE_FINAL');

    await deliver();
    const byTemplate = new Map(sends.map((one) => [one.templateKey, one.values]));
    expect(byTemplate.get('bot.service.usage_first')?.remainingPercent).toBe(20);
    expect(byTemplate.get('bot.service.usage_second')?.remainingPercent).toBe(10);
    expect(byTemplate.get('bot.service.usage_final')?.remainingPercent).toBe(5);
  });

  it('turns the week-out warning off with zero, and "today" off with its flag', async () => {
    expect(await setSetting('reminders.expiry_early_days', 0)).toBeNull();
    await setFlag('service_expiry_day_reminder', false);
    await pinLocalHour(2);
    const week = await service({ expiresInDays: 6.5 });
    const today = await service({ expiresInDays: 0.5 });

    expect(await servicePass()).toEqual({ expiry: 0, usage: 0 });
    expect(await count('customer_notifications')).toBe(0);
    // Recorded, not skipped: re-enabling does not back-fill a day that already began.
    const kinds = await ctx.container.database.db.execute(
      sql`SELECT kind FROM service_reminders WHERE service_id = ${today} ORDER BY kind`,
    );
    expect((kinds.rows as { kind: string }[]).map((row) => row.kind)).toContain('EXPIRY_DAY');
    expect(await count('service_reminders'), 'the week-out one is not even a candidate').toBe(4);
    void week;
  });

  // =========================================================================
  // 2. Once per instance; nothing per idle scan
  // =========================================================================

  it('writes no row on a scan that has nothing to send', async () => {
    await service({ expiresInDays: 20, usedBytes: (ALLOWANCE * 10n) / 100n });
    await payment({ state: 'PENDING', expiresInMinutes: 50 });
    await setFlag('wallet_low_balance_reminders', true);
    expect(
      await setSetting('wallet.low_balance.threshold', { amountMinor: '50000', currency: 'IRT' }),
    ).toBeNull();
    await ledger(customerA, 'CREDIT', 100_000n);

    for (let pass = 0; pass < 3; pass += 1) {
      await servicePass();
      await walletPass();
      await pendingPass();
    }
    expect(await count('service_reminders')).toBe(0);
    expect(await count('customer_notifications')).toBe(0);
    expect(await count('wallet_threshold_alerts')).toBe(0);
  });

  it('tells once across repeated passes, a restart and a refused-then-retried delivery', async () => {
    await service({ expiresInDays: 2 });
    await payment({ state: 'PENDING', expiresInMinutes: 8 });
    await setFlag('wallet_low_balance_reminders', true);
    expect(
      await setSetting('wallet.low_balance.threshold', { amountMinor: '50000', currency: 'IRT' }),
    ).toBeNull();
    await ledger(customerA, 'CREDIT', 100_000n);
    await ledger(customerA, 'DEBIT', 70_000n);

    await servicePass();
    await walletPass();
    await pendingPass();
    const reminders = await count('service_reminders');
    expect((await notifications()).map((row) => row.kind).sort()).toEqual([
      'PAYMENT_PENDING_REMINDER',
      'SERVICE_EXPIRY_FIRST',
      'WALLET_LOW_BALANCE',
    ]);

    // Telegram refuses all three: they stay PENDING with an attempt spent — durable retry.
    outcomes = [{ outcome: 'REFUSED' }, { outcome: 'REFUSED' }, { outcome: 'REFUSED' }];
    expect((await deliver()).pending).toBe(3);

    // The sweeps run again, as they do after a worker restart: nothing new is raised.
    await servicePass();
    await walletPass();
    await pendingPass();
    expect(await count('service_reminders')).toBe(reminders);
    expect(await count('wallet_threshold_alerts')).toBe(1);
    expect(await notifications()).toHaveLength(3);

    // The retry is the SAME row, delivered once: one refusal and one delivery, two attempts.
    await ctx.container.database.db.execute(
      sql`UPDATE customer_notifications SET next_attempt_at = now() - interval '1 second'`,
    );
    expect((await deliver()).delivered).toBe(3);
    const rows = await notifications();
    expect(rows.map((row) => [row.state, row.attempts])).toEqual([
      ['DELIVERED', 2],
      ['DELIVERED', 2],
      ['DELIVERED', 2],
    ]);
    expect(sends).toHaveLength(6);
    expect(await deliver()).toMatchObject({ claimed: 0 });
  });

  // =========================================================================
  // 3. Eligibility follows authoritative state
  // =========================================================================

  it('sends no "expires tomorrow" after a renewal, and the next period re-arms', async () => {
    await pinLocalHour(20);
    const id = await service({ expiresInDays: 0.5 });
    await servicePass();
    expect((await notifications()).map((row) => row.kind)).toEqual(['SERVICE_EXPIRY_SECOND']);

    // Renewed before the message left the queue.
    await ctx.container.database.db.execute(
      sql`UPDATE services SET expires_at = expires_at + interval '30 days' WHERE id = ${id}`,
    );
    const report = await deliver();
    expect(report.superseded).toBe(1);
    expect(sends).toHaveLength(0);
    expect((await notifications())[0]?.state).toBe('SUPERSEDED');

    // Thirty days out: nothing is due, and nothing is written.
    expect(await servicePass()).toEqual({ expiry: 0, usage: 0 });
  });

  it('supersedes a usage warning when traffic is added, and re-arms at the new allowance', async () => {
    const id = await service({ expiresInDays: 30, usedBytes: (ALLOWANCE * 95n) / 100n });
    await servicePass();
    expect((await notifications()).map((row) => row.kind)).toEqual(['SERVICE_USAGE_FINAL']);

    // ADD_TRAFFIC doubles the allowance before the send.
    await ctx.container.database.db.execute(
      sql`UPDATE services SET traffic_limit_bytes = ${ALLOWANCE * 2n} WHERE id = ${id}`,
    );
    expect((await deliver()).superseded).toBe(1);
    expect(sends).toHaveLength(0);

    // 47.5% of the new allowance: nothing. 85%: the first warning of the NEW basis.
    expect(await servicePass()).toEqual({ expiry: 0, usage: 0 });
    await ctx.container.database.db.execute(sql`
      UPDATE services SET traffic_used_bytes = ${(ALLOWANCE * 2n * 85n) / 100n},
                          usage_synced_at = now() WHERE id = ${id}`);
    expect(await servicePass()).toEqual({ expiry: 0, usage: 1 });
    expect((await deliver()).delivered).toBe(1);
    expect(sends.map((one) => one.templateKey)).toEqual(['bot.service.usage_first']);
  });

  it('supersedes an expiry warning for a service terminated before the send', async () => {
    const id = await service({ expiresInDays: 2 });
    await servicePass();
    await ctx.container.database.db.execute(
      sql`UPDATE services SET state = 'TERMINATED', terminated_at = now() WHERE id = ${id}`,
    );
    expect((await deliver()).superseded).toBe(1);
    expect(sends).toHaveLength(0);
  });

  // =========================================================================
  // 4. Wallet low balance
  // =========================================================================

  it('is off by default, and a zero threshold sends nothing either', async () => {
    await ledger(customerA, 'CREDIT', 100_000n);
    await ledger(customerA, 'DEBIT', 90_000n);
    expect(
      await setSetting('wallet.low_balance.threshold', { amountMinor: '50000', currency: 'IRT' }),
    ).toBeNull();

    expect(await walletPass()).toEqual({ alerts: 0 });
    expect(await count('wallet_threshold_alerts')).toBe(0);

    await setFlag('wallet_low_balance_reminders', true);
    expect(
      await setSetting('wallet.low_balance.threshold', { amountMinor: '0', currency: 'IRT' }),
    ).toBeNull();
    expect(await walletPass()).toEqual({ alerts: 0 });
    expect(await count('wallet_threshold_alerts')).toBe(0);
  });

  it('tells once per fall, and again only after the balance recovered', async () => {
    await setFlag('wallet_low_balance_reminders', true);
    expect(
      await setSetting('wallet.low_balance.threshold', { amountMinor: '50000', currency: 'IRT' }),
    ).toBeNull();

    await ledger(customerA, 'CREDIT', 100_000n);
    await ledger(customerA, 'DEBIT', 60_000n); // 40,000: below
    expect(await walletPass()).toEqual({ alerts: 1 });
    /*
     * Forward progress, asserted against the QUERY: a told wallet is not a candidate any
     * more, so it cannot occupy a slot in a bounded pass while the unique key quietly
     * refuses its insert — the failure `service-reminders.test.ts` names for its lane.
     */
    const stillOwed = await ctx.container.uow.run(tenantA, (tx) =>
      new DrizzleWalletThresholdAlertRepository(ctx.container.database.db).listCrossings(
        tenantA,
        { currency: 'IRT', threshold: 50_000n },
        200,
        tx,
      ),
    );
    expect(stillOwed).toEqual([]);
    expect(await walletPass()).toEqual({ alerts: 0 });

    await ledger(customerA, 'DEBIT', 10_000n); // 30,000: still the same fall
    await ledger(customerA, 'CREDIT', 15_000n); // 45,000: still below, not recovered
    expect(await walletPass()).toEqual({ alerts: 0 });

    await ledger(customerA, 'CREDIT', 5_000n); // 50,000: AT the threshold — recovered
    expect(await walletPass()).toEqual({ alerts: 0 });
    await ledger(customerA, 'DEBIT', 20_000n); // 30,000: a second fall
    expect(await walletPass()).toEqual({ alerts: 1 });
    expect(await walletPass()).toEqual({ alerts: 0 });

    const rows = await notifications();
    expect(rows.map((row) => row.kind)).toEqual(['WALLET_LOW_BALANCE', 'WALLET_LOW_BALANCE']);
    expect(rows[0]?.subjectId).not.toBe(rows[1]?.subjectId);
    expect(await count('wallet_threshold_alerts')).toBe(2);

    await deliver();
    expect(sends.at(-1)?.values).toMatchObject({
      balance: { amountMinor: 30_000n, currency: 'IRT' },
      threshold: { amountMinor: 50_000n, currency: 'IRT' },
    });
  });

  it('never tells a wallet that never held the threshold', async () => {
    await setFlag('wallet_low_balance_reminders', true);
    expect(
      await setSetting('wallet.low_balance.threshold', { amountMinor: '50000', currency: 'IRT' }),
    ).toBeNull();
    await ledger(customerA, 'CREDIT', 10_000n);
    // And one with no entries at all.
    await customer('931002');

    expect(await walletPass()).toEqual({ alerts: 0 });
    expect(await count('wallet_threshold_alerts')).toBe(0);
  });

  it('supersedes the alert when the wallet is topped up before the send', async () => {
    await setFlag('wallet_low_balance_reminders', true);
    expect(
      await setSetting('wallet.low_balance.threshold', { amountMinor: '50000', currency: 'IRT' }),
    ).toBeNull();
    await ledger(customerA, 'CREDIT', 100_000n);
    await ledger(customerA, 'DEBIT', 80_000n);
    await walletPass();
    await ledger(customerA, 'CREDIT', 40_000n); // 60,000

    expect((await deliver()).superseded).toBe(1);
    expect(sends).toHaveLength(0);
  });

  it('compares only in the currency the tenant sells in', async () => {
    await setFlag('wallet_low_balance_reminders', true);
    expect(
      await setSetting('wallet.low_balance.threshold', { amountMinor: '50000', currency: 'USD' }),
    ).toBeNull();
    await ledger(customerA, 'CREDIT', 100_000n);
    await ledger(customerA, 'DEBIT', 80_000n);

    expect(await walletPass()).toEqual({ alerts: 0 });
  });

  // =========================================================================
  // 5. Pending payments and orders
  // =========================================================================

  it('reminds about a pending transfer once, and never about one that cannot be paid', async () => {
    const due = await payment({ state: 'PENDING', expiresInMinutes: 8 });
    await payment({ state: 'CONFIRMED', expiresInMinutes: 8 });
    await payment({ state: 'CANCELLED', expiresInMinutes: 8 });
    await payment({ state: 'EXPIRED', expiresInMinutes: 8 });
    await payment({ state: 'PENDING', expiresInMinutes: -1 }); // lapsed, not yet swept
    await payment({ state: 'PENDING', expiresInMinutes: 8, signalled: true }); // "I paid"
    await payment({ state: 'PENDING', expiresInMinutes: 30 }); // outside the lead
    await payment({ state: 'PENDING', expiresInMinutes: 8, createdMinutesAgo: 2 }); // too young
    const receipted = await payment({ state: 'PENDING', expiresInMinutes: 8 });
    await ctx.container.database.db.execute(sql`
      INSERT INTO payment_receipts (id, tenant_id, bot_instance_id, customer_id, payment_id,
                                    kind, file_id, file_unique_id, telegram_message_id)
      VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, ${BOT_A}, ${customerA},
              ${receipted}, 'PHOTO', 'file-1', 'unique-1', 1)`);

    expect(await pendingPass()).toEqual({ payments: 1, orders: 0 });
    expect((await notifications()).map((row) => [row.kind, row.subjectId])).toEqual([
      ['PAYMENT_PENDING_REMINDER', due],
    ]);
    expect(await pendingPass()).toEqual({ payments: 0, orders: 0 });
    expect(await notifications()).toHaveLength(1);

    await deliver();
    expect(sends[0]?.templateKey).toBe('bot.payment.pending_reminder');
    expect(sends[0]?.values.minutes).toBeGreaterThanOrEqual(7);
    expect(sends[0]?.values.minutes).toBeLessThanOrEqual(8);
  });

  it('supersedes the reminder when the payment settles, is cancelled or lapses first', async () => {
    const settled = await payment({ state: 'PENDING', expiresInMinutes: 8 });
    const cancelled = await payment({ state: 'PENDING', expiresInMinutes: 8 });
    const lapsed = await payment({ state: 'PENDING', expiresInMinutes: 8 });
    expect(await pendingPass()).toEqual({ payments: 3, orders: 0 });

    await ctx.container.database.db.execute(sql`
      UPDATE payments SET state = 'CONFIRMED', confirmed_at = now(),
                          evidence_kind = 'OPERATOR_REVIEW' WHERE id = ${settled}`);
    await ctx.container.database.db.execute(
      sql`UPDATE payments SET state = 'CANCELLED', resolved_at = now() WHERE id = ${cancelled}`,
    );
    await ctx.container.database.db.execute(
      sql`UPDATE payments SET expires_at = now() - interval '1 minute' WHERE id = ${lapsed}`,
    );

    expect((await deliver()).superseded).toBe(3);
    expect(sends).toHaveLength(0);
  });

  it('reminds about an unpaid order only while no payment for it is under way', async () => {
    const bare = await order({ state: 'AWAITING_PAYMENT', expiresInMinutes: 8 });
    const paying = await order({ state: 'AWAITING_PAYMENT', expiresInMinutes: 8 });
    await payment({ state: 'PENDING', expiresInMinutes: 40, orderId: paying });
    await order({ state: 'PAID', expiresInMinutes: 8 });
    await order({ state: 'AWAITING_PAYMENT', expiresInMinutes: 25 });

    expect(await pendingPass()).toEqual({ payments: 0, orders: 1 });
    expect((await notifications()).map((row) => [row.kind, row.subjectId])).toEqual([
      ['ORDER_PENDING_REMINDER', bare],
    ]);
    await deliver();
    expect(sends[0]?.templateKey).toBe('bot.order.pending_reminder');
    expect(sends[0]?.values.total).toEqual({ amountMinor: 250_000n, currency: 'IRT' });
  });

  it('is switched off by its flag', async () => {
    await payment({ state: 'PENDING', expiresInMinutes: 8 });
    await setFlag('payment_pending_reminders', false);
    expect(await pendingPass()).toEqual({ payments: 0, orders: 0 });
    expect(await count('customer_notifications')).toBe(0);
  });

  // =========================================================================
  // 6. Backward compatibility
  // =========================================================================

  it('keeps a tenant’s stored thresholds meaning what they meant', async () => {
    /*
     * A tenant that configured ten and five days and the OLD usage defaults (80/95/100
     * used) before WP-A9. Every one of those writes is still accepted, and the sweep
     * obeys them rather than the new defaults.
     */
    expect(await setSetting('reminders.expiry_first_days', 10)).toBeNull();
    expect(await setSetting('reminders.expiry_second_days', 5)).toBeNull();
    expect(await setSetting('reminders.usage_final_percent', 100)).toBeNull();
    expect(await setSetting('reminders.usage_second_percent', 95)).toBeNull();

    const eight = await service({ expiresInDays: 8 });
    const ninetySix = await service({ expiresInDays: 30, usedBytes: (ALLOWANCE * 96n) / 100n });
    await servicePass();
    const told = await toldAbout();
    // Eight days is inside the stored first warning; the default week-out slot is inert.
    expect(told.get(eight)).toBe('SERVICE_EXPIRY_FIRST');
    // 96% used is past the stored 95 and short of the stored 100.
    expect(told.get(ninetySix)).toBe('SERVICE_USAGE_SECOND');

    // The older keys stay editable although the new slot sits inside the first warning…
    expect(await setSetting('reminders.usage_first_percent', 70)).toBeNull();
    expect(await setSetting('reminders.expiry_second_days', 4)).toBeNull();
    // …and the new slot, when IT is written, must be further out, or zero.
    expect(await setSetting('reminders.expiry_early_days', 9)).toMatch(/یادآور هفتگی/);
    expect(await setSetting('reminders.expiry_early_days', 14)).toBeNull();
    expect(await setSetting('reminders.expiry_early_days', 0)).toBeNull();
  });
  // =========================================================================
  // 7. Codex review #1 of PR #100: a valid configuration always delivers
  // =========================================================================

  /**
   * The service sweep with a clock of the test's choosing, so a case can walk the real
   * fifteen-minute cadence across a local midnight. Everything else is production code —
   * the repository, the notifier, the tenant's own row — and the settings and flags are
   * the registry's defaults.
   */
  function sweepAt(ms: number) {
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
    }).runOnce(tenantA);
  }

  /** Five minutes after the Tehran midnight two days from now. */
  async function justAfterTehranMidnight(): Promise<Date> {
    await ctx.container.database.db.execute(
      sql`UPDATE tenants SET display_timezone = 'Asia/Tehran' WHERE id = ${tenantA.tenantId}`,
    );
    const result = await ctx.container.database.db.execute(sql`
      SELECT (((date_trunc('day', now() AT TIME ZONE 'Asia/Tehran') + interval '2 days')
                 AT TIME ZONE 'Asia/Tehran') + interval '5 minutes')::text AS at`);
    return new Date((result.rows[0] as { at: string }).at);
  }

  async function kindsToldAbout(serviceId: string): Promise<readonly string[]> {
    const result = await ctx.container.database.db.execute(sql`
      SELECT n.kind FROM customer_notifications n
      JOIN service_reminders r ON r.id = n.subject_id
      WHERE r.service_id = ${serviceId} ORDER BY r.raised_at, n.kind`);
    return (result.rows as { kind: string }[]).map((row) => row.kind);
  }

  it('sends the day-of reminder for a deadline 5 minutes after Tehran midnight, at any sweep phase', async () => {
    const expiresAt = await justAfterTehranMidnight();
    const QUARTER = 15 * 60_000;
    // 9m50s is the phase that used to lose it: sweeps at 23:59:50 and 00:14:50.
    for (const phase of [0, 10_000, 5 * 60_000, 9 * 60_000 + 50_000, 14 * 60_000 + 50_000]) {
      const id = await service({ expiresInDays: null, expiresAt });
      let dayAt: number | null = null;
      for (
        let t = expiresAt.getTime() - 3_600_000 + phase;
        t <= expiresAt.getTime() + QUARTER;
        t += QUARTER
      ) {
        const before = await kindsToldAbout(id);
        await sweepAt(t);
        const after = await kindsToldAbout(id);
        if (!before.includes('SERVICE_EXPIRY_DAY') && after.includes('SERVICE_EXPIRY_DAY'))
          dayAt = t;
      }
      expect(await kindsToldAbout(id), `phase ${String(phase)}`).toEqual([
        'SERVICE_EXPIRY_SECOND',
        'SERVICE_EXPIRY_DAY',
        'SERVICE_EXPIRED',
      ]);
      // Raised early enough that the delivery lane's next poll sends it rather than
      // superseding it: delivered a minute later, before the deadline.
      expect(dayAt).not.toBeNull();
      sends = [];
      await deliver(at(dayAt! + 60_000));
      expect(sends.map((one) => one.templateKey)).toContain('bot.service.expiry_day');
      // Out of the way of the next phase: a terminated service is nobody's reminder.
      await ctx.container.database.db.execute(
        sql`UPDATE services SET state = 'TERMINATED', terminated_at = now() WHERE id = ${id}`,
      );
    }
  });

  it('never says "expires soon" after the deadline: a worker down for the whole rung sends the expired notice', async () => {
    const expiresAt = await justAfterTehranMidnight();
    const id = await service({ expiresInDays: null, expiresAt });
    await sweepAt(expiresAt.getTime() - 3_600_000);
    // The worker is down from then until a minute after the deadline.
    await sweepAt(expiresAt.getTime() + 60_000);
    expect(await kindsToldAbout(id)).toEqual(['SERVICE_EXPIRY_SECOND', 'SERVICE_EXPIRED']);
    // Deliberately recorded as passed, so it can never be sent late.
    const rows = await ctx.container.database.db.execute(
      sql`SELECT kind FROM service_reminders WHERE service_id = ${id} AND kind = 'EXPIRY_DAY'`,
    );
    expect(rows.rows).toHaveLength(1);
  });

  it('never enqueues a pending reminder too close to its deadline to be delivered', async () => {
    await payment({ state: 'PENDING', expiresInMinutes: 2 });
    await order({ state: 'AWAITING_PAYMENT', expiresInMinutes: 2 });
    expect(await pendingPass()).toEqual({ payments: 0, orders: 0 });
    expect(await count('customer_notifications')).toBe(0);
  });

  it('delivers at the smallest lead an operator can choose', async () => {
    expect(await setSetting('reminders.payment_pending_minutes', 5)).toBeNull();
    expect(await setSetting('reminders.payment_pending_minutes', 4)).not.toBeNull();
    // The latest moment a reminder may be enqueued: three minutes left.
    await payment({ state: 'PENDING', expiresInMinutes: 3.1 });
    expect(await pendingPass()).toEqual({ payments: 1, orders: 0 });

    // The delivery lane's next poll, a minute later, still finds it payable and sends it.
    const report = await deliver(at(ctx.container.clock.now().getTime() + 60_000));
    expect(report).toMatchObject({ delivered: 1, superseded: 0 });
  });

  it('treats a lead stored below the raised floor as the default, and says so', async () => {
    await ctx.container.database.db.execute(sql`
      INSERT INTO setting_values (id, tenant_id, setting_key, value)
      VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId},
              'reminders.payment_pending_minutes', '1'::jsonb)`);
    const read = await ctx.container.settingsService.get(
      tenantA,
      owner,
      'reminders.payment_pending_minutes',
    );
    expect(read).toMatchObject({ value: 10, source: 'DEFAULT', storedValueInvalid: true });

    // Ten minutes is in force, so an attempt eight minutes out is reminded.
    await payment({ state: 'PENDING', expiresInMinutes: 8 });
    expect(await pendingPass()).toEqual({ payments: 1, orders: 0 });
  });
  it('refuses an alert that names another tenant’s ledger entry', async () => {
    /*
     * Codex review #2 of PR #100: the crossing entry's key is `(tenant_id, id)`, as every
     * other reference into the ledger is, so a tenant A alert cannot point at a tenant B
     * entry — the database refuses it, whatever a writer believes.
     */
    const { customer: foreign } = await ctx.container.customers.resolveFromUpdate(
      tenantB,
      systemActor('resolve-foreign'),
      {
        idempotencyKey: 'resolve-foreign',
        telegramUserId: '931099',
        from: { id: 931099, first_name: 'زهرا' },
        botInstanceId: SEED_IDS.botB1 as BotInstanceId,
      },
    );
    const entry = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO wallet_entries (id, tenant_id, customer_id, direction, reason, amount,
                                  currency, reference)
      VALUES (${entry}, ${tenantB.tenantId}, ${foreign.id}, 'CREDIT', 'ADMIN_CREDIT', 1000,
              'IRT', ${`ref-${key()}`})`);

    const refused = await ctx.container.database.db
      .execute(
        sql`
        INSERT INTO wallet_threshold_alerts (id, tenant_id, customer_id, currency,
                                             threshold_amount, crossing_entry_id, crossed_at)
        VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, ${customerA}, 'IRT', 50000,
                ${entry}, now())`,
      )
      .then(
        () => null,
        (error: { cause?: { constraint?: string } }) => error.cause?.constraint ?? 'no constraint',
      );
    expect(refused).toBe('wallet_threshold_alerts_crossing_entry_fk');
  });
});
