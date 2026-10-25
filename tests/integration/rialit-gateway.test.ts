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
import { RialitAdapter } from '../../apps/api/src/modules/commerce/payments/infrastructure/rialit-adapter';
import type { FetchLike } from '../../apps/api/src/modules/commerce/payments/infrastructure/tonpays-adapter';
import {
  GatewayPaymentService,
  gatewayCallbackUrl,
} from '../../apps/api/src/modules/commerce/payments/application/gateway-payment.service';
import { settingsLateCreditPolicy } from '../../apps/api/src/modules/commerce/payments/application/late-credit-policy';
import { DrizzleOperationalConditionReader } from '../../apps/api/src/modules/platform/opslog/infrastructure/drizzle-operational-event.reader';
import { gatewayAttemptScreen } from '../../apps/api/src/surfaces/telegram/runtime/payment-screens';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  SEED_IDS,
  tenantA,
  type TestContext,
} from './harness';

/**
 * Rialit, end to end against a real database (`docs/rialit-gateway-audit.md`).
 *
 * The container's own services decide everything — `PaymentService` and its one settlement
 * path, the gateway route service. The gateway LANE is built here over the container's
 * database with the REAL `RialitAdapter`, whose `fetch` is a recording fake Rialit written
 * from the owner-provided Rialit API document's own request and response examples; nothing
 * leaves the process. The lane's clock is the only clock moved; a deadline is moved on its row.
 *
 * MUTATION (each reverted alone, the named test failed, restored with git checkout):
 *  - the both-charge guard in `rialitPayerCheck` -> 'both sides charging a fee';
 *  - `rialitJudgement` returning UNSUCCESSFUL for `expired` -> 'an expired payment stays open';
 *  - `rialitJudgement` approving `pending` (the webhook's word taken) -> 'a webhook that says
 *    paid settles nothing';
 *  - the delivery-id dedupe (`last_webhook_delivery_id`) bypassed in the repository ->
 *    'the same event id twice is a duplicate'.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const MARYAM = '910911';
const API_KEY = 'rl_live_KEY_that_must_never_leak_3a9c';
const TOPUP_TOMAN = 250_000n;

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
// A fake Rialit: the document's request and response shapes, and nothing more.
// ---------------------------------------------------------------------------------------

interface Payment {
  token: string;
  orderId: string;
  amount: number;
  payerId: unknown;
  payerFee: number;
  status: 'pending' | 'paid' | 'expired' | 'cancelled';
}

class FakeRialit {
  readonly payments: Payment[] = [];
  readonly sends: Record<string, unknown>[] = [];
  readonly reads: string[] = [];
  readonly auth = new Set<string | null>();
  /** The merchant's payer fee from the dashboard, added to every new payment. */
  payerFee = 0;
  /** The next create answers this instead (the request is still recorded). */
  createError: { status: number; body: unknown } | 'timeout' | null = null;
  /** Whether the create made the payment before failing (a 502 after the fact). */
  createdBeforeError = false;

  readonly fetch: FetchLike = async (url, init) => {
    const parsed = new URL(url);
    const headers = init.headers as Record<string, string>;
    this.auth.add(headers['authorization'] ?? null);
    if (parsed.pathname === '/api/v1/send' && init.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      this.sends.push(body);
      const failure = this.createError;
      if (failure !== null) {
        this.createError = null;
        if (this.createdBeforeError) this.make(body);
        if (failure === 'timeout') throw new Error('socket hang up');
        return json(failure.status, failure.body);
      }
      const same = this.payments.find((one) => one.orderId === body['order_id']);
      if (same !== undefined) {
        return same.amount === body['amount'] && same.payerId === body['payer_id']
          ? json(200, this.created(same))
          : json(409, { error: 'order_id already used with a different amount or payer_id' });
      }
      return json(201, this.created(this.make(body)));
    }
    const read = /^\/api\/v1\/status\/([^/]+)$/u.exec(parsed.pathname);
    if (read !== null && init.method === 'GET') {
      const token = decodeURIComponent(read[1] ?? '');
      this.reads.push(token);
      const found = this.payments.find((one) => one.token === token);
      if (found === undefined) return json(404, { error: 'payment not found' });
      return json(200, {
        token: found.token,
        order_id: found.orderId,
        payer_id: found.payerId,
        amount: found.amount,
        payer_amount: found.amount + found.payerFee,
        payer_fee: found.payerFee,
        status: found.status,
        ...(found.status === 'paid'
          ? { paid_at: '2026-09-29T08:14:03.271Z', reference: '123456789012' }
          : {}),
      });
    }
    return json(404, { error: 'not found' });
  };

  private make(body: Record<string, unknown>): Payment {
    const payment: Payment = {
      token: `hT4xQm9ZkR2vB7nLc8WpY3dJf6Gs${String(this.payments.length + 1).padStart(4, '0')}`,
      orderId: String(body['order_id']),
      amount: Number(body['amount']),
      payerId: body['payer_id'],
      payerFee: this.payerFee,
      status: 'pending',
    };
    this.payments.push(payment);
    return payment;
  }

  private created(payment: Payment) {
    return {
      token: payment.token,
      status: payment.status,
      amount: payment.amount,
      payer_amount: payment.amount + payment.payerFee,
      payer_fee: payment.payerFee,
    };
  }

  set(orderId: string, status: Payment['status']): void {
    const payment = this.payments.find((one) => one.orderId === orderId);
    if (payment === undefined) throw new Error(`no fake payment for ${orderId}`);
    payment.status = status;
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Rialit, through the one settlement path', () => {
  let ctx: TestContext;
  let owner: ActorContext;
  let maryam: UserId;
  let fake: FakeRialit;
  let lane: GatewayPaymentService;
  let offsetMs: number;
  let seq = 0;
  const logged: string[] = [];
  const key = () => `rl-key-${String((seq += 1)).padStart(4, '0')}`;

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
      await createAdmin(ctx.container, tenantA, { username: 'owner-rl', roleKeys: ['owner'] }),
    );
    maryam = (
      await ctx.container.customers.resolveFromUpdate(tenantA, systemActor('resolve-rl'), {
        idempotencyKey: 'resolve-rl',
        telegramUserId: MARYAM,
        from: { id: Number(MARYAM), first_name: 'مریم' },
        botInstanceId: BOT_A,
      })
    ).customer.id;
    fake = new FakeRialit();
    offsetMs = 0;
    logged.length = 0;
    lane = laneWith(fake);
  });

  function laneWith(rialit: FakeRialit): GatewayPaymentService {
    const db = ctx.container.database.db;
    const adapter = new RialitAdapter({
      fetch: rialit.fetch,
      baseUrl: 'https://api.rialit.io/api/v1',
    });
    const origins = new DrizzlePublicOriginReader(db);
    const log = (context: Record<string, unknown>, message: string) => {
      logged.push(`${message} ${JSON.stringify(context)}`);
    };
    return new GatewayPaymentService({
      invoices: new DrizzleGatewayInvoiceRepository(db),
      payments: ctx.container.payments,
      paymentRecords: new DrizzlePaymentRepository(db),
      adapters: (provider) => (provider === 'RIALIT' ? adapter : null),
      credentials: new DrizzleGatewayCredentialStore(db, ctx.container.cipher, () =>
        ctx.container.ids.uuid(),
      ),
      botTokens: { tokenForBotInstance: () => Promise.resolve(null) },
      presentation: () => Promise.reject(new Error('Rialit renders no invoice text')),
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

  async function enableRialit(feeBasisPoints = 0) {
    await ctx.container.paymentGateways.configure(tenantA, owner, {
      idempotencyKey: key(),
      provider: 'RIALIT',
      config: { ...OPEN_ROUTE, customerFeeBasisPoints: feeBasisPoints },
    });
    await ctx.container.paymentGateways.setCredential(tenantA, owner, {
      idempotencyKey: key(),
      provider: 'RIALIT',
      apiKey: API_KEY,
    });
    await ctx.container.paymentGateways.setStatus(tenantA, owner, {
      idempotencyKey: key(),
      provider: 'RIALIT',
      status: 'ACTIVE',
    });
  }

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
      provider: 'RIALIT',
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
      creation_sent_at: Date | null;
      provider_order_id: string;
      provider_invoice_id: string | null;
      provider_status: string | null;
      provider_paid: boolean | null;
      provider_unit: string;
      sent_amount: string;
      final_amount: string | null;
      invoice_url: string | null;
      outcome: string | null;
      last_webhook_delivery_id: string | null;
      webhook_count: number;
    }>(sql`SELECT * FROM gateway_invoices WHERE payment_id = ${paymentId}`);
    if (row === undefined) throw new Error('no invoice row');
    return row;
  }

  async function paymentOf(paymentId: string) {
    const [row] = await rows<{ state: string; resolution_note: string | null }>(
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

  async function createdAttempt(
    amountMinor = TOPUP_TOMAN,
  ): Promise<{ paymentId: PaymentId; orderId: string; token: string }> {
    const attempt = await topup(amountMinor);
    await pass();
    const invoice = await invoiceOf(attempt.payment.id);
    if (invoice.creation_state !== 'CREATED' || invoice.provider_invoice_id === null) {
      throw new Error(
        `not created: ${invoice.creation_state} ${String(invoice.creation_error_code)}`,
      );
    }
    return {
      paymentId: attempt.payment.id,
      orderId: invoice.provider_order_id,
      token: invoice.provider_invoice_id,
    };
  }

  const event = (
    link: { token: string; orderId: string },
    type: string,
    status: string,
    eventId: string,
  ) => ({
    event_id: eventId,
    type,
    created_at: '2026-09-29T08:14:05.482913Z',
    data: {
      id: link.token,
      order_id: link.orderId,
      payer_id: Number(MARYAM),
      status,
      amount: 250000,
      payer_amount: 250000,
      payer_fee: 0,
    },
  });

  const receive = (body: unknown, deliveryId: string | undefined) =>
    lane.receiveWebhook(String(tenantA.tenantId), 'RIALIT', body, deliveryId);

  const pastDeadline = (paymentId: string) =>
    ctx.container.database.db.execute(
      sql`UPDATE payments SET expires_at = now() - interval '1 second' WHERE id = ${paymentId}`,
    );
  const askNow = (paymentId: string) =>
    ctx.container.database.db.execute(
      sql`UPDATE gateway_invoices SET next_inquiry_at = now() WHERE payment_id = ${paymentId}`,
    );

  // -------------------------------------------------------------------------------------

  describe('the route and its key', () => {
    it('starts DISABLED, cannot be enabled without the API key, and says which piece is missing', async () => {
      await ctx.container.paymentGateways.configure(tenantA, owner, {
        idempotencyKey: key(),
        provider: 'RIALIT',
        config: OPEN_ROUTE,
      });
      const { gateways } = await ctx.container.paymentGateways.list(tenantA, owner);
      expect(gateways.find((one) => one.provider === 'RIALIT')?.status).toBe('DISABLED');
      const refused = await ctx.container.paymentGateways
        .setStatus(tenantA, owner, { idempotencyKey: key(), provider: 'RIALIT', status: 'ACTIVE' })
        .catch((error: unknown) => error);
      expect(isNexaError(refused) && refused.details).toMatchObject({
        reason: 'CREDENTIAL_MISSING',
      });
    });

    it('stores the API key encrypted, shows it never again, and leaks it nowhere', async () => {
      await enableRialit();
      const { orderId } = await createdAttempt();
      fake.set(orderId, 'paid');
      await inquireNow();
      expect([...fake.auth]).toEqual([`Bearer ${API_KEY}`]);
      const text = (value: unknown) =>
        JSON.stringify(value, (_k, item: unknown) =>
          typeof item === 'bigint' ? item.toString() : item,
        );
      const everything =
        text(await rows(sql`SELECT * FROM payment_gateway_credentials`)) +
        text(await rows(sql`SELECT before, after FROM audit_logs`)) +
        text(await rows(sql`SELECT context, message FROM operational_events`)) +
        text(await rows(sql`SELECT * FROM gateway_invoices`)) +
        text(await rows(sql`SELECT payload FROM outbox_messages`)) +
        text(await ctx.container.paymentGateways.list(tenantA, owner).then((one) => one.gateways)) +
        logged.join('\n');
      expect(everything).not.toContain(API_KEY);
    });
  });

  describe('create and the status read', () => {
    it('sends 250,000 Toman with the Telegram id as a number, and credits exactly 250,000 once GET /status says paid', async () => {
      await enableRialit();
      const { paymentId, orderId, token } = await createdAttempt();
      expect(fake.sends).toEqual([{ amount: 250000, order_id: orderId, payer_id: 910911 }]);
      expect(orderId).toMatch(/^[A-Za-z0-9]{1,16}-[0-9A-Z]{8}$/u);
      expect(await invoiceOf(paymentId)).toMatchObject({
        provider_unit: 'IRT',
        invoice_url: `https://pay.rialit.io/v1/${token}`,
      });
      await inquireNow();
      expect((await paymentOf(paymentId)).state).toBe('PENDING');
      expect(await ledger()).toEqual([]);
      fake.set(orderId, 'paid');
      await inquireNow();
      expect((await paymentOf(paymentId)).state).toBe('CONFIRMED');
      expect(await ledger()).toEqual([
        { reason: 'TOPUP_GATEWAY', amount: '250000', payment_id: paymentId },
      ]);
      await inquireNow();
      expect(await ledger()).toHaveLength(1);
    });

    it('refuses a payable outside 50,000-10,000,000 Toman before any call, with a clear screen', async () => {
      await enableRialit();
      const low = await topup(49_999n);
      await pass();
      expect(await invoiceOf(low.payment.id)).toMatchObject({
        creation_state: 'CREATE_FAILED',
        creation_error_code: 'rialit.AMOUNT_OUT_OF_RANGE:50000:10000000',
      });
      expect((await paymentOf(low.payment.id)).state).toBe('FAILED');
      expect(fake.sends).toHaveLength(0);
      const view = await lane.attemptFor(tenantA, maryam, low.payment.id);
      if (view === null) throw new Error('no attempt');
      expect(gatewayAttemptScreen(view, null, new Date()).key).toBe(
        'bot.payment.rialit_amount_out_of_range',
      );
    });

    it('applies the range to the PAYABLE: a principal inside it whose fee pushes it out is refused', async () => {
      await enableRialit(1_000); // 10 %
      const attempt = await topup(9_500_000n);
      await pass();
      expect((await invoiceOf(attempt.payment.id)).creation_error_code).toBe(
        'rialit.AMOUNT_OUT_OF_RANGE:50000:10000000',
      );
      expect(fake.sends).toHaveLength(0);
    });

    it('a 429 is asked again with the SAME order id; it is the only answer that clears the stamp', async () => {
      await enableRialit();
      fake.createError = { status: 429, body: { error: 'rate limit exceeded' } };
      const attempt = await topup();
      await pass();
      const deferred = await invoiceOf(attempt.payment.id);
      expect(deferred).toMatchObject({
        creation_state: 'CREATING',
        creation_error_code: 'rialit.RATE_LIMITED',
        creation_sent_at: null,
      });
      offsetMs += 2 * 60_000;
      await pass();
      expect((await invoiceOf(attempt.payment.id)).creation_state).toBe('CREATED');
      expect(fake.sends.map((one) => one['order_id'])).toEqual([
        deferred.provider_order_id,
        deferred.provider_order_id,
      ]);
    });

    it('a lost create (timeout, 502) is CREATE_UNKNOWN and is never sent again', async () => {
      await enableRialit();
      for (const failure of [
        'timeout',
        { status: 502, body: { error: 'upstream service unavailable' } },
      ] as const) {
        fake.createError = failure;
        fake.createdBeforeError = true;
        const attempt = await topup(TOPUP_TOMAN + BigInt(fake.sends.length));
        const before = fake.sends.length;
        await pass();
        expect((await invoiceOf(attempt.payment.id)).creation_state).toBe('CREATE_UNKNOWN');
        offsetMs += 10 * 60_000;
        await pass();
        await pass();
        expect(fake.sends.length).toBe(before + 1);
        expect((await paymentOf(attempt.payment.id)).state).not.toBe('CONFIRMED');
      }
      expect(await ledger()).toEqual([]);
    });

    it('a 409 is never re-keyed; a 401 and a 403 are configuration alerts', async () => {
      await enableRialit();
      fake.createError = {
        status: 409,
        body: { error: 'order_id already used with a different amount or payer_id' },
      };
      const conflict = await topup();
      await pass();
      expect(await invoiceOf(conflict.payment.id)).toMatchObject({
        creation_state: 'CREATE_UNKNOWN',
        creation_error_code: 'rialit.ORDER_CONFLICT',
      });
      fake.createError = { status: 401, body: { error: 'unauthorized' } };
      const refused = await topup(260_000n);
      await pass();
      expect(await invoiceOf(refused.payment.id)).toMatchObject({
        creation_state: 'CREATE_FAILED',
        creation_error_code: 'rialit.UNAUTHORIZED',
      });
      expect(await openConditions()).toContain('payments.gateway_misconfigured');
      fake.createError = { status: 403, body: { error: 'IP not allowed' } };
      const ip = await topup(270_000n);
      await pass();
      expect((await invoiceOf(ip.payment.id)).creation_error_code).toBe('rialit.IP_NOT_ALLOWED');
      expect(fake.sends).toHaveLength(3);
    });
  });

  describe('the fee: only ONE side charges, never both (owner rule)', () => {
    it('neither side: the customer is asked for the principal and it is credited', async () => {
      await enableRialit(0);
      const { paymentId, orderId } = await createdAttempt();
      expect(fake.sends[0]?.['amount']).toBe(250000);
      fake.set(orderId, 'paid');
      await inquireNow();
      expect(await ledger()).toEqual([
        { reason: 'TOPUP_GATEWAY', amount: '250000', payment_id: paymentId },
      ]);
    });

    it('Nexa alone: the payable (principal + Nexa fee) is sent, and only the principal is credited', async () => {
      await enableRialit(400); // 4 %
      const { paymentId, orderId } = await createdAttempt();
      expect(fake.sends[0]?.['amount']).toBe(260000);
      expect(String((await invoiceOf(paymentId)).sent_amount)).toBe('260000');
      fake.set(orderId, 'paid');
      await inquireNow();
      expect((await paymentOf(paymentId)).state).toBe('CONFIRMED');
      expect(await ledger()).toEqual([
        { reason: 'TOPUP_GATEWAY', amount: '250000', payment_id: paymentId },
      ]);
    });

    it('Rialit alone: the link is shown with Rialit’s payer amount, and only the principal is credited', async () => {
      await enableRialit(0);
      fake.payerFee = 2_500;
      const { paymentId, orderId } = await createdAttempt();
      expect(String((await invoiceOf(paymentId)).final_amount)).toBe('252500');
      const view = await lane.attemptFor(tenantA, maryam, paymentId);
      if (view === null) throw new Error('no attempt');
      const screen = gatewayAttemptScreen(view, null, new Date(Date.now() + offsetMs));
      expect(screen.key).toBe('bot.payment.gateway_invoice_topup_fee');
      expect(screen.values).toMatchObject({
        principal: money(250_000n, 'IRT'),
        fee: money(2_500n, 'IRT'),
        payable: money(252_500n, 'IRT'),
      });
      fake.set(orderId, 'paid');
      await inquireNow();
      expect(await ledger()).toEqual([
        { reason: 'TOPUP_GATEWAY', amount: '250000', payment_id: paymentId },
      ]);
    });

    it('both sides charging a fee: no link, a misconfiguration alert, the refusal screen, the token on the audit row', async () => {
      await enableRialit(400);
      fake.payerFee = 2_600;
      const attempt = await topup();
      await pass();
      const invoice = await invoiceOf(attempt.payment.id);
      expect(invoice).toMatchObject({
        creation_state: 'CREATE_FAILED',
        creation_error_code: 'rialit.DOUBLE_FEE',
        invoice_url: null,
        provider_invoice_id: null,
      });
      expect((await paymentOf(attempt.payment.id)).state).toBe('FAILED');
      expect(await openConditions()).toContain('payments.gateway_misconfigured');
      const [audit] = await rows<{ after: Record<string, unknown> }>(
        sql`SELECT after FROM audit_logs WHERE action = 'gateway_invoice.create_failed'
            AND entity_id = ${attempt.payment.id}`,
      );
      expect(audit?.after).toMatchObject({
        reason: 'rialit.DOUBLE_FEE',
        refusedProviderInvoiceId: fake.payments[0]?.token,
        paymentLinkShown: false,
      });
      const view = await lane.attemptFor(tenantA, maryam, attempt.payment.id);
      if (view === null) throw new Error('no attempt');
      const screen = gatewayAttemptScreen(view, null, new Date());
      expect(screen.key).toBe('bot.payment.rialit_misconfigured');
      expect(JSON.stringify(screen.buttons)).not.toContain('pay.rialit.io');
      expect(await ledger()).toEqual([]);
    });
  });

  describe('expired, cancelled and late', () => {
    const LATE_SWITCH = 'payments.late_credit.rialit_enabled';

    it('an expired or cancelled payment stays open: Nexa’s own deadline closes it, never the provider’s word', async () => {
      await enableRialit();
      const expired = await createdAttempt();
      const cancelled = await createdAttempt(260_000n);
      fake.set(expired.orderId, 'expired');
      fake.set(cancelled.orderId, 'cancelled');
      await inquireNow();
      expect((await paymentOf(expired.paymentId)).state).toBe('PENDING');
      expect((await paymentOf(cancelled.paymentId)).state).toBe('PENDING');
      expect((await invoiceOf(expired.paymentId)).provider_status).toBe('expired');
      expect(await ledger()).toEqual([]);
    });

    it('a late paid after expired is credited once to the wallet when the switch is ON', async () => {
      await enableRialit();
      await setSetting(LATE_SWITCH, true);
      const { paymentId, orderId } = await createdAttempt();
      fake.set(orderId, 'expired');
      await inquireNow();
      await pastDeadline(paymentId);
      fake.set(orderId, 'paid');
      await askNow(paymentId);
      const report = await inquireNow();
      expect(report.lateCredits).toBe(1);
      expect(await ledger()).toEqual([
        { reason: 'GATEWAY_LATE_CREDIT', amount: '250000', payment_id: paymentId },
      ]);
      expect((await invoiceOf(paymentId)).outcome).toBe('LATE_CREDITED');
      await askNow(paymentId);
      await inquireNow();
      expect(await ledger()).toHaveLength(1);
    });

    it('a late paid is only recorded when the switch is OFF (the default)', async () => {
      await enableRialit();
      const { paymentId, orderId } = await createdAttempt();
      await pastDeadline(paymentId);
      fake.set(orderId, 'paid');
      await askNow(paymentId);
      const report = await inquireNow();
      expect(report.lateCredits).toBe(0);
      expect(await ledger()).toEqual([]);
    });
  });

  describe('webhooks: unsigned hints, deduplicated, never deciding', () => {
    it('a webhook brings the read forward; the same event id twice is a duplicate', async () => {
      await enableRialit();
      const link = await createdAttempt();
      fake.set(link.orderId, 'paid');
      const paid = event(link, 'payment.paid', 'paid', 'evt-0001');
      const reads = fake.reads.length;
      expect(await receive(paid, 'evt-0001')).toBe('SCHEDULED');
      expect(await receive(paid, 'evt-0001')).toBe('DUPLICATE');
      expect(await invoiceOf(link.paymentId)).toMatchObject({
        webhook_count: 1,
        last_webhook_delivery_id: 'evt-0001',
      });
      await pass();
      expect(fake.reads.length).toBe(reads + 1);
      expect((await paymentOf(link.paymentId)).state).toBe('CONFIRMED');
      expect(await ledger()).toHaveLength(1);
      // The payment timeline tells the operator the same story, gateway facts included.
      const kinds = (
        await ctx.container.paymentTimeline.timeline(tenantA, owner, link.paymentId)
      ).entries.map((entry) => entry.kind);
      for (const kind of [
        'GATEWAY_INVOICE_CREATED',
        'GATEWAY_WEBHOOK_HINT',
        'GATEWAY_INQUIRY',
        'PAYMENT_CONFIRMED',
      ]) {
        expect(kinds).toContain(kind);
      }
    });

    it('a webhook that says paid settles nothing while GET /status says pending', async () => {
      await enableRialit();
      const link = await createdAttempt();
      expect(await receive(event(link, 'payment.paid', 'paid', 'evt-0002'), 'evt-0002')).toBe(
        'SCHEDULED',
      );
      await pass();
      expect((await paymentOf(link.paymentId)).state).toBe('PENDING');
      expect(await ledger()).toEqual([]);
    });

    it('expired and cancelled webhooks are hints too: the payment stays open', async () => {
      await enableRialit();
      const link = await createdAttempt();
      fake.set(link.orderId, 'cancelled');
      expect(
        await receive(event(link, 'payment.cancelled', 'cancelled', 'evt-0003'), 'evt-0003'),
      ).toBe('SCHEDULED');
      expect(await receive(event(link, 'payment.expired', 'expired', 'evt-0004'), 'evt-0004')).toBe(
        'SCHEDULED',
      );
      await pass();
      expect((await paymentOf(link.paymentId)).state).toBe('PENDING');
    });

    it('webhook.test is answered and nothing else happens', async () => {
      await enableRialit();
      const link = await createdAttempt();
      const before = await invoiceOf(link.paymentId);
      const audits = (await rows(sql`SELECT id FROM audit_logs`)).length;
      expect(
        await receive(
          {
            event_id: '019994b0-5d6e-7f80-9a1b-2c3d4e5f6a7b',
            type: 'webhook.test',
            created_at: '2026-09-29T09:02:40.317Z',
            data: { merchant_id: '0198f2c4-8a1b-7c2d-9e3f-4a5b6c7d8e9f' },
          },
          '019994b0-5d6e-7f80-9a1b-2c3d4e5f6a7b',
        ),
      ).toBe('IGNORED_TEST');
      expect(await invoiceOf(link.paymentId)).toEqual(before);
      expect((await rows(sql`SELECT id FROM audit_logs`)).length).toBe(audits);
    });

    it('answers an unknown attempt like any webhook, and junk as malformed', async () => {
      await enableRialit();
      expect(
        await receive(
          event({ token: 'unknownToken1', orderId: 'NOPE-AAAAAAAA' }, 'payment.paid', 'paid', 'e9'),
          'e9',
        ),
      ).toBe('IGNORED_UNKNOWN');
      expect(await receive({ nothing: true }, undefined)).toBe('MALFORMED');
    });
  });
});
