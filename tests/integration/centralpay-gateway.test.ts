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
import { CentralPayAdapter } from '../../apps/api/src/modules/commerce/payments/infrastructure/centralpay-adapter';
import type { FetchLike } from '../../apps/api/src/modules/commerce/payments/infrastructure/tonpays-adapter';
import {
  GatewayPaymentService,
  gatewayReturnUrl,
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
 * CentralPay, end to end against a real database (`docs/centralpay-gateway-audit.md`).
 *
 * The container's own services decide everything — `PaymentService` and its one settlement
 * path, the gateway route service. The gateway LANE is built here over the container's
 * database with the REAL `CentralPayAdapter`, whose `fetch` is a recording fake CentralPay
 * written from the owner-supplied guide's shapes; nothing leaves the process. The lane's
 * clock is the only clock moved; a payment's deadline is moved on its row.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const MARYAM = '910911';
const LINK_KEY = 'cp_link_KEY_that_must_never_leak_6d1e';
const VERIFY_KEY = 'cp_verify_md5_must_never_leak_0a9b8c7d';
const CARD = '6037991122334455';
const TOPUP_TOMAN = 150_000n;

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
// A fake CentralPay: the guide's request and response shapes, and nothing more.
// ---------------------------------------------------------------------------------------

interface Paid {
  amount: number;
  userId: number;
  referenceId: string;
}

class FakeCentralPay {
  readonly links: Record<string, unknown>[] = [];
  readonly verifies: Record<string, unknown>[] = [];
  /** What `verify` answers per orderId once the customer paid; unpaid answers success:false. */
  readonly paid = new Map<number, Paid>();

  readonly fetch: FetchLike = async (url, init) => {
    const parsed = new URL(url);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    if (parsed.pathname === '/webservice/basic/getLink.php') {
      this.links.push(body);
      return json(200, {
        success: true,
        data: { redirectUrl: `https://pay.centralapi.org/p/${String(body.orderId)}` },
      });
    }
    if (parsed.pathname === '/webservice/basic/verify.php') {
      this.verifies.push(body);
      const paid = this.paid.get(Number(body.orderId));
      // Repeated verifies of a paid order keep answering success (the guide's own words).
      if (paid === undefined) return json(200, { success: false, message: 'not paid' });
      return json(200, { success: true, data: { ...paid, userCardNumber: CARD } });
    }
    return json(404, { success: false });
  };

  /** The customer paid this order at CentralPay (the link's own figures unless overridden). */
  pay(orderId: string, overrides: Partial<Paid> = {}): void {
    const link = this.links.find((one) => String(one.orderId) === orderId);
    if (link === undefined) throw new Error(`no fake link for ${orderId}`);
    this.paid.set(Number(orderId), {
      amount: Number(link.amount),
      userId: Number(link.userId),
      referenceId: `REF-${orderId}`,
      ...overrides,
    });
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('CentralPay, through the one settlement path', () => {
  let ctx: TestContext;
  let owner: ActorContext;
  let maryam: UserId;
  let fake: FakeCentralPay;
  let lane: GatewayPaymentService;
  let offsetMs: number;
  /** The lane reads no verify key while set: a key gone missing under an open attempt. */
  let hideVerifyKey = false;
  let seq = 0;
  const logged: string[] = [];
  const key = () => `cp-key-${String((seq += 1)).padStart(4, '0')}`;

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
      await createAdmin(ctx.container, tenantA, { username: 'owner-cp', roleKeys: ['owner'] }),
    );
    maryam = (
      await ctx.container.customers.resolveFromUpdate(tenantA, systemActor('resolve-cp'), {
        idempotencyKey: 'resolve-cp',
        telegramUserId: MARYAM,
        from: { id: Number(MARYAM), first_name: 'مریم' },
        botInstanceId: BOT_A,
      })
    ).customer.id;
    await ctx.container.database.db.execute(
      sql`UPDATE bot_instances SET webhook_url = ${`https://bot.example.com/telegram/webhook/${BOT_A}`}
          WHERE tenant_id = ${tenantA.tenantId}`,
    );
    fake = new FakeCentralPay();
    offsetMs = 0;
    hideVerifyKey = false;
    logged.length = 0;
    lane = laneWith(fake);
  });

  function laneWith(centralpay: FakeCentralPay): GatewayPaymentService {
    const db = ctx.container.database.db;
    const adapter = new CentralPayAdapter({ fetch: centralpay.fetch });
    const origins = new DrizzlePublicOriginReader(db);
    const log = (context: Record<string, unknown>, message: string) => {
      logged.push(`${message} ${JSON.stringify(context)}`);
    };
    return new GatewayPaymentService({
      invoices: new DrizzleGatewayInvoiceRepository(db),
      payments: ctx.container.payments,
      paymentRecords: new DrizzlePaymentRepository(db),
      adapters: (provider) => (provider === 'CENTRALPAY' ? adapter : null),
      credentials: new Proxy(
        new DrizzleGatewayCredentialStore(db, ctx.container.cipher, () => ctx.container.ids.uuid()),
        {
          get: (target, property, receiver) =>
            property === 'readVerifyKey' && hideVerifyKey
              ? () => Promise.resolve(null)
              : (Reflect.get(target, property, receiver) as unknown),
        },
      ),
      botTokens: { tokenForBotInstance: () => Promise.resolve(null) },
      presentation: () => Promise.reject(new Error('CentralPay renders no invoice text')),
      budget: new DrizzleGatewayCallBudget(db),
      callbackUrlFor: async (scope: TenantContext, provider) =>
        gatewayReturnUrl(await origins.originFor(scope), provider, String(scope.tenantId)),
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
    });
  }

  // -------------------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------------------

  async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
    return (await ctx.container.database.db.execute(query)).rows as T[];
  }

  async function enableCentralPay() {
    await ctx.container.paymentGateways.configure(tenantA, owner, {
      idempotencyKey: key(),
      provider: 'CENTRALPAY',
      config: OPEN_ROUTE,
    });
    await ctx.container.paymentGateways.setCredential(tenantA, owner, {
      idempotencyKey: key(),
      provider: 'CENTRALPAY',
      apiKey: LINK_KEY,
    });
    await ctx.container.paymentGateways.setVerifyKey(tenantA, owner, {
      idempotencyKey: key(),
      provider: 'CENTRALPAY',
      verifyKey: VERIFY_KEY,
    });
    await ctx.container.paymentGateways.setStatus(tenantA, owner, {
      idempotencyKey: key(),
      provider: 'CENTRALPAY',
      status: 'ACTIVE',
    });
  }

  const topup = (amountMinor = TOPUP_TOMAN) => {
    const k = key();
    return ctx.container.payments.requestGatewayTopup(tenantA, systemActor(k), maryam, {
      idempotencyKey: k,
      amount: money(amountMinor, 'IRT'),
      provider: 'CENTRALPAY',
    });
  };

  const pass = () => lane.runOnce(tenantA);
  async function inquireNow() {
    offsetMs += 6 * 60_000;
    return pass();
  }
  const browserReturn = (orderId: string | undefined) =>
    lane.receiveBrowserReturn(String(tenantA.tenantId), 'CENTRALPAY', orderId);

  async function invoiceOf(paymentId: string) {
    const [row] = await rows<{
      creation_state: string;
      provider_order_id: string;
      provider_invoice_id: string | null;
      provider_user_id: string | null;
      provider_status: string | null;
      provider_paid: boolean | null;
      provider_charge_id: string | null;
      provider_unit: string;
      sent_amount: string;
      invoice_url: string | null;
      outcome: string | null;
      next_inquiry_at: Date | null;
      post_deadline_inquiries: number;
    }>(sql`SELECT * FROM gateway_invoices WHERE payment_id = ${paymentId}`);
    if (row === undefined) throw new Error('no invoice row');
    return row;
  }

  async function paymentOf(paymentId: string) {
    const [row] = await rows<{
      state: string;
      evidence_kind: string | null;
      evidence_note: string | null;
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

  /** A created link for a fresh top-up attempt. */
  async function createdAttempt(
    amountMinor = TOPUP_TOMAN,
  ): Promise<{ paymentId: PaymentId; orderId: string }> {
    const attempt = await topup(amountMinor);
    await pass();
    const invoice = await invoiceOf(attempt.payment.id);
    if (invoice.creation_state !== 'CREATED') throw new Error('not created');
    return { paymentId: attempt.payment.id, orderId: invoice.provider_order_id };
  }

  // -------------------------------------------------------------------------------------

  describe('the route and its two keys', () => {
    it('cannot be enabled without the API key AND the verify key, and the verify key needs the API key first', async () => {
      await ctx.container.paymentGateways.configure(tenantA, owner, {
        idempotencyKey: key(),
        provider: 'CENTRALPAY',
        config: OPEN_ROUTE,
      });
      const early = await ctx.container.paymentGateways
        .setVerifyKey(tenantA, owner, {
          idempotencyKey: key(),
          provider: 'CENTRALPAY',
          verifyKey: VERIFY_KEY,
        })
        .catch((error: unknown) => error);
      expect(isNexaError(early) && early.details).toMatchObject({ reason: 'CREDENTIAL_MISSING' });
      await ctx.container.paymentGateways.setCredential(tenantA, owner, {
        idempotencyKey: key(),
        provider: 'CENTRALPAY',
        apiKey: LINK_KEY,
      });
      const refused = await ctx.container.paymentGateways
        .setStatus(tenantA, owner, {
          idempotencyKey: key(),
          provider: 'CENTRALPAY',
          status: 'ACTIVE',
        })
        .catch((error: unknown) => error);
      expect(isNexaError(refused) && refused.details).toMatchObject({
        reason: 'VERIFY_KEY_MISSING',
      });
      // A route with no separate verify key takes none.
      const tonpays = await ctx.container.paymentGateways
        .setVerifyKey(tenantA, owner, {
          idempotencyKey: key(),
          provider: 'TONPAYS',
          verifyKey: 'x',
        })
        .catch((error: unknown) => error);
      expect(isNexaError(tonpays)).toBe(true);
    });

    it('sends the link key to getLink and the verify key to verify, and never returns, audits or logs either — nor the card', async () => {
      await enableCentralPay();
      const { gateways, facts } = await ctx.container.paymentGateways.list(tenantA, owner);
      const view = JSON.stringify(
        { gateways, facts: [...facts.entries()] },
        (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
      );
      expect(view).not.toContain(LINK_KEY);
      expect(view).not.toContain(VERIFY_KEY);
      expect(facts.get('CENTRALPAY')?.verifyKeySetAt).not.toBeNull();
      const stored = JSON.stringify(
        await rows(sql`SELECT * FROM payment_gateway_credentials WHERE provider = 'CENTRALPAY'`),
      );
      expect(stored).not.toContain(LINK_KEY);
      expect(stored).not.toContain(VERIFY_KEY);

      const { orderId } = await createdAttempt();
      fake.pay(orderId);
      await inquireNow();
      expect(fake.links.every((body) => body.api_key === LINK_KEY)).toBe(true);
      expect(fake.verifies.length).toBeGreaterThan(0);
      expect(fake.verifies.every((body) => body.api_key === VERIFY_KEY)).toBe(true);
      const text = (value: unknown) =>
        JSON.stringify(value, (_key, item: unknown) =>
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
      expect(everything).not.toContain(LINK_KEY);
      expect(everything).not.toContain(VERIFY_KEY);
      expect(everything).not.toContain(CARD);
    });
  });

  describe('the link', () => {
    it('asks for the exact Toman with integer ids and the order id in the return URL', async () => {
      await enableCentralPay();
      const { paymentId, orderId } = await createdAttempt();
      const invoice = await invoiceOf(paymentId);
      expect(invoice).toMatchObject({
        creation_state: 'CREATED',
        provider_unit: 'IRT',
        provider_invoice_id: orderId,
        invoice_url: `https://pay.centralapi.org/p/${orderId}`,
      });
      expect(String(invoice.sent_amount)).toBe(String(TOPUP_TOMAN));
      expect(orderId).toMatch(/^[0-9]{10}$/u);
      expect(invoice.provider_user_id).toMatch(/^[0-9]{10}$/u);
      expect(fake.links).toEqual([
        {
          api_key: LINK_KEY,
          type: 'deposit',
          amount: 150000,
          userId: Number(invoice.provider_user_id),
          orderId: Number(orderId),
          returnUrl: `https://bot.example.com/payments/return/centralpay/${String(tenantA.tenantId)}?orderId=${orderId}`,
        },
      ]);
      // The customer's Telegram id never reaches CentralPay.
      expect(JSON.stringify(fake.links)).not.toContain(MARYAM);
    });

    it('keeps one stable userId per customer and a fresh orderId per attempt', async () => {
      await enableCentralPay();
      const first = await createdAttempt(150_000n);
      const second = await createdAttempt(160_000n);
      expect(first.orderId).not.toBe(second.orderId);
      const a = await invoiceOf(first.paymentId);
      const b = await invoiceOf(second.paymentId);
      expect(a.provider_user_id).toBe(b.provider_user_id);
      const numbers = await rows<{ number: string }>(
        sql`SELECT number::text AS number FROM gateway_customer_numbers WHERE customer_id = ${maryam}`,
      );
      expect(numbers).toEqual([{ number: a.provider_user_id }]);
      // Written once: neither the number nor the attempt's copy can be changed.
      const rewrite = await ctx.container.database.db
        .execute(sql`UPDATE gateway_customer_numbers SET number = number + 1`)
        .catch((error: unknown) => error);
      expect(rewrite).toBeInstanceOf(Error);
      const rewriteInvoice = await ctx.container.database.db
        .execute(
          sql`UPDATE gateway_invoices SET provider_user_id = '1000000000' WHERE payment_id = ${first.paymentId}`,
        )
        .catch((error: unknown) => error);
      expect(rewriteInvoice).toBeInstanceOf(Error);
    });
  });

  describe('settlement: only verify, with every local check', () => {
    it('a browser return alone never settles: it only brings the verify forward', async () => {
      await enableCentralPay();
      const { paymentId, orderId } = await createdAttempt();
      fake.pay(orderId);
      const before = fake.verifies.length;
      const returned = await browserReturn(orderId);
      expect(returned).toEqual({
        state: 'CHECKING',
        botLink: expect.stringMatching(/^https:\/\/t\.me\//u),
      });
      // No call was made by the return, and nothing moved.
      expect(fake.verifies.length).toBe(before);
      expect((await paymentOf(paymentId)).state).toBe('PENDING');
      expect(await ledger()).toEqual([]);
      // The worker's verify — not the return — settles it.
      await pass();
      expect(fake.verifies.length).toBe(before + 1);
      expect(await paymentOf(paymentId)).toMatchObject({
        state: 'CONFIRMED',
        evidence_kind: 'GATEWAY_INQUIRY',
        evidence_note: 'centralpay:verified:paid',
      });
      expect(await ledger()).toEqual([
        { reason: 'TOPUP_GATEWAY', amount: String(TOPUP_TOMAN), payment_id: paymentId },
      ]);
      const invoice = await invoiceOf(paymentId);
      expect(invoice).toMatchObject({
        outcome: 'SETTLED',
        provider_status: 'verified',
        provider_paid: true,
        provider_charge_id: `REF-${orderId}`,
      });
    });

    it('a browser return naming no attempt, another tenant or junk says nothing and asks nothing', async () => {
      await enableCentralPay();
      await createdAttempt();
      const before = fake.verifies.length;
      expect((await browserReturn('1000000001')).state).toBe('UNKNOWN');
      expect((await browserReturn(undefined)).state).toBe('UNKNOWN');
      expect((await browserReturn("1' OR 1=1")).state).toBe('UNKNOWN');
      expect(
        (await lane.receiveBrowserReturn('00000000-0000-4000-8000-00000000dead', 'CENTRALPAY', '1'))
          .state,
      ).toBe('UNKNOWN');
      await pass();
      expect(fake.verifies.length).toBe(before);
    });

    it('credits exactly once whatever repeats: returns and verifies after settlement answer from local state', async () => {
      await enableCentralPay();
      const { paymentId, orderId } = await createdAttempt();
      fake.pay(orderId);
      await browserReturn(orderId);
      await pass();
      expect((await paymentOf(paymentId)).state).toBe('CONFIRMED');
      const verifies = fake.verifies.length;
      // The customer refreshes the return page, twice, and the worker runs on.
      expect((await browserReturn(orderId)).state).toBe('CONFIRMED');
      expect((await browserReturn(orderId)).state).toBe('CONFIRMED');
      await inquireNow();
      await inquireNow();
      // CentralPay would still say success — but it is not asked again.
      expect(fake.verifies.length).toBe(verifies);
      await ctx.container.payments.confirmGatewayPayment(tenantA, systemActor('again'), paymentId, {
        evidenceNote: null,
        providerReference: `REF-${orderId}`,
      });
      expect(await ledger()).toHaveLength(1);
    });

    it('never fulfils an amount mismatch: UNKNOWN for an operator, nothing credited, not confirmable', async () => {
      await enableCentralPay();
      const { paymentId, orderId } = await createdAttempt();
      fake.pay(orderId, { amount: 149_999 });
      await browserReturn(orderId);
      await pass();
      expect((await paymentOf(paymentId)).state).toBe('UNKNOWN');
      expect((await invoiceOf(paymentId)).provider_paid).toBe(false);
      expect(await ledger()).toEqual([]);
      expect(await openConditions()).toContain('payments.gateway_review_unresolved');
      const [audit] = await rows<{ after: { reason: string } }>(
        sql`SELECT after FROM audit_logs WHERE action = 'payment.lose_track' AND entity_id = ${paymentId}`,
      );
      expect(audit?.after.reason).toBe('PROVIDER_AMOUNT_MISMATCH');
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
          note: 'short payment, refunded at CentralPay',
          idempotencyKey: key(),
        },
      );
      expect(failed.state).toBe('FAILED');
      expect(await ledger()).toEqual([]);
    });

    it('never fulfils a verify naming another userId', async () => {
      await enableCentralPay();
      const { paymentId, orderId } = await createdAttempt();
      fake.pay(orderId, { userId: 1_000_000_001 });
      await inquireNow();
      expect((await paymentOf(paymentId)).state).toBe('UNKNOWN');
      expect(await ledger()).toEqual([]);
      const [audit] = await rows<{ after: { reason: string } }>(
        sql`SELECT after FROM audit_logs WHERE action = 'payment.lose_track' AND entity_id = ${paymentId}`,
      );
      expect(audit?.after.reason).toBe('PROVIDER_USER_MISMATCH');
    });

    it('refuses a referenceId already consumed by another payment: one reference, one credit', async () => {
      await enableCentralPay();
      const first = await createdAttempt(150_000n);
      const second = await createdAttempt(160_000n);
      fake.pay(first.orderId, { referenceId: 'SHARED-REF' });
      await inquireNow();
      expect((await paymentOf(first.paymentId)).state).toBe('CONFIRMED');
      // CentralPay names the SAME reference for the second, otherwise perfect, order.
      fake.pay(second.orderId, { referenceId: 'SHARED-REF' });
      await inquireNow();
      expect((await paymentOf(second.paymentId)).state).toBe('UNKNOWN');
      expect(await ledger()).toHaveLength(1);
      const second0 = await invoiceOf(second.paymentId);
      expect(second0.provider_paid).toBe(false);
      expect(second0.provider_charge_id).toBeNull();
      const [audit] = await rows<{ after: { reason: string } }>(
        sql`SELECT after FROM audit_logs WHERE action = 'payment.lose_track' AND entity_id = ${second.paymentId}`,
      );
      expect(audit?.after.reason).toBe('PROVIDER_REFERENCE_REUSED');
      // And the settlement path refuses a reference that is not this attempt's, under its lock.
      const third = await createdAttempt(170_000n);
      const refused = await ctx.container.payments.confirmGatewayPayment(
        tenantA,
        systemActor('forged'),
        third.paymentId,
        { evidenceNote: null, providerReference: 'SHARED-REF' },
      );
      expect(refused).toMatchObject({
        outcome: 'NOT_ELIGIBLE',
        reason: 'PROVIDER_REFERENCE_MISMATCH',
      });
      // Nor will it settle a CentralPay payment with no reference at all.
      const bare = await ctx.container.payments.confirmGatewayPayment(
        tenantA,
        systemActor('bare'),
        third.paymentId,
        { evidenceNote: null },
      );
      expect(bare).toMatchObject({
        outcome: 'NOT_ELIGIBLE',
        reason: 'PROVIDER_REFERENCE_MISMATCH',
      });
      expect(await ledger()).toHaveLength(1);
    });

    it('records a verify after the deadline as a late completion — decided under the lock — and moves nothing', async () => {
      await enableCentralPay();
      const { paymentId, orderId } = await createdAttempt();
      await ctx.container.database.db.execute(
        sql`UPDATE payments SET expires_at = now() - interval '1 minute' WHERE id = ${paymentId}`,
      );
      offsetMs = -10 * 60_000;
      fake.pay(orderId);
      await browserReturn(orderId);
      await pass();
      expect((await paymentOf(paymentId)).state).toBe('PENDING');
      expect((await invoiceOf(paymentId)).outcome).toBe('LATE_COMPLETION');
      expect(await ledger()).toEqual([]);
      expect(await openConditions()).toContain('payments.gateway_late_completion');
    });
  });

  describe('reconciliation without a return', () => {
    it('finds a payment whose browser never came back, on the worker’s own schedule', async () => {
      await enableCentralPay();
      const { paymentId, orderId } = await createdAttempt();
      fake.pay(orderId);
      await inquireNow();
      expect((await paymentOf(paymentId)).state).toBe('CONFIRMED');
    });

    it('is bounded: verifies stop at the deadline, and returns after it ask at most a few diagnostics', async () => {
      await enableCentralPay();
      const { paymentId, orderId } = await createdAttempt();
      let passes = 0;
      while ((await invoiceOf(paymentId)).next_inquiry_at !== null && passes < 60) {
        await inquireNow();
        passes += 1;
      }
      expect((await invoiceOf(paymentId)).next_inquiry_at).toBeNull();
      expect(fake.verifies.length).toBeGreaterThan(3);
      expect(fake.verifies.length).toBeLessThanOrEqual(20);
      const atDeadline = fake.verifies.length;
      await inquireNow();
      expect(fake.verifies.length).toBe(atDeadline);
      // A customer hammering the return URL after the deadline: bounded diagnostics only.
      for (let index = 0; index < 8; index += 1) {
        await browserReturn(orderId);
        await inquireNow();
      }
      expect(fake.verifies.length - atDeadline).toBeLessThanOrEqual(3);
      expect(await ledger()).toEqual([]);
    });

    /*
     * Codex P1 on #260: the inquiry is authorised by the VERIFY key, the create by the link
     * key. A create that succeeds proves the link key and nothing about the verify key, so it
     * must not clear the alarm that no approval can be read; only an answered verify does.
     */
    it('keeps the verify-key alarm open across a successful create, and closes it on an answered verify', async () => {
      await enableCentralPay();
      const condition = async () =>
        rows<{ dedupe_key: string; resolved_at: Date | null; context: Record<string, unknown> }>(
          sql`SELECT dedupe_key, resolved_at, context FROM operational_events
               WHERE tenant_id = ${tenantA.tenantId} AND code = 'payments.gateway_misconfigured'
               ORDER BY first_seen_at`,
        );
      await createdAttempt();
      hideVerifyKey = true;
      await inquireNow();
      expect(await condition()).toEqual([
        {
          dedupe_key: 'payments.gateway_misconfigured:CENTRALPAY:verify-key',
          resolved_at: null,
          context: {
            provider: 'CENTRALPAY',
            reason: 'nexa.credential_missing',
            kind: 'VERIFY_KEY',
          },
        },
      ]);

      // Another customer's link is made with the LINK key, and succeeds — the create path's
      // own recovery runs. The verify-key alarm stays open: no approval can be read yet.
      offsetMs = 0;
      const other = (
        await ctx.container.customers.resolveFromUpdate(tenantA, systemActor('resolve-cp-2'), {
          idempotencyKey: 'resolve-cp-2',
          telegramUserId: '910912',
          from: { id: 910912, first_name: 'سارا' },
          botInstanceId: BOT_A,
        })
      ).customer.id;
      const k = key();
      const second = await ctx.container.payments.requestGatewayTopup(
        tenantA,
        systemActor(k),
        other,
        { idempotencyKey: k, amount: money(TOPUP_TOMAN, 'IRT'), provider: 'CENTRALPAY' },
      );
      const linksBefore = fake.links.length;
      await pass();
      expect(fake.links.length).toBe(linksBefore + 1);
      expect((await invoiceOf(second.payment.id)).creation_state).toBe('CREATED');
      expect((await condition())[0]?.resolved_at).toBeNull();
      expect(await openConditions()).toContain('payments.gateway_misconfigured');

      // The verify key is back and CentralPay answers a verify: that is what closes it.
      hideVerifyKey = false;
      const verifiesBefore = fake.verifies.length;
      await inquireNow();
      expect(fake.verifies.length).toBeGreaterThan(verifiesBefore);
      expect((await condition())[0]?.resolved_at).not.toBeNull();
      expect(await openConditions()).not.toContain('payments.gateway_misconfigured');
      expect((await paymentOf(second.payment.id)).state).toBe('PENDING');
    });

    it('accepts no webhook for the route', async () => {
      await enableCentralPay();
      const { paymentId, orderId } = await createdAttempt();
      fake.pay(orderId);
      expect(
        await lane.receiveWebhook(String(tenantA.tenantId), 'CENTRALPAY', { orderId }, undefined),
      ).toBe('NO_ADAPTER');
      expect((await paymentOf(paymentId)).state).toBe('PENDING');
    });
  });
});
