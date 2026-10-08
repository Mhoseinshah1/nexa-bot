import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  AUTH_ROUTES,
  COMMERCE_ERROR_CODES,
  REFUND_REFUSAL_REASONS,
  REFUND_ROUTES,
  SESSION_COOKIE_NAME,
  paymentResponseSchema,
  refundListResponseSchema,
  type RefundRefusalReason,
} from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { SEED_IDS, seed } from '../../apps/api/src/infrastructure/persistence/seed';
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
  let ownerId = '';
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
    const owner = await createAdmin(api.container, tenantA, {
      username: 'owner',
      password: 'the-owner-password',
      roleKeys: ['owner'],
    });
    ownerId = owner.id;
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
    provider?: string;
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
        ${p.provider ?? (p.method === 'GATEWAY' ? 'NOWPAYMENTS' : p.method === 'MANUAL_TRANSFER' ? 'MANUAL_TRANSFER' : null)})`);
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
    // E4: the breakdown names the wallet debit and NO refund figure of its own — how much is
    // refundable is the ledger's answer alone (review of PR #247, F1).
    const detail = paymentResponseSchema.parse((await get(`/payments/${wallet}`)).json());
    expect(Object.keys(detail.payment.amounts ?? {}).filter((key) => /refund/iu.test(key))).toEqual(
      [],
    );
    expect(walletLedger.paidMinor).toBe('100000');
    expect(detail.payment.amounts?.walletDebit).toBe('100000');
    expect(detail.payment.amounts?.received).toBe('0');
  });

  /** The order a payment settled, read back for the fixtures below. */
  const orderOf = async (paymentId: string): Promise<string> =>
    (
      (await run(sql`SELECT order_id FROM payments WHERE id = ${paymentId}`)) as unknown as {
        rows: { order_id: string }[];
      }
    ).rows[0]?.order_id as string;

  /*
   * Read equals write, over EVERY refusal reason (review of PR #247, F6 and CX1/F3): for each
   * payment the ledger names a reason for, the write is refused with exactly 409
   * REFUND_NOT_PERMITTED and `details.reason` IS the ledger's reason — and writes nothing.
   */
  const reasons = {
    PAYMENT_NOT_SETTLED: () =>
      payment({ method: 'MANUAL_TRANSFER', state: 'PENDING', order: true }),
    CHANNEL_UNSUPPORTED: () => payment({ method: 'GATEWAY', state: 'CONFIRMED', order: true }),
    TOPUP_CREDITED_TO_WALLET: () =>
      payment({ method: 'MANUAL_TRANSFER', state: 'CONFIRMED', order: false }),
    // A refund row in another currency than its payment's: a row nothing in this code writes,
    // which the write path refuses — so the ledger must not call the payment refundable.
    CURRENCY_MISMATCH: async () => {
      const id = await payment({ method: 'WALLET', state: 'CONFIRMED', order: true });
      const customer = (
        (await run(sql`SELECT customer_id FROM payments WHERE id = ${id}`)) as unknown as {
          rows: { customer_id: string }[];
        }
      ).rows[0]?.customer_id as string;
      // One in the payment's own currency beside it: a witness that reads ONE of the
      // currencies (`min`, which is 'IRT' here) would miss the mixture.
      for (const currency of ['IRT', 'USD']) {
        await run(sql`INSERT INTO refunds (id, tenant_id, payment_id, customer_id, order_id, state,
            channel, amount, currency, reason, completed_at)
          VALUES (${uuid()}, ${tenantA.tenantId}, ${id}, ${customer}, ${await orderOf(id)},
            'COMPLETED', 'WALLET_CREDIT', 5, ${currency}, 'UNDELIVERABLE', now())`);
      }
      return id;
    },
    // The order's purchase operation is UNKNOWN: it may already have made the account.
    DELIVERY_IN_PROGRESS: async () => {
      const id = await payment({ method: 'WALLET', state: 'CONFIRMED', order: true });
      const orderId = await orderOf(id);
      const service = uuid();
      n += 1;
      await run(sql`INSERT INTO services (id, tenant_id, customer_id, order_id, panel_id, product_id,
          state, provider_username, traffic_limit_bytes)
        SELECT ${service}, tenant_id, customer_id, id, panel_id, product_id, 'PENDING_PROVISION',
          ${`nxtruth${n}`}, 1073741824 FROM orders WHERE id = ${orderId}`);
      await run(sql`INSERT INTO provisioning_operations (id, tenant_id, operation_id, service_id,
          order_id, panel_id, type, state, attempts)
        VALUES (${uuid()}, ${tenantA.tenantId}, ${uuid().replaceAll('-', '').slice(-16)}, ${service},
          ${orderId}, ${panelId}, 'PROVISION', 'UNKNOWN', 1)`);
      return id;
    },
  } satisfies Record<RefundRefusalReason, () => Promise<string>>;

  it('names every refusal reason, and the write refuses with exactly that reason (E3, F6)', async () => {
    expect(Object.keys(reasons).sort()).toEqual([...REFUND_REFUSAL_REASONS].sort());
    for (const [reason, make] of Object.entries(reasons)) {
      const id = await make();
      const read = await ledger(id);
      expect(read, reason).toMatchObject({ refundable: false, refusalReason: reason });
      const before = (
        (await run(
          sql`SELECT count(*)::int AS n FROM refunds WHERE payment_id = ${id}`,
        )) as unknown as {
          rows: { n: number }[];
        }
      ).rows[0]?.n;
      const response = await inject({
        method: 'POST',
        url: `${API_PREFIX}${REFUND_ROUTES.request(id)}`,
        headers: { cookie, origin: ORIGIN },
        payload: {
          idempotencyKey: `e3-refund-${reason.toLowerCase()}-01`,
          paymentId: id,
          amountMinor: '1000',
          reason: 'customer asked',
        },
      });
      expect(response.statusCode, `${reason}: ${response.body}`).toBe(409);
      const body = response.json() as {
        error: { code: string; details?: Record<string, unknown> };
      };
      expect(body.error.code, reason).toBe(COMMERCE_ERROR_CODES.REFUND_NOT_PERMITTED);
      expect(body.error.details?.['reason'], reason).toBe(read.refusalReason);
      const after = (
        (await run(
          sql`SELECT count(*)::int AS n FROM refunds WHERE payment_id = ${id}`,
        )) as unknown as {
          rows: { n: number }[];
        }
      ).rows[0]?.n;
      expect(after, reason).toBe(before);
    }
  });

  /*
   * The controller hands `paymentAmountsOf` what it read (review of PR #247, F5): whether a
   * payment is a top-up, a reviewer's receipt credit, and the attempt's fixed rate. Each is
   * asserted over HTTP, so a controller that drops one is caught where the unit tests of the
   * pure function cannot see it.
   */
  it('credits a confirmed top-up and a reviewer’s receipt credit as the server read them (E4, F5)', async () => {
    const topup = await payment({ method: 'MANUAL_TRANSFER', state: 'CONFIRMED', order: false });
    const topupAmounts = paymentResponseSchema.parse((await get(`/payments/${topup}`)).json())
      .payment.amounts;
    expect(topupAmounts).toMatchObject({ walletCredit: '100000', received: '100000' });

    const customerId = await customer();
    const failed = uuid();
    const entry = uuid();
    n += 1;
    await run(sql`INSERT INTO payments (id, tenant_id, customer_id, order_id, state, method, amount,
        currency, reference, resolved_at, resolved_by_admin_id, gateway_provider)
      VALUES (${failed}, ${tenantA.tenantId}, ${customerId}, NULL, 'FAILED', 'MANUAL_TRANSFER',
        100000, 'IRT', ${`E4-${n}`}, now(), ${ownerId}, 'MANUAL_TRANSFER')`);
    await run(sql`INSERT INTO wallet_entries (id, tenant_id, customer_id, direction, reason, amount,
        currency, reference, payment_id)
      VALUES (${entry}, ${tenantA.tenantId}, ${customerId}, 'CREDIT', 'RECEIPT_CREDIT', 90000, 'IRT',
        ${`e4-credit-${n}`}, ${failed})`);
    await run(sql`INSERT INTO receipt_credits (tenant_id, payment_id, amount, currency,
        wallet_entry_id, decided_by_admin_id, decided_at)
      VALUES (${tenantA.tenantId}, ${failed}, 90000, 'IRT', ${entry}, ${ownerId}, now())`);
    const failedAmounts = paymentResponseSchema.parse((await get(`/payments/${failed}`)).json())
      .payment.amounts;
    expect(failedAmounts).toMatchObject({ walletCredit: '90000', received: '0' });
  });

  it('names an operator’s fixed rate as the attempt froze it (E5, F5)', async () => {
    const id = await payment({
      method: 'GATEWAY',
      state: 'PENDING',
      order: true,
      provider: 'TELEGRAM_STARS',
    });
    const createdAt = new Date(Date.now() - 60_000);
    await run(sql`INSERT INTO gateway_invoices (payment_id, tenant_id, provider, provider_order_id,
        creation_state, provider_invoice_id, created_invoice_at, provider_unit, sent_amount,
        conversion_policy, conversion_rate_minor, bot_instance_id, created_at)
      VALUES (${id}, ${tenantA.tenantId}, 'TELEGRAM_STARS', '4000000002', 'CREATED', 'stars-e5-1',
        now(), 'XTR', 67, 'FIXED_RATE', 1500, ${SEED_IDS.botA1}, ${createdAt})`);
    const response = await get(`/payments/${id}`);
    expect(response.statusCode, response.body).toBe(200);
    expect(
      paymentResponseSchema.parse(response.json()).payment.gatewayInvoice?.rateProvenance,
    ).toEqual({
      authority: 'OPERATOR',
      policy: 'FIXED_RATE',
      rate: '1500',
      source: null,
      quoteId: null,
      policyVersion: null,
      quotedAt: null,
      fetchedAt: null,
      quoteState: null,
      frozenAt: createdAt.toISOString(),
    });
  });

  it('keeps an attempt’s rate provenance as frozen, whatever quote comes later (E5)', async () => {
    const id = await payment({ method: 'GATEWAY', state: 'PENDING', order: true });
    const createdAt = new Date(Date.now() - 60_000);
    const sourceAt = new Date(createdAt.getTime() - 2_000);
    const fetchedAt = new Date(createdAt.getTime() - 1_000);
    await run(sql`INSERT INTO gateway_invoices (payment_id, tenant_id, provider, provider_order_id,
        creation_state, provider_invoice_id, created_invoice_at, provider_unit, sent_amount,
        conversion_policy, fx_quote_id, fx_source, fx_base_asset, fx_quote_currency,
        fx_rate_mantissa, fx_rate_scale, fx_source_at, fx_fetched_at, fx_quote_state,
        fx_policy_version, fx_unit_ratio_mantissa, fx_unit_ratio_scale,
        fx_effective_rate_numerator, fx_effective_rate_denominator, created_at)
      VALUES (${id}, ${tenantA.tenantId}, 'NOWPAYMENTS', '4000000001', 'CREATED', 'np-e5-1', now(),
        'USD', 10, 'CENTRAL_FX', 'v1:NOBITEX:USDTIRT:103500e-0', 'NOBITEX', 'USDT', 'IRT',
        103500, 0, ${sourceAt}, ${fetchedAt},
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
      // The source's own time and our fetch time are two facts, each from its own column (F5).
      quotedAt: sourceAt.toISOString(),
      fetchedAt: fetchedAt.toISOString(),
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
