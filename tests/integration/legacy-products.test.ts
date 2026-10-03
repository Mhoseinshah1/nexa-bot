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
  ): Promise<ProductId> {
    const created = await products.create(scope, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن ده گیگ',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: scope === tenantA ? (panelRenew as PanelId) : null,
        categoryId: (scope === tenantA
          ? SEED_IDS.categoryA
          : SEED_IDS.categoryB) as ProductCategoryId,
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

  it('keeps tenants apart: one shape is two products, and no tenant reads the other', async () => {
    await publicProduct(35_000n, { trafficGb: 10n, days: 30 }, tenantB);
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
