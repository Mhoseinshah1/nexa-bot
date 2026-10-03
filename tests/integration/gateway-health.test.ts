import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  GATEWAY_HEALTH_OPERATIONAL_CODES,
  PAYMENT_GATEWAY_PROVIDERS,
  gatewayHealthResponseSchema,
  isNexaError,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type GatewayConfigurationGap,
  type PaymentGatewayConfig,
  type PaymentGatewayProvider,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import { DrizzleGatewayHealthReader } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-gateway-health.reader';
import { toHealthView } from '../../apps/api/src/surfaces/web/payment-gateways.controller';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  SEED_IDS,
  tenantA,
  tenantB,
  type TestContext,
} from './harness';

/**
 * Gateway Health against a real PostgreSQL (program §11, `docs/gateway-health.md`).
 *
 * What this file defends: completeness is the enable refusals' own answer, per provider;
 * every figure comes from a recorded row (and a route with none reads as having none — no
 * invented rate, latency or availability); the window is half-open; no credential, secret or
 * key ever appears; another tenant's facts never do; and the payments facts need
 * `payments.view`.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const BOT_B = SEED_IDS.botB1 as BotInstanceId;
const API_KEY = 'health_api_key_that_must_never_leak_77aa';
const IPN_SECRET = 'health_ipn_secret_that_must_never_leak_88bb';
const VERIFY_KEY = 'health_verify_key_that_must_never_leak_99cc';

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

const system = (id: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'test',
  surface: 'TELEGRAM',
  correlationId: id as CorrelationId,
});

/** The enable refusal each first gap stands for (`PaymentGatewayService.setStatus`). */
const REFUSAL: Partial<Record<GatewayConfigurationGap, { reason: string; detail?: string }>> = {
  CREDENTIAL_MISSING: { reason: 'CREDENTIAL_MISSING' },
  WEBHOOK_SECRET_MISSING: { reason: 'WEBHOOK_SECRET_MISSING' },
  VERIFY_KEY_MISSING: { reason: 'VERIFY_KEY_MISSING' },
  RATE_MISSING: { reason: 'RATE_MISSING' },
  CENTRAL_FX_DISABLED: { reason: 'FX_UNAVAILABLE', detail: 'DISABLED' },
  UNIT_RATIO_MISSING: { reason: 'FX_UNAVAILABLE', detail: 'UNIT_RATIO_MISSING' },
};

describe('gateway health', () => {
  let ctx: TestContext;
  let owner: ActorContext;
  let customerA: UserId;
  let customerB: UserId;
  let seq = 0;
  const key = () => `gh-key-${String((seq += 1)).padStart(4, '0')}`;

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
      await createAdmin(ctx.container, tenantA, { username: 'owner-gh', roleKeys: ['owner'] }),
    );
    customerA = (
      await ctx.container.customers.resolveFromUpdate(tenantA, system('a'), {
        idempotencyKey: 'gh-a',
        telegramUserId: '7300001',
        from: { id: 7300001, first_name: 'سینا' },
        botInstanceId: BOT_A,
      })
    ).customer.id;
    customerB = (
      await ctx.container.customers.resolveFromUpdate(tenantB, system('b'), {
        idempotencyKey: 'gh-b',
        telegramUserId: '7300002',
        from: { id: 7300002, first_name: 'نگار' },
        botInstanceId: BOT_B,
      })
    ).customer.id;
  });

  const exec = (query: ReturnType<typeof sql>) => ctx.container.database.db.execute(query);
  const report = (actor: ActorContext = owner, scope: TenantContext = tenantA) =>
    ctx.container.gatewayHealth.report(scope, actor, {});
  const entryOf = async (provider: PaymentGatewayProvider, actor: ActorContext = owner) => {
    const found = (await report(actor)).gateways.find((g) => g.provider === provider);
    if (found === undefined) throw new Error(`no ${provider} route`);
    return found;
  };

  /** A gateway payment with its invoice, as the lane writes them. */
  async function attempt(options: {
    provider: 'TONPAYS' | 'CENTRALPAY';
    scope?: TenantContext;
    state?: 'PENDING' | 'UNKNOWN';
    createdAt?: Date;
    invoice?: Record<string, unknown>;
  }): Promise<string> {
    seq += 1;
    const scope = options.scope ?? tenantA;
    const id = ctx.container.ids.uuid();
    const createdAt = options.createdAt ?? new Date(Date.now() - 5 * 60_000);
    await exec(sql`INSERT INTO payments
      (id, tenant_id, customer_id, method, state, amount, currency, reference, expires_at,
       gateway_provider, created_at, updated_at)
      VALUES (${id}, ${scope.tenantId}, ${scope === tenantB ? customerB : customerA}, 'GATEWAY',
              ${options.state ?? 'PENDING'}, 250000, 'IRT', ${`gh-${String(seq)}`},
              ${new Date(createdAt.getTime() + 70 * 60_000)}, ${options.provider}, ${createdAt}, ${createdAt})`);
    const row: Record<string, unknown> = {
      payment_id: id,
      tenant_id: scope.tenantId,
      provider: options.provider,
      provider_order_id: String(3_000_000_000 + seq),
      creation_state: 'CREATED',
      provider_invoice_id: `ghinv-${String(seq)}`,
      created_invoice_at: createdAt,
      provider_unit: 'IRT',
      sent_amount: 250000,
      created_at: createdAt,
      ...(options.provider === 'CENTRALPAY'
        ? { provider_user_id: String(4_000_000_000 + seq) }
        : {}),
      ...options.invoice,
    };
    const columns = Object.keys(row);
    await exec(
      sql`INSERT INTO gateway_invoices (${sql.raw(columns.join(', '))}) VALUES (${sql.join(
        columns.map((column) => sql`${row[column]}`),
        sql`, `,
      )})`,
    );
    return id;
  }

  async function openCondition(scope: TenantContext, code: string, provider: string, suffix = '') {
    await ctx.container.opsLog.record(scope, {
      code,
      severity: 'ERROR',
      message: 'test condition',
      dedupeKey: `${code}:${provider}${suffix}`,
      context: { provider },
    });
  }

  // -----------------------------------------------------------------------------------

  it('reports each route’s gaps as the enable refusal would name them, and switches on exactly when none remain', async () => {
    const health = await report();
    expect(health.gateways.map((g) => g.provider).sort()).toEqual(
      [...PAYMENT_GATEWAY_PROVIDERS].sort(),
    );
    for (const gateway of health.gateways) {
      const enableGap = gateway.gaps.find((gap) => REFUSAL[gap] !== undefined);
      const outcome = await ctx.container.paymentGateways
        .setStatus(tenantA, owner, {
          idempotencyKey: key(),
          provider: gateway.provider,
          status: 'ACTIVE',
        })
        .then(
          () => null,
          (error: unknown) => error,
        );
      if (enableGap === undefined) {
        expect(outcome, `${gateway.provider} was refused with no gap reported`).toBeNull();
      } else {
        expect(isNexaError(outcome) && outcome.details, gateway.provider).toMatchObject(
          REFUSAL[enableGap] ?? {},
        );
      }
    }
    // The routes that need secrets name each one, in the order the enable checks them.
    const byProvider = new Map(health.gateways.map((g) => [g.provider, g.gaps]));
    expect(byProvider.get('TONPAYS')).toEqual(['CREDENTIAL_MISSING']);
    expect(byProvider.get('CENTRALPAY')).toEqual(['CREDENTIAL_MISSING', 'VERIFY_KEY_MISSING']);
    expect(byProvider.get('NOWPAYMENTS')).toEqual(
      expect.arrayContaining(['CREDENTIAL_MISSING', 'WEBHOOK_SECRET_MISSING']),
    );
  });

  it('clears a gap as each secret is set — never showing what was set', async () => {
    await ctx.container.paymentGateways.configure(tenantA, owner, {
      idempotencyKey: key(),
      provider: 'CENTRALPAY',
      config: OPEN_ROUTE,
    });
    await ctx.container.paymentGateways.setCredential(tenantA, owner, {
      idempotencyKey: key(),
      provider: 'CENTRALPAY',
      apiKey: API_KEY,
    });
    expect((await entryOf('CENTRALPAY')).gaps).toEqual(['VERIFY_KEY_MISSING']);
    await ctx.container.paymentGateways.setVerifyKey(tenantA, owner, {
      idempotencyKey: key(),
      provider: 'CENTRALPAY',
      verifyKey: VERIFY_KEY,
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
    const central = await entryOf('CENTRALPAY');
    expect(central.gaps).toEqual([]);
    expect(central.state).toBe('DISABLED');
    // CentralPay documents no read-only call; NOWPayments has `/v1/estimate`.
    expect(central.check.supported).toBe(false);
    expect((await entryOf('NOWPAYMENTS')).check.supported).toBe(true);
    expect((await entryOf('TONPAYS')).check.supported).toBe(false);

    const health = await report();
    const wire = JSON.stringify(
      gatewayHealthResponseSchema.parse({
        window: null,
        gateways: health.gateways.map(toHealthView),
        withheld: health.withheld,
        generatedAt: new Date().toISOString(),
      }),
    );
    for (const secret of [API_KEY, IPN_SECRET, VERIFY_KEY]) expect(wire).not.toContain(secret);
  });

  it('says nothing it has not recorded: a route with no history has no last answer, no rate, no latency', async () => {
    const tonpays = await entryOf('TONPAYS');
    expect(tonpays.recorded).toEqual({
      lastInvoiceCreatedAt: null,
      lastInquiryAnsweredAt: null,
      lastInquiryFailure: null,
      lastCreateFailure: null,
      attemptsInWindow: 0,
      attemptsWithProviderError: 0,
      callBudget: null,
      openConditions: [],
      lastReconciliation: null,
    });
    expect(tonpays.signals).toEqual([]);
    const view = JSON.stringify(toHealthView(tonpays)).toLowerCase();
    for (const word of ['latency', 'availability', 'uptime', 'percent', 'rate"']) {
      expect(view, word).not.toContain(word);
    }
  });

  it('reads the latest answers, the errored attempts and the queues from what the lane recorded', async () => {
    const answered = new Date(Date.now() - 60_000);
    await attempt({
      provider: 'TONPAYS',
      invoice: { provider_status: 'pending', provider_paid: false, last_inquiry_at: answered },
    });
    const failedAt = new Date(Date.now() - 30_000);
    await attempt({
      provider: 'TONPAYS',
      state: 'UNKNOWN',
      invoice: {
        provider_status: 'completed',
        provider_paid: true,
        last_inquiry_at: failedAt,
        last_inquiry_error_code: 'HTTP_503',
      },
    });
    const sentAt = new Date(Date.now() - 20_000);
    await attempt({
      provider: 'TONPAYS',
      invoice: {
        creation_state: 'CREATE_UNKNOWN',
        provider_invoice_id: null,
        created_invoice_at: null,
        creation_error_code: 'TIMEOUT',
        creation_sent_at: sentAt,
      },
    });
    await exec(sql`INSERT INTO payment_gateway_call_budgets (tenant_id, provider, window_started_at, used)
                   VALUES (${tenantA.tenantId}, 'TONPAYS', ${answered}, 7)`);

    const tonpays = await entryOf('TONPAYS');
    expect(tonpays.recorded.lastInquiryAnsweredAt).toEqual(answered);
    expect(tonpays.recorded.lastInquiryFailure).toEqual({ at: failedAt, code: 'HTTP_503' });
    expect(tonpays.recorded.lastCreateFailure).toEqual({
      at: sentAt,
      state: 'CREATE_UNKNOWN',
      code: 'TIMEOUT',
    });
    expect(tonpays.recorded.attemptsInWindow).toBe(3);
    expect(tonpays.recorded.attemptsWithProviderError).toBe(2);
    expect(tonpays.recorded.callBudget).toEqual({ windowStartedAt: answered, used: 7 });
    // The Payment Operations Center's own counts, by the same read model.
    expect(tonpays.queues).toMatchObject({ PENDING: 2, UNKNOWN: 1, PROVIDER_ERROR: 2 });
    const attention = await ctx.container.paymentAttention.counts(tenantA, null);
    expect(tonpays.queues).toEqual(
      attention.find((row) => row.gatewayProvider === 'TONPAYS')?.counts,
    );
    expect(tonpays.signals.map((s) => s.kind).sort()).toEqual(
      ['PAYMENTS_NEED_RECONCILIATION', 'PAYMENTS_UNKNOWN', 'PROVIDER_ERRORS'].sort(),
    );
  });

  it('bounds the attempt counts by a half-open window', async () => {
    const start = new Date('2026-09-01T00:00:00Z');
    const end = new Date('2026-09-02T00:00:00Z');
    await attempt({ provider: 'TONPAYS', createdAt: start });
    await attempt({ provider: 'TONPAYS', createdAt: new Date(end.getTime() - 1) });
    await attempt({ provider: 'TONPAYS', createdAt: end });
    await attempt({ provider: 'TONPAYS', createdAt: new Date(start.getTime() - 1) });
    const reader = new DrizzleGatewayHealthReader(ctx.container.database.db);
    expect((await reader.facts(tenantA, { start, end })).get('TONPAYS')?.attemptsInWindow).toBe(2);
    expect((await reader.facts(tenantA, null)).get('TONPAYS')?.attemptsInWindow).toBe(4);
  });

  it('raises a typed signal for each open gateway condition, and drops it when the condition recovers', async () => {
    await openCondition(tenantA, 'payments.gateway_misconfigured', 'TONPAYS');
    await openCondition(tenantA, 'payments.gateway_webhook_unverified', 'NOWPAYMENTS');
    // Not a gateway-health code: never a gateway signal.
    await openCondition(tenantA, 'payments.something_else', 'TONPAYS');

    const signals = await ctx.container.gatewayHealth.signals(tenantA, null);
    expect(signals.map((s) => s.key).sort()).toEqual([
      'NOWPAYMENTS:OPEN_CONDITION:payments.gateway_webhook_unverified',
      'TONPAYS:OPEN_CONDITION:payments.gateway_misconfigured',
    ]);
    for (const signal of signals) {
      expect(signal.category).toBe('PAYMENT_GATEWAY');
      expect(GATEWAY_HEALTH_OPERATIONAL_CODES).toContain(signal.opsCode);
    }
    await ctx.container.opsLog.record(tenantA, {
      code: 'payments.gateway_configured',
      severity: 'INFO',
      message: 'recovered',
      context: { provider: 'TONPAYS' },
      recoversCode: 'payments.gateway_misconfigured',
      recoversDedupeKey: 'payments.gateway_misconfigured:TONPAYS',
    });
    expect((await ctx.container.gatewayHealth.signals(tenantA, null)).map((s) => s.key)).toEqual([
      'NOWPAYMENTS:OPEN_CONDITION:payments.gateway_webhook_unverified',
    ]);
  });

  it('names the last reconciliation from the audit log', async () => {
    const unknown = await attempt({
      provider: 'TONPAYS',
      state: 'UNKNOWN',
      invoice: {
        provider_status: 'rejected',
        provider_paid: false,
        last_inquiry_at: new Date(Date.now() - 5 * 60_000),
      },
    });
    await ctx.container.payments.reconcileGatewayPayment(tenantA, owner, unknown, {
      to: 'FAILED',
      note: null,
      idempotencyKey: key(),
    });
    expect((await entryOf('TONPAYS')).recorded.lastReconciliation).toMatchObject({
      action: 'payment.reconcile_failed',
    });
  });

  it('never shows another tenant’s attempts, conditions or reconciliations', async () => {
    await attempt({
      provider: 'TONPAYS',
      scope: tenantB,
      invoice: {
        tenant_id: tenantB.tenantId,
        last_inquiry_at: new Date(),
        last_inquiry_error_code: 'HTTP_500',
      },
    });
    await openCondition(tenantB, 'payments.gateway_misconfigured', 'TONPAYS');
    const tonpays = await entryOf('TONPAYS');
    expect(tonpays.recorded.attemptsInWindow).toBe(0);
    expect(tonpays.recorded.lastInquiryFailure).toBeNull();
    expect(tonpays.recorded.openConditions).toEqual([]);
    expect(await ctx.container.gatewayHealth.signals(tenantA, null)).toEqual([]);
  });

  it('refuses without payments.gateways.view, and withholds the payments facts without payments.view', async () => {
    const support = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'support-gh', roleKeys: ['support'] }),
    );
    const refused = await report(support).then(
      () => null,
      (error: unknown) => error,
    );
    expect(isNexaError(refused) && refused.kind).toBe('PERMISSION_DENIED');

    await attempt({ provider: 'TONPAYS', state: 'UNKNOWN' });
    // The operator role reads the routes but not payments.
    const operator = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'operator-gh',
        roleKeys: ['operator'],
      }),
    );
    const health = await report(operator);
    expect(health.withheld).toEqual(['PAYMENTS']);
    const tonpays = health.gateways.find((g) => g.provider === 'TONPAYS');
    expect(tonpays?.queues).toBeNull();
    expect(tonpays?.recorded.lastReconciliation).toBeNull();
    expect(tonpays?.signals.map((s) => s.kind)).not.toContain('PAYMENTS_UNKNOWN');
    expect((await report()).withheld).toEqual([]);
  });
});
