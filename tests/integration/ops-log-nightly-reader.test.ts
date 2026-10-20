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

  async function ledger(customerId: string, direction: 'CREDIT' | 'DEBIT', reason: string, amount: number, when: string) {
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
    await order({ customerId: customerA, purpose: 'NEW_SERVICE', total: 100_000, settledAt: START.toISOString() });
    await order({ customerId: customerB, purpose: 'NEW_SERVICE', total: 70_000, settledAt: new Date(END.getTime() - 1).toISOString() });
    // The next day's, and the day before's last millisecond (which is the PREVIOUS day's).
    await order({ customerId: customerA, purpose: 'NEW_SERVICE', total: 5_000_000, settledAt: END.toISOString() });
    await order({ customerId: customerB, purpose: 'NEW_SERVICE', total: 30_000, settledAt: new Date(START.getTime() - 1).toISOString() });

    const data = await read();
    expect(data.newPurchases).toEqual({ count: 2, sum: 170_000n });
    expect(data.previousGross).toBe(30_000n);
  });

  it('splits the day by what was bought, counts first purchases once per customer, and keeps a trial out of the sales', async () => {
    await order({ customerId: customerA, purpose: 'NEW_SERVICE', total: 100_000, settledAt: at(60) });
    // customerA's second purchase of a service is NOT a first purchase; customerB's is.
    await order({ customerId: customerA, purpose: 'NEW_SERVICE', total: 90_000, settledAt: at(120) });
    await order({ customerId: customerB, purpose: 'NEW_SERVICE', total: 80_000, settledAt: at(130) });
    await order({ customerId: customerA, purpose: 'RENEW', total: 60_000, settledAt: at(200) });
    await order({ customerId: customerA, purpose: 'ADD_TRAFFIC', total: 20_000, settledAt: at(210) });
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
    await order({ customerId: customerA, purpose: 'NEW_SERVICE', total: 100_000, settledAt: at(60) });
    await order({ customerId: customerB, purpose: 'NEW_SERVICE', total: 9_000_000, settledAt: at(61), imported: true });
    await order({ customerId: customerB, purpose: 'NEW_SERVICE', total: 8_000_000, settledAt: at(62), currency: 'IRR' });
    // Another tenant's own panel, product, customer and order.
    const panelB = uuid();
    const productB = uuid();
    await run(sql`INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelB}, ${tenantB.tenantId}, 'B', 'sanaei', 'https://b.example.test', 'ACTIVE')`);
    await run(sql`INSERT INTO products (id, tenant_id, title, status, duration_days, traffic_bytes, panel_id, price_amount, price_currency)
      VALUES (${productB}, ${tenantB.tenantId}, 'Plan', 'ACTIVE', 30, 1073741824, ${panelB}, 100000, 'IRT')`);
    const outsider = await customer(String(tenantB.tenantId), at(-600));
    await order({ tenantId: String(tenantB.tenantId), customerId: outsider, purpose: 'NEW_SERVICE', total: 7_000_000, settledAt: at(63), panelId: panelB, productId: productB });

    const data = await read();
    expect(data.newPurchases).toEqual({ count: 1, sum: 100_000n });
    expect(data.previousGross).toBe(0n);
    expect(data.panels.map((panel) => panel.name)).toEqual(['پنل ۱']);
  });

  it('reads refunds, commissions and top-up gifts from the ledger — credits of the day only', async () => {
    await ledger(customerA, 'CREDIT', 'REFUND', 5_000, at(10));
    await ledger(customerA, 'CREDIT', 'REFUND', 7_000, at(20));
    await ledger(customerB, 'CREDIT', 'REFERRAL_COMMISSION', 3_000, at(30));
    await ledger(customerB, 'CREDIT', 'CASHBACK_TOPUP', 2_000, at(40));
    // A debit with the same reason, a credit before the day and one on its end: none count.
    await ledger(customerA, 'DEBIT', 'REFUND', 99_000, at(50));
    await ledger(customerA, 'CREDIT', 'REFUND', 88_000, new Date(START.getTime() - 1).toISOString());
    await ledger(customerA, 'CREDIT', 'REFUND', 77_000, END.toISOString());

    const data = await read();
    expect(data.refunds).toEqual({ count: 2, sum: 12_000n });
    expect(data.commissions).toEqual({ count: 1, sum: 3_000n });
    expect(data.giftSum).toBe(2_000n);
    await order({ customerId: customerA, purpose: 'NEW_SERVICE', total: 100_000, settledAt: at(60) });
    const withSales = await read();
    expect(netOf({ ...withSales, day: START })).toBe(100_000n - 12_000n - 3_000n - 2_000n);
  });

  it('finds the best Tehran hour, the new customers, and the panel’s sold orders and gigabytes', async () => {
    // 00:30 Tehran (the first hour) sells less than 13:00 Tehran.
    await order({ customerId: customerA, purpose: 'NEW_SERVICE', total: 40_000, settledAt: at(30) });
    await order({ customerId: customerB, purpose: 'NEW_SERVICE', total: 90_000, settledAt: at(13 * 60 + 10) });
    await customer(String(tenantA.tenantId), at(100));
    await customer(String(tenantA.tenantId), END.toISOString());

    const data = await read();
    expect(data.bestHour).toBe(13);
    expect(data.newCustomers).toBe(1);
    expect(data.panels).toHaveLength(1);
    expect(data.panels[0]).toMatchObject({ name: 'پنل ۱', orders: 2, sum: 130_000n, soldBytes: 2n * 1073741824n });
  });

  it('renders all three reports from real figures without NaN, and a quiet day is a day', async () => {
    const quiet = await read();
    for (const built of nightlyReports({ ...quiet, day: START }, i18nOpsLogWords)) {
      expect(JSON.stringify(built.values, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).not.toMatch(/NaN/);
    }
    await order({ customerId: customerA, purpose: 'NEW_SERVICE', total: 100_000, settledAt: at(60) });
    const data = await read();
    const [summary] = nightlyReports({ ...data, day: START }, i18nOpsLogWords);
    expect(summary!.values['sales']).toEqual(money(100_000n, 'IRT'));
  });
});
