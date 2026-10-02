import { createHmac } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  isNexaError,
  money,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type PaymentGatewayConfig,
  type PaymentId,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import { DrizzleCustomerRepository } from '../../apps/api/src/modules/commerce/customers/infrastructure/drizzle-customer.repository';
import { DrizzlePaymentRepository } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-payment.repository';
import { DrizzleGatewayInvoiceRepository } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-gateway-invoice.repository';
import {
  DrizzleGatewayCallBudget,
  DrizzleGatewayCredentialStore,
  DrizzlePublicOriginReader,
} from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-gateway-credentials';
import { NowPaymentsAdapter } from '../../apps/api/src/modules/commerce/payments/infrastructure/nowpayments-adapter';
import type { FetchLike } from '../../apps/api/src/modules/commerce/payments/infrastructure/tonpays-adapter';
import { sortDeep } from '../../apps/api/src/modules/commerce/payments/infrastructure/nowpayments-signature';
import {
  GatewayPaymentService,
  gatewayCallbackUrl,
} from '../../apps/api/src/modules/commerce/payments/application/gateway-payment.service';
import { DrizzleOperationalConditionReader } from '../../apps/api/src/modules/platform/opslog/infrastructure/drizzle-operational-event.reader';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  SEED_IDS,
  tenantA,
  type TestContext,
} from './harness';

/**
 * NOWPayments, end to end against a real database (`docs/nowpayments-gateway-audit.md`).
 *
 * The container's own services decide everything — `PaymentService` and its one settlement
 * path, the gateway route service, the central FX quote. The gateway LANE is built here
 * over the container's database with the REAL `NowPaymentsAdapter`, whose `fetch` is a
 * recording fake NOWPayments written from the documented shapes; nothing leaves the process.
 * The lane's clock is the only clock moved; a payment's deadline is moved on its row.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const MARYAM = '910911';
const API_KEY = 'np_live_KEY_that_must_never_leak_5e1f';
const IPN_SECRET = 'np_IPN_secret_that_must_never_leak_0c9d';
/** 103,500 Toman per USDT; 1,035,000 Toman is exactly ten dollars. */
const RATE_TOMAN_PER_USDT = 103_500n;
const TOPUP_TOMAN = 1_035_000n;

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
// A fake NOWPayments: the documented request and response shapes, and nothing more.
// ---------------------------------------------------------------------------------------

interface FakePayment {
  payment_id: number;
  invoice_id: number;
  order_id: string;
  payment_status: string;
  price_amount: number;
  price_currency: string;
  pay_currency: string;
  updated_at: string;
}

class FakeNowPayments {
  readonly invoices = new Map<number, { orderId: string; priceAmount: number }>();
  readonly payments = new Map<number, FakePayment>();
  readonly creates: Record<string, unknown>[] = [];
  readonly reads: string[] = [];
  readonly lists: string[] = [];
  readonly headers: Record<string, string>[] = [];
  listStatus = 200;
  private seq = 4_522_625_000;

  readonly fetch: FetchLike = async (url, init) => {
    this.headers.push(init.headers as Record<string, string>);
    const parsed = new URL(url);
    if (parsed.pathname === '/v1/invoice' && init.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      this.creates.push(body);
      this.seq += 1;
      this.invoices.set(this.seq, {
        orderId: String(body.order_id),
        priceAmount: Number(body.price_amount),
      });
      return json(200, {
        id: String(this.seq),
        order_id: body.order_id,
        price_amount: String(body.price_amount),
        price_currency: body.price_currency,
        pay_currency: null,
        ipn_callback_url: body.ipn_callback_url,
        invoice_url: `https://nowpayments.io/payment/?iid=${String(this.seq)}`,
      });
    }
    if (parsed.pathname === '/v1/payment/' && init.method === 'GET') {
      const invoiceId = parsed.searchParams.get('invoiceId') ?? '';
      this.lists.push(invoiceId);
      if (this.listStatus !== 200) return json(this.listStatus, { code: 'AUTH_REQUIRED' });
      return json(200, {
        data: [...this.payments.values()].filter((p) => String(p.invoice_id) === invoiceId),
        limit: 100,
        page: 0,
        pagesCount: 1,
        total: 1,
      });
    }
    const one = /^\/v1\/payment\/([0-9]+)$/u.exec(parsed.pathname);
    if (one !== null && init.method === 'GET') {
      this.reads.push(one[1] ?? '');
      const payment = this.payments.get(Number(one[1]));
      return payment === undefined ? json(404, { code: 'NOT_FOUND' }) : json(200, payment);
    }
    return json(404, { code: 'NOT_FOUND' });
  };

  /** The customer opened the invoice and chose a coin: a payment exists under it. */
  pay(invoiceId: string, paymentId: number, status: string, priceAmount?: number): FakePayment {
    const invoice = this.invoices.get(Number(invoiceId));
    if (invoice === undefined) throw new Error(`no fake invoice ${invoiceId}`);
    const payment: FakePayment = {
      payment_id: paymentId,
      invoice_id: Number(invoiceId),
      order_id: invoice.orderId,
      payment_status: status,
      price_amount: priceAmount ?? invoice.priceAmount,
      price_currency: 'usd',
      pay_currency: 'usdttrc20',
      updated_at: new Date().toISOString(),
    };
    this.payments.set(paymentId, payment);
    return payment;
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const signed = (body: unknown, secret = IPN_SECRET) =>
  createHmac('sha512', secret)
    .update(JSON.stringify(sortDeep(body)))
    .digest('hex');

describe('NOWPayments, through the one settlement path', () => {
  let ctx: TestContext;
  let owner: ActorContext;
  let maryam: UserId;
  let fake: FakeNowPayments;
  let lane: GatewayPaymentService;
  let offsetMs: number;
  let seq = 0;
  const logged: string[] = [];
  const key = () => `np-key-${String((seq += 1)).padStart(4, '0')}`;

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    ctx.container.setInstallationTenant(tenantA.tenantId);
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-np', roleKeys: ['owner'] }),
    );
    maryam = (
      await ctx.container.customers.resolveFromUpdate(tenantA, systemActor('resolve-np'), {
        idempotencyKey: 'resolve-np',
        telegramUserId: MARYAM,
        from: { id: Number(MARYAM), first_name: 'مریم' },
        botInstanceId: BOT_A,
      })
    ).customer.id;
    await ctx.container.database.db.execute(
      sql`UPDATE bot_instances SET webhook_url = ${`https://bot.example.com/telegram/webhook/${BOT_A}`}
          WHERE tenant_id = ${tenantA.tenantId}`,
    );
    fake = new FakeNowPayments();
    offsetMs = 0;
    logged.length = 0;
    lane = laneWith(fake);
  });

  function laneWith(nowpayments: FakeNowPayments): GatewayPaymentService {
    const db = ctx.container.database.db;
    const adapter = new NowPaymentsAdapter({ fetch: nowpayments.fetch });
    const origins = new DrizzlePublicOriginReader(db);
    const log = (context: Record<string, unknown>, message: string) => {
      logged.push(`${message} ${JSON.stringify(context)}`);
    };
    return new GatewayPaymentService({
      invoices: new DrizzleGatewayInvoiceRepository(db),
      payments: ctx.container.payments,
      paymentRecords: new DrizzlePaymentRepository(db),
      adapters: (provider) => (provider === 'NOWPAYMENTS' ? adapter : null),
      credentials: new DrizzleGatewayCredentialStore(db, ctx.container.cipher, () =>
        ctx.container.ids.uuid(),
      ),
      botTokens: { tokenForBotInstance: () => Promise.resolve(null) },
      presentation: () => Promise.reject(new Error('NOWPayments renders no invoice text')),
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
      logger: { info: log, warn: log, error: log },
    });
  }

  // -------------------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------------------

  async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
    return (await ctx.container.database.db.execute(query)).rows as T[];
  }

  /** The central USDT quote (package FX), fresh, and the feature on. */
  async function centralQuote(rate = RATE_TOMAN_PER_USDT) {
    const current = await ctx.container.featureFlagResolver.resolve(tenantA, 'central_fx');
    await ctx.container.featureFlags.set(tenantA, owner, {
      key: 'central_fx',
      enabled: true,
      expectedVersion: current.version,
      idempotencyKey: key(),
      reason: 'NOWPayments integration test.',
    });
    await ctx.container.database.db.execute(
      sql`INSERT INTO fx_quotes (tenant_id, base_asset, quote_currency, rate_mantissa, rate_scale,
                                 source, source_at, fetched_at, quote_id, policy_version)
          VALUES (${tenantA.tenantId}, 'USDT', 'IRT', ${rate}, 0, 'WALLEX', NULL, now(),
                  ${`v1:WALLEX:USDT-IRT:${String(rate)}e-0:-:test`}, 1)
          ON CONFLICT (tenant_id, base_asset, quote_currency) DO UPDATE
            SET rate_mantissa = EXCLUDED.rate_mantissa, fetched_at = now(), quote_id = EXCLUDED.quote_id`,
    );
  }

  async function enableNowPayments() {
    await ctx.container.paymentGateways.configure(tenantA, owner, {
      idempotencyKey: key(),
      provider: 'NOWPAYMENTS',
      config: OPEN_ROUTE,
    });
    await ctx.container.paymentGateways.setCredential(tenantA, owner, {
      idempotencyKey: key(),
      provider: 'NOWPAYMENTS',
      apiKey: API_KEY,
    });
    await ctx.container.paymentGateways.setWebhookSecret(tenantA, owner, {
      idempotencyKey: key(),
      provider: 'NOWPAYMENTS',
      secret: IPN_SECRET,
    });
    await ctx.container.paymentGateways.setStatus(tenantA, owner, {
      idempotencyKey: key(),
      provider: 'NOWPAYMENTS',
      status: 'ACTIVE',
    });
    await centralQuote();
  }

  const topup = (amountMinor = TOPUP_TOMAN) => {
    const k = key();
    return ctx.container.payments.requestGatewayTopup(tenantA, systemActor(k), maryam, {
      idempotencyKey: k,
      amount: money(amountMinor, 'IRT'),
      provider: 'NOWPAYMENTS',
    });
  };

  const pass = () => lane.runOnce(tenantA);
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
      provider_unit: string;
      sent_amount: string;
      conversion_policy: string;
      fx_rate_mantissa: string | null;
      invoice_url: string | null;
      outcome: string | null;
      next_inquiry_at: Date | null;
      hinted_payment_id: string | null;
      webhook_count: number;
      late_completion_observed_at: Date | null;
    }>(sql`SELECT * FROM gateway_invoices WHERE payment_id = ${paymentId}`);
    if (row === undefined) throw new Error('no invoice row');
    return row;
  }

  async function paymentOf(paymentId: string) {
    const [row] = await rows<{
      state: string;
      evidence_kind: string | null;
      evidence_note: string | null;
      provider_review_until: Date | null;
    }>(sql`SELECT * FROM payments WHERE id = ${paymentId}`);
    if (row === undefined) throw new Error('no payment');
    return row;
  }

  const ledger = () =>
    rows<{ reason: string; amount: string; payment_id: string | null }>(
      sql`SELECT reason, amount::text AS amount, payment_id FROM wallet_entries
          WHERE tenant_id = ${tenantA.tenantId} AND customer_id = ${maryam} ORDER BY created_at, reason`,
    );

  const openConditions = async () =>
    (
      await rows<{ code: string }>(
        sql`SELECT code FROM operational_events WHERE tenant_id = ${tenantA.tenantId}
            AND resolved_at IS NULL ORDER BY code`,
      )
    ).map((row) => row.code);

  /** A created invoice for a fresh top-up attempt. */
  async function createdAttempt(): Promise<{ paymentId: PaymentId; invoiceId: string }> {
    const attempt = await topup();
    await pass();
    const invoice = await invoiceOf(attempt.payment.id);
    if (invoice.provider_invoice_id === null) throw new Error('not created');
    return { paymentId: attempt.payment.id, invoiceId: invoice.provider_invoice_id };
  }

  const ipn = (payment: FakePayment, signature?: string) =>
    lane.receiveWebhook(
      String(tenantA.tenantId),
      'NOWPAYMENTS',
      payment,
      undefined,
      signature ?? signed(payment),
    );

  // -------------------------------------------------------------------------------------

  describe('the route and its secrets', () => {
    it('cannot be enabled without the key AND the IPN secret, and the secret needs the key first', async () => {
      await ctx.container.paymentGateways.configure(tenantA, owner, {
        idempotencyKey: key(),
        provider: 'NOWPAYMENTS',
        config: OPEN_ROUTE,
      });
      const early = await ctx.container.paymentGateways
        .setWebhookSecret(tenantA, owner, {
          idempotencyKey: key(),
          provider: 'NOWPAYMENTS',
          secret: IPN_SECRET,
        })
        .catch((error: unknown) => error);
      expect(isNexaError(early) && early.details).toMatchObject({ reason: 'CREDENTIAL_MISSING' });
      await ctx.container.paymentGateways.setCredential(tenantA, owner, {
        idempotencyKey: key(),
        provider: 'NOWPAYMENTS',
        apiKey: API_KEY,
      });
      const refused = await ctx.container.paymentGateways
        .setStatus(tenantA, owner, {
          idempotencyKey: key(),
          provider: 'NOWPAYMENTS',
          status: 'ACTIVE',
        })
        .catch((error: unknown) => error);
      expect(isNexaError(refused) && refused.details).toMatchObject({
        reason: 'WEBHOOK_SECRET_MISSING',
      });
      // TonPays takes no webhook secret.
      const tonpays = await ctx.container.paymentGateways
        .setWebhookSecret(tenantA, owner, {
          idempotencyKey: key(),
          provider: 'TONPAYS',
          secret: 'x',
        })
        .catch((error: unknown) => error);
      expect(isNexaError(tonpays)).toBe(true);
    });

    it('never returns, audits or logs the key or the IPN secret, and stores both encrypted', async () => {
      await enableNowPayments();
      const { gateways, facts } = await ctx.container.paymentGateways.list(tenantA, owner);
      const view = JSON.stringify(
        { gateways, facts: [...facts.entries()] },
        (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
      );
      expect(view).not.toContain(API_KEY);
      expect(view).not.toContain(IPN_SECRET);
      const facts0 = facts.get('NOWPAYMENTS');
      expect(facts0?.credentialSetAt).not.toBeNull();
      expect(facts0?.webhookSecretSetAt).not.toBeNull();
      const stored = JSON.stringify(
        await rows(sql`SELECT * FROM payment_gateway_credentials WHERE provider = 'NOWPAYMENTS'`),
      );
      expect(stored).not.toContain(API_KEY);
      expect(stored).not.toContain(IPN_SECRET);
      // A whole lane run, with a webhook, logs neither.
      const { invoiceId } = await createdAttempt();
      await ipn(fake.pay(invoiceId, 77, 'finished'));
      await inquireNow();
      const everything =
        JSON.stringify(
          await rows(
            sql`SELECT before, after FROM audit_logs WHERE tenant_id = ${tenantA.tenantId}`,
          ),
        ) +
        JSON.stringify(await rows(sql`SELECT context, message FROM operational_events`)) +
        logged.join('\n');
      expect(everything).not.toContain(API_KEY);
      expect(everything).not.toContain(IPN_SECRET);
      // The key travelled in its header only.
      expect(fake.headers.every((headers) => headers['x-api-key'] === API_KEY)).toBe(true);
    });
  });

  describe('pricing and the hosted invoice', () => {
    it('prices in US cents from the central quote, snapshots it, and never names a coin', async () => {
      await enableNowPayments();
      const { paymentId } = await createdAttempt();
      const invoice = await invoiceOf(paymentId);
      expect(invoice).toMatchObject({
        creation_state: 'CREATED',
        provider_unit: 'USD',
        conversion_policy: 'CENTRAL_FX',
      });
      expect(String(invoice.fx_rate_mantissa)).toBe(String(RATE_TOMAN_PER_USDT));
      expect(String(invoice.sent_amount)).toBe('1000');
      expect(invoice.invoice_url).toMatch(/^https:\/\/nowpayments\.io\//u);
      expect(fake.creates).toHaveLength(1);
      expect(fake.creates[0]).toEqual({
        price_amount: 10,
        price_currency: 'usd',
        order_id: invoice.provider_order_id,
        ipn_callback_url: `https://bot.example.com/payments/webhook/nowpayments/${String(tenantA.tenantId)}`,
      });
      expect(fake.creates[0]).not.toHaveProperty('pay_currency');
    });

    it('refuses a new attempt when no usable central quote exists, rather than guessing a rate', async () => {
      await enableNowPayments();
      await ctx.container.database.db.execute(
        sql`UPDATE fx_quotes SET fetched_at = now() - interval '2 days' WHERE tenant_id = ${tenantA.tenantId}`,
      );
      const refused = await topup().catch((error: unknown) => error);
      expect(isNexaError(refused) && refused.details).toMatchObject({ reason: 'FX_UNAVAILABLE' });
    });
  });

  describe('settlement: only the authoritative read of a finished payment', () => {
    it('settles once, after a verified IPN brings the read forward, never on the IPN itself', async () => {
      await enableNowPayments();
      const { paymentId, invoiceId } = await createdAttempt();
      const payment = fake.pay(invoiceId, 5_077_125_051, 'finished');
      expect(await ipn(payment)).toBe('SCHEDULED');
      // The IPN alone moved nothing.
      expect((await paymentOf(paymentId)).state).toBe('PENDING');
      expect(await ledger()).toEqual([]);
      expect((await invoiceOf(paymentId)).hinted_payment_id).toBe('5077125051');
      await pass();
      expect(fake.reads).toEqual(['5077125051']);
      expect(await paymentOf(paymentId)).toMatchObject({
        state: 'CONFIRMED',
        evidence_kind: 'GATEWAY_INQUIRY',
        evidence_note: 'nowpayments:finished:paid',
      });
      expect(await ledger()).toEqual([
        { reason: 'TOPUP_GATEWAY', amount: String(TOPUP_TOMAN), payment_id: paymentId },
      ]);
      expect((await invoiceOf(paymentId)).outcome).toBe('SETTLED');
    });

    it('treats a duplicate IPN as a duplicate, and credits exactly once whatever repeats', async () => {
      await enableNowPayments();
      const { paymentId, invoiceId } = await createdAttempt();
      const payment = fake.pay(invoiceId, 91, 'finished');
      expect(await ipn(payment)).toBe('SCHEDULED');
      expect(await ipn(payment)).toBe('DUPLICATE');
      await pass();
      await ipn({ ...payment, updated_at: new Date(Date.now() + 1000).toISOString() });
      await inquireNow();
      await inquireNow();
      await ctx.container.payments.confirmGatewayPayment(tenantA, systemActor('again'), paymentId, {
        evidenceNote: null,
      });
      expect(await ledger()).toHaveLength(1);
      expect((await paymentOf(paymentId)).state).toBe('CONFIRMED');
    });

    it('drops an IPN whose signature does not verify — tampered, missing or another secret — unread', async () => {
      await enableNowPayments();
      const { paymentId, invoiceId } = await createdAttempt();
      const payment = fake.pay(invoiceId, 42, 'finished');
      const good = signed(payment);
      expect(await ipn({ ...payment, payment_status: 'waiting' }, good)).toBe('IGNORED_UNVERIFIED');
      expect(
        await lane.receiveWebhook(
          String(tenantA.tenantId),
          'NOWPAYMENTS',
          payment,
          undefined,
          undefined,
        ),
      ).toBe('IGNORED_UNVERIFIED');
      expect(await ipn(payment, signed(payment, 'another-secret'))).toBe('IGNORED_UNVERIFIED');
      const invoice = await invoiceOf(paymentId);
      expect(invoice.webhook_count).toBe(0);
      expect(invoice.hinted_payment_id).toBeNull();
      expect(await openConditions()).toContain('payments.gateway_webhook_unverified');
      // A verified one recovers the condition.
      expect(await ipn(payment, good)).toBe('SCHEDULED');
      expect(await openConditions()).not.toContain('payments.gateway_webhook_unverified');
    });

    it('never fulfils a partial payment: the payment goes to UNKNOWN for an operator, nothing credited', async () => {
      await enableNowPayments();
      const { paymentId, invoiceId } = await createdAttempt();
      await ipn(fake.pay(invoiceId, 55, 'partially_paid'));
      await pass();
      expect((await paymentOf(paymentId)).state).toBe('UNKNOWN');
      expect(await ledger()).toEqual([]);
      expect(await openConditions()).toContain('payments.gateway_review_unresolved');
      // Not confirmable on that evidence; failable.
      const confirm = await ctx.container.payments
        .reconcileGatewayPayment(tenantA, owner, paymentId, {
          to: 'CONFIRMED',
          note: null,
          idempotencyKey: key(),
        })
        .catch((error: unknown) => error);
      expect(isNexaError(confirm) && confirm.details).toMatchObject({
        reason: 'RECONCILIATION_EVIDENCE_MISSING',
      });
      const failed = await ctx.container.payments.reconcileGatewayPayment(
        tenantA,
        owner,
        paymentId,
        {
          to: 'FAILED',
          note: 'partial: refunded at NOWPayments',
          idempotencyKey: key(),
        },
      );
      expect(failed.state).toBe('FAILED');
      expect(await ledger()).toEqual([]);
    });

    it('never fulfils a finished payment for another price', async () => {
      await enableNowPayments();
      const { paymentId, invoiceId } = await createdAttempt();
      await ipn(fake.pay(invoiceId, 56, 'finished', 9.99));
      await pass();
      expect((await paymentOf(paymentId)).state).toBe('UNKNOWN');
      expect((await invoiceOf(paymentId)).provider_paid).toBe(false);
      expect(await ledger()).toEqual([]);
    });

    it('opens the review window when coins are seen before the deadline, and settles a finish after it', async () => {
      await enableNowPayments();
      const { paymentId, invoiceId } = await createdAttempt();
      // The lane sees the coins an hour before "now", well inside the customer window.
      offsetMs = -60 * 60_000;
      const payment = fake.pay(invoiceId, 60, 'confirming');
      await ipn(payment);
      await pass();
      const reviewed = await paymentOf(paymentId);
      expect(reviewed.state).toBe('PENDING');
      expect(reviewed.provider_review_until).not.toBeNull();
      // The customer window is now behind us; only the review window remains.
      await ctx.container.database.db.execute(
        sql`UPDATE payments SET expires_at = now() - interval '1 minute' WHERE id = ${paymentId}`,
      );
      fake.pay(invoiceId, 60, 'finished');
      offsetMs = 0;
      await pass();
      expect((await paymentOf(paymentId)).state).toBe('CONFIRMED');
      expect(await ledger()).toHaveLength(1);
    });

    it('records a finish after the deadline as a late completion — decided under the payment’s lock — and moves nothing', async () => {
      await enableNowPayments();
      const { paymentId, invoiceId } = await createdAttempt();
      await ctx.container.database.db.execute(
        sql`UPDATE payments SET expires_at = now() - interval '1 minute' WHERE id = ${paymentId}`,
      );
      // The lane's clock still believes the attempt is open; the settlement's lock decides.
      offsetMs = -10 * 60_000;
      await ipn(fake.pay(invoiceId, 61, 'finished'));
      await pass();
      expect((await paymentOf(paymentId)).state).toBe('PENDING');
      const invoice = await invoiceOf(paymentId);
      expect(invoice.outcome).toBe('LATE_COMPLETION');
      expect(invoice.late_completion_observed_at).not.toBeNull();
      expect(await ledger()).toEqual([]);
      expect(await openConditions()).toContain('payments.gateway_late_completion');
    });

    it('does not fail an attempt for one expired payment: the invoice can take another coin', async () => {
      await enableNowPayments();
      const { paymentId, invoiceId } = await createdAttempt();
      await ipn(fake.pay(invoiceId, 70, 'expired'));
      await pass();
      expect((await paymentOf(paymentId)).state).toBe('PENDING');
      await ipn(fake.pay(invoiceId, 71, 'finished'));
      await inquireNow();
      expect((await paymentOf(paymentId)).state).toBe('CONFIRMED');
    });
  });

  describe('reconciliation without a webhook', () => {
    it('finds a lost IPN’s payment through the invoice’s payment list', async () => {
      await enableNowPayments();
      const { paymentId, invoiceId } = await createdAttempt();
      fake.pay(invoiceId, 80, 'finished');
      await inquireNow();
      expect(fake.lists).toEqual([invoiceId]);
      expect((await paymentOf(paymentId)).state).toBe('CONFIRMED');
    });

    it('is bounded: the inquiries stop at the deadline, whether the list answers or is refused', async () => {
      await enableNowPayments();
      fake.listStatus = 401;
      const { paymentId } = await createdAttempt();
      let passes = 0;
      while ((await invoiceOf(paymentId)).next_inquiry_at !== null && passes < 60) {
        await inquireNow();
        passes += 1;
      }
      expect((await invoiceOf(paymentId)).next_inquiry_at).toBeNull();
      // Seventy minutes at the documented backoff: well under two dozen calls, then none.
      expect(fake.lists.length).toBeGreaterThan(3);
      expect(fake.lists.length).toBeLessThanOrEqual(20);
      const before = fake.lists.length;
      await inquireNow();
      await inquireNow();
      expect(fake.lists.length).toBe(before);
      // A refused LIST is not a misconfigured key.
      expect(await openConditions()).not.toContain('payments.gateway_misconfigured');
      expect((await paymentOf(paymentId)).state).toBe('PENDING');
    });
  });
});
