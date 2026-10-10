import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  TONPAYS_INQUIRY_BUDGET_PER_MINUTE,
  money,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type PaymentGatewayConfig,
  type PaymentId,
  type UserId,
} from '@nexa/contracts';
import { GATEWAY_PAYMENT_INTERVAL_MS } from '../../apps/api/src/modules/commerce/payments/application/gateway-payment-loop';
import type { GatewayPaymentService } from '../../apps/api/src/modules/commerce/payments/application/gateway-payment.service';
import {
  TONPAYS_INQUIRY_SCHEDULE,
  firstInquiryAt,
  hintReservePerMinute,
} from '../../apps/api/src/modules/commerce/payments/domain/inquiry-schedule';
import type { FetchLike } from '../../apps/api/src/modules/commerce/payments/infrastructure/tonpays-adapter';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  SEED_IDS,
  tenantA,
  type TestContext,
} from './harness';
import { FakeTonPaysTelegram, json, telegramLaneWith, useClock } from './tonpays-telegram-fixture';

/**
 * FIX-06 (batch 2026-10-10) against a real database: the per-provider inquiry schedule, the
 * budget share kept for hinted rows, and hinted inquiries asked before a pass's creations —
 * with the money rules they must not touch: only the inquiry's `completed` + `paid === true`
 * settles, a webhook only brings the question forward, an approval is settled once, a 429 backs
 * off and approves nothing, and the deadline still turns a late approval into LATE_COMPLETION.
 *
 * The REAL TonPays adapter over a fake `fetch`; the lane walked pass by pass at its production
 * interval on a pinned clock. Nothing leaves the process.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const MARYAM = '930930';

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

/** A fake TonPays website API that records the ORDER of its calls. */
class FakeTonPays {
  readonly invoices = new Map<
    string,
    { orderId: string; amount: number; status: string; paid: unknown }
  >();
  readonly calls: string[] = [];
  /** What the next check answers instead of the invoice: a 429, or nothing (a timeout). */
  checkMode: 'OK' | 'RATE_LIMITED' | 'LOST' = 'OK';
  /** How long a create takes to answer. */
  createDelayMs = 0;
  /** Runs inside a check, and inside a create, before each answers. */
  onCheck: (() => Promise<void>) | null = null;
  onCreate: (() => Promise<void>) | null = null;
  private seq = 0;

  readonly fetch: FetchLike = async (url, init) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    if (url.endsWith('/api/v1/invoices/create')) {
      this.calls.push('create');
      if (this.onCreate !== null) await this.onCreate();
      if (this.createDelayMs > 0) await new Promise((r) => setTimeout(r, this.createDelayMs));
      this.seq += 1;
      const invoiceId = `TPS-${String(this.seq).padStart(6, '0')}`;
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
      this.calls.push(`check:${String(body.invoice_id)}`);
      if (this.onCheck !== null) await this.onCheck();
      if (this.checkMode === 'RATE_LIMITED') {
        return json(429, { detail: { code: 'RATE_LIMIT_EXCEEDED' } });
      }
      if (this.checkMode === 'LOST') throw new Error('socket hang up');
      const invoice = this.invoices.get(String(body.invoice_id));
      if (invoice === undefined) return json(404, { detail: { code: 'INVOICE_NOT_FOUND' } });
      return json(200, {
        invoice_id: String(body.invoice_id),
        order_id: invoice.orderId,
        request_amount: invoice.amount,
        final_amount: invoice.amount,
        status: invoice.status,
        paid: invoice.paid,
      });
    }
    return json(404, { detail: { code: 'NOT_FOUND' } });
  };

  set(invoiceId: string, status: string, paid: unknown): void {
    const invoice = this.invoices.get(invoiceId);
    if (invoice === undefined) throw new Error(`no fake invoice ${invoiceId}`);
    invoice.status = status;
    invoice.paid = paid;
  }

  checks(): number {
    return this.calls.filter((call) => call.startsWith('check:')).length;
  }
}

describe('FIX-06: the inquiry schedule, the hint reserve and the pass order', () => {
  let ctx: TestContext;
  let owner: ActorContext;
  let maryam: UserId;
  let tonpays: FakeTonPays;
  let lane: GatewayPaymentService;
  let clock: ReturnType<typeof useClock>;
  let now: number;
  let seq = 0;
  const key = () => `schedule-${String((seq += 1))}`;

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  afterEach(() => {
    clock?.restore();
  });

  beforeEach(async () => {
    await ctx.reset();
    ctx.container.setInstallationTenant(tenantA.tenantId);
    clock = useClock(ctx);
    now = Date.now();
    clock.at(new Date(now));
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-sched', roleKeys: ['owner'] }),
    );
    maryam = (
      await ctx.container.customers.resolveFromUpdate(tenantA, systemActor('resolve-s'), {
        idempotencyKey: 'resolve-schedule',
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
    lane = telegramLaneWith(ctx, new FakeTonPaysTelegram(), { websiteFetch: tonpays.fetch });
    await ctx.container.paymentGateways.configure(tenantA, owner, {
      idempotencyKey: key(),
      provider: 'TONPAYS',
      config: OPEN_ROUTE,
    });
    await ctx.container.paymentGateways.setCredential(tenantA, owner, {
      idempotencyKey: key(),
      provider: 'TONPAYS',
      apiKey: 'tp_live_schedule_key_never_leaks_3f2d',
    });
    await ctx.container.paymentGateways.setStatus(tenantA, owner, {
      idempotencyKey: key(),
      provider: 'TONPAYS',
      status: 'ACTIVE',
    });
  });

  const advance = (ms: number) => {
    now += ms;
    clock.at(new Date(now));
  };

  async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
    return (await ctx.container.database.db.execute(query)).rows as T[];
  }

  const topup = async (amountMinor = 250_000n) =>
    (
      await ctx.container.payments.requestGatewayTopup(
        { tenantId: tenantA.tenantId, botInstanceId: BOT_A },
        systemActor(key()),
        maryam,
        { idempotencyKey: key(), amount: money(amountMinor, 'IRT'), provider: 'TONPAYS' },
      )
    ).payment.id as PaymentId;

  async function invoiceOf(paymentId: string) {
    const [row] = await rows<{
      provider_order_id: string;
      provider_invoice_id: string | null;
      created_invoice_at: Date | null;
      next_inquiry_at: Date | null;
      outcome: string | null;
    }>(
      sql`SELECT provider_order_id, provider_invoice_id, created_invoice_at, next_inquiry_at, outcome
            FROM gateway_invoices WHERE payment_id = ${paymentId}`,
    );
    if (row === undefined) throw new Error('no invoice row');
    return row;
  }

  const stateOf = async (paymentId: string) =>
    (await rows<{ state: string }>(sql`SELECT state FROM payments WHERE id = ${paymentId}`))[0]!
      .state;

  const credits = (paymentId: string) =>
    rows<{ amount: string }>(
      sql`SELECT amount::text AS amount FROM wallet_entries WHERE payment_id = ${paymentId}`,
    );

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

  /** Passes at the production interval until CONFIRMED; the clock at the settling pass. */
  async function passesUntilConfirmed(paymentId: string, limitMs: number): Promise<number> {
    const until = now + limitMs;
    while (now <= until) {
      await lane.runOnce(tenantA);
      if ((await stateOf(paymentId)) === 'CONFIRMED') return now;
      advance(GATEWAY_PAYMENT_INTERVAL_MS);
    }
    throw new Error(`not discovered within ${String(limitMs)} ms`);
  }

  async function createdTopup() {
    const paymentId = await topup();
    await lane.runOnce(tenantA);
    const invoice = await invoiceOf(paymentId);
    expect(invoice.provider_invoice_id).not.toBeNull();
    return { paymentId, invoice };
  }

  /** The tenant's TonPays budget window, already this full. */
  async function budgetUsed(used: number) {
    await ctx.container.database.db.execute(sql`
      INSERT INTO payment_gateway_call_budgets (tenant_id, provider, window_started_at, used)
      VALUES (${tenantA.tenantId}, 'TONPAYS', ${new Date(now)}, ${used})
      ON CONFLICT (tenant_id, provider)
        DO UPDATE SET window_started_at = EXCLUDED.window_started_at, used = EXCLUDED.used`);
  }

  // =====================================================================================

  describe('the schedule', () => {
    it('asks TonPays first about ten seconds after the invoice, at the jitter the payment names', async () => {
      const { paymentId, invoice } = await createdTopup();
      const created = new Date(invoice.created_invoice_at!);
      expect(new Date(invoice.next_inquiry_at!).getTime()).toBe(
        firstInquiryAt(TONPAYS_INQUIRY_SCHEDULE, created, paymentId).getTime(),
      );
      const delay = new Date(invoice.next_inquiry_at!).getTime() - created.getTime();
      expect(delay).toBeGreaterThanOrEqual(9_000);
      expect(delay).toBeLessThanOrEqual(11_000);
    });

    it('a lost callback is still discovered inside the early window: paid just after an ask, seen within one 10 s step', async () => {
      const { paymentId, invoice } = await createdTopup();
      // The lane at its interval until its first ask, which finds the invoice unpaid.
      while (tonpays.checks() === 0) {
        advance(GATEWAY_PAYMENT_INTERVAL_MS);
        await lane.runOnce(tenantA);
      }
      expect(await stateOf(paymentId)).toBe('PENDING');
      // Paid a second after it — the worst phase: a whole step to wait.
      advance(1_000);
      tonpays.set(invoice.provider_invoice_id!, 'completed', true);
      const paidAt = now;
      const seenAt = await passesUntilConfirmed(paymentId, 5 * 60_000);
      // One band step (10 s, +10 % jitter) and one pass, where the old schedule waited 40 s.
      expect(seenAt - paidAt).toBeLessThanOrEqual(11_000 + GATEWAY_PAYMENT_INTERVAL_MS);
      expect(tonpays.checks()).toBe(2);
      expect(await credits(paymentId)).toHaveLength(1);
    });

    it('decays after the fast phase: at twenty minutes the next scheduled ask is minutes away, not seconds', async () => {
      const { paymentId } = await createdTopup();
      advance(20 * 60_000);
      await lane.runOnce(tenantA);
      const next = new Date((await invoiceOf(paymentId)).next_inquiry_at!).getTime();
      expect(next - now).toBeGreaterThanOrEqual(108_000);
      expect(next - now).toBeLessThanOrEqual(132_000);
    });
  });

  describe('the money rules the schedule must not touch', () => {
    it('a webhook and the scheduled inquiry due at the same moment settle ONCE', async () => {
      const { paymentId, invoice } = await createdTopup();
      tonpays.set(invoice.provider_invoice_id!, 'completed', true);
      advance(10_000);
      expect(await webhook(invoice, 'sim-1')).toBe('SCHEDULED');
      const other = telegramLaneWith(ctx, new FakeTonPaysTelegram(), {
        websiteFetch: tonpays.fetch,
      });
      await Promise.all([lane.runOnce(tenantA), other.runOnce(tenantA)]);
      await webhook(invoice, 'sim-2');
      advance(30_000);
      await lane.runOnce(tenantA);
      expect(await stateOf(paymentId)).toBe('CONFIRMED');
      expect(await credits(paymentId)).toHaveLength(1);
      expect((await invoiceOf(paymentId)).outcome).toBe('SETTLED');
    });

    it('never approves on anything but completed AND paid === true, however often it asks', async () => {
      const { paymentId, invoice } = await createdTopup();
      for (const [status, paid] of [
        ['completed', false],
        ['completed', 'true'],
        ['completed', null],
        ['processing', true],
      ] as const) {
        tonpays.set(invoice.provider_invoice_id!, status, paid);
        advance(11_000);
        await lane.runOnce(tenantA);
        expect(await stateOf(paymentId), `${status}/${String(paid)}`).toBe('PENDING');
      }
      // A lost answer is UNKNOWN, never success.
      tonpays.set(invoice.provider_invoice_id!, 'completed', true);
      tonpays.checkMode = 'LOST';
      advance(11_000);
      await lane.runOnce(tenantA);
      expect(await stateOf(paymentId)).toBe('PENDING');
      expect(await credits(paymentId)).toEqual([]);
    });

    it('a 429 backs the row off at least a minute and approves nothing', async () => {
      const { paymentId, invoice } = await createdTopup();
      tonpays.set(invoice.provider_invoice_id!, 'completed', true);
      tonpays.checkMode = 'RATE_LIMITED';
      advance(11_000);
      await lane.runOnce(tenantA);
      expect(tonpays.checks()).toBe(1);
      const next = new Date((await invoiceOf(paymentId)).next_inquiry_at!).getTime();
      expect(next - now).toBeGreaterThanOrEqual(60_000);
      // Passes inside that minute ask nothing more.
      for (let i = 0; i < 15; i += 1) {
        advance(GATEWAY_PAYMENT_INTERVAL_MS);
        await lane.runOnce(tenantA);
      }
      expect(tonpays.checks()).toBe(1);
      expect(await stateOf(paymentId)).toBe('PENDING');
      tonpays.checkMode = 'OK';
      advance(20_000);
      await lane.runOnce(tenantA);
      expect(await stateOf(paymentId)).toBe('CONFIRMED');
    });

    it('an approval seen after the deadline is a LATE_COMPLETION, credits nothing', async () => {
      const { paymentId, invoice } = await createdTopup();
      await ctx.container.database.db.execute(
        sql`UPDATE payments SET expires_at = ${new Date(now + 15_000)} WHERE id = ${paymentId}`,
      );
      tonpays.set(invoice.provider_invoice_id!, 'completed', true);
      advance(16_000);
      await lane.runOnce(tenantA);
      expect(await credits(paymentId)).toEqual([]);
      expect((await invoiceOf(paymentId)).outcome).toBe('LATE_COMPLETION');
    });
  });

  describe('the hint reserve and the pass order', () => {
    it('a scheduled inquiry may not take the reserved top of the budget; a hinted one may', async () => {
      const reserve = hintReservePerMinute(TONPAYS_INQUIRY_BUDGET_PER_MINUTE);
      const { paymentId, invoice } = await createdTopup();
      tonpays.set(invoice.provider_invoice_id!, 'completed', true);
      advance(11_000);
      // Every scheduled call this minute already spent.
      await budgetUsed(TONPAYS_INQUIRY_BUDGET_PER_MINUTE - reserve);
      const report = await lane.runOnce(tenantA);
      expect(report.budgetExhausted).toBe(true);
      expect(tonpays.checks(), 'a scheduled inquiry took the reserve').toBe(0);
      // The customer's webhook: the same row, now hinted, takes the reserve.
      await webhook(invoice, 'reserve-1');
      advance(1_000);
      await lane.runOnce(tenantA);
      expect(tonpays.checks()).toBe(1);
      expect(await stateOf(paymentId)).toBe('CONFIRMED');
      // And the reserve is a share of the budget, never above it.
      await budgetUsed(TONPAYS_INQUIRY_BUDGET_PER_MINUTE);
      const second = await createdTopup();
      tonpays.set(second.invoice.provider_invoice_id!, 'completed', true);
      await webhook(second.invoice, 'reserve-2');
      advance(1_000);
      await lane.runOnce(tenantA);
      expect(await stateOf(second.paymentId)).toBe('PENDING');
    });

    it('a hinted inquiry is asked before the pass’s creations, however slow they are', async () => {
      const { paymentId, invoice } = await createdTopup();
      tonpays.set(invoice.provider_invoice_id!, 'completed', true);
      await webhook(invoice, 'order-1');
      // Two customers ask for invoices; each create takes a while.
      await topup(300_000n);
      await topup(350_000n);
      tonpays.createDelayMs = 150;
      tonpays.calls.length = 0;
      advance(1_000);
      await lane.runOnce(tenantA);
      expect(tonpays.calls[0], 'a create went first').toBe(`check:${invoice.provider_invoice_id!}`);
      expect(tonpays.calls.filter((call) => call === 'create')).toHaveLength(2);
      expect(await stateOf(paymentId)).toBe('CONFIRMED');
    });

    it('a create claimed after slow hinted inquiries is leased from the clock it was claimed at', async () => {
      const { invoice } = await createdTopup();
      await webhook(invoice, 'lease-1');
      const paymentId = await topup(300_000n);
      tonpays.calls.length = 0;
      // The hinted check takes fifty seconds of the pass.
      tonpays.onCheck = async () => advance(50_000);
      let leaseLeft: number | null = null;
      tonpays.onCreate = async () => {
        const [row] = await rows<{ until: Date | null }>(
          sql`SELECT creation_claimed_until AS until FROM gateway_invoices WHERE payment_id = ${paymentId}`,
        );
        leaseLeft = new Date(row!.until!).getTime() - now;
      };
      advance(1_000);
      await lane.runOnce(tenantA);
      expect(tonpays.calls.filter((call) => call === 'create')).toHaveLength(1);
      // A whole lease, not one already fifty seconds short.
      expect(leaseLeft).not.toBeNull();
      expect(leaseLeft!).toBeGreaterThanOrEqual(59_000);
    });

    it('a hinted row that throws is isolated like any other: backed off, and the hinted row beside it still settles', async () => {
      const failing = await createdTopup();
      // A different amount: the same one would be handed back as the same open attempt.
      const healthyId = await topup(260_000n);
      await lane.runOnce(tenantA);
      const healthy = { paymentId: healthyId, invoice: await invoiceOf(healthyId) };
      expect(healthy.paymentId).not.toBe(failing.paymentId);
      tonpays.set(failing.invoice.provider_invoice_id!, 'rejected', false);
      tonpays.set(healthy.invoice.provider_invoice_id!, 'completed', true);
      await webhook(failing.invoice, 'iso-1');
      await webhook(healthy.invoice, 'iso-2');
      const payments = ctx.container.payments;
      const throwing = telegramLaneWith(ctx, new FakeTonPaysTelegram(), {
        websiteFetch: tonpays.fetch,
        payments: {
          confirmGatewayPayment: (...args) => payments.confirmGatewayPayment(...args),
          recordProviderReview: (...args) => payments.recordProviderReview(...args),
          recordProviderFundsDetected: (...args) => payments.recordProviderFundsDetected(...args),
          failGatewayPayment: () => Promise.reject(new Error('deadlock detected')),
        },
      });
      tonpays.calls.length = 0;
      advance(1_000);
      const report = await throwing.runOnce(tenantA);
      // Both were asked in the hinted pre-phase, before any create; one threw.
      expect(report.rowFailures).toBe(1);
      expect(await stateOf(healthy.paymentId)).toBe('CONFIRMED');
      expect(await stateOf(failing.paymentId)).toBe('PENDING');
      // Its answer was recorded before the throw, so it keeps that answer's schedule (FIX10
      // BUG-1: a back-off never overrides a committed outcome): asked again, lease cleared.
      const [row] = await rows<{ next_inquiry_at: Date; inquiry_claimed_until: Date | null }>(
        sql`SELECT next_inquiry_at, inquiry_claimed_until FROM gateway_invoices
             WHERE payment_id = ${failing.paymentId}`,
      );
      expect(new Date(row!.next_inquiry_at).getTime()).toBeGreaterThan(now);
      expect(row!.inquiry_claimed_until).toBeNull();
    });

    it('a scheduled inquiry keeps its place AFTER the creations, and is still asked in the same pass', async () => {
      const { paymentId, invoice } = await createdTopup();
      await topup(300_000n);
      tonpays.calls.length = 0;
      advance(11_000);
      await lane.runOnce(tenantA);
      expect(tonpays.calls).toEqual(['create', `check:${invoice.provider_invoice_id!}`]);
      expect(await stateOf(paymentId)).toBe('PENDING');
    });
  });
});
