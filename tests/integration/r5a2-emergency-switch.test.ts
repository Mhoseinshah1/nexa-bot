import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CUSTOMER_NOTICES_PAUSE_SETTING_KEY,
  CUSTOMER_NOTIFICATION_AUTOMATED,
  CUSTOMER_NOTIFICATION_KINDS,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type UserId,
} from '@nexa/contracts';
import { OPERATIONAL_EVENT_LABELS_FA } from '@nexa/i18n';
import { DrizzleCustomerNotificationRepository } from '../../apps/api/src/modules/commerce/messaging/infrastructure/drizzle-customer-notification.repository';
import { CustomerNotificationService } from '../../apps/api/src/modules/commerce/messaging/application/customer-notification.service';
import type { CustomerMessage } from '../../apps/api/src/modules/commerce/messaging/application/ports';
import { DrizzleCustomerRepository } from '../../apps/api/src/modules/commerce/customers/infrastructure/drizzle-customer.repository';
import { DrizzlePaymentRepository } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-payment.repository';
import { DrizzleWalletRepository } from '../../apps/api/src/modules/commerce/wallet/infrastructure/drizzle-wallet.repository';
import { DrizzleNotificationSubjectReader } from '../../apps/api/src/modules/commerce/messaging/infrastructure/drizzle-notification-subject.reader';
import { DrizzleCustomerReminderFactsReader } from '../../apps/api/src/modules/commerce/messaging/infrastructure/drizzle-customer-reminder-facts.reader';
import { DrizzleServiceReminderSnapshotReader } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service-reminder.repository';
import { BroadcastDispatcher } from '../../apps/api/src/modules/commerce/broadcasts/application/broadcast-dispatcher';
import type {
  BroadcastDeliverRequest,
  BroadcastRenderRequest,
  BroadcastRenderResult,
  BroadcastSendResult,
  BroadcastTransport,
} from '../../apps/api/src/modules/commerce/broadcasts/application/ports';
import { DrizzleBroadcastRepository } from '../../apps/api/src/modules/commerce/broadcasts/infrastructure/drizzle-broadcast.repository';
import { DrizzleRecipientFactsReader } from '../../apps/api/src/modules/commerce/broadcasts/infrastructure/drizzle-recipient-facts.reader';
import { AudienceFixtures } from './audience-fixtures';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  SEED_IDS,
  tenantA,
  type TestContext,
} from './harness';
import { orderEndsReader } from '../support/order-ends';

/**
 * R5A-2 item 5 — the owner's emergency switch for AUTOMATED customer messages.
 *
 * MUTATIONS, each checked by reverting the single rule and watching its test fail:
 *   - `heldByEmergencySwitch` returning false            -> "sends no automated notice" fails.
 *   - the `AUTOMATED` check dropped (hold every kind)    -> "an operator-initiated kind" fails.
 *   - `announceNoticePause` dropped or its guard removed -> the two announcement tests fail.
 *   - the `wasOn === isOn` guard removed                  -> "restates the default" fails.
 */
const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const GIGABYTE = 1_073_741_824n;
const ALLOWANCE = 50n * GIGABYTE;
const DAY = 86_400;
const LOG_CHAT = '-1001234567890';
const PAUSED = OPERATIONAL_EVENT_LABELS_FA['customer_notices.paused']!;
const RESUMED = OPERATIONAL_EVENT_LABELS_FA['customer_notices.resumed']!;

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

describe('the emergency switch for automated customer messages (R5A-2 item 5)', () => {
  let ctx: TestContext;
  let owner: ActorContext;
  let panelA: string;
  let productA: string;
  let customerA: UserId;
  let n = 0;
  const key = (): string => `r5a2-sw-${(n += 1)}`;
  let sends: CustomerMessage[] = [];

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 120_000);
  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    sends = [];
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-r5a2sw', roleKeys: ['owner'] }),
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
      systemActor('resolve-952001'),
      {
        idempotencyKey: 'resolve-952001',
        telegramUserId: '952001',
        from: { id: 952001, first_name: 'سارا' },
        botInstanceId: BOT_A,
      },
    );
    customerA = customer.id;
  });

  async function expiringService(): Promise<void> {
    const orderId = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO orders (id, tenant_id, customer_id, state, product_id, panel_id, purpose,
                          line_title, line_duration_days, line_traffic_bytes,
                          line_device_limit, line_unit_price_amount, line_quantity,
                          subtotal_amount, discount_amount, total_amount, currency, quote,
                          confirmed_at, settled_at)
      VALUES (${orderId}, ${tenantA.tenantId}, ${customerA}, 'PAID',
              ${productA}, ${panelA}, 'NEW_SERVICE', 'پلن', 30, ${ALLOWANCE}, 2, 250000, 1,
              250000, 0, 250000, 'IRT', '{"trace":[]}'::jsonb, now() - interval '30 minutes', now())`);
    await ctx.container.database.db.execute(sql`
      INSERT INTO services (id, tenant_id, customer_id, order_id, panel_id, product_id,
                            provider_username, subscription_ref, provider_client_id,
                            traffic_limit_bytes, traffic_used_bytes, usage_synced_at,
                            state, provisioned_at, terminated_at, expires_at)
      VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, ${customerA}, ${orderId},
              ${panelA}, ${productA}, 'usw1', ${'a'.repeat(32)}, ${ctx.container.ids.uuid()},
              ${ALLOWANCE}, 0, now(), 'ACTIVE', now(), NULL,
              now() + make_interval(secs => ${2.5 * DAY}))`);
  }

  async function setSwitch(value: boolean): Promise<void> {
    const before = await ctx.container.settingsService.get(
      tenantA,
      owner,
      CUSTOMER_NOTICES_PAUSE_SETTING_KEY,
    );
    await ctx.container.settingsService.set(tenantA, owner, {
      idempotencyKey: key(),
      key: CUSTOMER_NOTICES_PAUSE_SETTING_KEY,
      value,
      expectedVersion: before.version,
    });
  }

  async function configureLog(): Promise<void> {
    await ctx.container.featureFlags.set(tenantA, owner, {
      key: 'ops_notifications',
      enabled: true,
      expectedVersion: null,
      idempotencyKey: key(),
      confirmKey: 'ops_notifications',
      reason: 'Emergency switch log.',
    });
    for (const [settingKey, value] of [
      ['ops.notifications.telegram_chat_id', LOG_CHAT],
      ['ops.notifications.telegram_topic_id', 5],
    ] as const) {
      await ctx.container.settingsService.set(tenantA, owner, {
        key: settingKey,
        value,
        expectedVersion: null,
        idempotencyKey: key(),
      });
    }
  }

  async function relayAll(): Promise<void> {
    for (let round = 0; round < 20; round += 1) {
      if ((await ctx.container.relay.processBatch()).claimed === 0) return;
    }
  }

  /** The operations-group messages whose heading is exactly this event title. */
  async function groupMessages(heading: string): Promise<number> {
    const result = await ctx.container.database.db.execute(sql`
      SELECT count(*)::int AS n FROM notifications
       WHERE tenant_id = ${tenantA.tenantId} AND kind = 'OPERATIONAL_EVENT'
         AND payload->>'heading' = ${heading}`);
    return Number((result.rows[0] as { n: number }).n);
  }

  function lane(withSwitch = true): CustomerNotificationService {
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
      // R11 A11: the two ended-order kinds render the order's own summary.
      orderEnds: orderEndsReader(db as never),
      messenger: {
        send: async (_scope, message) => {
          sends.push(message);
          return { outcome: 'DELIVERED' };
        },
        acknowledge: async () => undefined,
        sendFile: async () => ({ outcome: 'REFUSED' }),
      },
      ...(withSwitch ? { automatedPaused: ctx.container.automatedNoticesPaused } : {}),
      uow: ctx.container.uow,
      clock: ctx.container.clock,
      scopeIsActive: async () => true,
      logger: { info: () => {}, error: () => {} },
    });
  }

  async function states(): Promise<Record<string, string>> {
    const result = await ctx.container.database.db.execute(
      sql`SELECT kind, state FROM customer_notifications`,
    );
    return Object.fromEntries(
      (result.rows as unknown as { kind: string; state: string }[]).map((r) => [r.kind, r.state]),
    );
  }

  it('classifies every kind in the closed set, and every reminder is automated', () => {
    expect(Object.keys(CUSTOMER_NOTIFICATION_AUTOMATED).sort()).toEqual(
      [...CUSTOMER_NOTIFICATION_KINDS].sort(),
    );
    for (const kind of ['SERVICE_EXPIRY_FIRST', 'WALLET_LOW_BALANCE', 'RESELLER_MINIMUM_REMINDER'])
      expect(
        CUSTOMER_NOTIFICATION_AUTOMATED[kind as keyof typeof CUSTOMER_NOTIFICATION_AUTOMATED],
      ).toBe(true);
    for (const kind of ['DIRECT_MESSAGE', 'TICKET_REPLY', 'PAYMENT_TRANSFER_RECORDED'])
      expect(
        CUSTOMER_NOTIFICATION_AUTOMATED[kind as keyof typeof CUSTOMER_NOTIFICATION_AUTOMATED],
      ).toBe(false);
  });

  it('sends no automated notice while it is on, never sends it later, and sends it normally when off from the start', async () => {
    await expiringService();
    await setSwitch(true);
    expect(await ctx.container.serviceReminderSweep.runOnce(tenantA)).toEqual({
      expiry: 1,
      usage: 0,
    });

    const report = await lane().deliverDue(tenantA, 50);
    expect(report).toMatchObject({ claimed: 1, delivered: 0, superseded: 1 });
    expect(sends).toHaveLength(0);
    expect(await states()).toEqual({ SERVICE_EXPIRY_FIRST: 'SUPERSEDED' });

    // Off again: no backlog — the held notice is gone for good, and the fact is not re-raised.
    await setSwitch(false);
    expect(await ctx.container.serviceReminderSweep.runOnce(tenantA)).toEqual({
      expiry: 0,
      usage: 0,
    });
    expect(await lane().deliverDue(tenantA, 50)).toMatchObject({ claimed: 0 });
    expect(sends).toHaveLength(0);
  });

  it('releases no backlog: automated rows still PENDING when it goes OFF are superseded, not sent', async () => {
    await setSwitch(true);
    // Rows queued while the switch is on and never seen by a dispatcher pass (a short pause,
    // or a backlog beyond one pass's limit).
    for (const kind of [
      'SERVICE_EXPIRY_FIRST',
      'WALLET_LOW_BALANCE',
      'RESELLER_MINIMUM_REMINDER',
    ]) {
      await ctx.container.database.db.execute(sql`
        INSERT INTO customer_notifications (id, tenant_id, customer_id, bot_instance_id, kind, subject_id,
                                            state, next_attempt_at, attempts, created_at)
        VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, ${customerA}, ${BOT_A}, ${kind},
                ${ctx.container.ids.uuid()}, 'PENDING', now(), 0, now() - interval '1 minute')`);
    }
    // A kind the switch never touches (a real cancelled order, so its precondition holds).
    const ticketOrder = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO orders (id, tenant_id, customer_id, state, product_id, panel_id, purpose,
                          line_title, line_duration_days, line_traffic_bytes,
                          line_device_limit, line_unit_price_amount, line_quantity,
                          subtotal_amount, discount_amount, total_amount, currency, quote,
                          confirmed_at, cancelled_at)
      VALUES (${ticketOrder}, ${tenantA.tenantId}, ${customerA}, 'CANCELLED',
              ${productA}, ${panelA}, 'NEW_SERVICE', 'پلن', 30, ${ALLOWANCE}, 2, 250000, 1,
              250000, 0, 250000, 'IRT', '{"trace":[]}'::jsonb, now(), now())`);
    await ctx.container.database.db.execute(sql`
      INSERT INTO customer_notifications (id, tenant_id, customer_id, bot_instance_id, kind, subject_id,
                                          state, next_attempt_at, attempts, created_at)
      VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, ${customerA}, ${BOT_A}, 'ORDER_CANCELLED',
              ${ticketOrder}, 'PENDING', now(), 0, now() - interval '1 minute')`);

    await setSwitch(false);
    const report = await lane().deliverDue(tenantA, 50);
    const after = await ctx.container.database.db.execute(
      sql`SELECT kind, state, resolved_at, next_attempt_at FROM customer_notifications ORDER BY kind`,
    );
    const rows = after.rows as unknown as {
      kind: string;
      state: string;
      resolved_at: Date | null;
      next_attempt_at: Date | null;
    }[];
    for (const row of rows.filter((r) => r.kind !== 'ORDER_CANCELLED')) {
      expect(row.state).toBe('SUPERSEDED');
      expect(row.resolved_at).not.toBeNull();
      expect(row.next_attempt_at).toBeNull();
    }
    expect(rows.find((r) => r.kind === 'ORDER_CANCELLED')?.state).toBe('DELIVERED');
    expect(report.claimed).toBe(1);
    expect(sends.map((one) => one.templateKey)).toHaveLength(1);
  });

  it('holds nothing while the switch is off', async () => {
    await expiringService();
    await ctx.container.serviceReminderSweep.runOnce(tenantA);
    expect(await lane().deliverDue(tenantA, 50)).toMatchObject({ delivered: 1, superseded: 0 });
    expect(sends.map((one) => one.templateKey)).toEqual(['bot.service.expiry_first']);
  });

  it('still sends an operator-initiated kind through the lane while it is on', async () => {
    await expiringService();
    await setSwitch(true);
    const ticketOrder = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO orders (id, tenant_id, customer_id, state, product_id, panel_id, purpose,
                          line_title, line_duration_days, line_traffic_bytes,
                          line_device_limit, line_unit_price_amount, line_quantity,
                          subtotal_amount, discount_amount, total_amount, currency, quote,
                          confirmed_at, cancelled_at)
      VALUES (${ticketOrder}, ${tenantA.tenantId}, ${customerA}, 'CANCELLED',
              ${productA}, ${panelA}, 'NEW_SERVICE', 'پلن', 30, ${ALLOWANCE}, 2, 250000, 1,
              250000, 0, 250000, 'IRT', '{"trace":[]}'::jsonb, now(), now())`);
    await ctx.container.database.db.execute(sql`
      INSERT INTO customer_notifications (id, tenant_id, customer_id, bot_instance_id, kind, subject_id, state,
                                          next_attempt_at, attempts, created_at)
      VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, ${customerA}, ${BOT_A}, 'ORDER_CANCELLED',
              ${ticketOrder}, 'PENDING', now(), 0, now())`);
    expect(await lane().deliverDue(tenantA, 50)).toMatchObject({ delivered: 1, superseded: 0 });
    expect(sends.map((one) => one.templateKey)).toHaveLength(1);
  });

  it('does not touch a broadcast: it is still sent while the switch is on', async () => {
    await setSwitch(true);
    const fixtures = new AudienceFixtures(ctx, tenantA.tenantId as string);
    await fixtures.customer({
      telegramUserId: '952100',
      botInstanceId: SEED_IDS.botA1,
      firstName: 'x',
    });
    const delivered: string[] = [];
    const transport: BroadcastTransport = {
      render: async (
        _s: unknown,
        request: BroadcastRenderRequest,
      ): Promise<BroadcastRenderResult> => ({
        ok: true,
        rendered: {
          contentKind: request.contentKind,
          text: request.body,
          buttons: request.buttons,
          source: request.source,
        },
      }),
      pin: async () => ({ outcome: 'PINNED' }),
      deliver: async (
        _s: unknown,
        request: BroadcastDeliverRequest,
      ): Promise<BroadcastSendResult> => {
        delivered.push(request.chatId);
        return { outcome: 'SENT', messageId: delivered.length };
      },
    } as unknown as BroadcastTransport;
    const dispatcher = new BroadcastDispatcher({
      repository: new DrizzleBroadcastRepository(ctx.container.database.db),
      transport,
      facts: new DrizzleRecipientFactsReader(ctx.container.database.db, async () => 'IRT'),
      outbox: ctx.container.outbox,
      uow: ctx.container.uow,
      clock: { now: () => new Date(Date.now() + 5_000) },
      ids: ctx.container.ids,
      scopeIsActive: async () => true,
      logger: { info: () => undefined, error: () => undefined },
    });
    const draft = await ctx.container.broadcasts.create(tenantA, owner, {
      idempotencyKey: key(),
      title: 'Nowruz',
      contentKind: 'TEXT',
      body: 'سلام',
      buttons: [],
      audience: { version: 1 },
    });
    const record = await ctx.container.broadcasts.get(tenantA, owner, draft.id);
    const preview = await ctx.container.broadcasts.preview(tenantA, owner, draft.id);
    await ctx.container.broadcasts.launch(tenantA, owner, draft.id, {
      idempotencyKey: key(),
      mode: 'NOW',
      scheduledAt: null,
      expectedVersion: record.version,
      expectedDefinitionHash: preview.definitionHash,
      expectedRecipients: preview.customers,
      expectedFingerprint: preview.fingerprint,
      typedCount: null,
    });
    await dispatcher.pass(tenantA);
    expect([...delivered].sort()).toEqual(['952001', '952100']);
  });

  it('announces the switch in the operations group exactly once on ON, and once on OFF', async () => {
    await configureLog();
    await setSwitch(true);
    await relayAll();
    expect(await groupMessages(PAUSED)).toBe(1);
    expect(await groupMessages(RESUMED)).toBe(0);

    // Writing the same value again is a no-op and announces nothing.
    await setSwitch(true);
    await relayAll();
    expect(await groupMessages(PAUSED)).toBe(1);

    await setSwitch(false);
    await relayAll();
    expect(await groupMessages(RESUMED)).toBe(1);
    expect(await groupMessages(PAUSED)).toBe(1);

    // Switching it off again changes nothing.
    await setSwitch(false);
    await relayAll();
    expect(await groupMessages(RESUMED)).toBe(1);
  });

  it('announces nothing when the first write only restates the default (off)', async () => {
    await configureLog();
    await setSwitch(false);
    await relayAll();
    expect(await groupMessages(RESUMED)).toBe(0);
    expect(await groupMessages(PAUSED)).toBe(0);
  });
});
