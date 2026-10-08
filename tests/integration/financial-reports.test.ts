import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  AUTH_ROUTES,
  REPORT_ROUTES,
  SESSION_COOKIE_NAME,
  reportFinancialResponseSchema,
  type FinancialLines,
  type ReportFinancialResponse,
} from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import { createAdmin, migrateOnce, resetDatabase, tenantA, tenantB, testConfig } from './harness';

/**
 * Phase E2 — the financial statement over real HTTP and real SQL (`docs/financial-reports.md`).
 *
 * Three Tehran business days, 1405/06/10–12 (2026-08-31T20:30Z onward), seeded by hand with
 * every way a financial report double counts placed in it on purpose:
 *
 *   day 1  a card top-up of 500 000, then a WALLET purchase of 300 000 (350 000 − 50 000);
 *          a receipt credited to a wallet (70 000) from a FAILED transfer; a USD crypto
 *          top-up of 12.34; a sale of 90 000 refunded on day 4, outside the range;
 *          a sale exactly at the range's first instant (40 000).
 *   day 2  a gateway sale of 200 000 with a 2 % customer fee (204 000 paid), refunded in full
 *          to the wallet, then a WALLET re-purchase of 150 000; a sale exactly on the day-2
 *          midnight (60 000), which is day 2 and never day 1.
 *   day 3  a transfer sale of 400 000; two PARTIAL refunds of it (100 000 paid out, 50 000 to
 *          the wallet); cashback 20 000 and a commission 10 000, both partly reversed; an
 *          account-transfer pair of 100 000; and a sale at the range's END instant, outside.
 *
 * Plus tenant B's sale inside the range, and an opening balance from before it. Every figure
 * below is worked out by hand from that list.
 */

const ORIGIN = 'https://admin.example.test';
const DAY = 86_400_000;
const D0 = Date.UTC(2026, 7, 31, 20, 30); // local midnight of 1405/06/10, Tehran
const at = (dayOffset: number, hours = 0, minutes = 0): string =>
  new Date(D0 + dayOffset * DAY + (hours * 60 + minutes) * 60_000).toISOString();
const RANGE = 'range=CUSTOM&from=1405-06-10&to=1405-06-12';

describe('Phase E2: the financial statement', () => {
  let api: ApiApp;
  let ownerCookie: string;
  let foreignCookie: string;
  let observerCookie: string;
  let n = 0;
  let ownerId = '';
  const ids = { panel: '', product: '', productB: '', c1: '', c2: '', b1: '', panelB: '' };
  const uuid = (): string => api.container.ids.uuid();
  const run = (query: ReturnType<typeof sql>) => api.container.database.db.execute(query);

  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);
  const get = (path: string, cookie: string = ownerCookie) =>
    inject({ method: 'GET', url: `${API_PREFIX}${path}`, headers: { cookie, origin: ORIGIN } });

  const financial = async (
    query: string,
    cookie = ownerCookie,
  ): Promise<ReportFinancialResponse> => {
    const response = await get(`${REPORT_ROUTES.financial}?${query}`, cookie);
    expect(response.statusCode, response.body).toBe(200);
    return reportFinancialResponseSchema.parse(response.json());
  };

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

  async function customer(tenantId: string): Promise<string> {
    const id = uuid();
    n += 1;
    await run(sql`INSERT INTO customers (id, tenant_id, telegram_user_id, created_at, first_seen_at)
      VALUES (${id}, ${tenantId}, ${`88000${n}`}, ${at(-30)}::timestamptz, ${at(-30)}::timestamptz)`);
    return id;
  }

  async function product(tenantId: string, title: string, panelId: string): Promise<string> {
    const id = uuid();
    await run(sql`INSERT INTO products (id, tenant_id, title, status, duration_days, traffic_bytes, panel_id, price_amount, price_currency)
      VALUES (${id}, ${tenantId}, ${title}, 'ACTIVE', 30, 53687091200, ${panelId}, 100000, 'IRT')`);
    return id;
  }

  /** A settled sale: PAID, or REFUNDED when `refundedAt` is given. */
  async function order(o: {
    tenantId?: string;
    customerId: string;
    productId?: string;
    panelId?: string;
    subtotal: number;
    discount?: number;
    settledAt: string;
    refundedAt?: string;
  }): Promise<string> {
    const id = uuid();
    const discount = o.discount ?? 0;
    const state = o.refundedAt === undefined ? 'PAID' : 'REFUNDED';
    await run(sql`INSERT INTO orders (id, tenant_id, customer_id, state, purpose, product_id, panel_id,
        line_title, line_duration_days, line_traffic_bytes, line_quantity, line_unit_price_amount,
        subtotal_amount, discount_amount, total_amount, currency, quote,
        confirmed_at, settled_at, refunded_at, created_at)
      VALUES (${id}, ${o.tenantId ?? tenantA.tenantId}, ${o.customerId}, ${state}, 'NEW_SERVICE',
        ${o.productId ?? ids.product}, ${o.panelId ?? ids.panel}, 'Plan Gold', 30, 53687091200, 1, ${o.subtotal},
        ${o.subtotal}, ${discount}, ${o.subtotal - discount}, 'IRT', '{}'::jsonb,
        ${o.settledAt}::timestamptz, ${o.settledAt}::timestamptz, ${o.refundedAt ?? null}::timestamptz,
        ${o.settledAt}::timestamptz)`);
    return id;
  }

  async function payment(p: {
    tenantId?: string;
    customerId: string;
    orderId: string | null;
    state?: 'CONFIRMED' | 'FAILED' | 'EXPIRED';
    method: 'WALLET' | 'MANUAL_TRANSFER' | 'GATEWAY';
    amount: number;
    currency?: string;
    at: string;
    feeBasisPoints?: number;
    resolvedByAdminId?: string;
  }): Promise<string> {
    const id = uuid();
    n += 1;
    const state = p.state ?? 'CONFIRMED';
    const confirmed = state === 'CONFIRMED';
    const fee =
      p.feeBasisPoints === undefined
        ? null
        : Math.floor((p.amount * p.feeBasisPoints + 5000) / 10000);
    const provider =
      p.method === 'MANUAL_TRANSFER'
        ? 'MANUAL_TRANSFER'
        : p.method === 'GATEWAY'
          ? 'TONPAYS'
          : null;
    const evidence = !confirmed
      ? null
      : p.method === 'WALLET'
        ? 'WALLET_DEBIT'
        : p.method === 'GATEWAY'
          ? 'GATEWAY_INQUIRY'
          : 'OPERATOR_REVIEW';
    await run(sql`INSERT INTO payments (id, tenant_id, customer_id, order_id, state, method, amount, currency,
        reference, evidence_kind, confirmed_at, resolved_at, resolved_by_admin_id, gateway_provider,
        created_at, customer_fee_basis_points, customer_fee_amount, payable_amount)
      VALUES (${id}, ${p.tenantId ?? tenantA.tenantId}, ${p.customerId}, ${p.orderId}, ${state}, ${p.method},
        ${p.amount}, ${p.currency ?? 'IRT'}, ${`FIN-${n}`}, ${evidence},
        ${confirmed ? p.at : null}::timestamptz, ${confirmed ? null : p.at}::timestamptz,
        ${p.resolvedByAdminId ?? null}, ${provider}, ${p.at}::timestamptz,
        ${p.feeBasisPoints ?? null}, ${fee}, ${fee === null ? null : p.amount + fee})`);
    return id;
  }

  async function entry(e: {
    tenantId?: string;
    customerId: string;
    direction: 'CREDIT' | 'DEBIT';
    reason: string;
    amount: number;
    currency?: string;
    orderId?: string | null;
    paymentId?: string | null;
    at: string;
  }): Promise<string> {
    n += 1;
    const id = uuid();
    await run(sql`INSERT INTO wallet_entries (id, tenant_id, customer_id, direction, reason, amount, currency,
        reference, order_id, payment_id, created_at)
      VALUES (${id}, ${e.tenantId ?? tenantA.tenantId}, ${e.customerId}, ${e.direction}, ${e.reason},
        ${e.amount}, ${e.currency ?? 'IRT'}, ${`fin-entry-${n}`}, ${e.orderId ?? null}, ${e.paymentId ?? null},
        ${e.at}::timestamptz)`);
    return id;
  }

  async function refund(r: {
    paymentId: string;
    orderId: string;
    customerId: string;
    amount: number;
    channel: 'WALLET_CREDIT' | 'EXTERNAL_MANUAL';
    at: string;
  }): Promise<void> {
    await run(sql`INSERT INTO refunds (id, tenant_id, payment_id, customer_id, order_id, state, channel,
        amount, currency, reason, completed_at, created_at)
      VALUES (${uuid()}, ${tenantA.tenantId}, ${r.paymentId}, ${r.customerId}, ${r.orderId}, 'COMPLETED',
        ${r.channel}, ${r.amount}, 'IRT', 'UNDELIVERABLE', ${r.at}::timestamptz, ${r.at}::timestamptz)`);
  }

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
    for (const [username, roleKeys, scope] of [
      ['owner', ['owner'], tenantA],
      ['observer', ['observer'], tenantA],
      ['foreign', ['owner'], tenantB],
    ] as const) {
      const admin = await createAdmin(api.container, scope, {
        username,
        password: `the-${username}-password`,
        roleKeys: [...roleKeys],
      });
      if (username === 'owner') ownerId = admin.id;
    }
    ownerCookie = await cookieFor('owner');
    observerCookie = await cookieFor('observer');
    api.container.setInstallationTenant(tenantB.tenantId);
    foreignCookie = await cookieFor('foreign');
    api.container.setInstallationTenant(tenantA.tenantId);

    ids.panel = uuid();
    ids.panelB = uuid();
    await run(sql`INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${ids.panel}, ${tenantA.tenantId}, 'Panel A', 'sanaei', 'https://a.example.test', 'ACTIVE'),
             (${ids.panelB}, ${tenantB.tenantId}, 'Panel B', 'sanaei', 'https://b.example.test', 'ACTIVE')`);
    ids.product = await product(tenantA.tenantId, 'Plan Gold', ids.panel);
    ids.productB = await product(tenantB.tenantId, 'Plan B', ids.panelB);
    ids.c1 = await customer(tenantA.tenantId);
    ids.c2 = await customer(tenantA.tenantId);
    ids.b1 = await customer(tenantB.tenantId);

    // Before the range: the opening balance (1 000).
    await entry({
      customerId: ids.c1,
      direction: 'CREDIT',
      reason: 'ADMIN_CREDIT',
      amount: 1_000,
      at: at(-1, 12),
    });

    // --- Day 1 -------------------------------------------------------------------
    // A card top-up of 500 000, then the wallet purchase that spends 300 000 of it.
    const topup = await payment({
      customerId: ids.c1,
      orderId: null,
      method: 'MANUAL_TRANSFER',
      amount: 500_000,
      at: at(0, 10),
    });
    await entry({
      customerId: ids.c1,
      direction: 'CREDIT',
      reason: 'TOPUP_RECEIPT',
      amount: 500_000,
      paymentId: topup,
      at: at(0, 10),
    });
    const o1 = await order({
      customerId: ids.c1,
      subtotal: 350_000,
      discount: 50_000,
      settledAt: at(0, 11),
    });
    const p1 = await payment({
      customerId: ids.c1,
      orderId: o1,
      method: 'WALLET',
      amount: 300_000,
      at: at(0, 11),
    });
    await entry({
      customerId: ids.c1,
      direction: 'DEBIT',
      reason: 'PURCHASE',
      amount: 300_000,
      orderId: o1,
      paymentId: p1,
      at: at(0, 11),
    });
    // A receipt credited to a wallet: the payment FAILED, the money arrived as a credit.
    const failed = await payment({
      customerId: ids.c2,
      orderId: null,
      state: 'FAILED',
      method: 'MANUAL_TRANSFER',
      amount: 70_000,
      at: at(0, 12),
      resolvedByAdminId: ownerId,
    });
    const credit = await entry({
      customerId: ids.c2,
      direction: 'CREDIT',
      reason: 'RECEIPT_CREDIT',
      amount: 70_000,
      paymentId: failed,
      at: at(0, 12),
    });
    // ...with the reviewer's disposition row, as the receipt lane writes it beside the entry.
    await run(sql`INSERT INTO receipt_credits (tenant_id, payment_id, amount, currency,
        wallet_entry_id, decided_by_admin_id, decided_at)
      VALUES (${tenantA.tenantId}, ${failed}, 70000, 'IRT', ${credit}, ${ownerId},
        ${at(0, 12)}::timestamptz)`);
    // A USD crypto top-up: its own currency, never added to Toman.
    const usd = await payment({
      customerId: ids.c2,
      orderId: null,
      method: 'GATEWAY',
      amount: 1_234,
      currency: 'USD',
      at: at(0, 13),
    });
    await entry({
      customerId: ids.c2,
      direction: 'CREDIT',
      reason: 'TOPUP_CRYPTO',
      amount: 1_234,
      currency: 'USD',
      paymentId: usd,
      at: at(0, 13),
    });
    // A sale refunded on day 4: a sale on day 1, a refund outside the range.
    const o5 = await order({
      customerId: ids.c2,
      subtotal: 90_000,
      settledAt: at(0, 14),
      refundedAt: at(3, 9),
    });
    const p5 = await payment({
      customerId: ids.c2,
      orderId: o5,
      method: 'MANUAL_TRANSFER',
      amount: 90_000,
      at: at(0, 14),
    });
    await refund({
      paymentId: p5,
      orderId: o5,
      customerId: ids.c2,
      amount: 90_000,
      channel: 'WALLET_CREDIT',
      at: at(3, 9),
    });
    await entry({
      customerId: ids.c2,
      direction: 'CREDIT',
      reason: 'REFUND',
      amount: 90_000,
      orderId: o5,
      paymentId: p5,
      at: at(3, 9),
    });
    // Exactly at the first instant of the range: inside, day 1.
    const oEdge = await order({ customerId: ids.c2, subtotal: 40_000, settledAt: at(0) });
    await payment({
      customerId: ids.c2,
      orderId: oEdge,
      method: 'MANUAL_TRANSFER',
      amount: 40_000,
      at: at(0),
    });

    // --- Day 2 -------------------------------------------------------------------
    // A gateway sale with a 2 % customer fee, refunded in full to the wallet...
    const o2 = await order({
      customerId: ids.c1,
      subtotal: 200_000,
      settledAt: at(1, 9),
      refundedAt: at(1, 10),
    });
    const p2 = await payment({
      customerId: ids.c1,
      orderId: o2,
      method: 'GATEWAY',
      amount: 200_000,
      at: at(1, 9),
      feeBasisPoints: 200,
    });
    await refund({
      paymentId: p2,
      orderId: o2,
      customerId: ids.c1,
      amount: 200_000,
      channel: 'WALLET_CREDIT',
      at: at(1, 10),
    });
    await entry({
      customerId: ids.c1,
      direction: 'CREDIT',
      reason: 'REFUND',
      amount: 200_000,
      orderId: o2,
      paymentId: p2,
      at: at(1, 10),
    });
    // ...and the wallet re-purchase that spends part of the refund.
    const o3 = await order({ customerId: ids.c1, subtotal: 150_000, settledAt: at(1, 12) });
    const p3 = await payment({
      customerId: ids.c1,
      orderId: o3,
      method: 'WALLET',
      amount: 150_000,
      at: at(1, 12),
    });
    await entry({
      customerId: ids.c1,
      direction: 'DEBIT',
      reason: 'PURCHASE',
      amount: 150_000,
      orderId: o3,
      paymentId: p3,
      at: at(1, 12),
    });
    // Exactly on the day-2 midnight: day 2, never day 1.
    const oMid = await order({ customerId: ids.c2, subtotal: 60_000, settledAt: at(1) });
    await payment({
      customerId: ids.c2,
      orderId: oMid,
      method: 'MANUAL_TRANSFER',
      amount: 60_000,
      at: at(1),
    });

    // A gateway top-up attempt that EXPIRED and was approved by the provider afterwards: a
    // LATE_COMPLETION settles nothing, so it is in no cash or wallet line (PR #247 F2).
    const late = await payment({
      customerId: ids.c2,
      orderId: null,
      state: 'EXPIRED',
      method: 'GATEWAY',
      amount: 55_000,
      at: at(1, 14),
    });
    await run(sql`INSERT INTO gateway_invoices (payment_id, tenant_id, provider, provider_order_id,
        creation_state, provider_invoice_id, created_invoice_at, provider_unit, sent_amount,
        provider_status, provider_paid, outcome, outcome_at, late_completion_observed_at, created_at)
      VALUES (${late}, ${tenantA.tenantId}, 'TONPAYS', '3900000001', 'CREATED', 'fin-late-1',
        ${at(1, 14)}::timestamptz, 'IRT', 55000, 'completed', true, 'LATE_COMPLETION',
        ${at(1, 15)}::timestamptz, ${at(1, 15)}::timestamptz, ${at(1, 14)}::timestamptz)`);
    // --- Day 3 -------------------------------------------------------------------
    const o4 = await order({ customerId: ids.c1, subtotal: 400_000, settledAt: at(2, 9) });
    const p4 = await payment({
      customerId: ids.c1,
      orderId: o4,
      method: 'MANUAL_TRANSFER',
      amount: 400_000,
      at: at(2, 9),
    });
    await entry({
      customerId: ids.c1,
      direction: 'CREDIT',
      reason: 'CASHBACK_PURCHASE',
      amount: 20_000,
      orderId: o4,
      at: at(2, 9),
    });
    await entry({
      customerId: ids.c2,
      direction: 'CREDIT',
      reason: 'REFERRAL_COMMISSION',
      amount: 10_000,
      orderId: o4,
      at: at(2, 9),
    });
    // Two partial refunds; the order stays PAID.
    await refund({
      paymentId: p4,
      orderId: o4,
      customerId: ids.c1,
      amount: 100_000,
      channel: 'EXTERNAL_MANUAL',
      at: at(2, 10),
    });
    await entry({
      customerId: ids.c1,
      direction: 'DEBIT',
      reason: 'CASHBACK_REVERSAL',
      amount: 5_000,
      orderId: o4,
      at: at(2, 10),
    });
    await entry({
      customerId: ids.c2,
      direction: 'DEBIT',
      reason: 'REFERRAL_COMMISSION_REVERSAL',
      amount: 2_500,
      orderId: o4,
      at: at(2, 10),
    });
    await refund({
      paymentId: p4,
      orderId: o4,
      customerId: ids.c1,
      amount: 50_000,
      channel: 'WALLET_CREDIT',
      at: at(2, 11),
    });
    await entry({
      customerId: ids.c1,
      direction: 'CREDIT',
      reason: 'REFUND',
      amount: 50_000,
      orderId: o4,
      paymentId: p4,
      at: at(2, 11),
    });
    await entry({
      customerId: ids.c1,
      direction: 'DEBIT',
      reason: 'CASHBACK_REVERSAL',
      amount: 2_500,
      orderId: o4,
      at: at(2, 11),
    });
    await entry({
      customerId: ids.c2,
      direction: 'DEBIT',
      reason: 'REFERRAL_COMMISSION_REVERSAL',
      amount: 1_250,
      orderId: o4,
      at: at(2, 11),
    });
    // An account transfer: a pair that nets to zero.
    await entry({
      customerId: ids.c1,
      direction: 'DEBIT',
      reason: 'ACCOUNT_TRANSFER_OUT',
      amount: 100_000,
      at: at(2, 15),
    });
    await entry({
      customerId: ids.c2,
      direction: 'CREDIT',
      reason: 'ACCOUNT_TRANSFER_IN',
      amount: 100_000,
      at: at(2, 15),
    });
    // Exactly at the range's END instant: outside.
    const oEnd = await order({ customerId: ids.c2, subtotal: 999_000, settledAt: at(3) });
    await payment({
      customerId: ids.c2,
      orderId: oEnd,
      method: 'MANUAL_TRANSFER',
      amount: 999_000,
      at: at(3),
    });

    // Tenant B, inside the range.
    const ob = await order({
      tenantId: tenantB.tenantId,
      customerId: ids.b1,
      productId: ids.productB,
      panelId: ids.panelB,
      subtotal: 777_000,
      settledAt: at(1, 9),
    });
    await payment({
      tenantId: tenantB.tenantId,
      customerId: ids.b1,
      orderId: ob,
      method: 'MANUAL_TRANSFER',
      amount: 777_000,
      at: at(1, 9),
    });
    const pb = await payment({
      tenantId: tenantB.tenantId,
      customerId: ids.b1,
      orderId: null,
      method: 'MANUAL_TRANSFER',
      amount: 333_000,
      at: at(1, 9),
    });
    await entry({
      tenantId: tenantB.tenantId,
      customerId: ids.b1,
      direction: 'CREDIT',
      reason: 'TOPUP_RECEIPT',
      amount: 333_000,
      paymentId: pb,
      at: at(1, 9),
    });
  });

  const irt = (lines: readonly FinancialLines[] | null | undefined): FinancialLines => {
    const found = (lines ?? []).find((l) => l.currency === 'IRT');
    if (found === undefined) throw new Error('no IRT lines');
    return found;
  };

  it('counts a top-up then a wallet purchase once in each section, never twice', async () => {
    const report = await financial(`${RANGE}&granularity=DAY`);
    const day1 = irt(report.buckets[0]?.lines);
    // Sales: the wallet purchase (300 000), the 90 000 sale and the edge sale. Not the top-up.
    expect(day1.sales).toBe(String(300_000 + 90_000 + 40_000));
    expect(day1.salesCount).toBe(3);
    expect(day1.grossSales).toBe(String(350_000 + 90_000 + 40_000));
    expect(day1.discounts).toBe('50000');
    // Cash: the top-up and the two transfer sales arrived from outside; the wallet purchase did not.
    expect(day1.customerPaid).toBe(String(500_000 + 90_000 + 40_000));
    expect(day1.externalPayments).toBe(3);
    // The wallet rose by the top-up and fell by the purchase.
    expect(day1.walletTopups).toBe('500000');
    expect(day1.walletSpending).toBe('300000');
    // The receipt credit is cash of its own; its FAILED payment is not.
    expect(day1.receiptCredits).toBe('70000');
    // Nowhere is 800 000 (top-up + purchase) a figure.
    for (const value of Object.values(day1)) expect(value).not.toBe('800000');
  });

  it('counts a refund to the wallet and the re-purchase as sale, refund, sale', async () => {
    const report = await financial(`${RANGE}&granularity=DAY`);
    const day2 = irt(report.buckets[1]?.lines);
    expect(day2.salesCount).toBe(3); // o2, the re-purchase o3, and the midnight sale
    expect(day2.sales).toBe(String(200_000 + 150_000 + 60_000));
    expect(day2.refunds).toBe('200000');
    expect(day2.refundsToWallet).toBe('200000');
    expect(day2.refundsPaidOut).toBe('0');
    expect(day2.netSales).toBe(String(200_000 + 150_000 + 60_000 - 200_000));
    // The refund to the wallet is not cash, and the re-purchase from it is not cash either.
    expect(day2.customerPaid).toBe(String(204_000 + 60_000));
    expect(day2.principalReceived).toBe(String(200_000 + 60_000));
    expect(day2.customerFees).toBe('4000');
    expect(day2.walletSpending).toBe('150000');
  });

  it('nets partial refunds, cashback and commission reversals, and an account transfer pair', async () => {
    const report = await financial(`${RANGE}&granularity=DAY`);
    const day3 = irt(report.buckets[2]?.lines);
    expect(day3.sales).toBe('400000');
    expect(day3.refundCount).toBe(2);
    expect(day3.refunds).toBe('150000');
    expect(day3.refundsPaidOut).toBe('100000');
    expect(day3.refundsToWallet).toBe('50000');
    expect(day3.netSales).toBe('250000');
    expect(day3.cashbackNet).toBe(String(20_000 - 5_000 - 2_500));
    expect(day3.commissionNet).toBe(String(10_000 - 2_500 - 1_250));
    // The transfer pair moves no sales and no cash, and nets to zero in the wallet.
    expect(day3.customerPaid).toBe('400000');
    expect(day3.walletSpending).toBe('0');
    const wallet = report.wallet.find((w) => w.currency === 'IRT');
    expect(wallet?.movements.find((m) => m.group === 'TRANSFER')?.amount).toBe('0');
  });

  it('puts a row exactly on a bucket edge in the later bucket, and the range end outside', async () => {
    const report = await financial(`${RANGE}&granularity=DAY`);
    expect(report.buckets.map((b) => b.start)).toEqual([at(0), at(1), at(2)]);
    expect(report.buckets.at(-1)?.end).toBe(at(3));
    const total = irt(report.totals);
    // The 999 000 sale at the range's END instant is in no bucket and no total.
    expect(total.sales).toBe(String(430_000 + 410_000 + 400_000));
    expect(Object.values(total)).not.toContain('999000');
  });

  it('keeps a closed period as it was: a later refund is a line in the later period', async () => {
    const before = irt((await financial(`${RANGE}&granularity=DAY`)).totals);
    // The 90 000 day-1 sale was refunded on day 4. Inside the range it is still a sale and
    // its refund is absent; the day-4 statement holds the refund and no sale.
    expect(before.refunds).toBe(String(200_000 + 150_000));
    const day4 = irt((await financial('range=CUSTOM&from=1405-06-13&to=1405-06-13')).totals);
    expect(day4.refunds).toBe('90000');
    expect(day4.salesCount).toBe(1); // the 999 000 sale at that midnight, and nothing else
  });

  it('never adds two currencies, and shows the USD top-up in its own lines', async () => {
    const report = await financial(`${RANGE}&granularity=DAY`);
    const usd = report.totals.find((l) => l.currency === 'USD');
    expect(usd?.walletTopups).toBe('1234');
    expect(usd?.customerPaid).toBe('1234');
    expect(usd?.sales).toBe('0');
    expect(irt(report.totals).walletTopups).toBe('500000');
  });

  it('totals are the exact sum of the buckets, at every granularity', async () => {
    for (const granularity of ['DAY', 'WEEK', 'MONTH'] as const) {
      const report = await financial(`${RANGE}&granularity=${granularity}`);
      expect(report.granularity).toBe(granularity);
      for (const total of report.totals) {
        const lines = report.buckets
          .flatMap((b) => b.lines ?? [])
          .filter((l) => l.currency === total.currency);
        for (const key of Object.keys(total) as (keyof FinancialLines)[]) {
          if (key === 'currency') continue;
          const sum = lines.reduce((acc, l) => acc + BigInt(l[key] as string | number), 0n);
          expect(sum.toString(), `${granularity} ${total.currency} ${key}`).toBe(
            String(total[key]),
          );
        }
      }
    }
  });

  it('reconciles the wallet: opening + movements = closing, against an independent balance', async () => {
    const report = await financial(`${RANGE}&granularity=DAY`);
    const wallet = report.wallet.find((w) => w.currency === 'IRT')!;
    expect(wallet.opening).toBe('1000');
    const sum = wallet.movements.reduce((acc, m) => acc + BigInt(m.amount), BigInt(wallet.opening));
    expect(sum.toString()).toBe(wallet.closing);
    const { rows } =
      await run(sql`SELECT coalesce(sum(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0)::text AS b
      FROM wallet_entries WHERE tenant_id = ${tenantA.tenantId} AND currency = 'IRT' AND created_at < ${at(3)}::timestamptz`);
    expect(wallet.closing).toBe((rows[0] as { b: string }).b);
  });

  it('splits sales by channel and cash by route, each adding up to its section', async () => {
    const report = await financial(`${RANGE}&granularity=DAY`);
    const total = irt(report.totals);
    const channelSum = report.salesByChannel
      .filter((row) => row.currency === 'IRT')
      .reduce((acc, row) => acc + BigInt(row.sales), 0n);
    expect(channelSum.toString()).toBe(total.sales);
    expect(report.salesByChannel.find((r) => r.method === 'WALLET')?.sales).toBe('450000');
    const cashSum = report.cashByRoute
      .filter((row) => row.currency === 'IRT')
      .reduce((acc, row) => acc + BigInt(row.customerPaid), 0n);
    expect(cashSum.toString()).toBe(total.customerPaid);
    const gateway = report.cashByRoute.find((r) => r.method === 'GATEWAY' && r.currency === 'IRT');
    expect(gateway).toMatchObject({
      kind: 'ORDER',
      principal: '200000',
      customerFees: '4000',
      customerPaid: '204000',
    });
    expect(report.providerFeeRecorded).toBe(false);
    expect(report.profitSupported).toBe(false);
    const gold = report.byProduct.find((r) => r.title === 'Plan Gold' && r.currency === 'IRT');
    expect(gold).toMatchObject({ orders: 7, sales: total.sales, refunds: total.refunds });
  });

  it('is tenant-isolated, and owner-only', async () => {
    const mine = await financial(`${RANGE}&granularity=DAY`);
    for (const lines of [...mine.totals, ...mine.buckets.flatMap((b) => b.lines ?? [])]) {
      expect(Object.values(lines)).not.toContain('777000');
      expect(Object.values(lines)).not.toContain('333000');
    }
    const theirs = irt((await financial(`${RANGE}&granularity=DAY`, foreignCookie)).totals);
    expect(theirs.sales).toBe('777000');
    expect(theirs.walletTopups).toBe('333000');
    expect((await get(`${REPORT_ROUTES.financial}?${RANGE}`, observerCookie)).statusCode).toBe(403);
    expect((await get(`${REPORT_ROUTES.financial}?${RANGE}&granularity=HOUR`)).statusCode).toBe(
      400,
    );
  });

  it('exports exactly the displayed statement: its columns sum to the totals', async () => {
    const report = await financial(`${RANGE}&granularity=DAY`);
    const response = await get(
      `${REPORT_ROUTES.export}?${RANGE}&report=FINANCIAL&format=csv&granularity=DAY`,
    );
    expect(response.statusCode, response.body).toBe(200);
    const [header, ...data] = response.body
      .replace(/^\uFEFF/u, '')
      .trimEnd()
      .split('\r\n');
    const columns = (header as string).split(',');
    const rows = data.map((line) => line.split(','));
    const shown = report.buckets.flatMap((b) => b.lines ?? []);
    expect(rows).toHaveLength(shown.length);
    const currencyAt = columns.indexOf('واحد پول');
    for (const total of report.totals) {
      const mine = rows.filter((row) => row[currencyAt] === total.currency);
      for (const [key, title] of [
        ['sales', 'مبلغ فروش'],
        ['refunds', 'بازپرداخت'],
        ['netSales', 'فروش خالص پس از بازپرداخت'],
        ['customerPaid', 'پرداخت ناخالص مشتری'],
        ['walletTopups', 'شارژ کیف پول'],
        ['walletSpending', 'خرید از کیف پول'],
      ] as const) {
        const at = columns.indexOf(title);
        expect(at, title).toBeGreaterThan(-1);
        // Exact decimal text, scaled by the currency's own exponent: IRT 0, USD 2. Dropping
        // the point gives the minor units back, for both.
        const sum = mine.reduce(
          (acc, row) => acc + BigInt((row[at] as string).replace('.', '')),
          0n,
        );
        expect(sum.toString(), `${total.currency} ${key}`).toBe(total[key]);
      }
    }
    const xlsx = await get(
      `${REPORT_ROUTES.export}?${RANGE}&report=FINANCIAL&format=xlsx&granularity=DAY`,
    );
    expect(xlsx.statusCode).toBe(200);
    const misplaced = await get(
      `${REPORT_ROUTES.export}?${RANGE}&report=SALES&format=csv&granularity=DAY`,
    );
    expect(misplaced.statusCode).toBe(400);
  });

  /*
   * Roadmap E4 (`docs/payment-fees-fx.md`): ONE source of truth for a payment's money. Every
   * tenant payment the period touches — in ANY state — is fetched over HTTP, and the
   * breakdowns the server computed for their details (`amounts`) are summed. Per currency,
   * the report's lines are exactly those sums (review of PR #247, F2):
   *
   * - principal received, customer fees and customer paid = Σ principal, fee and `received`
   *   of the payments that received money (a confirmed wallet purchase received none);
   * - wallet top-ups = Σ `walletCredit` of the confirmed top-ups;
   * - receipt credits = Σ `walletCredit` of the FAILED transfers a reviewer credited;
   * - wallet spending = Σ `walletDebit`.
   *
   * The fixture holds what could make them differ: a wallet purchase, partial and full
   * refunds, a receipt credit and a LATE_COMPLETION (received nothing, credited nothing).
   */
  it('reports exactly the sum of the payments’ own money breakdowns, cash and wallet lines alike (E4)', async () => {
    const report = await financial(`${RANGE}&granularity=DAY`);
    const start = report.buckets[0]?.start as string;
    const end = report.buckets.at(-1)?.end as string;
    const rows = (
      (await run(sql`SELECT id, state FROM payments
         WHERE tenant_id = ${tenantA.tenantId}
           AND coalesce(confirmed_at, resolved_at, created_at) >= ${start}::timestamptz
           AND coalesce(confirmed_at, resolved_at, created_at) < ${end}::timestamptz`)) as unknown as {
        rows: { id: string; state: string }[];
      }
    ).rows;
    const states = new Set(rows.map((row) => row.state));
    for (const state of ['CONFIRMED', 'FAILED', 'EXPIRED']) expect(states).toContain(state);
    type Sums = Record<
      'principal' | 'fees' | 'received' | 'topups' | 'receiptCredits' | 'spending',
      bigint
    >;
    const zero = (): Sums => ({
      principal: 0n,
      fees: 0n,
      received: 0n,
      topups: 0n,
      receiptCredits: 0n,
      spending: 0n,
    });
    const sums = new Map<string, Sums>();
    const seen = { feeBearing: 0, walletPurchase: 0, receiptCredit: 0, late: 0 };
    for (const { id, state } of rows) {
      const detail = await get(`/payments/${id}`);
      expect(detail.statusCode, detail.body).toBe(200);
      const payment = (
        detail.json() as {
          payment: {
            orderId: string | null;
            method: string;
            amounts: Record<string, string | number | null> | null;
            gatewayInvoice: { outcome: string | null } | null;
          };
        }
      ).payment;
      const amounts = payment.amounts;
      if (amounts === null) throw new Error(`no amounts on ${id}`);
      const figure = (key: string) => BigInt(amounts[key] as string);
      const into = sums.get(amounts['currency'] as string) ?? zero();
      // The cash section counts a payment that RECEIVED money, and only by what it received.
      if (figure('received') > 0n) {
        into.principal += figure('principal');
        into.fees += figure('customerFee');
        into.received += figure('received');
      }
      if (state === 'CONFIRMED')
        into.topups += payment.orderId === null ? figure('walletCredit') : 0n;
      else into.receiptCredits += figure('walletCredit');
      into.spending += figure('walletDebit');
      sums.set(amounts['currency'] as string, into);

      if (amounts['customerFee'] !== '0') {
        seen.feeBearing += 1;
        expect(figure('principal') + figure('customerFee')).toBe(figure('payable'));
      }
      if (payment.method === 'WALLET' && state === 'CONFIRMED') {
        seen.walletPurchase += 1;
        expect(amounts['received']).toBe('0');
        expect(amounts['walletDebit']).toBe(amounts['principal']);
      }
      if (state === 'FAILED' && amounts['walletCredit'] !== '0') seen.receiptCredit += 1;
      if (payment.gatewayInvoice?.outcome === 'LATE_COMPLETION') {
        seen.late += 1;
        expect(amounts['received']).toBe('0');
        expect(amounts['walletCredit']).toBe('0');
      }
      // No refund figure beside the breakdown: the refund ledger is the one answer (F1).
      expect(Object.keys(amounts).some((key) => /refund/iu.test(key))).toBe(false);
    }
    expect(seen).toEqual({ feeBearing: 1, walletPurchase: 2, receiptCredit: 1, late: 1 });
    for (const total of report.totals) {
      const mine = sums.get(total.currency) ?? zero();
      expect(total.principalReceived, total.currency).toBe(mine.principal.toString());
      expect(total.customerFees, total.currency).toBe(mine.fees.toString());
      expect(total.customerPaid, total.currency).toBe(mine.received.toString());
      expect(total.walletTopups, total.currency).toBe(mine.topups.toString());
      expect(total.receiptCredits, total.currency).toBe(mine.receiptCredits.toString());
      expect(total.walletSpending, total.currency).toBe(mine.spending.toString());
    }
    expect(report.totals.map((total) => total.currency).sort()).toEqual([...sums.keys()].sort());
  });
});
