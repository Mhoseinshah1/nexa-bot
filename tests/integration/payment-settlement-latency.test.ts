import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  money,
  paymentTrackingCode,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type PaymentGatewayConfig,
  type PaymentGatewayProvider,
  type PaymentId,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import { DrizzleCustomerRepository } from '../../apps/api/src/modules/commerce/customers/infrastructure/drizzle-customer.repository';
import {
  CustomerNotificationLoop,
  CUSTOMER_NOTIFICATION_INTERVAL_MS,
} from '../../apps/api/src/modules/commerce/messaging/application/customer-notification-loop';
import { CustomerNotificationService } from '../../apps/api/src/modules/commerce/messaging/application/customer-notification.service';
import { CUSTOMER_NOTIFICATION_LATENCY_WARN_MS } from '../../apps/api/src/modules/commerce/messaging/application/notification-latency';
import type {
  CustomerMessage,
  CustomerSendResult,
} from '../../apps/api/src/modules/commerce/messaging/application/ports';
import {
  GATEWAY_LATE_COMPLETION_CODE,
  GatewayPaymentService,
  gatewayCallbackUrl,
  type GatewayPaymentServiceDeps,
} from '../../apps/api/src/modules/commerce/payments/application/gateway-payment.service';
import {
  DrizzleGatewayCallBudget,
  DrizzleGatewayCredentialStore,
  DrizzlePublicOriginReader,
} from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-gateway-credentials';
import { DrizzleGatewayInvoiceRepository } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-gateway-invoice.repository';
import { DrizzlePaymentRepository } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-payment.repository';
import {
  TonPaysAdapter,
  type FetchLike,
} from '../../apps/api/src/modules/commerce/payments/infrastructure/tonpays-adapter';
import { DrizzleServiceReminderSnapshotReader } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service-reminder.repository';
import { DrizzleOperationalConditionReader } from '../../apps/api/src/modules/platform/opslog/infrastructure/drizzle-operational-event.reader';
import { DrizzleWalletRepository } from '../../apps/api/src/modules/commerce/wallet/infrastructure/drizzle-wallet.repository';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  SEED_IDS,
  tenantA,
  type TestContext,
} from './harness';

/**
 * FIX-03 (2026-10-09), end to end against a real database: a valid approval credits the
 * ledger exactly once, the amount-and-tracking-code message is due the instant that credit
 * commits, and a healthy dispatcher sends it within one short interval — for every rail
 * that credits a wallet.
 *
 * The owner's report: «your payment was approved by the gateway» at 09:37, the message with
 * the amount and the tracking code at about 09:39. The approval is the gateway worker's
 * edit of the invoice message, made in the pass that committed the credit; the amount is
 * `WALLET_TOPUP_CREDITED`, enqueued in that SAME transaction — and it then waited for the
 * customer notification lane's next pass, once a minute. The money path never waited; the
 * dispatcher's timer did. `docs/payment-settlement-latency.md` carries the trace.
 *
 * What is real here: the database, `PaymentService` and its one settlement path, the
 * gateway lane with the REAL TonPays adapter over a recording fake `fetch`, the dispatcher
 * with the production readers, and `CustomerNotificationLoop` on its PRODUCTION interval
 * and real timers. Only the Telegram messenger is ours, so an outcome is a fixture.
 *
 * Per rail, the approval enters where that rail's own lane hands it to the settlement path:
 *
 *   - MANUAL_TRANSFER (card to card): an operator's `confirmManualTransfer`;
 *   - TONPAYS: the full lane — create, webhook hint, inquiry, settlement;
 *   - NOWPAYMENTS / CENTRALPAY: `confirmGatewayPayment` with the evidence each inquiry passes
 *     (each provider's own suite drives its adapter into that call);
 *   - TELEGRAM_STARS: a recorded `successful_payment`, settled by `settleRecorded`.
 *
 * TONPAYS_TELEGRAM settles through the same inquiry lane and the same call as TONPAYS; its
 * card and receipt steps are upstream of the approval and unchanged here.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const MARYAM = '930303';
/** How long a test waits for a send before calling the lane slow. Generous for a loaded CI. */
const PROMPT_BOUND_MS = CUSTOMER_NOTIFICATION_INTERVAL_MS + 4_000;

const systemActor = (key: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'settlement-latency:test',
  surface: 'TELEGRAM',
  correlationId: `corr-${key}` as CorrelationId,
});

const OPEN_ROUTE: PaymentGatewayConfig = {
  displayName: null,
  instructions: null,
  minAmountMinor: 0n,
  maxAmountMinor: 0n,
  eligibility: {
    activateAfterPayments: 0,
    deactivateAfterPayments: 0,
    activateAfterAccountDays: 0,
  },
  sortOrder: 0,
  topupCashbackPercent: 0,
  allowServicePurchase: true,
  allowWalletTopup: true,
};

// ---------------------------------------------------------------------------------------
// A fake TonPays: create and check, the documented shapes, and a switch for a lost answer.
// ---------------------------------------------------------------------------------------

class FakeTonPays {
  readonly invoices = new Map<
    string,
    { orderId: string; amount: number; status: string; paid: unknown }
  >();
  checks = 0;
  /** The check call's answer is lost (a timeout): the gateway's outcome is UNKNOWN. */
  checkLost = false;
  private seq = 0;

  readonly fetch: FetchLike = async (url, init) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    if (url.endsWith('/api/v1/invoices/create')) {
      this.seq += 1;
      const invoiceId = `TP-${String(this.seq).padStart(8, '0')}`;
      const invoice = {
        orderId: String(body.order_id),
        amount: Number(body.amount),
        status: 'pending',
        paid: false as unknown,
      };
      this.invoices.set(invoiceId, invoice);
      return json(201, {
        invoice_id: invoiceId,
        order_id: invoice.orderId,
        request_amount: invoice.amount,
        final_amount: invoice.amount,
        status: 'pending',
        invoice_url: `https://t.me/TonPaysInvoiceBot?start=inv_${invoiceId}`,
        web_invoice_url: `https://pay.tonpays.online/i/${invoiceId}`,
        callback_url: body.callback_url,
      });
    }
    if (url.endsWith('/api/v1/invoices/check')) {
      this.checks += 1;
      if (this.checkLost) throw new Error('socket hang up');
      const invoiceId = String(body.invoice_id);
      const invoice = this.invoices.get(invoiceId);
      if (invoice === undefined) return json(404, { detail: { code: 'INVOICE_NOT_FOUND' } });
      return json(200, {
        invoice_id: invoiceId,
        order_id: invoice.orderId,
        request_amount: invoice.amount,
        final_amount: invoice.amount,
        status: invoice.status,
        paid: invoice.paid,
      });
    }
    return json(404, { detail: { code: 'NOT_FOUND' } });
  };

  approve(invoiceId: string): void {
    const invoice = this.invoices.get(invoiceId);
    if (invoice === undefined) throw new Error(`no fake invoice ${invoiceId}`);
    invoice.status = 'completed';
    invoice.paid = true;
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('FIX-03: approval, credit and the final message, without an artificial wait', () => {
  let ctx: TestContext;
  let owner: ActorContext;
  let maryam: UserId;
  let tonpays: FakeTonPays;
  let lane: GatewayPaymentService;
  let offsetMs = 0;
  let keySeq = 0;
  const key = () => `fix03-${String((keySeq += 1))}`;

  /** Every message the fake messenger saw, with the instant it saw it. */
  let sends: { message: CustomerMessage; at: number }[] = [];
  /** What the next sends answer; DELIVERED once this runs out. */
  let outcomes: CustomerSendResult[] = [];
  /** Every dispatcher log line. */
  let logs: { level: string; message: string; context: Record<string, unknown> }[] = [];

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    ctx.container.setInstallationTenant(tenantA.tenantId);
    sends = [];
    outcomes = [];
    logs = [];
    offsetMs = 0;
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: `owner-${key()}`,
        roleKeys: ['owner'],
      }),
    );
    maryam = (
      await ctx.container.customers.resolveFromUpdate(tenantA, systemActor('resolve'), {
        idempotencyKey: `resolve-${key()}`,
        telegramUserId: MARYAM,
        from: { id: Number(MARYAM), first_name: 'مریم' },
        botInstanceId: BOT_A,
      })
    ).customer.id;
    await ctx.container.database.db.execute(
      sql`UPDATE bot_instances SET webhook_url = ${`https://bot.example.com/telegram/webhook/${BOT_A}`}
          WHERE tenant_id = ${tenantA.tenantId}`,
    );
    tonpays = new FakeTonPays();
    lane = laneWith();
  });

  // -------------------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------------------

  function laneWith(payments?: GatewayPaymentServiceDeps['payments']): GatewayPaymentService {
    const db = ctx.container.database.db;
    const adapter = new TonPaysAdapter({ fetch: tonpays.fetch });
    const origins = new DrizzlePublicOriginReader(db);
    return new GatewayPaymentService({
      invoices: new DrizzleGatewayInvoiceRepository(db),
      payments: payments ?? ctx.container.payments,
      paymentRecords: new DrizzlePaymentRepository(db),
      adapters: (provider) => (provider === 'TONPAYS' ? adapter : null),
      credentials: new DrizzleGatewayCredentialStore(db, ctx.container.cipher, () =>
        ctx.container.ids.uuid(),
      ),
      botTokens: { tokenForBotInstance: () => Promise.resolve(null) },
      presentation: () => Promise.reject(new Error('TonPays renders no invoice text')),
      budget: new DrizzleGatewayCallBudget(db),
      callbackUrlFor: async (scope: TenantContext, provider) =>
        gatewayCallbackUrl(await origins.originFor(scope), provider, String(scope.tenantId)),
      customers: new DrizzleCustomerRepository(db),
      conditions: new DrizzleOperationalConditionReader(db),
      scopeActivity: ctx.container.tenants,
      uow: ctx.container.uow,
      audit: ctx.container.audit,
      opsLog: ctx.container.opsLog,
      outbox: ctx.container.outbox,
      clock: { now: () => new Date(Date.now() + offsetMs) },
      ids: ctx.container.ids,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });
  }

  /** The dispatcher with the production readers; only the messenger is ours. */
  function dispatcher(
    extra: Partial<ConstructorParameters<typeof CustomerNotificationService>[0]> = {},
  ): CustomerNotificationService {
    const db = ctx.container.database.db;
    const wallet = new DrizzleWalletRepository(db);
    const payments = new DrizzlePaymentRepository(db);
    const people = new DrizzleCustomerRepository(db);
    const record = (level: string) => (context: Record<string, unknown>, message: string) =>
      logs.push({ level, message, context });
    return new CustomerNotificationService({
      notifications: ctx.container.customerNotifications,
      refundFigures: wallet,
      paymentCredits: wallet,
      rejectionReasons: payments,
      paymentReferences: payments,
      reminderSnapshots: new DrizzleServiceReminderSnapshotReader(db),
      contacts: {
        contactFor: async (scope, customerId, tx) => {
          const found = await people.findById(scope, customerId, tx);
          if (found === null) return { kind: 'NONE' };
          if (found.status !== 'ACTIVE') return { kind: 'BLOCKED' };
          return { kind: 'CONTACT', contact: { chatId: found.telegramUserId } };
        },
      },
      subjects: { stillHolds: async () => true },
      messenger: {
        send: async (_scope, message) => {
          sends.push({ message, at: Date.now() });
          return outcomes.shift() ?? { outcome: 'DELIVERED' };
        },
        acknowledge: async () => undefined,
        sendFile: async () => ({ outcome: 'REFUSED' }),
      },
      uow: ctx.container.uow,
      clock: ctx.container.clock,
      scopeIsActive: async () => true,
      logger: { info: record('info'), error: record('error'), warn: record('warn') },
      ...extra,
    });
  }

  const sweep = (service = dispatcher()) => service.deliverDue(tenantA, 50);

  /**
   * The production timer around the dispatcher, started the moment the credit committed —
   * the worst phase for it: its first pass is a whole interval away. Answers how long after
   * the commit the customer's message was handed to Telegram.
   */
  async function sentWithinPromptBound(committedAt: number): Promise<number> {
    const loop = new CustomerNotificationLoop(dispatcher(), {
      scope: () => tenantA,
      intervalMs: CUSTOMER_NOTIFICATION_INTERVAL_MS,
      now: () => Date.now(),
      logger: { info: () => undefined, error: () => undefined },
    });
    loop.start();
    try {
      const deadline = committedAt + PROMPT_BOUND_MS + 30_000;
      while (sends.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } finally {
      await loop.stop();
    }
    expect(sends.length, 'the final message was never sent').toBeGreaterThan(0);
    return sends[0]!.at - committedAt;
  }

  async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
    return (await ctx.container.database.db.execute(query)).rows as T[];
  }

  const ledger = (paymentId: string) =>
    rows<{ reason: string; amount: string }>(
      sql`SELECT reason, amount::text AS amount FROM wallet_entries
          WHERE tenant_id = ${tenantA.tenantId} AND payment_id = ${paymentId} ORDER BY reason`,
    );

  const notifications = (paymentId: string) =>
    rows<{
      kind: string;
      state: string;
      attempts: number;
      next_attempt_at: Date | null;
      send_started_at: Date | null;
      created_at: Date;
      resolved_at: Date | null;
    }>(
      sql`SELECT kind, state, attempts, next_attempt_at, send_started_at, created_at, resolved_at
          FROM customer_notifications WHERE tenant_id = ${tenantA.tenantId}
           AND subject_id = ${paymentId} ORDER BY created_at, kind`,
    );

  const paymentRow = async (paymentId: string) =>
    (
      await rows<{ state: string; confirmed_at: Date | null; reference: string }>(
        sql`SELECT state, confirmed_at, reference FROM payments WHERE id = ${paymentId}`,
      )
    )[0]!;

  /**
   * The credit and its announcement are one fact: the notification row was written by the
   * transaction that credited (the same `now`), and it is due at once — no `next_attempt_at`,
   * no stamp. That is "eligible for dispatch at commit", measured from the rows themselves.
   */
  async function expectCreditedOnceAndDueAtCommit(paymentId: string, amountMinor: bigint) {
    expect(await ledger(paymentId)).toEqual([
      expect.objectContaining({ amount: amountMinor.toString() }),
    ]);
    const payment = await paymentRow(paymentId);
    expect(payment.state).toBe('CONFIRMED');
    const queued = await notifications(paymentId);
    expect(queued.map((row) => row.kind)).toEqual(['WALLET_TOPUP_CREDITED']);
    const [row] = queued;
    expect(row!.state).toBe('PENDING');
    expect(row!.next_attempt_at, 'the final message was scheduled for later').toBeNull();
    expect(row!.send_started_at).toBeNull();
    expect(new Date(row!.created_at).getTime(), 'enqueued outside the credit').toBe(
      new Date(payment.confirmed_at!).getTime(),
    );
    return payment;
  }

  /** The message the customer reads: the amount, and the payment's own tracking code. */
  function expectFinalMessage(reference: string, amountMinor: bigint) {
    expect(sends).toHaveLength(1);
    expect(sends[0]!.message.templateKey).toBe('bot.wallet.topup_credited');
    expect(sends[0]!.message.values).toEqual({
      amount: money(amountMinor, 'IRT'),
      // FIX-02: the public tracking code, never the stored `<code>:<role>` reference.
      reference: paymentTrackingCode(reference),
    });
    expect(
      String(sends[0]!.message.values['reference']),
      'a role suffix reached the customer',
    ).not.toContain(':');
  }

  // --- the rails ---------------------------------------------------------------------

  async function setSetting(settingKey: string, value: unknown): Promise<void> {
    await ctx.container.database.db.execute(sql`
      INSERT INTO setting_values (id, tenant_id, setting_key, value, version, updated_at)
      VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, ${settingKey},
              ${JSON.stringify(value)}::jsonb, 1, now())
      ON CONFLICT (tenant_id, setting_key)
        DO UPDATE SET value = ${JSON.stringify(value)}::jsonb, version = setting_values.version + 1`);
  }

  async function centralFx(rate: bigint) {
    const current = await ctx.container.featureFlagResolver.resolve(tenantA, 'central_fx');
    if (!current.enabled) {
      await ctx.container.featureFlags.set(tenantA, owner, {
        key: 'central_fx',
        enabled: true,
        expectedVersion: current.version,
        idempotencyKey: key(),
        reason: 'FIX-03 settlement latency test.',
      });
    }
    await ctx.container.database.db.execute(
      sql`INSERT INTO fx_quotes (tenant_id, base_asset, quote_currency, rate_mantissa, rate_scale,
                                 source, source_at, fetched_at, quote_id, policy_version)
          VALUES (${tenantA.tenantId}, 'USDT', 'IRT', ${rate}, 0, 'WALLEX', NULL, now(),
                  ${`v1:WALLEX:USDT-IRT:${String(rate)}e-0:-:fix03`}, 1)
          ON CONFLICT (tenant_id, base_asset, quote_currency) DO UPDATE
            SET rate_mantissa = EXCLUDED.rate_mantissa, fetched_at = now(), quote_id = EXCLUDED.quote_id`,
    );
  }

  async function enable(provider: PaymentGatewayProvider) {
    await ctx.container.paymentGateways.configure(tenantA, owner, {
      idempotencyKey: key(),
      provider,
      config: OPEN_ROUTE,
    });
    if (provider === 'TONPAYS' || provider === 'NOWPAYMENTS' || provider === 'CENTRALPAY') {
      await ctx.container.paymentGateways.setCredential(tenantA, owner, {
        idempotencyKey: key(),
        provider,
        apiKey: `${provider.toLowerCase()}_test_key_never_leaks`,
      });
    }
    if (provider === 'NOWPAYMENTS') {
      await ctx.container.paymentGateways.setWebhookSecret(tenantA, owner, {
        idempotencyKey: key(),
        provider,
        secret: 'np_ipn_secret_for_fix03_never_leaks',
      });
      await centralFx(103_500n);
    }
    if (provider === 'CENTRALPAY') {
      await ctx.container.paymentGateways.setVerifyKey(tenantA, owner, {
        idempotencyKey: key(),
        provider,
        verifyKey: 'cp_verify_fix03_never_leaks',
      });
    }
    if (provider === 'TELEGRAM_STARS') {
      await centralFx(130_000n);
      const current = await ctx.container.settingsService.get(tenantA, owner, 'stars.per_usdt');
      await ctx.container.settingsService.set(tenantA, owner, {
        key: 'stars.per_usdt',
        value: '100',
        expectedVersion: current.version,
        idempotencyKey: key(),
      });
    }
    await ctx.container.paymentGateways.setStatus(tenantA, owner, {
      idempotencyKey: key(),
      provider,
      status: 'ACTIVE',
    });
  }

  const gatewayTopup = async (provider: PaymentGatewayProvider, amountMinor: bigint) => {
    const k = key();
    const attempt = await ctx.container.payments.requestGatewayTopup(
      { ...tenantA, botInstanceId: BOT_A },
      systemActor(k),
      maryam,
      { idempotencyKey: k, amount: money(amountMinor, 'IRT'), provider },
    );
    return attempt.payment.id as PaymentId;
  };

  const invoiceOf = async (paymentId: string) =>
    (
      await rows<{
        provider_order_id: string;
        provider_invoice_id: string | null;
        outcome: string | null;
        next_inquiry_at: Date | null;
      }>(
        sql`SELECT provider_order_id, provider_invoice_id, outcome, next_inquiry_at
            FROM gateway_invoices WHERE payment_id = ${paymentId}`,
      )
    )[0]!;

  /** A created TonPays top-up attempt, approved by the provider and not yet asked. */
  async function approvedTonPaysTopup(amountMinor = 250_000n) {
    await enable('TONPAYS');
    const paymentId = await gatewayTopup('TONPAYS', amountMinor);
    await lane.runOnce(tenantA); // creates the invoice
    const invoice = await invoiceOf(paymentId);
    expect(invoice.provider_invoice_id).not.toBeNull();
    tonpays.approve(invoice.provider_invoice_id!);
    return { paymentId, invoice };
  }

  const webhook = (
    invoice: { provider_order_id: string; provider_invoice_id: string | null },
    id: string,
  ) =>
    lane.receiveWebhook(
      String(tenantA.tenantId),
      'TONPAYS',
      {
        invoice_id: invoice.provider_invoice_id,
        order_id: invoice.provider_order_id,
        request_amount: 250000,
        final_amount: 250000,
        credit_amount: 250000,
        status: 'completed',
        paid: true,
        delivery_id: id,
        event: 'invoice.completed',
        occurred_at: 1727200000,
        api_version: 1,
      },
      id,
    );

  async function lateCompletionTraces(paymentId: string) {
    const [events] = await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM operational_events
           WHERE code = ${GATEWAY_LATE_COMPLETION_CODE} AND dedupe_key LIKE ${`%${paymentId}`}`,
    );
    const [outbox] = await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM outbox_messages
           WHERE event_type = 'PaymentLateCompletionObserved' AND aggregate_id = ${paymentId}`,
    );
    return { events: events!.n, outbox: outbox!.n };
  }

  /** Every scheduled inquiry due, and one pass. */
  const inquireNow = async () => {
    offsetMs += 6 * 60_000;
    return lane.runOnce(tenantA);
  };

  // =====================================================================================
  // Every rail: credited once, due at commit, sent within one short interval
  // =====================================================================================

  describe('per rail', () => {
    it('MANUAL_TRANSFER: an approved card-to-card receipt is credited once and its message sent promptly', async () => {
      await setSetting('wallet.topup.presets', [{ amountMinor: '500000', currency: 'IRT' }]);
      const k = key();
      const { payment } = await ctx.container.payments.requestWalletTopup(
        tenantA,
        systemActor(k),
        maryam,
        { idempotencyKey: k, amountMinor: 500_000n },
      );
      await ctx.container.payments.confirmManualTransfer(tenantA, owner, payment.id, {
        idempotencyKey: key(),
        note: 'seen in the statement',
      });
      const committedAt = Date.now();
      const confirmed = await expectCreditedOnceAndDueAtCommit(payment.id, 500_000n);

      const latency = await sentWithinPromptBound(committedAt);
      expect(latency, `sent ${String(latency)} ms after the credit`).toBeLessThanOrEqual(
        PROMPT_BOUND_MS,
      );
      expectFinalMessage(confirmed.reference, 500_000n);
    });

    it('TONPAYS: the inquiry’s approval credits once, and the message follows within one interval', async () => {
      const { paymentId } = await approvedTonPaysTopup();
      expect((await inquireNow()).settled).toBe(1);
      const committedAt = Date.now();
      const confirmed = await expectCreditedOnceAndDueAtCommit(paymentId, 250_000n);
      expect((await invoiceOf(paymentId)).outcome).toBe('SETTLED');

      const latency = await sentWithinPromptBound(committedAt);
      expect(latency, `sent ${String(latency)} ms after the credit`).toBeLessThanOrEqual(
        PROMPT_BOUND_MS,
      );
      expectFinalMessage(confirmed.reference, 250_000n);
    });

    it('NOWPAYMENTS: an approval credits once, and the message follows within one interval', async () => {
      await enable('NOWPAYMENTS');
      const paymentId = await gatewayTopup('NOWPAYMENTS', 1_035_000n);
      const result = await ctx.container.payments.confirmGatewayPayment(
        tenantA,
        systemActor(key()),
        paymentId,
        { evidenceNote: 'nowpayments:finished:paid' },
      );
      expect(result.outcome).toBe('SETTLED');
      const committedAt = Date.now();
      const confirmed = await expectCreditedOnceAndDueAtCommit(paymentId, 1_035_000n);
      const latency = await sentWithinPromptBound(committedAt);
      expect(latency).toBeLessThanOrEqual(PROMPT_BOUND_MS);
      expectFinalMessage(confirmed.reference, 1_035_000n);
    });

    it('CENTRALPAY: an approval naming its bound reference credits once, and the message follows promptly', async () => {
      await enable('CENTRALPAY');
      const paymentId = await gatewayTopup('CENTRALPAY', 150_000n);
      // The reference the lane binds to this attempt before it calls the settlement path.
      await ctx.container.database.db.execute(
        sql`UPDATE gateway_invoices SET provider_charge_id = 'cp-ref-fix03' WHERE payment_id = ${paymentId}`,
      );
      const result = await ctx.container.payments.confirmGatewayPayment(
        tenantA,
        systemActor(key()),
        paymentId,
        { evidenceNote: 'centralpay:verified:paid', providerReference: 'cp-ref-fix03' },
      );
      expect(result.outcome).toBe('SETTLED');
      const committedAt = Date.now();
      const confirmed = await expectCreditedOnceAndDueAtCommit(paymentId, 150_000n);
      const latency = await sentWithinPromptBound(committedAt);
      expect(latency).toBeLessThanOrEqual(PROMPT_BOUND_MS);
      expectFinalMessage(confirmed.reference, 150_000n);
    });

    it('TELEGRAM_STARS: a recorded successful_payment credits once, and the message follows promptly', async () => {
      await enable('TELEGRAM_STARS');
      const paymentId = await gatewayTopup('TELEGRAM_STARS', 100_000n);
      await ctx.container.uow.run(tenantA, (tx) =>
        new DrizzleGatewayInvoiceRepository(ctx.container.database.db).recordCharge(
          tenantA,
          paymentId,
          { chargeId: 'stars-charge-fix03', status: 'successful_payment', dueAt: new Date() },
          new Date(),
          tx,
        ),
      );
      expect(await ctx.container.gatewayPayments.settleRecorded(tenantA, paymentId)).toBe(
        'SETTLED',
      );
      const committedAt = Date.now();
      const confirmed = await expectCreditedOnceAndDueAtCommit(paymentId, 100_000n);
      const latency = await sentWithinPromptBound(committedAt);
      expect(latency).toBeLessThanOrEqual(PROMPT_BOUND_MS);
      expectFinalMessage(confirmed.reference, 100_000n);
      // A redelivered update settles nothing again and queues nothing again.
      expect(await ctx.container.gatewayPayments.settleRecorded(tenantA, paymentId)).toBe(
        'SETTLED',
      );
      expect(await ledger(paymentId)).toHaveLength(1);
      expect(await notifications(paymentId)).toHaveLength(1);
    });

    it('TELEGRAM_STARS: a refused settlement opens its alarm, and the later settlement closes it (audit P2-b on #260)', async () => {
      await enable('TELEGRAM_STARS');
      const paymentId = await gatewayTopup('TELEGRAM_STARS', 100_000n);
      await ctx.container.uow.run(tenantA, (tx) =>
        new DrizzleGatewayInvoiceRepository(ctx.container.database.db).recordCharge(
          tenantA,
          paymentId,
          { chargeId: 'stars-charge-p2b', status: 'successful_payment', dueAt: new Date() },
          new Date(),
          tx,
        ),
      );
      const refusing = new Proxy(ctx.container.payments, {
        get: (target, property, receiver) =>
          property === 'confirmGatewayPayment'
            ? () => Promise.reject(new Error('scope stopped accepting work'))
            : (Reflect.get(target, property, receiver) as unknown),
      });
      const alarms = () =>
        rows<{ code: string; resolved_at: Date | null }>(
          sql`SELECT code, resolved_at FROM operational_events
              WHERE tenant_id = ${tenantA.tenantId}
                AND code IN ('payments.gateway_settlement_failed', 'payments.gateway_settlement_decided')
              ORDER BY first_seen_at, id`,
        );
      expect(await laneWith(refusing).settleRecorded(tenantA, paymentId)).toBe('ERROR');
      expect(await alarms()).toEqual([
        { code: 'payments.gateway_settlement_failed', resolved_at: null },
      ]);
      expect(await laneWith().settleRecorded(tenantA, paymentId)).toBe('SETTLED');
      const after = await alarms();
      expect(after.map((row) => row.code)).toEqual([
        'payments.gateway_settlement_failed',
        'payments.gateway_settlement_decided',
      ]);
      expect(after[0]!.resolved_at).not.toBeNull();
      expect(await ledger(paymentId)).toHaveLength(1);
    });
  });

  // =====================================================================================
  // Races, repeats and crashes: still one credit and one message
  // =====================================================================================

  describe('exactly once', () => {
    it('two concurrent settlements and two concurrent dispatch passes: one credit, one message', async () => {
      const { paymentId } = await approvedTonPaysTopup();
      const results = await Promise.all([
        ctx.container.payments.confirmGatewayPayment(tenantA, systemActor('race-1'), paymentId, {
          evidenceNote: 'tonpays:completed:paid',
        }),
        ctx.container.payments.confirmGatewayPayment(tenantA, systemActor('race-2'), paymentId, {
          evidenceNote: 'tonpays:completed:paid',
        }),
      ]);
      expect(results.map((r) => r.outcome).sort()).toEqual(['ALREADY_CONFIRMED', 'SETTLED']);
      await expectCreditedOnceAndDueAtCommit(paymentId, 250_000n);
      // Two worker replicas, one pass each, at the same moment.
      await Promise.all([sweep(), sweep()]);
      expect(sends).toHaveLength(1);
      expect((await notifications(paymentId))[0]!.state).toBe('DELIVERED');
    });

    it('a webhook and the poll, duplicated and out of order: one credit, one message', async () => {
      const { paymentId, invoice } = await approvedTonPaysTopup();
      // The hint arrives first, twice; it decides nothing and only brings the inquiry forward.
      expect(await webhook(invoice, 'd-1')).toBe('SCHEDULED');
      await webhook(invoice, 'd-1');
      expect((await paymentRow(paymentId)).state).toBe('PENDING');
      // Two replicas run the brought-forward inquiry at once, then a late webhook arrives.
      offsetMs += 6_000;
      const other = laneWith();
      await Promise.all([lane.runOnce(tenantA), other.runOnce(tenantA)]);
      await webhook(invoice, 'd-late');
      await inquireNow();
      await expectCreditedOnceAndDueAtCommit(paymentId, 250_000n);
      await sweep();
      await sweep();
      expect(sends).toHaveLength(1);
    });

    it('a crash between the credit and the lane’s outcome record: the next pass credits nothing more', async () => {
      const { paymentId } = await approvedTonPaysTopup();
      // The settlement commits, and the process dies before the lane records its outcome.
      const payments = ctx.container.payments;
      const dying = laneWith({
        recordProviderReview: (...args) => payments.recordProviderReview(...args),
        recordProviderFundsDetected: (...args) => payments.recordProviderFundsDetected(...args),
        failGatewayPayment: (...args) => payments.failGatewayPayment(...args),
        confirmGatewayPayment: async (...args) => {
          await payments.confirmGatewayPayment(...args);
          throw new Error('process died after the commit');
        },
      });
      offsetMs += 6 * 60_000;
      await dying.runOnce(tenantA);
      expect((await invoiceOf(paymentId)).outcome, 'no outcome recorded').toBeNull();
      await expectCreditedOnceAndDueAtCommit(paymentId, 250_000n);
      // The restarted worker asks again: ALREADY_CONFIRMED, recorded, nothing moves twice.
      await inquireNow();
      expect((await invoiceOf(paymentId)).outcome).toBe('ALREADY_SETTLED');
      await expectCreditedOnceAndDueAtCommit(paymentId, 250_000n);
      // Not a late completion: no alarm, no late-approval log for money credited once.
      expect(await lateCompletionTraces(paymentId)).toEqual({ events: 0, outbox: 0 });
      await sweep();
      expect(sends).toHaveLength(1);
    });

    it('a crash after the commit and before any dispatch: the restarted lane sends it once', async () => {
      const { paymentId } = await approvedTonPaysTopup();
      await inquireNow();
      // No pass ran in the dead worker; a fresh dispatcher (the restarted one) finds it due.
      await sweep(dispatcher());
      await sweep(dispatcher());
      expect(sends).toHaveLength(1);
      expect((await notifications(paymentId))[0]!.state).toBe('DELIVERED');
    });

    it('a crash after the send stamp: the message may have arrived, so it is never sent again', async () => {
      const { paymentId } = await approvedTonPaysTopup();
      await inquireNow();
      // The dying pass stamped the send and its lease ran out with no outcome recorded.
      await ctx.container.database.db.execute(
        sql`UPDATE customer_notifications
               SET send_started_at = now() - interval '10 minutes',
                   next_attempt_at = now() - interval '1 minute'
             WHERE subject_id = ${paymentId}`,
      );
      await sweep();
      await sweep();
      expect(sends, 'an unknown send was repeated').toHaveLength(0);
      expect((await notifications(paymentId))[0]!.state).toBe('UNCONFIRMED');
      expect(await ledger(paymentId)).toHaveLength(1);
    });
  });

  // =====================================================================================
  // Unknown and refused: never success, never a second message
  // =====================================================================================

  describe('unknown outcomes and rate limits', () => {
    it('a gateway UNKNOWN (the inquiry’s answer was lost) credits nothing and says nothing', async () => {
      const { paymentId } = await approvedTonPaysTopup();
      tonpays.checkLost = true;
      const report = await inquireNow();
      expect(report.settled).toBe(0);
      expect(tonpays.checks).toBeGreaterThan(0);
      expect((await paymentRow(paymentId)).state).toBe('PENDING');
      expect(await ledger(paymentId)).toEqual([]);
      expect(await notifications(paymentId)).toEqual([]);
      await sweep();
      expect(sends).toHaveLength(0);
    });

    it('a late approval, past the attempt’s deadline, credits nothing and announces no credit', async () => {
      const { paymentId } = await approvedTonPaysTopup();
      await ctx.container.database.db.execute(
        sql`UPDATE payments SET expires_at = now() - interval '1 second' WHERE id = ${paymentId}`,
      );
      await inquireNow();
      expect(await ledger(paymentId)).toEqual([]);
      expect((await notifications(paymentId)).map((row) => row.kind)).not.toContain(
        'WALLET_TOPUP_CREDITED',
      );
      // The counterpart of the crash case: a real late approval IS recorded and raised.
      expect((await invoiceOf(paymentId)).outcome).toBe('LATE_COMPLETION');
      expect(await lateCompletionTraces(paymentId)).toEqual({ events: 1, outbox: 1 });
    });

    it('a Telegram send whose outcome is unknown is never repeated, and the credit stands once', async () => {
      const { paymentId } = await approvedTonPaysTopup();
      await inquireNow();
      outcomes = [{ outcome: 'UNKNOWN' }];
      await sweep();
      await sweep();
      expect(sends).toHaveLength(1);
      expect((await notifications(paymentId))[0]!.state).toBe('UNCONFIRMED');
      expect(await ledger(paymentId)).toHaveLength(1);
    });

    it('a 429 is honoured at Telegram’s time, spends no attempt, sends once — and the wait is reported', async () => {
      const { paymentId } = await approvedTonPaysTopup();
      await inquireNow();
      outcomes = [{ outcome: 'RATE_LIMITED', retryAfterMs: 1_000 }];
      await sweep();
      const [held] = await notifications(paymentId);
      expect(held!.state).toBe('PENDING');
      expect(held!.attempts).toBe(0);
      // WP20: the later of retry_after and the lane's own back-off. An EXTERNAL delay.
      expect(new Date(held!.next_attempt_at!).getTime()).toBeGreaterThan(Date.now() + 30_000);
      await sweep();
      expect(sends, 'a rate-limited message was retried before its time').toHaveLength(1);

      // Telegram's time arrives: the row is sent once, and the wait it cost is a warning.
      await ctx.container.database.db.execute(
        sql`UPDATE customer_notifications
               SET next_attempt_at = now() - interval '1 second',
                   created_at = now() - interval '61 seconds'
             WHERE subject_id = ${paymentId}`,
      );
      await sweep();
      expect(sends).toHaveLength(2);
      expect((await notifications(paymentId))[0]!.state).toBe('DELIVERED');
      const slow = logs.filter((line) => line.level === 'warn');
      expect(slow).toHaveLength(1);
      expect(slow[0]!.context).toMatchObject({
        kind: 'WALLET_TOPUP_CREDITED',
        subjectId: paymentId,
        outcome: 'DELIVERED',
        thresholdMs: CUSTOMER_NOTIFICATION_LATENCY_WARN_MS,
      });
      expect(Number(slow[0]!.context.queuedMs)).toBeGreaterThan(60_000);
    });

    it('logs the breakdown of a prompt send at info, with no warning', async () => {
      await approvedTonPaysTopup();
      await inquireNow();
      await sweep();
      const lines = logs.filter((line) => line.message === 'customer notification latency');
      expect(lines).toHaveLength(1);
      expect(lines[0]!.context).toMatchObject({
        kind: 'WALLET_TOPUP_CREDITED',
        outcome: 'DELIVERED',
      });
      expect(Number(lines[0]!.context.queuedMs)).toBeLessThan(
        CUSTOMER_NOTIFICATION_LATENCY_WARN_MS,
      );
      expect(logs.filter((line) => line.level === 'warn')).toEqual([]);
    });
    it('counts a renewal’s slow screen-closing as pre-send work, never as the Telegram call (Codex #252)', async () => {
      // A renewal result closes its order's payment screens first: Telegram `clearButtons`
      // calls, made after the send stamp and before the send itself. Here they take 400 ms.
      const operationId = ctx.container.ids.uuid();
      await ctx.container.uow.run(tenantA, (tx) =>
        ctx.container.customerNotifications.enqueue(
          tenantA,
          {
            id: ctx.container.ids.uuid(),
            customerId: maryam,
            botInstanceId: BOT_A,
            kind: 'SERVICE_RENEWED',
            subjectId: operationId,
          },
          ctx.container.clock.now(),
          tx,
        ),
      );
      let closed = 0;
      await sweep(
        dispatcher({
          renewals: {
            notificationFacts: async () => ({
              values: {},
              serviceId: ctx.container.ids.uuid(),
              orderId: ctx.container.ids.uuid(),
            }),
          },
          orderScreens: {
            close: async () => {
              closed += 1;
              await new Promise((resolve) => setTimeout(resolve, 400));
            },
          },
        }),
      );
      expect(closed).toBe(1);
      expect(sends).toHaveLength(1);
      const [line] = logs.filter(
        (one) =>
          one.message === 'customer notification latency' && one.context.kind === 'SERVICE_RENEWED',
      );
      expect(line, 'no latency line for the renewal').toBeDefined();
      // The fake Telegram answers at once: the call itself is near zero, the closing is not.
      expect(
        Number(line!.context.sendMs),
        'screen-closing counted as the Telegram call',
      ).toBeLessThan(200);
      expect(Number(line!.context.preSendMs)).toBeGreaterThanOrEqual(390);
    });
  });
});
