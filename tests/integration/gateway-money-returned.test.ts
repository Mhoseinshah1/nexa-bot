import { sql } from 'drizzle-orm';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  money,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type PanelId,
  type PaymentGatewayConfig,
  type PaymentGatewayProvider,
  type ProductCategoryId,
  type ProductId,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { DrizzleCustomerRepository } from '../../apps/api/src/modules/commerce/customers/infrastructure/drizzle-customer.repository';
import { DrizzlePaymentRepository } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-payment.repository';
import { DrizzlePaymentGatewayRepository } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-payment-gateway.repository';
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
import { TetraPayAdapter } from '../../apps/api/src/modules/commerce/payments/infrastructure/tetrapay-adapter';
import {
  GatewayPaymentService,
  gatewayCallbackUrl,
} from '../../apps/api/src/modules/commerce/payments/application/gateway-payment.service';
import { settingsLateCreditPolicy } from '../../apps/api/src/modules/commerce/payments/application/late-credit-policy';
import { DrizzleWalletRepository } from '../../apps/api/src/modules/commerce/wallet/infrastructure/drizzle-wallet.repository';
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
 * R12 F1 items 1 and 2 — gateway money for an attempt that can no longer pay its order is
 * RETURNED to the customer's wallet, through the late-credit lane, whatever the late-credit
 * switch says.
 *
 * 1. An attempt Nexa CANCELLED — the order was paid from the wallet (`settleFromWallet` ->
 *    `cancelPendingForOrder`), or the customer withdrew the payment (`withdrawPending`) — is
 *    still payable at the provider until its own deadline. It is asked about until then, and
 *    money the provider confirms for it goes to the wallet.
 * 2. A second provider's approval for an order another payment already settled used to be a
 *    late completion and nothing else (`ORDER_NOT_AWAITING_PAYMENT`). Its principal goes to the
 *    wallet; and the settlement closes the order's other open LINK attempts.
 *
 * Built like `late-gateway-credit.test.ts`: the container's own services decide everything,
 * the lane is built here over the container's database with the REAL TonPays and TetraPay
 * adapters whose `fetch` is a recording fake written from the documented shapes, and only the
 * lane's clock moves. Both routes' late-credit switches are set OFF in every case.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const BOT_USERNAME = 'nexa_test_bot';
const MARYAM = '910911';
const TONPAYS_KEY = 'tp_live_KEY_r12_f1_never_leaks_7c1';
const TETRAPAY_KEY = 'tetra_live_KEY_r12_f1_never_leaks_9a2';
const PRICE = 250_000n;

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

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The documented TonPays create and check shapes, and nothing more. */
class FakeTonPays {
  readonly invoices = new Map<
    string,
    { invoiceId: string; orderId: string; amount: number; status: string; paid: unknown }
  >();
  readonly checks: string[] = [];
  /** R12 F1 item 5: a `request_amount` the check reports instead of the invoice's own. */
  readonly reportedAmount = new Map<string, number>();
  private seq = 0;

  readonly fetch: FetchLike = async (url, init) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    if (url.endsWith('/api/v1/invoices/create')) {
      this.seq += 1;
      const invoiceId = `TP-${String(this.seq).padStart(8, '0')}`;
      const invoice = {
        invoiceId,
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
        request_amount: this.reportedAmount.get(invoiceId) ?? invoice.amount,
        final_amount: invoice.amount + 37,
        status: invoice.status,
        paid: invoice.paid,
      });
    }
    return json(404, { detail: { code: 'NOT_FOUND', message: 'x' } });
  };

  pay(invoiceId: string): void {
    const invoice = this.invoices.get(invoiceId);
    if (invoice === undefined) throw new Error(`no fake invoice ${invoiceId}`);
    invoice.status = 'completed';
    invoice.paid = true;
  }
}

/** The documented TetraPay create and verify shapes, and nothing more. */
class FakeTetraPay {
  readonly links: {
    token: string;
    orderId: string;
    amount: string;
    status: 'created' | 'paid';
  }[] = [];

  readonly fetch: FetchLike = async (url, init) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/api/v1/payments' && init.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      const link = {
        token: `tok${String(this.links.length + 1).padStart(4, '0')}ABCDEFGHIJ`,
        orderId: String(body['order_id']),
        amount: String(body['amount']),
        status: 'created' as 'created' | 'paid',
      };
      this.links.push(link);
      return json(201, {
        token: link.token,
        payment_url: `https://tetrapay.online/pay/${link.token}`,
        amount: link.amount,
        payable_amount: String(BigInt(link.amount) + 1_000n),
        expires_at: '2026-09-29T10:30:00.000Z',
      });
    }
    const verify = /^\/api\/v1\/payments\/([^/]+)\/verify$/u.exec(parsed.pathname);
    if (verify !== null && init.method === 'POST') {
      const token = decodeURIComponent(verify[1] ?? '');
      const link = this.links.find((one) => one.token === token);
      if (link === undefined) return json(404, { error: { code: 'NOT_FOUND', message: 'x' } });
      const paid = link.status === 'paid';
      return json(200, {
        token: link.token,
        status: link.status,
        order_id: link.orderId,
        amount: link.amount,
        payable_amount: String(BigInt(link.amount) + 1_000n),
        received_amount: paid ? String(BigInt(link.amount) + 1_000n) : null,
        net_amount: link.amount,
        fee_total: '1000',
        method: paid ? 'online' : null,
        paid_at: paid ? '2026-09-29T10:21:44.000Z' : null,
        verified_before: false,
      });
    }
    return json(404, { error: { code: 'NOT_FOUND', message: 'x' } });
  };

  pay(token: string): void {
    const link = this.links.find((one) => one.token === token);
    if (link === undefined) throw new Error(`no fake link ${token}`);
    link.status = 'paid';
  }
}

describe('R12 F1 — gateway money for an attempt that can no longer pay its order', () => {
  let ctx: TestContext;
  let panel: FakeMarzban;
  let products: DrizzleProductRepository;
  let panelId: string;
  let owner: ActorContext;
  let maryam: UserId;
  let tonpays: FakeTonPays;
  let tetrapay: FakeTetraPay;
  let lane: GatewayPaymentService;
  let offsetMs: number;
  let seq = 0;
  const key = (stem: string) => `r12f1-${stem}-${String((seq += 1))}`;

  beforeAll(async () => {
    ctx = await createTestContext({ PANEL_HTTP_ALLOW_LOOPBACK: 'true' });
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
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
      await createAdmin(ctx.container, tenantA, { username: 'owner-r12f1', roleKeys: ['owner'] }),
    );
    const created = await ctx.container.panels.create(tenantA, owner, {
      name: 'Marzban A',
      providerType: 'marzban',
      baseUrl: panel.baseUrl,
      credentials: { username: panel.username, password: panel.password },
      activation: { proxyProtocols: ['vless'], inboundTags: { vless: ['VLESS TCP'] } },
      idempotencyKey: 'panel-r12f1-create',
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
      sql`UPDATE bot_instances SET webhook_url = ${`https://bot.example.com/telegram/webhook/${BOT_A}`},
          username = ${BOT_USERNAME} WHERE tenant_id = ${tenantA.tenantId} AND id = ${BOT_A}`,
    );
    tonpays = new FakeTonPays();
    tetrapay = new FakeTetraPay();
    offsetMs = 0;
    lane = laneWith();
    /*
     * Both routes' late-credit switches OFF, explicitly (TonPays' default is ON): everything
     * returned below is returned whatever the switch says.
     */
    await setSetting('payments.late_credit.tonpays_enabled', false);
    await setSetting('payments.late_credit.tetrapay_enabled', false);
  });

  async function setSetting(settingKey: string, value: unknown) {
    const current = (await ctx.container.settingsService.list(tenantA, owner)).find(
      (row) => row.key === settingKey,
    );
    await ctx.container.settingsService.set(tenantA, owner, {
      key: settingKey,
      value,
      expectedVersion: current?.version ?? null,
      idempotencyKey: key('setting'),
    });
  }

  /** The production lane's wiring: the same policy reader and the same credit path. */
  function laneWith(): GatewayPaymentService {
    const db = ctx.container.database.db;
    const tonpaysAdapter = new TonPaysAdapter({ fetch: tonpays.fetch });
    const tetrapayAdapter = new TetraPayAdapter({
      fetch: tetrapay.fetch,
      baseUrl: 'https://api.tetra98.com/api/v1',
      now: () => new Date(Date.now() + offsetMs),
    });
    const origins = new DrizzlePublicOriginReader(db);
    return new GatewayPaymentService({
      invoices: new DrizzleGatewayInvoiceRepository(db),
      payments: ctx.container.payments,
      paymentRecords: new DrizzlePaymentRepository(db),
      adapters: (provider) =>
        provider === 'TONPAYS' ? tonpaysAdapter : provider === 'TETRAPAY' ? tetrapayAdapter : null,
      credentials: new DrizzleGatewayCredentialStore(db, ctx.container.cipher, () =>
        ctx.container.ids.uuid(),
      ),
      botTokens: { tokenForBotInstance: () => Promise.resolve(null) },
      presentation: () => Promise.reject(new Error('these routes render no invoice text')),
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
      botLinkFor: (scope) => origins.botLinkFor(scope),
      routeVisibility: new DrizzlePaymentGatewayRepository(db),
      lateCredit: {
        policyFor: settingsLateCreditPolicy(ctx.container.settingsResolver),
        credit: (scope, actor, id, input) =>
          ctx.container.payments.creditLateGatewayApproval(scope, actor, id, input),
      },
    });
  }

  // -------------------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------------------

  async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
    return (await ctx.container.database.db.execute(query)).rows as T[];
  }

  async function enable(provider: PaymentGatewayProvider, apiKey: string) {
    await ctx.container.paymentGateways.configure(tenantA, owner, {
      idempotencyKey: key('cfg'),
      provider,
      config: OPEN_ROUTE,
    });
    await ctx.container.paymentGateways.setCredential(tenantA, owner, {
      idempotencyKey: key('cred'),
      provider,
      apiKey,
    });
    await ctx.container.paymentGateways.setStatus(tenantA, owner, {
      idempotencyKey: key('on'),
      provider,
      status: 'ACTIVE',
    });
  }

  async function product(): Promise<ProductId> {
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
        price: money(PRICE, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, row.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    return row.id;
  }

  /** An order awaiting payment, drafted and confirmed by the order service. */
  async function awaitingOrder(): Promise<string> {
    const productId = await product();
    const k = key('order');
    const draft = await ctx.container.orders.createDraft(tenantA, systemActor(k), {
      idempotencyKey: `${k}-draft`,
      customerId: maryam,
      productId,
    });
    const order = await ctx.container.orders.confirm(tenantA, systemActor(k), {
      idempotencyKey: `${k}-confirm`,
      customerId: maryam,
      orderId: draft.id,
    });
    expect(order.state).toBe('AWAITING_PAYMENT');
    return order.id;
  }

  /** A created attempt through `provider` for the order; returns its payment and invoice id. */
  async function attempt(orderId: string, provider: 'TONPAYS' | 'TETRAPAY') {
    const opened = await ctx.container.payments.requestGatewayPayment(
      { ...tenantA, botInstanceId: BOT_A },
      systemActor(key('attempt')),
      maryam,
      { idempotencyKey: key('attempt'), orderId, provider },
    );
    await pass();
    const invoice = await invoiceOf(opened.payment.id);
    if (invoice.provider_invoice_id === null) throw new Error(`${provider} not created`);
    return { paymentId: opened.payment.id, invoiceId: invoice.provider_invoice_id };
  }

  const pass = () => lane.runOnce(tenantA);

  /** A pass a little later: every row scheduled inside the next minutes is due. */
  async function laterPass(ms = 3 * 60_000) {
    offsetMs += ms;
    return pass();
  }

  async function invoiceOf(paymentId: string) {
    const [row] = await rows<{
      provider_invoice_id: string | null;
      outcome: string | null;
      next_inquiry_at: Date | null;
      late_completion_observed_at: Date | null;
    }>(sql`SELECT * FROM gateway_invoices WHERE payment_id = ${paymentId}`);
    if (row === undefined) throw new Error('no invoice row');
    return row;
  }

  const paymentState = async (paymentId: string) =>
    (await rows<{ state: string }>(sql`SELECT state FROM payments WHERE id = ${paymentId}`))[0]
      ?.state;

  const orderState = async (orderId: string) =>
    (await rows<{ state: string }>(sql`SELECT state FROM orders WHERE id = ${orderId}`))[0]?.state;

  const lateCredits = (paymentId: string) =>
    rows<{ reason: string; direction: string; amount: string; reference: string }>(
      sql`SELECT reason, direction, amount::text AS amount, reference FROM wallet_entries
           WHERE tenant_id = ${tenantA.tenantId} AND payment_id = ${paymentId}
             AND reason = 'GATEWAY_LATE_CREDIT'`,
    );

  const walletTotal = async () =>
    (await new DrizzleWalletRepository(ctx.container.database.db).balanceOf(tenantA, maryam, 'IRT'))
      .amountMinor;

  const notices = (paymentId: string) =>
    rows<{ kind: string }>(
      sql`SELECT kind FROM customer_notifications WHERE tenant_id = ${tenantA.tenantId}
           AND subject_id = ${paymentId} ORDER BY created_at, kind`,
    );

  const creditedEvents = (paymentId: string) =>
    rows<{ payload: Record<string, unknown> }>(
      sql`SELECT payload FROM outbox_messages
           WHERE event_type = 'PaymentLateCredited' AND aggregate_id = ${paymentId}`,
    );

  async function fundWallet(amountMinor = PRICE) {
    await ctx.container.wallet.adjust(tenantA, owner, maryam, {
      idempotencyKey: key('fund'),
      direction: 'CREDIT',
      amountMinor,
      currency: 'IRT',
      note: 'موجودی آزمایشی',
    });
  }

  const payFromWallet = (orderId: string) =>
    ctx.container.payments.settleFromWallet(
      { ...tenantA, botInstanceId: BOT_A },
      systemActor(key('wallet')),
      maryam,
      { idempotencyKey: key('wallet'), orderId },
    );

  /** The money returned once: one GATEWAY_LATE_CREDIT of the principal, told once, RETURNED. */
  async function expectReturnedOnce(paymentId: string) {
    const credits = await lateCredits(paymentId);
    expect(credits).toEqual([
      {
        reason: 'GATEWAY_LATE_CREDIT',
        direction: 'CREDIT',
        amount: PRICE.toString(),
        reference: `${paymentId}:late-credit`,
      },
    ]);
    expect((await notices(paymentId)).map((one) => one.kind)).toContain(
      'GATEWAY_LATE_PAYMENT_CREDITED',
    );
    const events = await creditedEvents(paymentId);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ basis: 'RETURNED', amountMinor: PRICE.toString() });
    expect((await invoiceOf(paymentId)).outcome).toBe('LATE_CREDITED');
    const [audit] = await rows<{ after: Record<string, unknown> }>(
      sql`SELECT after FROM audit_logs WHERE entity_id = ${paymentId}
           AND action = 'payment.gateway_late_credit'`,
    );
    expect(audit?.after).toMatchObject({ basis: 'RETURNED', credited: true });
  }

  // -------------------------------------------------------------------------------------
  // Item 1 — a CANCELLED attempt
  // -------------------------------------------------------------------------------------

  describe('item 1: money the provider confirms for a CANCELLED attempt', () => {
    it('paid after the wallet settled: the principal is returned to the wallet once, with the late-credit switch OFF', async () => {
      await enable('TONPAYS', TONPAYS_KEY);
      const orderId = await awaitingOrder();
      const { paymentId, invoiceId } = await attempt(orderId, 'TONPAYS');
      await fundWallet();
      await payFromWallet(orderId);
      // `settleFromWallet` withdrew the open TonPays attempt; the order is the wallet's.
      expect(await paymentState(paymentId)).toBe('CANCELLED');
      expect(await orderState(orderId)).toBe('PAID');
      expect(await walletTotal()).toBe(0n);

      // The customer had the TonPays link open and paid it anyway.
      tonpays.pay(invoiceId);
      await laterPass();

      await expectReturnedOnce(paymentId);
      expect(await walletTotal()).toBe(PRICE);
      // Nothing else moved: the payment stays CANCELLED, the order stays the wallet's.
      expect(await paymentState(paymentId)).toBe('CANCELLED');
      expect(await orderState(orderId)).toBe('PAID');

      // Asked again (a webhook, a repeated pass): never credited twice.
      await laterPass();
      await laterPass();
      expect(await lateCredits(paymentId)).toHaveLength(1);
      expect(await walletTotal()).toBe(PRICE);
    });

    it('paid after the customer withdrew the attempt: returned, the order left awaiting payment', async () => {
      await enable('TONPAYS', TONPAYS_KEY);
      const orderId = await awaitingOrder();
      const { paymentId, invoiceId } = await attempt(orderId, 'TONPAYS');
      await ctx.container.payments.withdrawPending(
        { ...tenantA, botInstanceId: BOT_A },
        systemActor(key('withdraw')),
        maryam,
        { idempotencyKey: key('withdraw'), paymentId },
      );
      expect(await paymentState(paymentId)).toBe('CANCELLED');

      tonpays.pay(invoiceId);
      await laterPass();

      await expectReturnedOnce(paymentId);
      expect(await walletTotal()).toBe(PRICE);
      expect(await orderState(orderId)).toBe('AWAITING_PAYMENT');
    });

    it('keeps asking about a CANCELLED attempt on its ordinary schedule until its deadline — a payment two inquiries later is still returned', async () => {
      await enable('TONPAYS', TONPAYS_KEY);
      const orderId = await awaitingOrder();
      const { paymentId, invoiceId } = await attempt(orderId, 'TONPAYS');
      await fundWallet();
      await payFromWallet(orderId);

      // First inquiry after the cancel: still pending at TonPays. The row stays scheduled.
      const before = tonpays.checks.length;
      await laterPass();
      expect(tonpays.checks.length).toBeGreaterThan(before);
      expect((await invoiceOf(paymentId)).next_inquiry_at).not.toBeNull();
      expect(await lateCredits(paymentId)).toHaveLength(0);

      // Paid later, still inside the attempt's 70 minutes.
      tonpays.pay(invoiceId);
      await laterPass(10 * 60_000);
      await expectReturnedOnce(paymentId);
    });

    it('stops asking once the CANCELLED attempt’s own deadline has passed', async () => {
      await enable('TONPAYS', TONPAYS_KEY);
      const orderId = await awaitingOrder();
      const { paymentId } = await attempt(orderId, 'TONPAYS');
      await fundWallet();
      await payFromWallet(orderId);

      // Past the attempt's deadline; a row still due is asked at most once more, then dropped.
      offsetMs += 75 * 60_000;
      await pass();
      await pass();
      expect((await invoiceOf(paymentId)).next_inquiry_at).toBeNull();
      const asked = tonpays.checks.length;
      await laterPass(60 * 60_000);
      expect(tonpays.checks.length).toBe(asked);
      expect(await lateCredits(paymentId)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------------------
  // Item 2 — a second gateway payment for an order already paid
  // -------------------------------------------------------------------------------------

  describe('item 2: two providers, one order', () => {
    it('the first approval settles the order and closes the other link; money the second provider still confirms is returned to the wallet', async () => {
      await enable('TONPAYS', TONPAYS_KEY);
      await enable('TETRAPAY', TETRAPAY_KEY);
      const orderId = await awaitingOrder();
      const first = await attempt(orderId, 'TONPAYS');
      const second = await attempt(orderId, 'TETRAPAY');

      tonpays.pay(first.invoiceId);
      await laterPass();
      expect(await paymentState(first.paymentId)).toBe('CONFIRMED');
      expect(await orderState(orderId)).toBe('PAID');
      // The settlement closed TetraPay's open link in the same transaction.
      expect(await paymentState(second.paymentId)).toBe('CANCELLED');
      const [closed] = await rows<{ after: Record<string, unknown> }>(
        sql`SELECT after FROM audit_logs WHERE entity_id = ${second.paymentId}
             AND action = 'payment.withdraw'`,
      );
      expect(closed?.after).toMatchObject({
        state: 'CANCELLED',
        withdrawnBy: 'ORDER_SETTLED',
        settledByPaymentId: first.paymentId,
      });

      // The customer paid the TetraPay link as well.
      tetrapay.pay(second.invoiceId);
      await laterPass();
      await expectReturnedOnce(second.paymentId);
      expect(await walletTotal()).toBe(PRICE);
      // One confirmed payment for the order, and it is still the first.
      const confirmed = await rows<{ id: string }>(
        sql`SELECT id FROM payments WHERE order_id = ${orderId} AND state = 'CONFIRMED'`,
      );
      expect(confirmed.map((one) => one.id)).toEqual([first.paymentId]);
    });

    it('a sibling the settlement could not close (its row was held) is returned through ORDER_NOT_AWAITING_PAYMENT', async () => {
      await enable('TONPAYS', TONPAYS_KEY);
      await enable('TETRAPAY', TETRAPAY_KEY);
      const orderId = await awaitingOrder();
      const first = await attempt(orderId, 'TONPAYS');
      const second = await attempt(orderId, 'TETRAPAY');

      /*
       * Another transaction holds TetraPay's payment row while TonPays settles (its own
       * settlement, say): the sibling close skips a locked row rather than waiting on it.
       */
      const holder = new Client({ connectionString: process.env['TEST_DATABASE_URL'] });
      await holder.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM payments WHERE id = $1 FOR UPDATE', [second.paymentId]);
        tonpays.pay(first.invoiceId);
        await laterPass();
        await holder.query('ROLLBACK');
      } finally {
        await holder.end();
      }
      expect(await orderState(orderId)).toBe('PAID');
      expect(await paymentState(second.paymentId)).toBe('PENDING');

      tetrapay.pay(second.invoiceId);
      await laterPass();
      await expectReturnedOnce(second.paymentId);
      expect(await walletTotal()).toBe(PRICE);
      // Not a late completion: the money is accounted for.
      expect((await invoiceOf(second.paymentId)).late_completion_observed_at).toBeNull();
      // And the PENDING payment can never settle the order now.
      expect(await paymentState(first.paymentId)).toBe('CONFIRMED');
    });
  });

  describe('item 5: TonPays approval and the amount', () => {
    it('an approval whose request_amount is not what Nexa sent is held for an operator, never settled', async () => {
      await enable('TONPAYS', TONPAYS_KEY);
      const orderId = await awaitingOrder();
      const { paymentId, invoiceId } = await attempt(orderId, 'TONPAYS');
      tonpays.pay(invoiceId);
      // Nexa sent 250,000 Toman; the check says the invoice asked for 25,000.
      tonpays.reportedAmount.set(invoiceId, 25_000);
      await laterPass();

      expect(await paymentState(paymentId)).toBe('UNKNOWN');
      expect(await orderState(orderId)).toBe('AWAITING_PAYMENT');
      expect(await lateCredits(paymentId)).toHaveLength(0);
      expect(await walletTotal()).toBe(0n);
      const [held] = await rows<{ provider_paid: boolean | null }>(
        sql`SELECT provider_paid FROM gateway_invoices WHERE payment_id = ${paymentId}`,
      );
      expect(held?.provider_paid).toBe(false);
    });

    it('the figure Nexa sent settles as before', async () => {
      await enable('TONPAYS', TONPAYS_KEY);
      const orderId = await awaitingOrder();
      const { paymentId, invoiceId } = await attempt(orderId, 'TONPAYS');
      tonpays.pay(invoiceId);
      tonpays.reportedAmount.set(invoiceId, Number(PRICE));
      await laterPass();
      expect(await paymentState(paymentId)).toBe('CONFIRMED');
      expect(await orderState(orderId)).toBe('PAID');
    });
  });

  it('a late-credit reference is never written for a payment whose approval settled its order', async () => {
    await enable('TONPAYS', TONPAYS_KEY);
    const orderId = await awaitingOrder();
    const { paymentId, invoiceId } = await attempt(orderId, 'TONPAYS');
    tonpays.pay(invoiceId);
    await laterPass();
    expect(await paymentState(paymentId)).toBe('CONFIRMED');
    await laterPass();
    expect(await lateCredits(paymentId)).toHaveLength(0);
    expect(await walletTotal()).toBe(0n);
  });
});
