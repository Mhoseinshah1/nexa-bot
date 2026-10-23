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
import { DrizzlePaymentGatewayRepository } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-payment-gateway.repository';
import { DrizzleGatewayInvoiceRepository } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-gateway-invoice.repository';
import {
  DrizzleGatewayCallBudget,
  DrizzleGatewayCredentialStore,
  DrizzlePublicOriginReader,
} from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-gateway-credentials';
import { TetraPayAdapter } from '../../apps/api/src/modules/commerce/payments/infrastructure/tetrapay-adapter';
import { tetrapaySignatureOf } from '../../apps/api/src/modules/commerce/payments/infrastructure/tetrapay-signature';
import type { FetchLike } from '../../apps/api/src/modules/commerce/payments/infrastructure/tonpays-adapter';
import {
  GatewayPaymentService,
  gatewayCallbackUrl,
} from '../../apps/api/src/modules/commerce/payments/application/gateway-payment.service';
import { settingsLateCreditPolicy } from '../../apps/api/src/modules/commerce/payments/application/late-credit-policy';
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
 * TetraPay, end to end against a real database (`docs/tetrapay-gateway-audit.md`).
 *
 * The container's own services decide everything - `PaymentService` and its one settlement path,
 * the gateway route service. The gateway LANE is built here over the container's database with
 * the REAL `TetraPayAdapter`, whose `fetch` is a recording fake TetraPay written from the
 * documentation's own request and response examples; nothing leaves the process. The lane's
 * clock is the only clock moved; a payment's deadline is moved on its row.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const MARYAM = '910911';
const API_KEY = 'tp_live_KEY_that_must_never_leak_5c2d';
const WHSEC = 'whsec_SECRET_that_must_never_leak_8e1f';
const BOT_USERNAME = 'nexa_test_bot';
const TOPUP_TOMAN = 10_000n;

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
// A fake TetraPay: the documentation's request and response shapes, and nothing more.
// ---------------------------------------------------------------------------------------

interface Link {
  token: string;
  orderId: string;
  amount: string;
  body: Record<string, unknown>;
  status: 'created' | 'pending' | 'paid' | 'expired';
  receivedAmount: string | null;
  method: 'online' | 'card' | null;
  /** What verify reports as `amount` once paid, if not the link's own. */
  reportAmount?: string;
}

class FakeTetraPay {
  readonly links: Link[] = [];
  readonly verifies: string[] = [];
  readonly auth = new Set<string | null>();
  /** The next create answers this error instead. */
  createError: { status: number; body: unknown; headers?: Record<string, string> } | null = null;

  readonly fetch: FetchLike = async (url, init) => {
    const parsed = new URL(url);
    const headers = init.headers as Record<string, string>;
    this.auth.add(headers['authorization'] ?? null);
    if (parsed.pathname === '/api/v1/payments' && init.method === 'POST') {
      if (this.createError !== null) {
        const failure = this.createError;
        this.createError = null;
        return json(failure.status, failure.body, failure.headers);
      }
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      const same = this.links.find((link) => link.orderId === body['order_id']);
      if (same !== undefined) {
        return same.amount === body['amount']
          ? json(200, this.created(same))
          : json(409, { error: { code: 'ORDER_CONFLICT', message: 'x' } });
      }
      const link: Link = {
        token: `tok${String(this.links.length + 1).padStart(4, '0')}ABCDEFGHIJ`,
        orderId: String(body['order_id']),
        amount: String(body['amount']),
        body,
        status: 'created',
        receivedAmount: null,
        method: null,
      };
      this.links.push(link);
      return json(201, this.created(link));
    }
    const verify = /^\/api\/v1\/payments\/([^/]+)\/verify$/u.exec(parsed.pathname);
    if (verify !== null && init.method === 'POST') {
      const token = decodeURIComponent(verify[1] ?? '');
      this.verifies.push(token);
      const link = this.links.find((one) => one.token === token);
      if (link === undefined) {
        return json(404, { error: { code: 'NOT_FOUND', message: 'x' } });
      }
      const paid = link.status === 'paid';
      return json(200, {
        token: link.token,
        status: link.status,
        order_id: link.orderId,
        amount: paid ? (link.reportAmount ?? link.amount) : link.amount,
        payable_amount: String(BigInt(link.amount) + 1_000n),
        received_amount: link.receivedAmount,
        net_amount: link.amount,
        fee_total: '1000',
        method: link.method,
        paid_at: paid ? '2026-09-29T10:21:44.000Z' : null,
        verified_before: this.verifies.filter((one) => one === token).length > 1 && paid,
      });
    }
    return json(404, { error: { code: 'NOT_FOUND', message: 'x' } });
  };

  private created(link: Link) {
    return {
      token: link.token,
      payment_url: `https://tetrapay.online/pay/${link.token}`,
      amount: link.amount,
      payable_amount: String(BigInt(link.amount) + 1_000n),
      expires_at: '2026-09-29T10:30:00.000Z',
    };
  }

  /** The customer paid this link at TetraPay (the link's own figures unless overridden). */
  pay(orderId: string, overrides: { reportAmount?: string; receivedAmount?: string } = {}): void {
    const link = this.links.find((one) => one.orderId === orderId);
    if (link === undefined) throw new Error(`no fake link for ${orderId}`);
    link.status = 'paid';
    link.method = 'online';
    link.receivedAmount = overrides.receivedAmount ?? String(BigInt(link.amount) + 1_000n);
    if (overrides.reportAmount !== undefined) link.reportAmount = overrides.reportAmount;
  }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('TetraPay, through the one settlement path', () => {
  let ctx: TestContext;
  let owner: ActorContext;
  let maryam: UserId;
  let fake: FakeTetraPay;
  let lane: GatewayPaymentService;
  let offsetMs: number;
  let seq = 0;
  const logged: string[] = [];
  const key = () => `tp-key-${String((seq += 1)).padStart(4, '0')}`;

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
      await createAdmin(ctx.container, tenantA, { username: 'owner-tp', roleKeys: ['owner'] }),
    );
    maryam = (
      await ctx.container.customers.resolveFromUpdate(tenantA, systemActor('resolve-tp'), {
        idempotencyKey: 'resolve-tp',
        telegramUserId: MARYAM,
        from: { id: Number(MARYAM), first_name: 'مریم' },
        botInstanceId: BOT_A,
      })
    ).customer.id;
    await ctx.container.database.db.execute(
      sql`UPDATE bot_instances SET webhook_url = ${`https://bot.example.com/telegram/webhook/${BOT_A}`},
          username = ${BOT_USERNAME} WHERE tenant_id = ${tenantA.tenantId} AND id = ${BOT_A}`,
    );
    fake = new FakeTetraPay();
    offsetMs = 0;
    logged.length = 0;
    lane = laneWith(fake);
  });

  function laneWith(tetrapay: FakeTetraPay): GatewayPaymentService {
    const db = ctx.container.database.db;
    const adapter = new TetraPayAdapter({
      fetch: tetrapay.fetch,
      baseUrl: 'https://api.tetra98.com/api/v1',
      now: () => new Date(Date.now() + offsetMs),
    });
    const origins = new DrizzlePublicOriginReader(db);
    const log = (context: Record<string, unknown>, message: string) => {
      logged.push(`${message} ${JSON.stringify(context)}`);
    };
    return new GatewayPaymentService({
      invoices: new DrizzleGatewayInvoiceRepository(db),
      payments: ctx.container.payments,
      paymentRecords: new DrizzlePaymentRepository(db),
      adapters: (provider) => (provider === 'TETRAPAY' ? adapter : null),
      credentials: new DrizzleGatewayCredentialStore(db, ctx.container.cipher, () =>
        ctx.container.ids.uuid(),
      ),
      botTokens: { tokenForBotInstance: () => Promise.resolve(null) },
      presentation: () => Promise.reject(new Error('TetraPay renders no invoice text')),
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

  async function enableTetraPay() {
    await ctx.container.paymentGateways.configure(tenantA, owner, {
      idempotencyKey: key(),
      provider: 'TETRAPAY',
      config: OPEN_ROUTE,
    });
    await ctx.container.paymentGateways.setCredential(tenantA, owner, {
      idempotencyKey: key(),
      provider: 'TETRAPAY',
      apiKey: API_KEY,
    });
    await ctx.container.paymentGateways.setStatus(tenantA, owner, {
      idempotencyKey: key(),
      provider: 'TETRAPAY',
      status: 'ACTIVE',
    });
  }

  const setSecret = () =>
    ctx.container.paymentGateways.setWebhookSecret(tenantA, owner, {
      idempotencyKey: key(),
      provider: 'TETRAPAY',
      secret: WHSEC,
    });

  async function setSetting(settingKey: string, value: unknown) {
    const current = (await ctx.container.settingsService.list(tenantA, owner)).find(
      (row) => row.key === settingKey,
    );
    await ctx.container.settingsService.set(tenantA, owner, {
      key: settingKey,
      value,
      expectedVersion: current?.version ?? null,
      idempotencyKey: key(),
    });
  }

  const topup = (amountMinor = TOPUP_TOMAN) => {
    const k = key();
    return ctx.container.payments.requestGatewayTopup(tenantA, systemActor(k), maryam, {
      idempotencyKey: k,
      amount: money(amountMinor, 'IRT'),
      provider: 'TETRAPAY',
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
      creation_error_code: string | null;
      creation_retry_at: Date | null;
      provider_order_id: string;
      provider_invoice_id: string | null;
      provider_status: string | null;
      provider_paid: boolean | null;
      provider_method: string | null;
      provider_unit: string;
      sent_amount: string;
      invoice_url: string | null;
      outcome: string | null;
      next_inquiry_at: Date | null;
      last_webhook_delivery_id: string | null;
      webhook_count: number;
    }>(sql`SELECT * FROM gateway_invoices WHERE payment_id = ${paymentId}`);
    if (row === undefined) throw new Error('no invoice row');
    return row;
  }

  async function paymentOf(paymentId: string) {
    const [row] = await rows<{ state: string; evidence_kind: string | null }>(
      sql`SELECT * FROM payments WHERE id = ${paymentId}`,
    );
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

  /** A created link for a fresh top-up attempt. */
  async function createdAttempt(
    amountMinor = TOPUP_TOMAN,
  ): Promise<{ paymentId: PaymentId; orderId: string; token: string }> {
    const attempt = await topup(amountMinor);
    await pass();
    const invoice = await invoiceOf(attempt.payment.id);
    if (invoice.creation_state !== 'CREATED' || invoice.provider_invoice_id === null) {
      throw new Error('not created');
    }
    return {
      paymentId: attempt.payment.id,
      orderId: invoice.provider_order_id,
      token: invoice.provider_invoice_id,
    };
  }

  const webhookBody = (link: { token: string; orderId: string }, amount = '100000') =>
    JSON.stringify({
      event: 'payment.paid',
      event_id: 'evt-1',
      token: link.token,
      status: 'paid',
      order_id: link.orderId,
      amount,
    });

  const signed = (raw: string, secret = WHSEC, atSeconds?: number) => {
    const t = String(atSeconds ?? Math.floor((Date.now() + offsetMs) / 1000));
    return `t=${t},v1=${tetrapaySignatureOf(secret, t, Buffer.from(raw))}`;
  };

  const receive = (
    raw: string,
    header: string | undefined,
    eventId: string | undefined = 'evt-1',
  ) =>
    lane.receiveWebhook(
      String(tenantA.tenantId),
      'TETRAPAY',
      JSON.parse(raw) as unknown,
      eventId,
      header,
      Buffer.from(raw),
    );

  // -------------------------------------------------------------------------------------

  describe('the route and its keys', () => {
    it('is enabled with the API key alone: the webhook secret is optional', async () => {
      await enableTetraPay();
      const { gateways, facts } = await ctx.container.paymentGateways.list(tenantA, owner);
      expect(gateways.find((one) => one.provider === 'TETRAPAY')?.status).toBe('ACTIVE');
      expect(facts.get('TETRAPAY')?.webhookSecretSetAt).toBeNull();
    });

    it('cannot be enabled without the API key', async () => {
      await ctx.container.paymentGateways.configure(tenantA, owner, {
        idempotencyKey: key(),
        provider: 'TETRAPAY',
        config: OPEN_ROUTE,
      });
      const refused = await ctx.container.paymentGateways
        .setStatus(tenantA, owner, {
          idempotencyKey: key(),
          provider: 'TETRAPAY',
          status: 'ACTIVE',
        })
        .catch((error: unknown) => error);
      expect(isNexaError(refused) && refused.details).toMatchObject({
        reason: 'CREDENTIAL_MISSING',
      });
    });

    it('stores the API key and the webhook secret encrypted, shows neither again, and leaks neither anywhere', async () => {
      await enableTetraPay();
      await setSecret();
      const { gateways, facts } = await ctx.container.paymentGateways.list(tenantA, owner);
      const view = JSON.stringify(
        { gateways, facts: [...facts.entries()] },
        (_k, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
      );
      expect(view).not.toContain(API_KEY);
      expect(view).not.toContain(WHSEC);
      const stored = JSON.stringify(
        await rows(sql`SELECT * FROM payment_gateway_credentials WHERE provider = 'TETRAPAY'`),
      );
      expect(stored).not.toContain(API_KEY);
      expect(stored).not.toContain(WHSEC);

      const { orderId } = await createdAttempt();
      fake.pay(orderId);
      await inquireNow();
      expect([...fake.auth]).toEqual([`Bearer ${API_KEY}`]);
      const text = (value: unknown) =>
        JSON.stringify(value, (_k, item: unknown) =>
          typeof item === 'bigint' ? item.toString() : item,
        );
      const everything =
        text(
          await rows(
            sql`SELECT before, after FROM audit_logs WHERE tenant_id = ${tenantA.tenantId}`,
          ),
        ) +
        text(await rows(sql`SELECT context, message FROM operational_events`)) +
        text(await rows(sql`SELECT * FROM gateway_invoices`)) +
        text(await rows(sql`SELECT payload FROM outbox_messages`)) +
        logged.join('\n');
      expect(everything).not.toContain(API_KEY);
      expect(everything).not.toContain(WHSEC);
    });
  });

  describe('create and verify', () => {
    it('asks for 10,000 Toman as "100000" rial with the bot start link, and credits the wallet exactly 10,000 once verify says paid', async () => {
      await enableTetraPay();
      const { paymentId, orderId, token } = await createdAttempt();
      const invoice = await invoiceOf(paymentId);
      expect(invoice).toMatchObject({
        creation_state: 'CREATED',
        provider_unit: 'IRR',
        invoice_url: `https://tetrapay.online/pay/${token}`,
      });
      expect(String(invoice.sent_amount)).toBe('100000');
      expect(fake.links).toHaveLength(1);
      expect(fake.links[0]?.body).toEqual({
        amount: '100000',
        order_id: orderId,
        callback_url: `https://t.me/${BOT_USERNAME}?start=tp-${paymentId}`,
        allow_partial: false,
      });
      expect(orderId).toMatch(/^[A-Za-z0-9]{8}-[0-9A-Z]{6}$/u);
      // The customer's Telegram id never reaches TetraPay.
      expect(JSON.stringify(fake.links)).not.toContain(MARYAM);

      // Not paid yet: asked, nothing moves.
      await inquireNow();
      expect((await paymentOf(paymentId)).state).toBe('PENDING');
      expect(await ledger()).toEqual([]);

      fake.pay(orderId);
      await inquireNow();
      expect(await paymentOf(paymentId)).toMatchObject({
        state: 'CONFIRMED',
        evidence_kind: 'GATEWAY_INQUIRY',
      });
      expect(await ledger()).toEqual([
        { reason: 'TOPUP_GATEWAY', amount: '10000', payment_id: paymentId },
      ]);
      expect(await invoiceOf(paymentId)).toMatchObject({
        outcome: 'SETTLED',
        provider_status: 'paid',
        provider_paid: true,
        provider_method: 'online',
      });
    });

    it('credits exactly once whatever repeats: more verifies, a duplicate webhook, a second confirm', async () => {
      await enableTetraPay();
      await setSecret();
      const link = await createdAttempt();
      fake.pay(link.orderId);
      const raw = webhookBody(link);
      expect(await receive(raw, signed(raw))).toBe('SCHEDULED');
      await pass();
      expect((await paymentOf(link.paymentId)).state).toBe('CONFIRMED');
      // The same event again (TetraPay retries with the same event id), and later verifies.
      expect(await receive(raw, signed(raw))).toBe('DUPLICATE');
      await inquireNow();
      await inquireNow();
      await ctx.container.payments.confirmGatewayPayment(
        tenantA,
        systemActor('again'),
        link.paymentId,
        {
          evidenceNote: null,
        },
      );
      expect(await ledger()).toHaveLength(1);
    });

    it('never credits an amount mismatch: held UNKNOWN for an operator, with the alert', async () => {
      await enableTetraPay();
      const { paymentId, orderId } = await createdAttempt();
      fake.pay(orderId, { reportAmount: '99999' });
      await inquireNow();
      expect((await paymentOf(paymentId)).state).toBe('UNKNOWN');
      expect((await invoiceOf(paymentId)).provider_paid).toBe(false);
      expect(await ledger()).toEqual([]);
      expect(await openConditions()).toContain('payments.gateway_review_unresolved');
      const [audit] = await rows<{ after: { reason: string } }>(
        sql`SELECT after FROM audit_logs WHERE action = 'payment.lose_track' AND entity_id = ${paymentId}`,
      );
      expect(audit?.after.reason).toBe('PROVIDER_AMOUNT_MISMATCH');
    });

    it('never credits a paid answer whose money did not all arrive (a partial payment)', async () => {
      await enableTetraPay();
      const { paymentId, orderId } = await createdAttempt();
      fake.pay(orderId, { receivedAmount: '100000' });
      await inquireNow();
      expect((await paymentOf(paymentId)).state).toBe('UNKNOWN');
      expect(await ledger()).toEqual([]);
    });

    it('honours Retry-After on a rate-limited create: the same order id again, not before it', async () => {
      await enableTetraPay();
      fake.createError = {
        status: 429,
        body: { error: { code: 'RATE_LIMITED', message: 'x', retryAfter: 300 } },
        headers: { 'retry-after': '300' },
      };
      const attempt = await topup();
      const before = Date.now();
      await pass();
      const invoice = await invoiceOf(attempt.payment.id);
      expect(invoice.creation_state).toBe('CREATING');
      expect(invoice.creation_error_code).toBe('tetrapay.RATE_LIMITED');
      // The lane's own minimum is a minute; the provider asked for five.
      expect(new Date(String(invoice.creation_retry_at)).getTime() - before).toBeGreaterThanOrEqual(
        299_000,
      );
      expect(fake.links).toHaveLength(0);
    });

    it('GATEWAY_SUSPENDED refuses the create alone: an attempt already open is still verified and credited', async () => {
      await enableTetraPay();
      const open = await createdAttempt();
      fake.createError = {
        status: 403,
        body: { error: { code: 'GATEWAY_SUSPENDED', message: 'x' } },
      };
      const refused = await topup(11_000n);
      await pass();
      expect((await invoiceOf(refused.payment.id)).creation_state).toBe('CREATE_FAILED');
      expect(await openConditions()).toContain('payments.gateway_misconfigured');
      fake.pay(open.orderId);
      await inquireNow();
      expect((await paymentOf(open.paymentId)).state).toBe('CONFIRMED');
    });
  });

  describe('the daily limit', () => {
    const offered = async () =>
      (
        await ctx.container.paymentGateways.routesFor(
          tenantA,
          maryam,
          'WALLET_TOPUP',
          money(TOPUP_TOMAN, 'IRT'),
        )
      ).map((route) => route.provider);

    it('hides the gateway until 00:00 Tehran, then brings it back by itself', async () => {
      await enableTetraPay();
      expect(await offered()).toContain('TETRAPAY');
      fake.createError = {
        status: 429,
        body: { error: { code: 'DAILY_LIMIT_REACHED', message: 'x', kind: 'links', limit: 100 } },
        headers: { 'retry-after': '3600' },
      };
      const attempt = await topup();
      await pass();
      const invoice = await invoiceOf(attempt.payment.id);
      expect(invoice).toMatchObject({
        creation_state: 'CREATE_FAILED',
        creation_error_code: 'tetrapay.DAILY_LIMIT_REACHED',
      });
      expect((await paymentOf(attempt.payment.id)).state).toBe('FAILED');
      expect(await offered()).not.toContain('TETRAPAY');
      const [stored] = await rows<{ status: string; hidden_until: string }>(
        sql`SELECT status, hidden_until FROM payment_gateways
            WHERE provider = 'TETRAPAY' AND tenant_id = ${tenantA.tenantId}`,
      );
      const route = stored && {
        status: stored.status,
        hidden_until: new Date(stored.hidden_until),
      };
      // The operator's switch is untouched.
      expect(route?.status).toBe('ACTIVE');
      expect(route?.hidden_until.getTime()).toBeGreaterThan(Date.now());
      expect(route?.hidden_until.getTime()).toBeLessThanOrEqual(Date.now() + 24 * 3_600_000);
      // And a new top-up through it is refused while hidden.
      const refused = await topup().catch((error: unknown) => error);
      expect(isNexaError(refused)).toBe(true);
      // After the midnight it is offered again with nobody touching it.
      await ctx.container.database.db.execute(
        sql`UPDATE payment_gateways SET hidden_until = now() - interval '1 second' WHERE provider = 'TETRAPAY' AND tenant_id = ${tenantA.tenantId}`,
      );
      expect(await offered()).toContain('TETRAPAY');
    });
  });

  describe('the webhook', () => {
    it('drops an invalid signature, a stale t and a wrong secret - one alert for the burst - and brings nothing forward', async () => {
      await enableTetraPay();
      await setSecret();
      const link = await createdAttempt();
      fake.pay(link.orderId);
      const raw = webhookBody(link);
      const before = (await invoiceOf(link.paymentId)).next_inquiry_at;
      expect(await receive(raw, 't=1,v1=' + 'a'.repeat(64), 'e1')).toBe('IGNORED_UNVERIFIED');
      expect(await receive(raw, signed(raw, 'whsec_wrong'), 'e2')).toBe('IGNORED_UNVERIFIED');
      const stale = Math.floor(Date.now() / 1000) - 301;
      expect(await receive(raw, signed(raw, WHSEC, stale), 'e3')).toBe('IGNORED_UNVERIFIED');
      expect(await receive(raw, undefined, 'e4')).toBe('IGNORED_UNVERIFIED');
      // Signed over different bytes than the ones received.
      expect(await receive(raw, signed(raw + ' '), 'e5')).toBe('IGNORED_UNVERIFIED');
      const alerts = (await openConditions()).filter(
        (code) => code === 'payments.gateway_webhook_unverified',
      );
      expect(alerts).toHaveLength(1);
      const after = await invoiceOf(link.paymentId);
      expect(after.webhook_count).toBe(0);
      expect(after.next_inquiry_at).toEqual(before);
      expect((await paymentOf(link.paymentId)).state).toBe('PENDING');
    });

    it('accepts a valid signature, brings the verify forward, and still settles only through verify', async () => {
      await enableTetraPay();
      await setSecret();
      const link = await createdAttempt();
      const raw = webhookBody(link);
      expect(await receive(raw, signed(raw), 'evt-valid')).toBe('SCHEDULED');
      const invoice = await invoiceOf(link.paymentId);
      expect(invoice.webhook_count).toBe(1);
      expect(invoice.last_webhook_delivery_id).toBe('evt-valid');
      // The webhook SAYS paid; TetraPay's verify says otherwise: nothing is credited.
      await pass();
      expect((await paymentOf(link.paymentId)).state).toBe('PENDING');
      expect(await ledger()).toEqual([]);
    });

    it('with no secret configured, a webhook only triggers an early verify', async () => {
      await enableTetraPay();
      const link = await createdAttempt();
      fake.pay(link.orderId);
      const raw = webhookBody(link);
      const verifies = fake.verifies.length;
      expect(await receive(raw, undefined, 'evt-nosecret')).toBe('SCHEDULED');
      // No condition: there was nothing to verify the signature against.
      expect(await openConditions()).not.toContain('payments.gateway_webhook_unverified');
      await pass();
      expect(fake.verifies.length).toBe(verifies + 1);
      expect((await paymentOf(link.paymentId)).state).toBe('CONFIRMED');
      expect(await ledger()).toHaveLength(1);
    });

    it('answers a body naming no known attempt like any other webhook, and malformed junk as malformed', async () => {
      await enableTetraPay();
      expect(await receive(webhookBody({ token: 'tokX', orderId: 'NOPE-123456' }), undefined)).toBe(
        'IGNORED_UNKNOWN',
      );
      expect(await receive('{"nothing":true}', undefined)).toBe('MALFORMED');
    });
  });

  describe('a payment verify reports as paid after the attempt closed', () => {
    const LATE_SWITCH = 'payments.late_credit.tetrapay_enabled';
    const pastDeadline = (paymentId: string) =>
      ctx.container.database.db.execute(
        sql`UPDATE payments SET expires_at = now() - interval '1 second' WHERE id = ${paymentId}`,
      );

    it('is credited to the wallet once through the late-credit path when the switch is ON', async () => {
      await enableTetraPay();
      await setSetting(LATE_SWITCH, true);
      const { paymentId, orderId } = await createdAttempt();
      await pastDeadline(paymentId);
      fake.pay(orderId);
      await ctx.container.database.db.execute(
        sql`UPDATE gateway_invoices SET next_inquiry_at = now() WHERE payment_id = ${paymentId}`,
      );
      const report = await inquireNow();
      expect(report.lateCredits).toBe(1);
      expect(await ledger()).toEqual([
        { reason: 'GATEWAY_LATE_CREDIT', amount: '10000', payment_id: paymentId },
      ]);
      expect((await invoiceOf(paymentId)).outcome).toBe('LATE_CREDITED');
      await inquireNow();
      expect(await ledger()).toHaveLength(1);
    });

    it('is only recorded as a late completion when the switch is OFF (the default)', async () => {
      await enableTetraPay();
      const { paymentId, orderId } = await createdAttempt();
      await pastDeadline(paymentId);
      fake.pay(orderId);
      await ctx.container.database.db.execute(
        sql`UPDATE gateway_invoices SET next_inquiry_at = now() WHERE payment_id = ${paymentId}`,
      );
      const report = await inquireNow();
      expect(report.lateCredits).toBe(0);
      expect(await ledger()).toEqual([]);
    });
  });
});
