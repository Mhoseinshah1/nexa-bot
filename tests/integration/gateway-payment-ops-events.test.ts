import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  money,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type PaymentGatewayConfig,
  type PaymentId,
  type UserId,
} from '@nexa/contracts';
import { DrizzleCustomerRepository } from '../../apps/api/src/modules/commerce/customers/infrastructure/drizzle-customer.repository';
import {
  GATEWAY_INQUIRY_FAILING_CODE,
  GATEWAY_INQUIRY_OK_CODE,
  GATEWAY_MISCONFIGURED_CODE,
  GATEWAY_SETTLEMENT_DECIDED_CODE,
  GATEWAY_SETTLEMENT_FAILED_CODE,
  GatewayPaymentService,
  type GatewayPaymentServiceDeps,
} from '../../apps/api/src/modules/commerce/payments/application/gateway-payment.service';
import { GatewayInquiryHealth } from '../../apps/api/src/modules/commerce/payments/application/gateway-inquiry-health';
import {
  DrizzleGatewayCallBudget,
  DrizzleGatewayCredentialStore,
} from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-gateway-credentials';
import { DrizzleGatewayInvoiceRepository } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-gateway-invoice.repository';
import { DrizzlePaymentRepository } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-payment.repository';
import {
  TonPaysAdapter,
  type FetchLike,
} from '../../apps/api/src/modules/commerce/payments/infrastructure/tonpays-adapter';
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
 * FIX-03 (batch 2026-10-10): the payment-gateway failures that used to be log lines.
 *
 * - An approval the settlement transaction refused is `payments.gateway_settlement_failed`,
 *   once per payment however often it is retried, and nothing is credited. It is a condition:
 *   the pass that later DECIDES that payment closes it with `payments.gateway_settlement_decided`,
 *   and only that payment's (audit P2-b on #260).
 * - Inquiries that keep failing open `payments.gateway_inquiry_failing` for the gateway, and
 *   the next answered inquiry closes it with `payments.gateway_inquiry_ok`.
 * - An inquiry whose route lost its key opens `payments.gateway_misconfigured`, as the create
 *   path does.
 *
 * Real: the database, `PaymentService`, the gateway lane, the TonPays adapter over a fake
 * `fetch`, the recorder and its condition reader. Synthetic data only; no real provider.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const CUSTOMER = '940404';
const API_KEY = 'tonpays_test_key_never_leaks';

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

const systemActor = (key: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'gateway-ops-events:test',
  surface: 'TELEGRAM',
  correlationId: `corr-${key}` as CorrelationId,
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A fake TonPays: create, and a check whose answer the test chooses. */
class FakeTonPays {
  readonly invoices = new Map<string, { orderId: string; amount: number; paid: boolean }>();
  /** What the check endpoint does: answer, fail with a 502, or refuse with a 429. */
  check: 'ANSWER' | 'BAD_GATEWAY' | 'RATE_LIMITED' = 'ANSWER';
  private seq = 0;

  readonly fetch: FetchLike = async (url, init) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    if (url.endsWith('/api/v1/invoices/create')) {
      this.seq += 1;
      const invoiceId = `TP-${String(this.seq).padStart(8, '0')}`;
      const invoice = { orderId: String(body.order_id), amount: Number(body.amount), paid: false };
      this.invoices.set(invoiceId, invoice);
      return json(201, {
        invoice_id: invoiceId,
        order_id: invoice.orderId,
        request_amount: invoice.amount,
        final_amount: invoice.amount,
        status: 'pending',
        invoice_url: `https://t.me/TonPaysInvoiceBot?start=inv_${invoiceId}`,
        web_invoice_url: `https://pay.tonpays.online/i/${invoiceId}`,
      });
    }
    if (url.endsWith('/api/v1/invoices/check')) {
      if (this.check === 'BAD_GATEWAY') return json(502, { error: 'bad gateway' });
      if (this.check === 'RATE_LIMITED') {
        return json(429, { detail: { code: 'RATE_LIMIT_EXCEEDED', message: 'slow down' } });
      }
      const invoiceId = String(body.invoice_id);
      const invoice = this.invoices.get(invoiceId)!;
      return json(200, {
        invoice_id: invoiceId,
        order_id: invoice.orderId,
        request_amount: invoice.amount,
        final_amount: invoice.amount,
        status: invoice.paid ? 'completed' : 'pending',
        paid: invoice.paid,
      });
    }
    return json(404, { detail: { code: 'NOT_FOUND' } });
  };

  approveAll(): void {
    for (const invoice of this.invoices.values()) invoice.paid = true;
  }
}

describe('FIX-03: payment-gateway operational events', () => {
  let ctx: TestContext;
  let owner: ActorContext;
  let customer: UserId;
  let tonpays: FakeTonPays;
  let offsetMs = 0;
  let seq = 0;
  const key = () => `gw-ops-${String((seq += 1))}`;

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    ctx.container.setInstallationTenant(tenantA.tenantId);
    offsetMs = 0;
    tonpays = new FakeTonPays();
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: `owner-${key()}`,
        roleKeys: ['owner'],
      }),
    );
    customer = (
      await ctx.container.customers.resolveFromUpdate(tenantA, systemActor('resolve'), {
        idempotencyKey: `resolve-${key()}`,
        telegramUserId: CUSTOMER,
        from: { id: Number(CUSTOMER), first_name: 'آزمون' },
        botInstanceId: BOT_A,
      })
    ).customer.id;
    await ctx.container.paymentGateways.configure(tenantA, owner, {
      idempotencyKey: key(),
      provider: 'TONPAYS',
      config: OPEN_ROUTE,
    });
    await ctx.container.paymentGateways.setCredential(tenantA, owner, {
      idempotencyKey: key(),
      provider: 'TONPAYS',
      apiKey: API_KEY,
    });
    await ctx.container.paymentGateways.setStatus(tenantA, owner, {
      idempotencyKey: key(),
      provider: 'TONPAYS',
      status: 'ACTIVE',
    });
  });

  function lane(
    options: {
      readonly payments?: GatewayPaymentServiceDeps['payments'];
      readonly noCredential?: boolean;
      readonly health?: GatewayInquiryHealth;
      readonly opsLog?: GatewayPaymentServiceDeps['opsLog'];
    } = {},
  ): GatewayPaymentService {
    const db = ctx.container.database.db;
    const adapter = new TonPaysAdapter({ fetch: tonpays.fetch });
    const store = new DrizzleGatewayCredentialStore(db, ctx.container.cipher, () =>
      ctx.container.ids.uuid(),
    );
    const credentials =
      options.noCredential === true
        ? new Proxy(store, {
            get: (target, property, receiver) =>
              property === 'read'
                ? () => Promise.resolve(null)
                : (Reflect.get(target, property, receiver) as unknown),
          })
        : store;
    return new GatewayPaymentService({
      invoices: new DrizzleGatewayInvoiceRepository(db),
      payments: options.payments ?? ctx.container.payments,
      paymentRecords: new DrizzlePaymentRepository(db),
      adapters: (provider) => (provider === 'TONPAYS' ? adapter : null),
      credentials,
      botTokens: { tokenForBotInstance: () => Promise.resolve(null) },
      presentation: () => Promise.reject(new Error('TonPays renders no invoice text')),
      budget: new DrizzleGatewayCallBudget(db),
      callbackUrlFor: async () => null,
      customers: new DrizzleCustomerRepository(db),
      conditions: new DrizzleOperationalConditionReader(db),
      scopeActivity: ctx.container.tenants,
      uow: ctx.container.uow,
      audit: ctx.container.audit,
      opsLog: options.opsLog ?? ctx.container.opsLog,
      outbox: ctx.container.outbox,
      clock: { now: () => new Date(Date.now() + offsetMs) },
      ids: ctx.container.ids,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      inquiryHealth:
        options.health ??
        new GatewayInquiryHealth({ threshold: 2, windowMs: 3_600_000, recheckMs: 0 }),
    });
  }

  async function topup(): Promise<PaymentId> {
    const k = key();
    const attempt = await ctx.container.payments.requestGatewayTopup(
      { ...tenantA, botInstanceId: BOT_A },
      systemActor(k),
      customer,
      { idempotencyKey: k, amount: money(250_000n, 'IRT'), provider: 'TONPAYS' },
    );
    return attempt.payment.id as PaymentId;
  }

  /** Every scheduled inquiry due (a minute on), and one pass. */
  async function inquire(service: GatewayPaymentService) {
    offsetMs += 2 * 60_000;
    return service.runOnce(tenantA);
  }

  interface EventRow {
    readonly code: string;
    readonly dedupe_key: string | null;
    readonly occurrence_count: number;
    readonly resolved_at: Date | null;
    readonly context: Record<string, unknown>;
  }

  async function events(code: string): Promise<EventRow[]> {
    const result = await ctx.container.database.db.execute(
      sql`SELECT code, dedupe_key, occurrence_count, resolved_at, context
            FROM operational_events WHERE tenant_id = ${tenantA.tenantId} AND code = ${code}
           ORDER BY first_seen_at, id`,
    );
    return result.rows as unknown as EventRow[];
  }

  async function paymentState(paymentId: string): Promise<string> {
    const result = await ctx.container.database.db.execute(
      sql`SELECT state FROM payments WHERE id = ${paymentId}`,
    );
    return (result.rows[0] as { state: string }).state;
  }

  it('an approval the settlement refused is reported once per payment, and nothing is credited', async () => {
    const paymentId = await topup();
    await lane().runOnce(tenantA); // creates the invoice
    tonpays.approveAll();
    let refusals = 0;
    const refusing = new Proxy(ctx.container.payments, {
      get: (target, property, receiver) =>
        property === 'confirmGatewayPayment'
          ? () => {
              refusals += 1;
              return Promise.reject(new Error('scope stopped accepting work'));
            }
          : (Reflect.get(target, property, receiver) as unknown),
    });
    const broken = lane({ payments: refusing });
    await inquire(broken);
    await inquire(broken);
    expect(refusals).toBe(2);

    const rows = await events(GATEWAY_SETTLEMENT_FAILED_CODE);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      dedupe_key: `${GATEWAY_SETTLEMENT_FAILED_CODE}:${paymentId}`,
      occurrence_count: 2,
      context: { paymentId, provider: 'TONPAYS', error: 'Error' },
    });
    // Undecided: the condition stays open, and nothing has recovered it.
    expect(rows[0]!.resolved_at).toBeNull();
    expect(await events(GATEWAY_SETTLEMENT_DECIDED_CODE)).toEqual([]);
    // Neither the error's message nor the key ever reaches the row.
    expect(JSON.stringify(rows)).not.toContain('scope stopped');
    expect(JSON.stringify(rows)).not.toContain(API_KEY);
    expect(await paymentState(paymentId)).toBe('PENDING');

    // The settlement path recovers: credited exactly once, and no new failure row.
    await inquire(lane());
    expect(await paymentState(paymentId)).toBe('CONFIRMED');
    const after = await events(GATEWAY_SETTLEMENT_FAILED_CODE);
    expect(after).toHaveLength(1);
    // Audit P2-b on #260: and the alarm that said "nothing was credited" is closed.
    expect(after[0]!.resolved_at).not.toBeNull();
    const decided = await events(GATEWAY_SETTLEMENT_DECIDED_CODE);
    expect(decided).toHaveLength(1);
    expect(decided[0]!.context).toEqual({ paymentId });
    // A later pass decides nothing more and records nothing more.
    await inquire(lane());
    expect(await events(GATEWAY_SETTLEMENT_DECIDED_CODE)).toHaveLength(1);
  });

  it('a refused approval later recorded LATE_COMPLETION closes its alarm; another payment keeps its own', async () => {
    const late = await topup();
    await lane().runOnce(tenantA);
    const other = await ctx.container.payments.requestGatewayTopup(
      { ...tenantA, botInstanceId: BOT_A },
      systemActor(key()),
      customer,
      { idempotencyKey: key(), amount: money(300_000n, 'IRT'), provider: 'TONPAYS' },
    );
    const otherId = other.payment.id as PaymentId;
    await lane().runOnce(tenantA);
    tonpays.approveAll();
    const refusing = new Proxy(ctx.container.payments, {
      get: (target, property, receiver) =>
        property === 'confirmGatewayPayment'
          ? () => Promise.reject(new Error('scope stopped accepting work'))
          : (Reflect.get(target, property, receiver) as unknown),
    });
    await inquire(lane({ payments: refusing }));
    const open = await events(GATEWAY_SETTLEMENT_FAILED_CODE);
    expect(open.map((row) => row.dedupe_key).sort()).toEqual(
      [late, otherId].map((id) => `${GATEWAY_SETTLEMENT_FAILED_CODE}:${id}`).sort(),
    );
    // Past `late`'s deadline only: its next answer is a LATE_COMPLETION, a decision.
    await ctx.container.database.db.execute(
      sql`UPDATE payments SET expires_at = ${new Date(Date.now() + offsetMs + 60_000)}
           WHERE id = ${late}`,
    );
    // The other payment is not asked in that pass: nothing is decided about it.
    await ctx.container.database.db.execute(
      sql`UPDATE gateway_invoices SET next_inquiry_at = ${new Date(Date.now() + offsetMs + 3_600_000)}
           WHERE payment_id = ${otherId}`,
    );
    await inquire(lane({ payments: refusing }));
    expect(await paymentState(late)).toBe('PENDING');
    const rows = await events(GATEWAY_SETTLEMENT_FAILED_CODE);
    const byKey = new Map(rows.map((row) => [row.dedupe_key, row]));
    expect(byKey.get(`${GATEWAY_SETTLEMENT_FAILED_CODE}:${late}`)?.resolved_at).not.toBeNull();
    // The other payment is undecided: still nothing credited, its alarm still open.
    expect(byKey.get(`${GATEWAY_SETTLEMENT_FAILED_CODE}:${otherId}`)?.resolved_at).toBeNull();
    expect(await paymentState(otherId)).toBe('PENDING');
    expect((await events(GATEWAY_SETTLEMENT_DECIDED_CODE)).map((row) => row.context)).toEqual([
      { paymentId: late },
    ]);
  });

  it('a decision with no refusal before it records no recovery', async () => {
    const paymentId = await topup();
    await lane().runOnce(tenantA);
    tonpays.approveAll();
    await inquire(lane());
    expect(await paymentState(paymentId)).toBe('CONFIRMED');
    expect(await events(GATEWAY_SETTLEMENT_DECIDED_CODE)).toEqual([]);
  });

  it('inquiries that keep failing open the gateway condition; an answered one closes it', async () => {
    await topup();
    const health = new GatewayInquiryHealth({ threshold: 2, windowMs: 3_600_000, recheckMs: 0 });
    const service = lane({ health });
    await service.runOnce(tenantA); // creates the invoice

    tonpays.check = 'BAD_GATEWAY';
    await inquire(service);
    expect(await events(GATEWAY_INQUIRY_FAILING_CODE)).toHaveLength(0);
    tonpays.check = 'RATE_LIMITED';
    await inquire(service);
    const opened = await events(GATEWAY_INQUIRY_FAILING_CODE);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      dedupe_key: `${GATEWAY_INQUIRY_FAILING_CODE}:TONPAYS`,
      resolved_at: null,
      context: { provider: 'TONPAYS', reason: 'RATE_LIMITED' },
    });

    tonpays.check = 'ANSWER';
    await inquire(service);
    expect(await events(GATEWAY_INQUIRY_OK_CODE)).toHaveLength(1);
    expect((await events(GATEWAY_INQUIRY_FAILING_CODE))[0]?.resolved_at).not.toBeNull();
    // A healthy lane closes nothing more.
    await inquire(service);
    expect(await events(GATEWAY_INQUIRY_OK_CODE)).toHaveLength(1);
  });

  it('a failing-condition record that did not land is tried again on the next failure (Codex P2 on #260)', async () => {
    await topup();
    let refuseNext = true;
    const flaky: GatewayPaymentServiceDeps['opsLog'] = {
      record: (scope, event, tx) => {
        if (event.code === GATEWAY_INQUIRY_FAILING_CODE && refuseNext) {
          refuseNext = false;
          return Promise.reject(new Error('operations log unavailable'));
        }
        return ctx.container.opsLog.record(scope, event, tx);
      },
    };
    // A ten-minute window: before the fix, the failed write held the next one off for it.
    const health = new GatewayInquiryHealth({ threshold: 2, windowMs: 600_000, recheckMs: 0 });
    const service = lane({ health, opsLog: flaky });
    await service.runOnce(tenantA); // creates the invoice
    tonpays.check = 'BAD_GATEWAY';
    await inquire(service);
    await inquire(service); // threshold reached; the write is refused
    expect(refuseNext).toBe(false);
    expect(await events(GATEWAY_INQUIRY_FAILING_CODE)).toHaveLength(0);
    await inquire(service); // two minutes later, inside the window: recorded now
    const rows = await events(GATEWAY_INQUIRY_FAILING_CODE);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.resolved_at).toBeNull();
  });

  it('one failed inquiry is not an outage', async () => {
    await topup();
    const service = lane();
    await service.runOnce(tenantA);
    tonpays.check = 'BAD_GATEWAY';
    await inquire(service);
    tonpays.check = 'ANSWER';
    await inquire(service);
    tonpays.check = 'BAD_GATEWAY';
    await inquire(service);
    expect(await events(GATEWAY_INQUIRY_FAILING_CODE)).toHaveLength(0);
    expect(await events(GATEWAY_INQUIRY_OK_CODE)).toHaveLength(0);
  });

  it('an inquiry whose route lost its key opens the misconfigured condition', async () => {
    await topup();
    await lane().runOnce(tenantA); // created with the key
    await inquire(lane({ noCredential: true }));
    const rows = await events(GATEWAY_MISCONFIGURED_CODE);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      dedupe_key: `${GATEWAY_MISCONFIGURED_CODE}:TONPAYS`,
      context: { provider: 'TONPAYS', reason: 'nexa.credential_missing' },
    });
  });
});
