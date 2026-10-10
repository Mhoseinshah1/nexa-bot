import { createServer, type Server } from 'node:http';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  classifyListSearch,
  COMMERCE_ERROR_CODES,
  EMPTY_PRODUCT_DISPLAY,
  GATEWAY_ROW_FAILING_CODE,
  GATEWAY_ROW_FAILURE_ALERT_AFTER,
  GATEWAY_ROW_RECOVERED_CODE,
  isNexaError,
  MAX_MONEY_AMOUNT_MINOR,
  money,
  opsLogTopicForCode,
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
import { hashRequest } from '../../apps/api/src/modules/platform/idempotency/infrastructure/drizzle-idempotency-store';
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
  /*
   * F3 (round N): answers the documentation does not rule out and the adapter used to
   * discard — a numeric invoice id and metadata that is null or not a whole number — and a
   * created invoice with no link a customer can open, and an HTML page in front of the API.
   */
  | 'UNDOCUMENTED_METADATA'
  | 'NO_LINK'
  | 'HTML_PAGE'
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
      if (mode === 'HTML_PAGE') {
        return new Response('<!DOCTYPE html><html><body>Access denied</body></html>', {
          status: 403,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      this.seq += 1;
      const invoiceId =
        mode === 'UNDOCUMENTED_METADATA'
          ? String(700_000 + this.seq)
          : `TP-${String(this.seq).padStart(8, '0')}`;
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
      if (mode === 'UNDOCUMENTED_METADATA') {
        return json(201, {
          invoice_id: Number(invoiceId),
          order_id: invoice.orderId,
          request_amount: `${String(invoice.amount)}.0`,
          final_amount: null,
          status: null,
          invoice_url: `https://t.me/TonPaysInvoiceBot?start=inv_${invoiceId}`,
          web_invoice_url: `https://pay.tonpays.online/i/${invoiceId}?p=xyz`,
          callback_url: body.callback_url,
        });
      }
      if (mode === 'NO_LINK') {
        return json(201, {
          invoice_id: invoiceId,
          order_id: invoice.orderId,
          status: 'pending',
          invoice_url: `tg://resolve?domain=TonPaysInvoiceBot&start=inv_${invoiceId}`,
        });
      }
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
  /** Every `sendMessage` body — and, since R2, every `editMessageText` — the bot sent. */
  const sent: Record<string, unknown>[] = [];
  const lastMarkup = () => JSON.stringify(sent[sent.length - 1]?.['reply_markup'] ?? {});
  const lastText = () => String(sent[sent.length - 1]?.['text'] ?? '');
  /**
   * R2: runs when an `editMessageText` reaches "Telegram", BEFORE it is applied — so whatever
   * it does happens between the caller's decision to edit and the edit landing. Answering
   * `RATE_LIMITED` refuses the edit with a 429, which Telegram never applies.
   */
  let beforeEdit: ((body: Record<string, unknown>) => Promise<'RATE_LIMITED' | void>) | null = null;

  beforeAll(async () => {
    telegram = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        void (async () => {
          const url = request.url ?? '';
          let body: Record<string, unknown> | null = null;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
          } catch {
            // a multipart upload; not what these cases read
          }
          if (body !== null && url.includes('/editMessageText') && beforeEdit !== null) {
            if ((await beforeEdit(body)) === 'RATE_LIMITED') {
              response.writeHead(429, { 'content-type': 'application/json' });
              response.end(
                JSON.stringify({
                  ok: false,
                  error_code: 429,
                  description: 'Too Many Requests: retry after 1',
                  parameters: { retry_after: 1 },
                }),
              );
              return;
            }
          }
          if (body !== null && (url.includes('/sendMessage') || url.includes('/editMessageText'))) {
            sent.push(body);
          }
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ ok: true, result: { message_id: 11 } }));
        })();
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
    beforeEdit = null;
    lane = laneWith(tonpays);
  });

  /** A gateway lane over the container's database, with a fake TonPays and a movable clock. */
  function laneWith(
    fake: FakeTonPays,
    overrides: {
      readonly budget?: GatewayCallBudget;
      readonly payments?: GatewayPaymentServiceDeps['payments'];
      /** R2: the customer's invoice message, edited by the worker once the invoice is ready. */
      readonly invoiceScreens?: GatewayPaymentServiceDeps['invoiceScreens'];
      /** FIX10: a wrapped adapter, so a case can make one row's call throw. */
      readonly adapter?: TonPaysAdapter;
      readonly logger?: GatewayPaymentServiceDeps['logger'];
    } = {},
  ): GatewayPaymentService {
    const db = ctx.container.database.db;
    const adapter = overrides.adapter ?? new TonPaysAdapter({ fetch: fake.fetch });
    const origins = new DrizzlePublicOriginReader(db);
    return new GatewayPaymentService({
      invoices: new DrizzleGatewayInvoiceRepository(db),
      payments: overrides.payments ?? ctx.container.payments,
      paymentRecords: new DrizzlePaymentRepository(db),
      adapters: (provider) => (provider === 'TONPAYS' ? adapter : null),
      credentials: new DrizzleGatewayCredentialStore(db, ctx.container.cipher, () =>
        ctx.container.ids.uuid(),
      ),
      // TonPays sends its invoices with its own key; neither of these is reached for it.
      botTokens: { tokenForBotInstance: () => Promise.resolve(null) },
      presentation: () => Promise.reject(new Error('TonPays renders no invoice text')),
      budget: overrides.budget ?? new DrizzleGatewayCallBudget(db),
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
      logger: overrides.logger ?? {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      ...(overrides.invoiceScreens === undefined
        ? {}
        : { invoiceScreens: overrides.invoiceScreens }),
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

  const tap = (data: string) => tapOn(null, data);

  /** A tap on one message by its id; null taps a message nothing has tracked before. */
  const tapOn = (messageId: number | null, data: string) => {
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
            message_id: messageId ?? updateSeq,
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

    /*
     * R2 (v0.3.5 real-test item 4): the customer taps the gateway, sees the loading screen,
     * and the SAME message becomes the invoice — amount, deadline, the pay link, the status
     * check and the main menu — as soon as the worker has created it. No status-check tap.
     */
    it('R2: edits the tapped message into the ready invoice without a status-check tap', async () => {
      await enableTonPays();
      lane = laneWith(tonpays, { invoiceScreens: ctx.container.wizardScreens });
      const orderId = await draftOrder();
      const { paymentId } = await payWithGateway(orderId);
      const message = updateSeq;
      const onMessage = () => sent.filter((body) => body['message_id'] === message);
      expect(onMessage().at(-1)?.['text']).toContain('در حال ساخت');
      const checksBefore = tonpays.checks.length;

      await pass();

      const invoice = await invoiceOf(paymentId);
      const ready = onMessage().at(-1);
      expect(ready?.['text']).toContain('250,000');
      expect(ready?.['text']).toContain('مهلت پرداخت');
      const markup = JSON.stringify(ready?.['reply_markup'] ?? {});
      expect(markup).toContain(`"url":"${invoice.web_invoice_url!}"`);
      expect(markup).toContain(`gc:${paymentId}`);
      expect(markup).toContain('"callback_data":"mm:"');
      // Nobody tapped «بررسی وضعیت پرداخت»: the worker created it and edited the message.
      expect(tonpays.checks.length).toBe(checksBefore);
      const [wizard] = await rows<{ step: string }>(
        sql`SELECT step FROM telegram_wizards WHERE payment_id = ${paymentId}`,
      );
      expect(wizard?.step).toBe('INVOICE');
    });

    it('R2: a create whose answer was lost edits the same message into a truthful end, never re-sent', async () => {
      await enableTonPays();
      lane = laneWith(tonpays, { invoiceScreens: ctx.container.wizardScreens });
      tonpays.createMode = 'SERVER_ERROR';
      const orderId = await draftOrder();
      const { paymentId } = await payWithGateway(orderId);
      const message = updateSeq;

      await pass();
      await pass();

      const last = sent.filter((body) => body['message_id'] === message).at(-1);
      expect(String(last?.['text'])).toContain('پاسخ درگاه');
      const markup = JSON.stringify(last?.['reply_markup'] ?? {});
      expect(markup).toContain(`pm:${orderId}`);
      expect(markup).not.toContain('"url"');
      // TonPays rule three: the lost create is never retried and never re-keyed.
      expect(tonpays.creates).toHaveLength(1);
      expect((await invoiceOf(paymentId)).creation_state).toBe('CREATE_UNKNOWN');
    });

    /*
     * R2 finding F1: the turn LANDS its loading screen before it edits the message. A worker
     * that commits the attempt's end in between must not be able to claim that landing —
     * it would edit the end in, and the turn's loading edit would then bury it for ever
     * under "the link will appear here", with a check button whose gate no longer matched.
     */
    it('R2: an end the worker commits between the turn landing the loading screen and its edit ends on the end screen, not the loading screen', async () => {
      await enableTonPays();
      lane = laneWith(tonpays, { invoiceScreens: ctx.container.wizardScreens });
      const orderId = await draftOrder();
      tonpays.createMode = { code: 'INVALID_API_KEY', status: 401 };
      let raced = false;
      beforeEdit = async (body) => {
        if (!String(body['text']).includes('در حال ساخت')) return;
        beforeEdit = null;
        // The loading edit has been asked for and not applied: the worker runs now.
        await pass();
        raced = true;
      };
      const { paymentId } = await payWithGateway(orderId);
      const message = updateSeq;
      expect(raced).toBe(true);
      expect((await paymentOf(paymentId)).state).toBe('FAILED');

      const onMessage = sent.filter((body) => body['message_id'] === message);
      const last = onMessage.at(-1);
      expect(String(last?.['text'])).not.toContain('در حال ساخت');
      const markup = JSON.stringify(last?.['reply_markup'] ?? {});
      expect(markup).toContain(`pm:${orderId}`);
      expect(markup).not.toContain('gc:');
      const [wizard] = await rows<{ step: string }>(
        sql`SELECT step FROM telegram_wizards WHERE payment_id = ${paymentId}`,
      );
      expect(wizard?.step).toBe('NOTICE');

      // The end screen's own button is honoured: back to choosing how to pay.
      const back = await tapOn(message, `pm:${orderId}`);
      expect(back.replyKey).not.toBeNull();
    });

    /*
     * The loading screen is HELD by the turn that landed it until that turn marks it: a check
     * tap arriving in between is stale, so it cannot draw the attempt's end and then have the
     * turn's loading edit land on top. A turn that died in between frees it with its lease,
     * and then the loading screen's check button is what recovers it.
     */
    it('R2: a check tap on a loading screen its turn still holds is stale; once the hold lapses it renders the attempt', async () => {
      await enableTonPays();
      lane = laneWith(tonpays, { invoiceScreens: ctx.container.wizardScreens });
      const orderId = await draftOrder();
      tonpays.createMode = { code: 'INVALID_API_KEY', status: 401 };
      let paymentId = '';
      let inBetween: Awaited<ReturnType<typeof tapOn>> | null = null;
      beforeEdit = async (body) => {
        if (!String(body['text']).includes('در حال ساخت')) return;
        beforeEdit = null;
        await pass();
        const [row] = await rows<{ id: string }>(
          sql`SELECT id FROM payments WHERE order_id = ${orderId} AND method = 'GATEWAY'`,
        );
        paymentId = row?.id ?? '';
        inBetween = await tapOn(Number(body['message_id']), `gc:${paymentId}`);
      };
      await payWithGateway(orderId);
      const message = updateSeq - 1;
      expect(inBetween).not.toBeNull();
      expect(inBetween!.replyKey).toBeNull();
      expect(
        String(sent.filter((body) => body['message_id'] === message).at(-1)?.['text']),
      ).not.toContain('در حال ساخت');

      // A turn that died between its landing and its mark: the landing, held, never marked.
      await ctx.container.database.db.execute(
        sql`UPDATE telegram_wizards SET step = 'INVOICE_LOADING', busy_until = now() - interval '1 second'
            WHERE payment_id = ${paymentId}`,
      );
      sent.length = 0;
      const recovered = await tapOn(message, `gc:${paymentId}`);
      expect(recovered.replyKey).not.toBeNull();
      expect(JSON.stringify(sent.at(-1)?.['reply_markup'] ?? {})).toContain(`pm:${orderId}`);
      const [wizard] = await rows<{ step: string }>(
        sql`SELECT step FROM telegram_wizards WHERE payment_id = ${paymentId}`,
      );
      expect(wizard?.step).toBe('NOTICE');
    });

    /*
     * A turn marks only the loading screen IT landed. Another message showing the same attempt
     * whose own turn still holds it at INVOICE_LOADING has not had its loading edit yet: marked
     * by this turn, it could be edited into the invoice and then buried by that edit.
     */
    it('R2: a turn marks only its own loading screen, never another message’s held landing of the same attempt', async () => {
      await enableTonPays();
      lane = laneWith(tonpays, { invoiceScreens: ctx.container.wizardScreens });
      const orderId = await draftOrder();
      beforeEdit = async (body) => {
        if (!String(body['text']).includes('در حال ساخت')) return;
        beforeEdit = null;
        // Another turn's landing of this attempt on message 424242, held and not yet edited.
        await ctx.container.database.db.execute(
          sql`INSERT INTO telegram_wizards (id, tenant_id, bot_instance_id, chat_id, message_id,
                kind, step, version, payment_id, busy_until, created_at, updated_at)
              SELECT gen_random_uuid(), tenant_id, ${BOT_A}, ${MARYAM}, 424242, 'ORDER',
                'INVOICE_LOADING', 1, id, now() + interval '30 seconds', now(), now()
              FROM payments WHERE order_id = ${orderId} AND method = 'GATEWAY'`,
        );
      };
      const { paymentId } = await payWithGateway(orderId);
      const steps = await rows<{ message_id: string; step: string }>(
        sql`SELECT message_id::text AS message_id, step FROM telegram_wizards
            WHERE payment_id = ${paymentId} ORDER BY message_id`,
      );
      expect(steps).toEqual([
        { message_id: String(updateSeq), step: 'INVOICE_PENDING' },
        { message_id: '424242', step: 'INVOICE_LOADING' },
      ]);
    });

    /*
     * R2 finding F4: a worker edit Telegram answers with a 429 was NOT applied. The wizard is
     * put back on the step whose screen the message still shows, so that screen's check
     * button — the loading screen carries it — renders the committed attempt in place.
     */
    it('R2: a worker edit Telegram rate-limited puts the wizard back, and the loading screen’s check button finishes it', async () => {
      await enableTonPays();
      lane = laneWith(tonpays, { invoiceScreens: ctx.container.wizardScreens });
      const orderId = await draftOrder();
      tonpays.createMode = { code: 'INVALID_API_KEY', status: 401 };
      const { paymentId } = await payWithGateway(orderId);
      const message = updateSeq;
      const onMessage = () => sent.filter((body) => body['message_id'] === message);
      const stepOf = async () =>
        (
          await rows<{ step: string }>(
            sql`SELECT step FROM telegram_wizards WHERE payment_id = ${paymentId}`,
          )
        )[0]?.step;
      expect(await stepOf()).toBe('INVOICE_PENDING');
      expect(JSON.stringify(onMessage().at(-1)?.['reply_markup'] ?? {})).toContain(
        `gc:${paymentId}`,
      );

      let limited = 0;
      beforeEdit = () => {
        limited += 1;
        beforeEdit = null;
        return Promise.resolve('RATE_LIMITED');
      };
      await pass();
      expect(limited).toBe(1);
      expect((await paymentOf(paymentId)).state).toBe('FAILED');
      // Still the loading screen, and still at the step whose check button it carries.
      expect(String(onMessage().at(-1)?.['text'])).toContain('در حال ساخت');
      expect(await stepOf()).toBe('INVOICE_PENDING');

      const checked = await tapOn(message, `gc:${paymentId}`);
      expect(checked.replyKey).not.toBeNull();
      expect(String(onMessage().at(-1)?.['text'])).not.toContain('در حال ساخت');
      expect(JSON.stringify(onMessage().at(-1)?.['reply_markup'] ?? {})).toContain(`pm:${orderId}`);
      expect(await stepOf()).toBe('NOTICE');
    });

    /*
     * F3 (round N) — the real v0.3.6 failure: purchase and top-up both showed the loading
     * screen, then «پاسخ درگاه ... دریافت نشد». Every case above builds its OWN lane over an
     * injected `fetch`; none ran the lane production runs. These drive the CONTAINER's own
     * `gatewayPaymentLoop` — the worker's loop, its `GatewayPaymentService`, its
     * `TonPaysAdapter` on the real global `fetch`, its `WizardInvoiceScreens` — and replace
     * nothing but the network: `https://tonpays.online` answers from the fake, every other
     * request (the Telegram stand-in) goes out as it would.
     */
    async function onProductionNetwork<T>(run: () => Promise<T>): Promise<T> {
      const original = globalThis.fetch;
      globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        return url.startsWith('https://tonpays.online/')
          ? tonpays.fetch(url, init ?? {})
          : original(input, init);
      }) as typeof fetch;
      try {
        return await run();
      } finally {
        globalThis.fetch = original;
      }
    }
    const workerPass = () => ctx.container.gatewayPaymentLoop.tick();
    const wizardStep = async (paymentId: string) =>
      (
        await rows<{ step: string }>(
          sql`SELECT step FROM telegram_wizards WHERE payment_id = ${paymentId}`,
        )
      ).map((row) => row.step);
    const typed = (value: string) => {
      updateSeq += 1;
      return ctx.container.botRuntime.handle(tenantA, systemActor('bot'), {
        idempotencyKey: `tp-update-${String(updateSeq)}`,
        botInstanceId: BOT_A,
        update: {
          update_id: updateSeq,
          message: {
            message_id: updateSeq,
            date: 0,
            chat: { id: Number(MARYAM), type: 'private' },
            from: { id: Number(MARYAM), first_name: 'مریم', is_bot: false },
            text: value,
          },
        },
        telegramUserId: MARYAM,
        from: { id: Number(MARYAM), first_name: 'مریم' },
      });
    };

    it('F3: the production lane edits the purchase wizard into the ready invoice, with no tap', async () => {
      await enableTonPays();
      await onProductionNetwork(async () => {
        const orderId = await draftOrder();
        const { paymentId } = await payWithGateway(orderId);
        const message = updateSeq;
        const onMessage = () => sent.filter((body) => body['message_id'] === message);
        expect(String(onMessage().at(-1)?.['text'])).toContain('در حال ساخت');

        await workerPass();

        const invoice = await invoiceOf(paymentId);
        expect(invoice.creation_state).toBe('CREATED');
        const ready = onMessage().at(-1);
        expect(String(ready?.['text'])).toContain('250,000');
        expect(String(ready?.['text'])).toContain('مهلت پرداخت');
        const markup = JSON.stringify(ready?.['reply_markup'] ?? {});
        expect(markup).toContain(`"url":"${invoice.web_invoice_url!}"`);
        expect(markup).toContain(`gc:${paymentId}`);
        expect(markup).toContain('"callback_data":"mm:"');
        expect(await wizardStep(paymentId)).toEqual(['INVOICE']);
        expect(tonpays.checks).toHaveLength(0);
      });
    });

    it('F3: the production lane edits the wallet top-up wizard into the ready invoice, with no tap', async () => {
      await enableTonPays();
      await onProductionNetwork(async () => {
        await tap('o:');
        const message = updateSeq;
        await typed('75000');
        const route = [
          ...JSON.stringify(sent.at(-1)?.['reply_markup'] ?? {}).matchAll(
            /"callback_data":"(tp:[^"]+\.TONPAYS)"/gu,
          ),
        ][0]?.[1];
        expect(route).toBeDefined();
        await tapOn(message, route ?? '');
        const [payment] = await rows<{ id: string }>(
          sql`SELECT id FROM payments WHERE tenant_id = ${tenantA.tenantId} AND order_id IS NULL
              AND method = 'GATEWAY'`,
        );
        expect(payment).toBeDefined();
        const paymentId = payment!.id;
        const onMessage = () => sent.filter((body) => body['message_id'] === message);
        expect(String(onMessage().at(-1)?.['text'])).toContain('در حال ساخت');

        await workerPass();

        const invoice = await invoiceOf(paymentId);
        expect(invoice.creation_state).toBe('CREATED');
        const ready = onMessage().at(-1);
        expect(String(ready?.['text'])).toContain('75,000');
        expect(String(ready?.['text'])).toContain('مهلت پرداخت');
        const markup = JSON.stringify(ready?.['reply_markup'] ?? {});
        expect(markup).toContain(`"url":"${invoice.web_invoice_url!}"`);
        expect(markup).toContain(`gc:${paymentId}`);
        expect(markup).toContain('"callback_data":"mm:"');
        expect(await wizardStep(paymentId)).toEqual(['INVOICE']);
      });
    });

    it('F3: a created invoice whose ids and metadata come in undocumented shapes is still the invoice, and renders', async () => {
      await enableTonPays();
      tonpays.createMode = 'UNDOCUMENTED_METADATA';
      await onProductionNetwork(async () => {
        const orderId = await draftOrder();
        const { paymentId } = await payWithGateway(orderId);
        const message = updateSeq;

        await workerPass();

        const invoice = await invoiceOf(paymentId);
        expect(invoice.creation_state).toBe('CREATED');
        expect(invoice.provider_invoice_id).toMatch(/^7\d{5}$/u);
        // Metadata of a shape nobody documented is recorded as absent, never invented.
        expect(invoice.request_amount).toBeNull();
        expect(invoice.final_amount).toBeNull();
        expect((await paymentOf(paymentId)).external_reference).toBe(invoice.provider_invoice_id);
        const ready = sent.filter((body) => body['message_id'] === message).at(-1);
        expect(JSON.stringify(ready?.['reply_markup'] ?? {})).toContain(
          `"url":"${invoice.web_invoice_url!}"`,
        );

        // And the inquiry reads the same numeric id back and settles on completed + paid.
        tonpays.set(invoice.provider_invoice_id!, 'completed', true);
        offsetMs += 6 * 60_000;
        await pass();
        expect((await paymentOf(paymentId)).state).toBe('CONFIRMED');
      });
    });

    it('F3: a create answered without a payable link says so, never fabricates one, and the retry opens a new attempt', async () => {
      await enableTonPays();
      tonpays.createMode = 'NO_LINK';
      await onProductionNetwork(async () => {
        const orderId = await draftOrder();
        const { paymentId } = await payWithGateway(orderId);
        const message = updateSeq;

        await workerPass();

        const invoice = await invoiceOf(paymentId);
        expect(invoice.creation_state).toBe('CREATED');
        expect(invoice.web_invoice_url).toBeNull();
        expect(invoice.invoice_url).toBeNull();
        const [row] = await rows<{ creation_error_code: string | null }>(
          sql`SELECT creation_error_code FROM gateway_invoices WHERE payment_id = ${paymentId}`,
        );
        expect(row?.creation_error_code).toBe('nexa.no_payment_link');
        const end = sent.filter((body) => body['message_id'] === message).at(-1);
        expect(String(end?.['text'])).toContain('لینک پرداختی برای آن نفرستاد');
        expect(String(end?.['text'])).not.toContain('دریافت نشد');
        const markup = JSON.stringify(end?.['reply_markup'] ?? {});
        expect(markup).not.toContain('"url"');
        expect(markup).toContain(`pm:${orderId}`);

        // The way on: the methods, then the gateway again — a NEW attempt, not this one.
        tonpays.createMode = 'OK';
        await tapOn(message, `pm:${orderId}`);
        await tapOn(message, `g:${orderId}`);
        const attempts = await rows<{ id: string }>(
          sql`SELECT id FROM payments WHERE order_id = ${orderId} AND method = 'GATEWAY'
              ORDER BY created_at`,
        );
        expect(attempts.map((one) => one.id)).toHaveLength(2);
        expect(attempts[1]!.id).not.toBe(paymentId);
        await workerPass();
        const second = await invoiceOf(attempts[1]!.id);
        expect(second.creation_state).toBe('CREATED');
        expect(
          JSON.stringify(
            sent.filter((body) => body['message_id'] === message).at(-1)?.['reply_markup'] ?? {},
          ),
        ).toContain(`"url":"${second.web_invoice_url!}"`);
      });
    });

    it('F3: a create answered by an HTML page is a truthful end with no link, and the operator reads why', async () => {
      await enableTonPays();
      tonpays.createMode = 'HTML_PAGE';
      await onProductionNetwork(async () => {
        const orderId = await draftOrder();
        const { paymentId } = await payWithGateway(orderId);
        const message = updateSeq;

        await workerPass();

        const [row] = await rows<{ creation_state: string; creation_error_code: string | null }>(
          sql`SELECT creation_state, creation_error_code FROM gateway_invoices
              WHERE payment_id = ${paymentId}`,
        );
        expect(row).toEqual({
          creation_state: 'CREATE_UNKNOWN',
          creation_error_code: 'http.403.unreadable.html',
        });
        const events = await rows<{ context: Record<string, unknown> }>(
          sql`SELECT context FROM operational_events WHERE tenant_id = ${tenantA.tenantId}
              AND code = 'payments.gateway_create_unknown'`,
        );
        expect(events[0]?.context).toMatchObject({ reason: 'http.403.unreadable.html' });
        expect(typeof events[0]?.context['elapsedMs']).toBe('number');
        expect(JSON.stringify(events)).not.toContain(API_KEY);

        const end = sent.filter((body) => body['message_id'] === message).at(-1);
        expect(String(end?.['text'])).toContain('پاسخ درگاه');
        expect(JSON.stringify(end?.['reply_markup'] ?? {})).not.toContain('"url"');
        expect(JSON.stringify(end?.['reply_markup'] ?? {})).toContain(`pm:${orderId}`);
        // TonPays rule three: never sent again.
        await workerPass();
        expect(tonpays.creates).toHaveLength(1);
        expect((await paymentOf(paymentId)).state).toBe('PENDING');
      });
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

    /*
     * FIX-02 (2026-10-09): the public tracking code — the operation-id half of the stored
     * `<id>:gateway` reference — is on the invoice before anything is paid, on every later
     * screen of the same payment, through a rate-limited retry, and findable by an operator.
     * The stored reference itself, suffix and all, never reaches the customer.
     */
    async function codeOf(paymentId: string): Promise<{ code: string; reference: string }> {
      const [row] = await rows<{ reference: string }>(
        sql`SELECT reference FROM payments WHERE id = ${paymentId}`,
      );
      if (row === undefined) throw new Error('no payment');
      expect(row.reference).toMatch(/^[0-9a-f]{16}:gateway$/u);
      return { code: row.reference.split(':')[0]!, reference: row.reference };
    }

    it('FIX-02: the preparing screen, the invoice and the confirmation carry ONE code, never the stored reference', async () => {
      await enableTonPays();
      const orderId = await draftOrder();
      const { paymentId } = await payWithGateway(orderId);
      const { code, reference } = await codeOf(paymentId);
      expect(lastText()).toContain(`کد پیگیری پرداخت: ${code}`);
      expect(lastText()).not.toContain(reference);
      expect(lastText()).not.toContain(':gateway');

      await pass();
      await tap(`gc:${paymentId}`);
      expect(lastMarkup()).toContain('"url"');
      expect(lastText()).toContain(`کد پیگیری پرداخت: ${code}`);
      expect(lastText()).not.toContain(':gateway');

      const invoice = await invoiceOf(paymentId);
      tonpays.invoices.get(invoice.provider_invoice_id!)!.status = 'completed';
      tonpays.invoices.get(invoice.provider_invoice_id!)!.paid = true;
      await inquireNow();
      expect((await paymentOf(paymentId)).state).toBe('CONFIRMED');
      await tap(`gc:${paymentId}`);
      expect(lastText()).toContain(`کد پیگیری پرداخت: ${code}`);
      expect((await codeOf(paymentId)).reference).toBe(reference);
    });

    it('FIX-02: a rate-limited create retried later keeps the SAME payment and the SAME code', async () => {
      await enableTonPays();
      const orderId = await draftOrder();
      tonpays.createMode = { code: 'RATE_LIMIT_EXCEEDED', status: 429 };
      const { paymentId } = await payWithGateway(orderId);
      const { code } = await codeOf(paymentId);
      await pass();
      await tap(`gc:${paymentId}`);
      expect(lastText()).toContain(`کد پیگیری پرداخت: ${code}`);

      tonpays.createMode = 'OK';
      offsetMs += 20_000;
      await pass();
      await tap(`gc:${paymentId}`);
      expect(lastMarkup()).toContain('"url"');
      expect(lastText()).toContain(`کد پیگیری پرداخت: ${code}`);
      const payments = await rows<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM payments WHERE order_id = ${orderId}`,
      );
      expect(payments[0]?.n).toBe(1);
      // A second tap of the gateway button hands back the open attempt: no second code.
      await tap(`g:${orderId}`);
      expect(lastText()).toContain(`کد پیگیری پرداخت: ${code}`);
    });

    it('FIX-02: a create whose answer was lost says so with the attempt’s code; the next attempt is a new payment with its own', async () => {
      await enableTonPays();
      const orderId = await draftOrder();
      tonpays.createMode = 'TIMEOUT_AFTER_CREATING';
      const { paymentId } = await payWithGateway(orderId);
      const { code } = await codeOf(paymentId);
      await pass();
      await tap(`gc:${paymentId}`);
      expect((await invoiceOf(paymentId)).creation_state).toBe('CREATE_UNKNOWN');
      expect(lastText()).toContain(`کد پیگیری پرداخت: ${code}`);
      // The lost create is never re-sent and its code never changes.
      await inquireNow();
      expect((await codeOf(paymentId)).code).toBe(code);

      // Choosing the gateway again opens a NEW attempt — a new payment, so its own code —
      // and the old one keeps the code its screens showed.
      tonpays.createMode = 'OK';
      const next = await payWithGateway(orderId);
      expect(next.paymentId).not.toBe(paymentId);
      const fresh = await codeOf(next.paymentId);
      expect(fresh.code).not.toBe(code);
      expect(lastText()).toContain(`کد پیگیری پرداخت: ${fresh.code}`);
      expect((await codeOf(paymentId)).code).toBe(code);
    });

    it('FIX-02: a tenant override saved before the code was required still shows it, once; the stored body is not rewritten', async () => {
      await enableTonPays();
      // Saved through the service (which now requires {reference}), then set back to the shape
      // an override stored before FIX-02 has: no {reference} at all.
      await ctx.container.templatesService.set(tenantA, owner, {
        key: 'bot.payment.gateway_invoice',
        body: 'فاکتور قدیمی: {total} تا {expiresAt} — {reference}',
        expectedVersion: null,
        expectedRevision: null,
        idempotencyKey: 'fix02-override',
      });
      const oldBody = 'فاکتور قدیمی: {total} تا {expiresAt}';
      await ctx.container.database.db.execute(
        sql`UPDATE template_overrides SET body = ${oldBody}
             WHERE tenant_id = ${tenantA.tenantId} AND template_key = 'bot.payment.gateway_invoice'`,
      );
      const orderId = await draftOrder();
      const { paymentId } = await payWithGateway(orderId);
      const { code } = await codeOf(paymentId);
      await pass();
      await tap(`gc:${paymentId}`);
      expect(lastText()).toContain('فاکتور قدیمی:');
      expect(lastText().split(`کد پیگیری پرداخت: ${code}`)).toHaveLength(2);
      const [stored] = await rows<{ body: string }>(
        sql`SELECT body FROM template_overrides
             WHERE tenant_id = ${tenantA.tenantId} AND template_key = 'bot.payment.gateway_invoice'`,
      );
      expect(stored?.body).toBe(oldBody);
    });

    it('FIX-02: an operator finds the payment by the code the customer quotes, and by an old suffixed reference', async () => {
      await enableTonPays();
      const orderId = await draftOrder();
      const { paymentId } = await payWithGateway(orderId);
      const { code, reference } = await codeOf(paymentId);
      for (const typed of [code, code.toUpperCase(), ` ${code} `, reference]) {
        const page = await ctx.container.payments.list(tenantA, owner, {
          limit: 20,
          search: { text: classifyListSearch(typed)! },
        });
        expect(
          page.items.map((item) => item.id),
          typed,
        ).toEqual([paymentId]);
      }
      const byFilter = await ctx.container.payments.list(tenantA, owner, {
        limit: 20,
        search: { reference: code },
      });
      expect(byFilter.items.map((item) => item.id)).toEqual([paymentId]);
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
      // FIX-03: an order's payment is never announced, or credited, as a wallet top-up.
      expect(await notified(paymentId)).not.toContain('WALLET_TOPUP_CREDITED');
      expect((await ledger()).filter((entry) => entry.payment_id === paymentId)).toEqual([]);
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
          recordProviderReview: (...args) => ctx.container.payments.recordProviderReview(...args),
          recordProviderFundsDetected: (...args) =>
            ctx.container.payments.recordProviderFundsDetected(...args),
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
      // FIX10 BUG-1: the row's failure is isolated and counted, never the whole pass's.
      expect((await flaky.runOnce(tenantA)).rowFailures).toBe(1);
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

    /*
     * FIX10 BUG-1 (audit probe `probe-poison-row`): one row whose processing throws used to
     * throw the whole pass. The rows claimed with it were never processed, it kept the oldest
     * `next_inquiry_at`, and the same batch was claimed and abandoned on every pass — a paid
     * attempt beside it stayed PENDING for as long as the poison lasted.
     */
    it('FIX10 BUG-1: a row whose inquiry throws is backed off, and the paid row claimed with it settles in the same pass', async () => {
      const first = await createdAttempt();
      const secondOrderId = await draftOrder(300_000n);
      const second = await payWithGateway(secondOrderId);
      await pass();
      const secondInvoiceId = (await invoiceOf(second.paymentId)).provider_invoice_id!;
      // Deterministic order: the poisoned row is due first.
      await ctx.container.database.db.execute(
        sql`UPDATE gateway_invoices SET next_inquiry_at = now() - interval '1 hour' WHERE payment_id = ${first.paymentId}`,
      );
      tonpays.set(secondInvoiceId, 'completed', true);
      const real = new TonPaysAdapter({ fetch: tonpays.fetch });
      const poisoned = Object.create(real) as TonPaysAdapter;
      let poison = true;
      (poisoned as unknown as { inquire: unknown }).inquire = (
        apiKey: string,
        invoiceId: string,
      ) =>
        poison && invoiceId === first.invoiceId
          ? Promise.reject(
              Object.assign(new Error(`boom ${apiKey}`), { code: '40P01', detail: apiKey }),
            )
          : real.inquire(apiKey, invoiceId);
      const errors: string[] = [];
      const poisonLane = laneWith(tonpays, {
        adapter: poisoned,
        logger: {
          info: () => undefined,
          warn: () => undefined,
          error: (context, message) => errors.push(`${message} ${JSON.stringify(context)}`),
        },
      });

      offsetMs += 6 * 60_000;
      const laneNow = Date.now() + offsetMs;
      const report = await poisonLane.runOnce(tenantA);
      expect(report.rowFailures).toBe(1);
      expect(report.settled).toBe(1);
      expect((await paymentOf(second.paymentId)).state).toBe('CONFIRMED');

      // The failing row: nothing decided about it — not failed, not UNKNOWN, no outcome —
      // its lease given back and its next inquiry pushed behind the back-off.
      expect((await paymentOf(first.paymentId)).state).toBe('PENDING');
      const [backedOff] = await rows<{
        outcome: string | null;
        inquiry_claimed_until: string | null;
        next_inquiry_at: string;
        inquiry_attempts: number;
      }>(
        sql`SELECT outcome, inquiry_claimed_until, next_inquiry_at, inquiry_attempts
            FROM gateway_invoices WHERE payment_id = ${first.paymentId}`,
      );
      expect(backedOff?.outcome).toBeNull();
      expect(backedOff?.inquiry_claimed_until).toBeNull();
      expect(new Date(backedOff!.next_inquiry_at).getTime()).toBeGreaterThanOrEqual(
        laneNow + 30_000,
      );
      // A local exception is not an answer: no inquiry was recorded for it.
      expect(backedOff?.inquiry_attempts).toBe(0);

      // Logged with its ids and the machine code only — never the message, detail or key.
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain(first.paymentId);
      expect(errors[0]).toContain('"code":"40P01"');
      expect(errors[0]).not.toContain('boom');
      expect(errors[0]).not.toContain(API_KEY);

      // Not due again before the back-off: a pass right now does not ask about it.
      const checksBefore = tonpays.checks.length;
      await poisonLane.runOnce(tenantA);
      expect(tonpays.checks.slice(checksBefore)).not.toContain(first.invoiceId);

      // The fault cleared, the row is asked again after its back-off and settles once.
      poison = false;
      tonpays.set(first.invoiceId, 'completed', true);
      offsetMs += 6 * 60_000;
      await poisonLane.runOnce(tenantA);
      expect((await paymentOf(first.paymentId)).state).toBe('CONFIRMED');
      for (const orderId of [first.orderId, secondOrderId]) {
        const settled = await rows<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM outbox_messages WHERE event_type = 'OrderSettled'
              AND aggregate_id = ${orderId}`,
        );
        expect(settled[0]!.n).toBe(1);
      }
    });

    /*
     * Codex #268 B: a verified webhook that lands while the row is claimed writes the row
     * without touching its lease — and, bringing the schedule only FORWARD, without moving a
     * `next_inquiry_at` that is already due. A back-off that then wrote `retryAt`
     * unconditionally suppressed the inquiry the webhook asked for, by up to five minutes.
     */
    it('Codex #268 B: a webhook that lands between the claim and the throw keeps the row due; the back-off does not swallow it', async () => {
      const first = await createdAttempt();
      await ctx.container.database.db.execute(
        sql`UPDATE gateway_invoices SET next_inquiry_at = now() - interval '1 hour' WHERE payment_id = ${first.paymentId}`,
      );
      const real = new TonPaysAdapter({ fetch: tonpays.fetch });
      const poisoned = Object.create(real) as TonPaysAdapter;
      let poison = true;
      let hinted = 0;
      (poisoned as unknown as { inquire: unknown }).inquire = async (
        apiKey: string,
        invoiceId: string,
      ) => {
        if (!poison || invoiceId !== first.invoiceId) return real.inquire(apiKey, invoiceId);
        // The customer paid; the provider's webhook arrives while this row is claimed …
        expect(await webhook(first.invoice, 'completed', `mid-claim-${hinted}`)).toBe('SCHEDULED');
        hinted += 1;
        // … and then this row's processing throws, before anything is recorded.
        throw Object.assign(new Error('boom'), { code: '40P01' });
      };
      const poisonLane = laneWith(tonpays, { adapter: poisoned });

      offsetMs += 6 * 60_000;
      const laneNow = Date.now() + offsetMs;
      expect((await poisonLane.runOnce(tenantA)).rowFailures).toBe(1);
      expect(hinted).toBe(1);
      const [after] = await rows<{
        inquiry_claimed_until: string | null;
        next_inquiry_at: string;
        last_webhook_at: string | null;
      }>(
        sql`SELECT inquiry_claimed_until, next_inquiry_at, last_webhook_at
            FROM gateway_invoices WHERE payment_id = ${first.paymentId}`,
      );
      expect(after?.last_webhook_at).not.toBeNull();
      // Lease given back, and still due: NOT pushed behind the 30-second back-off floor.
      expect(after?.inquiry_claimed_until).toBeNull();
      expect(new Date(after!.next_inquiry_at).getTime()).toBeLessThanOrEqual(laneNow);

      // The very next pass — no time passes — asks again and the provider's answer settles it.
      poison = false;
      tonpays.set(first.invoiceId, 'completed', true);
      await poisonLane.runOnce(tenantA);
      expect((await paymentOf(first.paymentId)).state).toBe('CONFIRMED');

      // The control: the same throw with NO webhook in between is backed off as before.
      const second = await createdAttempt(300_000n);
      await ctx.container.database.db.execute(
        sql`UPDATE gateway_invoices SET next_inquiry_at = now() - interval '1 hour' WHERE payment_id = ${second.paymentId}`,
      );
      const quiet = Object.create(real) as TonPaysAdapter;
      (quiet as unknown as { inquire: unknown }).inquire = (apiKey: string, invoiceId: string) =>
        invoiceId === second.invoiceId
          ? Promise.reject(Object.assign(new Error('boom'), { code: '40P01' }))
          : real.inquire(apiKey, invoiceId);
      offsetMs += 6 * 60_000;
      const quietNow = Date.now() + offsetMs;
      expect((await laneWith(tonpays, { adapter: quiet }).runOnce(tenantA)).rowFailures).toBe(1);
      const [backedOff] = await rows<{ next_inquiry_at: string }>(
        sql`SELECT next_inquiry_at FROM gateway_invoices WHERE payment_id = ${second.paymentId}`,
      );
      expect(new Date(backedOff!.next_inquiry_at).getTime()).toBeGreaterThanOrEqual(
        quietNow + 30_000,
      );
    });

    /*
     * FIX10 (audit P1-b on #268): isolating a row means nothing else reports it — no
     * settlement failure, no inquiry error, no lane failure, and readiness stays fresh. So a
     * row whose processing throws on EVERY pass (an approval among them) opens one operator
     * condition after GATEWAY_ROW_FAILURE_ALERT_AFTER passes in a row, counted durably on the
     * row, and its next clean pass closes it.
     */
    it('FIX10 P1-b: a row that throws on every pass opens ONE condition after three passes; a clean pass closes it', async () => {
      const first = await createdAttempt();
      const secondOrderId = await draftOrder(300_000n);
      const second = await payWithGateway(secondOrderId);
      await pass();
      const secondInvoiceId = (await invoiceOf(second.paymentId)).provider_invoice_id!;
      // The provider HAS approved the failing one: money is held while its row throws.
      tonpays.set(first.invoiceId, 'completed', true);
      const real = new TonPaysAdapter({ fetch: tonpays.fetch });
      const poisoned = Object.create(real) as TonPaysAdapter;
      let poison = true;
      (poisoned as unknown as { inquire: unknown }).inquire = (
        apiKey: string,
        invoiceId: string,
      ) =>
        poison && invoiceId === first.invoiceId
          ? Promise.reject(Object.assign(new Error(`boom ${apiKey}`), { code: '40P01' }))
          : real.inquire(apiKey, invoiceId);
      const poisonLane = laneWith(tonpays, { adapter: poisoned });
      const conditions = () =>
        rows<{
          dedupe_key: string;
          severity: string;
          occurrence_count: number;
          resolved_at: string | null;
          context: Record<string, unknown>;
        }>(
          sql`SELECT dedupe_key, severity, occurrence_count, resolved_at, context
              FROM operational_events
              WHERE tenant_id = ${tenantA.tenantId} AND code = ${GATEWAY_ROW_FAILING_CODE}`,
        );
      const failuresOf = async (paymentId: string) =>
        (
          await rows<{ row_failures: number }>(
            sql`SELECT row_failures FROM gateway_invoices WHERE payment_id = ${paymentId}`,
          )
        )[0]!.row_failures;

      for (let passNo = 1; passNo < GATEWAY_ROW_FAILURE_ALERT_AFTER; passNo += 1) {
        // Past the back-off's cap: the row is due again on every one of these passes.
        offsetMs += 6 * 60_000;
        expect((await poisonLane.runOnce(tenantA)).rowFailures).toBe(1);
        expect(await failuresOf(first.paymentId)).toBe(passNo);
        expect(await conditions()).toEqual([]);
      }
      // The row beside it was not held up by any of this.
      tonpays.set(secondInvoiceId, 'completed', true);
      offsetMs += 6 * 60_000;
      const report = await poisonLane.runOnce(tenantA);
      expect(report.rowFailures).toBe(1);
      expect(report.settled).toBe(1);
      expect((await paymentOf(second.paymentId)).state).toBe('CONFIRMED');
      expect(await failuresOf(second.paymentId)).toBe(0);

      const opened = await conditions();
      expect(opened).toHaveLength(1);
      expect(opened[0]).toMatchObject({
        dedupe_key: `${GATEWAY_ROW_FAILING_CODE}:invoice:${first.paymentId}`,
        severity: 'ERROR',
        occurrence_count: 1,
        resolved_at: null,
      });
      expect(opened[0]!.context).toMatchObject({
        paymentId: first.paymentId,
        provider: 'TONPAYS',
        lane: 'INQUIRY',
        failures: GATEWAY_ROW_FAILURE_ALERT_AFTER,
        errorCode: '40P01',
      });
      // Ids and machine codes only: never the message, the key or a provider payload.
      expect(JSON.stringify(opened[0]!.context)).not.toContain('boom');
      expect(JSON.stringify(opened[0]!.context)).not.toContain(API_KEY);
      // Its PAYMENTS topic.
      expect(opsLogTopicForCode(GATEWAY_ROW_FAILING_CODE)).toBe('PAYMENTS');

      // Another failing pass is an occurrence of the SAME condition, never a second one.
      offsetMs += 6 * 60_000;
      await poisonLane.runOnce(tenantA);
      const still = await conditions();
      expect(still).toHaveLength(1);
      expect(still[0]!.occurrence_count).toBe(2);
      expect(still[0]!.resolved_at).toBeNull();
      expect((await paymentOf(first.paymentId)).state).toBe('PENDING');

      // The fault cleared: the next pass settles it once and closes the condition.
      poison = false;
      offsetMs += 6 * 60_000;
      await poisonLane.runOnce(tenantA);
      expect((await paymentOf(first.paymentId)).state).toBe('CONFIRMED');
      expect(await failuresOf(first.paymentId)).toBe(0);
      const closed = await conditions();
      expect(closed).toHaveLength(1);
      expect(closed[0]!.resolved_at).not.toBeNull();
      const recoveries = await rows<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM operational_events
            WHERE tenant_id = ${tenantA.tenantId} AND code = ${GATEWAY_ROW_RECOVERED_CODE}`,
      );
      expect(recoveries[0]!.n).toBe(1);
      const settled = await rows<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM outbox_messages WHERE event_type = 'OrderSettled'
            AND aggregate_id = ${first.orderId}`,
      );
      expect(settled[0]!.n).toBe(1);
    });

    it('FIX10 P1-b: a row that fails fewer times in a row than the threshold opens nothing, and its count resets', async () => {
      const first = await createdAttempt();
      const real = new TonPaysAdapter({ fetch: tonpays.fetch });
      const poisoned = Object.create(real) as TonPaysAdapter;
      let poison = true;
      (poisoned as unknown as { inquire: unknown }).inquire = (
        apiKey: string,
        invoiceId: string,
      ) =>
        poison && invoiceId === first.invoiceId
          ? Promise.reject(Object.assign(new Error('boom'), { code: '40P01' }))
          : real.inquire(apiKey, invoiceId);
      const poisonLane = laneWith(tonpays, { adapter: poisoned });
      // Due on every pass, whatever a clean inquiry scheduled next.
      const dueNow = () =>
        ctx.container.database.db.execute(
          sql`UPDATE gateway_invoices SET next_inquiry_at = now() - interval '1 hour'
              WHERE payment_id = ${first.paymentId}`,
        );
      const failures = async () =>
        (
          await rows<{ row_failures: number }>(
            sql`SELECT row_failures FROM gateway_invoices WHERE payment_id = ${first.paymentId}`,
          )
        )[0]!.row_failures;
      for (let round = 0; round < 2; round += 1) {
        poison = true;
        for (let n = 1; n < GATEWAY_ROW_FAILURE_ALERT_AFTER; n += 1) {
          offsetMs += 6 * 60_000;
          await dueNow();
          await poisonLane.runOnce(tenantA);
        }
        expect(await failures()).toBe(GATEWAY_ROW_FAILURE_ALERT_AFTER - 1);
        // One clean pass in between: CONSECUTIVE failures, so the count starts again.
        poison = false;
        offsetMs += 6 * 60_000;
        await dueNow();
        await poisonLane.runOnce(tenantA);
        expect(await failures()).toBe(0);
      }
      const events = await rows<{ code: string }>(
        sql`SELECT code FROM operational_events WHERE tenant_id = ${tenantA.tenantId}
            AND code IN (${GATEWAY_ROW_FAILING_CODE}, ${GATEWAY_ROW_RECOVERED_CODE})`,
      );
      expect(events).toEqual([]);
    });
  });

  /*
   * FIX10 R1: the claim lease against a slow batch, with two lanes over one database and one
   * movable clock. A provider call is "slow" by moving the lanes' clock inside it.
   */
  describe('the claim lease (FIX10 R1)', () => {
    const claimOf = async (paymentId: string) =>
      (
        await rows<{ claimed: string | null }>(
          sql`SELECT inquiry_claimed_until AS claimed FROM gateway_invoices WHERE payment_id = ${paymentId}`,
        )
      )[0]?.claimed ?? null;

    it('a lane starts no row its lease cannot cover, and gives those rows back for the next lane at once', async () => {
      const attempts = [
        await createdAttempt(),
        await createdAttempt(260_000n),
        await createdAttempt(270_000n),
      ];
      const real = new TonPaysAdapter({ fetch: tonpays.fetch });
      const slow = Object.create(real) as TonPaysAdapter;
      (slow as unknown as { inquire: unknown }).inquire = async (apiKey: string, id: string) => {
        // Each answer takes twenty seconds of the lease.
        offsetMs += 20_000;
        return real.inquire(apiKey, id);
      };
      offsetMs += 6 * 60_000;
      const checksBefore = tonpays.checks.length;
      const report = await laneWith(tonpays, { adapter: slow }).runOnce(tenantA);
      // A 60 s lease and a 45 s row bound: one row at 0 s, none at 20 s.
      expect(tonpays.checks.length - checksBefore).toBe(1);
      expect(report.leaseReleased).toBe(2);
      const unasked = attempts.filter(
        (one) => !tonpays.checks.slice(checksBefore).includes(one.invoiceId),
      );
      expect(unasked).toHaveLength(2);
      for (const one of unasked) expect(await claimOf(one.paymentId)).toBeNull();

      // Given back, not left leased: another lane takes them in its very next pass.
      await laneWith(tonpays).runOnce(tenantA);
      expect([...new Set(tonpays.checks.slice(checksBefore))].sort()).toEqual(
        attempts.map((one) => one.invoiceId).sort(),
      );
    });

    it('an answer recorded after the lease was taken over overwrites nothing and settles nothing', async () => {
      const { paymentId, invoiceId } = await createdAttempt();
      const real = new TonPaysAdapter({ fetch: tonpays.fetch });
      const stalled = Object.create(real) as TonPaysAdapter;
      const other = laneWith(tonpays);
      (stalled as unknown as { inquire: unknown }).inquire = async (apiKey: string, id: string) => {
        // This replica's answer: still pending. Then it stalls past its lease...
        const stale = await real.inquire(apiKey, id);
        offsetMs += 70_000;
        // ...the customer pays, and another replica takes the row and settles it.
        tonpays.set(invoiceId, 'completed', true);
        await other.runOnce(tenantA);
        return stale;
      };
      offsetMs += 6 * 60_000;
      const report = await laneWith(tonpays, { adapter: stalled }).runOnce(tenantA);
      expect(report.leaseLost).toBe(1);
      expect((await paymentOf(paymentId)).state).toBe('CONFIRMED');
      // The newer evidence stands: the stale "pending" neither replaced it nor rescheduled
      // a settled attempt.
      const invoice = await invoiceOf(paymentId);
      expect(invoice.provider_status).toBe('completed');
      expect(invoice.provider_paid).toBe(true);
      expect(invoice.outcome).toBe('SETTLED');
      expect(invoice.next_inquiry_at).toBeNull();
    });

    it('a failed call recorded after the lease was taken over does not reschedule the attempt the other replica settled', async () => {
      const { paymentId, invoiceId } = await createdAttempt();
      const real = new TonPaysAdapter({ fetch: tonpays.fetch });
      const stalled = Object.create(real) as TonPaysAdapter;
      const other = laneWith(tonpays);
      (stalled as unknown as { inquire: unknown }).inquire = async () => {
        // This replica's call fails slowly, past its lease; meanwhile the other settles it.
        offsetMs += 70_000;
        tonpays.set(invoiceId, 'completed', true);
        await other.runOnce(tenantA);
        return { kind: 'UNKNOWN', code: 'nexa.timeout' };
      };
      offsetMs += 6 * 60_000;
      const report = await laneWith(tonpays, { adapter: stalled }).runOnce(tenantA);
      expect(report.leaseLost).toBe(1);
      expect((await paymentOf(paymentId)).state).toBe('CONFIRMED');
      const [row] = await rows<{
        outcome: string | null;
        next_inquiry_at: string | null;
        last_inquiry_error_code: string | null;
      }>(
        sql`SELECT outcome, next_inquiry_at, last_inquiry_error_code FROM gateway_invoices
            WHERE payment_id = ${paymentId}`,
      );
      expect(row).toMatchObject({
        outcome: 'SETTLED',
        next_inquiry_at: null,
        last_inquiry_error_code: null,
      });
    });

    it('a replica whose lease was taken over before it stamped the send sends nothing', async () => {
      await enableTonPays();
      const { paymentId } = await payWithGateway(await draftOrder());
      const repository = new DrizzleGatewayInvoiceRepository(ctx.container.database.db);
      const budget = new DrizzleGatewayCallBudget(ctx.container.database.db);
      const report = await laneWith(tonpays, {
        budget: {
          take: async (...args: Parameters<GatewayCallBudget['take']>) => {
            // Stalled past its lease between the claim and the stamp; another replica claims.
            offsetMs += 70_000;
            const taken = await ctx.container.uow.run(tenantA, (tx) =>
              repository.claimCreating(tenantA, new Date(Date.now() + offsetMs), 60_000, 5, tx),
            );
            expect(taken.map((one) => one.invoice.paymentId)).toEqual([paymentId]);
            return budget.take(...args);
          },
        },
      }).runOnce(tenantA);
      expect(report.leaseLost).toBe(1);
      expect(tonpays.creates).toHaveLength(0);
      const invoice = await invoiceOf(paymentId);
      expect(invoice.creation_state).toBe('CREATING');
    });

    it('a create still in flight is never called UNKNOWN by another replica, even past its lease', async () => {
      await enableTonPays();
      const orderId = await draftOrder();
      const { paymentId } = await payWithGateway(orderId);
      const real = new TonPaysAdapter({ fetch: tonpays.fetch });
      const stalled = Object.create(real) as TonPaysAdapter;
      const other = laneWith(tonpays);
      let othersReport: Awaited<ReturnType<GatewayPaymentService['runOnce']>> | null = null;
      (stalled as unknown as { createInvoice: unknown }).createInvoice = async (
        ...args: Parameters<TonPaysAdapter['createInvoice']>
      ) => {
        // The call is slow: past the claim's sixty seconds, inside its timeout plus a lease.
        offsetMs += 70_000;
        othersReport = await other.runOnce(tenantA);
        return real.createInvoice(...args);
      };
      await laneWith(tonpays, { adapter: stalled }).runOnce(tenantA);
      expect(othersReport).toMatchObject({ createUnknown: 0, created: 0 });
      const invoice = await invoiceOf(paymentId);
      expect(invoice.creation_state).toBe('CREATED');
      expect(invoice.provider_invoice_id).not.toBeNull();
      expect(tonpays.creates).toHaveLength(1);
    });

    /*
     * Codex #270: the hold was measured from the clock read BEFORE the setup steps. A setup
     * that stalled past the row bound plus a lease (nobody reclaiming meanwhile) passed the
     * lease fence and wrote a hold already in the past, so another replica could claim the
     * row during the call and call the live create UNKNOWN.
     */
    it('a setup that stalls before the stamp still holds the row for the whole call', async () => {
      await enableTonPays();
      const { paymentId } = await payWithGateway(await draftOrder());
      const budget = new DrizzleGatewayCallBudget(ctx.container.database.db);
      const real = new TonPaysAdapter({ fetch: tonpays.fetch });
      const stalled = Object.create(real) as TonPaysAdapter;
      const other = laneWith(tonpays);
      let othersReport: Awaited<ReturnType<GatewayPaymentService['runOnce']>> | null = null;
      let holdAtCall: Date | null = null;
      let clockAtCall = 0;
      (stalled as unknown as { createInvoice: unknown }).createInvoice = async (
        ...args: Parameters<TonPaysAdapter['createInvoice']>
      ) => {
        const [row] = await rows<{ hold: string }>(
          sql`SELECT creation_claimed_until AS hold FROM gateway_invoices WHERE payment_id = ${paymentId}`,
        );
        holdAtCall = new Date(row!.hold);
        clockAtCall = Date.now() + offsetMs;
        // A little into the call, another replica's pass runs.
        offsetMs += 5_000;
        othersReport = await other.runOnce(tenantA);
        return real.createInvoice(...args);
      };
      const report = await laneWith(tonpays, {
        adapter: stalled,
        budget: {
          take: async (...args: Parameters<GatewayCallBudget['take']>) => {
            // A setup step before the stamp stalls far past rowBound + lease; nobody claims.
            offsetMs += 10 * 60_000;
            return budget.take(...args);
          },
        },
      }).runOnce(tenantA);
      expect(report.leaseLost).toBe(0);
      // The hold the call started under covers the call from the moment it started.
      expect(holdAtCall!.getTime()).toBeGreaterThan(clockAtCall);
      expect(othersReport).toMatchObject({ createUnknown: 0, created: 0 });
      const invoice = await invoiceOf(paymentId);
      expect(invoice.creation_state).toBe('CREATED');
      expect(tonpays.creates).toHaveLength(1);
    });
  });

  describe('an exhausted call budget', () => {
    const empty: GatewayCallBudget = { take: () => Promise.resolve(false) };
    const claims = async (column: 'creation_claimed_until' | 'inquiry_claimed_until') =>
      (
        await rows<{ claimed: string | null }>(
          sql`SELECT ${sql.raw(column)} AS claimed FROM gateway_invoices
              WHERE tenant_id = ${tenantA.tenantId} ORDER BY created_at`,
        )
      ).map((row) => (row.claimed === null ? null : new Date(row.claimed).toISOString()));

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

    it('releases only a lease still carrying the value it set, never one another worker has since taken', async () => {
      const { paymentId } = await createdAttempt();
      const repository = new DrizzleGatewayInvoiceRepository(ctx.container.database.db);
      const ours = new Date(Date.UTC(2030, 0, 1, 0, 0, 0));
      const theirs = new Date(Date.UTC(2030, 0, 1, 0, 1, 0));
      await ctx.container.database.db.execute(
        sql`UPDATE gateway_invoices SET inquiry_claimed_until = ${theirs.toISOString()}::timestamptz
            WHERE payment_id = ${paymentId}`,
      );
      expect(
        await repository.releaseClaims(tenantA, 'INQUIRY', [paymentId], ours, new Date()),
      ).toBe(0);
      expect(await claims('inquiry_claimed_until')).toEqual([theirs.toISOString()]);
      expect(
        await repository.releaseClaims(tenantA, 'INQUIRY', [paymentId], theirs, new Date()),
      ).toBe(1);
      expect(await claims('inquiry_claimed_until')).toEqual([null]);
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

  // =====================================================================================
  // WP18 — the customer gateway fee, and the financial log.
  // `docs/wp18-gateway-fee-financial-log-audit.md`.
  // =====================================================================================

  describe('WP18 — the customer gateway fee', () => {
    const FIVE_PERCENT = 500;

    const feeOf = async (paymentId: string) =>
      (
        await rows<{
          amount: string;
          customer_fee_basis_points: number | null;
          customer_fee_amount: string | null;
          payable_amount: string | null;
        }>(
          sql`SELECT amount::text AS amount, customer_fee_basis_points,
                     customer_fee_amount::text AS customer_fee_amount,
                     payable_amount::text AS payable_amount
              FROM payments WHERE id = ${paymentId}`,
        )
      )[0]!;

    /** The database's own message, under the query wrapper drizzle puts around it. */
    const dbMessage = (error: unknown): string =>
      String((error as { cause?: { message?: unknown } }).cause?.message ?? error);

    const sentAmount = async (paymentId: string) =>
      (
        await rows<{ sent_amount: string }>(
          sql`SELECT sent_amount::text AS sent_amount FROM gateway_invoices WHERE payment_id = ${paymentId}`,
        )
      )[0]!.sent_amount;

    async function approve(paymentId: string, key: string) {
      const invoice = await invoiceOf(paymentId);
      tonpays.set(invoice.provider_invoice_id!, 'completed', true);
      await webhook(invoice, 'completed', key);
      await inquireNow();
      await inquireNow();
    }

    it('invoices principal + fee, keeps the payment amount the principal, and settles the order at its own total', async () => {
      await enableTonPays({ customerFeeBasisPoints: FIVE_PERCENT });
      const orderId = await draftOrder(200_000n);
      const { paymentId } = await payWithGateway(orderId);

      expect(await feeOf(paymentId)).toEqual({
        amount: '200000',
        customer_fee_basis_points: 500,
        customer_fee_amount: '10000',
        payable_amount: '210000',
      });
      expect(await sentAmount(paymentId)).toBe('210000');
      await pass();
      // The invoice TonPays is asked for is the payable, and nothing else.
      expect(tonpays.creates.map((create) => create.body.amount)).toEqual([210_000]);
      // The customer is shown the three figures apart, once the invoice exists.
      await tap(`gc:${paymentId}`);
      expect(lastText()).toContain('مبلغ سفارش');
      expect(lastText()).toContain('کارمزد درگاه');
      expect(lastText()).toContain('مبلغ قابل پرداخت');

      await approve(paymentId, 'fee-order');
      expect((await paymentOf(paymentId)).state).toBe('CONFIRMED');
      // The settlement guard compares the PRINCIPAL with the order total: it settled.
      expect(await orderState(orderId)).toBe('PAID');
      const [order] = await rows<{ total_amount: string }>(
        sql`SELECT total_amount::text AS total_amount FROM orders WHERE id = ${orderId}`,
      );
      expect(order!.total_amount).toBe('200000');
      // No money moved through the wallet for a gateway order, fee included.
      expect(await ledger()).toEqual([]);
    });

    it('credits a top-up’s principal only, bases the gift on the principal, and never credits the fee', async () => {
      await enableTonPays({ customerFeeBasisPoints: FIVE_PERCENT, topupCashbackPercent: 10 });
      const scope = { ...tenantA, botInstanceId: BOT_A };
      const attempt = await ctx.container.payments.requestGatewayTopup(
        scope,
        systemActor('fee-topup'),
        maryam,
        { idempotencyKey: 'fee-topup', amount: money(200_000n, 'IRT'), provider: 'TONPAYS' },
      );
      expect(attempt.payment.amount.amountMinor).toBe(200_000n);
      expect(attempt.payment.customerFee?.payable.amountMinor).toBe(210_000n);
      await pass();
      expect(tonpays.creates.map((create) => create.body.amount)).toEqual([210_000]);

      await approve(attempt.payment.id, 'fee-topup');
      expect(await ledger()).toEqual([
        { reason: 'CASHBACK_TOPUP', amount: '20000', payment_id: attempt.payment.id },
        { reason: 'TOPUP_GATEWAY', amount: '200000', payment_id: attempt.payment.id },
      ]);
    });

    it('rounds the fee half-up to the minor unit, on integers', async () => {
      // 12.5 % of 3 Toman is 0.375 → 0; 16.67 % of 3 is 0.5001 → 1; 50 % of 1 is 0.5 → 1.
      await enableTonPays({ customerFeeBasisPoints: 5_000 });
      const scope = { ...tenantA, botInstanceId: BOT_A };
      const attempt = await ctx.container.payments.requestGatewayTopup(
        scope,
        systemActor('fee-round'),
        maryam,
        { idempotencyKey: 'fee-round', amount: money(100_001n, 'IRT'), provider: 'TONPAYS' },
      );
      // 100001 × 0.5 = 50000.5 → 50001, half-up.
      expect(await feeOf(attempt.payment.id)).toMatchObject({
        customer_fee_amount: '50001',
        payable_amount: '150002',
      });
    });

    it('snapshots the rate: a later change neither alters the open attempt nor the invoice it hands back', async () => {
      await enableTonPays({ customerFeeBasisPoints: FIVE_PERCENT });
      const orderId = await draftOrder(200_000n);
      const { paymentId } = await payWithGateway(orderId);
      await ctx.container.paymentGateways.configure(tenantA, owner, {
        idempotencyKey: 'fee-raised',
        provider: 'TONPAYS',
        config: { ...OPEN_ROUTE, customerFeeBasisPoints: 1_000 },
      });
      // The same order, tapped again: the OPEN attempt comes back with its own figures.
      const again = await payWithGateway(orderId);
      expect(again.paymentId).toBe(paymentId);
      expect(await feeOf(paymentId)).toMatchObject({
        customer_fee_basis_points: 500,
        payable_amount: '210000',
      });
      // And the database refuses to rewrite a snapshot, in every state.
      await expect(
        ctx.container.database.db.execute(
          sql`UPDATE payments SET customer_fee_amount = 0, payable_amount = amount WHERE id = ${paymentId}`,
        ),
      ).rejects.toSatisfy((error: unknown) =>
        /customer gateway fee and payable are fixed/u.test(dbMessage(error)),
      );
    });

    it('holds the payable to principal + fee, and a fee only on a gateway payment, in the database too', async () => {
      await enableTonPays({ customerFeeBasisPoints: FIVE_PERCENT });
      const orderId = await draftOrder(200_000n);
      const { paymentId } = await payWithGateway(orderId);
      await expect(
        ctx.container.database.db.execute(
          sql`INSERT INTO payments (id, tenant_id, customer_id, method, amount, currency, reference,
                                    customer_fee_basis_points, customer_fee_amount, payable_amount)
              SELECT gen_random_uuid(), tenant_id, customer_id, 'GATEWAY', 1000, currency, 'bad-payable',
                     500, 50, 1049
              FROM payments WHERE id = ${paymentId}`,
        ),
      ).rejects.toSatisfy((error: unknown) =>
        /payments_customer_fee_check/u.test(dbMessage(error)),
      );
      await expect(
        ctx.container.database.db.execute(
          sql`INSERT INTO payments (id, tenant_id, customer_id, method, amount, currency, reference,
                                    customer_fee_basis_points, customer_fee_amount, payable_amount)
              SELECT gen_random_uuid(), tenant_id, customer_id, 'MANUAL_TRANSFER', 1000, currency, 'bad-method',
                     500, 50, 1050
              FROM payments WHERE id = ${paymentId}`,
        ),
      ).rejects.toSatisfy((error: unknown) =>
        /payments_customer_fee_check/u.test(dbMessage(error)),
      );
    });

    it('refuses a non-zero fee on a route that does not settle through a gateway', async () => {
      await expect(
        ctx.container.paymentGateways.configure(tenantA, owner, {
          idempotencyKey: 'manual-fee',
          provider: 'MANUAL_TRANSFER',
          config: { ...OPEN_ROUTE, customerFeeBasisPoints: 100 },
        }),
      ).rejects.toSatisfy(
        (error: unknown) =>
          isNexaError(error) && error.code === COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
      );
      // A save that does not mention the fee keeps the stored rate.
      await enableTonPays({ customerFeeBasisPoints: FIVE_PERCENT });
      const { customerFeeBasisPoints: _omitted, ...withoutFee } = {
        ...OPEN_ROUTE,
        customerFeeBasisPoints: undefined,
      };
      const kept = await ctx.container.paymentGateways.configure(tenantA, owner, {
        idempotencyKey: 'tp-no-fee-field',
        provider: 'TONPAYS',
        config: { ...withoutFee, sortOrder: 7 },
      });
      expect(kept.customerFeeBasisPoints).toBe(FIVE_PERCENT);
    });

    it('refuses a payable past the largest money amount, before anything is written (Codex review of #82)', async () => {
      await enableTonPays({ customerFeeBasisPoints: 100 });
      const scope = { ...tenantA, botInstanceId: BOT_A };
      await expect(
        ctx.container.payments.requestGatewayTopup(scope, systemActor('fee-overflow'), maryam, {
          idempotencyKey: 'fee-overflow',
          amount: money(MAX_MONEY_AMOUNT_MINOR, 'IRT'),
          provider: 'TONPAYS',
        }),
      ).rejects.toSatisfy(
        (error: unknown) =>
          isNexaError(error) &&
          error.code === COMMERCE_ERROR_CODES.PAYMENT_GATEWAY_UNAVAILABLE &&
          (error.details as { reason?: string }).reason === 'AMOUNT_NOT_REPRESENTABLE',
      );
      const written = await rows<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM payments WHERE customer_id = ${maryam}`,
      );
      expect(written[0]!.n).toBe(0);
      await pass();
      expect(tonpays.creates).toEqual([]);
    });

    it('replays a route edit an earlier release committed, whose retry omits the fee (Codex review of #82)', async () => {
      await enableTonPays();
      const { customerFeeBasisPoints: _fee, ...withoutFee } = { ...OPEN_ROUTE, sortOrder: 3 };
      // The earlier release hashed the edit without a fee field, and remembered it.
      await ctx.container.idempotency.remember(
        tenantA,
        'WEB',
        'legacy-route-edit',
        hashRequest({
          provider: 'TONPAYS',
          displayName: withoutFee.displayName,
          instructions: withoutFee.instructions,
          minAmountMinor: withoutFee.minAmountMinor.toString(),
          maxAmountMinor: withoutFee.maxAmountMinor.toString(),
          eligibility: withoutFee.eligibility,
          sortOrder: withoutFee.sortOrder,
          topupCashbackPercent: withoutFee.topupCashbackPercent,
          allowServicePurchase: withoutFee.allowServicePurchase,
          allowWalletTopup: withoutFee.allowWalletTopup,
        }),
        { provider: 'TONPAYS' },
      );
      // Its retry after the upgrade replays that edit rather than being refused.
      const replayed = await ctx.container.paymentGateways.configure(tenantA, owner, {
        idempotencyKey: 'legacy-route-edit',
        provider: 'TONPAYS',
        config: withoutFee,
      });
      expect(replayed.provider).toBe('TONPAYS');
      // And an edit that SENDS a fee is still its own command.
      await expect(
        ctx.container.paymentGateways.configure(tenantA, owner, {
          idempotencyKey: 'legacy-route-edit',
          provider: 'TONPAYS',
          config: { ...withoutFee, customerFeeBasisPoints: 250 },
        }),
      ).rejects.toMatchObject({ code: 'platform.idempotency_payload_mismatch' });
    });

    it('never refunds the fee: the automatic refund returns the principal and nothing more', async () => {
      await enableTonPays({ customerFeeBasisPoints: FIVE_PERCENT });
      const orderId = await draftOrder(200_000n);
      const { paymentId } = await payWithGateway(orderId);
      await pass();
      await approve(paymentId, 'fee-refund');
      const payment = await new DrizzlePaymentRepository(ctx.container.database.db).findById(
        tenantA,
        paymentId,
      );
      const refund = await ctx.container.uow.run(tenantA, (tx) =>
        ctx.container.refunds.refundUndeliverable(
          tenantA,
          systemActor('fee-refund-auto'),
          { payment: payment!, now: ctx.container.clock.now() },
          tx,
        ),
      );
      expect(refund?.amount.amountMinor).toBe(200_000n);
      expect(await ledger()).toEqual([
        { reason: 'REFUND', amount: '200000', payment_id: paymentId },
      ]);
    });
  });

  describe('WP18 — the financial log', () => {
    const LOG_CHAT = '-1001234567890';
    const PAYMENTS_TOPIC = 77;
    let flagKey = 0;

    async function configureLog(paymentsTopic: number | null) {
      const key = () => `wp18-log-${String((flagKey += 1))}`;
      await ctx.container.featureFlags.set(tenantA, owner, {
        key: 'ops_notifications',
        enabled: true,
        expectedVersion: null,
        idempotencyKey: key(),
        confirmKey: 'ops_notifications',
        reason: 'WP18 financial log.',
      });
      await ctx.container.settingsService.set(tenantA, owner, {
        key: 'ops.notifications.telegram_chat_id',
        value: LOG_CHAT,
        expectedVersion: null,
        idempotencyKey: key(),
      });
      await ctx.container.settingsService.set(tenantA, owner, {
        key: 'ops.notifications.telegram_topic_id',
        value: 5,
        expectedVersion: null,
        idempotencyKey: key(),
      });
      if (paymentsTopic !== null) {
        await ctx.container.settingsService.set(tenantA, owner, {
          key: 'ops.notifications.payments_topic_id',
          value: paymentsTopic,
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

    const logs = () =>
      rows<{
        kind: string;
        template_key: string;
        destination: { chatId: string; topicId: number | null };
        payload: Record<string, unknown>;
        dedupe_key: string;
      }>(
        sql`SELECT kind, template_key, destination, payload, dedupe_key FROM notifications
            WHERE tenant_id = ${tenantA.tenantId} AND template_key LIKE 'ops.financial.%'
            ORDER BY created_at`,
      );

    it('logs a gateway order payment to the payments topic with principal, fee, payable and the provider’s figure as diagnostic', async () => {
      await configureLog(PAYMENTS_TOPIC);
      await enableTonPays({ customerFeeBasisPoints: 500 });
      const orderId = await draftOrder(200_000n);
      const { paymentId } = await payWithGateway(orderId);
      await pass();
      const invoice = await invoiceOf(paymentId);
      tonpays.set(invoice.provider_invoice_id!, 'completed', true);
      await webhook(invoice, 'completed', 'log-1');
      await inquireNow();
      await relayAll();
      await relayAll(); // a second pass writes nothing new

      const written = await logs();
      expect(written).toHaveLength(1);
      const [log] = written;
      expect(log!.template_key).toBe('ops.financial.order_paid');
      // A kind the release before WP18 knows: its Web Admin reads `kind` as a strict enum,
      // so a new kind would break its whole notifications page after a rollback.
      expect(log!.kind).toBe('OPERATIONAL_EVENT');
      expect(log!.destination).toMatchObject({ chatId: LOG_CHAT, topicId: PAYMENTS_TOPIC });
      expect(log!.payload).toMatchObject({
        method: 'GATEWAY',
        route: 'TONPAYS',
        telegramId: MARYAM,
        displayName: 'مریم',
        paymentId,
        orderId,
        principal: { amountMinor: '200000', currency: 'IRT' },
        fee: { amountMinor: '10000', currency: 'IRT' },
        payable: { amountMinor: '210000', currency: 'IRT' },
        providerInvoiceId: invoice.provider_invoice_id,
        // The fake reports its documented final amount, 37 above the request: diagnostic.
        providerFinalAmount: '210037 IRT',
        evidence: 'GATEWAY_INQUIRY',
      });
      // Nothing that is a key, a link or a raw payload.
      const serialised = JSON.stringify(written);
      expect(serialised).not.toContain(API_KEY);
      expect(serialised).not.toContain('https://');
      expect(serialised).not.toContain('t.me');
    });

    it('logs a top-up with the principal credit, fee, total paid and gift apart', async () => {
      await configureLog(null);
      await enableTonPays({ customerFeeBasisPoints: 500, topupCashbackPercent: 10 });
      const attempt = await ctx.container.payments.requestGatewayTopup(
        { ...tenantA, botInstanceId: BOT_A },
        systemActor('log-topup'),
        maryam,
        { idempotencyKey: 'log-topup', amount: money(200_000n, 'IRT'), provider: 'TONPAYS' },
      );
      await pass();
      const invoice = await invoiceOf(attempt.payment.id);
      tonpays.set(invoice.provider_invoice_id!, 'completed', true);
      await webhook(invoice, 'completed', 'log-topup');
      await inquireNow();
      await relayAll();

      const [log] = await logs();
      expect(log!.template_key).toBe('ops.financial.topup_credited');
      // No payments topic configured: the operations topic.
      expect(log!.destination).toMatchObject({ chatId: LOG_CHAT, topicId: 5 });
      expect(log!.payload).toMatchObject({
        principal: { amountMinor: '200000' },
        fee: { amountMinor: '10000' },
        payable: { amountMinor: '210000' },
        gift: { amountMinor: '20000' },
      });
    });

    it('logs a gateway failure and a late approval, once each', async () => {
      await configureLog(PAYMENTS_TOPIC);
      await enableTonPays();
      const failedOrder = await draftOrder();
      const failed = await payWithGateway(failedOrder);
      await pass();
      tonpays.set((await invoiceOf(failed.paymentId)).provider_invoice_id!, 'rejected', false);
      await inquireNow();
      await inquireNow();

      const lateOrder = await draftOrder();
      const late = await payWithGateway(lateOrder);
      await pass();
      const lateInvoice = await invoiceOf(late.paymentId);
      await ctx.container.database.db.execute(
        sql`UPDATE payments SET expires_at = now() - interval '1 second' WHERE id = ${late.paymentId}`,
      );
      tonpays.set(lateInvoice.provider_invoice_id!, 'completed', true);
      await webhook(lateInvoice, 'completed', 'late-1');
      await inquireNow();
      await inquireNow();
      await relayAll();

      const keys = (await logs()).map((log) => log.template_key).sort();
      expect(keys).toEqual(['ops.financial.late_completion', 'ops.financial.payment_failed']);
      expect(new Set((await logs()).map((log) => log.kind))).toEqual(
        new Set(['OPERATIONAL_EVENT']),
      );
      // The provider's verdict, never an operator's rejection: the log names who said no.
      const failure = (await logs()).find(
        (log) => log.template_key === 'ops.financial.payment_failed',
      );
      expect(failure!.payload).toMatchObject({
        cause: 'GATEWAY_FAILED',
        paymentId: failed.paymentId,
      });
      expect((await paymentOf(late.paymentId)).state).not.toBe('CONFIRMED');
    });

    it('writes one log for an event replayed past a lost relay claim', async () => {
      await configureLog(PAYMENTS_TOPIC);
      await enableTonPays();
      const orderId = await draftOrder();
      const { paymentId } = await payWithGateway(orderId);
      await pass();
      const invoice = await invoiceOf(paymentId);
      tonpays.set(invoice.provider_invoice_id!, 'completed', true);
      await webhook(invoice, 'completed', 'replay-1');
      await inquireNow();
      await relayAll();
      expect(await logs()).toHaveLength(1);

      // A lost `processed_messages` claim is staged by calling the consumer again directly,
      // past the claim (that table refuses DELETE by trigger): the dedupe key is what stands.
      const consumer = (
        ctx.container.relay as unknown as {
          consumers: {
            name: string;
            handle: (event: never, tx: never) => Promise<void>;
          }[];
        }
      ).consumers.find((one) => one.name === 'payments.financial-log');
      if (consumer === undefined) throw new Error('the financial log is not registered');
      const [message] = await rows<Record<string, unknown>>(
        sql`SELECT * FROM outbox_messages
             WHERE event_type = 'PaymentConfirmed' AND aggregate_id = ${paymentId}`,
      );
      const event = {
        eventId: String(message?.['id']),
        eventType: 'PaymentConfirmed',
        eventVersion: 1,
        tenantId: tenantA.tenantId as string,
        aggregateType: 'Payment',
        aggregateId: paymentId,
        sequence: 1,
        correlationId: 'replayed',
        causationId: null,
        actor: { type: 'SYSTEM_JOB', id: null },
        occurredAt: new Date().toISOString(),
        payload: message?.['payload'],
      };
      await ctx.container.uow.run(tenantA, (tx) => consumer.handle(event as never, tx as never));
      expect(await logs()).toHaveLength(1);
    });

    it('logs a completed refund and a superseded one, and writes nothing when the log is not configured', async () => {
      await enableTonPays();
      const orderId = await draftOrder(200_000n);
      const { paymentId } = await payWithGateway(orderId);
      await pass();
      const invoice = await invoiceOf(paymentId);
      tonpays.set(invoice.provider_invoice_id!, 'completed', true);
      await webhook(invoice, 'completed', 'rf-1');
      await inquireNow();
      // Not configured yet: the confirmation's event is consumed and logs nothing.
      await relayAll();
      expect(await logs()).toEqual([]);

      await configureLog(PAYMENTS_TOPIC);
      await ctx.container.database.db.execute(
        sql`INSERT INTO refunds (id, tenant_id, payment_id, customer_id, order_id, state, channel,
                                 amount, currency, reason)
            SELECT gen_random_uuid(), tenant_id, id, customer_id, order_id, 'REQUESTED', 'EXTERNAL_MANUAL',
                   1000, currency, 'operator'
            FROM payments WHERE id = ${paymentId}`,
      );
      const payment = await new DrizzlePaymentRepository(ctx.container.database.db).findById(
        tenantA,
        paymentId,
      );
      await ctx.container.uow.run(tenantA, (tx) =>
        ctx.container.refunds.refundUndeliverable(
          tenantA,
          systemActor('rf-auto'),
          { payment: payment!, now: ctx.container.clock.now() },
          tx,
        ),
      );
      await relayAll();
      const written = await logs();
      expect(written.map((log) => log.template_key).sort()).toEqual([
        'ops.financial.refund_completed',
        'ops.financial.refund_failed',
      ]);
      const failed = written.find((log) => log.template_key === 'ops.financial.refund_failed');
      expect(failed!.payload).toMatchObject({
        cause: 'SUPERSEDED',
        amount: { amountMinor: '1000' },
      });
      const completed = written.find(
        (log) => log.template_key === 'ops.financial.refund_completed',
      );
      expect(completed!.payload).toMatchObject({ amount: { amountMinor: '200000' } });
    });

    /*
     * Codex review of #82: the payments topic could not be tested. The only test send went
     * to the operations topic, so a wrong payments topic was found on the first financial
     * event, after its bounded attempts were spent.
     */
    const testedTopic = async (id: string) =>
      (
        await rows<{ destination: { topicId: number | null } }>(
          sql`SELECT destination FROM notifications WHERE id = ${id}`,
        )
      )[0]!.destination.topicId;

    it('tests the payments topic on request, and the operations topic by default (Codex review of #82)', async () => {
      await configureLog(PAYMENTS_TOPIC);
      const payments = await ctx.container.notifications.sendTest(tenantA, owner, {
        idempotencyKey: 'wp18-test-payments',
        target: 'PAYMENTS',
      });
      expect(await testedTopic(payments.intent.id)).toBe(PAYMENTS_TOPIC);
      const operations = await ctx.container.notifications.sendTest(tenantA, owner, {
        idempotencyKey: 'wp18-test-operations',
      });
      expect(await testedTopic(operations.intent.id)).toBe(5);
    });

    it('tests where the financial log goes: the operations topic when no payments topic is set (Codex review of #82)', async () => {
      await configureLog(null);
      const payments = await ctx.container.notifications.sendTest(tenantA, owner, {
        idempotencyKey: 'wp18-test-payments-fallback',
        target: 'PAYMENTS',
      });
      expect(await testedTopic(payments.intent.id)).toBe(5);
    });

    it('replays a test an earlier release accepted, whose retry sends no target (Codex review of #82)', async () => {
      await configureLog(PAYMENTS_TOPIC);
      const first = await ctx.container.notifications.sendTest(tenantA, owner, {
        idempotencyKey: 'wp18-test-legacy',
      });
      const [stored] = await rows<{ request_hash: string }>(
        sql`SELECT request_hash FROM request_idempotency WHERE key = 'wp18-test-legacy'`,
      );
      // The hash an earlier release wrote for the same request: the command, and nothing else.
      expect(stored!.request_hash).toBe(hashRequest({ command: 'notifications.test' }));
      const again = await ctx.container.notifications.sendTest(tenantA, owner, {
        idempotencyKey: 'wp18-test-legacy',
      });
      expect(again.intent.id).toBe(first.intent.id);
      expect(again.replayed).toBe(true);
    });

    it('logs nothing while ops_notifications is off, even with a chat configured', async () => {
      await configureLog(PAYMENTS_TOPIC);
      const flag = (await ctx.container.featureFlags.list(tenantA, owner)).find(
        (row) => row.key === 'ops_notifications',
      );
      if (flag === undefined) throw new Error('no ops_notifications flag');
      await ctx.container.featureFlags.set(tenantA, owner, {
        key: 'ops_notifications',
        enabled: false,
        expectedVersion: flag.version,
        idempotencyKey: `wp18-log-off-${String((flagKey += 1))}`,
        confirmKey: 'ops_notifications',
        reason: 'WP18: the switch is the switch.',
      });
      await enableTonPays();
      const orderId = await draftOrder();
      const { paymentId } = await payWithGateway(orderId);
      await pass();
      const invoice = await invoiceOf(paymentId);
      tonpays.set(invoice.provider_invoice_id!, 'completed', true);
      await webhook(invoice, 'completed', 'off-1');
      await inquireNow();
      await relayAll();
      expect((await paymentOf(paymentId)).state).toBe('CONFIRMED');
      expect(await logs()).toEqual([]);
    });

    it('cannot touch the money: a log that fails to queue leaves the confirmation committed', async () => {
      await configureLog(PAYMENTS_TOPIC);
      await enableTonPays();
      const orderId = await draftOrder();
      const { paymentId } = await payWithGateway(orderId);
      await pass();
      // The lane is broken: every financial log insert fails.
      await ctx.container.database.db.execute(
        sql`ALTER TABLE notifications ADD CONSTRAINT wp18_break CHECK (template_key NOT LIKE 'ops.financial.%') NOT VALID`,
      );
      try {
        const invoice = await invoiceOf(paymentId);
        tonpays.set(invoice.provider_invoice_id!, 'completed', true);
        await webhook(invoice, 'completed', 'broken-1');
        await inquireNow();
        await relayAll();
        expect((await paymentOf(paymentId)).state).toBe('CONFIRMED');
        expect(await orderState(orderId)).toBe('PAID');
        expect(await logs()).toEqual([]);
      } finally {
        await ctx.container.database.db.execute(
          sql`ALTER TABLE notifications DROP CONSTRAINT wp18_break`,
        );
      }
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
