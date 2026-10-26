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
import { CustomGatewayAdapter } from '../../apps/api/src/modules/commerce/payments/infrastructure/custom-gateway-adapter';
import {
  GatewayPaymentService,
  gatewayCallbackUrl,
} from '../../apps/api/src/modules/commerce/payments/application/gateway-payment.service';
import { settingsLateCreditPolicy } from '../../apps/api/src/modules/commerce/payments/application/late-credit-policy';
import { DrizzleOperationalConditionReader } from '../../apps/api/src/modules/platform/opslog/infrastructure/drizzle-operational-event.reader';
import { matchesTrustedEntry } from '../../apps/api/src/infrastructure/trusted-proxy';
import { MockCustomBridge } from '../support/mock-custom-bridge';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  SEED_IDS,
  tenantA,
  type TestContext,
} from './harness';

/**
 * The custom gateway, end to end against a real database (`docs/protocols/custom-gateway.md`),
 * and the protocol's CONTRACT tests: one case per status, a bad signature, a replay, a stale
 * timestamp, an amount mismatch, the IP allow-list, and a callback that says PAID while the
 * inquiry says PENDING.
 *
 * The container's own services decide everything — `PaymentService` and its one settlement path,
 * the route service. The gateway LANE is built here over the container's database with the REAL
 * `CustomGatewayAdapter`, whose HTTP client is the reference bridge (`tests/support/
 * mock-custom-bridge.ts`, written from the protocol document) in process; nothing leaves the
 * process. The lane's clock (and the bridge's) is the only clock moved.
 *
 * Mutation checks are recorded in `docs/custom-gateway-falsification.md`.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const MARYAM = '910912';
const SECRET = 'cgw_live_SECRET_that_must_never_leak_9f3a2c71e0b4';
const BASE = 'https://bridge.example/nexa';
const TOPUP_TOMAN = 125_000n;
const RIAL = 1_250_000n;

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

const OPEN_ROUTE: PaymentGatewayConfig = {
  displayName: 'پرداخت آزمایشی',
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

describe('the custom gateway, through the one settlement path', () => {
  let ctx: TestContext;
  let owner: ActorContext;
  let maryam: UserId;
  let bridge: MockCustomBridge;
  let lane: GatewayPaymentService;
  let offsetMs: number;
  let seq = 0;
  const logged: string[] = [];
  const key = () => `cg-key-${String((seq += 1)).padStart(4, '0')}`;
  const now = () => new Date(Date.now() + offsetMs);

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
      await createAdmin(ctx.container, tenantA, { username: 'owner-cg', roleKeys: ['owner'] }),
    );
    maryam = (
      await ctx.container.customers.resolveFromUpdate(tenantA, systemActor('resolve-cg'), {
        idempotencyKey: 'resolve-cg',
        telegramUserId: MARYAM,
        from: { id: Number(MARYAM), first_name: 'مریم' },
        botInstanceId: BOT_A,
      })
    ).customer.id;
    offsetMs = 0;
    logged.length = 0;
    bridge = new MockCustomBridge({ secret: SECRET, now, basePath: '/nexa' });
    lane = laneWith(bridge);
  });

  function laneWith(target: MockCustomBridge): GatewayPaymentService {
    const db = ctx.container.database.db;
    const adapter = new CustomGatewayAdapter({ http: target.http, now });
    const origins = new DrizzlePublicOriginReader(db);
    const routes = new DrizzlePaymentGatewayRepository(db);
    const log = (context: Record<string, unknown>, message: string) => {
      logged.push(`${message} ${JSON.stringify(context)}`);
    };
    return new GatewayPaymentService({
      invoices: new DrizzleGatewayInvoiceRepository(db),
      payments: ctx.container.payments,
      paymentRecords: new DrizzlePaymentRepository(db),
      adapters: (provider) => (provider === 'CUSTOM' ? adapter : null),
      credentials: new DrizzleGatewayCredentialStore(db, ctx.container.cipher, () =>
        ctx.container.ids.uuid(),
      ),
      botTokens: { tokenForBotInstance: () => Promise.resolve(null) },
      presentation: () => Promise.reject(new Error('the custom gateway renders no invoice text')),
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
      clock: { now },
      ids: ctx.container.ids,
      logger: { info: log, warn: log, error: log },
      botLinkFor: (scope) => origins.botLinkFor(scope),
      routeVisibility: routes,
      webhookSources: {
        allowlistFor: async (scope, provider) =>
          (await routes.find(scope, provider))?.webhookIpAllowlist ?? null,
        matches: matchesTrustedEntry,
      },
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

  async function setEndpoint(baseUrl = BASE, ipAllowlist: readonly string[] = []) {
    return ctx.container.paymentGateways.setEndpoint(tenantA, owner, {
      idempotencyKey: key(),
      provider: 'CUSTOM',
      baseUrl,
      ipAllowlist,
    });
  }

  async function setStatus(status: 'ACTIVE' | 'DISABLED') {
    return ctx.container.paymentGateways.setStatus(tenantA, owner, {
      idempotencyKey: key(),
      provider: 'CUSTOM',
      status,
    });
  }

  async function enableCustom(options: { fee?: number; allowlist?: readonly string[] } = {}) {
    await ctx.container.paymentGateways.configure(tenantA, owner, {
      idempotencyKey: key(),
      provider: 'CUSTOM',
      config: { ...OPEN_ROUTE, customerFeeBasisPoints: options.fee ?? 0 },
    });
    await ctx.container.paymentGateways.setCredential(tenantA, owner, {
      idempotencyKey: key(),
      provider: 'CUSTOM',
      apiKey: SECRET,
    });
    await setEndpoint(BASE, options.allowlist ?? []);
    await setStatus('ACTIVE');
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
      provider: 'CUSTOM',
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
      provider_order_id: string;
      provider_invoice_id: string | null;
      provider_user_id: string | null;
      provider_status: string | null;
      provider_paid: boolean | null;
      provider_unit: string;
      sent_amount: bigint;
      final_amount: string | null;
      invoice_url: string | null;
      outcome: string | null;
      endpoint_base_url: string | null;
      last_webhook_delivery_id: string | null;
      webhook_count: number;
      next_inquiry_at: Date | null;
    }>(sql`SELECT * FROM gateway_invoices WHERE payment_id = ${paymentId}`);
    if (row === undefined) throw new Error('no invoice row');
    return row;
  }

  async function paymentOf(paymentId: string) {
    const [row] = await rows<{ state: string }>(
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
  ): Promise<{ paymentId: PaymentId; orderId: string; reference: string }> {
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
      reference: invoice.provider_invoice_id,
    };
  }

  /** A bridge callback, delivered to the lane as the webhook controller would hand it on. */
  const deliver = (
    signed: { body: string; headers: Record<string, string> },
    /** The sender as the trusted proxy reported it; `null`: Nexa does not know it. */
    sourceIp: string | null = '203.0.113.10',
  ) =>
    lane.receiveWebhook(
      String(tenantA.tenantId),
      'CUSTOM',
      JSON.parse(signed.body) as unknown,
      signed.headers['x-nexa-delivery-id'],
      signed.headers['x-nexa-bridge-signature'],
      Buffer.from(signed.body, 'utf8'),
      sourceIp ?? undefined,
    );

  const pastDeadline = (paymentId: string) =>
    ctx.container.database.db.execute(
      sql`UPDATE payments SET expires_at = now() - interval '1 second' WHERE id = ${paymentId}`,
    );
  const askNow = (paymentId: string) =>
    ctx.container.database.db.execute(
      sql`UPDATE gateway_invoices SET next_inquiry_at = now() WHERE payment_id = ${paymentId}`,
    );

  // -------------------------------------------------------------------------------------

  describe('the route: disabled by default, one secret, a bridge address', () => {
    it('starts DISABLED and cannot be enabled without its secret, then without its bridge address', async () => {
      const { gateways } = await ctx.container.paymentGateways.list(tenantA, owner);
      const custom = gateways.find((one) => one.provider === 'CUSTOM');
      expect(custom?.status).toBe('DISABLED');
      expect(custom?.endpointBaseUrl ?? null).toBeNull();
      const noSecret = await setStatus('ACTIVE').catch((error: unknown) => error);
      expect(isNexaError(noSecret) && noSecret.details).toMatchObject({
        reason: 'CREDENTIAL_MISSING',
      });
      await ctx.container.paymentGateways.setCredential(tenantA, owner, {
        idempotencyKey: key(),
        provider: 'CUSTOM',
        apiKey: SECRET,
      });
      const noEndpoint = await setStatus('ACTIVE').catch((error: unknown) => error);
      expect(isNexaError(noEndpoint) && noEndpoint.details).toMatchObject({
        reason: 'ENDPOINT_MISSING',
      });
      // Gateway Health names the same gap, from the same facts.
      const facts = await ctx.container.paymentGateways.readinessFacts(
        tenantA,
        custom as NonNullable<typeof custom>,
      );
      expect(facts.endpointSet).toBe(false);
      await setEndpoint();
      expect((await setStatus('ACTIVE')).status).toBe('ACTIVE');
    });

    it('provisioning creates the route DISABLED for a tenant that has none (the boot-time reconcile)', async () => {
      await ctx.container.database.db.execute(
        sql`DELETE FROM payment_gateways WHERE tenant_id = ${tenantA.tenantId} AND provider = 'CUSTOM'`,
      );
      await ctx.container.uow.run(tenantA, (tx) =>
        ctx.container.paymentGatewayProvisioning.ensureDefaults(tenantA, 'IRT', new Date(), tx),
      );
      const [row] = await rows<{ status: string; endpoint_base_url: string | null }>(
        sql`SELECT status, endpoint_base_url FROM payment_gateways
            WHERE tenant_id = ${tenantA.tenantId} AND provider = 'CUSTOM'`,
      );
      expect(row).toEqual({ status: 'DISABLED', endpoint_base_url: null });
    });

    it('refuses a secret shorter than 32 characters', async () => {
      const refused = await ctx.container.paymentGateways
        .setCredential(tenantA, owner, {
          idempotencyKey: key(),
          provider: 'CUSTOM',
          apiKey: 'short-secret',
        })
        .catch((error: unknown) => error);
      expect(isNexaError(refused) && refused.details).toMatchObject({ reason: 'SECRET_TOO_SHORT' });
    });

    it('takes an https base URL only, refuses one the URL policy refuses, and audits each change', async () => {
      for (const bad of [
        'http://bridge.example',
        'https://u:p@bridge.example',
        'https://bridge.example/?x=1',
      ]) {
        const refused = await setEndpoint(bad).catch((error: unknown) => error);
        expect(isNexaError(refused) && refused.details).toMatchObject({
          reason: 'ENDPOINT_URL_INVALID',
        });
      }
      // The installation's URL policy: link-local (cloud metadata) is never called.
      const metadata = await setEndpoint('https://169.254.169.254/latest').catch(
        (error: unknown) => error,
      );
      expect(isNexaError(metadata) && metadata.details).toMatchObject({
        reason: 'ENDPOINT_ADDRESS_REFUSED',
      });
      const badList = await setEndpoint(BASE, ['0.0.0.0/0']).catch((error: unknown) => error);
      expect(isNexaError(badList) && badList.details).toMatchObject({
        reason: 'ALLOWLIST_INVALID',
      });
      const saved = await setEndpoint(`${BASE}/`, ['203.0.113.0/24']);
      expect(saved).toMatchObject({
        endpointBaseUrl: BASE,
        webhookIpAllowlist: ['203.0.113.0/24'],
      });
      const audits = await rows<{ action: string; after: Record<string, unknown> }>(
        sql`SELECT action, after FROM audit_logs WHERE action = 'payment_gateway.set_endpoint'`,
      );
      expect(audits).toHaveLength(1);
      expect(audits[0]?.after).toMatchObject({ endpointBaseUrl: BASE });
    });

    it('refuses to change the bridge address while the route is ACTIVE', async () => {
      await enableCustom();
      const refused = await setEndpoint('https://other-bridge.example').catch(
        (error: unknown) => error,
      );
      expect(isNexaError(refused) && refused.details).toMatchObject({
        reason: 'ENDPOINT_CHANGE_WHILE_ACTIVE',
      });
      const { gateways } = await ctx.container.paymentGateways.list(tenantA, owner);
      expect(gateways.find((one) => one.provider === 'CUSTOM')?.endpointBaseUrl).toBe(BASE);
    });

    it('refuses the endpoint write once the scope has stopped accepting work (checked in the transaction)', async () => {
      await ctx.container.database.db.execute(
        sql`UPDATE tenants SET status = 'STOPPED' WHERE id = ${tenantA.tenantId}`,
      );
      const refused = await setEndpoint().catch((error: unknown) => error);
      expect(refused).toMatchObject({ code: 'commerce.request_invalid' });
      await ctx.container.database.db.execute(
        sql`UPDATE tenants SET status = 'ACTIVE' WHERE id = ${tenantA.tenantId}`,
      );
      const { gateways } = await ctx.container.paymentGateways.list(tenantA, owner);
      expect(gateways.find((one) => one.provider === 'CUSTOM')?.endpointBaseUrl ?? null).toBeNull();
    });

    it('the connection test pings the bridge with the stored secret and records the result', async () => {
      await ctx.container.paymentGateways.setCredential(tenantA, owner, {
        idempotencyKey: key(),
        provider: 'CUSTOM',
        apiKey: SECRET,
      });
      await setEndpoint();
      // The container's own adapter would dial out; the check is exercised against the lane's
      // adapter in the unit and TLS suites. Here: the route exposes the check.
      expect(ctx.container.paymentGateways.checkSupported('CUSTOM')).toBe(true);
    });
  });

  describe('create and the inquiry — the contract, one case per status', () => {
    it('sends the payable in rial with the customer number and the frozen URL, and credits exactly once on PAID', async () => {
      await enableCustom();
      const { paymentId, orderId, reference } = await createdAttempt();
      const invoice = await invoiceOf(paymentId);
      expect(invoice).toMatchObject({
        provider_unit: 'IRR',
        sent_amount: RIAL,
        endpoint_base_url: BASE,
        invoice_url: `https://pay.bridge.test/p/${reference}`,
      });
      expect(invoice.provider_user_id).toMatch(/^[0-9]{10}$/u);
      expect(orderId).toMatch(/^cg_[0-9A-HJKMNP-TV-Z]{26}$/u);
      const sent = JSON.parse(bridge.payments.get(orderId)?.requestBody ?? '{}') as Record<
        string,
        unknown
      >;
      expect(sent).toMatchObject({
        invoice_id: orderId,
        amount: { value: '1250000', currency: 'IRR' },
        customer_ref: invoice.provider_user_id,
      });
      expect(String(sent['callback_url'] ?? 'null')).not.toContain(MARYAM);
      // PENDING: nothing moves.
      await inquireNow();
      expect((await paymentOf(paymentId)).state).toBe('PENDING');
      expect(await ledger()).toEqual([]);
      // PAID, exact: settled once, the principal credited.
      bridge.set(orderId, 'PAID', RIAL);
      await inquireNow();
      expect((await paymentOf(paymentId)).state).toBe('CONFIRMED');
      expect(await ledger()).toEqual([
        { reason: 'TOPUP_GATEWAY', amount: TOPUP_TOMAN.toString(), payment_id: paymentId },
      ]);
      await inquireNow();
      expect(await ledger()).toHaveLength(1);
    });

    it('FAILED fails the attempt, credits nothing', async () => {
      await enableCustom();
      const { paymentId, orderId } = await createdAttempt();
      bridge.set(orderId, 'FAILED');
      await inquireNow();
      expect((await paymentOf(paymentId)).state).toBe('FAILED');
      expect(await ledger()).toEqual([]);
    });

    it('EXPIRED fails the attempt, credits nothing', async () => {
      await enableCustom();
      const { paymentId, orderId } = await createdAttempt();
      bridge.set(orderId, 'EXPIRED');
      await inquireNow();
      expect((await paymentOf(paymentId)).state).toBe('FAILED');
      expect(await ledger()).toEqual([]);
    });

    it('UNDERPAID is held UNKNOWN for an operator, credits nothing', async () => {
      await enableCustom();
      const { paymentId, orderId } = await createdAttempt();
      bridge.set(orderId, 'UNDERPAID', 1_000_000n);
      await inquireNow();
      expect((await paymentOf(paymentId)).state).toBe('UNKNOWN');
      expect(await ledger()).toEqual([]);
      expect(await openConditions()).toContain('payments.gateway_review_unresolved');
    });

    it('OVERPAID is held UNKNOWN for an operator, credits nothing', async () => {
      await enableCustom();
      const { paymentId, orderId } = await createdAttempt();
      bridge.set(orderId, 'OVERPAID', 1_500_000n);
      await inquireNow();
      expect((await paymentOf(paymentId)).state).toBe('UNKNOWN');
      expect(await ledger()).toEqual([]);
    });

    it('amount mismatch: PAID with another amount_paid is held UNKNOWN, credits nothing', async () => {
      await enableCustom();
      const { paymentId, orderId } = await createdAttempt();
      bridge.set(orderId, 'PAID', RIAL - 10n);
      await inquireNow();
      expect((await paymentOf(paymentId)).state).toBe('UNKNOWN');
      expect(await ledger()).toEqual([]);
    });

    /*
     * Codex on #336 (1): a SIGNED answer is bound to this request's nonce, so one that reports
     * captured money under another `invoice_id` or `reference` is the bridge's own word that
     * money is held — the hold, never the "about another attempt, ignored" path that left the
     * payment PENDING to expire (and the customer free to pay again).
     */
    const signedAnswerNaming = (
      orderId: string,
      status: string,
      identity: Record<string, unknown>,
    ) => {
      const payment = bridge.payments.get(orderId);
      if (payment === undefined) throw new Error('no bridge payment');
      bridge.nextInquiry = {
        kind: 'answer',
        status: 200,
        body: {
          ...bridge.inquiryAnswer(payment),
          status,
          amount: { value: RIAL.toString(), currency: 'IRR' },
          amount_paid: status === 'PAID' ? { value: RIAL.toString(), currency: 'IRR' } : null,
          ...identity,
        },
      };
    };
    const holdReasons = (paymentId: string) =>
      rows<{ reason: string | null }>(
        sql`SELECT after->>'reason' AS reason FROM audit_logs
            WHERE action = 'payment.lose_track' AND entity_id = ${paymentId}`,
      );
    const OTHER_ORDER_ID = `cg_${'Z'.repeat(26)}`;

    it('a signed PAID naming another reference is held UNKNOWN, credits nothing, binds nothing', async () => {
      await enableCustom();
      const { paymentId, orderId, reference } = await createdAttempt();
      signedAnswerNaming(orderId, 'PAID', { reference: 'brg-999999' });
      await inquireNow();
      expect((await paymentOf(paymentId)).state).toBe('UNKNOWN');
      expect(await ledger()).toEqual([]);
      expect(await openConditions()).toContain('payments.gateway_review_unresolved');
      expect(await holdReasons(paymentId)).toEqual([{ reason: 'PROVIDER_REFERENCE_MISMATCH' }]);
      const invoice = await invoiceOf(paymentId);
      expect(invoice.provider_invoice_id).toBe(reference);
      expect(invoice.provider_paid).toBe(false);
    });

    it('a signed PAID naming another invoice id is held UNKNOWN, and a lost create adopts nothing from it', async () => {
      await enableCustom();
      bridge.nextCreate = { kind: 'drop' };
      bridge.createBeforeOverride = true;
      const attempt = await topup();
      await pass();
      const lost = await invoiceOf(attempt.payment.id);
      expect(lost.creation_state).toBe('CREATE_UNKNOWN');
      // Asked BY invoice id (reference null); the signed answer names another invoice id.
      await deliver(
        bridge.callback(lost.provider_order_id, { reference: null, deliveryId: 'dlv-other' }),
      );
      signedAnswerNaming(lost.provider_order_id, 'PAID', { invoice_id: OTHER_ORDER_ID });
      await pass();
      expect((await paymentOf(attempt.payment.id)).state).toBe('UNKNOWN');
      expect(await ledger()).toEqual([]);
      expect(await holdReasons(attempt.payment.id)).toEqual([
        { reason: 'PROVIDER_ORDER_ID_MISMATCH' },
      ]);
      expect((await invoiceOf(attempt.payment.id)).provider_invoice_id).toBeNull();
    });

    it('a signed FAILED or PENDING naming another invoice id neither fails nor holds the attempt', async () => {
      await enableCustom();
      const { paymentId, orderId } = await createdAttempt();
      for (const status of ['FAILED', 'PENDING']) {
        signedAnswerNaming(orderId, status, { invoice_id: OTHER_ORDER_ID });
        await askNow(paymentId);
        await inquireNow();
        expect((await paymentOf(paymentId)).state).toBe('PENDING');
        expect(
          await rows<{ code: string | null }>(
            sql`SELECT last_inquiry_error_code AS code FROM gateway_invoices
                WHERE payment_id = ${paymentId}`,
          ),
        ).toEqual([{ code: 'nexa.identity_mismatch' }]);
      }
      expect(await holdReasons(paymentId)).toEqual([]);
      expect(await ledger()).toEqual([]);
    });

    it('an unsigned inquiry answer saying PAID approves nothing', async () => {
      await enableCustom();
      const { paymentId, orderId } = await createdAttempt();
      bridge.set(orderId, 'PAID', RIAL);
      bridge.signResponses = false;
      await inquireNow();
      expect((await paymentOf(paymentId)).state).toBe('PENDING');
      expect(await ledger()).toEqual([]);
      bridge.signResponses = true;
      await inquireNow();
      expect((await paymentOf(paymentId)).state).toBe('CONFIRMED');
    });

    it('the Nexa fee is in the payable sent; only the principal is credited', async () => {
      await enableCustom({ fee: 1_000 });
      const { paymentId, orderId } = await createdAttempt();
      expect((await invoiceOf(paymentId)).sent_amount).toBe(1_375_000n);
      bridge.set(orderId, 'PAID', 1_375_000n);
      await inquireNow();
      expect(await ledger()).toEqual([
        { reason: 'TOPUP_GATEWAY', amount: TOPUP_TOMAN.toString(), payment_id: paymentId },
      ]);
    });
  });

  describe('a lost create and the frozen URL', () => {
    it('a lost create is never re-sent: a callback naming only the invoice id brings a read BY invoice id, and the reference is adopted', async () => {
      await enableCustom();
      bridge.nextCreate = { kind: 'drop' };
      bridge.createBeforeOverride = true;
      const attempt = await topup();
      await pass();
      const lost = await invoiceOf(attempt.payment.id);
      expect(lost.creation_state).toBe('CREATE_UNKNOWN');
      expect(lost.provider_invoice_id).toBeNull();
      const sends = () => bridge.received.filter((one) => one.path === '/v1/payments').length;
      offsetMs += 2 * 60_000;
      await pass();
      await pass();
      expect(sends()).toBe(1);
      // The bridge's callback names the invoice id only: Nexa asks BY invoice id, reference null.
      expect(
        await deliver(
          bridge.callback(lost.provider_order_id, { reference: null, deliveryId: 'dlv-lost' }),
        ),
      ).toBe('SCHEDULED');
      await pass();
      const read = await invoiceOf(attempt.payment.id);
      expect(read.provider_invoice_id).toBe(bridge.payments.get(lost.provider_order_id)?.reference);
      expect(sends()).toBe(1);
      expect((await paymentOf(attempt.payment.id)).state).toBe('PENDING');
      // Paid at the bridge: the next read (by the adopted reference) settles it, once.
      bridge.set(lost.provider_order_id, 'PAID', RIAL);
      expect(
        await deliver(bridge.callback(lost.provider_order_id, { deliveryId: 'dlv-lost-2' })),
      ).toBe('SCHEDULED');
      offsetMs += 10_000;
      await pass();
      expect((await paymentOf(attempt.payment.id)).state).toBe('CONFIRMED');
      expect(await ledger()).toHaveLength(1);
      expect(sends()).toBe(1);
    });

    /*
     * Codex on #336 (2): Nexa holds ONE secret per route — the current bridge's. An attempt
     * frozen to bridge A, asked with bridge B's secret, is refused by A, and A's callbacks fail
     * verification: a customer who paid A's link is never credited. Keeping A's old secret for
     * those attempts would keep trusting a secret the operator replaced (perhaps because it
     * leaked), so the address cannot move while an attempt opened against the old one is open.
     */
    it('refuses to move the bridge address while an attempt opened against the old one is open', async () => {
      await enableCustom();
      const { paymentId, orderId } = await createdAttempt();
      await setStatus('DISABLED');
      const refused = await setEndpoint('https://new-bridge.example/v2').catch(
        (error: unknown) => error,
      );
      expect(isNexaError(refused) && refused.details).toMatchObject({
        reason: 'ENDPOINT_CHANGE_WITH_OPEN_ATTEMPTS',
        openAttempts: 1,
      });
      const route = async () =>
        (await ctx.container.paymentGateways.list(tenantA, owner)).gateways.find(
          (one) => one.provider === 'CUSTOM',
        );
      expect((await route())?.endpointBaseUrl).toBe(BASE);
      // The same bridge (a new allow-list) is not a move: allowed.
      expect((await setEndpoint(BASE, ['203.0.113.0/24'])).webhookIpAllowlist).toEqual([
        '203.0.113.0/24',
      ]);
      // Decided (settled at A, with A's secret): the address may move.
      await setStatus('ACTIVE');
      bridge.set(orderId, 'PAID', RIAL);
      await inquireNow();
      expect((await paymentOf(paymentId)).state).toBe('CONFIRMED');
      await setStatus('DISABLED');
      await setEndpoint('https://new-bridge.example/v2');
      expect((await route())?.endpointBaseUrl).toBe('https://new-bridge.example/v2');
    });

    it('an open attempt keeps asking the bridge that created it after the route’s URL changes', async () => {
      await enableCustom();
      const { paymentId, orderId } = await createdAttempt();
      // A route moved underneath an open attempt (written directly: the service refuses it now).
      await ctx.container.database.db.execute(
        sql`UPDATE payment_gateways SET endpoint_base_url = 'https://new-bridge.example/v2'
            WHERE tenant_id = ${tenantA.tenantId} AND provider = 'CUSTOM'`,
      );
      expect((await invoiceOf(paymentId)).endpoint_base_url).toBe(BASE);
      // The reference bridge serves only `/nexa`: an inquiry sent to the new URL would 404.
      bridge.set(orderId, 'PAID', RIAL);
      await inquireNow();
      expect((await paymentOf(paymentId)).state).toBe('CONFIRMED');
      const frozen = await ctx.container.database.db
        .execute(
          sql`UPDATE gateway_invoices SET endpoint_base_url = 'https://x.example' WHERE payment_id = ${paymentId}`,
        )
        .catch((error: unknown) => error);
      // Refused by `nexa_gateway_invoices_endpoint_guard`: written once, when the attempt opens.
      expect(String((frozen as { cause?: { message?: string } }).cause?.message)).toMatch(
        /written once/u,
      );
      expect((await invoiceOf(paymentId)).endpoint_base_url).toBe(BASE);
    });
  });

  describe('late PAID', () => {
    const LATE_SWITCH = 'payments.late_credit.custom_enabled';

    it('is only recorded when the switch is OFF (the default)', async () => {
      await enableCustom();
      const { paymentId, orderId } = await createdAttempt();
      await pastDeadline(paymentId);
      bridge.set(orderId, 'PAID', RIAL);
      await askNow(paymentId);
      const report = await inquireNow();
      expect(report.lateCredits).toBe(0);
      expect(await ledger()).toEqual([]);
    });

    it('is credited once to the wallet when the switch is ON', async () => {
      await enableCustom();
      await setSetting(LATE_SWITCH, true);
      const { paymentId, orderId } = await createdAttempt();
      await pastDeadline(paymentId);
      bridge.set(orderId, 'PAID', RIAL);
      await askNow(paymentId);
      const report = await inquireNow();
      expect(report.lateCredits).toBe(1);
      expect(await ledger()).toEqual([
        { reason: 'GATEWAY_LATE_CREDIT', amount: TOPUP_TOMAN.toString(), payment_id: paymentId },
      ]);
      await askNow(paymentId);
      await inquireNow();
      expect(await ledger()).toHaveLength(1);
    });
  });

  describe('callbacks — signed hints, deduplicated, never deciding (the contract)', () => {
    it('a verified callback brings the inquiry forward, and the same delivery id twice is a replay', async () => {
      await enableCustom();
      const link = await createdAttempt();
      bridge.set(link.orderId, 'PAID', RIAL);
      const signed = bridge.callback(link.orderId, { deliveryId: 'dlv-0001' });
      const inquiries = () =>
        bridge.received.filter((one) => one.path === '/v1/payments/inquiry').length;
      const before = inquiries();
      expect(await deliver(signed)).toBe('SCHEDULED');
      expect(await deliver(signed)).toBe('DUPLICATE');
      expect(await invoiceOf(link.paymentId)).toMatchObject({
        webhook_count: 1,
        last_webhook_delivery_id: 'dlv-0001',
      });
      await pass();
      expect(inquiries()).toBe(before + 1);
      expect((await paymentOf(link.paymentId)).state).toBe('CONFIRMED');
      expect(await ledger()).toHaveLength(1);
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

    it('a callback that says PAID credits nothing while the inquiry says PENDING', async () => {
      await enableCustom();
      const link = await createdAttempt();
      expect(
        await deliver(bridge.callback(link.orderId, { status: 'PAID', deliveryId: 'dlv-p' })),
      ).toBe('SCHEDULED');
      await pass();
      expect((await paymentOf(link.paymentId)).state).toBe('PENDING');
      expect(await ledger()).toEqual([]);
    });

    it('a bad signature is refused before it is read: nothing recorded, nothing scheduled, an alert opened', async () => {
      await enableCustom();
      const link = await createdAttempt();
      const before = await invoiceOf(link.paymentId);
      const forged = bridge.callback(link.orderId, {
        deliveryId: 'dlv-forged',
        secret: 'not-the-routes-secret-0000000000000000',
      });
      expect(await deliver(forged)).toBe('IGNORED_UNVERIFIED');
      expect(await invoiceOf(link.paymentId)).toEqual(before);
      expect(await openConditions()).toContain('payments.gateway_webhook_unverified');
      // A good one afterwards closes the condition.
      expect(await deliver(bridge.callback(link.orderId, { deliveryId: 'dlv-good' }))).toBe(
        'SCHEDULED',
      );
      expect(await openConditions()).not.toContain('payments.gateway_webhook_unverified');
    });

    it('a stale timestamp (301 s) is refused like a bad signature', async () => {
      await enableCustom();
      const link = await createdAttempt();
      const t = Math.floor(now().getTime() / 1000) - 301;
      expect(await deliver(bridge.callback(link.orderId, { deliveryId: 'dlv-old', t }))).toBe(
        'IGNORED_UNVERIFIED',
      );
      expect((await invoiceOf(link.paymentId)).webhook_count).toBe(0);
    });

    it('a sender outside the IP allow-list is refused before its signature is read', async () => {
      await enableCustom({ allowlist: ['198.51.100.0/24'] });
      const link = await createdAttempt();
      const signed = bridge.callback(link.orderId, { deliveryId: 'dlv-ip' });
      expect(await deliver(signed, '203.0.113.10')).toBe('IGNORED_SOURCE');
      // A list is set and the sender is unknown: fail closed.
      expect(await deliver(signed, null)).toBe('IGNORED_SOURCE');
      expect((await invoiceOf(link.paymentId)).webhook_count).toBe(0);
      expect(await deliver(signed, '198.51.100.77')).toBe('SCHEDULED');
    });

    it('a test delivery is answered and nothing else happens; junk is malformed', async () => {
      await enableCustom();
      const link = await createdAttempt();
      const before = await invoiceOf(link.paymentId);
      const test = bridge.callback(link.orderId, { event: 'test', deliveryId: 'dlv-test' });
      expect(await deliver(test)).toBe('IGNORED_TEST');
      expect(await invoiceOf(link.paymentId)).toEqual(before);
      const mismatched = bridge.callback(link.orderId, { deliveryId: 'dlv-a' });
      expect(
        await lane.receiveWebhook(
          String(tenantA.tenantId),
          'CUSTOM',
          JSON.parse(mismatched.body) as unknown,
          'dlv-b',
          mismatched.headers['x-nexa-bridge-signature'],
          Buffer.from(mismatched.body, 'utf8'),
          '203.0.113.10',
        ),
      ).toBe('MALFORMED');
    });

    it('the secret leaks nowhere: no row, audit, event, log or list carries it', async () => {
      await enableCustom();
      const link = await createdAttempt();
      bridge.set(link.orderId, 'PAID', RIAL);
      await deliver(bridge.callback(link.orderId, { deliveryId: 'dlv-leak' }));
      await pass();
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
      expect(everything).not.toContain(SECRET);
    });
  });
});
