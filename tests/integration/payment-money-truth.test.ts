import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  AUTH_ROUTES,
  REFUND_ROUTES,
  SESSION_COOKIE_NAME,
  paymentResponseSchema,
  refundListResponseSchema,
} from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import { createAdmin, migrateOnce, resetDatabase, tenantA, testConfig } from './harness';

/**
 * Roadmap E3 and E5 over real HTTP and real SQL (`docs/refund-audit.md`,
 * `docs/payment-fees-fx.md`).
 *
 * E3: the refund ledger says WHY a payment cannot be refunded — the same reason the write
 * path refuses with — for a gateway payment (no channel), a top-up (already on the wallet)
 * and an unsettled payment, and says nothing for a refundable wallet-funded order.
 *
 * E5: an attempt's rate provenance is its own frozen snapshot: a newer central quote changes
 * nothing it says, and the database refuses to rewrite the snapshot.
 */

const ORIGIN = 'https://admin.example.test';

describe('refund refusal reasons and rate provenance', () => {
  let api: ApiApp;
  let cookie: string;
  let n = 0;
  let panelId = '';
  let productId = '';
  const uuid = (): string => api.container.ids.uuid();
  const run = (query: ReturnType<typeof sql>) => api.container.database.db.execute(query);
  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);
  const get = (path: string) =>
    inject({ method: 'GET', url: `${API_PREFIX}${path}`, headers: { cookie, origin: ORIGIN } });

  beforeAll(async () => {
    const config = testConfig({ WEB_ADMIN_ORIGINS: ORIGIN });
    await migrateOnce(config.DATABASE_URL);
    api = await createApiApp(config);
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  beforeEach(async () => {
    await resetDatabase(api.container.database.db);
    await seed(api.container.database.db, api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);
    await createAdmin(api.container, tenantA, {
      username: 'owner',
      password: 'the-owner-password',
      roleKeys: ['owner'],
    });
    const response = await inject({
      method: 'POST',
      url: `${API_PREFIX}${AUTH_ROUTES.login}`,
      headers: { origin: ORIGIN },
      payload: { username: 'owner', password: 'the-owner-password' },
    });
    const match = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(
      String(response.headers['set-cookie'] ?? ''),
    );
    if (match === null) throw new Error(`No session cookie: ${response.body}`);
    cookie = `${SESSION_COOKIE_NAME}=${match[1] as string}`;
    panelId = uuid();
    await run(sql`INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelId}, ${tenantA.tenantId}, 'Panel A', 'sanaei', 'https://a.example.test', 'ACTIVE')`);
    productId = uuid();
    await run(sql`INSERT INTO products (id, tenant_id, title, status, duration_days, traffic_bytes, panel_id, price_amount, price_currency)
      VALUES (${productId}, ${tenantA.tenantId}, 'Plan', 'ACTIVE', 30, 1073741824, ${panelId}, 100000, 'IRT')`);
  });

  async function customer(): Promise<string> {
    const id = uuid();
    n += 1;
    await run(sql`INSERT INTO customers (id, tenant_id, telegram_user_id)
      VALUES (${id}, ${tenantA.tenantId}, ${`99100${n}`})`);
    return id;
  }

  /** A payment as a lane writes it. An order is created when `order` is true. */
  async function payment(p: {
    method: 'WALLET' | 'MANUAL_TRANSFER' | 'GATEWAY';
    state: 'CONFIRMED' | 'PENDING';
    order: boolean;
  }): Promise<string> {
    const customerId = await customer();
    let orderId: string | null = null;
    if (p.order) {
      orderId = uuid();
      const money = { amountMinor: '100000', currency: 'IRT' };
      const quote = {
        productId,
        quotedAt: new Date().toISOString(),
        currency: 'IRT',
        finalAmount: money,
        trace: [
          {
            step: 'BASE_PRICE',
            effect: 'REPLACES',
            ruleId: null,
            ruleLabel: 'Plan',
            amountBefore: money,
            amountAfter: money,
          },
        ],
      };
      await run(sql`INSERT INTO orders (id, tenant_id, customer_id, state, purpose, product_id,
          panel_id, line_title,
          line_duration_days, line_traffic_bytes, line_quantity, line_unit_price_amount,
          subtotal_amount, discount_amount, total_amount, currency, quote, confirmed_at,
          settled_at)
        VALUES (${orderId}, ${tenantA.tenantId}, ${customerId},
          ${p.state === 'CONFIRMED' ? 'PAID' : 'AWAITING_PAYMENT'}, 'NEW_SERVICE', ${productId},
          ${panelId}, 'Plan',
          30, 1073741824, 1, 100000, 100000, 0, 100000, 'IRT', ${JSON.stringify(quote)}::jsonb, now(),
          ${p.state === 'CONFIRMED' ? new Date() : null})`);
    }
    const id = uuid();
    n += 1;
    const confirmed = p.state === 'CONFIRMED';
    const evidence = !confirmed
      ? null
      : p.method === 'WALLET'
        ? 'WALLET_DEBIT'
        : p.method === 'GATEWAY'
          ? 'GATEWAY_INQUIRY'
          : 'OPERATOR_REVIEW';
    await run(sql`INSERT INTO payments (id, tenant_id, customer_id, order_id, state, method, amount,
        currency, reference, evidence_kind, confirmed_at, expires_at, gateway_provider)
      VALUES (${id}, ${tenantA.tenantId}, ${customerId}, ${orderId}, ${p.state}, ${p.method},
        100000, 'IRT', ${`E3-${n}`}, ${evidence}, ${confirmed ? new Date() : null},
        ${confirmed ? null : new Date(Date.now() + 3_600_000)},
        ${p.method === 'GATEWAY' ? 'NOWPAYMENTS' : p.method === 'MANUAL_TRANSFER' ? 'MANUAL_TRANSFER' : null})`);
    return id;
  }

  const ledger = async (paymentId: string) => {
    const response = await get(`/payments/${paymentId}/refunds`);
    expect(response.statusCode, response.body).toBe(200);
    return refundListResponseSchema.parse(response.json());
  };

  it('names why a payment cannot be refunded, and nothing for one that can (E3)', async () => {
    const gateway = await payment({ method: 'GATEWAY', state: 'CONFIRMED', order: true });
    const topup = await payment({ method: 'MANUAL_TRANSFER', state: 'CONFIRMED', order: false });
    const pending = await payment({ method: 'MANUAL_TRANSFER', state: 'PENDING', order: true });
    const wallet = await payment({ method: 'WALLET', state: 'CONFIRMED', order: true });

    expect(await ledger(gateway)).toMatchObject({
      refundable: false,
      refusalReason: 'CHANNEL_UNSUPPORTED',
    });
    expect(await ledger(topup)).toMatchObject({
      refundable: false,
      refusalReason: 'TOPUP_CREDITED_TO_WALLET',
    });
    expect(await ledger(pending)).toMatchObject({
      refundable: false,
      refusalReason: 'PAYMENT_NOT_SETTLED',
    });
    // A delivered wallet-funded order IS refundable by an operator, back to the wallet.
    const walletLedger = await ledger(wallet);
    expect(walletLedger).toMatchObject({ refundable: true, refusalReason: null });
    // E4: the refund ledger bounds by the same figure the payment's breakdown names.
    const detail = paymentResponseSchema.parse((await get(`/payments/${wallet}`)).json());
    expect(detail.payment.amounts?.refundCeiling).toBe(walletLedger.paidMinor);
    expect(detail.payment.amounts?.walletDebit).toBe('100000');
    expect(detail.payment.amounts?.received).toBe('0');
  });

  it('refuses the write for exactly the reason the ledger names (E3)', async () => {
    const gateway = await payment({ method: 'GATEWAY', state: 'CONFIRMED', order: true });
    const response = await inject({
      method: 'POST',
      url: `${API_PREFIX}${REFUND_ROUTES.request(gateway)}`,
      headers: { cookie, origin: ORIGIN },
      payload: {
        idempotencyKey: 'e3-refund-gateway-0001',
        paymentId: gateway,
        amountMinor: '1000',
        reason: 'customer asked',
      },
    });
    expect(response.statusCode, response.body).toBeGreaterThanOrEqual(400);
    const body = response.json() as { error: { details?: Record<string, unknown> } };
    expect(body.error.details?.['reason']).toBe((await ledger(gateway)).refusalReason);
    const refunds = (await run(
      sql`SELECT count(*)::int AS n FROM refunds WHERE payment_id = ${gateway}`,
    )) as unknown as { rows: { n: number }[] };
    expect(refunds.rows[0]?.n).toBe(0);
  });

  it('keeps an attempt’s rate provenance as frozen, whatever quote comes later (E5)', async () => {
    const id = await payment({ method: 'GATEWAY', state: 'PENDING', order: true });
    const createdAt = new Date(Date.now() - 60_000);
    await run(sql`INSERT INTO gateway_invoices (payment_id, tenant_id, provider, provider_order_id,
        creation_state, provider_invoice_id, created_invoice_at, provider_unit, sent_amount,
        conversion_policy, fx_quote_id, fx_source, fx_base_asset, fx_quote_currency,
        fx_rate_mantissa, fx_rate_scale, fx_source_at, fx_fetched_at, fx_quote_state,
        fx_policy_version, fx_unit_ratio_mantissa, fx_unit_ratio_scale,
        fx_effective_rate_numerator, fx_effective_rate_denominator, created_at)
      VALUES (${id}, ${tenantA.tenantId}, 'NOWPAYMENTS', '4000000001', 'CREATED', 'np-e5-1', now(),
        'USD', 10, 'CENTRAL_FX', 'v1:NOBITEX:USDTIRT:103500e-0', 'NOBITEX', 'USDT', 'IRT',
        103500, 0, ${new Date(createdAt.getTime() - 2_000)}, ${new Date(createdAt.getTime() - 1_000)},
        'FRESH', 1, 1, 0, 103500, 1, ${createdAt})`);

    const read = async () => {
      const response = await get(`/payments/${id}`);
      expect(response.statusCode, response.body).toBe(200);
      return paymentResponseSchema.parse(response.json()).payment.gatewayInvoice?.rateProvenance;
    };
    const before = await read();
    expect(before).toMatchObject({
      authority: 'MARKET',
      policy: 'CENTRAL_FX',
      source: 'NOBITEX',
      quoteId: 'v1:NOBITEX:USDTIRT:103500e-0',
      quoteState: 'FRESH',
      policyVersion: 1,
      frozenAt: createdAt.toISOString(),
    });
    expect(before?.rate).toMatch(/^103500(\.0+)?$/u);

    // A newer, very different central quote is stored: the attempt's provenance is unmoved.
    await run(sql`INSERT INTO fx_quotes (tenant_id, base_asset, quote_currency, source,
        rate_mantissa, rate_scale, fetched_at, quote_id, policy_version)
      VALUES (${tenantA.tenantId}, 'USDT', 'IRT', 'WALLEX', 999999, 0, now(), 'v1:WALLEX:new', 1)
      ON CONFLICT (tenant_id, base_asset, quote_currency) DO UPDATE
        SET rate_mantissa = 999999, source = 'WALLEX', quote_id = 'v1:WALLEX:new',
            fetched_at = now()`);
    expect(await read()).toEqual(before);

    // And the snapshot cannot be rewritten underneath it.
    await expect(
      run(sql`UPDATE gateway_invoices SET fx_rate_mantissa = 999999 WHERE payment_id = ${id}`),
    ).rejects.toThrow();
    expect(await read()).toEqual(before);
  });
});
