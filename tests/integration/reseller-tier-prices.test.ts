import { sql, type SQL } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  COMMERCE_ERROR_CODES,
  EMPTY_PRODUCT_DISPLAY,
  PLATFORM_ERROR_CODES,
  money,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type Money,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
  type ResellerOverrideMode,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import type { OrderRecord } from '../../apps/api/src/modules/commerce/orders/application/ports';
import {
  SEED_IDS,
  adminActorFor,
  createAdmin,
  createTestContext,
  makePanelSellable,
  tenantA,
  type TestContext,
} from './harness';

/**
 * Round 4 PR-G — a reseller tier's exact price per product (`FIXED_PRICE_TABLE`), end to end
 * at the service boundary: the real container, the real order, commercial-action, pricing
 * and reseller services over PostgreSQL.
 *
 * The rules each case pins:
 * - the quote IS the tier price: the `TIER_PRICE` step replaces the list subtotal, the
 *   discount stays the promotions' alone, and the snapshot records `fixed_price`;
 * - a product the table does not price is NOT sellable to the tier — left out of the
 *   catalogue (a courtesy) and refused at the draft and again at confirmation — unless the
 *   tier's «قیمت عادی برای محصولات بدون قیمت» sells it at list;
 * - a price changed between the quote and the confirmation refuses with
 *   `RESELLER_TERMS_CHANGED`; a price removed refuses as not entitled; neither re-prices;
 * - add-ons keep their own pricing under a price table;
 * - the operator's write is tenant-scoped, in the list price's currency, audited and
 *   idempotent.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const viaBot: TenantContext = { ...tenantA, botInstanceId: BOT_A };

const customerActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

const EVERYTHING = [
  { kind: 'OPERATION', subject: null },
  { kind: 'PRODUCT', subject: null },
  { kind: 'PANEL', subject: null },
  { kind: 'BOT', subject: null },
] as const;

describe('reseller tier fixed price per product (Round 4 PR-G)', () => {
  let ctx: TestContext;
  let products: DrizzleProductRepository;
  let owner: ActorContext;
  let panelA: string;
  let resellerCustomer: UserId;
  let n = 0;
  const key = (): string => `tier-price-key-${(n += 1)}`;

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    products = new DrizzleProductRepository(ctx.container.database.db);
    panelA = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelA}, ${tenantA.tenantId}, 'Panel A', 'sanaei', 'https://a.example.test', 'ACTIVE')`);
    await makePanelSellable(ctx.container, tenantA, panelA);
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'owner-tier-price',
        roleKeys: ['owner'],
      }),
    );
    resellerCustomer = await customer('950001');
  });

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  async function customer(telegramUserId: string): Promise<UserId> {
    const { customer: record } = await ctx.container.customers.resolveFromUpdate(
      tenantA,
      customerActor(`resolve-${telegramUserId}`),
      {
        idempotencyKey: `resolve-${telegramUserId}`,
        telegramUserId,
        from: { id: Number(telegramUserId), first_name: 'سارا' },
        botInstanceId: BOT_A,
      },
    );
    return record.id;
  }

  async function product(
    price: bigint,
    options: { readonly panelId?: string; readonly categoryId?: string } = {},
  ): Promise<ProductId> {
    const created = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن نقره‌ای',
        description: 'یک ماهه',
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: (options.panelId ?? panelA) as PanelId,
        categoryId: (options.categoryId ?? SEED_IDS.categoryA) as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: 2 },
        price: money(price, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, created.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    return created.id;
  }

  async function tableTier(options: { readonly fallback?: boolean } = {}): Promise<string> {
    const created = await ctx.container.resellersAdmin.createTier(tenantA, owner, {
      idempotencyKey: key(),
      write: {
        name: `نمایندگی نقره‌ای ${n}`,
        pricingMode: 'FIXED_PRICE_TABLE',
        discountPercentage: null,
        creditLimit: money(0n, 'IRT'),
        unpricedListFallback: options.fallback ?? false,
      },
    });
    await ctx.container.resellersAdmin.replaceGrants(tenantA, owner, {
      idempotencyKey: key(),
      tierId: created.id,
      grants: EVERYTHING,
    });
    return created.id;
  }

  async function register(tierId: string, mode: ResellerOverrideMode = 'TIER'): Promise<void> {
    await ctx.container.resellersAdmin.register(tenantA, owner, {
      idempotencyKey: key(),
      customerId: resellerCustomer,
      write: {
        tierId,
        pricingMode: mode,
        discountPercentage: null,
        creditLimit: null,
      },
    });
  }

  const setPrices = (
    tierId: string,
    prices: readonly { readonly productId: string; readonly price: Money | null }[],
    idempotencyKey: string = key(),
  ) =>
    ctx.container.resellersAdmin.setProductPrices(tenantA, owner, {
      idempotencyKey,
      tierId,
      prices,
    });

  const draft = (productId: string) =>
    ctx.container.orders.createDraft(viaBot, customerActor(key()), {
      idempotencyKey: key(),
      customerId: resellerCustomer,
      productId,
    });

  const confirm = (orderId: string) =>
    ctx.container.orders.confirm(viaBot, customerActor(key()), {
      idempotencyKey: key(),
      customerId: resellerCustomer,
      orderId,
    });

  async function rows<T>(query: SQL): Promise<T[]> {
    return ((await ctx.container.database.db.execute(query as never)) as unknown as { rows: T[] })
      .rows;
  }

  const termsRow = async (orderId: string) =>
    (
      await rows<{
        layer: string;
        percent: number | null;
        fixed_price: boolean;
        list_amount: string;
        cost_amount: string;
        margin_amount: string;
        sale_amount: string;
        currency: string;
      }>(
        sql`SELECT layer, percent, fixed_price, list_amount::text AS list_amount,
                   cost_amount::text AS cost_amount, margin_amount::text AS margin_amount,
                   sale_amount::text AS sale_amount, currency
              FROM order_reseller_terms WHERE order_id = ${orderId}`,
      )
    )[0];

  const orderState = async (orderId: string) =>
    (await rows<{ state: string }>(sql`SELECT state FROM orders WHERE id = ${orderId}`))[0]?.state;

  const stepsOf = (order: OrderRecord) =>
    order.totals.quote.trace.map((s) => ({
      step: s.step,
      ruleId: s.ruleId,
      before: s.amountBefore.amountMinor,
      after: s.amountAfter.amountMinor,
    }));

  const browse = async () =>
    (
      await ctx.container.products.browseCategory(
        viaBot,
        customerActor(key()),
        SEED_IDS.categoryA,
        50,
        0,
        resellerCustomer,
      )
    ).items.map((p) => ({ id: p.id, price: p.price?.amountMinor ?? null }));

  // -------------------------------------------------------------------------
  // The quote
  // -------------------------------------------------------------------------

  it('quotes the tier price as the TIER_PRICE step that replaces the subtotal, and records it', async () => {
    const tierId = await tableTier();
    await register(tierId);
    const productId = await product(1_000_000n);
    await setPrices(tierId, [{ productId, price: money(800_000n, 'IRT') }]);

    const order = await draft(productId);
    expect(order.totals.subtotal).toEqual(money(800_000n, 'IRT'));
    expect(order.totals.total).toEqual(money(800_000n, 'IRT'));
    expect(order.totals.discount, 'a margin is never a discount').toEqual(money(0n, 'IRT'));
    expect(order.line.unitPrice, 'the line keeps the list unit price').toEqual(
      money(1_000_000n, 'IRT'),
    );
    expect(stepsOf(order)).toEqual([
      expect.objectContaining({ step: 'BASE_PRICE', after: 1_000_000n }),
      { step: 'TIER_PRICE', ruleId: tierId, before: 1_000_000n, after: 800_000n },
    ]);
    for (const amount of [order.totals.subtotal, order.totals.total]) {
      expect(typeof amount.amountMinor).toBe('bigint');
      expect(amount.currency).toBe('IRT');
    }

    const confirmed = await confirm(order.id);
    expect(confirmed.state).toBe('AWAITING_PAYMENT');
    expect(await termsRow(order.id)).toEqual({
      layer: 'TIER',
      percent: null,
      fixed_price: true,
      list_amount: '1000000',
      cost_amount: '800000',
      margin_amount: '200000',
      sale_amount: '800000',
      currency: 'IRT',
    });
    const terms = await ctx.container.resellersAdmin.termsFor(tenantA, order.id);
    expect(terms?.fixedPrice, 'the ops log reads the tier price from this row').toBe(true);
    expect(terms?.costAmount).toBe(800_000n);
  });

  it('shows a reseller the tier price in the catalogue, and an ordinary customer the list', async () => {
    const tierId = await tableTier();
    await register(tierId);
    const priced = await product(1_000_000n);
    const unpriced = await product(500_000n);
    await setPrices(tierId, [{ productId: priced, price: money(750_000n, 'IRT') }]);

    expect(await browse(), 'the unpriced product is not offered to the tier').toEqual([
      { id: priced, price: 750_000n },
    ]);
    const ordinary = await customer('950002');
    const page = await ctx.container.products.browseCategory(
      viaBot,
      customerActor(key()),
      SEED_IDS.categoryA,
      50,
      0,
      ordinary,
    );
    expect(
      page.items
        .map((p) => ({ id: p.id, price: p.price?.amountMinor }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    ).toEqual(
      [
        { id: priced, price: 1_000_000n },
        { id: unpriced, price: 500_000n },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );
  });

  it('leaves a category of unpriced products out of the category list, in SQL', async () => {
    const tierId = await tableTier();
    await register(tierId);
    const empty = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO product_categories (id, tenant_id, name, sort_order)
      VALUES (${empty}, ${tenantA.tenantId}, 'بی‌قیمت', 1)`);
    await product(1_000_000n, { categoryId: empty });
    const priced = await product(1_000_000n);
    await setPrices(tierId, [{ productId: priced, price: money(900_000n, 'IRT') }]);
    const categories = async () =>
      (
        await ctx.container.products.browseCategories(
          viaBot,
          customerActor(key()),
          50,
          0,
          resellerCustomer,
        )
      ).items.map((c) => c.id);
    // The category list carries no price to filter afterwards: only the query's own gate
    // can keep an empty category out of it.
    expect(await categories()).not.toContain(empty);
    expect(await categories()).toContain(SEED_IDS.categoryA);
  });

  // -------------------------------------------------------------------------
  // A product the table does not price
  // -------------------------------------------------------------------------

  it('refuses a product the table does not price, before an order exists', async () => {
    const tierId = await tableTier();
    await register(tierId);
    const productId = await product(1_000_000n);
    const before = (await rows<{ n: number }>(sql`SELECT count(*)::int AS n FROM orders`))[0]?.n;

    await expect(draft(productId)).rejects.toMatchObject({
      code: COMMERCE_ERROR_CODES.RESELLER_NOT_ENTITLED,
      details: { dimension: 'CATALOGUE', reason: 'TIER_PRICE_MISSING', tierId },
    });
    expect((await rows<{ n: number }>(sql`SELECT count(*)::int AS n FROM orders`))[0]?.n).toBe(
      before,
    );
  });

  it('refuses a price in another currency as no price at all', async () => {
    const tierId = await tableTier();
    await register(tierId);
    const productId = await product(1_000_000n);
    await setPrices(tierId, [{ productId, price: money(800_000n, 'IRT') }]);
    // A row left in another currency (a product re-priced in rials after its tier price was
    // written) is not a price for the product.
    await ctx.container.database.db.execute(sql`
      UPDATE reseller_tier_product_prices SET price_currency = 'IRR' WHERE product_id = ${productId}`);
    await expect(draft(productId)).rejects.toMatchObject({
      code: COMMERCE_ERROR_CODES.RESELLER_NOT_ENTITLED,
    });
    expect(await browse()).toEqual([]);
  });

  it('sells an unpriced product at list when the tier says so, and records the LIST layer', async () => {
    const tierId = await tableTier({ fallback: true });
    await register(tierId);
    const productId = await product(1_000_000n);

    expect(await browse()).toEqual([{ id: productId, price: 1_000_000n }]);
    const order = await draft(productId);
    expect(order.totals.total).toEqual(money(1_000_000n, 'IRT'));
    expect(stepsOf(order).map((s) => s.step)).toEqual(['BASE_PRICE']);
    await confirm(order.id);
    expect(await termsRow(order.id)).toMatchObject({
      layer: 'LIST',
      percent: null,
      fixed_price: false,
      cost_amount: '1000000',
      margin_amount: '0',
    });
  });

  it('lets a reseller’s own override replace the table, so an unpriced product is sold at list', async () => {
    const tierId = await tableTier();
    await register(tierId, 'LIST_PRICE');
    const productId = await product(1_000_000n);
    const order = await draft(productId);
    expect(order.totals.total).toEqual(money(1_000_000n, 'IRT'));
    await confirm(order.id);
    expect(await termsRow(order.id)).toMatchObject({ layer: 'OVERRIDE', fixed_price: false });
  });

  it('charges the list when the tier price is above it, and records no table price', async () => {
    const tierId = await tableTier();
    await register(tierId);
    const productId = await product(1_000_000n);
    await setPrices(tierId, [{ productId, price: money(1_200_000n, 'IRT') }]);
    const order = await draft(productId);
    expect(order.totals.total).toEqual(money(1_000_000n, 'IRT'));
    expect(stepsOf(order).map((s) => s.step)).toEqual(['BASE_PRICE']);
    await confirm(order.id);
    expect(await termsRow(order.id)).toMatchObject({
      layer: 'LIST',
      fixed_price: false,
      cost_amount: '1000000',
    });
  });

  // -------------------------------------------------------------------------
  // Between the quote and the confirmation
  // -------------------------------------------------------------------------

  it('refuses to confirm when the tier price changed since the quote, and writes nothing', async () => {
    const tierId = await tableTier();
    await register(tierId);
    const productId = await product(1_000_000n);
    await setPrices(tierId, [{ productId, price: money(800_000n, 'IRT') }]);
    const drafted = await draft(productId);

    await setPrices(tierId, [{ productId, price: money(700_000n, 'IRT') }]);

    await expect(confirm(drafted.id)).rejects.toMatchObject({
      code: COMMERCE_ERROR_CODES.RESELLER_TERMS_CHANGED,
    });
    expect(await orderState(drafted.id)).toBe('DRAFT');
    expect(await termsRow(drafted.id)).toBeUndefined();

    // Starting again quotes the live price, and that confirms.
    const again = await draft(productId);
    expect(again.totals.total).toEqual(money(700_000n, 'IRT'));
    await confirm(again.id);
    expect((await termsRow(again.id))?.cost_amount).toBe('700000');
  });

  it('refuses to confirm when the tier price was removed since the quote', async () => {
    const tierId = await tableTier();
    await register(tierId);
    const productId = await product(1_000_000n);
    await setPrices(tierId, [{ productId, price: money(800_000n, 'IRT') }]);
    const drafted = await draft(productId);

    const cleared = await setPrices(tierId, [{ productId, price: null }]);
    expect(cleared).toMatchObject({ set: 0, cleared: 1 });

    await expect(confirm(drafted.id)).rejects.toMatchObject({
      code: COMMERCE_ERROR_CODES.RESELLER_NOT_ENTITLED,
      details: { reason: 'TIER_PRICE_MISSING' },
    });
    expect(await orderState(drafted.id)).toBe('DRAFT');
    expect(await termsRow(drafted.id)).toBeUndefined();
  });

  it('refuses to confirm a percentage-tier quote once the tier became a price table', async () => {
    const created = await ctx.container.resellersAdmin.createTier(tenantA, owner, {
      idempotencyKey: key(),
      write: {
        name: 'درصدی',
        pricingMode: 'PERCENTAGE_DISCOUNT',
        discountPercentage: 20,
        creditLimit: money(0n, 'IRT'),
      },
    });
    await ctx.container.resellersAdmin.replaceGrants(tenantA, owner, {
      idempotencyKey: key(),
      tierId: created.id,
      grants: EVERYTHING,
    });
    await register(created.id);
    const productId = await product(1_000_000n);
    const drafted = await draft(productId);
    expect(drafted.totals.total).toEqual(money(800_000n, 'IRT'));

    await setPrices(created.id, [{ productId, price: money(900_000n, 'IRT') }]);
    await ctx.container.resellersAdmin.updateTier(tenantA, owner, {
      idempotencyKey: key(),
      tierId: created.id,
      write: {
        name: 'درصدی',
        pricingMode: 'FIXED_PRICE_TABLE',
        discountPercentage: null,
        creditLimit: money(0n, 'IRT'),
      },
    });
    await expect(confirm(drafted.id)).rejects.toMatchObject({
      code: COMMERCE_ERROR_CODES.RESELLER_TERMS_CHANGED,
    });
  });

  // -------------------------------------------------------------------------
  // Renewal and add-ons
  // -------------------------------------------------------------------------

  describe('commercial actions', () => {
    async function renewableService(price: bigint): Promise<{
      serviceId: string;
      productId: ProductId;
    }> {
      const panel = await ctx.container.panels.create(tenantA, owner, {
        name: 'Panel Renew',
        providerType: 'marzban',
        baseUrl: 'https://renew.example.test',
        credentials: { username: 'nexa', password: 'not-a-real-password' },
        activation: { proxyProtocols: ['vless'], inboundTags: { vless: ['VLESS TCP'] } },
        idempotencyKey: key(),
      });
      const panelId = panel.view.panel.id;
      const productId = await product(price, { panelId });
      const serviceId = ctx.container.ids.uuid();
      // The service's own order, bought before the customer was a reseller.
      const order = await draft(productId);
      await ctx.container.database.db.execute(sql`
        INSERT INTO services (id, tenant_id, customer_id, order_id, panel_id, product_id,
                              provider_username, subscription_ref, provider_client_id,
                              traffic_limit_bytes, state, provisioned_at, expires_at)
        VALUES (${serviceId}, ${tenantA.tenantId}, ${resellerCustomer}, ${order.id},
                ${panelId}, ${productId}, ${'tp' + serviceId.slice(-8)},
                ${serviceId.replace(/-/gu, '').slice(0, 32)},
                ${ctx.container.ids.uuid()}, 0, 'ACTIVE', now(), now() + interval '30 days')`);
      return { serviceId, productId };
    }

    const renew = (serviceId: string) =>
      ctx.container.commercialActions.draft(viaBot, customerActor(key()), resellerCustomer, {
        serviceId,
        kind: 'RENEW',
        idempotencyKey: key(),
      });

    it('renews at the tier price and records it at confirmation', async () => {
      const { serviceId, productId } = await renewableService(100_000n);
      const tierId = await tableTier();
      await register(tierId);
      await setPrices(tierId, [{ productId, price: money(70_000n, 'IRT') }]);

      const offer = await ctx.container.commercialActions.offer(
        viaBot,
        customerActor(key()),
        resellerCustomer,
        serviceId,
        'RENEW',
      );
      expect(offer.product?.price, 'the renewal button shows the tier price').toEqual(
        money(70_000n, 'IRT'),
      );

      const { order } = await renew(serviceId);
      expect(order.totals.total).toEqual(money(70_000n, 'IRT'));
      expect(stepsOf(order).map((s) => s.step)).toEqual(['BASE_PRICE', 'TIER_PRICE']);
      await ctx.container.commercialActions.confirm(
        viaBot,
        customerActor(key()),
        resellerCustomer,
        {
          orderId: order.id,
          idempotencyKey: key(),
        },
      );
      expect(await termsRow(order.id)).toMatchObject({
        layer: 'TIER',
        fixed_price: true,
        cost_amount: '70000',
        list_amount: '100000',
      });
    });

    it('refuses a renewal of a product the table does not price, and offers none', async () => {
      const { serviceId } = await renewableService(100_000n);
      await register(await tableTier());
      const offer = await ctx.container.commercialActions.offer(
        viaBot,
        customerActor(key()),
        resellerCustomer,
        serviceId,
        'RENEW',
      );
      expect(offer.product).toBeNull();
      await expect(renew(serviceId)).rejects.toMatchObject({
        code: COMMERCE_ERROR_CODES.RESELLER_NOT_ENTITLED,
        details: { reason: 'TIER_PRICE_MISSING' },
      });
    });
  });

  // -------------------------------------------------------------------------
  // The operator's write
  // -------------------------------------------------------------------------

  describe('the price table write', () => {
    it('lists every product with its list price and the tier price, by keyset', async () => {
      const tierId = await tableTier();
      const a = await product(1_000_000n);
      const b = await product(2_000_000n);
      await setPrices(tierId, [{ productId: a, price: money(900_000n, 'IRT') }]);
      const first = await ctx.container.resellersAdmin.productPriceTable(tenantA, owner, tierId, {
        limit: 1,
        cursor: null,
      });
      expect(first.items).toHaveLength(1);
      expect(first.next).not.toBeNull();
      const second = await ctx.container.resellersAdmin.productPriceTable(tenantA, owner, tierId, {
        limit: 50,
        cursor: first.next,
      });
      const all = [...first.items, ...second.items].filter(
        (r) => r.productId === a || r.productId === b,
      );
      expect(new Set(all.map((r) => r.productId))).toEqual(new Set([a, b]));
      const rowA = all.find((r) => r.productId === a);
      expect(rowA?.listPrice).toEqual(money(1_000_000n, 'IRT'));
      expect(rowA?.tierPrice).toEqual(money(900_000n, 'IRT'));
      expect(all.find((r) => r.productId === b)?.tierPrice).toBeNull();
    });

    it('refuses a price in a currency other than the product’s, and an unknown product', async () => {
      const tierId = await tableTier();
      const productId = await product(1_000_000n);
      await expect(
        setPrices(tierId, [{ productId, price: money(800_000n, 'IRR') }]),
      ).rejects.toMatchObject({ code: COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID });
      await expect(
        setPrices(tierId, [{ productId: ctx.container.ids.uuid(), price: money(800_000n, 'IRT') }]),
      ).rejects.toMatchObject({ code: COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID });
      expect(
        (
          await rows<{ n: number }>(
            sql`SELECT count(*)::int AS n FROM reseller_tier_product_prices`,
          )
        )[0]?.n,
      ).toBe(0);
    });

    it('audits the before and after, and replays a write with the same key', async () => {
      const tierId = await tableTier();
      const productId = await product(1_000_000n);
      const idem = key();
      const first = await setPrices(tierId, [{ productId, price: money(800_000n, 'IRT') }], idem);
      const replay = await setPrices(tierId, [{ productId, price: money(800_000n, 'IRT') }], idem);
      expect(replay).toEqual(first);
      const audits = await rows<{ before: unknown; after: unknown }>(
        sql`SELECT before, after FROM audit_logs
             WHERE action = 'reseller_tier.product_prices' AND entity_id = ${tierId}`,
      );
      expect(audits).toHaveLength(1);
      expect(audits[0]?.before).toEqual({ prices: [{ productId, price: null }] });
      expect(audits[0]?.after).toEqual({
        prices: [{ productId, price: { amount: '800000', currency: 'IRT' } }],
      });
      await expect(
        setPrices(tierId, [{ productId, price: money(1n, 'IRT') }], idem),
      ).rejects.toMatchObject({ code: PLATFORM_ERROR_CODES.IDEMPOTENCY_PAYLOAD_MISMATCH });
    });

    it('refuses the write to an actor without resellers.edit', async () => {
      const tierId = await tableTier();
      const productId = await product(1_000_000n);
      const viewer = adminActorFor(
        await createAdmin(ctx.container, tenantA, {
          username: 'finance-tp',
          roleKeys: ['finance'],
        }),
      );
      await expect(
        ctx.container.resellersAdmin.setProductPrices(tenantA, viewer, {
          idempotencyKey: key(),
          tierId,
          prices: [{ productId, price: money(800_000n, 'IRT') }],
        }),
      ).rejects.toMatchObject({ kind: 'PERMISSION_DENIED' });
      expect(
        (
          await rows<{ n: number }>(
            sql`SELECT count(*)::int AS n FROM audit_logs
                 WHERE action = 'reseller_tier.product_prices' AND result <> 'SUCCESS'`,
          )
        )[0]?.n,
        'the denial is audited',
      ).toBe(1);
      expect(
        (
          await rows<{ n: number }>(
            sql`SELECT count(*)::int AS n FROM reseller_tier_product_prices`,
          )
        )[0]?.n,
      ).toBe(0);
    });

    it('refuses a zero price in the database itself', async () => {
      const tierId = await tableTier();
      const productId = await product(1_000_000n);
      await expect(
        ctx.container.database.db.execute(sql`
          INSERT INTO reseller_tier_product_prices (tenant_id, tier_id, product_id, price_amount, price_currency)
          VALUES (${tenantA.tenantId}, ${tierId}, ${productId}, 0, 'IRT')`),
      ).rejects.toThrow();
    });
  });
});
