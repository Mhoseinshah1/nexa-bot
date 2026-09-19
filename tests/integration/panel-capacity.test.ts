import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  money,
  PANEL_UNHEALTHY_AFTER_FAILURES,
  PRODUCT_PAGE_MAX,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type PanelId,
  type ProductId,
  type UserId,
} from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { DrizzlePanelCapacityRepository } from '../../apps/api/src/modules/platform/panels/infrastructure/drizzle-panel-capacity.repository';
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
      await createAdmin(ctx.container, tenantA, {
        username: 'owner-capacity',
        roleKeys: ['owner'],
      }),
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

  it('answers a second acquire for the same order with the slot it already holds', async () => {
    /*
     * The RESERVATION's own replay defence, reached directly.
     *
     * The case below goes through `confirm`, where the order's idempotency store
     * answers the second call before the panel is ever consulted — so it proves
     * that store and says nothing about this. Two transactions acquiring for one
     * order is the shape a retry across replicas actually has.
     *
     * The panel is FULL of this order's own hold when the second call arrives,
     * which is why the held-check comes before the capacity arithmetic: an order
     * that already owns its slot is not asking for another, and answering it
     * `AT_CAPACITY` would refuse a retry at a step it had already passed.
     */
    await setCap(panelA, 1);
    const product = await activeProduct(panelA);
    const orderId = await draftFor(customerA, product);
    const acquire = () =>
      ctx.container.uow.run(tenantA, (tx) =>
        ctx.container.panelSales.acquire(tenantA, panelA, orderId, tx, null),
      );

    await expect(acquire()).resolves.toEqual({ eligible: true });
    await expect(acquire()).resolves.toEqual({ eligible: true });
    expect(await reservations(panelA)).toBe(1);
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

    /*
     * A BARRIER, not a race.
     *
     * Two `Promise.all` confirmations are concurrent in the sense that both are
     * in flight; whether they are both inside the critical section is up to the
     * event loop, and the first version of this case passed with the row lock
     * REMOVED — it proved nothing. The barrier makes the interleaving a
     * property of the test: neither call may begin acquiring until both have
     * arrived, so both are inside their transactions with the panel not yet
     * locked by either. The barrier is AHEAD of the lock rather than inside
     * `reserve`, because `acquire` locks first — a barrier after that point
     * deadlocks, with one caller holding the row and the other waiting for
     * PostgreSQL to hand it over.
     *
     * From there the lock is the only thing that can separate them. With it,
     * one waits in PostgreSQL and counts AFTER the other commits. Without it,
     * both count zero and both are sold the last slot.
     *
     * The instance is patched rather than a stand-in injected, because the gate
     * the order path uses holds THIS object — a stand-in would test a second
     * wiring that production does not have.
     */
    const arrivals: (() => void)[] = [];
    const bothArrived = new Promise<void>((resolve) => {
      let seen = 0;
      arrivals.push(() => {
        seen += 1;
        if (seen === 2) resolve();
      });
    });
    const realAcquire = ctx.container.panelSales.acquire.bind(ctx.container.panelSales);
    ctx.container.panelSales.acquire = async (scope, panelId, orderId, tx, expiresAt) => {
      arrivals[0]!();
      await bothArrived;
      return realAcquire(scope, panelId, orderId, tx, expiresAt);
    };

    try {
      const settled = await Promise.allSettled([
        confirm(customerA, first),
        confirm(customerB, second),
      ]);

      expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(settled.filter((r) => r.status === 'rejected')).toHaveLength(1);
      expect(await reservations(panelA)).toBe(1);
    } finally {
      ctx.container.panelSales.acquire = realAcquire;
    }
  });

  it('holds the panel row for update before it counts', async () => {
    /*
     * The lock itself, asserted where it is the only explanation.
     *
     * Two weaker versions of this case were written first and BOTH passed with
     * `FOR UPDATE` deleted, which is the whole reason this one exists:
     *
     *   - two confirmations under a rendezvous barrier. The interleaving that
     *     oversells is "both count before either inserts", and the lock makes
     *     that interleaving unconstructible: the loser makes no progress at all
     *     while the winner is inside, so any barrier waiting for it deadlocks.
     *   - a reserve that must WAIT while another transaction holds the row. It
     *     waits either way: `panel_capacity_reservations` references `panels`,
     *     so the INSERT takes a key-share lock on that row regardless. That case
     *     proved the foreign key.
     *
     * What distinguishes them is the lock MODE the reserving transaction holds
     * on `panels` at the moment it counts. `SELECT ... FOR UPDATE` takes
     * `RowShareLock` on the relation; a plain read takes `AccessShareLock`, and
     * the insert's `RowExclusiveLock` has not happened yet. So the count is
     * paused and the catalogue is asked, from another connection, what this
     * transaction is holding.
     */
    await setCap(panelA, 2);
    const product = await activeProduct(panelA);
    const orderId = await draftFor(customerA, product);

    let reportBackend = (_pid: number): void => {};
    const backendPid = new Promise<number>((resolve) => {
      reportBackend = resolve;
    });
    let releaseCount = (): void => {};
    const mayCount = new Promise<void>((resolve) => {
      releaseCount = resolve;
    });

    const real = ctx.container.panelCapacity.readMany.bind(ctx.container.panelCapacity);
    ctx.container.panelCapacity.readMany = async (scope, panelIds, now, tx) => {
      if (tx !== undefined) {
        const pid = (await tx.tx.execute(
          sql`SELECT pg_backend_pid()::int AS pid` as never,
        )) as unknown as { rows: { pid: number }[] };
        reportBackend(pid.rows[0]!.pid);
        await mayCount;
      }
      return real(scope, panelIds, now, tx);
    };

    try {
      const reserving = ctx.container.uow.run(tenantA, (tx) =>
        ctx.container.panelCapacity.reserve(
          tenantA,
          {
            id: ctx.container.ids.uuid(),
            panelId: panelA,
            orderId,
            expiresAt: new Date(ctx.container.clock.now().getTime() + 60_000),
          },
          ctx.container.clock.now(),
          tx,
        ),
      );

      const pid = await backendPid;
      const held = (await ctx.container.database.db.execute(
        sql`SELECT mode FROM pg_locks
             WHERE pid = ${pid} AND locktype = 'relation'
               AND relation = 'panels'::regclass` as never,
      )) as unknown as { rows: { mode: string }[] };

      expect(
        held.rows.map((row) => row.mode),
        'reserve counted without holding the panel row for update',
      ).toContain('RowShareLock');

      releaseCount();
      await expect(reserving).resolves.toMatchObject({ outcome: 'RESERVED' });
    } finally {
      releaseCount();
      ctx.container.panelCapacity.readMany = real;
    }
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

  it('reads a panel capacity in ONE statement, because two would be two snapshots', async () => {
    /*
     * The counts and the cap come from one statement, and the reason is
     * PostgreSQL's snapshot rule rather than the round trip. Under READ
     * COMMITTED each statement gets a FRESH snapshot, so a settlement
     * committing between a service count and a hold count is seen by neither —
     * the service did not exist when the first ran and the hold was gone when
     * the second did — and `used` comes back one too low. A panel then reports
     * room it does not have. Found by the Codex review of this branch.
     *
     * Counted rather than argued, because "one statement" is the only form of
     * this rule a test can see: the interleaving itself needs a commit between
     * two statements of another transaction, which is exactly what having one
     * statement makes impossible to construct.
     */
    let statements = 0;
    const db = ctx.container.database.db;
    const counting = new Proxy(db, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver) as unknown;
        if (property === 'execute' && typeof value === 'function') {
          return (...args: unknown[]) => {
            statements += 1;
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
      },
    });

    await placeService(panelA, 'ACTIVE');
    const capacity = await new DrizzlePanelCapacityRepository(counting).read(
      tenantA,
      panelA,
      ctx.container.clock.now(),
    );

    expect(capacity?.services).toBe(1);
    expect(statements, 'one statement, so one snapshot').toBe(1);
  });

  it('fills the catalogue bound past a screenful of ineligible products', async () => {
    /*
     * Filtering only the already-bounded page let a screenful of ineligible
     * products HIDE the eligible ones behind it: twenty products on a disabled
     * panel and an eligible twenty-first produced an empty catalogue, and the
     * bot's bound is a bound rather than a cursor, so the customer had no way
     * to reach past it. Found by the Codex review of this branch.
     */
    const roomy = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${roomy}, ${tenantA.tenantId}, 'Panel C', 'sanaei', 'https://c.example.test', 'ACTIVE')`);
    for (let index = 0; index < 20; index += 1) await activeProduct(panelA);
    // Created last, so it sorts last: same `sortOrder`, and the tie breaks on
    // `createdAt` then id. It is the row the old code could never reach.
    const wanted = await activeProduct(roomy);
    await setStatus(panelA, 'DISABLED');

    const browsed = await ctx.container.products.browse(tenantA, systemActor(key()), 20);
    expect(browsed.items.map((item) => item.id)).toEqual([wanted.id]);
    expect(browsed.hasMore, 'and nothing further is claimed, because there is none').toBe(false);
  });

  /**
   * Many ACTIVE products on one panel, in one statement.
   *
   * Through `products.create` a row at a time, a five-hundred-product fixture is a
   * thousand round trips and a test nobody will wait for — so these go straight in.
   * Everything the catalogue's membership rule reads is set explicitly; the point of
   * the fixture is the COUNT in front of the eligible product, not the rows.
   */
  const bulkActiveProducts = async (panelId: string, count: number, from = 0): Promise<void> => {
    const values = sql.join(
      Array.from(
        { length: count },
        (_unused, index) =>
          sql`(${ctx.container.ids.uuid()}, ${tenantA.tenantId}, ${`bulk ${String(from + index)}`},
             'EVERYONE', 'ACTIVE', ${from + index}, ${panelId}, 30, 0, 1, 120000, 'IRT',
             ${ctx.container.clock.now()}, ${ctx.container.clock.now()})`,
      ),
      sql`, `,
    );
    await ctx.container.database.db.execute(sql`
      INSERT INTO products (id, tenant_id, title, audience, status, sort_order, panel_id,
                            duration_days, traffic_bytes, device_limit,
                            price_amount, price_currency, created_at, updated_at)
      VALUES ${values}`);
  };

  it('reaches an eligible product past EVERY former scan ceiling', async () => {
    /*
     * Codex C4-N3 / M4 on PR #50 — the same finding three times, and the third time
     * with the point that the first two fixes missed.
     *
     * Both earlier attempts filtered eligibility out of a page the database had
     * already bounded. That can always be defeated by putting enough ineligible
     * products in front of the eligible one: the bound started at the caller's own
     * (twenty products hid the twenty-first), moved to `PRODUCT_PAGE_MAX` (a hundred
     * hid the hundred-and-first), then to `PRODUCT_PAGE_MAX * 5`. Each fix moved the
     * number at which a customer sees an empty shop; none removed it.
     *
     * 501 is deliberately one past the LAST of those ceilings, so this case fails
     * against every version of the scan that has existed on this branch and passes
     * only for a filter the database applies BEFORE its LIMIT.
     */
    const roomy = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${roomy}, ${tenantA.tenantId}, 'Panel D', 'sanaei', 'https://d.example.test', 'ACTIVE')`);
    await bulkActiveProducts(panelA, PRODUCT_PAGE_MAX * 5 + 1);
    const wanted = await activeProduct(roomy);
    await setStatus(panelA, 'DISABLED');

    const browsed = await ctx.container.products.browse(tenantA, systemActor(key()), 20);

    expect(browsed.items.map((item) => item.id)).toEqual([wanted.id]);
    expect(browsed.hasMore, 'the catalogue was reached to its end').toBe(false);
  }, 60_000);

  it('reaches eligible products behind every KIND of unsellable panel at once', async () => {
    /*
     * Disabled, archived, confirmed-unhealthy and full, each with products in front
     * of the eligible one. Four reasons rather than one, because `decideEligibility`
     * decides them in an order and a filter built from only the first would pass a
     * test that used only disabled panels.
     */
    const disabled = ctx.container.ids.uuid();
    const archived = ctx.container.ids.uuid();
    const unhealthy = ctx.container.ids.uuid();
    const full = ctx.container.ids.uuid();
    const roomy = ctx.container.ids.uuid();
    for (const [index, id] of [disabled, archived, unhealthy, full, roomy].entries()) {
      await ctx.container.database.db.execute(sql`
        INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status, max_services)
        VALUES (${id}, ${tenantA.tenantId}, ${`Panel ${String(index)}`}, 'sanaei',
                ${`https://p${String(index)}.example.test`}, 'ACTIVE', NULL)`);
    }
    for (const id of [disabled, archived, unhealthy, full]) await bulkActiveProducts(id, 30);
    const wanted = await activeProduct(roomy);

    await setStatus(disabled, 'DISABLED');
    await setStatus(archived, 'ARCHIVED');
    await setHealth(unhealthy, 'UNREACHABLE', PANEL_UNHEALTHY_AFTER_FAILURES);
    // Full is cap ONE and a service occupying it — `panels_max_services_check`
    // refuses a cap of zero, and a real occupant is the state being tested anyway.
    await setCap(full, 1);
    await placeService(full, 'ACTIVE');

    const browsed = await ctx.container.products.browse(tenantA, systemActor(key()), 20);
    expect(browsed.items.map((item) => item.id)).toEqual([wanted.id]);
  }, 60_000);

  it('pages across eligible products, in the catalogue s own order, ties and all', async () => {
    /*
     * Ordering is `sort_order`, then `created_at`, then `id`, and the tie is the part
     * worth asserting: two products at the same `sort_order` must come back in a
     * stable order rather than whichever the planner happened to emit.
     */
    const a = await activeProduct(panelA);
    const b = await activeProduct(panelA);
    const c = await activeProduct(panelA);
    const inOrder = [a, b, c]
      .slice()
      .sort(
        (left, right) =>
          left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id),
      )
      .map((item) => item.id);

    const first = await ctx.container.products.browse(tenantA, systemActor(key()), 2);
    expect(first.items.map((item) => item.id)).toEqual(inOrder.slice(0, 2));
    expect(first.hasMore, 'two of three asked for, so there are more').toBe(true);

    const all = await ctx.container.products.browse(tenantA, systemActor(key()), 3);
    expect(all.items.map((item) => item.id)).toEqual(inOrder);
    expect(all.hasMore, 'all three asked for and all three returned').toBe(false);
  });

  it('still bounds the catalogue, and says so when there are more', async () => {
    // The other half of the same rule: filtering in the query must not turn the
    // caller's bound into a suggestion. Two eligible products, one asked for.
    await activeProduct(panelA);
    await activeProduct(panelA);

    const browsed = await ctx.container.products.browse(tenantA, systemActor(key()), 1);
    expect(browsed.items).toHaveLength(1);
    expect(browsed.hasMore).toBe(true);
  });

  it('never reaches another tenant s eligible products', async () => {
    /*
     * The eligible-panel set is read per tenant and then used as a WHERE clause, so a
     * leak here would be a panel id from tenant B admitting tenant B's products into
     * tenant A's shop. Asserted in both directions, and with tenant A's own product
     * present, so an empty answer cannot pass it.
     */
    const mine = await activeProduct(panelA);
    const theirs = await products.create(tenantB, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن همسایه',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: panelForeign as PanelId,
        specification: { durationDays: 30, trafficBytes: 0n, deviceLimit: 1 },
        price: money(120_000n, 'IRT'),
      },
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantB, theirs.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());

    // Both directions, and both non-empty, so neither can pass by returning nothing.
    expect(
      (await ctx.container.products.browse(tenantA, systemActor(key()), 20)).items.map(
        (item) => item.id,
      ),
    ).toEqual([mine.id]);
    expect(
      (await ctx.container.products.browse(tenantB, systemActor(key()), 20)).items.map(
        (item) => item.id,
      ),
    ).toEqual([theirs.id]);
  });

  it('drops a product from the catalogue as soon as its panel fills', async () => {
    /*
     * The catalogue is a SNAPSHOT, and it becomes wrong the moment capacity changes.
     * That is why it is a courtesy and why confirmation re-decides — but the snapshot
     * must at least be current as of the read, and a set of eligible panel ids
     * computed once per request is exactly where a stale answer would hide.
     */
    const product = await activeProduct(panelA);
    expect(
      (await ctx.container.products.browse(tenantA, systemActor(key()), 20)).items.map(
        (item) => item.id,
      ),
    ).toEqual([product.id]);

    await setCap(panelA, 1);
    await placeService(panelA, 'ACTIVE');

    expect((await ctx.container.products.browse(tenantA, systemActor(key()), 20)).items).toEqual(
      [],
    );
  });

  it('asks the database a fixed number of times, whatever the catalogue holds', async () => {
    /*
     * The N+1 guard. Eligibility is per PANEL and the catalogue is per PRODUCT, so
     * the shape this design must never take is one eligibility read per row — which
     * is what the first version of `evaluateMany` replaced, and what a later edit
     * could quietly reintroduce.
     *
     * Counted rather than reasoned about: three statements for the whole request —
     * the fleet's capacity, the panels, the products — and the SAME three whether
     * the catalogue holds one product or a hundred.
     */
    const pool = ctx.container.database.pool as unknown as {
      query: (...args: unknown[]) => unknown;
    };
    const real = pool.query.bind(pool) as (...args: unknown[]) => unknown;
    let statements = 0;
    pool.query = (...args: unknown[]) => {
      statements += 1;
      return real(...args);
    };
    const counted = async (): Promise<number> => {
      statements = 0;
      await ctx.container.products.browse(tenantA, systemActor(key()), 100);
      return statements;
    };

    await activeProduct(panelA);
    const forOne = await counted();

    await bulkActiveProducts(panelA, 99, 1000);
    const forAHundred = await counted();
    pool.query = real;

    expect(forOne, 'the fleet capacity, the panels, the products').toBe(3);
    expect(forAHundred).toBe(forOne);
  }, 60_000);

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
    expect(
      (await ctx.container.products.browse(tenantA, systemActor(key()), 20)).items,
    ).toHaveLength(1);

    // Confirmed down, and OLD. A stopped monitor must not close every shop in
    // the installation: old evidence stops being evidence, it does not become
    // worse evidence.
    await setHealth(
      panelA,
      'UNREACHABLE',
      PANEL_UNHEALTHY_AFTER_FAILURES + 5,
      new Date(ctx.container.clock.now().getTime() - 24 * 60 * 60 * 1000),
    );
    expect(
      (await ctx.container.products.browse(tenantA, systemActor(key()), 20)).items,
    ).toHaveLength(1);
    const order = await draftFor(customerA, product);
    await expect(confirm(customerA, order)).resolves.toMatchObject({
      state: 'AWAITING_PAYMENT',
    });
  });

  it('a DEGRADED panel keeps selling: the credentials were accepted', async () => {
    const product = await activeProduct(panelA);
    await setHealth(panelA, 'DEGRADED', 0);
    expect(
      (await ctx.container.products.browse(tenantA, systemActor(key()), 20)).items,
    ).toHaveLength(1);
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
    expect(
      await ctx.container.panelCapacity.read(tenantB, panelForeign, new Date()),
    ).not.toBeNull();
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
