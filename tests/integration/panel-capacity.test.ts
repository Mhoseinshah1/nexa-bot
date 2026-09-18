import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  money,
  PANEL_UNHEALTHY_AFTER_FAILURES,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type PanelId,
  type ProductId,
  type UserId,
} from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import type { ProductRecord } from '../../apps/api/src/modules/commerce/catalog/application/ports';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  SEED_IDS,
  tenantA,
  tenantB,
  type TestContext,
} from './harness';

/**
 * A panel's capacity, and whether it may be sold onto at all.
 *
 * Every case here is about ONE of the two things that make this hard:
 *
 *   - the last slot is claimed BEFORE there is a service to count. Between a
 *     confirmation and a payment nothing but the reservation row represents the
 *     customer's claim, so a count-and-insert sells it twice. The concurrency
 *     cases force the interleaving rather than hoping for it.
 *   - eligibility is asked three times — catalogue, confirmation, settlement —
 *     and the interesting failures are the ones where two of the three
 *     disagree. So each is asserted separately, and the settlement one is
 *     asserted with the panel changed UNDERNEATH a confirmed order.
 *
 * Nothing here sleeps. Where two requests must be in flight together they are
 * started together and joined with `Promise.all`; where an expiry must have
 * passed, the row's `expires_at` is moved rather than time.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'panel-capacity:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

describe('panel capacity and sales eligibility', () => {
  let ctx: TestContext;
  let products: DrizzleProductRepository;
  let panelA: string;
  let panelForeign: string;
  let customerA: UserId;
  let customerB: UserId;
  let owner: ActorContext;
  let n = 0;
  const key = () => `panel-capacity-key-${(n += 1)}`;

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
    panelForeign = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelA}, ${tenantA.tenantId}, 'Panel A', 'sanaei', 'https://a.example.test', 'ACTIVE'),
             (${panelForeign}, ${tenantB.tenantId}, 'Panel B', 'sanaei', 'https://b.example.test', 'ACTIVE')`);
    customerA = await customer('900201');
    customerB = await customer('900202');
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-capacity', roleKeys: ['owner'] }),
    );
  });

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  async function customer(telegramUserId: string): Promise<UserId> {
    const { customer: record } = await ctx.container.customers.resolveFromUpdate(
      tenantA,
      systemActor(`resolve-${telegramUserId}`),
      {
        idempotencyKey: `resolve-${telegramUserId}`,
        telegramUserId,
        from: { id: Number(telegramUserId), first_name: 'مینا' },
        botInstanceId: BOT_A,
      },
    );
    return record.id;
  }

  async function activeProduct(panelId: string): Promise<ProductRecord> {
    const created = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن ظرفیت',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: panelId as PanelId,
        specification: { durationDays: 30, trafficBytes: 0n, deviceLimit: 1 },
        price: money(120_000n, 'IRT'),
      },
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, created.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    const after = await products.findById(tenantA, created.id);
    if (after === null) throw new Error('product vanished');
    return after;
  }

  /** A DRAFT, for a customer, against the panel under test. */
  async function draftFor(customerId: UserId, product: ProductRecord): Promise<string> {
    const k = key();
    const order = await ctx.container.orders.createDraft(tenantA, systemActor(k), {
      idempotencyKey: k,
      customerId,
      productId: product.id,
    });
    return order.id;
  }

  const confirm = (customerId: UserId, orderId: string, idempotencyKey = key()) =>
    ctx.container.orders.confirm(tenantA, systemActor(idempotencyKey), {
      idempotencyKey,
      customerId,
      orderId,
    });

  const setCap = (panelId: string, cap: number | null) =>
    ctx.container.database.db.execute(
      sql`UPDATE panels SET max_services = ${cap} WHERE id = ${panelId}`,
    );

  const setStatus = (panelId: string, status: string) =>
    ctx.container.database.db.execute(
      sql`UPDATE panels
             SET status = ${status},
                 archived_at = CASE WHEN ${status} = 'ARCHIVED' THEN now() ELSE NULL END
           WHERE id = ${panelId}`,
    );

  /**
   * A health row written directly, because what is under test is how the
   * DECISION reads it — not how a probe produces it. `panel-monitor.test.ts`
   * owns the probe-to-row half.
   */
  const setHealth = (
    panelId: string,
    state: string,
    streak: number,
    checkedAt: Date = ctx.container.clock.now(),
  ) =>
    ctx.container.database.db.execute(sql`
      INSERT INTO panel_health (panel_id, tenant_id, state, checked_at, latency_ms, failure,
                                unusable_streak)
      VALUES (${panelId}, ${tenantA.tenantId}, ${state}, ${checkedAt}, 5,
              ${state === 'HEALTHY' || state === 'DEGRADED' ? null : 'AUTHENTICATION_FAILED'},
              ${streak})
      ON CONFLICT (panel_id) DO UPDATE
         SET state = EXCLUDED.state, checked_at = EXCLUDED.checked_at,
             failure = EXCLUDED.failure, unusable_streak = EXCLUDED.unusable_streak`);

  /**
   * A service occupying a slot, written directly so no provider is involved.
   *
   * It needs a real product and a real order id because `services` references
   * both; the ORDER id is minted rather than a row, which the schema allows and
   * which keeps these fixtures from having to drive a whole purchase to place a
   * service that exists only to be counted.
   */
  async function placeService(panelId: string, state: string): Promise<void> {
    const product = await activeProduct(panelId);
    // A real DRAFT, because `services` references `(tenant_id, order_id,
    // customer_id)` as a triple — the composite reference that stops a service
    // naming one customer's order against another customer's account.
    const order = await draftFor(customerA, product);
    await ctx.container.database.db.execute(sql`
      INSERT INTO services (id, tenant_id, customer_id, order_id, panel_id, product_id,
                            provider_username, subscription_ref, provider_client_id,
                            traffic_limit_bytes, state, provisioned_at, terminated_at)
      VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, ${customerA},
              ${order}, ${panelId}, ${product.id},
              ${'u' + Math.random().toString(16).slice(2, 10)},
              ${Math.random().toString(16).slice(2).padEnd(32, '0').slice(0, 32)},
              ${ctx.container.ids.uuid()}, 0, ${state},
              ${state === 'PENDING_PROVISION' || state === 'UNRECONCILED' ? null : new Date()},
              ${state === 'TERMINATED' ? new Date() : null})`);
  }

  const reservations = async (panelId: string): Promise<number> => {
    const rows = (await ctx.container.database.db.execute(
      sql`SELECT count(*)::int AS n FROM panel_capacity_reservations WHERE panel_id = ${panelId}` as never,
    )) as unknown as { rows: { n: number }[] };
    return rows.rows[0]?.n ?? 0;
  };

  const capacityOf = async (panelId: string) =>
    ctx.container.panelCapacity.read(tenantA, panelId, ctx.container.clock.now());

  // -------------------------------------------------------------------------
  // Capacity arithmetic
  // -------------------------------------------------------------------------

  it('counts every service state that occupies a slot, and not TERMINATED', async () => {
    for (const state of ['PENDING_PROVISION', 'ACTIVE', 'SUSPENDED', 'EXPIRED', 'UNRECONCILED']) {
      await placeService(panelA, state);
    }
    await placeService(panelA, 'TERMINATED');

    const capacity = await capacityOf(panelA);
    // Five occupy, one does not. UNRECONCILED is the one that matters most:
    // this installation does not know whether the provider holds an account,
    // and counting it free is how a panel is oversold by exactly the services
    // nobody can account for.
    expect(capacity?.services).toBe(5);
    expect(capacity?.reservations).toBe(0);
    expect(capacity?.used).toBe(5);
  });

  it('a null cap is unlimited, and available is null rather than a large number', async () => {
    await setCap(panelA, null);
    await placeService(panelA, 'ACTIVE');
    const capacity = await capacityOf(panelA);
    expect(capacity?.maxServices).toBeNull();
    expect(capacity?.available).toBeNull();
  });

  it('floors available at zero when the cap is below current usage', async () => {
    await placeService(panelA, 'ACTIVE');
    await placeService(panelA, 'ACTIVE');
    await setCap(panelA, 1);
    const capacity = await capacityOf(panelA);
    expect(capacity?.used).toBe(2);
    // Not -1. A screen showing a negative is indistinguishable from a broken
    // counter, and the honest number of slots left is none.
    expect(capacity?.available).toBe(0);
  });

  // -------------------------------------------------------------------------
  // The reservation lifecycle
  // -------------------------------------------------------------------------

  it('takes exactly one slot when an order is confirmed', async () => {
    await setCap(panelA, 3);
    const product = await activeProduct(panelA);
    const order = await draftFor(customerA, product);

    await confirm(customerA, order);

    expect(await reservations(panelA)).toBe(1);
    const capacity = await capacityOf(panelA);
    expect(capacity?.services).toBe(0);
    expect(capacity?.reservations).toBe(1);
    expect(capacity?.used).toBe(1);
  });

  it('a replayed confirmation holds ONE slot, not two', async () => {
    await setCap(panelA, 1);
    const product = await activeProduct(panelA);
    const order = await draftFor(customerA, product);
    const shared = key();

    await confirm(customerA, order, shared);
    // The same command again. A retry, a double-tapped button, a second
    // replica: all of them must find the hold this order already owns rather
    // than be refused by a panel that filled up in between.
    await confirm(customerA, order, shared);

    expect(await reservations(panelA)).toBe(1);
  });

  it('refuses the last slot to the second of two concurrent confirmations', async () => {
    await setCap(panelA, 1);
    const product = await activeProduct(panelA);
    const first = await draftFor(customerA, product);
    const second = await draftFor(customerB, product);

    // Genuinely in flight together. The lock inside `reserve` is what makes one
    // of these wait; a count taken before that wait would see zero on both
    // sides and sell the slot twice.
    const settled = await Promise.allSettled([
      confirm(customerA, first),
      confirm(customerB, second),
    ]);

    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(await reservations(panelA)).toBe(1);
  });

  it('refuses a confirmation when services already fill the cap', async () => {
    await setCap(panelA, 1);
    await placeService(panelA, 'ACTIVE');
    const product = await activeProduct(panelA);
    const order = await draftFor(customerA, product);

    await expect(confirm(customerA, order)).rejects.toMatchObject({
      code: 'commerce.panel_not_eligible',
      details: { reason: 'AT_CAPACITY' },
    });
    expect(await reservations(panelA)).toBe(0);
  });

  it('an expired reservation stops counting immediately, with nothing having run', async () => {
    await setCap(panelA, 1);
    const product = await activeProduct(panelA);
    const first = await draftFor(customerA, product);
    await confirm(customerA, first);

    // The hold's own deadline, moved into the past. No sweeper, no process:
    // the capacity query filters on `expires_at`, which is what makes the
    // backstop true without anything running.
    await ctx.container.database.db.execute(
      sql`UPDATE panel_capacity_reservations SET expires_at = now() - interval '1 minute'`,
    );

    expect((await capacityOf(panelA))?.used).toBe(0);
    const second = await draftFor(customerB, product);
    await expect(confirm(customerB, second)).resolves.toMatchObject({
      state: 'AWAITING_PAYMENT',
    });
  });

  it('gives the slot back when the customer cancels their own order', async () => {
    await setCap(panelA, 1);
    const product = await activeProduct(panelA);
    const order = await draftFor(customerA, product);
    await confirm(customerA, order);
    expect(await reservations(panelA)).toBe(1);

    const k = key();
    await ctx.container.orders.cancelByCustomer(tenantA, systemActor(k), {
      idempotencyKey: k,
      customerId: customerA,
      orderId: order,
    });

    expect(await reservations(panelA)).toBe(0);
    expect((await capacityOf(panelA))?.used).toBe(0);
  });

  it('gives the slot back when the order expiry sweep closes the order', async () => {
    await setCap(panelA, 1);
    const product = await activeProduct(panelA);
    const order = await draftFor(customerA, product);
    await confirm(customerA, order);

    // The ORDER's deadline, not the reservation's: what is under test is that
    // the sweep releases, and a reservation that had already lapsed would
    // release nothing and prove nothing.
    await ctx.container.database.db.execute(
      sql`UPDATE orders SET expires_at = now() - interval '1 minute' WHERE id = ${order}`,
    );

    await ctx.container.paymentExpirySweep.runOnce(tenantA);

    expect(await reservations(panelA)).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Eligibility
  // -------------------------------------------------------------------------

  it('hides a product whose panel is disabled, and refuses it if asked anyway', async () => {
    const product = await activeProduct(panelA);
    await setStatus(panelA, 'DISABLED');

    const browsed = await ctx.container.products.browse(tenantA, systemActor(key()), 20);
    expect(browsed.items).toHaveLength(0);

    // The catalogue is a courtesy; this is the rule. An id travels in a
    // screenshot and a callback drawn a minute ago is still in the chat.
    const order = await draftFor(customerA, product);
    await expect(confirm(customerA, order)).rejects.toMatchObject({
      code: 'commerce.panel_not_eligible',
      details: { reason: 'DISABLED' },
    });
  });

  it('refuses an archived panel as ARCHIVED, never as at capacity', async () => {
    const product = await activeProduct(panelA);
    const order = await draftFor(customerA, product);
    await setCap(panelA, 1);
    await placeService(panelA, 'ACTIVE');
    await setStatus(panelA, 'ARCHIVED');

    // Both conditions hold. The operator's own DECISION is reported, because a
    // measurement must never be given in place of somebody's instruction.
    await expect(confirm(customerA, order)).rejects.toMatchObject({
      details: { reason: 'ARCHIVED' },
    });
  });

  it('keeps selling through one bad probe, and stops at the threshold', async () => {
    const product = await activeProduct(panelA);

    await setHealth(panelA, 'UNREACHABLE', PANEL_UNHEALTHY_AFTER_FAILURES - 1);
    const early = await draftFor(customerA, product);
    await expect(confirm(customerA, early)).resolves.toMatchObject({
      state: 'AWAITING_PAYMENT',
    });

    await setHealth(panelA, 'UNREACHABLE', PANEL_UNHEALTHY_AFTER_FAILURES);
    const late = await draftFor(customerB, product);
    await expect(confirm(customerB, late)).rejects.toMatchObject({
      details: { reason: 'UNHEALTHY' },
    });
  });

  it('never empties the catalogue because health is unchecked or stale', async () => {
    const product = await activeProduct(panelA);

    // Never probed. The absence of evidence, not evidence of absence — a fresh
    // installation whose monitor has not run must be able to sell.
    expect((await ctx.container.products.browse(tenantA, systemActor(key()), 20)).items).toHaveLength(
      1,
    );

    // Confirmed down, and OLD. A stopped monitor must not close every shop in
    // the installation: old evidence stops being evidence, it does not become
    // worse evidence.
    await setHealth(
      panelA,
      'UNREACHABLE',
      PANEL_UNHEALTHY_AFTER_FAILURES + 5,
      new Date(ctx.container.clock.now().getTime() - 24 * 60 * 60 * 1000),
    );
    expect((await ctx.container.products.browse(tenantA, systemActor(key()), 20)).items).toHaveLength(
      1,
    );
    const order = await draftFor(customerA, product);
    await expect(confirm(customerA, order)).resolves.toMatchObject({
      state: 'AWAITING_PAYMENT',
    });
  });

  it('a DEGRADED panel keeps selling: the credentials were accepted', async () => {
    const product = await activeProduct(panelA);
    await setHealth(panelA, 'DEGRADED', 0);
    expect((await ctx.container.products.browse(tenantA, systemActor(key()), 20)).items).toHaveLength(
      1,
    );
    const order = await draftFor(customerA, product);
    await expect(confirm(customerA, order)).resolves.toMatchObject({
      state: 'AWAITING_PAYMENT',
    });
  });

  it('a fresh usable probe makes a confirmed-down panel sellable again', async () => {
    const product = await activeProduct(panelA);
    await setHealth(panelA, 'AUTH_FAILED', PANEL_UNHEALTHY_AFTER_FAILURES);
    const refused = await draftFor(customerA, product);
    await expect(confirm(customerA, refused)).rejects.toMatchObject({
      details: { reason: 'UNHEALTHY' },
    });

    // Recovery is the exact negation of the refusal: one probe that concluded
    // something usable resets the streak, and nothing else has to happen.
    await setHealth(panelA, 'HEALTHY', 0);
    const accepted = await draftFor(customerB, product);
    await expect(confirm(customerB, accepted)).resolves.toMatchObject({
      state: 'AWAITING_PAYMENT',
    });
  });

  it('lowering the cap below usage refuses new sales and terminates nothing', async () => {
    await setCap(panelA, 5);
    await placeService(panelA, 'ACTIVE');
    await placeService(panelA, 'ACTIVE');

    await ctx.container.panels.update(tenantA, owner, panelA, {
      maxServices: 1,
      idempotencyKey: key(),
    });

    const states = (await ctx.container.database.db.execute(
      sql`SELECT state FROM services WHERE panel_id = ${panelA}` as never,
    )) as unknown as { rows: { state: string }[] };
    // Two services, both untouched. A limit that could delete a customer's
    // service because somebody mistyped a number is not a limit.
    expect(states.rows.map((row) => row.state)).toEqual(['ACTIVE', 'ACTIVE']);

    const product = await activeProduct(panelA);
    const order = await draftFor(customerA, product);
    await expect(confirm(customerA, order)).rejects.toMatchObject({
      details: { reason: 'AT_CAPACITY' },
    });
  });

  // -------------------------------------------------------------------------
  // Tenancy and permission
  // -------------------------------------------------------------------------

  it('counts nothing across the tenant boundary', async () => {
    // Another tenant's panel, with the same id nowhere in this tenant's data.
    expect(await capacityOf(panelForeign)).toBeNull();
    expect(await ctx.container.panelCapacity.read(tenantB, panelForeign, new Date())).not.toBeNull();
  });

  it('refuses a cap change to an administrator who holds no panel permission', async () => {
    // No roles at all, which is what deny-by-default means here: permissions
    // are granted, never assumed, so an administrator nobody has given
    // `panels.edit` cannot change a number that decides whether a tenant sells.
    const viewer = await createAdmin(ctx.container, tenantA, {
      username: 'viewer_capacity',
      roleKeys: [],
    });
    await expect(
      ctx.container.panels.update(tenantA, adminActorFor(viewer), panelA, {
        maxServices: 2,
        idempotencyKey: key(),
      }),
    ).rejects.toMatchObject({ kind: 'PERMISSION_DENIED' });
  });
});
