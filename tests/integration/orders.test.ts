import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ORDER_EXPIRY_MINUTES_MIN,
  money,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type PanelId,
  type ProductId,
  type ProductStatus,
  type UserId,
} from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import type {
  ProductDraft,
  ProductRecord,
} from '../../apps/api/src/modules/commerce/catalog/application/ports';
import type { OrderRecord } from '../../apps/api/src/modules/commerce/orders/application/ports';
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
 * Orders, from a customer's intent to the boundary where money begins.
 *
 * Phase 4B owns two writes — creating a DRAFT and confirming it into
 * `AWAITING_PAYMENT` — and every case here is about one of the ways those two could be
 * subtly wrong rather than visibly broken:
 *
 *   - the SNAPSHOT. An order records what was bought as it read at the time. A report
 *     that joins on today's product row is how the legacy system renders
 *     «محصول حذف‌شده» for anything since deleted, and how renaming a plan rewrites
 *     history. So: change the product after the draft, and the order must not move.
 *   - the PRICE, which is snapshotted at DRAFT and NOT re-quoted at CONFIRM. The number
 *     the customer is answering is the number they were shown.
 *   - the ORDERABILITY, which IS re-checked at confirmation, because a product an
 *     operator withdrew between the summary and the tap must not sell.
 *   - the TRANSITION, which is a conditional UPDATE. Two confirmations, a double tap and
 *     a redelivered callback must produce one state change and exactly one
 *     `OrderConfirmed` — a consumer that charges per event would otherwise charge twice.
 *   - the BOUNDARY. Nothing here settles anything. `SETTLE` is guarded by
 *     `settlementIsFunded` and there is no funding in this codebase to satisfy it with.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const BOT_B = SEED_IDS.botB1 as BotInstanceId;

/** The actor a customer-initiated order command runs as. Holds `maintenance.run` only. */
const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

describe('orders, up to the payment boundary', () => {
  let ctx: TestContext;
  let products: DrizzleProductRepository;
  let panelA: string;
  let panelB: string;
  let customerA: UserId;
  /**
   * An owner, for the handful of READS this suite makes as an operator.
   *
   * Re-created per case rather than cached across them, because `reset()` truncates
   * `admins` — a cached actor would name a row that no longer exists and the guard would
   * refuse it on whichever case happened to run second.
   */
  let owner: ActorContext;

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
    panelB = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelA}, ${tenantA.tenantId}, 'Panel A', 'sanaei', 'https://a.example.test', 'ACTIVE'),
             (${panelB}, ${tenantB.tenantId}, 'Panel B', 'sanaei', 'https://b.example.test', 'ACTIVE')`);
    customerA = await customer(tenantA, BOT_A, '900100');
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-orders', roleKeys: ['owner'] }),
    );
  });

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  /** A real customer, created the way the bot creates one. */
  async function customer(
    scope: typeof tenantA,
    botInstanceId: BotInstanceId,
    telegramUserId: string,
  ): Promise<UserId> {
    const { customer: record } = await ctx.container.customers.resolveFromUpdate(
      scope,
      systemActor(`resolve-${telegramUserId}`),
      {
        idempotencyKey: `resolve-${telegramUserId}`,
        telegramUserId,
        from: { id: Number(telegramUserId), first_name: 'زهرا' },
        botInstanceId,
      },
    );
    return record.id;
  }

  const draft = (panelId: string, overrides: Partial<ProductDraft> = {}): ProductDraft => ({
    title: 'پلن پایه',
    description: 'یک ماهه',
    audience: 'EVERYONE',
    sortOrder: 10,
    panelId: panelId as PanelId,
    specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: 2 },
    price: money(250_000n, 'IRT'),
    ...overrides,
  });

  async function productIn(
    scope: typeof tenantA,
    status: ProductStatus,
    panelId: string,
    overrides: Partial<ProductDraft> = {},
  ): Promise<ProductRecord> {
    const created = await products.create(scope, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: draft(panelId, overrides),
      now: ctx.container.clock.now(),
    });
    if (status === 'ACTIVE') {
      await products.setStatus(scope, created.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    }
    const after = await products.findById(scope, created.id);
    if (after === null) throw new Error('product vanished');
    return after;
  }

  const createDraft = (
    scope: typeof tenantA,
    customerId: UserId,
    productId: string,
    key: string,
  ): Promise<OrderRecord> =>
    ctx.container.orders.createDraft(scope, systemActor(key), {
      idempotencyKey: key,
      customerId,
      productId,
    });

  const confirm = (
    scope: typeof tenantA,
    customerId: UserId,
    orderId: string,
    key: string,
  ): Promise<OrderRecord> =>
    ctx.container.orders.confirm(scope, systemActor(key), {
      idempotencyKey: key,
      customerId,
      orderId,
    });

  const eventTypes = async (orderId: string): Promise<string[]> => {
    const rows = (await ctx.container.database.db.execute(
      sql`SELECT event_type FROM outbox_messages
          WHERE aggregate_type = 'Order' AND aggregate_id = ${orderId}
          ORDER BY sequence ASC` as never,
    )) as unknown as { rows: { event_type: string }[] };
    return rows.rows.map((row) => row.event_type);
  };

  const actions = async (orderId: string): Promise<string[]> => {
    const rows = (await ctx.container.database.db.execute(
      sql`SELECT action FROM audit_logs WHERE entity_type = 'Order' AND entity_id = ${orderId}
          ORDER BY occurred_at ASC, id ASC` as never,
    )) as unknown as { rows: { action: string }[] };
    return rows.rows.map((row) => row.action);
  };

  const orderCount = async (): Promise<number> => {
    const rows = (await ctx.container.database.db.execute(
      sql`SELECT count(*)::int AS n FROM orders` as never,
    )) as unknown as { rows: { n: number }[] };
    return rows.rows[0]?.n ?? 0;
  };

  // -------------------------------------------------------------------------
  // DRAFT creation
  // -------------------------------------------------------------------------

  it('creates a DRAFT carrying the whole snapshot and a priced, traced total', async () => {
    const product = await productIn(tenantA, 'ACTIVE', panelA);
    const order = await createDraft(tenantA, customerA, product.id, 'draft-1');

    expect(order.state).toBe('DRAFT');
    expect(order.confirmedAt).toBeNull();
    expect(order.line).toMatchObject({
      productId: product.id,
      panelId: panelA,
      title: 'پلن پایه',
      quantity: 1,
    });
    expect(order.line.specification).toEqual({
      durationDays: 30,
      trafficBytes: 53_687_091_200n,
      deviceLimit: 2,
    });
    expect(order.line.unitPrice).toEqual(money(250_000n, 'IRT'));
    expect(order.totals.subtotal.amountMinor).toBe(250_000n);
    expect(order.totals.discount.amountMinor).toBe(0n);
    expect(order.totals.total.amountMinor).toBe(250_000n);
    expect(order.totals.currency).toBe('IRT');

    /*
     * The trace is MANDATORY and has exactly one step.
     *
     * `pricing.ts`: "a quote without a trace is not a quote". One step, because Phase 4B
     * implements one — `BASE_PRICE` with `ruleId: null`, which the contract defines as
     * "the step applied a default". A second step here would be a claim that a rule
     * fired, and there are no rules.
     */
    expect(order.totals.quote.trace).toHaveLength(1);
    expect(order.totals.quote.trace[0]).toMatchObject({
      step: 'BASE_PRICE',
      effect: 'REPLACES',
      ruleId: null,
    });
    expect(order.totals.quote.finalAmount.amountMinor).toBe(250_000n);
    expect(order.totals.quote.productId).toBe(product.id);
  });

  it('nothing is owed by a DRAFT: no order event is emitted', async () => {
    const product = await productIn(tenantA, 'ACTIVE', panelA);
    const order = await createDraft(tenantA, customerA, product.id, 'draft-quiet');
    // The catalogue declares OrderConfirmed/Settled/Cancelled/Refunded and nothing for a
    // draft. A draft commits the customer to nothing and has no consumer.
    expect(await eventTypes(order.id)).toEqual([]);
    expect(await actions(order.id)).toEqual(['order.draft_create']);
  });

  it('holds the draft for the CONFIGURED window, not a hard-coded one', async () => {
    await ctx.container.database.db.execute(sql`
      INSERT INTO setting_values (id, tenant_id, setting_key, value, version)
      VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, 'sales.order_expiry_minutes',
              ${JSON.stringify(ORDER_EXPIRY_MINUTES_MIN)}::jsonb, 1)`);

    const product = await productIn(tenantA, 'ACTIVE', panelA);
    const order = await createDraft(tenantA, customerA, product.id, 'draft-window');

    expect(order.expiresAt).not.toBeNull();
    const heldMinutes = ((order.expiresAt as Date).getTime() - order.createdAt.getTime()) / 60_000;
    expect(heldMinutes).toBeCloseTo(ORDER_EXPIRY_MINUTES_MIN, 3);
  });

  it('carries an amount past 2^53 without losing a unit', async () => {
    /*
     * A Toman price is ordinary, not an edge case, and `Number.MAX_SAFE_INTEGER` is
     * ~9.0e15. A total that round-trips through a JSON number loses its last digits, and
     * the trace is jsonb — which is why every amount in it is stored as a STRING.
     */
    const huge = 9_007_199_254_740_993n;
    const product = await productIn(tenantA, 'ACTIVE', panelA, { price: money(huge, 'IRT') });
    const order = await createDraft(tenantA, customerA, product.id, 'draft-huge');

    expect(order.totals.total.amountMinor).toBe(huge);
    expect(order.totals.quote.finalAmount.amountMinor).toBe(huge);
    const reread = await ctx.container.orders.get(tenantA, owner, order.id);
    expect(reread.totals.total.amountMinor).toBe(huge);
  });

  it('returns the SAME order for a replayed key and writes no second row', async () => {
    const product = await productIn(tenantA, 'ACTIVE', panelA);
    const first = await createDraft(tenantA, customerA, product.id, 'draft-replay');
    const second = await createDraft(tenantA, customerA, product.id, 'draft-replay');

    expect(second.id).toBe(first.id);
    expect(await orderCount()).toBe(1);
  });

  it('two concurrent creations under one key produce exactly one order', async () => {
    const product = await productIn(tenantA, 'ACTIVE', panelA);
    const results = await Promise.allSettled([
      createDraft(tenantA, customerA, product.id, 'draft-race'),
      createDraft(tenantA, customerA, product.id, 'draft-race'),
    ]);
    // The losing insert is a CONFLICT that rolls its whole transaction back, so one of
    // the two may reject — what must not happen is two ORDERS.
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    expect(await orderCount()).toBe(1);
  });

  // -------------------------------------------------------------------------
  // What cannot be ordered, and why — three refusals, not one
  // -------------------------------------------------------------------------

  it('refuses a withdrawn product as NOT_PURCHASABLE', async () => {
    const product = await productIn(tenantA, 'INACTIVE', panelA);
    await expect(createDraft(tenantA, customerA, product.id, 'no-1')).rejects.toMatchObject({
      code: 'commerce.product_not_purchasable',
    });
    expect(await orderCount()).toBe(0);
  });

  it('refuses an unpriced product as NOT_PRICED — absent price never means free', async () => {
    const product = await productIn(tenantA, 'ACTIVE', panelA, { price: null });
    await expect(createDraft(tenantA, customerA, product.id, 'no-2')).rejects.toMatchObject({
      code: 'commerce.product_not_priced',
    });
  });

  it('refuses a product with no panel as NOT_FULFILLABLE', async () => {
    const product = await productIn(tenantA, 'ACTIVE', panelA, { panelId: null });
    await expect(createDraft(tenantA, customerA, product.id, 'no-3')).rejects.toMatchObject({
      code: 'commerce.product_not_fulfillable',
    });
  });

  it('ORDERS a HIDDEN product, which no catalogue lists', async () => {
    /*
     * Catalogue membership and orderability are different predicates. HIDDEN means
     * "sold, but not advertised" — a tenant selling to one customer by link. Collapsing
     * the two would make HIDDEN mean either unsellable or public, and neither is what
     * `catalog.ts` says.
     */
    const product = await productIn(tenantA, 'ACTIVE', panelA, { audience: 'HIDDEN' });
    expect((await products.listCatalog(tenantA, 50)).items).toHaveLength(0);
    const order = await createDraft(tenantA, customerA, product.id, 'hidden-ok');
    expect(order.state).toBe('DRAFT');
  });

  it('refuses a blocked customer, and says so distinctly from "unknown"', async () => {
    const product = await productIn(tenantA, 'ACTIVE', panelA);
    await ctx.container.database.db.execute(sql`
      UPDATE customers SET status = 'BLOCKED', blocked_at = now() WHERE id = ${customerA}`);

    await expect(createDraft(tenantA, customerA, product.id, 'blocked-1')).rejects.toMatchObject({
      code: 'commerce.customer_blocked',
    });
    expect(await orderCount()).toBe(0);
  });

  it('refuses an installation that has stopped accepting work', async () => {
    const product = await productIn(tenantA, 'ACTIVE', panelA);
    await ctx.container.database.db.execute(sql`
      UPDATE tenants SET status = 'STOPPED' WHERE id = ${tenantA.tenantId}`);

    await expect(createDraft(tenantA, customerA, product.id, 'stopped-1')).rejects.toThrow();
    expect(await orderCount()).toBe(0);
  });

  // -------------------------------------------------------------------------
  // CONFIRM — the last edge Phase 4B owns
  // -------------------------------------------------------------------------

  it('moves DRAFT to AWAITING_PAYMENT, stamps the time and emits one OrderConfirmed', async () => {
    const product = await productIn(tenantA, 'ACTIVE', panelA);
    const order = await createDraft(tenantA, customerA, product.id, 'c-1');
    const confirmed = await confirm(tenantA, customerA, order.id, 'c-1-confirm');

    expect(confirmed.state).toBe('AWAITING_PAYMENT');
    expect(confirmed.confirmedAt).not.toBeNull();
    expect(await eventTypes(order.id)).toEqual(['OrderConfirmed']);
    expect(await actions(order.id)).toEqual(['order.draft_create', 'order.confirm']);
  });

  it('stops there: nothing settles, and the order still owes money', async () => {
    const product = await productIn(tenantA, 'ACTIVE', panelA);
    const order = await createDraft(tenantA, customerA, product.id, 'c-boundary');
    await confirm(tenantA, customerA, order.id, 'c-boundary-confirm');

    const rows = (await ctx.container.database.db.execute(
      sql`SELECT state, settled_at, cancelled_at, refunded_at FROM orders WHERE id = ${order.id}` as never,
    )) as unknown as {
      rows: { state: string; settled_at: Date | null; refunded_at: Date | null }[];
    };
    const row = rows.rows[0];
    expect(row?.state).toBe('AWAITING_PAYMENT');
    // `orders_settled_at_check` binds the timestamp to the state, so this is the
    // database agreeing that nothing was settled — not merely this test not asking.
    expect(row?.settled_at).toBeNull();
    expect(row?.refunded_at).toBeNull();
  });

  it('confirming twice is a success, changes nothing twice, and emits ONE event', async () => {
    const product = await productIn(tenantA, 'ACTIVE', panelA);
    const order = await createDraft(tenantA, customerA, product.id, 'c-2');
    const first = await confirm(tenantA, customerA, order.id, 'c-2-a');
    const second = await confirm(tenantA, customerA, order.id, 'c-2-b');

    expect(second.state).toBe('AWAITING_PAYMENT');
    expect(second.confirmedAt?.getTime()).toBe(first.confirmedAt?.getTime());
    expect(await eventTypes(order.id)).toEqual(['OrderConfirmed']);
    // The second call is audited as a no-op rather than erased: the log has to
    // distinguish "this confirmed it" from "it was already confirmed".
    expect(await actions(order.id)).toEqual([
      'order.draft_create',
      'order.confirm',
      'order.confirm',
    ]);
  });

  it('two concurrent confirmations produce one transition and one event', async () => {
    const product = await productIn(tenantA, 'ACTIVE', panelA);
    const order = await createDraft(tenantA, customerA, product.id, 'c-race');
    const results = await Promise.allSettled([
      confirm(tenantA, customerA, order.id, 'c-race-a'),
      confirm(tenantA, customerA, order.id, 'c-race-b'),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled').length).toBeGreaterThan(0);
    expect(await eventTypes(order.id)).toEqual(['OrderConfirmed']);
  });

  it('refuses a draft whose own deadline has passed', async () => {
    const product = await productIn(tenantA, 'ACTIVE', panelA);
    const order = await createDraft(tenantA, customerA, product.id, 'c-expired');
    await ctx.container.database.db.execute(sql`
      UPDATE orders SET expires_at = now() - interval '1 minute' WHERE id = ${order.id}`);

    await expect(confirm(tenantA, customerA, order.id, 'c-expired-go')).rejects.toMatchObject({
      code: 'commerce.order_expired',
    });

    // NOT moved to EXPIRED. That sweep is a later phase's job, and a read path that
    // quietly writes a state change is one an operator cannot reason about.
    const after = await ctx.container.orders.get(tenantA, owner, order.id);
    expect(after.state).toBe('DRAFT');
    expect(await eventTypes(order.id)).toEqual([]);
  });

  it('re-checks ORDERABILITY at confirmation: a withdrawn product does not sell', async () => {
    const product = await productIn(tenantA, 'ACTIVE', panelA);
    const order = await createDraft(tenantA, customerA, product.id, 'c-withdrawn');
    await products.setStatus(tenantA, product.id, 'ACTIVE', 'INACTIVE', ctx.container.clock.now());

    await expect(confirm(tenantA, customerA, order.id, 'c-withdrawn-go')).rejects.toMatchObject({
      code: 'commerce.product_not_purchasable',
    });
    const after = await ctx.container.orders.get(tenantA, owner, order.id);
    expect(after.state).toBe('DRAFT');
  });

  it('does NOT re-price at confirmation: the customer pays what they were shown', async () => {
    const product = await productIn(tenantA, 'ACTIVE', panelA);
    const order = await createDraft(tenantA, customerA, product.id, 'c-price');
    expect(order.totals.total.amountMinor).toBe(250_000n);

    await products.update(
      tenantA,
      product.id,
      draft(panelA, { price: money(999_000n, 'IRT') }),
      ctx.container.clock.now(),
    );

    const confirmed = await confirm(tenantA, customerA, order.id, 'c-price-go');
    expect(confirmed.totals.total.amountMinor).toBe(250_000n);
    expect(confirmed.line.unitPrice.amountMinor).toBe(250_000n);
    expect(confirmed.totals.quote.finalAmount.amountMinor).toBe(250_000n);
  });

  it('keeps the SNAPSHOT when the product is renamed and re-specified afterwards', async () => {
    const product = await productIn(tenantA, 'ACTIVE', panelA);
    const order = await createDraft(tenantA, customerA, product.id, 'c-snapshot');

    await products.update(
      tenantA,
      product.id,
      draft(panelA, {
        title: 'یک نام کاملاً دیگر',
        specification: { durationDays: 365, trafficBytes: 1n, deviceLimit: 99 },
      }),
      ctx.container.clock.now(),
    );

    const confirmed = await confirm(tenantA, customerA, order.id, 'c-snapshot-go');
    // The legacy «محصول حذف‌شده» is what a report that joins on today's row produces.
    expect(confirmed.line.title).toBe('پلن پایه');
    expect(confirmed.line.specification).toEqual({
      durationDays: 30,
      trafficBytes: 53_687_091_200n,
      deviceLimit: 2,
    });
  });

  it('keeps the snapshot when the product is re-pointed at another panel', async () => {
    const product = await productIn(tenantA, 'ACTIVE', panelA);
    const order = await createDraft(tenantA, customerA, product.id, 'c-panel');
    const otherPanel = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${otherPanel}, ${tenantA.tenantId}, 'Panel A2', 'sanaei', 'https://a2.example.test', 'ACTIVE')`);
    await products.update(tenantA, product.id, draft(otherPanel), ctx.container.clock.now());

    const confirmed = await confirm(tenantA, customerA, order.id, 'c-panel-go');
    // A re-point changes where the NEXT service is made, never where an existing
    // promise was made.
    expect(confirmed.line.panelId).toBe(panelA);
  });

  it('refuses confirmation by a customer who does not own the order, as UNKNOWN', async () => {
    const product = await productIn(tenantA, 'ACTIVE', panelA);
    const order = await createDraft(tenantA, customerA, product.id, 'c-owner');
    const other = await customer(tenantA, BOT_A, '900200');

    // Not FORBIDDEN: a distinct refusal would answer "does order X exist" for anybody
    // willing to guess ids, and an order id travels in screenshots.
    await expect(confirm(tenantA, other, order.id, 'c-owner-go')).rejects.toMatchObject({
      code: 'commerce.order_not_found',
    });
    const after = await ctx.container.orders.get(tenantA, owner, order.id);
    expect(after.state).toBe('DRAFT');
  });

  it('refuses a blocked customer at confirmation too, not only at creation', async () => {
    const product = await productIn(tenantA, 'ACTIVE', panelA);
    const order = await createDraft(tenantA, customerA, product.id, 'c-blocked');
    await ctx.container.database.db.execute(sql`
      UPDATE customers SET status = 'BLOCKED', blocked_at = now() WHERE id = ${customerA}`);

    await expect(confirm(tenantA, customerA, order.id, 'c-blocked-go')).rejects.toMatchObject({
      code: 'commerce.customer_blocked',
    });
    expect(await eventTypes(order.id)).toEqual([]);
  });

  it('refuses to confirm an order that has reached a terminal state', async () => {
    const product = await productIn(tenantA, 'ACTIVE', panelA);
    const order = await createDraft(tenantA, customerA, product.id, 'c-terminal');
    await ctx.container.database.db.execute(sql`
      UPDATE orders SET state = 'CANCELLED', cancelled_at = now() WHERE id = ${order.id}`);

    await expect(confirm(tenantA, customerA, order.id, 'c-terminal-go')).rejects.toMatchObject({
      code: 'commerce.order_state_invalid',
    });
  });

  // -------------------------------------------------------------------------
  // Tenancy
  // -------------------------------------------------------------------------

  it("cannot order another tenant's product, and cannot reach its order", async () => {
    const productB = await productIn(tenantB, 'ACTIVE', panelB);
    await expect(createDraft(tenantA, customerA, productB.id, 'x-1')).rejects.toMatchObject({
      code: 'commerce.product_not_found',
    });

    const productA = await productIn(tenantA, 'ACTIVE', panelA);
    const order = await createDraft(tenantA, customerA, productA.id, 'x-2');
    const customerB = await customer(tenantB, BOT_B, '900300');
    await expect(confirm(tenantB, customerB, order.id, 'x-3')).rejects.toMatchObject({
      code: 'commerce.order_not_found',
    });
    // And the row did not move under the other tenant's hand.
    const after = await ctx.container.orders.get(tenantA, owner, order.id);
    expect(after.state).toBe('DRAFT');
  });

  it("lists only this tenant's orders", async () => {
    const productA = await productIn(tenantA, 'ACTIVE', panelA);
    const productB = await productIn(tenantB, 'ACTIVE', panelB);
    const customerB = await customer(tenantB, BOT_B, '900400');
    const mine = await createDraft(tenantA, customerA, productA.id, 'l-1');
    await createDraft(tenantB, customerB, productB.id, 'l-2');

    const page = await ctx.container.orders.list(tenantA, owner, { search: {} });
    expect(page.items.map((o) => o.id)).toEqual([mine.id]);
  });
});
