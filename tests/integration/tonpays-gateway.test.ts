import { createServer, type Server } from 'node:http';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  COMMERCE_ERROR_CODES,
  EMPTY_PRODUCT_DISPLAY,
  isNexaError,
  money,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type PanelId,
  type PaymentGatewayConfig,
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
  type GatewayPaymentServiceDeps,
} from '../../apps/api/src/modules/commerce/payments/application/gateway-payment.service';
import type { GatewayCallBudget } from '../../apps/api/src/modules/commerce/payments/application/gateway-invoice-ports';
import { DrizzleOperationalConditionReader } from '../../apps/api/src/modules/platform/opslog/infrastructure/drizzle-operational-event.reader';
import { startFakeMarzban, type FakeMarzban } from '../support/fake-marzban';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  validatePanelConnection,
  SEED_IDS,
  tenantA,
  tenantB,
  type TestContext,
} from './harness';

/**
 * WP11A — TonPays, end to end against a real database (`docs/tonpays-gateway-audit.md`).
 *
 * The container's own services decide everything: the Telegram runtime, `PaymentService`
 * and its one settlement path, the gateway route service. The gateway LANE is built here
 * over the container's database with the REAL `TonPaysAdapter`, whose `fetch` is a
 * recording fake TonPays — so the adapter's parsing and classification are the ones under
 * test, and nothing leaves the process. The lane's clock is the only thing moved: the
 * payment's own 70-minute deadline is the database row, and the boundary cases move the
 * row rather than the clock.
 *
 * Targeted, per the WP11A brief: the full falsification pass is deferred to acceptance.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const MARYAM = '910910';
const API_KEY = 'tp_live_KEY_that_must_never_leak_71c0de';
const OTHER_KEY = 'tp_live_OTHER_tenant_key_33aa';

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

// ---------------------------------------------------------------------------------------
// A fake TonPays: the documented request and response shapes, and nothing more.
// ---------------------------------------------------------------------------------------

interface FakeInvoice {
  readonly invoiceId: string;
  readonly orderId: string;
  readonly amount: number;
  status: string;
  paid: unknown;
  finalAmount: number;
}

type CreateMode =
  | 'OK'
  | 'NO_WEB_LINK'
  | 'TIMEOUT_AFTER_CREATING'
  | 'SERVER_ERROR'
  | { readonly code: string; readonly status: number };

class FakeTonPays {
  readonly invoices = new Map<string, FakeInvoice>();
  readonly creates: { body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  readonly checks: string[] = [];
  createMode: CreateMode = 'OK';
  private seq = 0;

  readonly fetch: FetchLike = async (url, init) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    const headers = init.headers as Record<string, string>;
    if (url.endsWith('/api/v1/invoices/create')) {
      this.creates.push({ body, headers });
      const mode = this.createMode;
      if (typeof mode === 'object') {
        return json(mode.status, { detail: { code: mode.code, message: 'refused' } });
      }
      if (mode === 'SERVER_ERROR') return json(502, { error: 'bad gateway' });
      this.seq += 1;
      const invoiceId = `TP-${String(this.seq).padStart(8, '0')}`;
      const invoice: FakeInvoice = {
        invoiceId,
        orderId: String(body.order_id),
        amount: Number(body.amount),
        status: 'pending',
        paid: false,
        // The documented example: the final amount differs from the requested one.
        finalAmount: Number(body.amount) + 37,
      };
      this.invoices.set(invoiceId, invoice);
      if (mode === 'TIMEOUT_AFTER_CREATING') throw new Error('socket hang up');
      return json(201, {
        invoice_id: invoiceId,
        order_id: invoice.orderId,
        request_amount: invoice.amount,
        final_amount: invoice.finalAmount,
        status: 'pending',
        invoice_url: `https://t.me/TonPaysInvoiceBot?start=inv_${invoiceId}`,
        ...(mode === 'NO_WEB_LINK' || body.buyer_chat_id === undefined
          ? {}
          : { web_invoice_url: `https://pay.tonpays.online/i/${invoiceId}?p=xyz` }),
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
        request_amount: invoice.amount,
        final_amount: invoice.finalAmount,
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
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('TonPays, through the one settlement path', () => {
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
  /** Every `sendMessage` body the bot sent to the fake Telegram. */
  const sent: Record<string, unknown>[] = [];
  const lastMarkup = () => JSON.stringify(sent[sent.length - 1]?.['reply_markup'] ?? {});
  const lastText = () => String(sent[sent.length - 1]?.['text'] ?? '');

  beforeAll(async () => {
    telegram = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        try {
          if ((request.url ?? '').includes('/sendMessage')) {
            sent.push(
              JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
            );
          }
        } catch {
          // a multipart upload; not what these cases read
        }
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
      await createAdmin(ctx.container, tenantA, { username: 'owner-tp', roleKeys: ['owner'] }),
    );
    const created = await ctx.container.panels.create(tenantA, owner, {
      name: 'Marzban A',
      providerType: 'marzban',
      baseUrl: panel.baseUrl,
      credentials: { username: panel.username, password: panel.password },
      activation: { proxyProtocols: ['vless'], inboundTags: { vless: ['VLESS TCP'] } },
      idempotencyKey: 'panel-tp-create',
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
    // The installation's public origin, as the Telegram bootstrap registers it.
    await ctx.container.database.db.execute(
      sql`UPDATE bot_instances SET webhook_url = ${`https://bot.example.com/telegram/webhook/${BOT_A}`}
          WHERE tenant_id = ${tenantA.tenantId}`,
    );

    tonpays = new FakeTonPays();
    offsetMs = 0;
    lane = laneWith(tonpays);
  });

  /** A gateway lane over the container's database, with a fake TonPays and a movable clock. */
  function laneWith(
    fake: FakeTonPays,
    overrides: {
      readonly budget?: GatewayCallBudget;
      readonly payments?: GatewayPaymentServiceDeps['payments'];
    } = {},
  ): GatewayPaymentService {
    const db = ctx.container.database.db;
    const adapter = new TonPaysAdapter({ fetch: fake.fetch });
    const origins = new DrizzlePublicOriginReader(db);
    return new GatewayPaymentService({
      invoices: new DrizzleGatewayInvoiceRepository(db),
      payments: overrides.payments ?? ctx.container.payments,
      paymentRecords: new DrizzlePaymentRepository(db),
      adapters: (provider) => (provider === 'TONPAYS' ? adapter : null),
      credentials: new DrizzleGatewayCredentialStore(db, ctx.container.cipher, () =>
        ctx.container.ids.uuid(),
      ),
      budget: overrides.budget ?? new DrizzleGatewayCallBudget(db),
      callbackUrlFor: async (scope: TenantContext, provider) =>
        gatewayCallbackUrl(await origins.originFor(scope), provider, String(scope.tenantId)),
      customers: new DrizzleCustomerRepository(db),
      conditions: new DrizzleOperationalConditionReader(db),
      scopeActivity: ctx.container.tenants,
      uow: ctx.container.uow,
      audit: ctx.container.audit,
      opsLog: ctx.container.opsLog,
      clock: { now: () => new Date(Date.now() + offsetMs) },
      ids: ctx.container.ids,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });
  }

  // -------------------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------------------

  async function enableTonPays(config: Partial<PaymentGatewayConfig> = {}, scope = tenantA) {
    await ctx.container.paymentGateways.configure(scope, owner, {
      idempotencyKey: `tp-cfg-${JSON.stringify(config)}`,
      provider: 'TONPAYS',
      config: { ...OPEN_ROUTE, ...config },
    });
    await ctx.container.paymentGateways.setCredential(scope, owner, {
      idempotencyKey: 'tp-cred',
      provider: 'TONPAYS',
      apiKey: API_KEY,
    });
    await ctx.container.paymentGateways.setStatus(scope, owner, {
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
      idempotencyKey: `tp-update-${String(updateSeq)}`,
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

  /** A DRAFT order for Maryam, through the Telegram flow a customer takes. */
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

  /** The customer taps the pre-invoice's gateway button. */
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

  /** Brings every scheduled inquiry due and runs a pass. */
  async function inquireNow() {
    offsetMs += 6 * 60_000;
    return pass();
  }

  async function invoiceOf(paymentId: string) {
    const [row] = await rows<{
      creation_state: string;
      provider_order_id: string;
      provider_invoice_id: string | null;
      provider_status: string | null;
      provider_paid: boolean | null;
      outcome: string | null;
      late_completion_observed_at: Date | null;
      next_inquiry_at: Date | null;
      web_invoice_url: string | null;
      invoice_url: string | null;
      request_amount: string | null;
      final_amount: string | null;
      webhook_count: number;
    }>(sql`SELECT * FROM gateway_invoices WHERE payment_id = ${paymentId}`);
    if (row === undefined) throw new Error('no invoice row');
    return row;
  }

  async function paymentOf(paymentId: string) {
    const [row] = await rows<{
      state: string;
      evidence_kind: string | null;
      amount: string;
      expires_at: Date;
      created_at: Date;
      resolved_by_admin_id: string | null;
      external_reference: string | null;
    }>(sql`SELECT * FROM payments WHERE id = ${paymentId}`);
    if (row === undefined) throw new Error('no payment');
    return row;
  }

  const orderState = async (orderId: string) =>
    (await rows<{ state: string }>(sql`SELECT state FROM orders WHERE id = ${orderId}`))[0]?.state;

  const ledger = () =>
    rows<{ reason: string; amount: string; payment_id: string | null }>(
      sql`SELECT reason, amount::text AS amount, payment_id FROM wallet_entries
          WHERE tenant_id = ${tenantA.tenantId} AND customer_id = ${maryam} ORDER BY created_at, reason`,
    );

  const notified = async (subjectId: string) =>
    (
      await rows<{ kind: string }>(
        sql`SELECT kind FROM customer_notifications WHERE subject_id = ${subjectId} ORDER BY kind`,
      )
    ).map((row) => row.kind);

  const webhook = (
    invoice: { provider_order_id: string; provider_invoice_id: string | null },
    status: string,
    deliveryId: string,
    tenantId: string = String(tenantA.tenantId),
  ) =>
    lane.receiveWebhook(
      tenantId,
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

  /** A created TonPays attempt for a fresh order, and its fake invoice id. */
  async function createdAttempt(priceMinor = 250_000n) {
    await enableTonPays();
    const orderId = await draftOrder(priceMinor);
    const { paymentId } = await payWithGateway(orderId);
    await pass();
    const invoice = await invoiceOf(paymentId);
    if (invoice.provider_invoice_id === null) throw new Error('not created');
    return { orderId, paymentId, invoice, invoiceId: invoice.provider_invoice_id };
  }

  // =====================================================================================

  describe('creating an attempt', () => {
    it('is a database write while Telegram waits, and the worker creates the invoice with the documented request', async () => {
      await enableTonPays();
      const orderId = await draftOrder();
      const { paymentId } = await payWithGateway(orderId);

      // The tap made no call: the attempt is CREATING, and the payment carries the deadline.
      expect(tonpays.creates).toHaveLength(0);
      const payment = await paymentOf(paymentId);
      expect(payment.state).toBe('PENDING');
      expect(String(payment.amount)).toBe('250000');
      expect(new Date(payment.expires_at).getTime() - new Date(payment.created_at).getTime()).toBe(
        70 * 60_000,
      );
      expect((await invoiceOf(paymentId)).creation_state).toBe('CREATING');
      expect(await orderState(orderId)).toBe('AWAITING_PAYMENT');

      await pass();
      expect(tonpays.creates).toHaveLength(1);
      const [create] = tonpays.creates;
      const invoice = await invoiceOf(paymentId);
      expect(create!.headers['X-API-Key']).toBe(API_KEY);
      expect(create!.body).toEqual({
        amount: 250000,
        order_id: invoice.provider_order_id,
        callback_url: `https://bot.example.com/payments/webhook/tonpays/${String(tenantA.tenantId)}`,
        buyer_chat_id: Number(MARYAM),
      });
      expect(invoice.provider_order_id).toHaveLength(20);
      expect(invoice.creation_state).toBe('CREATED');
      expect(invoice.web_invoice_url).toMatch(/^https:\/\/pay\.tonpays\.online\//u);
      expect((await paymentOf(paymentId)).external_reference).toBe(invoice.provider_invoice_id);
    });

    it('tells the customer it is preparing, then shows the invoice with the web link, and never says paid', async () => {
      await enableTonPays();
      const orderId = await draftOrder();
      const { paymentId } = await payWithGateway(orderId);
      expect(lastMarkup()).toContain(`gc:${paymentId}`);
      expect(lastMarkup()).not.toContain('"url"');
      await pass();
      await tap(`gc:${paymentId}`);
      const invoice = await invoiceOf(paymentId);
      expect(lastMarkup()).toContain(`"url":"${invoice.web_invoice_url!}"`);
      expect(lastMarkup()).not.toContain(invoice.invoice_url!);
      expect(lastText()).toContain('250,000');
      expect(lastText()).not.toContain('تأیید و ثبت شد');
    });

    it('offers web_invoice_url first and falls back to invoice_url, never inventing one', async () => {
      const { paymentId, invoice } = await createdAttempt();
      const view = await ctx.container.gatewayPayments.attemptFor(tenantA, maryam, paymentId);
      expect(view?.invoice.webInvoiceUrl).toBe(invoice.web_invoice_url);

      tonpays.createMode = 'NO_WEB_LINK';
      const second = await draftOrder();
      const { paymentId: other } = await payWithGateway(second);
      await pass();
      const fallback = await invoiceOf(other);
      expect(fallback.web_invoice_url).toBeNull();
      expect(fallback.invoice_url).toMatch(/^https:\/\/t\.me\//u);
      await tap(`gc:${other}`);
      expect(lastMarkup()).toContain(`"url":"${fallback.invoice_url!}"`);
    });

    it('hands back the open attempt to a second tap rather than making a second invoice', async () => {
      await enableTonPays();
      const orderId = await draftOrder();
      const first = await payWithGateway(orderId);
      const again = await ctx.container.payments.requestGatewayPayment(
        { ...tenantA, botInstanceId: BOT_A },
        systemActor('again'),
        maryam,
        { idempotencyKey: 'again-1', orderId, provider: 'TONPAYS' },
      );
      expect(again.reissued).toBe(true);
      expect(again.payment.id).toBe(first.paymentId);
    });

    it('records a lost create answer as CREATE_UNKNOWN: no success, no settlement, never re-sent', async () => {
      await enableTonPays();
      const orderId = await draftOrder();
      tonpays.createMode = 'TIMEOUT_AFTER_CREATING';
      const { paymentId } = await payWithGateway(orderId);
      await pass();
      const invoice = await invoiceOf(paymentId);
      expect(invoice.creation_state).toBe('CREATE_UNKNOWN');
      expect(invoice.provider_invoice_id).toBeNull();
      expect((await paymentOf(paymentId)).state).toBe('PENDING');
      expect(await orderState(orderId)).toBe('AWAITING_PAYMENT');
      expect(await ledger()).toEqual([]);

      await inquireNow();
      await inquireNow();
      expect(tonpays.creates).toHaveLength(1);
      expect(tonpays.checks).toHaveLength(0);
    });

    it('never re-sends a create whose send was stamped and never answered', async () => {
      await enableTonPays();
      const orderId = await draftOrder();
      const { paymentId } = await payWithGateway(orderId);
      // A worker that died mid-call: the stamp committed, the answer never recorded.
      await ctx.container.database.db.execute(
        sql`UPDATE gateway_invoices SET creation_sent_at = now() WHERE payment_id = ${paymentId}`,
      );
      await pass();
      expect(tonpays.creates).toHaveLength(0);
      expect((await invoiceOf(paymentId)).creation_state).toBe('CREATE_UNKNOWN');
    });

    it('retries a rate-limited create with the SAME order id, and moves no money meanwhile', async () => {
      await enableTonPays();
      const orderId = await draftOrder();
      tonpays.createMode = { code: 'RATE_LIMIT_EXCEEDED', status: 429 };
      const { paymentId } = await payWithGateway(orderId);
      await pass();
      expect((await invoiceOf(paymentId)).creation_state).toBe('CREATING');
      expect((await paymentOf(paymentId)).state).toBe('PENDING');
      expect(await ledger()).toEqual([]);

      tonpays.createMode = 'OK';
      offsetMs += 20_000;
      await pass();
      expect(tonpays.creates).toHaveLength(2);
      expect(tonpays.creates[1]!.body.order_id).toBe(tonpays.creates[0]!.body.order_id);
      expect((await invoiceOf(paymentId)).creation_state).toBe('CREATED');
    });

    it('treats a 5xx create as CREATE_UNKNOWN even when its body carries a rate-limit code, and never re-sends it', async () => {
      await enableTonPays();
      const orderId = await draftOrder();
      // A server failure that may have happened after the invoice was made.
      tonpays.createMode = { code: 'RATE_LIMIT_EXCEEDED', status: 500 };
      const { paymentId } = await payWithGateway(orderId);
      await pass();
      expect((await invoiceOf(paymentId)).creation_state).toBe('CREATE_UNKNOWN');

      tonpays.createMode = 'OK';
      offsetMs += 20_000;
      await pass();
      expect(tonpays.creates).toHaveLength(1);
      expect((await paymentOf(paymentId)).state).toBe('PENDING');
      expect(await ledger()).toEqual([]);
    });

    it('treats a merchant configuration refusal as unavailable, not as the customer’s payment failing', async () => {
      await enableTonPays();
      const orderId = await draftOrder();
      tonpays.createMode = { code: 'INVALID_API_KEY', status: 401 };
      const { paymentId } = await payWithGateway(orderId);
      await pass();
      expect((await invoiceOf(paymentId)).creation_state).toBe('CREATE_FAILED');
      expect((await paymentOf(paymentId)).state).toBe('FAILED');
      expect(await notified(paymentId)).toEqual([]);
      expect(await orderState(orderId)).toBe('AWAITING_PAYMENT');
      const events = await rows<{ code: string }>(
        sql`SELECT code FROM operational_events WHERE tenant_id = ${tenantA.tenantId}
            AND code = 'payments.gateway_misconfigured'`,
      );
      expect(events).toHaveLength(1);
    });
  });

  describe('approval', () => {
    it('does not settle on a webhook alone: the webhook only brings the inquiry forward', async () => {
      const { orderId, paymentId, invoice } = await createdAttempt();
      // The webhook says completed and paid; the provider's own inquiry says pending.
      expect(await webhook(invoice, 'completed', 'd-1')).toBe('SCHEDULED');
      expect((await paymentOf(paymentId)).state).toBe('PENDING');
      expect(tonpays.checks).toHaveLength(0);

      const due = await invoiceOf(paymentId);
      expect(new Date(due.next_inquiry_at!).getTime()).toBeLessThanOrEqual(
        Date.now() + offsetMs + 6_000,
      );

      offsetMs += 6_000;
      await pass();
      expect(tonpays.checks).toHaveLength(1);
      expect((await paymentOf(paymentId)).state).toBe('PENDING');
      expect(await orderState(orderId)).toBe('AWAITING_PAYMENT');
    });

    it('settles completed + paid=true exactly once, through the existing settlement, whatever repeats', async () => {
      const { orderId, paymentId, invoice, invoiceId } = await createdAttempt();
      tonpays.set(invoiceId, 'completed', true);

      await webhook(invoice, 'completed', 'd-1');
      await webhook(invoice, 'completed', 'd-1'); // duplicate delivery
      await webhook(invoice, 'completed', 'd-2');
      offsetMs += 6_000;
      await pass();
      await inquireNow();
      await webhook(invoice, 'completed', 'd-3');
      await inquireNow();

      const payment = await paymentOf(paymentId);
      expect(payment.state).toBe('CONFIRMED');
      expect(payment.evidence_kind).toBe('GATEWAY_INQUIRY');
      expect(payment.resolved_by_admin_id).toBeNull();
      expect(await orderState(orderId)).toBe('PAID');
      const confirmed = await rows<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM payments WHERE order_id = ${orderId} AND state = 'CONFIRMED'`,
      );
      expect(confirmed[0]!.n).toBe(1);
      const settled = await rows<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM outbox_messages WHERE event_type = 'OrderSettled'
            AND aggregate_id = ${orderId}`,
      );
      expect(settled[0]!.n).toBe(1);
      expect((await invoiceOf(paymentId)).outcome).toBe('SETTLED');
    });

    it('never settles pending, processing, need_action, or completed without paid === true', async () => {
      const { orderId, paymentId, invoiceId } = await createdAttempt();
      for (const [status, paid] of [
        ['pending', false],
        ['processing', false],
        ['need_action', false],
        ['completed', false],
        ['completed', 'true'],
        ['completed', null],
      ] as const) {
        tonpays.set(invoiceId, status, paid);
        await inquireNow();
        expect((await paymentOf(paymentId)).state, `${status}/${String(paid)}`).toBe('PENDING');
        expect(await orderState(orderId)).toBe('AWAITING_PAYMENT');
      }
      expect(await ledger()).toEqual([]);
    });

    for (const status of ['rejected', 'expired', 'canceled'] as const) {
      it(`records ${status} as unsuccessful without touching the order, and lets the customer pay again`, async () => {
        const { orderId, paymentId, invoiceId } = await createdAttempt();
        tonpays.set(invoiceId, status, false);
        await inquireNow();
        expect((await paymentOf(paymentId)).state).toBe('FAILED');
        expect(await orderState(orderId)).toBe('AWAITING_PAYMENT');
        expect(await notified(paymentId)).toEqual(['GATEWAY_PAYMENT_FAILED']);
        expect(await ledger()).toEqual([]);

        // A NEW attempt: new payment, new provider order id, new invoice.
        const retry = await payWithGateway(orderId);
        expect(retry.paymentId).not.toBe(paymentId);
        await pass();
        const second = await invoiceOf(retry.paymentId);
        expect(second.provider_order_id).not.toBe((await invoiceOf(paymentId)).provider_order_id);
        expect(tonpays.creates).toHaveLength(2);
      });
    }

    it('keeps an unsuccessful inquiry scheduled until the failure is durable, so a failed write is retried', async () => {
      const { paymentId, invoiceId } = await createdAttempt();
      tonpays.set(invoiceId, 'rejected', false);
      // The failure's own transaction dies once, after the inquiry was recorded.
      let refusals = 1;
      const flaky = laneWith(tonpays, {
        payments: {
          confirmGatewayPayment: (...args) => ctx.container.payments.confirmGatewayPayment(...args),
          failGatewayPayment: (...args) => {
            if (refusals > 0) {
              refusals -= 1;
              return Promise.reject(new Error('connection terminated'));
            }
            return ctx.container.payments.failGatewayPayment(...args);
          },
        },
      });
      offsetMs += 6 * 60_000;
      await expect(flaky.runOnce(tenantA)).rejects.toThrow('connection terminated');
      expect((await paymentOf(paymentId)).state).toBe('PENDING');
      const stranded = await invoiceOf(paymentId);
      expect(stranded.outcome).toBeNull();
      expect(stranded.next_inquiry_at).not.toBeNull();

      await inquireNow();
      expect((await paymentOf(paymentId)).state).toBe('FAILED');
      const done = await invoiceOf(paymentId);
      expect(done.outcome).toBe('UNSUCCESSFUL');
      expect(done.next_inquiry_at).toBeNull();
    });

    it('never lets the old attempt settle the new one', async () => {
      const first = await createdAttempt();
      tonpays.set(first.invoiceId, 'canceled', false);
      await inquireNow();
      const retry = await payWithGateway(first.orderId);
      await pass();

      // The provider now claims the OLD invoice was paid after all.
      tonpays.set(first.invoiceId, 'completed', true);
      await webhook(first.invoice, 'completed', 'late-1');
      await inquireNow();

      expect((await paymentOf(first.paymentId)).state).toBe('FAILED');
      expect((await paymentOf(retry.paymentId)).state).toBe('PENDING');
      expect(await orderState(first.orderId)).toBe('AWAITING_PAYMENT');
      expect((await invoiceOf(first.paymentId)).late_completion_observed_at).not.toBeNull();
    });

    it('never acts on an inquiry answer that names another order, whatever it says', async () => {
      const { orderId, paymentId, invoiceId } = await createdAttempt();
      // The provider answers this invoice id with somebody else's order: completed and paid.
      const fake = tonpays.invoices.get(invoiceId)!;
      tonpays.invoices.set(invoiceId, { ...fake, orderId: 'NX0000000000000000ZZ' });
      tonpays.set(invoiceId, 'completed', true);
      await inquireNow();

      expect((await paymentOf(paymentId)).state).toBe('PENDING');
      expect(await orderState(orderId)).toBe('AWAITING_PAYMENT');
      expect(await ledger()).toEqual([]);
      const invoice = await invoiceOf(paymentId);
      expect(invoice.outcome).toBeNull();
      expect(invoice.provider_paid).toBeNull();
    });

    it('writes nothing for a webhook whose invoice id is not the one on record', async () => {
      const { paymentId, invoice } = await createdAttempt();
      const before = await invoiceOf(paymentId);
      expect(
        await webhook(
          { provider_order_id: invoice.provider_order_id, provider_invoice_id: 'TP-99999999' },
          'completed',
          'forged-1',
        ),
      ).toBe('IGNORED_MISMATCH');
      const after = await invoiceOf(paymentId);
      expect(after.webhook_count).toBe(before.webhook_count);
      expect(after.next_inquiry_at).toEqual(before.next_inquiry_at);
      expect(after.provider_invoice_id).toBe(invoice.provider_invoice_id);
      expect((await paymentOf(paymentId)).state).toBe('PENDING');
    });

    it('does not let a provider amount that differs block an approved payment, nor replace Nexa’s amount', async () => {
      const { orderId, paymentId, invoiceId } = await createdAttempt();
      tonpays.set(invoiceId, 'completed', true); // final_amount is request + 37
      await inquireNow();
      const payment = await paymentOf(paymentId);
      expect(payment.state).toBe('CONFIRMED');
      expect(String(payment.amount)).toBe('250000');
      expect(await orderState(orderId)).toBe('PAID');
      const invoice = await invoiceOf(paymentId);
      expect(String(invoice.request_amount)).toBe('250000');
      expect(String(invoice.final_amount)).toBe('250037');
    });
  });

  describe('the 70-minute deadline', () => {
    it('settles an approval one minute before the deadline and refuses it one second after, recording the anomaly', async () => {
      const early = await createdAttempt();
      await ctx.container.database.db.execute(
        sql`UPDATE payments SET expires_at = now() + interval '60 seconds' WHERE id = ${early.paymentId}`,
      );
      tonpays.set(early.invoiceId, 'completed', true);
      offsetMs += 25_000;
      await pass();
      expect((await paymentOf(early.paymentId)).state).toBe('CONFIRMED');

      const late = await draftOrder();
      const { paymentId } = await payWithGateway(late);
      await pass();
      const invoice = await invoiceOf(paymentId);
      await ctx.container.database.db.execute(
        sql`UPDATE payments SET expires_at = now() - interval '1 second' WHERE id = ${paymentId}`,
      );
      tonpays.set(invoice.provider_invoice_id!, 'completed', true);
      await webhook(invoice, 'completed', 'late');
      offsetMs += 6_000;
      await pass();

      expect((await paymentOf(paymentId)).state).toBe('PENDING');
      expect(await orderState(late)).toBe('AWAITING_PAYMENT');
      const after = await invoiceOf(paymentId);
      expect(after.late_completion_observed_at).not.toBeNull();
      expect(after.outcome).toBe('LATE_COMPLETION');
      const events = await rows<{ code: string }>(
        sql`SELECT code FROM operational_events WHERE code = 'payments.gateway_late_completion'`,
      );
      expect(events).toHaveLength(1);

      // The sweep closes it as it closes every payment, and nothing reopens it.
      await ctx.container.paymentExpirySweep.runOnce(tenantA);
      expect((await paymentOf(paymentId)).state).toBe('EXPIRED');
      await webhook(invoice, 'completed', 'later');
      await inquireNow();
      expect((await paymentOf(paymentId)).state).toBe('EXPIRED');
      expect(await orderState(late)).not.toBe('PAID');
    });

    it('is enforced by the settlement path itself, whatever its caller believes', async () => {
      const { orderId, paymentId } = await createdAttempt();
      await ctx.container.database.db.execute(
        sql`UPDATE payments SET expires_at = now() - interval '1 second' WHERE id = ${paymentId}`,
      );
      // Called directly, as a lane with a wrong clock or a stale read would call it.
      const result = await ctx.container.payments.confirmGatewayPayment(
        tenantA,
        systemActor('direct'),
        paymentId,
        { evidenceNote: 'tonpays:completed:paid' },
      );
      expect(result).toMatchObject({ outcome: 'NOT_ELIGIBLE', reason: 'DEADLINE_PASSED' });
      expect((await paymentOf(paymentId)).state).toBe('PENDING');
      expect(await orderState(orderId)).toBe('AWAITING_PAYMENT');
    });

    it('stops reconciling once the deadline has passed', async () => {
      const { paymentId } = await createdAttempt();
      await ctx.container.database.db.execute(
        sql`UPDATE payments SET expires_at = now() - interval '1 second' WHERE id = ${paymentId}`,
      );
      await inquireNow();
      const checks = tonpays.checks.length;
      await inquireNow();
      await inquireNow();
      expect(tonpays.checks.length).toBe(checks);
      expect((await invoiceOf(paymentId)).next_inquiry_at).toBeNull();
    });
  });

  describe('concurrency', () => {
    it('confirms once when five settlements race for one approval', async () => {
      const { orderId, paymentId } = await createdAttempt();
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          ctx.container.payments.confirmGatewayPayment(
            tenantA,
            systemActor(`race-${String(i)}`),
            paymentId,
            {
              evidenceNote: 'tonpays:completed:paid',
            },
          ),
        ),
      );
      expect(results.filter((r) => r.outcome === 'SETTLED')).toHaveLength(1);
      expect(results.filter((r) => r.outcome === 'ALREADY_CONFIRMED')).toHaveLength(4);
      expect(await orderState(orderId)).toBe('PAID');
    });

    it('settles once when a webhook and two reconciliation replicas race', async () => {
      const { orderId, paymentId, invoice, invoiceId } = await createdAttempt();
      tonpays.set(invoiceId, 'completed', true);
      const other = laneWith(tonpays);
      offsetMs += 6 * 60_000;
      await Promise.all([
        lane.runOnce(tenantA),
        other.runOnce(tenantA),
        webhook(invoice, 'completed', 'race-1'),
        lane.runOnce(tenantA),
      ]);
      await inquireNow();
      expect((await paymentOf(paymentId)).state).toBe('CONFIRMED');
      const settled = await rows<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM outbox_messages WHERE event_type = 'OrderSettled'
            AND aggregate_id = ${orderId}`,
      );
      expect(settled[0]!.n).toBe(1);
    });
  });

  describe('an exhausted call budget', () => {
    const empty: GatewayCallBudget = { take: () => Promise.resolve(false) };
    const claims = async (column: 'creation_claimed_until' | 'inquiry_claimed_until') =>
      (
        await rows<{ claimed: Date | null }>(
          sql`SELECT ${sql.raw(column)} AS claimed FROM gateway_invoices
              WHERE tenant_id = ${tenantA.tenantId} ORDER BY created_at`,
        )
      ).map((row) => row.claimed);

    it('gives back the creation leases it did not reach, so each is retried within seconds', async () => {
      await enableTonPays();
      await payWithGateway(await draftOrder());
      await payWithGateway(await draftOrder(300_000n));
      const starved = await laneWith(tonpays, { budget: empty }).runOnce(tenantA);
      expect(starved.budgetExhausted).toBe(true);
      expect(await claims('creation_claimed_until')).toEqual([null, null]);

      offsetMs += 6_000;
      await pass();
      expect(tonpays.creates).toHaveLength(2);
    });

    it('gives back the inquiry leases it did not reach, the row that met the empty budget included', async () => {
      const first = await createdAttempt();
      const second = await payWithGateway(await draftOrder(300_000n));
      await pass();
      expect((await invoiceOf(second.paymentId)).provider_invoice_id).not.toBeNull();

      offsetMs += 6 * 60_000;
      const starved = await laneWith(tonpays, { budget: empty }).runOnce(tenantA);
      expect(starved.budgetExhausted).toBe(true);
      expect(await claims('inquiry_claimed_until')).toEqual([null, null]);
      expect(tonpays.checks).toHaveLength(0);

      // The promised retry, five seconds out — not a minute later when a lease runs out.
      offsetMs += 6_000;
      await pass();
      expect([...tonpays.checks].sort()).toEqual(
        [first.invoiceId, (await invoiceOf(second.paymentId)).provider_invoice_id!].sort(),
      );
    });
  });

  describe('a wallet top-up', () => {
    it('hands back an open top-up only for the same amount, and opens a new attempt for another', async () => {
      await enableTonPays();
      const scope = { ...tenantA, botInstanceId: BOT_A };
      const topup = (key: string, amountMinor: bigint) =>
        ctx.container.payments.requestGatewayTopup(scope, systemActor(key), maryam, {
          idempotencyKey: key,
          amount: money(amountMinor, 'IRT'),
          provider: 'TONPAYS',
        });
      const fifty = await topup('tu-50', 50_000n);
      const hundred = await topup('tu-100', 100_000n);
      expect(hundred.reissued).toBe(false);
      expect(hundred.payment.id).not.toBe(fifty.payment.id);
      expect(String((await paymentOf(hundred.payment.id)).amount)).toBe('100000');

      const fiftyAgain = await topup('tu-50-again', 50_000n);
      expect(fiftyAgain.reissued).toBe(true);
      expect(fiftyAgain.payment.id).toBe(fifty.payment.id);

      await pass();
      expect(tonpays.creates.map((create) => create.body.amount).sort()).toEqual([100_000, 50_000]);
    });

    it('credits the Nexa amount and the route’s gift exactly once, and nothing for a failed attempt', async () => {
      await enableTonPays({ topupCashbackPercent: 10 });
      const scope = { ...tenantA, botInstanceId: BOT_A };
      const attempt = await ctx.container.payments.requestGatewayTopup(
        scope,
        systemActor('topup-1'),
        maryam,
        { idempotencyKey: 'topup-1', amount: money(100_000n, 'IRT'), provider: 'TONPAYS' },
      );
      expect(attempt.payment.orderId).toBeNull();
      expect(attempt.payment.topupCashbackPercent).toBe(10);
      await pass();
      const invoice = await invoiceOf(attempt.payment.id);
      tonpays.set(invoice.provider_invoice_id!, 'completed', true);
      await webhook(invoice, 'completed', 'tu-1');
      await inquireNow();
      await webhook(invoice, 'completed', 'tu-2');
      await inquireNow();
      await ctx.container.payments.confirmGatewayPayment(
        tenantA,
        systemActor('again'),
        attempt.payment.id,
        {
          evidenceNote: null,
        },
      );

      expect(await ledger()).toEqual([
        { reason: 'CASHBACK_TOPUP', amount: '10000', payment_id: attempt.payment.id },
        { reason: 'TOPUP_GATEWAY', amount: '100000', payment_id: attempt.payment.id },
      ]);
      expect(await notified(attempt.payment.id)).toEqual([
        'WALLET_TOPUP_CREDITED',
        'WALLET_TOPUP_GIFT_CREDITED',
      ]);

      // A second top-up the provider rejects: no credit, no gift.
      const failed = await ctx.container.payments.requestGatewayTopup(
        scope,
        systemActor('topup-2'),
        maryam,
        { idempotencyKey: 'topup-2', amount: money(50_000n, 'IRT'), provider: 'TONPAYS' },
      );
      await pass();
      const failedInvoice = await invoiceOf(failed.payment.id);
      tonpays.set(failedInvoice.provider_invoice_id!, 'rejected', false);
      await inquireNow();
      expect((await paymentOf(failed.payment.id)).state).toBe('FAILED');
      expect(await ledger()).toHaveLength(2);
    });
  });

  describe('tenant isolation', () => {
    it('ignores a webhook that names another tenant, and a tenant’s key reads only for that tenant', async () => {
      const { paymentId, invoice } = await createdAttempt();
      expect(await webhook(invoice, 'completed', 'x-1', String(tenantB.tenantId))).toBe(
        'IGNORED_UNKNOWN',
      );
      expect(
        await webhook(invoice, 'completed', 'x-2', '00000000-0000-7000-8000-000000000000'),
      ).toBe('IGNORED_INACTIVE');
      expect((await invoiceOf(paymentId)).webhook_count).toBe(0);

      const store = new DrizzleGatewayCredentialStore(
        ctx.container.database.db,
        ctx.container.cipher,
        () => ctx.container.ids.uuid(),
      );
      const ownerB = adminActorFor(
        await createAdmin(ctx.container, tenantB, { username: 'owner-tp-b', roleKeys: ['owner'] }),
      );
      await ctx.container.paymentGateways.setCredential(tenantB, ownerB, {
        idempotencyKey: 'tp-cred-b',
        provider: 'TONPAYS',
        apiKey: OTHER_KEY,
      });
      expect(await store.read(tenantA, 'TONPAYS')).toBe(API_KEY);
      expect(await store.read(tenantB, 'TONPAYS')).toBe(OTHER_KEY);
      // A ciphertext transplanted into the other tenant's row does not decrypt.
      await ctx.container.database.db.execute(sql`
        UPDATE payment_gateway_credentials SET api_key_ciphertext =
          (SELECT api_key_ciphertext FROM payment_gateway_credentials WHERE tenant_id = ${tenantA.tenantId})
        WHERE tenant_id = ${tenantB.tenantId}`);
      await expect(store.read(tenantB, 'TONPAYS')).rejects.toThrow();
    });

    it('never resolves one tenant’s order id from another tenant’s webhook URL', async () => {
      const { paymentId, invoice, invoiceId } = await createdAttempt();
      tonpays.set(invoiceId, 'completed', true);
      await webhook(invoice, 'completed', 'x-3', String(tenantB.tenantId));
      await lane.runOnce(tenantB);
      expect((await paymentOf(paymentId)).state).toBe('PENDING');
    });
  });

  describe('the API key', () => {
    it('is refused enablement without one, is never returned, and never reaches a durable log', async () => {
      await expect(
        ctx.container.paymentGateways.setStatus(tenantA, owner, {
          idempotencyKey: 'tp-on-nokey',
          provider: 'TONPAYS',
          status: 'ACTIVE',
        }),
      ).rejects.toSatisfy(
        (error: unknown) =>
          isNexaError(error) && error.code === COMMERCE_ERROR_CODES.PAYMENT_GATEWAY_UNAVAILABLE,
      );

      // A full flow, including a configuration refusal that quotes the key back.
      await enableTonPays();
      tonpays.createMode = { code: 'INVALID_API_KEY', status: 401 };
      await payWithGateway(await draftOrder());
      await pass();

      const listed = await ctx.container.paymentGateways.list(tenantA, owner);
      const facts = listed.facts.get('TONPAYS');
      expect(facts?.credentialSetAt).toBeInstanceOf(Date);
      expect(JSON.stringify([...listed.facts.values()])).not.toContain(API_KEY);
      expect(
        JSON.stringify(listed.gateways, (_k, v: unknown) =>
          typeof v === 'bigint' ? v.toString() : v,
        ),
      ).not.toContain(API_KEY);

      const [stored] = await rows<{ api_key_ciphertext: string }>(
        sql`SELECT api_key_ciphertext FROM payment_gateway_credentials WHERE tenant_id = ${tenantA.tenantId}`,
      );
      expect(stored!.api_key_ciphertext).not.toContain(API_KEY);

      for (const table of [
        'audit_logs',
        'operational_events',
        'outbox_messages',
        'request_idempotency',
        'gateway_invoices',
        'payments',
      ]) {
        const [dump] = await rows<{ text: string }>(
          sql`SELECT coalesce(string_agg(t::text, ' '), '') AS text FROM ${sql.raw(table)} t`,
        );
        expect(dump!.text, table).not.toContain(API_KEY);
      }
    });
  });
});
