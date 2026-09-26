import { inflateRawSync } from 'node:zlib';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  AUTH_ROUTES,
  REPORT_ROUTES,
  SESSION_COOKIE_NAME,
  reportFailuresResponseSchema,
  reportInfrastructureResponseSchema,
  reportOrdersResponseSchema,
  reportPaymentsResponseSchema,
  reportProductsResponseSchema,
  reportReferralsResponseSchema,
  reportResellersResponseSchema,
  reportServicesResponseSchema,
  reportSummaryResponseSchema,
  reportTrendResponseSchema,
  reportWalletResponseSchema,
} from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { DrizzleReportingRepository } from '../../apps/api/src/modules/commerce/reporting/infrastructure/drizzle-reporting.repository';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import { createAdmin, migrateOnce, resetDatabase, tenantA, tenantB, testConfig } from './harness';

/**
 * WP12's business reports over real HTTP and real SQL (`docs/wp12-business-analytics-audit.md`).
 *
 * One Tehran business day is seeded by hand — 1405/06/10, which is 1 September 2026 and
 * begins at 2026-08-31T20:30Z — with every classic way a report double-counts or invents
 * money placed in it on purpose: an order with a failed attempt before its confirmed
 * one, a wallet top-up followed by a wallet purchase, cashback, a referral commission, a
 * signup gift, a discount, a pending order, a trial, a refunded order, a renamed product,
 * an order one second inside midnight and one exactly on it, and another tenant's sale.
 * Each figure below is derived from that list by hand; a query that counts wrongly gets a
 * different number.
 *
 * The range is CUSTOM on past dates, so the assertions do not move with the wall clock.
 */

const ORIGIN = 'https://admin.example.test';
const DAY = 86_400_000;
const GIB = 1_073_741_824n;
/** Local midnight of 1405/06/10 in Tehran. */
const D0 = Date.UTC(2026, 7, 31, 20, 30);
const at = (hours: number, minutes = 0, dayOffset = 0, seconds = 0): string =>
  new Date(D0 + dayOffset * DAY + ((hours * 60 + minutes) * 60 + seconds) * 1000).toISOString();
const DAY_D = 'range=CUSTOM&from=1405-06-10&to=1405-06-10';

describe('WP12 business reports', () => {
  let api: ApiApp;
  let ownerCookie: string;
  let financeCookie: string;
  let observerCookie: string;
  let foreignCookie: string;
  let n = 0;
  const uuid = (): string => api.container.ids.uuid();

  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);

  const get = (path: string, cookie: string | null = ownerCookie) =>
    inject({
      method: 'GET',
      url: `${API_PREFIX}${path}`,
      headers: cookie === null ? { origin: ORIGIN } : { cookie, origin: ORIGIN },
    });

  async function cookieFor(username: string): Promise<string> {
    const response = await inject({
      method: 'POST',
      url: `${API_PREFIX}${AUTH_ROUTES.login}`,
      headers: { origin: ORIGIN },
      payload: { username, password: `the-${username}-password` },
    });
    const match = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(
      String(response.headers['set-cookie'] ?? ''),
    );
    if (match === null) throw new Error(`No session cookie for ${username}: ${response.body}`);
    return `${SESSION_COOKIE_NAME}=${match[1] as string}`;
  }

  beforeAll(async () => {
    const config = testConfig({ WEB_ADMIN_ORIGINS: ORIGIN });
    await migrateOnce(config.DATABASE_URL);
    api = await createApiApp(config);
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  // --- Seed ------------------------------------------------------------------------

  const ids = {
    panel: '',
    p1: '',
    p2: '',
    c1: '',
    r1: '',
    r2: '',
    c9: '',
    b1: '',
    o1: '',
    o6: '',
  };

  const run = (query: ReturnType<typeof sql>) => api.container.database.db.execute(query);

  async function customer(tenantId: string, createdAt: string): Promise<string> {
    const id = uuid();
    n += 1;
    await run(sql`INSERT INTO customers (id, tenant_id, telegram_user_id, first_name, created_at, first_seen_at)
      VALUES (${id}, ${tenantId}, ${`77000${n}`}, ${`Customer${n}`}, ${createdAt}::timestamptz, ${createdAt}::timestamptz)`);
    return id;
  }

  async function product(tenantId: string, title: string, panelId: string): Promise<string> {
    const id = uuid();
    await run(sql`INSERT INTO products (id, tenant_id, title, status, duration_days, traffic_bytes, panel_id, price_amount, price_currency)
      VALUES (${id}, ${tenantId}, ${title}, 'ACTIVE', 30, ${String(50n * GIB)}::bigint, ${panelId}, 100000, 'IRT')`);
    return id;
  }

  async function order(o: {
    tenantId?: string;
    customerId: string;
    productId: string;
    purpose: 'NEW_SERVICE' | 'RENEW' | 'ADD_TRAFFIC' | 'ADD_TIME' | 'TRIAL';
    state?: 'PAID' | 'AWAITING_PAYMENT' | 'REFUNDED';
    title: string;
    subtotal: number;
    discount?: number;
    trafficBytes?: bigint;
    days?: number;
    settledAt?: string;
    refundedAt?: string;
    currency?: 'IRT' | 'IRR';
  }): Promise<string> {
    const id = uuid();
    const state = o.state ?? 'PAID';
    const discount = o.discount ?? 0;
    const bytes =
      o.trafficBytes ??
      (o.purpose === 'ADD_TIME' ? 0n : o.purpose === 'ADD_TRAFFIC' ? 10n * GIB : 50n * GIB);
    const days = o.days ?? (o.purpose === 'ADD_TRAFFIC' ? 0 : 30);
    const settled = state === 'AWAITING_PAYMENT' ? null : (o.settledAt ?? null);
    await run(sql`INSERT INTO orders (id, tenant_id, customer_id, state, purpose, product_id, panel_id,
        line_title, line_duration_days, line_traffic_bytes, line_quantity, line_unit_price_amount,
        line_category_name, subtotal_amount, discount_amount, total_amount, currency, quote,
        confirmed_at, settled_at, refunded_at, created_at)
      VALUES (${id}, ${o.tenantId ?? tenantA.tenantId}, ${o.customerId}, ${state}, ${o.purpose}, ${o.productId}, ${ids.panel},
        ${o.title}, ${days}, ${String(bytes)}::bigint, 1, ${o.subtotal},
        'دسته', ${o.subtotal}, ${discount}, ${o.subtotal - discount}, ${o.currency ?? 'IRT'}, '{}'::jsonb,
        ${o.settledAt ?? at(0)}::timestamptz, ${settled}::timestamptz, ${o.refundedAt ?? null}::timestamptz,
        ${o.settledAt ?? at(0)}::timestamptz)`);
    return id;
  }

  async function payment(p: {
    tenantId?: string;
    customerId: string;
    orderId: string | null;
    state: 'CONFIRMED' | 'FAILED' | 'PENDING';
    method: 'WALLET' | 'MANUAL_TRANSFER';
    amount: number;
    createdAt: string;
    doneAt?: string;
  }): Promise<string> {
    const id = uuid();
    n += 1;
    const confirmed = p.state === 'CONFIRMED';
    await run(sql`INSERT INTO payments (id, tenant_id, customer_id, order_id, state, method, amount, currency,
        reference, evidence_kind, confirmed_at, resolved_at, gateway_provider, created_at, expires_at)
      VALUES (${id}, ${p.tenantId ?? tenantA.tenantId}, ${p.customerId}, ${p.orderId}, ${p.state}, ${p.method}, ${p.amount}, 'IRT',
        ${`RPT-${n}`}, ${confirmed ? (p.method === 'WALLET' ? 'WALLET_DEBIT' : 'OPERATOR_REVIEW') : null},
        ${confirmed ? (p.doneAt ?? p.createdAt) : null}::timestamptz,
        ${p.state === 'FAILED' ? (p.doneAt ?? p.createdAt) : null}::timestamptz,
        ${p.method === 'MANUAL_TRANSFER' ? 'MANUAL_TRANSFER' : null},
        ${p.createdAt}::timestamptz, ${p.state === 'PENDING' ? at(23, 0, 3) : null}::timestamptz)`);
    return id;
  }

  async function entry(e: {
    tenantId?: string;
    customerId: string;
    direction: 'CREDIT' | 'DEBIT';
    reason: string;
    amount: number;
    orderId?: string | null;
    paymentId?: string | null;
    createdAt: string;
  }): Promise<void> {
    n += 1;
    await run(sql`INSERT INTO wallet_entries (id, tenant_id, customer_id, direction, reason, amount, currency,
        reference, order_id, payment_id, created_at)
      VALUES (${uuid()}, ${e.tenantId ?? tenantA.tenantId}, ${e.customerId}, ${e.direction}, ${e.reason}, ${e.amount}, 'IRT',
        ${`rpt-entry-${n}`}, ${e.orderId ?? null}, ${e.paymentId ?? null}, ${e.createdAt}::timestamptz)`);
  }

  async function service(
    orderId: string,
    customerId: string,
    productId: string,
    state: string,
    provisionedAt: string | null,
  ): Promise<string> {
    const id = uuid();
    n += 1;
    await run(sql`INSERT INTO services (id, tenant_id, customer_id, order_id, panel_id, product_id, state,
        provider_username, traffic_limit_bytes, provisioned_at, created_at)
      VALUES (${id}, ${tenantA.tenantId}, ${customerId}, ${orderId}, ${ids.panel}, ${productId}, ${state},
        ${`nxrpt${n}`}, ${String(50n * GIB)}::bigint, ${provisionedAt}::timestamptz, ${provisionedAt ?? at(0)}::timestamptz)`);
    return id;
  }

  beforeEach(async () => {
    await resetDatabase(api.container.database.db);
    await seed(api.container.database.db, api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);
    for (const [username, roleKeys, scope] of [
      ['owner', ['owner'], tenantA],
      ['finance', ['finance'], tenantA],
      ['observer', ['observer'], tenantA],
      ['foreign', ['owner'], tenantB],
    ] as const) {
      await createAdmin(api.container, scope, {
        username,
        password: `the-${username}-password`,
        roleKeys: [...roleKeys],
      });
    }
    ownerCookie = await cookieFor('owner');
    financeCookie = await cookieFor('finance');
    observerCookie = await cookieFor('observer');
    api.container.setInstallationTenant(tenantB.tenantId);
    foreignCookie = await cookieFor('foreign');
    api.container.setInstallationTenant(tenantA.tenantId);

    ids.panel = uuid();
    await run(sql`INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${ids.panel}, ${tenantA.tenantId}, 'Panel A', 'sanaei', 'https://a.example.test', 'ACTIVE')`);
    // Renamed AFTER its sales: the report must show the titles it was sold under.
    ids.p1 = await product(tenantA.tenantId, 'Plan Platinum', ids.panel);
    ids.p2 = await product(tenantA.tenantId, 'Plan B', ids.panel);

    ids.r1 = await customer(tenantA.tenantId, at(9, 0, -5));
    ids.c9 = await customer(tenantA.tenantId, at(9, 0, -1));
    ids.r2 = await customer(tenantA.tenantId, at(9, 0));
    ids.c1 = await customer(tenantA.tenantId, at(10, 0));

    // A sale with a FAILED attempt before its confirmed one, and a discount.
    ids.o1 = await order({
      customerId: ids.c1,
      productId: ids.p1,
      purpose: 'NEW_SERVICE',
      title: 'Plan A',
      subtotal: 100_000,
      discount: 20_000,
      settledAt: at(12),
    });
    await payment({
      customerId: ids.c1,
      orderId: ids.o1,
      state: 'FAILED',
      method: 'MANUAL_TRANSFER',
      amount: 80_000,
      createdAt: at(11),
      doneAt: at(11, 5),
    });
    const o1Paid = await payment({
      customerId: ids.c1,
      orderId: ids.o1,
      state: 'CONFIRMED',
      method: 'MANUAL_TRANSFER',
      amount: 80_000,
      createdAt: at(11, 30),
      doneAt: at(12),
    });
    void o1Paid;
    await service(ids.o1, ids.c1, ids.p1, 'ACTIVE', at(12, 5));

    // A top-up, then a renewal paid from the wallet: the renewal is revenue, the top-up is not.
    const topup = await payment({
      customerId: ids.c1,
      orderId: null,
      state: 'CONFIRMED',
      method: 'MANUAL_TRANSFER',
      amount: 60_000,
      createdAt: at(8),
    });
    await entry({
      customerId: ids.c1,
      direction: 'CREDIT',
      reason: 'TOPUP_RECEIPT',
      amount: 60_000,
      paymentId: topup,
      createdAt: at(8, 1),
    });
    const o2 = await order({
      customerId: ids.c1,
      productId: ids.p1,
      purpose: 'RENEW',
      title: 'Plan Gold',
      subtotal: 50_000,
      settledAt: at(13),
    });
    await payment({
      customerId: ids.c1,
      orderId: o2,
      state: 'CONFIRMED',
      method: 'WALLET',
      amount: 50_000,
      createdAt: at(13),
    });
    await entry({
      customerId: ids.c1,
      direction: 'DEBIT',
      reason: 'PURCHASE',
      amount: 50_000,
      orderId: o2,
      createdAt: at(13),
    });

    await order({
      customerId: ids.c1,
      productId: ids.p1,
      purpose: 'ADD_TRAFFIC',
      title: '10 GB',
      subtotal: 10_000,
      settledAt: at(14),
    });
    await order({
      customerId: ids.c1,
      productId: ids.p1,
      purpose: 'ADD_TIME',
      title: '30 days',
      subtotal: 5_000,
      settledAt: at(14, 30),
    });

    // Money given away: none of it is revenue.
    await entry({
      customerId: ids.c1,
      direction: 'CREDIT',
      reason: 'CASHBACK_PURCHASE',
      amount: 4_000,
      orderId: ids.o1,
      createdAt: at(15),
    });
    await entry({
      customerId: ids.r1,
      direction: 'CREDIT',
      reason: 'REFERRAL_COMMISSION',
      amount: 3_000,
      orderId: ids.o1,
      createdAt: at(15),
    });
    await entry({
      customerId: ids.c1,
      direction: 'CREDIT',
      reason: 'REFERRAL_SIGNUP_GIFT',
      amount: 2_000,
      createdAt: at(10, 2),
    });
    await entry({
      customerId: ids.r1,
      direction: 'CREDIT',
      reason: 'REFERRAL_SIGNUP_GIFT',
      amount: 2_000,
      createdAt: at(10, 2),
    });
    await run(sql`INSERT INTO referrals (id, tenant_id, referrer_id, referee_id, trigger, created_at)
      VALUES (${uuid()}, ${tenantA.tenantId}, ${ids.r1}, ${ids.c1}, 'ON_FIRST_PAID_ORDER', ${at(10, 1)}::timestamptz)`);

    // Not sales: a pending order, a free trial, a refunded order.
    const o5 = await order({
      customerId: ids.c1,
      productId: ids.p2,
      purpose: 'NEW_SERVICE',
      state: 'AWAITING_PAYMENT',
      title: 'Plan B',
      subtotal: 40_000,
      settledAt: at(18),
    });
    await payment({
      customerId: ids.c1,
      orderId: o5,
      state: 'PENDING',
      method: 'MANUAL_TRANSFER',
      amount: 40_000,
      createdAt: at(18),
    });
    const o6 = await order({
      customerId: ids.c1,
      productId: ids.p2,
      purpose: 'TRIAL',
      title: 'Trial',
      subtotal: 0,
      settledAt: at(9, 30),
    });
    ids.o6 = o6;
    await service(o6, ids.c1, ids.p2, 'ACTIVE', at(9, 31));
    await order({
      customerId: ids.c9,
      productId: ids.p2,
      purpose: 'NEW_SERVICE',
      state: 'REFUNDED',
      title: 'Plan B',
      subtotal: 40_000,
      settledAt: at(19),
      refundedAt: at(20),
    });

    // A reseller's purchase on credit.
    const tier = uuid();
    await run(sql`INSERT INTO reseller_tiers (id, tenant_id, name, pricing_mode, credit_limit_amount, credit_limit_currency)
      VALUES (${tier}, ${tenantA.tenantId}, 'Gold', 'LIST_PRICE', 100000, 'IRT')`);
    await run(sql`INSERT INTO resellers (id, tenant_id, customer_id, tier_id, credit_limit_amount, credit_limit_currency)
      VALUES (${uuid()}, ${tenantA.tenantId}, ${ids.r2}, ${tier}, 100000, 'IRT')`);
    const o10 = await order({
      customerId: ids.r2,
      productId: ids.p1,
      purpose: 'NEW_SERVICE',
      title: 'Plan A',
      subtotal: 30_000,
      trafficBytes: 0n,
      settledAt: at(16),
    });
    await run(sql`INSERT INTO order_reseller_terms (tenant_id, order_id, reseller_customer_id, tier_id, tier_name, layer,
        list_amount, cost_amount, promotion_amount, sale_amount, margin_amount, currency)
      VALUES (${tenantA.tenantId}, ${o10}, ${ids.r2}, ${tier}, 'Gold', 'LIST', 30000, 30000, 0, 30000, 0, 'IRT')`);
    await payment({
      customerId: ids.r2,
      orderId: o10,
      state: 'CONFIRMED',
      method: 'WALLET',
      amount: 30_000,
      createdAt: at(16),
    });
    await entry({
      customerId: ids.r2,
      direction: 'DEBIT',
      reason: 'PURCHASE',
      amount: 30_000,
      orderId: o10,
      createdAt: at(16),
    });
    await service(o10, ids.r2, ids.p1, 'ACTIVE', at(16, 5));

    // The midnight edges: one sale inside the last minute, one exactly on the next midnight.
    const o11 = await order({
      customerId: ids.c9,
      productId: ids.p2,
      purpose: 'NEW_SERVICE',
      title: 'Plan B',
      subtotal: 2_000,
      trafficBytes: 20n * GIB,
      settledAt: at(23, 58),
    });
    const s11 = await service(o11, ids.c9, ids.p2, 'PENDING_PROVISION', null);
    await run(sql`INSERT INTO provisioning_operations (id, tenant_id, operation_id, service_id, order_id, panel_id, type, state,
        attempts, failure_kind, completed_at)
      VALUES (${uuid()}, ${tenantA.tenantId}, ${uuid().replaceAll('-', '').slice(-16)}, ${s11}, ${o11}, ${ids.panel}, 'PROVISION', 'FAILED',
        1, 'PROVIDER_ERROR', ${at(23, 59, 0, 30)}::timestamptz)`);
    await order({
      customerId: ids.c9,
      productId: ids.p2,
      purpose: 'NEW_SERVICE',
      title: 'Plan B',
      subtotal: 1_000,
      settledAt: at(0, 0, 1),
    });

    // The previous day.
    await order({
      customerId: ids.c9,
      productId: ids.p2,
      purpose: 'NEW_SERVICE',
      title: 'Plan B',
      subtotal: 7_000,
      settledAt: at(15, 0, -1),
    });

    // Another tenant's sale, the same day.
    const bPanel = uuid();
    await run(sql`INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${bPanel}, ${tenantB.tenantId}, 'Panel B', 'sanaei', 'https://b.example.test', 'ACTIVE')`);
    const bProduct = await product(tenantB.tenantId, 'Foreign', bPanel);
    ids.b1 = await customer(tenantB.tenantId, at(9, 0));
    const saved = ids.panel;
    ids.panel = bPanel;
    await order({
      tenantId: tenantB.tenantId,
      customerId: ids.b1,
      productId: bProduct,
      purpose: 'NEW_SERVICE',
      title: 'Foreign',
      subtotal: 999_999,
      settledAt: at(12),
    });
    ids.panel = saved;
    await entry({
      tenantId: tenantB.tenantId,
      customerId: ids.b1,
      direction: 'CREDIT',
      reason: 'TOPUP_RECEIPT',
      amount: 5_555,
      paymentId: await payment({
        tenantId: tenantB.tenantId,
        customerId: ids.b1,
        orderId: null,
        state: 'CONFIRMED',
        method: 'MANUAL_TRANSFER',
        amount: 5_555,
        createdAt: at(8),
      }),
      createdAt: at(8),
    });
  });

  // --- Revenue and the double-counting guards ---------------------------------------

  it('counts each paid commercial order once, after discount, and nothing else as revenue', async () => {
    const response = await get(`${REPORT_ROUTES.summary}?${DAY_D}`);
    expect(response.statusCode).toBe(200);
    const body = reportSummaryResponseSchema.parse(response.json());

    // o1 80000 (after 20000 off) + o2 renewal 50000 + o3 10000 + o4 5000 + o10 30000 + o11 2000.
    // NOT: the 60000 top-up, the cashback, commission and gifts, the pending o5, the trial,
    // the refunded o7, the sale exactly on the next midnight, or tenant B's 999999.
    expect(body.sales.current).toBe(6);
    expect(body.revenue).toEqual([{ currency: 'IRT', current: '177000', previous: '7000' }]);
    expect(body.grossValue[0]?.current).toBe('197000');
    expect(body.discount[0]?.current).toBe('20000');
    // Sales plus the trial granted.
    expect(body.successfulOrders.current).toBe(7);
    expect(body.renewals).toEqual({ current: 1, previous: 0 });
    // The top-up is wallet inflow, reported beside revenue and never inside it.
    expect(body.walletTopup).toEqual([{ currency: 'IRT', current: '60000', previous: '0' }]);
    expect(body.walletTopupCount.current).toBe(1);
    // New users and new buyers are different people: r2 and c1 registered and bought on D;
    // c9 registered and first bought the day before.
    expect(body.newUsers).toEqual({ current: 2, previous: 1 });
    expect(body.newBuyers).toEqual({ current: 2, previous: 1 });
    expect(body.newServices.current).toBe(2);
    expect(body.newTrialServices.current).toBe(1);
    expect(body.activeServices).toBe(3);
    expect(body.period.timezone).toBe('Asia/Tehran');
    expect(body.period.current.start).toBe(new Date(D0).toISOString());
    expect(body.period.current.startLocal).toBe('1405/06/10');
  });

  it('puts a sale one second inside midnight in its day, and one on midnight in the next', async () => {
    const next = reportSummaryResponseSchema.parse(
      (await get(`${REPORT_ROUTES.summary}?range=CUSTOM&from=1405-06-11&to=1405-06-11`)).json(),
    );
    expect(next.sales.current).toBe(1);
    expect(next.revenue[0]?.current).toBe('1000');
  });

  it('keeps one tenant out of another tenant’s report', async () => {
    const body = reportSummaryResponseSchema.parse(
      (await get(`${REPORT_ROUTES.summary}?${DAY_D}`, foreignCookie)).json(),
    );
    expect(body.revenue).toEqual([{ currency: 'IRT', current: '999999', previous: '0' }]);
    expect(body.walletTopup[0]?.current).toBe('5555');
    expect(body.sales.current).toBe(1);
  });

  it('draws current and previous series on aligned hourly buckets, one currency', async () => {
    const body = reportTrendResponseSchema.parse(
      (await get(`${REPORT_ROUTES.trend}?${DAY_D}&metric=REVENUE`)).json(),
    );
    expect(body.period.granularity).toBe('HOUR');
    expect(body.current).toHaveLength(24);
    expect(body.previous).toHaveLength(24);
    expect(body.currency).toBe('IRT');
    const value = (series: typeof body.current, hour: number) => series[hour]?.value;
    expect(value(body.current, 12)).toBe('80000');
    expect(value(body.current, 14)).toBe('15000');
    expect(value(body.current, 23)).toBe('2000');
    expect(value(body.current, 0)).toBe('0');
    expect(value(body.previous, 15)).toBe('7000');
    // Aligned by hour of day, not by instant: bucket 15 of each side is 15:00 local.
    expect(body.previous[15]?.label).toBe(body.current[15]?.label);
    const total = body.current.reduce((sum, b) => sum + BigInt(b.value ?? '0'), 0n);
    expect(total).toBe(177_000n);
  });

  it('ranks products by the snapshot title they were sold under, by count and by revenue', async () => {
    const byCount = reportProductsResponseSchema.parse(
      (await get(`${REPORT_ROUTES.products}?${DAY_D}&by=COUNT`)).json(),
    );
    expect(byCount.rows.map((r) => [r.title, r.orders, r.revenue])).toEqual([
      ['Plan A', 2, '110000'],
      ['Plan Gold', 1, '50000'],
      ['Plan B', 1, '2000'],
    ]);
    // The product was renamed after the sales; its current title appears nowhere.
    expect(byCount.rows.some((r) => r.title === 'Plan Platinum')).toBe(false);
    expect(byCount.rows[0]?.productStatus).toBe('ACTIVE');
    const byRevenue = reportProductsResponseSchema.parse(
      (await get(`${REPORT_ROUTES.products}?${DAY_D}&by=REVENUE&limit=1&page=2`)).json(),
    );
    expect(byRevenue.totalRows).toBe(3);
    expect(byRevenue.rows.map((r) => [r.rank, r.title])).toEqual([[2, 'Plan Gold']]);
  });

  it('separates renewal, extra traffic and extra time, and counts metered traffic only', async () => {
    const body = reportServicesResponseSchema.parse(
      (await get(`${REPORT_ROUTES.services}?${DAY_D}`)).json(),
    );
    const op = (purpose: string) => body.operations.find((o) => o.purpose === purpose);
    expect(op('RENEW')?.orders.current).toBe(1);
    expect(op('ADD_TRAFFIC')?.orders.current).toBe(1);
    expect(op('ADD_TIME')?.orders.current).toBe(1);
    expect(op('ADD_TIME')?.revenue[0]?.current).toBe('5000');
    // o1 50 + o2 50 + o3 10 + o11 20 GiB; o10 is unlimited and counted apart, never as 0.
    expect(body.trafficSoldBytes).toBe(String(130n * GIB));
    expect(body.unlimitedTrafficLines).toBe(1);
    expect(body.states.find((s) => s.state === 'ACTIVE')?.count).toBe(3);
  });

  it('reports infrastructure as services, traffic and failures, with no money at all', async () => {
    const response = await get(`${REPORT_ROUTES.infrastructure}?${DAY_D}`);
    const body = reportInfrastructureResponseSchema.parse(response.json());
    expect(body.panels).toHaveLength(1);
    expect(body.panels[0]).toMatchObject({
      panelName: 'Panel A',
      servicesCreated: 3,
      activeServices: 3,
      trafficSoldBytes: String(130n * GIB),
      unlimitedTrafficLines: 1,
      provisioningFailures: 1,
    });
    expect(body.providers).toEqual([
      expect.objectContaining({ providerType: 'sanaei', servicesCreated: 3 }),
    ]);
    expect(body.locationSupported).toBe(false);
    expect(response.body).not.toMatch(/revenue|amount|currency/i);
  });

  it('gives each payment route attempts, outcomes and a success rate over decided attempts only', async () => {
    const body = reportPaymentsResponseSchema.parse(
      (await get(`${REPORT_ROUTES.payments}?${DAY_D}`)).json(),
    );
    const manualOrders = body.rows.find(
      (r) => r.method === 'MANUAL_TRANSFER' && r.kind === 'ORDER',
    );
    // FAILED + CONFIRMED + PENDING: the pending attempt is in neither term of the rate.
    expect(manualOrders).toMatchObject({
      attempts: 3,
      confirmed: 1,
      failed: 1,
      pending: 1,
      successRateBasisPoints: 5000,
    });
    expect(manualOrders?.provider).toBe('MANUAL_TRANSFER');
    expect(manualOrders?.confirmedAmount).toEqual([{ currency: 'IRT', amount: '80000' }]);
    const wallet = body.rows.find((r) => r.method === 'WALLET');
    expect(wallet).toMatchObject({
      confirmed: 2,
      confirmedAmount: [{ currency: 'IRT', amount: '80000' }],
    });
    expect(body.totals).toMatchObject({
      attempts: 6,
      confirmed: 4,
      failed: 1,
      pending: 1,
      successRateBasisPoints: 8000,
    });
  });

  it('keeps wallet inflow, gifts, cashback and spending apart, by reason code', async () => {
    const body = reportWalletResponseSchema.parse(
      (await get(`${REPORT_ROUTES.wallet}?${DAY_D}`)).json(),
    );
    const group = (g: string) => body.groups.find((x) => x.group === g);
    expect(group('TOPUP')).toMatchObject({ amount: '60000', entries: 1 });
    expect(group('SPENDING')).toMatchObject({ amount: '-80000', entries: 2 });
    expect(group('CASHBACK')?.amount).toBe('4000');
    expect(group('REFERRAL_COMMISSION')?.amount).toBe('3000');
    expect(group('GIFT')).toMatchObject({ amount: '4000', entries: 2 });
    // 60000 − 80000 + 4000 + 3000 + 4000, tenant A only.
    expect(body.balances).toEqual([{ currency: 'IRT', amount: '-9000' }]);
  });

  it('reports referral conversion, rewards from the ledger and revenue from orders', async () => {
    const body = reportReferralsResponseSchema.parse(
      (await get(`${REPORT_ROUTES.referrals}?${DAY_D}&by=REVENUE`)).json(),
    );
    expect(body.signups.current).toBe(1);
    expect(body.convertedBuyers).toBe(1);
    expect(body.conversionBasisPoints).toBe(10_000);
    expect(body.signupGifts).toEqual([{ currency: 'IRT', amount: '4000', entries: 2 }]);
    expect(body.commissions).toEqual([{ currency: 'IRT', amount: '3000', entries: 1 }]);
    // c1's sales on D: o1 + o2 + o3 + o4.
    expect(body.referredRevenue).toEqual([{ currency: 'IRT', amount: '145000' }]);
    expect(body.topReferrers.rows).toEqual([
      {
        rank: 1,
        referrerId: ids.r1,
        signups: 1,
        convertedBuyers: 1,
        revenue: [{ currency: 'IRT', amount: '145000' }],
        commission: [{ currency: 'IRT', amount: '3000' }],
      },
    ]);
  });

  it('keeps the referrer total on a page past the last referrer, never zero', async () => {
    const body = reportReferralsResponseSchema.parse(
      (await get(`${REPORT_ROUTES.referrals}?${DAY_D}&by=SIGNUPS&limit=1&page=2`)).json(),
    );
    expect(body.topReferrers.rows).toEqual([]);
    expect(body.topReferrers.totalRows).toBe(1);
  });

  it('reports reseller orders, sales, services and credit in use, and never margin or cost', async () => {
    const response = await get(`${REPORT_ROUTES.resellers}?${DAY_D}`);
    const body = reportResellersResponseSchema.parse(response.json());
    expect(body.rows).toEqual([
      expect.objectContaining({
        resellerCustomerId: ids.r2,
        tierName: 'Gold',
        orders: 1,
        sales: [{ currency: 'IRT', amount: '30000' }],
        services: 1,
        creditLimit: { amountMinor: '100000', currency: 'IRT' },
        creditInUse: { amountMinor: '30000', currency: 'IRT' },
      }),
    ]);
    expect(response.body).not.toMatch(/margin|cost|profit/i);
  });

  it('reports credit exactly as the credit card derives it: the tier limit, and debt in the selling currency', async () => {
    const credit = async () => {
      const body = reportResellersResponseSchema.parse(
        (await get(`${REPORT_ROUTES.resellers}?${DAY_D}`)).json(),
      );
      const row = body.rows.find((r) => r.resellerCustomerId === ids.r2);
      return { creditLimit: row?.creditLimit, creditInUse: row?.creditInUse };
    };
    // No limit of its own: the tier's applies, and the IRT debt is in use against it.
    await run(sql`UPDATE resellers SET credit_limit_amount = NULL, credit_limit_currency = NULL
      WHERE tenant_id = ${tenantA.tenantId} AND customer_id = ${ids.r2}`);
    expect(await credit()).toEqual({
      creditLimit: { amountMinor: '100000', currency: 'IRT' },
      creditInUse: { amountMinor: '30000', currency: 'IRT' },
    });
    // A limit in another currency grants no credit here, and the debt still shows — in the
    // currency it was run up in, never as zero in the limit's.
    await run(sql`UPDATE resellers SET credit_limit_amount = 50, credit_limit_currency = 'USD'
      WHERE tenant_id = ${tenantA.tenantId} AND customer_id = ${ids.r2}`);
    expect(await credit()).toEqual({
      creditLimit: { amountMinor: '50', currency: 'USD' },
      creditInUse: { amountMinor: '30000', currency: 'IRT' },
    });
  });

  it('summarises failures from structured state only', async () => {
    const body = reportFailuresResponseSchema.parse(
      (await get(`${REPORT_ROUTES.failures}?${DAY_D}`)).json(),
    );
    expect(body.payments.failed).toBe(1);
    expect(body.provisioning).toEqual({ failed: 1, abandoned: 0 });
    expect(body.byFailureKind).toEqual([{ failureKind: 'PROVIDER_ERROR', count: 1 }]);
    expect(body.ordersRefunded).toBe(1);
  });

  it('counts an active customer by active service or a recent sale, never by a top-up', async () => {
    const reports = new DrizzleReportingRepository(api.container.database.db);
    // c1 and r2 hold active services; c9 bought on D; a window without D drops c9.
    expect(await reports.activeCustomers(tenantA, new Date(D0), new Date(D0 + DAY))).toBe(3);
    expect(
      await reports.activeCustomers(tenantA, new Date(D0 - 10 * DAY), new Date(D0 - 5 * DAY)),
    ).toBe(2);
  });

  // --- Drill-down -------------------------------------------------------------------

  it('pages the orders drill-down by cursor without overlap, and names the confirmed payment', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string = `${REPORT_ROUTES.orders}?${DAY_D}&limit=3${cursor === null ? '' : `&cursor=${cursor}`}`;
      const page = reportOrdersResponseSchema.parse((await get(url)).json());
      seen.push(...page.rows.map((r) => r.orderId));
      const o1 = page.rows.find((r) => r.orderId === ids.o1);
      if (o1 !== undefined) {
        expect(o1).toMatchObject({
          paymentMethod: 'MANUAL_TRANSFER',
          subtotal: '100000',
          discount: '20000',
          total: '80000',
        });
      }
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(7);
    // Business records only: no Telegram id or name of the customer.
    const raw = (await get(`${REPORT_ROUTES.orders}?${DAY_D}`)).body;
    expect(raw).not.toMatch(/77000\d|Customer\d/);
  });

  // --- Authorization and validation --------------------------------------------------

  it('refuses every non-owner, even one holding reports.view and reports.export', async () => {
    for (const cookie of [financeCookie, observerCookie]) {
      for (const path of [
        `${REPORT_ROUTES.summary}?${DAY_D}`,
        `${REPORT_ROUTES.referrals}?${DAY_D}`,
        `${REPORT_ROUTES.export}?${DAY_D}&report=SALES&format=csv`,
      ]) {
        const response = await get(path, cookie);
        expect(response.statusCode, path).toBe(403);
        const error = (response.json() as { error: { kind: string; code: string } }).error;
        expect(error).toMatchObject({
          kind: 'PERMISSION_DENIED',
          code: 'platform.permission_denied',
        });
      }
    }
    // The owner-role refusal is recorded like any other denial, naming the role it lacked.
    const events = await api.container.database.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM operational_events
       WHERE code = 'access.permission_denied' AND context->>'requiredRole' = 'owner'`);
    expect(events.rows[0]?.n).toBeGreaterThan(0);
    expect((await get(`${REPORT_ROUTES.summary}?${DAY_D}`, null)).statusCode).toBe(401);
  });

  it('refuses a malformed range at the edge', async () => {
    for (const query of [
      'range=CUSTOM&from=1405-06-10',
      'range=TODAY&from=1405-06-10&to=1405-06-10',
      'range=CUSTOM&from=1405-07-31&to=1405-08-01',
      'range=CUSTOM&from=1405-06-10&to=1405-06-01',
      'range=CUSTOM&from=1400-01-01&to=1405-01-01',
      'range=ALL_TIME',
      'range=TODAY&range=YESTERDAY',
    ]) {
      expect((await get(`${REPORT_ROUTES.summary}?${query}`)).statusCode, query).toBe(400);
    }
  });

  // --- Export -------------------------------------------------------------------------

  it('exports the selected range as Persian-safe CSV with exact numbers and no personal data', async () => {
    const response = await get(`${REPORT_ROUTES.export}?${DAY_D}&report=SALES&format=csv`);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="nexa-sales-1405-06-10.csv"',
    );
    expect(response.headers['cache-control']).toBe('no-store');
    const bytes = response.rawPayload;
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = bytes.toString('utf8').slice(1);
    const lines = text.trimEnd().split('\r\n');
    expect(lines[0]).toContain('شناسه سفارش');
    // The six sales. The trial is a successful order but never a sale, so it has no row.
    expect(lines).toHaveLength(1 + 6);
    expect(text).not.toContain(ids.o6);
    const o1 = lines.find((line) => line.startsWith(ids.o1)) ?? '';
    expect(o1.split(',')).toEqual(
      expect.arrayContaining(['100000', '20000', '80000', 'IRT', 'MANUAL_TRANSFER']),
    );
    expect(o1).toContain('1405/06/10 12:00');
    expect(text).not.toMatch(/77000\d|Customer\d/);
    expect(text).not.toContain('Foreign');
  });

  it('exports every currency a referrer earned in, one row each, never only the sales currency', async () => {
    // A sale in the tenant's PREVIOUS sales currency, on the same day, by the same referee.
    await order({
      customerId: ids.c1,
      productId: ids.p1,
      purpose: 'NEW_SERVICE',
      title: 'Plan A (IRR)',
      subtotal: 500_000,
      settledAt: at(16),
      currency: 'IRR',
    });
    const response = await get(`${REPORT_ROUTES.export}?${DAY_D}&report=REFERRALS&format=csv`);
    expect(response.statusCode).toBe(200);
    const lines = response.rawPayload.toString('utf8').slice(1).trimEnd().split('\r\n');
    const r1 = lines.filter((line) => line.includes(ids.r1));
    expect(r1).toHaveLength(2);
    expect(r1.some((line) => line.split(',').includes('IRT') && line.includes('145000'))).toBe(
      true,
    );
    expect(r1.some((line) => line.split(',').includes('IRR') && line.includes('500000'))).toBe(
      true,
    );
  });

  it('exports XLSX with numeric money cells', async () => {
    const response = await get(
      `${REPORT_ROUTES.export}?range=CUSTOM&from=1405-06-01&to=1405-06-31&report=PAYMENTS&format=xlsx`,
    );
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="nexa-payments-1405-06-01-to-1405-06-31.xlsx"',
    );
    const files = unzip(response.rawPayload);
    expect(Object.keys(files).sort()).toEqual(
      [
        '[Content_Types].xml',
        '_rels/.rels',
        'xl/_rels/workbook.xml.rels',
        'xl/styles.xml',
        'xl/workbook.xml',
        'xl/worksheets/sheet1.xml',
      ].sort(),
    );
    const sheet = files['xl/worksheets/sheet1.xml'] ?? '';
    expect(sheet).toContain('rightToLeft="1"');
    expect(sheet).toMatch(/<c r="L\d+"><v>80000<\/v><\/c>/);
    expect(sheet).toContain('نرخ موفقیت');
    expect(files['xl/workbook.xml']).toContain('پرداخت‌ها');
  });
});

/** The entries of a ZIP, by walking its local headers — enough for the archive this suite writes. */
function unzip(buffer: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const size = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extra = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const start = offset + 30 + nameLength + extra;
    const data = buffer.subarray(start, start + size);
    out[name] = (method === 8 ? inflateRawSync(data) : data).toString('utf8');
    offset = start + size;
  }
  return out;
}
