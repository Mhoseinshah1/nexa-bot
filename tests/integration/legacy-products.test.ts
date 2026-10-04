import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BYTES_PER_GB,
  EMPTY_PRODUCT_DISPLAY,
  isNexaError,
  money,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { unorderableReason } from '../../apps/api/src/modules/commerce/catalog/application/catalog-visibility';
import { legacyShapeAdoption } from '../../apps/api/src/modules/commerce/catalog/application/legacy-product.service';
import {
  legacyShapeKey,
  type LegacyShapeInput,
} from '../../apps/api/src/modules/commerce/catalog/application/legacy-shape';
import {
  SEED_IDS,
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
  tenantB,
  type TestContext,
} from './harness';

/**
 * Program Item 14: hidden legacy products, against real PostgreSQL through the shipped
 * container (`docs/legacy-migration/hidden-legacy-products.md`).
 *
 * What is asserted is the set §17 of the program names: excluded from the customer
 * catalogue, referenced by a service, renewed at the CURRENT tariff and never the legacy
 * price, one product per shape whatever the rerun, custom shapes handled, and tenant
 * isolation — plus the explicit UNRESOLVED state and the database guard that keeps the
 * product hidden.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

/** The most frequent normal shape the earlier audit saw: bac6 / 10GB / 30d. */
const BAC6_10GB: LegacyShapeInput = {
  codePanel: 'bac6',
  volume: '10',
  serviceTime: '30',
  timeUnit: null,
  isCustom: 0,
};
/** Its historical price, which must never become the tariff. */
const LEGACY_PRICE = 29_000n;

describe('hidden legacy products', () => {
  let ctx: TestContext;
  let products: DrizzleProductRepository;
  let owner: ActorContext;
  let ownerB: ActorContext;
  let observer: ActorContext;
  let panelRenew: string;
  let n = 0;
  const key = (): string => `legacy-key-${String((n += 1))}`;

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    products = new DrizzleProductRepository(ctx.container.database.db);
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-legacy', roleKeys: ['owner'] }),
    );
    ownerB = adminActorFor(
      await createAdmin(ctx.container, tenantB, {
        username: 'owner-legacy-b',
        roleKeys: ['owner'],
      }),
    );
    observer = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'obs-legacy', roleKeys: ['observer'] }),
    );
    const renewable = await ctx.container.panels.create(tenantA, owner, {
      name: 'Panel Renew',
      providerType: 'marzban',
      baseUrl: 'https://renew.example.test',
      credentials: { username: 'nexa', password: 'not-a-real-password' },
      activation: { proxyProtocols: ['vless'], inboundTags: { vless: ['VLESS TCP'] } },
      idempotencyKey: 'panel-legacy-create',
    });
    panelRenew = renewable.view.panel.id;
  });

  // ------------------------------------------------------------------ fixtures

  const ensure = (input: LegacyShapeInput, scope: TenantContext = tenantA, actor = owner) =>
    ctx.container.legacyProducts.ensureShape(scope, actor, {
      idempotencyKey: key(),
      legacy: input,
    });

  async function ensured(input: LegacyShapeInput, scope: TenantContext = tenantA, actor = owner) {
    const result = await ensure(input, scope, actor);
    if (result.outcome === 'UNMAPPABLE') throw new Error(`unmappable: ${result.reason}`);
    return result.shape;
  }

  const resolveMatch = (shapeId: string, scope: TenantContext = tenantA, actor = owner) =>
    ctx.container.legacyProducts.resolveTariff(scope, actor, {
      idempotencyKey: key(),
      shapeId,
      request: { kind: 'MATCH' },
    });

  /** A public, ACTIVE, categorised product: what "the current NEXA tariff" is. */
  async function publicProduct(
    price: bigint,
    spec: { trafficGb: bigint; days: number } = { trafficGb: 10n, days: 30 },
    scope: TenantContext = tenantA,
    placement: { categoryId?: string; panelId?: string | null } = {},
  ): Promise<ProductId> {
    const created = await products.create(scope, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن ده گیگ',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: (placement.panelId !== undefined
          ? placement.panelId
          : scope === tenantA
            ? panelRenew
            : null) as PanelId | null,
        categoryId: (placement.categoryId ??
          (scope === tenantA ? SEED_IDS.categoryA : SEED_IDS.categoryB)) as ProductCategoryId,
        specification: {
          durationDays: spec.days,
          trafficBytes: spec.trafficGb * BYTES_PER_GB,
          deviceLimit: null,
        },
        price: money(price, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: ctx.container.clock.now(),
    });
    await products.setStatus(scope, created.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    return created.id;
  }

  const setPrice = (productId: string, amount: bigint) =>
    ctx.container.database.db.execute(
      sql`UPDATE products SET price_amount = ${amount} WHERE id = ${productId}`,
    );

  async function customer(telegramUserId: string): Promise<UserId> {
    const { customer: record } = await ctx.container.customers.resolveFromUpdate(
      tenantA,
      systemActor(`resolve-${telegramUserId}`),
      {
        idempotencyKey: `resolve-${telegramUserId}`,
        telegramUserId,
        from: { id: Number(telegramUserId), first_name: 'زهرا' },
        botInstanceId: BOT_A,
      },
    );
    return record.id;
  }

  /**
   * A service that REFERENCES the hidden product — the shape P6 will write. Direct SQL,
   * because adoption is P6 and on hold: the creating order is an ordinary purchase draft
   * (the trigger requires one), and the service row names the hidden product.
   */
  async function legacyService(customerId: UserId, hiddenProductId: string): Promise<string> {
    const carrier = await publicProduct(99_000n, { trafficGb: 1n, days: 1 });
    const k = key();
    const order = await ctx.container.orders.createDraft(tenantA, systemActor(k), {
      idempotencyKey: `${k}-carrier`,
      customerId,
      productId: carrier,
    });
    const id = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO services (id, tenant_id, customer_id, order_id, panel_id, product_id,
                            provider_username, subscription_ref, provider_client_id,
                            traffic_limit_bytes, state, provisioned_at, expires_at)
      VALUES (${id}, ${tenantA.tenantId}, ${customerId}, ${order.id},
              ${panelRenew}, ${hiddenProductId}, ${`legacy${String(n)}`},
              ${Math.random().toString(16).slice(2).padEnd(32, '0').slice(0, 32)},
              ${ctx.container.ids.uuid()}, ${10n * BYTES_PER_GB}, 'ACTIVE', now(),
              now() + interval '30 days')`);
    return id;
  }

  const renewalTotal = async (customerId: UserId, serviceId: string): Promise<bigint> => {
    const k = key();
    const { order } = await ctx.container.commercialActions.draft(
      tenantA,
      systemActor(k),
      customerId,
      { serviceId, kind: 'RENEW', idempotencyKey: `${k}-quote` },
    );
    return order.totals.total.amountMinor;
  };

  const count = async (query: ReturnType<typeof sql>): Promise<number> => {
    const rows = (await ctx.container.database.db.execute(query as never)) as unknown as {
      rows: { n: number }[];
    };
    return rows.rows[0]?.n ?? 0;
  };

  /** Holds a lock in an outside transaction until `release` is called. */
  async function hold(statement: ReturnType<typeof sql>): Promise<{
    release: () => void;
    done: Promise<void>;
  }> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => (locked = resolve));
    const done = ctx.container.database.db.transaction(async (tx) => {
      await tx.execute(statement as never);
      locked();
      await gate;
    });
    await holding;
    return { release, done };
  }

  /** Waits until `expected` sessions are queued on an advisory lock — the barrier. */
  async function awaitAdvisoryWaiters(expected: number): Promise<void> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const waiting = await count(
        sql`SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted AND locktype = 'advisory'`,
      );
      if (waiting >= expected) return;
      if (Date.now() > deadline) throw new Error('the ensures never waited on the shape lock.');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  async function refusal(promise: Promise<unknown>): Promise<string> {
    try {
      await promise;
    } catch (error) {
      if (isNexaError(error)) return error.code;
      if (error instanceof Error) {
        // drizzle wraps the driver's error; the database's own message is the cause.
        const cause = (error as { cause?: unknown }).cause;
        return cause instanceof Error ? `${error.message} ${cause.message}` : error.message;
      }
      throw error;
    }
    throw new Error('expected a refusal, and the call succeeded');
  }

  // --------------------------------------------------------------- the cases

  it('creates ONE hidden, inactive, unpriced, uncategorised product per shape', async () => {
    const shape = await ensured(BAC6_10GB);
    const product = await products.findById(tenantA, shape.productId);
    expect(product).toMatchObject({
      status: 'INACTIVE',
      audience: 'HIDDEN',
      categoryId: null,
      panelId: null,
      price: null,
      specification: { durationDays: 30, trafficBytes: 10n * BYTES_PER_GB, deviceLimit: null },
    });
    expect(shape).toMatchObject({
      tariffStatus: 'UNRESOLVED',
      unresolvedReason: 'NOT_YET_RESOLVED',
      legacyCodePanel: 'bac6',
      isCustom: false,
    });
  });

  it('does not duplicate a shape: reruns, other spellings and other historical prices', async () => {
    const first = await ensured(BAC6_10GB);
    const again = await ensure({ ...BAC6_10GB, volume: 10, serviceTime: ' 30 ', timeUnit: 'days' });
    // A historical price is not even an input; carrying one changes nothing.
    const pricier = await ensure({ ...BAC6_10GB, price_product: '57000' } as LegacyShapeInput);
    expect(again).toMatchObject({ outcome: 'EXISTING', shape: { id: first.id } });
    expect(pricier).toMatchObject({ outcome: 'EXISTING', shape: { productId: first.productId } });
    expect(await count(sql`SELECT count(*)::int AS n FROM legacy_product_shapes`)).toBe(1);
    expect(
      await count(sql`SELECT count(*)::int AS n FROM products WHERE audience = 'HIDDEN'`),
    ).toBe(1);
  });

  it('creates one product when the same shape is ensured concurrently', async () => {
    /*
     * A real interleaving, not a hopeful Promise.all: an outside transaction holds the
     * shape's advisory lock, and both ensures are released only once BOTH are waiting on
     * it — each has already passed its idempotency read. Without the lock neither waits,
     * the barrier never fills, and this case fails: the mutation that proves it.
     */
    const keyed = legacyShapeKey(BAC6_10GB);
    if (!keyed.ok) throw new Error('expected a key');
    const { release, done } = await hold(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`legacy-shape:${String(tenantA.tenantId)}:${keyed.key}`}, 0))`,
    );
    const racing = Promise.all([ensure(BAC6_10GB), ensure(BAC6_10GB)]);
    await awaitAdvisoryWaiters(2);
    release();
    await done;
    const results = await racing;
    expect(results.map((r) => r.outcome).sort()).toEqual(['CREATED', 'EXISTING']);
    expect(
      await count(sql`SELECT count(*)::int AS n FROM products WHERE audience = 'HIDDEN'`),
    ).toBe(1);
    expect(await count(sql`SELECT count(*)::int AS n FROM legacy_product_shapes`)).toBe(1);
  });

  it('separates a custom shape from a normal one of the same size', async () => {
    const normal = await ensured(BAC6_10GB);
    const custom = await ensured({ ...BAC6_10GB, isCustom: 1 });
    expect(custom.productId).not.toBe(normal.productId);
    expect(custom.isCustom).toBe(true);
  });

  it('writes nothing for a shape it cannot map, and says why', async () => {
    expect(await ensure({ ...BAC6_10GB, timeUnit: 'month' })).toEqual({
      outcome: 'UNMAPPABLE',
      reason: 'TIME_UNIT_UNKNOWN',
    });
    expect(await ensure({ ...BAC6_10GB, volume: '0' })).toEqual({
      outcome: 'UNMAPPABLE',
      reason: 'VOLUME_ZERO',
    });
    expect(await count(sql`SELECT count(*)::int AS n FROM legacy_product_shapes`)).toBe(0);
    expect(await count(sql`SELECT count(*)::int AS n FROM products`)).toBe(0);
  });

  it('stays UNRESOLVED, inactive and not adoptable when there is no current tariff', async () => {
    const shape = await ensured(BAC6_10GB);
    const result = await resolveMatch(shape.id);
    expect(result.finding).toBe('NO_CURRENT_TARIFF');
    expect(result.shape).toMatchObject({
      tariffStatus: 'UNRESOLVED',
      unresolvedReason: 'NO_CURRENT_TARIFF',
    });
    expect(result.product).toMatchObject({ status: 'INACTIVE', price: null });
  });

  it('refuses to guess between two current prices', async () => {
    await publicProduct(35_000n);
    await publicProduct(40_000n);
    const shape = await ensured(BAC6_10GB);
    const result = await resolveMatch(shape.id);
    expect(result.finding).toBe('AMBIGUOUS_TARIFF');
    expect(result.shape.unresolvedReason).toBe('AMBIGUOUS_TARIFF');
    expect(result.product.price).toBeNull();
  });

  it('takes no tariff from a product nobody can buy now: a withdrawn category or no panel', async () => {
    /*
     * "The current NEXA tariff" is the price a customer can buy this shape at TODAY. A
     * product the operator withdrew by deactivating its category, or one with no panel to
     * deliver on, is refused by `unorderableReason` for every new purchase — its price is
     * history, not a tariff, and adopting a legacy service at it is a guessed tariff.
     */
    const withdrawn = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(
      sql`INSERT INTO product_categories (id, tenant_id, name, status)
          VALUES (${withdrawn}, ${tenantA.tenantId}, 'پلن‌های قدیمی', 'INACTIVE')`,
    );
    await publicProduct(35_000n, { trafficGb: 10n, days: 30 }, tenantA, { categoryId: withdrawn });
    await publicProduct(36_000n, { trafficGb: 10n, days: 30 }, tenantA, { panelId: null });
    const shape = await ensured(BAC6_10GB);
    const none = await resolveMatch(shape.id);
    expect(none.finding).toBe('NO_CURRENT_TARIFF');
    expect(none.product).toMatchObject({ status: 'INACTIVE', price: null });

    // Beside a product that IS on sale, the withdrawn ones are not a second price.
    const onSale = await publicProduct(40_000n);
    const matched = await resolveMatch(shape.id);
    expect(matched).toMatchObject({
      finding: 'MATCHED',
      shape: { tariffSourceProductId: onSale },
      product: { price: money(40_000n, 'IRT') },
    });
  });

  it('renews at the CURRENT tariff, never the historical price, and follows it on re-resolution', async () => {
    const tariff = await publicProduct(35_000n);
    const shape = await ensured(BAC6_10GB);
    const resolved = await resolveMatch(shape.id);
    expect(resolved).toMatchObject({
      finding: 'MATCHED',
      shape: {
        tariffStatus: 'RESOLVED',
        resolution: 'MATCHED_PUBLIC_PRODUCT',
        tariffSourceProductId: tariff,
      },
      product: { status: 'ACTIVE', audience: 'HIDDEN', price: money(35_000n, 'IRT') },
    });

    const alice = await customer('901401');
    const serviceId = await legacyService(alice, shape.productId);
    const first = await renewalTotal(alice, serviceId);
    expect(first).toBe(35_000n);
    expect(first).not.toBe(LEGACY_PRICE);

    // The public tariff moves; the next resolution carries it to the hidden product.
    await setPrice(tariff, 42_000n);
    const resynced = await resolveMatch(shape.id);
    expect(resynced).toMatchObject({ finding: 'MATCHED', changed: true });
    expect(await renewalTotal(alice, serviceId)).toBe(42_000n);
  });

  it('keeps an accepted tariff when a later run finds none, rather than withdrawing renewals', async () => {
    const tariff = await publicProduct(35_000n);
    const shape = await ensured(BAC6_10GB);
    await resolveMatch(shape.id);
    await products.setStatus(tenantA, tariff, 'ACTIVE', 'INACTIVE', ctx.container.clock.now());
    const later = await resolveMatch(shape.id);
    expect(later).toMatchObject({
      finding: 'NO_CURRENT_TARIFF',
      changed: false,
      shape: { tariffStatus: 'RESOLVED' },
      product: { status: 'ACTIVE', price: money(35_000n, 'IRT') },
    });
  });

  it('lets an operator state the tariff of a custom shape, with a reason, and it renews', async () => {
    const custom = await ensured({ ...BAC6_10GB, isCustom: 1, volume: '17', serviceTime: '45' });
    expect((await resolveMatch(custom.id)).finding).toBe('NO_CURRENT_TARIFF');

    expect(
      await refusal(
        ctx.container.legacyProducts.resolveTariff(tenantA, owner, {
          idempotencyKey: key(),
          shapeId: custom.id,
          request: { kind: 'STATED', price: money(60_000n, 'IRT'), reason: '  ' },
        }),
      ),
    ).toBe('commerce.request_invalid');

    const stated = await ctx.container.legacyProducts.resolveTariff(tenantA, owner, {
      idempotencyKey: key(),
      shapeId: custom.id,
      request: { kind: 'STATED', price: money(60_000n, 'IRT'), reason: 'تعرفه فعلی سرویس دلخواه' },
    });
    expect(stated).toMatchObject({
      finding: 'STATED',
      shape: {
        tariffStatus: 'RESOLVED',
        resolution: 'OPERATOR_STATED',
        tariffSourceProductId: null,
      },
    });

    const bob = await customer('901402');
    const serviceId = await legacyService(bob, custom.productId);
    expect(await renewalTotal(bob, serviceId)).toBe(60_000n);

    const audit = await count(
      sql`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'legacy.product_shape.resolve'
            AND reason IS NOT NULL`,
    );
    expect(audit).toBe(1);
  });

  it('is never listed and never sold as a new service, even once priced', async () => {
    await publicProduct(35_000n);
    const shape = await ensured(BAC6_10GB);
    await resolveMatch(shape.id);
    const carol = await customer('901403');

    const listed = await ctx.container.products.browse(tenantA, systemActor('browse'), 50, carol);
    expect(listed.items.map((p) => p.id)).not.toContain(shape.productId);
    const page = await ctx.container.products.browseCategory(
      tenantA,
      systemActor('browse-cat'),
      SEED_IDS.categoryA,
      50,
      0,
      carol,
    );
    expect(page.items.map((p) => p.id)).not.toContain(shape.productId);

    const k = key();
    await expect(
      ctx.container.orders
        .createDraft(tenantA, systemActor(k), {
          idempotencyKey: `${k}-direct`,
          customerId: carol,
          productId: shape.productId,
        })
        .then((order) =>
          ctx.container.orders.confirm(tenantA, systemActor(k), {
            idempotencyKey: `${k}-confirm`,
            customerId: carol,
            orderId: order.id,
          }),
        ),
    ).rejects.toThrow();
  });

  it('stays out of every catalogue audience, customer and reseller, even once bound to a panel', async () => {
    /*
     * The worst case an operator can reach: the shape resolved (ACTIVE, priced) and a
     * panel bound to the hidden product through an ordinary product edit. A category
     * cannot be given (the database guard), so `audience = HIDDEN` is then the ONLY thing
     * between it and a listing — and it must hold for every audience the catalogue knows,
     * including a reseller whose tier names the product's own id.
     */
    await publicProduct(35_000n);
    const shape = await ensured(BAC6_10GB);
    await resolveMatch(shape.id);
    await ctx.container.database.db.execute(
      sql`UPDATE products SET panel_id = ${panelRenew} WHERE id = ${shape.productId}`,
    );
    const audiences = [
      { kind: 'CUSTOMER' },
      { kind: 'RESELLER', productIds: 'ALL', categoryIds: 'ALL' },
      { kind: 'RESELLER', productIds: [shape.productId], categoryIds: [] },
    ] as const;
    for (const audience of audiences) {
      const catalogue = await products.listCatalog(tenantA, 100, [panelRenew], audience);
      expect(
        catalogue.items.map((p) => p.id),
        JSON.stringify(audience),
      ).not.toContain(shape.productId);
      if (audience.kind === 'CUSTOMER' || audience.productIds === 'ALL') {
        // The control: the public product beside it IS listed, so the query is live.
        expect(catalogue.items.length).toBeGreaterThan(0);
      }
      const page = await products.listCustomerProductsInCategory(
        tenantA,
        SEED_IDS.categoryA,
        100,
        0,
        [panelRenew],
        audience,
      );
      expect(page.items.map((p) => p.id)).not.toContain(shape.productId);
    }
    // And a direct reference still cannot buy it new, whoever buys.
    const stored = await products.findById(tenantA, shape.productId);
    if (stored === null) throw new Error('expected the hidden product');
    expect(stored).toMatchObject({ status: 'ACTIVE', audience: 'HIDDEN' });
    expect(unorderableReason(stored, null, 'CUSTOMER')).toBe('NOT_CATEGORISED');
    expect(unorderableReason(stored, null, 'RESELLER')).toBe('NOT_CATEGORISED');
  });

  it('gives P6 a closed manual-review reason for every shape it may not adopt', async () => {
    const shape = await ensured(BAC6_10GB);
    const product = await products.findById(tenantA, shape.productId);
    expect(legacyShapeAdoption(null, null)).toEqual({ adoptable: false, reason: 'NO_SHAPE' });
    expect(legacyShapeAdoption(shape, product)).toEqual({
      adoptable: false,
      reason: 'NOT_YET_RESOLVED',
    });
    const none = await resolveMatch(shape.id);
    expect(legacyShapeAdoption(none.shape, none.product)).toEqual({
      adoptable: false,
      reason: 'NO_CURRENT_TARIFF',
    });
    await publicProduct(35_000n);
    await publicProduct(40_000n);
    const ambiguous = await resolveMatch(shape.id);
    expect(legacyShapeAdoption(ambiguous.shape, ambiguous.product)).toEqual({
      adoptable: false,
      reason: 'AMBIGUOUS_TARIFF',
    });
    // Never a price invented for it: still unpriced and inactive.
    expect(ambiguous.product).toMatchObject({ status: 'INACTIVE', price: null });

    const stated = await ctx.container.legacyProducts.resolveTariff(tenantA, owner, {
      idempotencyKey: key(),
      shapeId: shape.id,
      request: { kind: 'STATED', price: money(38_000n, 'IRT'), reason: 'دو قیمت فعلی؛ بررسی شد' },
    });
    expect(legacyShapeAdoption(stated.shape, stated.product)).toEqual({ adoptable: true });
    // An operator withdrawing the hidden product takes it out of adoption again.
    await products.setStatus(
      tenantA,
      shape.productId,
      'ACTIVE',
      'INACTIVE',
      ctx.container.clock.now(),
    );
    const withdrawn = await products.findById(tenantA, shape.productId);
    expect(legacyShapeAdoption(stated.shape, withdrawn)).toEqual({
      adoptable: false,
      reason: 'PRODUCT_NOT_ADOPTABLE',
    });
  });

  it('a stated tariff yields to a current public one once it exists (renewal follows the CURRENT tariff)', async () => {
    /*
     * STATED is the exit for a shape NEXA does not sell. Once NEXA does sell it, the
     * owner's rule — renew at the current NEXA tariff — names that price, and a MATCH
     * moves the shape onto it. Pinned so the behaviour is a decision, not an accident.
     */
    const shape = await ensured(BAC6_10GB);
    await ctx.container.legacyProducts.resolveTariff(tenantA, owner, {
      idempotencyKey: key(),
      shapeId: shape.id,
      request: { kind: 'STATED', price: money(30_000n, 'IRT'), reason: 'هنوز فروخته نمی‌شود' },
    });
    const tariff = await publicProduct(35_000n);
    const moved = await resolveMatch(shape.id);
    expect(moved).toMatchObject({
      finding: 'MATCHED',
      changed: true,
      shape: { resolution: 'MATCHED_PUBLIC_PRODUCT', tariffSourceProductId: tariff },
      product: { price: money(35_000n, 'IRT') },
    });
  });

  it('refuses both writes once the tenant has stopped accepting work, and writes nothing', async () => {
    const shape = await ensured(BAC6_10GB);
    await ctx.container.database.db.execute(
      sql`UPDATE tenants SET status = 'STOPPED' WHERE id = ${tenantA.tenantId}`,
    );
    expect(await refusal(ensure({ ...BAC6_10GB, volume: '20' }))).toBe('commerce.request_invalid');
    expect(await refusal(resolveMatch(shape.id))).toBe('commerce.request_invalid');
    expect(await count(sql`SELECT count(*)::int AS n FROM legacy_product_shapes`)).toBe(1);
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM legacy_product_shapes WHERE tariff_status = 'RESOLVED' OR unresolved_reason <> 'NOT_YET_RESOLVED'`,
      ),
    ).toBe(0);
  });

  it('refuses, at the database, an edit that would list or categorise it', async () => {
    const shape = await ensured(BAC6_10GB);
    const db = ctx.container.database.db;
    expect(
      await refusal(
        db.execute(sql`UPDATE products SET audience = 'EVERYONE' WHERE id = ${shape.productId}`),
      ),
    ).toMatch(/legacy shape/u);
    expect(
      await refusal(
        db.execute(
          sql`UPDATE products SET category_id = ${SEED_IDS.categoryA} WHERE id = ${shape.productId}`,
        ),
      ),
    ).toMatch(/legacy shape/u);
    // An ordinary product is untouched by the guard.
    const ordinary = await publicProduct(35_000n);
    await db.execute(sql`UPDATE products SET audience = 'HIDDEN' WHERE id = ${ordinary}`);
    await db.execute(sql`UPDATE products SET audience = 'EVERYONE' WHERE id = ${ordinary}`);
  });

  it("refuses, at the database, a change to the shape's traffic or duration", async () => {
    /*
     * The two figures ARE the shape: the shape row records them, the tariff is matched on
     * them, and a renewal buys them. An edit through the catalogue would split the three.
     */
    const shape = await ensured(BAC6_10GB);
    const db = ctx.container.database.db;
    expect(
      await refusal(
        db.execute(sql`UPDATE products SET duration_days = 60 WHERE id = ${shape.productId}`),
      ),
    ).toMatch(/legacy shape/u);
    expect(
      await refusal(
        db.execute(
          sql`UPDATE products SET traffic_bytes = ${20n * BYTES_PER_GB} WHERE id = ${shape.productId}`,
        ),
      ),
    ).toMatch(/legacy shape/u);
    // Writing the same figures back, the price and the status all stay allowed.
    await db.execute(
      sql`UPDATE products SET duration_days = 30, traffic_bytes = ${10n * BYTES_PER_GB},
                              title = 'تغییر نام' WHERE id = ${shape.productId}`,
    );
    const stored = await products.findById(tenantA, shape.productId);
    expect(stored?.specification).toMatchObject({
      durationDays: 30,
      trafficBytes: 10n * BYTES_PER_GB,
    });
    // An ordinary product's figures remain editable.
    const ordinary = await publicProduct(35_000n);
    await db.execute(
      sql`UPDATE products SET duration_days = 60, traffic_bytes = ${20n * BYTES_PER_GB} WHERE id = ${ordinary}`,
    );
    expect((await products.findById(tenantA, ordinary as ProductId))?.specification).toMatchObject({
      durationDays: 60,
      trafficBytes: 20n * BYTES_PER_GB,
    });
  });

  it('keeps tenants apart: one shape is two products, and no tenant reads the other', async () => {
    // Tenant B sells the shape on its own panel: a tariff needs somewhere to deliver.
    const panelB = await ctx.container.panels.create(tenantB, ownerB, {
      name: 'Panel B',
      providerType: 'marzban',
      baseUrl: 'https://renew-b.example.test',
      credentials: { username: 'nexa', password: 'not-a-real-password' },
      activation: { proxyProtocols: ['vless'], inboundTags: { vless: ['VLESS TCP'] } },
      idempotencyKey: 'panel-legacy-create-b',
    });
    await publicProduct(35_000n, { trafficGb: 10n, days: 30 }, tenantB, {
      panelId: panelB.view.panel.id,
    });
    const a = await ensured(BAC6_10GB);
    const b = await ensured(BAC6_10GB, tenantB, ownerB);
    expect(a.productId).not.toBe(b.productId);
    expect(a.shapeKey).toBe(b.shapeKey);

    // Tenant B's public tariff is not tenant A's.
    expect((await resolveMatch(a.id)).finding).toBe('NO_CURRENT_TARIFF');
    expect((await resolveMatch(b.id, tenantB, ownerB)).finding).toBe('MATCHED');

    // And A cannot address B's shape.
    expect(await refusal(resolveMatch(b.id))).toBe('commerce.product_not_found');
  });

  it('denies an actor without catalog.edit, and writes nothing', async () => {
    expect(await refusal(ensure(BAC6_10GB, tenantA, observer))).toMatch(/permission/u);
    expect(await count(sql`SELECT count(*)::int AS n FROM legacy_product_shapes`)).toBe(0);
    const shape = await ensured(BAC6_10GB);
    expect(await refusal(resolveMatch(shape.id, tenantA, observer))).toMatch(/permission/u);
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM audit_logs WHERE action LIKE 'legacy.product_shape.%' AND result = 'DENIED'`,
      ),
    ).toBe(2);
  });
});
