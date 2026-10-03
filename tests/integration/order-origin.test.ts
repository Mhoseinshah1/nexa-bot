import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ActorContext, OrderId } from '@nexa/contracts';
import { DrizzleOrderRepository } from '../../apps/api/src/modules/commerce/orders/infrastructure/drizzle-order.repository';
import { DrizzleDiscountRepository } from '../../apps/api/src/modules/commerce/pricing/infrastructure/drizzle-discount.repository';
import { DrizzleReferralSignupGiftRepository } from '../../apps/api/src/modules/commerce/referrals/infrastructure/drizzle-referral-signup-gift.repository';
import { AudienceFixtures } from './audience-fixtures';
import { insertLegacyAdoption, insertLegacyAdoptionOrder } from './legacy-adoption-fixture';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
  tenantB,
  type TestContext,
} from './harness';

/**
 * Migration P3 — `orders.origin` and `LEGACY_ADOPTION` (`docs/migration-order-origin.md`).
 *
 * An adopted legacy service needs an order (`services.order_id` NOT NULL unique,
 * `orders.panel_id` NOT NULL). That order keeps `purpose = NEW_SERVICE`, is marked
 * `origin = LEGACY_ADOPTION`, and must be invisible to every figure of sales and revenue
 * and inert to every lane that acts on a paid order. There is no write path (P6 HOLD);
 * the rows are written by `legacy-adoption-fixture.ts`.
 */
describe('Migration P3: orders.origin and LEGACY_ADOPTION', () => {
  let ctx: TestContext;
  let fx: AudienceFixtures;
  let owner: ActorContext;
  let orders: DrizzleOrderRepository;
  let panel: string;
  let product: string;
  let n = 0;

  const run = (query: ReturnType<typeof sql>) => ctx.container.database.db.execute(query);
  const count = async (query: ReturnType<typeof sql>): Promise<number> => {
    const [row] = (await run(query)).rows as { n: number }[];
    return Number(row?.n ?? 0);
  };
  const tid = (): string => `7300${String((n += 1)).padStart(4, '0')}`;

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 600_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    fx = new AudienceFixtures(ctx, tenantA.tenantId as string);
    orders = new DrizzleOrderRepository(ctx.container.database.db);
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-origin', roleKeys: ['owner'] }),
    );
    panel = await fx.panel('origin');
    product = await fx.product(panel, 'Gold');
  });

  async function adoption(tenant = tenantA, f = fx, p = panel, prod = product) {
    const customerId = await f.customer({ telegramUserId: tid() });
    const adopted = await insertLegacyAdoption(ctx, {
      tenantId: tenant.tenantId as string,
      customerId,
      panelId: p,
      productId: prod,
      providerUsername: `legacy_user_${String(n)}`,
    });
    return { customerId, ...adopted };
  }

  // ---------------------------------------------------------------------------
  // Schema
  // ---------------------------------------------------------------------------

  it('adds a NOT NULL origin defaulting to STANDARD, constrained, and immutable', async () => {
    const [column] = (
      await run(sql`SELECT is_nullable, column_default FROM information_schema.columns
        WHERE table_name = 'orders' AND column_name = 'origin'`)
    ).rows as { is_nullable: string; column_default: string }[];
    expect(column).toEqual({ is_nullable: 'NO', column_default: "'STANDARD'::text" });
    expect(
      await count(sql`SELECT count(*)::int AS n FROM pg_constraint
        WHERE conname IN ('orders_origin_check', 'orders_legacy_adoption_shape_check')`),
    ).toBe(2);
    expect(
      await count(sql`SELECT count(*)::int AS n FROM pg_trigger
        WHERE tgname = 'orders_origin_immutable' AND NOT tgisinternal`),
    ).toBe(1);
  });

  const originOf = async (orderId: string): Promise<string | undefined> =>
    (
      (await run(sql`SELECT origin FROM orders WHERE id = ${orderId}`)).rows as {
        origin: string;
      }[]
    )[0]?.origin;

  it('gives an ordinary order the STANDARD origin without its writer naming one', async () => {
    const customerId = await fx.customer({ telegramUserId: tid() });
    // The fixture's INSERT names no origin, like every writer that predates the column.
    const orderId = await fx.order({ customerId, panelId: panel, productId: product });
    expect(await originOf(orderId)).toBe('STANDARD');
    // Every row: nothing is left without an origin.
    expect(await count(sql`SELECT count(*)::int AS n FROM orders WHERE origin IS NULL`)).toBe(0);
  });

  it('reads an adoption back as a NEW_SERVICE of LEGACY_ADOPTION origin, PAID and free', async () => {
    const { orderId } = await adoption();
    const read = await orders.findById(tenantA, orderId as OrderId);
    expect(read).toMatchObject({
      origin: 'LEGACY_ADOPTION',
      purpose: 'NEW_SERVICE',
      state: 'PAID',
    });
    expect(read?.totals.total.amountMinor).toBe(0n);
  });

  it('refuses an adoption that is priced, of another purpose, or refunded', async () => {
    const customerId = await fx.customer({ telegramUserId: tid() });
    const violates = expect.objectContaining({
      cause: expect.objectContaining({
        constraint: 'orders_legacy_adoption_shape_check',
      }) as unknown,
    }) as unknown;
    // The fixture writes on a raw `pg` client, whose error IS the database error.
    const violatesRaw = expect.objectContaining({
      constraint: 'orders_legacy_adoption_shape_check',
    }) as unknown;
    const base = {
      tenantId: tenantA.tenantId as string,
      customerId,
      panelId: panel,
      productId: product,
    };
    await expect(
      insertLegacyAdoptionOrder(ctx, { ...base, malformed: { total: 250_000n } }),
    ).rejects.toEqual(violatesRaw);
    await expect(
      insertLegacyAdoptionOrder(ctx, { ...base, malformed: { purpose: 'RENEW' } }),
    ).rejects.toEqual(violatesRaw);
    // Never refundable: there is no money of this installation's to give back.
    const { orderId } = await adoption();
    await expect(
      run(sql`UPDATE orders SET state = 'REFUNDED', refunded_at = now() WHERE id = ${orderId}`),
    ).rejects.toEqual(violates);
    expect((await orders.findById(tenantA, orderId as OrderId))?.state).toBe('PAID');
  });

  it('refuses to rewrite an origin in either direction', async () => {
    const { orderId } = await adoption();
    const customerId = await fx.customer({ telegramUserId: tid() });
    const standard = await fx.order({ customerId, panelId: panel, productId: product });
    const fixed = expect.objectContaining({
      cause: expect.objectContaining({
        message: expect.stringMatching(/orders\.origin is fixed/) as unknown,
      }) as unknown,
    }) as unknown;
    await expect(
      run(sql`UPDATE orders SET origin = 'STANDARD' WHERE id = ${orderId}`),
    ).rejects.toEqual(fixed);
    // A real sale (250 000, PAID) may not be turned into an adoption after the fact.
    await expect(
      run(sql`UPDATE orders SET origin = 'LEGACY_ADOPTION' WHERE id = ${standard}`),
    ).rejects.toEqual(fixed);
    expect(await originOf(orderId)).toBe('LEGACY_ADOPTION');
    expect(await originOf(standard)).toBe('STANDARD');
  });

  // ---------------------------------------------------------------------------
  // Reports
  // ---------------------------------------------------------------------------

  it('keeps an adoption out of every sales and revenue figure', async () => {
    // One real sale of 250 000 and one adoption, both today, on the same product.
    const buyer = await fx.customer({ telegramUserId: tid() });
    await fx.service({ customerId: buyer, panelId: panel, productId: product });
    await adoption();
    const request = { range: 'TODAY' as const };
    const reports = ctx.container.reports;

    const summary = await reports.summary(tenantA, owner, request);
    expect(summary.sales.current).toBe(1);
    expect(summary.successfulOrders.current).toBe(1);
    expect(summary.newBuyers.current).toBe(1);
    expect(summary.newServices.current).toBe(1);
    expect(summary.revenue.map((m) => [m.currency, m.current])).toEqual([['IRT', '250000']]);

    const dashboard = await reports.dashboard(tenantA, owner, request);
    expect(dashboard.selected.sales.current).toBe(1);
    expect(dashboard.today.sales.current).toBe(1);

    const financial = await reports.financial(tenantA, owner, request, 'DAY');
    expect(financial.totals).toHaveLength(1);
    expect(financial.totals[0]).toMatchObject({ salesCount: 1, sales: '250000' });

    const products = await reports.products(tenantA, owner, request, 'COUNT', {});
    expect(products.rows.map((r) => [r.title, r.orders])).toEqual([['plan', 1]]);

    const services = await reports.services(tenantA, owner, request);
    expect(services.newServices.current).toBe(1);
    // Traffic sold is the one sale's 50 GiB; the adoption's line is not traffic sold.
    expect(services.trafficSoldBytes).toBe('53687091200');
    // Both services are live, and the live count says so: it is not a sales figure.
    expect(services.activeServices).toBe(2);

    const drill = await reports.orders(tenantA, owner, request, {});
    expect(drill.response.rows).toHaveLength(1);
    expect(drill.response.rows[0]?.total).toBe('250000');

    const infrastructure = await reports.infrastructure(tenantA, owner, request);
    expect(JSON.stringify(infrastructure)).toContain('"servicesCreated":1');
  });

  it('does not let an adoption count as a referred purchase, even beside a delivered op', async () => {
    const referrer = await fx.customer({ telegramUserId: tid() });
    const { customerId: referee, orderId, serviceId } = await adoption();
    await fx.referral(referrer, referee);
    // The shape the delivered predicate looks for, present on purpose: only the origin stops it.
    await run(sql`INSERT INTO provisioning_operations
        (id, tenant_id, operation_id, service_id, panel_id, order_id, type, state, attempts,
         completed_at, announced_at)
      VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, 'a0a0a0a0a0a0a0a1', ${serviceId},
              ${panel}, ${orderId}, 'PROVISION', 'SUCCEEDED', 1, now(), now())`);
    const repo = new DrizzleReferralSignupGiftRepository(ctx.container.database.db);
    expect(await repo.referredPurchases(tenantA, referrer, 'IRT')).toEqual({ count: 0, total: 0n });
  });

  it('keeps an existing first-purchase query as it was: an adopted customer is not a first buyer', async () => {
    const { customerId } = await adoption();
    const discounts = new DrizzleDiscountRepository(ctx.container.database.db);
    expect(await discounts.isFirstPurchase(tenantA, customerId, null)).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Origin triggers nothing
  // ---------------------------------------------------------------------------

  it('starts no provisioning, cashback, commission or refund by being there', async () => {
    const { orderId, serviceId } = await adoption();
    ctx.container.setInstallationTenant(tenantA.tenantId);
    await ctx.container.provisionerLoop.tick();
    await ctx.container.provisionerLoop.tick();

    expect(await count(sql`SELECT count(*)::int AS n FROM provisioning_operations`)).toBe(0);
    expect(await count(sql`SELECT count(*)::int AS n FROM wallet_entries`)).toBe(0);
    expect(await count(sql`SELECT count(*)::int AS n FROM refunds`)).toBe(0);
    expect(await count(sql`SELECT count(*)::int AS n FROM order_cashback`)).toBe(0);
    expect(await count(sql`SELECT count(*)::int AS n FROM order_referral_commissions`)).toBe(0);
    const [service] = (
      await run(sql`SELECT state, provider_username FROM services WHERE id = ${serviceId}`)
    ).rows as { state: string; provider_username: string }[];
    expect(service?.state).toBe('ACTIVE');
    expect((await orders.findById(tenantA, orderId as OrderId))?.state).toBe('PAID');
  });

  // ---------------------------------------------------------------------------
  // Tenancy
  // ---------------------------------------------------------------------------

  it('keeps tenants apart: B’s adoption and B’s sale are invisible to A', async () => {
    const fxB = new AudienceFixtures(ctx, tenantB.tenantId as string);
    const panelB = await fxB.panel('b');
    const productB = await fxB.product(panelB, 'B');
    const { orderId } = await adoption(tenantB, fxB, panelB, productB);
    const buyerB = await fxB.customer({ telegramUserId: tid() });
    await fxB.order({ customerId: buyerB, panelId: panelB, productId: productB });

    expect(await orders.findById(tenantA, orderId as OrderId)).toBeNull();
    expect((await orders.findById(tenantB, orderId as OrderId))?.origin).toBe('LEGACY_ADOPTION');
    const summaryA = await ctx.container.reports.summary(tenantA, owner, { range: 'TODAY' });
    expect(summaryA.sales.current).toBe(0);

    // An adoption cannot name another tenant's customer or panel.
    const customerA = await fx.customer({ telegramUserId: tid() });
    await expect(
      insertLegacyAdoptionOrder(ctx, {
        tenantId: tenantB.tenantId as string,
        customerId: customerA,
        panelId: panelB,
        productId: productB,
      }),
    ).rejects.toBeDefined();
  });
});
