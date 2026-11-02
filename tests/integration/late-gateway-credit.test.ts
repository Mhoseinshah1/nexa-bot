import { createServer, type Server } from 'node:http';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  isNexaError,
  money,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type PanelId,
  type PaymentGatewayConfig,
  type PaymentGatewayProvider,
  type PaymentId,
  type ProductCategoryId,
  type ProductId,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { DrizzleCustomerRepository } from '../../apps/api/src/modules/commerce/customers/infrastructure/drizzle-customer.repository';
import { DrizzlePaymentRepository } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-payment.repository';
import { DrizzleGatewayInvoiceRepository } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-gateway-invoice.repository';
import {
  DrizzleGatewayCallBudget,
  DrizzleGatewayCredentialStore,
  DrizzlePublicOriginReader,
} from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-gateway-credentials';
import {
  TonPaysAdapter,
  type FetchLike,
} from '../../apps/api/src/modules/commerce/payments/infrastructure/tonpays-adapter';
import {
  GatewayPaymentService,
  gatewayCallbackUrl,
} from '../../apps/api/src/modules/commerce/payments/application/gateway-payment.service';
import { gatewayAttemptScreen } from '../../apps/api/src/surfaces/telegram/bot-runtime';
import { settingsLateCreditPolicy } from '../../apps/api/src/modules/commerce/payments/application/late-credit-policy';
import { CustomerNotificationService } from '../../apps/api/src/modules/commerce/messaging/application/customer-notification.service';
import { DrizzleWalletRepository } from '../../apps/api/src/modules/commerce/wallet/infrastructure/drizzle-wallet.repository';
import { DrizzleServiceReminderSnapshotReader } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service-reminder.repository';
import { DrizzleOperationalConditionReader } from '../../apps/api/src/modules/platform/opslog/infrastructure/drizzle-operational-event.reader';
import { startFakeMarzban, type FakeMarzban } from '../support/fake-marzban';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  validatePanelConnection,
  SEED_IDS,
  tenantA,
  type TestContext,
} from './harness';

/**
 * R5A item 4 — a gateway's LATE approval, credited to the customer's wallet.
 *
 * Built the way `tonpays-gateway.test.ts` is: the container's own services decide
 * everything, the gateway lane is built here over the container's database with the REAL
 * `TonPaysAdapter` whose `fetch` is a recording fake TonPays, and only the lane's clock moves.
 * The lane is given the late-credit collaborator exactly as the container gives it to the
 * production lane; the settings are the registry's, read from the database.
 *
 * What each case holds, and what reverting it breaks, is named in the report of the change.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const MARYAM = '910910';
const API_KEY = 'tp_live_KEY_that_must_never_leak_71c0de';
const SWITCH = 'payments.late_credit.tonpays_enabled';
const WINDOW = 'payments.late_credit.window_hours';

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
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

interface FakeInvoice {
  readonly invoiceId: string;
  readonly orderId: string;
  readonly amount: number;
  /** What the provider says it was asked for; defaults to the real amount. */
  requestAmount: number | null;
  status: string;
  paid: unknown;
}

/** The documented TonPays request and response shapes, and nothing more. */
class FakeTonPays {
  readonly invoices = new Map<string, FakeInvoice>();
  readonly checks: string[] = [];
  private seq = 0;

  readonly fetch: FetchLike = async (url, init) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    if (url.endsWith('/api/v1/invoices/create')) {
      this.seq += 1;
      const invoiceId = `TP-${String(this.seq).padStart(8, '0')}`;
      const invoice: FakeInvoice = {
        invoiceId,
        orderId: String(body.order_id),
        amount: Number(body.amount),
        requestAmount: Number(body.amount),
        status: 'pending',
        paid: false,
      };
      this.invoices.set(invoiceId, invoice);
      return json(201, {
        invoice_id: invoiceId,
        order_id: invoice.orderId,
        request_amount: invoice.amount,
        final_amount: invoice.amount + 37,
        status: 'pending',
        invoice_url: `https://t.me/TonPaysInvoiceBot?start=inv_${invoiceId}`,
        web_invoice_url: `https://pay.tonpays.online/i/${invoiceId}?p=xyz`,
        callback_url: body.callback_url,
      });
    }
    if (url.endsWith('/api/v1/invoices/check')) {
      const invoiceId = String(body.invoice_id);
      this.checks.push(invoiceId);
      const invoice = this.invoices.get(invoiceId);
      if (invoice === undefined) {
        return json(404, { detail: { code: 'INVOICE_NOT_FOUND', message: 'x' } });
      }
      return json(200, {
        invoice_id: invoice.invoiceId,
        order_id: invoice.orderId,
        ...(invoice.requestAmount === null ? {} : { request_amount: invoice.requestAmount }),
        final_amount: invoice.amount + 37,
        status: invoice.status,
        paid: invoice.paid,
      });
    }
    return json(404, { detail: { code: 'NOT_FOUND', message: 'x' } });
  };

  set(invoiceId: string, status: string, paid: unknown): void {
    const invoice = this.invoices.get(invoiceId);
    if (invoice === undefined) throw new Error(`no fake invoice ${invoiceId}`);
    invoice.status = status;
    invoice.paid = paid;
  }

  setRequestAmount(invoiceId: string, amount: number | null): void {
    const invoice = this.invoices.get(invoiceId);
    if (invoice === undefined) throw new Error(`no fake invoice ${invoiceId}`);
    invoice.requestAmount = amount;
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('a late gateway approval, credited to the wallet', () => {
  let ctx: TestContext;
  let telegram: Server;
  let panel: FakeMarzban;
  let products: DrizzleProductRepository;
  let panelId: string;
  let owner: ActorContext;
  let maryam: UserId;
  let tonpays: FakeTonPays;
  let lane: GatewayPaymentService;
  let offsetMs: number;
  let updateSeq = 0;
  let settingSeq = 0;
  /** What the customer's notification lane handed to Telegram. */
  const sends: { templateKey: string; values: Record<string, unknown> }[] = [];

  beforeAll(async () => {
    telegram = createServer((request, response) => {
      request.on('data', () => undefined);
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, result: { message_id: 11 } }));
      });
    });
    await new Promise<void>((resolve) => telegram.listen(0, '127.0.0.1', resolve));
    const address = telegram.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    ctx = await createTestContext({
      PANEL_HTTP_ALLOW_LOOPBACK: 'true',
      TELEGRAM_API_BASE_URL: `http://127.0.0.1:${String(address.port)}`,
    });
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
    await new Promise<void>((resolve) => telegram.close(() => resolve()));
  });

  afterEach(async () => {
    await panel?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    ctx.container.setInstallationTenant(tenantA.tenantId);
    products = new DrizzleProductRepository(ctx.container.database.db);
    panel = await startFakeMarzban({ host: '127.0.0.2' });
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-lc', roleKeys: ['owner'] }),
    );
    const created = await ctx.container.panels.create(tenantA, owner, {
      name: 'Marzban A',
      providerType: 'marzban',
      baseUrl: panel.baseUrl,
      credentials: { username: panel.username, password: panel.password },
      activation: { proxyProtocols: ['vless'], inboundTags: { vless: ['VLESS TCP'] } },
      idempotencyKey: 'panel-lc-create',
    });
    panelId = created.view.panel.id;
    await validatePanelConnection(ctx.container, tenantA, panelId);
    maryam = (
      await ctx.container.customers.resolveFromUpdate(tenantA, systemActor('resolve-m'), {
        idempotencyKey: 'resolve-m',
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
    offsetMs = 0;
    sends.length = 0;
    lane = laneWith(tonpays);
  });

  /** The production lane's wiring: the same policy reader and the same credit path. */
  function laneWith(
    fake: FakeTonPays,
    withLateCredit = true,
    invoiceScreens?: { refresh(scope: TenantContext, paymentId: string): Promise<void> },
  ): GatewayPaymentService {
    const db = ctx.container.database.db;
    const adapter = new TonPaysAdapter({ fetch: fake.fetch });
    const origins = new DrizzlePublicOriginReader(db);
    return new GatewayPaymentService({
      invoices: new DrizzleGatewayInvoiceRepository(db),
      payments: ctx.container.payments,
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
      ...(invoiceScreens === undefined ? {} : { invoiceScreens }),
      ...(withLateCredit
        ? {
            lateCredit: {
              policyFor: settingsLateCreditPolicy(ctx.container.settingsResolver),
              credit: (scope, actor, id, input) =>
                ctx.container.payments.creditLateGatewayApproval(scope, actor, id, input),
            },
          }
        : {}),
    });
  }

  // -------------------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------------------

  async function setSetting(key: string, value: unknown) {
    settingSeq += 1;
    const current = (await ctx.container.settingsService.list(tenantA, owner)).find(
      (row) => row.key === key,
    );
    await ctx.container.settingsService.set(tenantA, owner, {
      key,
      value,
      expectedVersion: current?.version ?? null,
      idempotencyKey: `lc-setting-${String(settingSeq)}`,
    });
  }

  async function enableTonPays(config: Partial<PaymentGatewayConfig> = {}) {
    await ctx.container.paymentGateways.configure(tenantA, owner, {
      idempotencyKey: 'tp-cfg',
      provider: 'TONPAYS',
      config: { ...OPEN_ROUTE, ...config },
    });
    await ctx.container.paymentGateways.setCredential(tenantA, owner, {
      idempotencyKey: 'tp-cred',
      provider: 'TONPAYS',
      apiKey: API_KEY,
    });
    await ctx.container.paymentGateways.setStatus(tenantA, owner, {
      idempotencyKey: 'tp-on',
      provider: 'TONPAYS',
      status: 'ACTIVE',
    });
  }

  async function product(priceMinor = 250_000n): Promise<ProductId> {
    const row = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن تست',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: panelId as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: null },
        price: money(priceMinor, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, row.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    return row.id;
  }

  const tap = (data: string) => {
    updateSeq += 1;
    return ctx.container.botRuntime.handle(tenantA, systemActor('bot'), {
      idempotencyKey: `lc-update-${String(updateSeq)}`,
      botInstanceId: BOT_A,
      update: {
        update_id: updateSeq,
        callback_query: {
          id: `cbq-${String(updateSeq)}`,
          from: { id: Number(MARYAM), first_name: 'مریم', is_bot: false },
          data,
          message: {
            message_id: updateSeq,
            date: 0,
            chat: { id: Number(MARYAM), type: 'private' },
            from: { id: 999999, is_bot: true, first_name: 'Nexa' },
          },
        },
      },
      telegramUserId: MARYAM,
      from: { id: Number(MARYAM), first_name: 'مریم' },
    });
  };

  async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
    return (await ctx.container.database.db.execute(query)).rows as T[];
  }

  async function draftOrder(priceMinor = 250_000n): Promise<string> {
    const productId = await product(priceMinor);
    await tap(`p:${productId}`);
    const [draft] = await rows<{ id: string }>(
      sql`SELECT id FROM orders WHERE tenant_id = ${tenantA.tenantId} AND customer_id = ${maryam}
          ORDER BY created_at DESC LIMIT 1`,
    );
    if (draft === undefined) throw new Error('no draft');
    await tap(`Z:${draft.id}`);
    return draft.id;
  }

  async function payWithGateway(orderId: string): Promise<{ paymentId: PaymentId }> {
    await tap(`g:${orderId}`);
    const [payment] = await rows<{ id: string }>(
      sql`SELECT id FROM payments WHERE tenant_id = ${tenantA.tenantId} AND order_id = ${orderId}
          AND method = 'GATEWAY' ORDER BY created_at DESC LIMIT 1`,
    );
    if (payment === undefined) throw new Error('no gateway payment');
    return { paymentId: payment.id as PaymentId };
  }

  const pass = () => lane.runOnce(tenantA);

  async function invoiceOf(paymentId: string) {
    const [row] = await rows<{
      provider_order_id: string;
      provider_invoice_id: string | null;
      outcome: string | null;
      late_completion_observed_at: Date | null;
      next_inquiry_at: Date | null;
      last_inquiry_at: Date | null;
      post_deadline_inquiries: number;
      inquiry_attempts: number;
    }>(sql`SELECT * FROM gateway_invoices WHERE payment_id = ${paymentId}`);
    if (row === undefined) throw new Error('no invoice row');
    return row;
  }

  async function paymentOf(paymentId: string) {
    const [row] = await rows<{ state: string; reference: string; code: string | null }>(
      sql`SELECT state, reference, code FROM payments WHERE id = ${paymentId}`,
    );
    if (row === undefined) throw new Error('no payment');
    return row;
  }

  const orderState = async (orderId: string) =>
    (await rows<{ state: string }>(sql`SELECT state FROM orders WHERE id = ${orderId}`))[0]?.state;

  const ledgerOf = (paymentId: string) =>
    rows<{
      reason: string;
      direction: string;
      amount: string;
      reference: string;
      order_id: string | null;
      payment_id: string | null;
      customer_id: string;
    }>(
      sql`SELECT reason, direction, amount::text AS amount, reference, order_id, payment_id, customer_id
            FROM wallet_entries WHERE tenant_id = ${tenantA.tenantId} AND payment_id = ${paymentId}
           ORDER BY created_at, reason`,
    );

  const walletTotal = async () => {
    const balance = await new DrizzleWalletRepository(ctx.container.database.db).balanceOf(
      tenantA,
      maryam,
      'IRT',
    );
    return balance.amountMinor;
  };

  /** What the customer was told about this payment, other than that it expired. */
  const notices = (paymentId: string) =>
    rows<{ kind: string }>(
      sql`SELECT kind FROM customer_notifications WHERE tenant_id = ${tenantA.tenantId}
           AND subject_id = ${paymentId} AND kind <> 'PAYMENT_EXPIRED' ORDER BY created_at, kind`,
    );

  const openCodes = async () =>
    (
      await rows<{ code: string }>(
        sql`SELECT code FROM operational_events WHERE tenant_id = ${tenantA.tenantId}`,
      )
    ).map((row) => row.code);

  const outboxCount = async (eventType: string, aggregateId: string) =>
    (
      await rows<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM outbox_messages
             WHERE event_type = ${eventType} AND aggregate_id = ${aggregateId}`,
      )
    )[0]!.n;

  const serviceCount = async () =>
    (
      await rows<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM services WHERE tenant_id = ${tenantA.tenantId}`,
      )
    )[0]!.n;

  const webhook = (
    invoice: { provider_order_id: string; provider_invoice_id: string | null },
    status: string,
    deliveryId: string,
  ) =>
    lane.receiveWebhook(
      String(tenantA.tenantId),
      'TONPAYS',
      {
        invoice_id: invoice.provider_invoice_id,
        order_id: invoice.provider_order_id,
        request_amount: 250000,
        final_amount: 250037,
        credit_amount: 250037,
        status,
        paid: status === 'completed',
        delivery_id: deliveryId,
        event: `invoice.${status}`,
        occurred_at: 1727200000,
        api_version: 1,
      },
      deliveryId,
    );

  /** A created attempt for a fresh order. */
  async function createdAttempt(priceMinor = 250_000n) {
    await enableTonPays();
    const orderId = await draftOrder(priceMinor);
    const { paymentId } = await payWithGateway(orderId);
    await pass();
    const invoice = await invoiceOf(paymentId);
    if (invoice.provider_invoice_id === null) throw new Error('not created');
    return { orderId, paymentId, invoice, invoiceId: invoice.provider_invoice_id };
  }

  /** The attempt's deadline passed, as the database sees it; the sweep has not run. */
  const pastDeadline = (paymentId: string) =>
    ctx.container.database.db.execute(
      sql`UPDATE payments SET expires_at = now() - interval '1 second' WHERE id = ${paymentId}`,
    );

  /** The customer's notification lane, with a recording messenger and the production readers. */
  function dispatcher(): CustomerNotificationService {
    const db = ctx.container.database.db;
    const wallet = new DrizzleWalletRepository(db);
    const payments = new DrizzlePaymentRepository(db);
    const people = new DrizzleCustomerRepository(db);
    return new CustomerNotificationService({
      notifications: ctx.container.customerNotifications,
      refundFigures: wallet,
      paymentCredits: wallet,
      walletBalances: {
        balanceNow: async (scope, customerId, currency) => {
          const balance = await wallet.balanceOf(scope, customerId, currency);
          return money(balance.amountMinor, balance.currency);
        },
      },
      rejectionReasons: payments,
      paymentReferences: payments,
      reminderSnapshots: new DrizzleServiceReminderSnapshotReader(db),
      contacts: {
        contactFor: async (scope, customerId, tx) => {
          const found = await people.findById(scope, customerId, tx);
          if (found === null) return { kind: 'NONE' };
          return { kind: 'CONTACT', contact: { chatId: found.telegramUserId } };
        },
      },
      subjects: { stillHolds: async () => true },
      messenger: {
        send: async (_scope, message) => {
          sends.push({ templateKey: message.templateKey, values: { ...message.values } });
          return { outcome: 'DELIVERED' };
        },
        acknowledge: async () => undefined,
        sendFile: async () => ({ outcome: 'REFUSED' }),
      },
      uow: ctx.container.uow,
      clock: ctx.container.clock,
      scopeIsActive: async () => true,
      logger: { info: () => undefined, error: () => undefined, warn: () => undefined },
    });
  }

  // =====================================================================================

  it('credits an approval that arrives after the deadline to the wallet ONCE: the order is not reopened, no service is built, the customer is told', async () => {
    const { orderId, paymentId, invoice, invoiceId } = await createdAttempt();
    await pastDeadline(paymentId);
    tonpays.set(invoiceId, 'completed', true);
    await webhook(invoice, 'completed', 'late-1');
    offsetMs += 6_000;
    const report = await pass();
    expect(report.lateCredits).toBe(1);
    expect(report.lateCompletions).toBe(0);

    // The wallet holds the payment's amount, under the payment, never the order.
    const entries = await ledgerOf(paymentId);
    expect(entries).toEqual([
      {
        reason: 'GATEWAY_LATE_CREDIT',
        direction: 'CREDIT',
        amount: '250000',
        reference: `${paymentId}:late-credit`,
        order_id: null,
        payment_id: paymentId,
        customer_id: maryam,
      },
    ]);
    expect(await walletTotal()).toBe(250_000n);

    // Nothing was settled or built: the payment and the order are as they were.
    expect((await paymentOf(paymentId)).state).toBe('PENDING');
    expect(await orderState(orderId)).toBe('AWAITING_PAYMENT');
    expect(await serviceCount()).toBe(0);
    // The sweep closes the payment as it always does, and it stays closed.
    await ctx.container.paymentExpirySweep.runOnce(tenantA);
    expect((await paymentOf(paymentId)).state).toBe('EXPIRED');
    expect(await orderState(orderId)).not.toBe('PAID');

    // Recorded on the invoice (not as a late completion an operator must decide), with the
    // domain events and the audit row written in the same transaction.
    const after = await invoiceOf(paymentId);
    expect(after.outcome).toBe('LATE_CREDITED');
    expect(after.late_completion_observed_at).toBeNull();
    expect(after.next_inquiry_at).toBeNull();
    expect(await openCodes()).not.toContain('payments.gateway_late_completion');
    expect(await outboxCount('PaymentLateCredited', paymentId)).toBe(1);
    expect(await outboxCount('PaymentLateCompletionObserved', paymentId)).toBe(0);
    const audit = await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM audit_logs
           WHERE entity_id = ${paymentId} AND action = 'payment.gateway_late_credit'`,
    );
    expect(audit[0]!.n).toBe(1);

    // The customer is told once, with the amount and the balance now.
    expect((await notices(paymentId)).map((row) => row.kind)).toEqual([
      'GATEWAY_LATE_PAYMENT_CREDITED',
    ]);
    await dispatcher().deliverDue(tenantA, 50);
    // (The sweep's own «پرداخت منقضی شد» went out as well; the late credit's is the one under test.)
    const told = sends.filter((send) => send.templateKey === 'bot.payment.gateway_late_credited');
    expect(told).toHaveLength(1);
    expect(told[0]!.values).toMatchObject({
      amount: money(250_000n, 'IRT'),
      balance: money(250_000n, 'IRT'),
    });
  });

  it('credits ONCE however often the approval is seen: a duplicate webhook, repeated inquiries, two concurrent credits', async () => {
    const { orderId, paymentId, invoice, invoiceId } = await createdAttempt();
    await pastDeadline(paymentId);
    tonpays.set(invoiceId, 'completed', true);
    await webhook(invoice, 'completed', 'dup-1');
    await webhook(invoice, 'completed', 'dup-1');
    await webhook(invoice, 'completed', 'dup-2');
    for (let round = 0; round < 3; round += 1) {
      offsetMs += 6 * 60_000;
      await pass();
    }
    await ctx.container.paymentExpirySweep.runOnce(tenantA);
    await webhook(invoice, 'completed', 'dup-3');
    offsetMs += 6 * 60_000;
    await pass();

    // Two callers racing on two connections, as two replicas would.
    const credit = () =>
      ctx.container.payments.creditLateGatewayApproval(tenantA, systemActor('race'), paymentId, {
        providerRequestAmount: 250_000n,
        evidenceNote: null,
      });
    const raced = await Promise.all([credit(), credit()]);
    expect(raced.map((one) => one.outcome)).toEqual(['CREDITED', 'CREDITED']);
    expect(raced.filter((one) => one.outcome === 'CREDITED' && one.credited)).toHaveLength(0);

    expect(
      (await ledgerOf(paymentId)).filter((e) => e.reason === 'GATEWAY_LATE_CREDIT'),
    ).toHaveLength(1);
    expect(await walletTotal()).toBe(250_000n);
    expect(await notices(paymentId)).toHaveLength(1);
    expect(await outboxCount('PaymentLateCredited', paymentId)).toBe(1);
    expect(await outboxCount('WalletEntryRecorded', maryam)).toBe(1);
    expect(await orderState(orderId)).toBe('AWAITING_PAYMENT');
  });

  it('two concurrent first credits write ONE entry, whichever transaction wins', async () => {
    const { paymentId, invoiceId } = await createdAttempt();
    await pastDeadline(paymentId);
    tonpays.set(invoiceId, 'completed', true);
    // The inquiry that records the approval, without the credit (a lane with none wired).
    const bare = laneWith(tonpays, false);
    offsetMs += 6 * 60_000;
    await bare.runOnce(tenantA);
    const credit = () =>
      ctx.container.payments.creditLateGatewayApproval(tenantA, systemActor('race'), paymentId, {
        providerRequestAmount: 250_000n,
        evidenceNote: null,
      });
    const raced = await Promise.all([credit(), credit(), credit()]);
    expect(raced.every((one) => one.outcome === 'CREDITED')).toBe(true);
    // Exactly one of them wrote it.
    expect(raced.filter((one) => one.outcome === 'CREDITED' && one.credited)).toHaveLength(1);
    expect(await ledgerOf(paymentId)).toHaveLength(1);
    expect(await walletTotal()).toBe(250_000n);
  });

  it('re-verifies: a webhook alone never credits, and neither does an inquiry that is not an approval', async () => {
    const { paymentId, invoice, invoiceId } = await createdAttempt();
    await pastDeadline(paymentId);
    // The webhook says completed and paid; the provider's own inquiry still says pending.
    await webhook(invoice, 'completed', 'liar-1');
    offsetMs += 6_000;
    await pass();
    expect(await ledgerOf(paymentId)).toEqual([]);
    // completed but not paid is not an approval either.
    tonpays.set(invoiceId, 'completed', false);
    offsetMs += 6 * 60_000;
    await pass();
    expect(await ledgerOf(paymentId)).toEqual([]);
    expect((await invoiceOf(paymentId)).outcome).toBeNull();

    // And the credit path itself refuses a payment whose recorded answer is no approval.
    const refused = await ctx.container.payments.creditLateGatewayApproval(
      tenantA,
      systemActor('direct'),
      paymentId,
      { providerRequestAmount: 250_000n, evidenceNote: null },
    );
    expect(refused).toMatchObject({ outcome: 'NOT_ELIGIBLE', reason: 'APPROVAL_NOT_VERIFIED' });
    expect(await ledgerOf(paymentId)).toEqual([]);
    expect(await walletTotal()).toBe(0n);
  });

  it('with the setting OFF nothing is credited: the approval is a late completion, exactly as before', async () => {
    await setSetting(SWITCH, false);
    const { orderId, paymentId, invoice, invoiceId } = await createdAttempt();
    await pastDeadline(paymentId);
    tonpays.set(invoiceId, 'completed', true);
    await webhook(invoice, 'completed', 'off-1');
    offsetMs += 6_000;
    const report = await pass();
    expect(report.lateCompletions).toBe(1);
    expect(report.lateCredits).toBe(0);

    expect(await ledgerOf(paymentId)).toEqual([]);
    expect(await walletTotal()).toBe(0n);
    const after = await invoiceOf(paymentId);
    expect(after.outcome).toBe('LATE_COMPLETION');
    expect(after.late_completion_observed_at).not.toBeNull();
    expect(await openCodes()).toContain('payments.gateway_late_completion');
    expect(await notices(paymentId)).toEqual([]);
    expect(await outboxCount('PaymentLateCredited', paymentId)).toBe(0);
    expect(await orderState(orderId)).toBe('AWAITING_PAYMENT');
  });

  it('with the setting OFF no slow late polling is scheduled either', async () => {
    await setSetting(SWITCH, false);
    const { paymentId } = await createdAttempt();
    await ctx.container.database.db.execute(
      sql`UPDATE payments SET expires_at = now() + interval '4 seconds' WHERE id = ${paymentId}`,
    );
    await ctx.container.database.db.execute(
      sql`UPDATE gateway_invoices SET next_inquiry_at = now() - interval '1 second' WHERE payment_id = ${paymentId}`,
    );
    await pass();
    expect((await invoiceOf(paymentId)).next_inquiry_at).toBeNull();
  });

  it('an amount the provider reports for another figure is not credited, and raises the alert', async () => {
    const { orderId, paymentId, invoice, invoiceId } = await createdAttempt();
    await pastDeadline(paymentId);
    tonpays.set(invoiceId, 'completed', true);
    tonpays.setRequestAmount(invoiceId, 999_999);
    await webhook(invoice, 'completed', 'mismatch-1');
    offsetMs += 6_000;
    const report = await pass();
    expect(report.lateCredits).toBe(0);
    expect(report.lateCompletions).toBe(1);

    expect(await ledgerOf(paymentId)).toEqual([]);
    expect(await walletTotal()).toBe(0n);
    expect((await invoiceOf(paymentId)).outcome).toBe('LATE_COMPLETION');
    const alerts = await rows<{ code: string; reason: string }>(
      sql`SELECT code, context->>'reason' AS reason FROM operational_events
           WHERE tenant_id = ${tenantA.tenantId} AND code = 'payments.gateway_late_completion'`,
    );
    /*
     * R12 F1 item 5: the TonPays adapter itself now answers such an approval MISMATCH (its
     * `request_amount` is not what Nexa sent), so the lane records it as a late completion
     * before the credit is ever asked — with the provider's reason rather than the credit's.
     */
    expect(alerts).toEqual([
      { code: 'payments.gateway_late_completion', reason: 'PROVIDER_AMOUNT_MISMATCH' },
    ]);
    expect(await orderState(orderId)).toBe('AWAITING_PAYMENT');
    expect(await notices(paymentId)).toEqual([]);
  });

  it('an UNKNOWN payment is credited to the WALLET only: never the order, never a service — and an operator’s later reconciliation cannot credit it again', async () => {
    const { orderId, paymentId, invoiceId } = await createdAttempt();
    // The attempt goes UNKNOWN inside its deadline (a hold for an operator).
    await ctx.container.uow.run(tenantA, (tx) =>
      new DrizzlePaymentRepository(ctx.container.database.db).loseTrack(
        tenantA,
        paymentId,
        ctx.container.clock.now(),
        tx,
      ),
    );
    expect((await paymentOf(paymentId)).state).toBe('UNKNOWN');
    tonpays.set(invoiceId, 'completed', true);
    await ctx.container.database.db.execute(
      sql`UPDATE gateway_invoices SET next_inquiry_at = now() - interval '1 second' WHERE payment_id = ${paymentId}`,
    );
    const report = await pass();
    expect(report.lateCredits).toBe(1);

    const entries = await ledgerOf(paymentId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      reason: 'GATEWAY_LATE_CREDIT',
      order_id: null,
      reference: `${paymentId}:late-credit`,
    });
    expect(await walletTotal()).toBe(250_000n);
    // Still UNKNOWN, the order untouched, no service.
    expect((await paymentOf(paymentId)).state).toBe('UNKNOWN');
    expect(await orderState(orderId)).toBe('AWAITING_PAYMENT');
    expect(await serviceCount()).toBe(0);

    // The operator's reconcile-as-paid is refused: the money is already in the wallet.
    const confirm = ctx.container.payments.reconcileGatewayPayment(tenantA, owner, paymentId, {
      to: 'CONFIRMED',
      note: null,
      idempotencyKey: 'reconcile-after-credit',
    });
    await expect(confirm).rejects.toSatisfy(
      (error: unknown) =>
        isNexaError(error) &&
        (error.details as { reason?: string } | undefined)?.reason ===
          'LATE_CREDIT_ALREADY_APPLIED',
    );
    expect(await orderState(orderId)).toBe('AWAITING_PAYMENT');
    expect(await walletTotal()).toBe(250_000n);
    expect(await ledgerOf(paymentId)).toHaveLength(1);
    expect(await serviceCount()).toBe(0);
    // Closing it as not paid is still the operator's, and moves nothing.
    await ctx.container.payments.reconcileGatewayPayment(tenantA, owner, paymentId, {
      to: 'FAILED',
      note: null,
      idempotencyKey: 'reconcile-fail-after-credit',
    });
    expect((await paymentOf(paymentId)).state).toBe('FAILED');
    expect(await walletTotal()).toBe(250_000n);
  });

  it('an operator who reconciled first is not credited again by a later approval', async () => {
    const { orderId, paymentId, invoiceId } = await createdAttempt();
    // Inside the deadline the ordinary settlement owns the approval.
    tonpays.set(invoiceId, 'completed', true);
    await ctx.container.database.db.execute(
      sql`UPDATE gateway_invoices SET next_inquiry_at = now() - interval '1 second' WHERE payment_id = ${paymentId}`,
    );
    await pass();
    expect((await paymentOf(paymentId)).state).toBe('CONFIRMED');
    expect(await orderState(orderId)).not.toBe('AWAITING_PAYMENT');
    // The credit path refuses a CONFIRMED payment whatever the caller believes.
    const refused = await ctx.container.payments.creditLateGatewayApproval(
      tenantA,
      systemActor('confirmed'),
      paymentId,
      { providerRequestAmount: 250_000n, evidenceNote: null },
    );
    expect(refused).toMatchObject({ outcome: 'NOT_ELIGIBLE', reason: 'ALREADY_CONFIRMED' });
    expect((await ledgerOf(paymentId)).filter((e) => e.reason === 'GATEWAY_LATE_CREDIT')).toEqual(
      [],
    );
  });

  it('a payment credited to the wallet can never also settle its order, even if its deadline moves', async () => {
    const { orderId, paymentId, invoice, invoiceId } = await createdAttempt();
    await pastDeadline(paymentId);
    tonpays.set(invoiceId, 'completed', true);
    await webhook(invoice, 'completed', 'belt-1');
    offsetMs += 6_000;
    await pass();
    expect(await walletTotal()).toBe(250_000n);
    // The payment is still PENDING; its deadline moves ahead again.
    await ctx.container.database.db.execute(
      sql`UPDATE payments SET expires_at = now() + interval '1 hour' WHERE id = ${paymentId}`,
    );
    const settled = await ctx.container.payments.confirmGatewayPayment(
      tenantA,
      systemActor('belt'),
      paymentId,
      { evidenceNote: 'belt' },
    );
    expect(settled).toMatchObject({
      outcome: 'NOT_ELIGIBLE',
      reason: 'LATE_CREDIT_ALREADY_APPLIED',
    });
    expect((await paymentOf(paymentId)).state).toBe('PENDING');
    expect(await orderState(orderId)).toBe('AWAITING_PAYMENT');
    expect(await serviceCount()).toBe(0);
    expect(await walletTotal()).toBe(250_000n);
  });

  describe('Codex review: what an operator, the customer and the timeline see after a credit', () => {
    const guideOf = async (paymentId: string) => {
      const record = await ctx.container.payments.get(tenantA, owner, paymentId);
      const read = await ctx.container.payments.situations(tenantA, owner, [record]);
      return read.get(record.id)!.guide;
    };
    const credit = async (
      paymentId: string,
      invoice: Awaited<ReturnType<typeof invoiceOf>>,
      invoiceId: string,
    ) => {
      tonpays.set(invoiceId, 'completed', true);
      await webhook(invoice, 'completed', 'cx-1');
      offsetMs += 6_000;
      await pass();
      expect(await walletTotal()).toBe(250_000n);
    };

    it('P1: a credited PENDING, then EXPIRED, payment is money in the wallet — never awaiting payment, never "pay again"', async () => {
      const { paymentId, invoice, invoiceId } = await createdAttempt();
      await pastDeadline(paymentId);
      await credit(paymentId, invoice, invoiceId);
      expect((await paymentOf(paymentId)).state).toBe('PENDING');
      expect(await guideOf(paymentId)).toMatchObject({
        situation: 'LATE_CREDITED',
        money: 'TO_WALLET',
        customer: 'NOTHING',
      });
      await ctx.container.paymentExpirySweep.runOnce(tenantA);
      expect((await paymentOf(paymentId)).state).toBe('EXPIRED');
      expect(await guideOf(paymentId)).toMatchObject({
        situation: 'LATE_CREDITED',
        money: 'TO_WALLET',
        customer: 'NOTHING',
      });
    });

    it('P1: a credited UNKNOWN payment is not "possibly paid, wait" — and still has its one exit', async () => {
      const { paymentId, invoiceId } = await createdAttempt();
      await ctx.container.uow.run(tenantA, (tx) =>
        new DrizzlePaymentRepository(ctx.container.database.db).loseTrack(
          tenantA,
          paymentId,
          ctx.container.clock.now(),
          tx,
        ),
      );
      tonpays.set(invoiceId, 'completed', true);
      await ctx.container.database.db.execute(
        sql`UPDATE gateway_invoices SET next_inquiry_at = now() - interval '1 second' WHERE payment_id = ${paymentId}`,
      );
      await pass();
      expect(await walletTotal()).toBe(250_000n);
      expect(await guideOf(paymentId)).toMatchObject({
        situation: 'LATE_CREDITED',
        money: 'TO_WALLET',
        customer: 'NOTHING',
        actions: ['RECONCILE'],
      });
    });

    it('P2: the customer’s invoice message is refreshed on a credit and no longer says unresolved', async () => {
      const refreshed: string[] = [];
      lane = laneWith(tonpays, true, {
        refresh: async (_scope, id) => {
          refreshed.push(id);
        },
      });
      const { orderId, paymentId, invoice, invoiceId } = await createdAttempt();
      // createdAttempt's own pass refreshed the ready invoice; only the credit's counts.
      refreshed.length = 0;
      await pastDeadline(paymentId);
      await credit(paymentId, invoice, invoiceId);
      expect(refreshed).toEqual([paymentId]);

      const view = await ctx.container.gatewayPayments.attemptFor(tenantA, maryam, paymentId);
      const screen = gatewayAttemptScreen(view!, orderId, new Date(Date.now() + 6 * 60_000));
      expect(screen.key).toBe('bot.payment.gateway_late_credited_screen');
      // No way to pay again is drawn on it.
      expect(JSON.stringify(screen.buttons)).not.toContain('gc:');
    });

    it('P2: …and the same payment read UNKNOWN shows the credited screen, not the unresolved one', async () => {
      const { orderId, paymentId, invoiceId } = await createdAttempt();
      await ctx.container.uow.run(tenantA, (tx) =>
        new DrizzlePaymentRepository(ctx.container.database.db).loseTrack(
          tenantA,
          paymentId,
          ctx.container.clock.now(),
          tx,
        ),
      );
      tonpays.set(invoiceId, 'completed', true);
      await ctx.container.database.db.execute(
        sql`UPDATE gateway_invoices SET next_inquiry_at = now() - interval '1 second' WHERE payment_id = ${paymentId}`,
      );
      await pass();
      const view = await ctx.container.gatewayPayments.attemptFor(tenantA, maryam, paymentId);
      expect(gatewayAttemptScreen(view!, orderId, new Date()).key).toBe(
        'bot.payment.gateway_late_credited_screen',
      );
    });

    it('P2: the notice is on the payment timeline', async () => {
      const { paymentId, invoice, invoiceId } = await createdAttempt();
      await pastDeadline(paymentId);
      await credit(paymentId, invoice, invoiceId);
      const view = await ctx.container.paymentTimeline.timeline(tenantA, owner, paymentId);
      expect(
        view.entries.map((e) => ('notificationKind' in e ? e.notificationKind : null)),
      ).toContain('GATEWAY_LATE_PAYMENT_CREDITED');
    });
  });

  describe('the operations log', () => {
    const LOG_CHAT = '-1001234567890';
    const PAYMENTS_TOPIC = 77;
    let flagSeq = 0;

    async function configureLog() {
      const key = () => `lc-log-${String((flagSeq += 1))}`;
      await ctx.container.featureFlags.set(tenantA, owner, {
        key: 'ops_notifications',
        enabled: true,
        expectedVersion: null,
        idempotencyKey: key(),
        confirmKey: 'ops_notifications',
        reason: 'Late credit log.',
      });
      for (const [settingKey, value] of [
        ['ops.notifications.telegram_chat_id', LOG_CHAT],
        ['ops.notifications.telegram_topic_id', 5],
        ['ops.notifications.payments_topic_id', PAYMENTS_TOPIC],
      ] as const) {
        await ctx.container.settingsService.set(tenantA, owner, {
          key: settingKey,
          value,
          expectedVersion: null,
          idempotencyKey: key(),
        });
      }
    }

    async function relayAll() {
      for (let round = 0; round < 20; round += 1) {
        const result = await ctx.container.relay.processBatch();
        if (result.claimed === 0) return;
      }
    }

    it('posts «تأیید دیرهنگام — واریز به کیف پول» to the PAYMENTS topic, once, with the customer, code, gateway, amount, wallet before and after, and both times', async () => {
      await configureLog();
      const { paymentId, invoice, invoiceId } = await createdAttempt();
      await pastDeadline(paymentId);
      tonpays.set(invoiceId, 'completed', true);
      await webhook(invoice, 'completed', 'log-1');
      offsetMs += 6_000;
      await pass();
      await relayAll();
      await relayAll();

      const written = await rows<{
        kind: string;
        template_key: string;
        destination: { chatId: string; topicId: number | null };
        payload: Record<string, unknown>;
      }>(
        sql`SELECT kind, template_key, destination, payload FROM notifications
             WHERE tenant_id = ${tenantA.tenantId} AND template_key = 'ops.financial.late_credit'`,
      );
      expect(written).toHaveLength(1);
      const [log] = written;
      expect(log!.kind).toBe('OPERATIONAL_EVENT');
      expect(log!.destination).toMatchObject({ chatId: LOG_CHAT, topicId: PAYMENTS_TOPIC });
      const payment = await paymentOf(paymentId);
      expect(log!.payload).toMatchObject({
        gateway: 'تون‌پی (وب‌سایت)',
        telegramId: MARYAM,
        displayName: 'مریم',
        reference: payment.code ?? payment.reference,
        amount: { amountMinor: '250000', currency: 'IRT' },
        balanceBefore: { amountMinor: '0', currency: 'IRT' },
        balanceAfter: { amountMinor: '250000', currency: 'IRT' },
      });
      expect(String(log!.payload['reference'])).toHaveLength(8);
      expect(log!.payload).toHaveProperty('expiredAt');
      expect(log!.payload).toHaveProperty('approvedAt');
      // The deadline passed before the credit was written.
      expect(new Date(String(log!.payload['expiredAt'])).getTime()).toBeLessThan(
        new Date(String(log!.payload['approvedAt'])).getTime(),
      );
      // No «late completion» message for the same fact: nothing is left for an operator to check.
      const lateMessages = await rows<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM notifications
             WHERE tenant_id = ${tenantA.tenantId} AND template_key = 'ops.financial.late_completion'`,
      );
      expect(lateMessages[0]!.n).toBe(0);
      expect(JSON.stringify(written)).not.toContain(API_KEY);
    });
  });

  describe('the slow late poll', () => {
    /** Forces the attempt's next inquiry due, with its deadline `seconds` ahead. */
    async function dueWithDeadline(paymentId: string, seconds: number) {
      await ctx.container.database.db.execute(
        sql`UPDATE payments SET expires_at = now() + (${seconds} || ' seconds')::interval WHERE id = ${paymentId}`,
      );
      await ctx.container.database.db.execute(
        sql`UPDATE gateway_invoices SET next_inquiry_at = now() - interval '1 second' WHERE payment_id = ${paymentId}`,
      );
    }

    const minutesUntilNext = async (paymentId: string) => {
      const invoice = await invoiceOf(paymentId);
      if (invoice.next_inquiry_at === null || invoice.last_inquiry_at === null) return null;
      return (
        (new Date(invoice.next_inquiry_at).getTime() -
          new Date(invoice.last_inquiry_at).getTime()) /
        60_000
      );
    };

    it('picks up a late approval WITHOUT a webhook', async () => {
      const { orderId, paymentId, invoiceId } = await createdAttempt();
      // The last question inside the deadline: still open, and the slow poll is scheduled.
      await dueWithDeadline(paymentId, 4);
      await pass();
      expect(await ledgerOf(paymentId)).toEqual([]);
      const first = await minutesUntilNext(paymentId);
      expect(first).not.toBeNull();
      expect(first!).toBeGreaterThan(4.4);
      expect(first!).toBeLessThan(5.6);

      // The payment closes; the customer pays at the provider afterwards; no webhook arrives.
      offsetMs += 6 * 60_000;
      await ctx.container.database.db.execute(
        sql`UPDATE payments SET expires_at = now() - interval '1 minute' WHERE id = ${paymentId}`,
      );
      await ctx.container.paymentExpirySweep.runOnce(tenantA);
      expect((await paymentOf(paymentId)).state).toBe('EXPIRED');
      tonpays.set(invoiceId, 'completed', true);
      const report = await pass();

      expect(report.lateCredits).toBe(1);
      expect(await walletTotal()).toBe(250_000n);
      expect((await invoiceOf(paymentId)).outcome).toBe('LATE_CREDITED');
      expect((await invoiceOf(paymentId)).next_inquiry_at).toBeNull();
      expect(await orderState(orderId)).not.toBe('PAID');
      expect(await serviceCount()).toBe(0);
    });

    it('backs off 5 minutes, then 15, then hourly — and stops when the window closes', async () => {
      const { paymentId } = await createdAttempt();
      await dueWithDeadline(paymentId, 4);
      await pass();
      const gaps: number[] = [];
      const near = (value: number, target: number) => Math.abs(value - target) <= target * 0.11;
      expect(near((await minutesUntilNext(paymentId))!, 5)).toBe(true);

      // Past the deadline, each late poll schedules the next one further out. The lane's clock
      // jumps to when the next one is due; the deadline stays a minute behind the DB's now.
      for (let step = 0; step < 4; step += 1) {
        const invoice = await invoiceOf(paymentId);
        offsetMs = new Date(invoice.next_inquiry_at!).getTime() - Date.now() + 1_000;
        await ctx.container.database.db.execute(
          sql`UPDATE payments SET expires_at = now() - interval '1 minute' WHERE id = ${paymentId}`,
        );
        await pass();
        gaps.push((await minutesUntilNext(paymentId))!);
      }
      expect(near(gaps[0]!, 15)).toBe(true);
      expect(near(gaps[1]!, 60)).toBe(true);
      expect(near(gaps[2]!, 60)).toBe(true);
      expect(near(gaps[3]!, 60)).toBe(true);

      // Beyond the configured window nothing is scheduled any more.
      await setSetting(WINDOW, 1);
      const invoice = await invoiceOf(paymentId);
      offsetMs = new Date(invoice.next_inquiry_at!).getTime() - Date.now() + 1_000;
      await ctx.container.database.db.execute(
        sql`UPDATE payments SET expires_at = now() - interval '3 hours' WHERE id = ${paymentId}`,
      );
      await pass();
      expect((await invoiceOf(paymentId)).next_inquiry_at).toBeNull();
    });

    it('asks within the provider budget: a late poll takes at most half the scheduled share of the minute', async () => {
      const { paymentId } = await createdAttempt();
      await dueWithDeadline(paymentId, 4);
      await pass();
      // Past the deadline, the budget window is full to half of the scheduled share (15 of 30):
      // a late poll is deferred, never asked.
      offsetMs += 6 * 60_000;
      await ctx.container.database.db.execute(
        sql`UPDATE payments SET expires_at = now() - interval '1 minute' WHERE id = ${paymentId}`,
      );
      await ctx.container.database.db.execute(
        sql`INSERT INTO payment_gateway_call_budgets (tenant_id, provider, window_started_at, used)
            VALUES (${tenantA.tenantId}, 'TONPAYS', ${new Date(Date.now() + offsetMs)}, 20)
            ON CONFLICT (tenant_id, provider) DO UPDATE SET window_started_at = EXCLUDED.window_started_at, used = EXCLUDED.used`,
      );
      const before = tonpays.checks.length;
      const report = await pass();
      expect(report.budgetExhausted).toBe(true);
      expect(tonpays.checks.length).toBe(before);
    });
  });

  it('the route that names no switch (the descriptor) is never credited, whatever the setting', async () => {
    const providers: readonly PaymentGatewayProvider[] = [
      'MANUAL_TRANSFER',
      'TELEGRAM_STARS',
      'NOWPAYMENTS',
      'CENTRALPAY',
    ];
    const { PAYMENT_GATEWAY_DESCRIPTORS } = await import('@nexa/contracts');
    for (const provider of providers) {
      expect(PAYMENT_GATEWAY_DESCRIPTORS[provider].lateCreditSetting).toBeNull();
    }
    expect(PAYMENT_GATEWAY_DESCRIPTORS.TONPAYS.lateCreditSetting).toBe(SWITCH);
    expect(PAYMENT_GATEWAY_DESCRIPTORS.TONPAYS_TELEGRAM.lateCreditSetting).toBe(
      'payments.late_credit.tonpays_telegram_enabled',
    );
  });
});
