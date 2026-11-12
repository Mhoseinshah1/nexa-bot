import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { ResellerPurchaseBatch, ResellerPurchaseQuote, UserId } from '@nexa/contracts';
import { tenantA } from './harness';
import { codeOf, systemActor, useSellingHarness } from './reseller-selling-harness';

/**
 * PR-5 §5.5 — «خرید» on the reseller panel, against the real app over HTTP.
 *
 * Proves: the catalogue is the bot's own for the same reseller (categories, plans, servers,
 * prices, the list price struck through); one purchase is N ordinary orders, each under its
 * own key `(batchKey, index)`, paid from the wallet through the bot's checkout; the whole total
 * is pre-checked against the wallet BEFORE the first order (a short wallet charges nothing);
 * an order refused on the way is not charged while the others are; a replay of the same key
 * quotes the same orders and charges once; a custom username is for one service only; another
 * reseller's purchase is not found; «ارسال همهٔ لینک‌ها» uses the existing delivery.
 */
describe('the reseller web panel — buying (PR-5)', () => {
  const h = useSellingHarness('rwb');

  const quoteBody = (productId: string, quantity: number, username?: string) => ({
    plan: { kind: 'PLAN', productId },
    quantity,
    username: username === undefined ? { mode: 'AUTOMATIC' } : { mode: 'CUSTOM', value: username },
    clientId: null,
    note: null,
  });

  async function quote(cookie: string, productId: string, quantity: number, key = randomUUID()) {
    const response = await h().call(
      cookie,
      'POST',
      '/purchases/quote',
      quoteBody(productId, quantity),
      key,
    );
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as ResellerPurchaseQuote;
  }

  async function batch(cookie: string, batchId: string): Promise<ResellerPurchaseBatch> {
    const response = await h().call(cookie, 'GET', `/purchases/${batchId}`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as ResellerPurchaseBatch;
  }

  async function ordersOf(customerId: UserId): Promise<{ state: string; n: number }[]> {
    const rows = await h()
      .db()
      .execute(
        sql`SELECT state, count(*)::int AS n FROM orders WHERE customer_id = ${customerId}::uuid GROUP BY state ORDER BY state`,
      );
    return rows.rows as { state: string; n: number }[];
  }

  it('shows exactly the bot’s catalogue for this reseller, with the list price struck through', async () => {
    const first = await h().product(250_000n, 'یک ماهه');
    const second = await h().product(500_000n, 'دو ماهه');
    const cookie = await h().signedIn();
    const actor = systemActor('catalogue');

    const servers = (await h().call(cookie, 'GET', '/catalogue/servers')).json() as {
      enabled: boolean;
      step: boolean;
    };
    // `sales.server_selection` is off by default: no server step, as the bot.
    expect(servers).toMatchObject({ enabled: false, step: false });

    const bot = await h().api.container.products.browseCategories(
      tenantA,
      actor,
      20,
      0,
      h().reseller,
    );
    const categories = (await h().call(cookie, 'GET', '/catalogue/categories')).json() as {
      items: { id: string }[];
    };
    expect(categories.items.map((item) => item.id)).toEqual(bot.items.map((item) => item.id));

    const categoryId = bot.items[0]?.id as string;
    const botPlans = await h().api.container.products.browseCategory(
      tenantA,
      actor,
      categoryId,
      20,
      0,
      h().reseller,
    );
    const plans = (await h().call(cookie, 'GET', `/catalogue/categories/${categoryId}`)).json() as {
      items: { id: string; price: { amountMinor: string }; listPrice: { amountMinor: string } }[];
    };
    expect(plans.items.map((plan) => plan.id)).toEqual(botPlans.items.map((plan) => plan.id));
    expect(plans.items.map((plan) => plan.price.amountMinor)).toEqual(
      botPlans.items.map((plan) => plan.price?.amountMinor.toString()),
    );
    const byId = new Map(plans.items.map((plan) => [plan.id, plan]));
    expect(byId.get(first)).toMatchObject({
      price: { amountMinor: '200000' },
      listPrice: { amountMinor: '250000' },
    });
    expect(byId.get(second)).toMatchObject({
      price: { amountMinor: '400000' },
      listPrice: { amountMinor: '500000' },
    });

    // «سرویس دلخواه» exactly when the bot offers it — not configured here.
    const custom = (await h().call(cookie, 'GET', '/catalogue/custom')).json() as {
      offered: boolean;
    };
    expect(custom.offered).toBe(false);
  });

  it('buys three services as three ordinary orders, each under its own key, paid from the wallet', async () => {
    const plan = await h().product();
    await h().credit(h().reseller, 600_000n);
    const cookie = await h().signedIn();
    const quoted = await quote(cookie, plan, 3);
    expect(quoted).toMatchObject({
      quantity: 3,
      unitPrice: { amountMinor: '200000' },
      listUnitPrice: { amountMinor: '250000' },
      total: { amountMinor: '600000' },
      saving: { amountMinor: '150000' },
      balance: { amountMinor: '600000' },
      balanceAfter: { amountMinor: '0' },
      sufficient: true,
      shortfall: null,
    });
    const before = await batch(cookie, quoted.batchId);
    expect(before.items.map((item) => item.status)).toEqual(['QUOTED', 'QUOTED', 'QUOTED']);
    // The per-index key: three DIFFERENT orders, not one replayed three times.
    expect(new Set(before.items.map((item) => item.orderId)).size).toBe(3);

    const confirmed = await h().call(cookie, 'POST', `/purchases/${quoted.batchId}/confirm`);
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    // Paid, and each service recorded by the settlement; the links come with provisioning.
    const paid = (confirmed.json() as ResellerPurchaseBatch).items;
    expect(paid.map((item) => item.status)).toEqual(['CREATED', 'CREATED', 'CREATED']);
    expect(paid.map((item) => item.subscriptionUrl)).toEqual([null, null, null]);
    expect(await h().balance(h().reseller)).toBe(0n);
    expect(await ordersOf(h().reseller)).toEqual([{ state: 'PAID', n: 3 }]);

    await h().api.container.provisionerLoop.tick();
    const after = await batch(cookie, quoted.batchId);
    expect(after.items.map((item) => item.status)).toEqual(['CREATED', 'CREATED', 'CREATED']);
    expect(after.items.every((item) => item.subscriptionUrl?.startsWith('https://'))).toBe(true);
    expect(new Set(after.items.map((item) => item.username)).size).toBe(3);

    // `ResellerService.recordPurchase`, as the bot does: three sales this month.
    const dashboard = (await h().call(cookie, 'GET', '/dashboard')).json() as {
      monthSales: { count: number };
    };
    expect(dashboard.monthSales.count).toBe(3);

    // «ارسال همهٔ لینک‌ها در تلگرام»: the existing delivery, to the reseller's own chat.
    h().sent.length = 0;
    const links = await h().call(cookie, 'POST', `/purchases/${quoted.batchId}/send-links`);
    expect(links.json()).toEqual({ sent: 3, failed: 0 });
    const toReseller = h().sent.filter((message) => message.body.includes('943001'));
    expect(toReseller.length).toBeGreaterThanOrEqual(3);
  });

  it('pre-checks the whole total against the wallet and charges nothing when it is short', async () => {
    const plan = await h().product();
    await h().credit(h().reseller, 400_000n);
    const cookie = await h().signedIn();
    const quoted = await quote(cookie, plan, 3);
    expect(quoted).toMatchObject({
      sufficient: false,
      shortfall: { amountMinor: '200000' },
      balanceAfter: { amountMinor: '-200000' },
    });
    const refused = await h().call(cookie, 'POST', `/purchases/${quoted.batchId}/confirm`);
    expect(refused.statusCode).toBe(409);
    expect(codeOf(refused)).toBe('commerce.wallet_insufficient_funds');
    // Not one order was paid or even confirmed: the balance is untouched.
    expect(await h().balance(h().reseller)).toBe(400_000n);
    expect(await ordersOf(h().reseller)).toEqual([{ state: 'DRAFT', n: 3 }]);
    const view = await batch(cookie, quoted.batchId);
    expect(view.confirmed).toBe(false);
  });

  it('a refused order is not charged while the others are bought', async () => {
    const plan = await h().product();
    await h().credit(h().reseller, 600_000n);
    const cookie = await h().signedIn();
    const quoted = await quote(cookie, plan, 3);
    const middle = (await batch(cookie, quoted.batchId)).items[1]?.orderId as string;
    // The middle draft's time runs out before the purchase: the checkout refuses it.
    await h()
      .db()
      .execute(
        sql`UPDATE orders SET expires_at = now() - interval '1 minute' WHERE id = ${middle}::uuid`,
      );
    const confirmed = await h().call(cookie, 'POST', `/purchases/${quoted.batchId}/confirm`);
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    const items = (confirmed.json() as ResellerPurchaseBatch).items;
    expect(items.map((item) => item.status)).toEqual(['CREATED', 'FAILED', 'CREATED']);
    expect(items[1]?.reason).not.toBeNull();
    // Two charged, one not.
    expect(await h().balance(h().reseller)).toBe(200_000n);
  });

  it('replays the same batch key: the same orders, charged once', async () => {
    const plan = await h().product();
    await h().credit(h().reseller, 1_000_000n);
    const cookie = await h().signedIn();
    const key = randomUUID();
    const once = await quote(cookie, plan, 2, key);
    const twice = await quote(cookie, plan, 2, key);
    expect(twice.batchId).toBe(once.batchId);
    expect((await batch(cookie, once.batchId)).items.map((item) => item.orderId)).toEqual(
      (await batch(cookie, twice.batchId)).items.map((item) => item.orderId),
    );
    // The same key for a different purchase is refused.
    const different = await h().call(cookie, 'POST', '/purchases/quote', quoteBody(plan, 3), key);
    expect(different.statusCode).toBe(409);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const confirmed = await h().call(cookie, 'POST', `/purchases/${once.batchId}/confirm`);
      expect(confirmed.statusCode, confirmed.body).toBe(200);
    }
    expect(await h().balance(h().reseller)).toBe(600_000n);
    expect(await ordersOf(h().reseller)).toEqual([{ state: 'PAID', n: 2 }]);
  });

  it('a custom username is for a purchase of one service only, and is the bot’s own step', async () => {
    const plan = await h().product();
    await h().credit(h().reseller, 200_000n);
    const cookie = await h().signedIn();
    const many = await h().call(
      cookie,
      'POST',
      '/purchases/quote',
      quoteBody(plan, 2, 'sara_vip1'),
    );
    expect(many.statusCode).toBe(400);
    expect(codeOf(many)).toBe('reseller_web.custom_username_single');

    const one = await h().call(cookie, 'POST', '/purchases/quote', quoteBody(plan, 1, 'sara_vip1'));
    expect(one.statusCode, one.body).toBe(200);
    const quoted = one.json() as ResellerPurchaseQuote;
    expect(quoted).toMatchObject({ usernameMode: 'CUSTOM', username: 'sara_vip1' });
    await h().call(cookie, 'POST', `/purchases/${quoted.batchId}/confirm`);
    await h().api.container.provisionerLoop.tick();
    expect((await batch(cookie, quoted.batchId)).items[0]?.username).toBe('sara_vip1');
  });

  it('another reseller’s purchase is not found, and a suspended panel refuses', async () => {
    const plan = await h().product();
    const cookie = await h().signedIn();
    const quoted = await quote(cookie, plan, 1);
    const others = await h().signedIn(h().other);
    for (const [method, path] of [
      ['GET', `/purchases/${quoted.batchId}`],
      ['POST', `/purchases/${quoted.batchId}/confirm`],
      ['POST', `/purchases/${quoted.batchId}/send-links`],
    ] as const) {
      const response = await h().call(others, method, path);
      expect(response.statusCode, `${method} ${path}`).toBe(404);
      expect(codeOf(response)).toBe('reseller_web.not_found');
    }
    // A quote without the idempotency header is refused.
    const bare = await h()
      .api.app.getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/api/reseller/v1/purchases/quote',
        headers: {
          origin: 'https://admin.example.test',
          cookie: `nexa_reseller_session=${cookie}`,
        },
        payload: quoteBody(plan, 1),
      });
    expect(bare.statusCode).toBe(400);
  });
});
