import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { money } from '@nexa/contracts';
import { DrizzleNightlyReportReader } from '../../apps/api/src/modules/commerce/ops-log/infrastructure/drizzle-nightly-report.reader';
import {
  grossOf,
  netOf,
  nightlyReports,
} from '../../apps/api/src/modules/commerce/ops-log/application/nightly-report';
import { i18nOpsLogWords } from '../../apps/api/src/modules/commerce/ops-log/infrastructure/i18n-ops-log-words';
import { createTestContext, tenantA, tenantB, type TestContext } from './harness';

/**
 * Round 4 PR-D (L27-L29) — the nightly reports' numbers, read from the ledger and the orders
 * by real SQL over one half-open Tehran day.
 *
 * The day is 1405/07/20 in Tehran: [2026-10-11T20:30:00Z, 2026-10-12T20:30:00Z). Every way a
 * figure lies is placed on it on purpose: an order one millisecond before the day, one exactly
 * on its end (the next day's), a trial, an imported order, another currency, another tenant's
 * order, a refund and a gift on the ledger, and a failed and an expired payment.
 *
 * MUTATION: `settled_at < end` written `<= end` -> the boundary test; the import filter
 * (`source = 'NEXA'`) dropped -> the provenance test; the ledger tally reading DEBIT as well
 * -> the ledger test.
 */

const START = new Date('2026-10-11T20:30:00Z');
const END = new Date('2026-10-12T20:30:00Z');
const PREVIOUS_START = new Date('2026-10-10T20:30:00Z');
const WINDOW = {
  start: START,
  end: END,
  previousStart: PREVIOUS_START,
  previousEnd: START,
  currency: 'IRT' as const,
  timezone: 'Asia/Tehran',
};
const at = (minutesFromStart: number): string =>
  new Date(START.getTime() + minutesFromStart * 60_000).toISOString();

describe('the nightly report reader', () => {
  let ctx: TestContext;
  let reader: DrizzleNightlyReportReader;
  let n = 0;
  const uuid = (): string => ctx.container.ids.uuid();
  const run = (query: ReturnType<typeof sql>) => ctx.container.database.db.execute(query);
  let panelA = '';
  let productA = '';
  let customerA = '';
  let customerB = '';

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 120_000);
  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    reader = new DrizzleNightlyReportReader(ctx.container.database.db);
    panelA = uuid();
    productA = uuid();
    await run(sql`INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelA}, ${tenantA.tenantId}, 'پنل ۱', 'sanaei', 'https://a.example.test', 'ACTIVE')`);
    await run(sql`INSERT INTO products (id, tenant_id, title, status, duration_days, traffic_bytes, panel_id, price_amount, price_currency)
      VALUES (${productA}, ${tenantA.tenantId}, 'Plan', 'ACTIVE', 30, 1073741824, ${panelA}, 100000, 'IRT')`);
    customerA = await customer(String(tenantA.tenantId), at(-600));
    customerB = await customer(String(tenantA.tenantId), at(-600));
  });

  async function customer(tenantId: string, createdAt: string): Promise<string> {
    const id = uuid();
    n += 1;
    await run(sql`INSERT INTO customers (id, tenant_id, telegram_user_id, first_name, created_at, first_seen_at)
      VALUES (${id}, ${tenantId}, ${`79000${String(n)}`}, ${`Customer${String(n)}`}, ${createdAt}::timestamptz, ${createdAt}::timestamptz)`);
    return id;
  }

  async function order(o: {
    customerId: string;
    purpose: 'NEW_SERVICE' | 'RENEW' | 'ADD_TRAFFIC' | 'ADD_TIME' | 'TRIAL';
    total: number;
    settledAt: string;
    currency?: string;
    imported?: boolean;
    tenantId?: string;
    panelId?: string;
    productId?: string;
  }): Promise<string> {
    const id = uuid();
    n += 1;
    await run(sql`INSERT INTO orders (id, tenant_id, customer_id, state, purpose, product_id, panel_id,
        line_title, line_duration_days, line_traffic_bytes, line_quantity, line_unit_price_amount,
        line_category_name, subtotal_amount, discount_amount, total_amount, currency, quote,
        confirmed_at, settled_at, created_at, source, source_ref)
      VALUES (${id}, ${o.tenantId ?? tenantA.tenantId}, ${o.customerId}, 'PAID', ${o.purpose},
        ${o.productId ?? productA}, ${o.panelId ?? panelA}, 'Plan',
        ${o.purpose === 'ADD_TRAFFIC' ? 0 : 30}, ${o.purpose === 'ADD_TIME' ? 0 : 1073741824}, 1, ${o.total},
        'دسته', ${o.total}, 0, ${o.total}, ${o.currency ?? 'IRT'}, '{}'::jsonb,
        ${o.settledAt}::timestamptz, ${o.settledAt}::timestamptz, ${o.settledAt}::timestamptz,
        ${o.imported === true ? 'MIRZA' : 'NEXA'}, ${o.imported === true ? `legacy-${String(n)}` : null})`);
    return id;
  }

  async function ledger(
    customerId: string,
    direction: 'CREDIT' | 'DEBIT',
    reason: string,
    amount: number,
    when: string,
  ) {
    n += 1;
    // A top-up gift names the payment it belongs to (a CHECK says so).
    let paymentId: string | null = null;
    if (reason === 'CASHBACK_TOPUP') {
      paymentId = uuid();
      await run(sql`INSERT INTO payments (id, tenant_id, customer_id, order_id, state, method, amount, currency,
          reference, evidence_kind, confirmed_at, resolved_at, created_at)
        VALUES (${paymentId}, ${tenantA.tenantId}, ${customerId}, NULL, 'CONFIRMED', 'MANUAL_TRANSFER', 20000, 'IRT',
          ${`NGT-${String(n)}`}, 'OPERATOR_REVIEW', ${when}::timestamptz, NULL, ${when}::timestamptz)`);
    }
    await run(sql`INSERT INTO wallet_entries (id, tenant_id, customer_id, direction, reason, amount, currency, reference, payment_id, created_at)
      VALUES (${uuid()}, ${tenantA.tenantId}, ${customerId}, ${direction}, ${reason}, ${amount}, 'IRT',
              ${`nightly-${String(n)}`}, ${paymentId}, ${when}::timestamptz)`);
  }

  const read = () => reader.read(tenantA, WINDOW, { tx: undefined } as never);

  it('counts an order on the half-open Tehran day: the first instant is in, the last millisecond is in, the end is out', async () => {
    await order({
      customerId: customerA,
      purpose: 'NEW_SERVICE',
      total: 100_000,
      settledAt: START.toISOString(),
    });
    await order({
      customerId: customerB,
      purpose: 'NEW_SERVICE',
      total: 70_000,
      settledAt: new Date(END.getTime() - 1).toISOString(),
    });
    // The next day's, and the day before's last millisecond (which is the PREVIOUS day's).
    await order({
      customerId: customerA,
      purpose: 'NEW_SERVICE',
      total: 5_000_000,
      settledAt: END.toISOString(),
    });
    await order({
      customerId: customerB,
      purpose: 'NEW_SERVICE',
      total: 30_000,
      settledAt: new Date(START.getTime() - 1).toISOString(),
    });

    const data = await read();
    expect(data.newPurchases).toEqual({ count: 2, sum: 170_000n });
    expect(data.previousGross).toBe(30_000n);
  });

  it('splits the day by what was bought, counts first purchases once per customer, and keeps a trial out of the sales', async () => {
    await order({
      customerId: customerA,
      purpose: 'NEW_SERVICE',
      total: 100_000,
      settledAt: at(60),
    });
    // customerA's second purchase of a service is NOT a first purchase; customerB's is.
    await order({
      customerId: customerA,
      purpose: 'NEW_SERVICE',
      total: 90_000,
      settledAt: at(120),
    });
    await order({
      customerId: customerB,
      purpose: 'NEW_SERVICE',
      total: 80_000,
      settledAt: at(130),
    });
    await order({ customerId: customerA, purpose: 'RENEW', total: 60_000, settledAt: at(200) });
    await order({
      customerId: customerA,
      purpose: 'ADD_TRAFFIC',
      total: 20_000,
      settledAt: at(210),
    });
    await order({ customerId: customerA, purpose: 'ADD_TIME', total: 10_000, settledAt: at(220) });
    await order({ customerId: customerB, purpose: 'TRIAL', total: 0, settledAt: at(230) });

    const data = await read();
    expect(data.newPurchases).toEqual({ count: 3, sum: 270_000n });
    expect(data.firstPurchases).toBe(2);
    expect(data.renewals).toEqual({ count: 1, sum: 60_000n });
    expect(data.traffic).toEqual({ count: 1, sum: 20_000n });
    expect(data.time).toEqual({ count: 1, sum: 10_000n });
    expect(grossOf(data)).toBe(360_000n);
    // The trial is counted as a trial, never summed into the sales.
    expect(data.trials).toBe(1);
  });

  it('never counts what the import wrote, another currency or another tenant', async () => {
    await order({
      customerId: customerA,
      purpose: 'NEW_SERVICE',
      total: 100_000,
      settledAt: at(60),
    });
    await order({
      customerId: customerB,
      purpose: 'NEW_SERVICE',
      total: 9_000_000,
      settledAt: at(61),
      imported: true,
    });
    await order({
      customerId: customerB,
      purpose: 'NEW_SERVICE',
      total: 8_000_000,
      settledAt: at(62),
      currency: 'IRR',
    });
    // Another tenant's own panel, product, customer and order.
    const panelB = uuid();
    const productB = uuid();
    await run(sql`INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelB}, ${tenantB.tenantId}, 'B', 'sanaei', 'https://b.example.test', 'ACTIVE')`);
    await run(sql`INSERT INTO products (id, tenant_id, title, status, duration_days, traffic_bytes, panel_id, price_amount, price_currency)
      VALUES (${productB}, ${tenantB.tenantId}, 'Plan', 'ACTIVE', 30, 1073741824, ${panelB}, 100000, 'IRT')`);
    const outsider = await customer(String(tenantB.tenantId), at(-600));
    await order({
      tenantId: String(tenantB.tenantId),
      customerId: outsider,
      purpose: 'NEW_SERVICE',
      total: 7_000_000,
      settledAt: at(63),
      panelId: panelB,
      productId: productB,
    });

    const data = await read();
    expect(data.newPurchases).toEqual({ count: 1, sum: 100_000n });
    expect(data.previousGross).toBe(0n);
    expect(data.panels.map((panel) => panel.name)).toEqual(['پنل ۱']);
  });

  /** A refund row of a payment of its own; `completedAt` null leaves it unfinished. */
  async function refund(o: {
    channel: 'WALLET_CREDIT' | 'EXTERNAL_MANUAL' | 'PROVIDER';
    amount: number;
    completedAt: string | null;
    currency?: string;
  }): Promise<void> {
    n += 1;
    const paymentId = uuid();
    await run(sql`INSERT INTO payments (id, tenant_id, customer_id, order_id, state, method, amount, currency,
        reference, evidence_kind, confirmed_at, resolved_at, created_at)
      VALUES (${paymentId}, ${tenantA.tenantId}, ${customerA}, NULL, 'CONFIRMED', 'MANUAL_TRANSFER', 900000,
        ${o.currency ?? 'IRT'}, ${`NRF-${String(n)}`}, 'OPERATOR_REVIEW', ${at(-60)}::timestamptz, NULL,
        ${at(-60)}::timestamptz)`);
    await run(sql`INSERT INTO refunds (id, tenant_id, payment_id, customer_id, state, channel, amount,
        currency, reason, completed_at, created_at)
      VALUES (${uuid()}, ${tenantA.tenantId}, ${paymentId}, ${customerA},
        ${o.completedAt === null ? 'AWAITING_EXTERNAL' : 'COMPLETED'}, ${o.channel}, ${o.amount},
        ${o.currency ?? 'IRT'}, 'بازگشت آزمایشی', ${o.completedAt}::timestamptz, ${at(-60)}::timestamptz)`);
  }

  it('counts every refund COMPLETED in the day once, on every channel, by its completion and currency', async () => {
    await refund({ channel: 'WALLET_CREDIT', amount: 5_000, completedAt: at(10) });
    await refund({ channel: 'EXTERNAL_MANUAL', amount: 7_000, completedAt: at(20) });
    await refund({ channel: 'PROVIDER', amount: 11_000, completedAt: at(30) });
    // Not the day's: unfinished, completed before it, completed at its end, another currency.
    await refund({ channel: 'EXTERNAL_MANUAL', amount: 99_000, completedAt: null });
    await refund({
      channel: 'WALLET_CREDIT',
      amount: 88_000,
      completedAt: new Date(START.getTime() - 1).toISOString(),
    });
    await refund({ channel: 'PROVIDER', amount: 77_000, completedAt: END.toISOString() });
    await refund({
      channel: 'EXTERNAL_MANUAL',
      amount: 66_000,
      completedAt: at(40),
      currency: 'USD',
    });
    // A wallet REFUND credit is the same refund as its row: it is never counted a second time.
    await ledger(customerA, 'CREDIT', 'REFUND', 5_000, at(10));

    const data = await read();
    expect(data.refunds).toEqual({ count: 3, sum: 23_000n });
  });

  it('counts commissions net of the day’s reversals, never below zero, and gifts as the day’s credits', async () => {
    await ledger(customerB, 'CREDIT', 'REFERRAL_COMMISSION', 3_000, at(30));
    await ledger(customerB, 'CREDIT', 'REFERRAL_COMMISSION', 4_000, at(31));
    await ledger(customerB, 'DEBIT', 'REFERRAL_COMMISSION_REVERSAL', 1_000, at(32));
    // A reversal outside the day is not this day's.
    await ledger(customerB, 'DEBIT', 'REFERRAL_COMMISSION_REVERSAL', 500, END.toISOString());
    await ledger(customerB, 'CREDIT', 'CASHBACK_TOPUP', 2_000, at(40));
    await ledger(customerB, 'CREDIT', 'CASHBACK_TOPUP', 9_000, END.toISOString());

    const data = await read();
    expect(data.commissions).toEqual({ count: 2, sum: 6_000n });
    expect(data.giftSum).toBe(2_000n);
    await refund({ channel: 'EXTERNAL_MANUAL', amount: 12_000, completedAt: at(50) });
    await order({
      customerId: customerA,
      purpose: 'NEW_SERVICE',
      total: 100_000,
      settledAt: at(60),
    });
    const withSales = await read();
    expect(netOf({ ...withSales, day: START })).toBe(100_000n - 12_000n - 6_000n - 2_000n);
  });

  it('floors the commissions at zero on a day of reversals only', async () => {
    await ledger(customerB, 'CREDIT', 'REFERRAL_COMMISSION', 1_000, at(30));
    await ledger(customerB, 'DEBIT', 'REFERRAL_COMMISSION_REVERSAL', 5_000, at(31));
    const data = await read();
    expect(data.commissions.sum).toBe(0n);
  });

  it('the panels’ sums add up to the gross: no import, no other currency, no trial, nothing outside the day', async () => {
    const panelB = uuid();
    await run(sql`INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelB}, ${tenantA.tenantId}, 'پنل ۲', 'sanaei', 'https://b2.example.test', 'ACTIVE')`);
    await order({
      customerId: customerA,
      purpose: 'NEW_SERVICE',
      total: 100_000,
      settledAt: at(60),
    });
    await order({
      customerId: customerA,
      purpose: 'RENEW',
      total: 60_000,
      settledAt: at(70),
      panelId: panelB,
    });
    await order({
      customerId: customerB,
      purpose: 'ADD_TRAFFIC',
      total: 20_000,
      settledAt: at(80),
      panelId: panelB,
    });
    // None of these is the day's sale, on either panel.
    await order({
      customerId: customerB,
      purpose: 'NEW_SERVICE',
      total: 9_000_000,
      settledAt: at(90),
      imported: true,
    });
    await order({
      customerId: customerB,
      purpose: 'NEW_SERVICE',
      total: 8_000,
      settledAt: at(91),
      currency: 'USD',
      panelId: panelB,
    });
    await order({ customerId: customerB, purpose: 'TRIAL', total: 0, settledAt: at(92) });
    await order({
      customerId: customerB,
      purpose: 'NEW_SERVICE',
      total: 7_000_000,
      settledAt: END.toISOString(),
    });
    await order({
      customerId: customerB,
      purpose: 'NEW_SERVICE',
      total: 6_000_000,
      settledAt: new Date(START.getTime() - 1).toISOString(),
      panelId: panelB,
    });

    const data = await read();
    const panelSum = data.panels.reduce((total, panel) => total + panel.sum, 0n);
    const panelOrders = data.panels.reduce((total, panel) => total + panel.orders, 0);
    expect(grossOf(data)).toBe(180_000n);
    expect(panelSum).toBe(grossOf(data));
    expect(panelOrders).toBe(3);
    expect(data.panels.find((panel) => panel.name === 'پنل ۲')).toMatchObject({
      orders: 2,
      sum: 80_000n,
    });
  });

  it('sums the resellers’ sales over EVERY reseller of the day, never over a capped list of them', async () => {
    const tier = uuid();
    await run(sql`INSERT INTO reseller_tiers (id, tenant_id, name, pricing_mode, credit_limit_currency)
      VALUES (${tier}, ${tenantA.tenantId}, 'سطح ۱', 'LIST_PRICE', 'IRT')`);
    // 1 001 resellers, each with one 1 000 order on the day, and one top reseller with 50 000.
    await run(sql`INSERT INTO customers (id, tenant_id, telegram_user_id, first_name, created_at, first_seen_at)
      SELECT gen_random_uuid(), ${tenantA.tenantId}, '88' || lpad(g::text, 6, '0'), 'R' || g,
             ${at(-600)}::timestamptz, ${at(-600)}::timestamptz
        FROM generate_series(1, 1002) AS g`);
    await run(sql`INSERT INTO orders (id, tenant_id, customer_id, state, purpose, product_id, panel_id,
        line_title, line_duration_days, line_traffic_bytes, line_quantity, line_unit_price_amount,
        line_category_name, subtotal_amount, discount_amount, total_amount, currency, quote,
        confirmed_at, settled_at, created_at)
      SELECT gen_random_uuid(), c.tenant_id, c.id, 'PAID', 'NEW_SERVICE', ${productA}, ${panelA}, 'Plan',
             30, 1073741824, 1, t.total, 'دسته', t.total, 0, t.total, 'IRT', '{}'::jsonb,
             ${at(60)}::timestamptz, ${at(60)}::timestamptz, ${at(60)}::timestamptz
        FROM customers c
        CROSS JOIN LATERAL (SELECT CASE WHEN c.telegram_user_id = '88001002' THEN 50000 ELSE 1000 END AS total) t
       WHERE c.tenant_id = ${tenantA.tenantId} AND c.telegram_user_id LIKE '88%'`);
    await run(sql`INSERT INTO order_reseller_terms (tenant_id, order_id, reseller_customer_id, tier_id,
        tier_name, layer, list_amount, cost_amount, promotion_amount, sale_amount, margin_amount, currency)
      SELECT o.tenant_id, o.id, o.customer_id, ${tier}, 'سطح ۱', 'LIST', o.total_amount, o.total_amount,
             0, o.total_amount, 0, 'IRT'
        FROM orders o JOIN customers c ON c.tenant_id = o.tenant_id AND c.id = o.customer_id
       WHERE o.tenant_id = ${tenantA.tenantId} AND c.telegram_user_id LIKE '88%'`);

    const data = await read();
    expect(data.resellers.salesSum).toBe(1_001n * 1_000n + 50_000n);
    expect(data.resellers.top).toMatchObject({ name: 'R1002', sum: 50_000n });
  }, 60_000);

  it('finds the best Tehran hour, the new customers, and the panel’s sold orders and gigabytes', async () => {
    // 00:30 Tehran (the first hour) sells less than 13:00 Tehran.
    await order({
      customerId: customerA,
      purpose: 'NEW_SERVICE',
      total: 40_000,
      settledAt: at(30),
    });
    await order({
      customerId: customerB,
      purpose: 'NEW_SERVICE',
      total: 90_000,
      settledAt: at(13 * 60 + 10),
    });
    await customer(String(tenantA.tenantId), at(100));
    await customer(String(tenantA.tenantId), END.toISOString());

    const data = await read();
    expect(data.bestHour).toBe(13);
    expect(data.newCustomers).toBe(1);
    expect(data.panels).toHaveLength(1);
    expect(data.panels[0]).toMatchObject({
      name: 'پنل ۱',
      orders: 2,
      sum: 130_000n,
      soldBytes: 2n * 1073741824n,
    });
  });

  it('renders all three reports from real figures without NaN, and a quiet day is a day', async () => {
    const quiet = await read();
    for (const built of nightlyReports({ ...quiet, day: START }, i18nOpsLogWords)) {
      expect(
        JSON.stringify(built.values, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
      ).not.toMatch(/NaN/);
    }
    await order({
      customerId: customerA,
      purpose: 'NEW_SERVICE',
      total: 100_000,
      settledAt: at(60),
    });
    const data = await read();
    const [summary] = nightlyReports({ ...data, day: START }, i18nOpsLogWords);
    expect(summary!.values['sales']).toEqual(money(100_000n, 'IRT'));
  });
});
