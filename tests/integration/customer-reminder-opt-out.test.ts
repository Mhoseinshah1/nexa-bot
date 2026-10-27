import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  isNexaError,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type FeatureFlagKey,
  type UserId,
} from '@nexa/contracts';
import { REMINDER_OPT_OUT_DISABLED_REASON } from '../../apps/api/src/modules/commerce/customers/application/customer.service';
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
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  SEED_IDS,
  tenantA,
  type TestContext,
} from './harness';

/**
 * Round 11, B6 — a per-customer switch for the service expiry and volume reminders.
 *
 * What this file proves:
 *
 *   1. THE SWEEP. An opted-out customer is skipped by the reminder sweep (expiry AND volume)
 *      while every other customer is still reminded; a stored opt-out is honoured only while
 *      `customer_reminder_opt_out` is on; thresholds that passed in silence are not replayed
 *      on opt-in; and a reminder already QUEUED when the customer opts out is superseded at
 *      send time, not sent.
 *   2. NOTHING ELSE CHANGES. The wallet low-balance alert and the pending-payment reminder
 *      still reach an opted-out customer, and the customer's other rows are untouched.
 *   3. THE CUSTOMER'S OWN WRITE. Idempotent, audited, one outbox event per real change,
 *      refused (nothing stored) while the switch is off.
 *   4. THE OPERATOR'S WRITE. `users.notifications.edit`, a reason, audit with before and
 *      after, a denied role refused and audited, settable while the switch is off.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const GIGABYTE = 1_073_741_824n;
const ALLOWANCE = 50n * GIGABYTE;
const DAY = 86_400;
const FLAG: FeatureFlagKey = 'customer_reminder_opt_out';

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

describe('the customer reminder opt-out (R11 B6)', () => {
  let ctx: TestContext;
  let owner: ActorContext;
  let panelA: string;
  let productA: string;
  let alice: UserId; // opts out
  let bob: UserId; // never does
  let n = 0;
  const key = (): string => `r11b6-${(n += 1)}`;

  let sends: CustomerMessage[] = [];
  const outcomes: CustomerSendResult[] = [];

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    sends = [];
    outcomes.length = 0;
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-r11b6', roleKeys: ['owner'] }),
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
    alice = await customer('961001');
    bob = await customer('961002');
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

  async function setFlag(enabled: boolean, flagKey: FeatureFlagKey = FLAG): Promise<void> {
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
      reason: 'R11 B6 test toggle',
    });
  }

  /** The customer's OWN switch (the path the bot and the mini app both take). */
  const optOut = (customerId: UserId, optedOut: boolean, idempotencyKey = key()) =>
    ctx.container.customers.setRemindersOptOut(tenantA, systemActor(idempotencyKey), {
      idempotencyKey,
      customerId,
      optedOut,
    });

  const storedOptOut = async (customerId: UserId): Promise<Date | null> => {
    const result = await ctx.container.database.db.execute(
      sql`SELECT reminders_opt_out_at AS at FROM customers WHERE id = ${customerId}`,
    );
    return (result.rows[0] as { at: Date | null } | undefined)?.at ?? null;
  };

  async function order(customerId: UserId, state: string, expiresInMinutes?: number) {
    const id = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO orders (id, tenant_id, customer_id, state, product_id, panel_id, purpose,
                          line_title, line_duration_days, line_traffic_bytes,
                          line_device_limit, line_unit_price_amount, line_quantity,
                          subtotal_amount, discount_amount, total_amount, currency, quote,
                          confirmed_at, settled_at, expires_at)
      VALUES (${id}, ${tenantA.tenantId}, ${customerId}, ${state},
              ${productA}, ${panelA}, 'NEW_SERVICE', 'پلن', 30, ${ALLOWANCE}, 2, 250000, 1,
              250000, 0, 250000, 'IRT', '{"trace":[]}'::jsonb,
              now() - make_interval(mins => 30),
              ${state === 'PAID' ? sql`now()` : sql`NULL`},
              ${
                expiresInMinutes === undefined
                  ? sql`NULL`
                  : sql`now() + make_interval(secs => ${expiresInMinutes * 60})`
              })`);
    return id;
  }

  async function service(
    customerId: UserId,
    options: { readonly expiresInDays: number; readonly usedBytes?: bigint },
  ): Promise<string> {
    const orderId = await order(customerId, 'PAID');
    const id = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO services (id, tenant_id, customer_id, order_id, panel_id, product_id,
                            provider_username, subscription_ref, provider_client_id,
                            traffic_limit_bytes, traffic_used_bytes, usage_synced_at,
                            state, provisioned_at, terminated_at, expires_at)
      VALUES (${id}, ${tenantA.tenantId}, ${customerId}, ${orderId}, ${panelA}, ${productA},
              ${'u' + Math.random().toString(16).slice(2, 12)},
              ${Math.random().toString(16).slice(2).padEnd(32, '0').slice(0, 32)},
              ${ctx.container.ids.uuid()},
              ${ALLOWANCE}, ${options.usedBytes ?? 0n}, now(),
              'ACTIVE', now(), NULL, now() + make_interval(secs => ${options.expiresInDays * DAY}))`);
    return id;
  }

  async function pendingPayment(customerId: UserId): Promise<string> {
    const orderId = await order(customerId, 'AWAITING_PAYMENT', 60);
    const id = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO payments (id, tenant_id, customer_id, order_id, state, method, amount, currency,
                            reference, expires_at, created_at)
      VALUES (${id}, ${tenantA.tenantId}, ${customerId}, ${orderId}, 'PENDING',
              'MANUAL_TRANSFER', 250000, 'IRT', ${`NX-${key()}`},
              now() + make_interval(secs => ${8 * 60}), now() - make_interval(mins => 20))`);
    return id;
  }

  async function ledger(customerId: UserId, direction: 'CREDIT' | 'DEBIT', amount: bigint) {
    await ctx.container.database.db.execute(sql`
      INSERT INTO wallet_entries (id, tenant_id, customer_id, direction, reason, amount,
                                  currency, reference)
      VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, ${customerId}, ${direction},
              ${direction === 'CREDIT' ? 'ADMIN_CREDIT' : 'ADMIN_DEBIT'}, ${amount}, 'IRT',
              ${`ref-${key()}`})`);
  }

  const servicePass = () => ctx.container.serviceReminderSweep.runOnce(tenantA);

  /** The dispatcher with the REAL subject reader, and a messenger that records what it sends. */
  function dispatcher(): CustomerNotificationService {
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
      clock: ctx.container.clock,
      scopeIsActive: async () => true,
      logger: { info: () => {}, error: () => {} },
    });
  }
  const deliver = () => dispatcher().deliverDue(tenantA, 200);

  interface Told {
    readonly serviceId: string;
    readonly customerId: string;
    readonly kind: string;
    readonly state: string;
  }
  /** Every service reminder notification, with the service it names and its state. */
  async function toldAbout(): Promise<readonly Told[]> {
    const result = await ctx.container.database.db.execute(sql`
      SELECT r.service_id, n.customer_id, n.kind, n.state
        FROM customer_notifications n
        JOIN service_reminders r ON r.id = n.subject_id
       ORDER BY n.created_at ASC, n.kind ASC`);
    return (
      result.rows as unknown as {
        service_id: string;
        customer_id: string;
        kind: string;
        state: string;
      }[]
    ).map((row) => ({
      serviceId: row.service_id,
      customerId: row.customer_id,
      kind: row.kind,
      state: row.state,
    }));
  }

  const reminderRows = async (serviceId: string): Promise<number> =>
    Number(
      (
        (
          await ctx.container.database.db.execute(
            sql`SELECT count(*)::int AS n FROM service_reminders WHERE service_id = ${serviceId}`,
          )
        ).rows[0] as { n: number }
      ).n,
    );

  const kindsFor = async (customerId: UserId): Promise<string[]> =>
    (
      await ctx.container.database.db.execute(
        sql`SELECT kind FROM customer_notifications WHERE customer_id = ${customerId} ORDER BY kind`,
      )
    ).rows.map((row) => (row as { kind: string }).kind);

  // =========================================================================
  // 1. The sweep
  // =========================================================================

  it('is off by default and OFF is the behaviour before the feature: a stored opt-out changes nothing', async () => {
    expect((await ctx.container.featureFlagResolver.resolve(tenantA, FLAG)).enabled).toBe(false);
    // The operator may store the choice while the switch is off.
    await ctx.container.customerControls.setReminderPreference(tenantA, owner, {
      idempotencyKey: key(),
      customerId: alice,
      optedOut: true,
      reason: 'asked on the phone',
    });
    expect(await storedOptOut(alice)).not.toBeNull();

    const expiring = await service(alice, { expiresInDays: 2.5 });
    const heavy = await service(alice, { expiresInDays: 30, usedBytes: (ALLOWANCE * 90n) / 100n });
    expect(await servicePass()).toEqual({ expiry: 1, usage: 1 });
    const told = await toldAbout();
    expect(told.map((row) => row.serviceId).sort()).toEqual([expiring, heavy].sort());
  });

  it('skips an opted-out customer for expiry and volume reminders and still tells everybody else', async () => {
    await setFlag(true);
    await optOut(alice, true);

    const aliceExpiring = await service(alice, { expiresInDays: 2.5 });
    const aliceHeavy = await service(alice, {
      expiresInDays: 30,
      usedBytes: (ALLOWANCE * 90n) / 100n,
    });
    const bobExpiring = await service(bob, { expiresInDays: 2.5 });
    const bobHeavy = await service(bob, {
      expiresInDays: 30,
      usedBytes: (ALLOWANCE * 90n) / 100n,
    });

    // Two services told (bob's), two recorded in silence (alice's).
    expect(await servicePass()).toEqual({ expiry: 1, usage: 1 });
    const told = await toldAbout();
    expect(told.map((row) => row.serviceId).sort()).toEqual([bobExpiring, bobHeavy].sort());
    expect(told.every((row) => row.customerId === bob)).toBe(true);
    expect(told.map((row) => row.kind).sort()).toEqual(
      ['SERVICE_EXPIRY_FIRST', 'SERVICE_USAGE_SECOND'].sort(),
    );

    // Alice's services are recorded as raised, so they are not candidates for ever (forward
    // progress) — and nothing was sent to her.
    expect(await reminderRows(aliceExpiring)).toBeGreaterThan(0);
    expect(await reminderRows(aliceHeavy)).toBeGreaterThan(0);
    expect(await kindsFor(alice)).toEqual([]);

    // A second pass is quiet for both.
    expect(await servicePass()).toEqual({ expiry: 0, usage: 0 });

    await deliver();
    expect(sends.map((one) => one.templateKey).sort()).toEqual([
      'bot.service.expiry_first',
      'bot.service.usage_second',
    ]);
  });

  it('skips the «expired» notice too: it is one of the sweep’s reminder slots', async () => {
    await setFlag(true);
    await optOut(alice, true);
    // A deadline that has just passed: the sweep raises the EXPIRED notice for the service.
    const orderId = await order(alice, 'PAID');
    const id = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO services (id, tenant_id, customer_id, order_id, panel_id, product_id,
                            provider_username, subscription_ref, provider_client_id,
                            traffic_limit_bytes, traffic_used_bytes, usage_synced_at,
                            state, provisioned_at, terminated_at, expires_at)
      VALUES (${id}, ${tenantA.tenantId}, ${alice}, ${orderId}, ${panelA}, ${productA},
              'uexpired1', ${'e'.repeat(32)}, ${ctx.container.ids.uuid()},
              ${ALLOWANCE}, 0, now(), 'EXPIRED', now(), NULL, now() - make_interval(hours => 2))`);
    const bobId = ctx.container.ids.uuid();
    const bobOrder = await order(bob, 'PAID');
    await ctx.container.database.db.execute(sql`
      INSERT INTO services (id, tenant_id, customer_id, order_id, panel_id, product_id,
                            provider_username, subscription_ref, provider_client_id,
                            traffic_limit_bytes, traffic_used_bytes, usage_synced_at,
                            state, provisioned_at, terminated_at, expires_at)
      VALUES (${bobId}, ${tenantA.tenantId}, ${bob}, ${bobOrder}, ${panelA}, ${productA},
              'uexpired2', ${'f'.repeat(32)}, ${ctx.container.ids.uuid()},
              ${ALLOWANCE}, 0, now(), 'EXPIRED', now(), NULL, now() - make_interval(hours => 2))`);
    await servicePass();
    const told = await toldAbout();
    expect(told.map((row) => [row.customerId, row.kind])).toEqual([[bob, 'SERVICE_EXPIRED']]);
  });

  it('does not replay thresholds that passed in silence when the customer opts back in', async () => {
    await setFlag(true);
    await optOut(alice, true);
    const expiring = await service(alice, { expiresInDays: 2.5 });
    await servicePass();
    expect(await toldAbout()).toEqual([]);

    await optOut(alice, false);
    // The threshold that passed while they had asked for silence is history, not news.
    expect(await servicePass()).toEqual({ expiry: 0, usage: 0 });
    expect(await toldAbout()).toEqual([]);
    expect(await reminderRows(expiring)).toBeGreaterThan(0);

    // A threshold crossed AFTER they opted back in is told as for anyone: the one-day rung.
    await ctx.container.database.db.execute(sql`
      UPDATE services SET expires_at = now() + make_interval(hours => 20) WHERE id = ${expiring}`);
    // The deadline moved: a new period, so the ladder re-arms and the customer hears again.
    expect(await servicePass()).toEqual({ expiry: 1, usage: 0 });
    expect((await toldAbout()).map((row) => row.kind)).toEqual(['SERVICE_EXPIRY_SECOND']);
  });

  it('supersedes a reminder queued BEFORE the opt-out instead of sending it; the same reminder is sent to an unchanged customer', async () => {
    await setFlag(true);
    const aliceService = await service(alice, { expiresInDays: 2.5 });
    const bobService = await service(bob, { expiresInDays: 2.5 });
    expect(await servicePass()).toEqual({ expiry: 2, usage: 0 });

    // Alice opts out after the reminder was raised and before it is delivered.
    await optOut(alice, true);
    await deliver();

    const told = await toldAbout();
    expect(told.find((row) => row.serviceId === aliceService)?.state).toBe('SUPERSEDED');
    expect(told.find((row) => row.serviceId === bobService)?.state).toBe('DELIVERED');
    expect(sends).toHaveLength(1);
  });

  it('sends a queued reminder anyway once the switch is turned off: a stored opt-out is honoured only while the installation offers it', async () => {
    await setFlag(true);
    await service(alice, { expiresInDays: 2.5 });
    await servicePass();
    await optOut(alice, true);
    await setFlag(false);
    await deliver();
    expect((await toldAbout())[0]?.state).toBe('DELIVERED');
    expect(sends).toHaveLength(1);
  });

  // =========================================================================
  // 2. Nothing else changes
  // =========================================================================

  it('still tells an opted-out customer about their wallet and their pending payment', async () => {
    await setFlag(true);
    await setFlag(true, 'wallet_low_balance_reminders');
    const before = await ctx.container.settingsService.get(
      tenantA,
      owner,
      'wallet.low_balance.threshold',
    );
    await ctx.container.settingsService.set(tenantA, owner, {
      idempotencyKey: key(),
      key: 'wallet.low_balance.threshold',
      value: { amountMinor: '50000', currency: 'IRT' },
      expectedVersion: before.version,
    });
    await optOut(alice, true);

    await ledger(alice, 'CREDIT', 100_000n);
    await ledger(alice, 'DEBIT', 60_000n); // 40,000: below the threshold
    await pendingPayment(alice);
    const serviceId = await service(alice, { expiresInDays: 2.5 });

    expect(await ctx.container.walletLowBalanceSweep.runOnce(tenantA)).toEqual({ alerts: 1 });
    expect(await ctx.container.pendingPaymentReminderSweep.runOnce(tenantA)).toEqual({
      payments: 1,
      orders: 0,
    });
    await servicePass();

    expect(await kindsFor(alice)).toEqual(['PAYMENT_PENDING_REMINDER', 'WALLET_LOW_BALANCE']);
    await deliver();
    expect(sends.map((one) => one.templateKey).sort()).toEqual([
      'bot.payment.pending_reminder',
      'bot.wallet.low_balance',
    ]);
    // The service itself is untouched by the preference.
    expect(await reminderRows(serviceId)).toBeGreaterThan(0);
  });

  // =========================================================================
  // 3. The customer's own write
  // =========================================================================

  it('is idempotent: a replayed key answers the first result, a second tap changes nothing', async () => {
    await setFlag(true);
    const first = await optOut(alice, true, 'tap-1');
    expect(first.changed).toBe(true);
    const at = await storedOptOut(alice);
    expect(at).not.toBeNull();

    const replay = await optOut(alice, true, 'tap-1');
    expect(replay.changed).toBe(true); // the FIRST result, as stored
    const again = await optOut(alice, true, 'tap-2');
    expect(again.changed).toBe(false);
    expect(await storedOptOut(alice)).toEqual(at);

    // One real change, one event; the audit row records before and after for each call.
    const events = await ctx.container.database.db.execute(
      sql`SELECT count(*)::int AS n FROM outbox_messages WHERE event_type = 'CustomerReminderOptOutChanged'`,
    );
    expect((events.rows[0] as { n: number }).n).toBe(1);
    const audits = await ctx.container.database.db.execute(
      sql`SELECT action, result FROM audit_logs WHERE action = 'customer.reminders_opt_out' ORDER BY occurred_at`,
    );
    expect(audits.rows.map((row) => (row as { result: string }).result)).toEqual([
      'SUCCESS',
      'SUCCESS',
    ]);

    const back = await optOut(alice, false);
    expect(back.changed).toBe(true);
    expect(await storedOptOut(alice)).toBeNull();
  });

  it('refuses the write while the switch is off, whichever surface asks, and stores nothing', async () => {
    for (const optedOut of [true, false]) {
      const refused = await optOut(alice, optedOut).catch((error: unknown) => error);
      expect(isNexaError(refused) && refused.details['reason']).toBe(
        REMINDER_OPT_OUT_DISABLED_REASON,
      );
    }
    expect(await storedOptOut(alice)).toBeNull();
    expect(await ctx.container.customers.remindersOptOutAllowed(tenantA)).toBe(false);
    await setFlag(true);
    expect(await ctx.container.customers.remindersOptOutAllowed(tenantA)).toBe(true);
  });

  it('touches only the named customer', async () => {
    await setFlag(true);
    await optOut(alice, true);
    expect(await storedOptOut(alice)).not.toBeNull();
    expect(await storedOptOut(bob)).toBeNull();
  });

  // =========================================================================
  // 4. The operator's write
  // =========================================================================

  describe('from the Web Admin', () => {
    const auditRows = async (action: string) =>
      (
        await ctx.container.database.db.execute(
          sql`SELECT result, reason, entity_id, before, after FROM audit_logs
               WHERE tenant_id = ${tenantA.tenantId} AND action = ${action} ORDER BY occurred_at`,
        )
      ).rows as unknown as {
        result: string;
        reason: string | null;
        entity_id: string;
        before: Record<string, unknown> | null;
        after: Record<string, unknown> | null;
      }[];

    it('sets it with a reason, audits before and after, emits one event and shows it on the overview', async () => {
      const result = await ctx.container.customerControls.setReminderPreference(tenantA, owner, {
        idempotencyKey: 'op-1',
        customerId: alice,
        optedOut: true,
        reason: 'customer asked support to stop the reminders',
      });
      expect(result.changed).toBe(true);
      expect(result.overview.reminders.optOutAt).not.toBeNull();
      // The flag is off: the page is told the setting is stored but not in force.
      expect(result.overview.reminders.enabled).toBe(false);

      const audits = await auditRows('customer.reminders_opt_out');
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        result: 'SUCCESS',
        reason: 'customer asked support to stop the reminders',
        entity_id: alice,
      });
      expect(audits[0]?.before).toMatchObject({ remindersOptOutAt: null });
      expect(audits[0]?.after).toMatchObject({ optedOut: true, changed: true });

      await setFlag(true);
      const overview = await ctx.container.customerControls.overview(tenantA, owner, alice);
      expect(overview.reminders.enabled).toBe(true);
      expect(overview.reminders.optOutAt).not.toBeNull();

      const events = await ctx.container.database.db.execute(
        sql`SELECT count(*)::int AS n FROM outbox_messages WHERE event_type = 'CustomerReminderOptOutChanged'`,
      );
      expect((events.rows[0] as { n: number }).n).toBe(1);
    });

    it('is idempotent: a replay changes nothing more, a second setting says it changed nothing', async () => {
      const input = {
        customerId: alice,
        optedOut: true,
        reason: 'first',
      };
      await ctx.container.customerControls.setReminderPreference(tenantA, owner, {
        ...input,
        idempotencyKey: 'op-replay',
      });
      const replay = await ctx.container.customerControls.setReminderPreference(tenantA, owner, {
        ...input,
        idempotencyKey: 'op-replay',
      });
      expect(replay.changed).toBe(true);
      expect(await auditRows('customer.reminders_opt_out')).toHaveLength(1);

      const second = await ctx.container.customerControls.setReminderPreference(tenantA, owner, {
        ...input,
        idempotencyKey: 'op-second',
        reason: 'second',
      });
      expect(second.changed).toBe(false);
      await expect(
        ctx.container.customerControls.setReminderPreference(tenantA, owner, {
          ...input,
          optedOut: false,
          idempotencyKey: 'op-replay',
        }),
      ).rejects.toMatchObject({ code: 'platform.idempotency_payload_mismatch' });

      const off = await ctx.container.customerControls.setReminderPreference(tenantA, owner, {
        ...input,
        optedOut: false,
        idempotencyKey: 'op-in',
        reason: 'back',
      });
      expect(off.changed).toBe(true);
      expect(off.overview.reminders.optOutAt).toBeNull();
      expect((await auditRows('customer.reminders_opt_in')).map((row) => row.result)).toEqual([
        'SUCCESS',
      ]);
    });

    it('requires a reason', async () => {
      await expect(
        ctx.container.customerControls.setReminderPreference(tenantA, owner, {
          idempotencyKey: 'op-noreason',
          customerId: alice,
          optedOut: true,
          reason: '   ',
        }),
      ).rejects.toMatchObject({ kind: 'VALIDATION' });
      expect(await storedOptOut(alice)).toBeNull();
    });

    it('refuses a role without users.notifications.edit, audits the denial and changes nothing', async () => {
      const support = adminActorFor(
        await createAdmin(ctx.container, tenantA, {
          username: 'support-r11b6',
          roleKeys: ['support'],
        }),
      );
      await expect(
        ctx.container.customerControls.setReminderPreference(tenantA, support, {
          idempotencyKey: 'op-denied',
          customerId: alice,
          optedOut: true,
          reason: 'x',
        }),
      ).rejects.toMatchObject({ code: 'platform.permission_denied' });
      expect(await storedOptOut(alice)).toBeNull();
      expect((await auditRows('customer.reminders_opt_out')).map((row) => row.result)).toEqual([
        'DENIED',
      ]);
      const events = await ctx.container.database.db.execute(
        sql`SELECT count(*)::int AS n FROM outbox_messages WHERE event_type = 'CustomerReminderOptOutChanged'`,
      );
      expect((events.rows[0] as { n: number }).n).toBe(0);
    });
  });
});
