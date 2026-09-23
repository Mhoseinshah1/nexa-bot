import { sql, type SQL } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  money,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
  type UserId,
} from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import type { OrderRecord } from '../../apps/api/src/modules/commerce/orders/application/ports';
import type { DiscountRuleWrite } from '../../apps/api/src/modules/commerce/pricing/application/ports';
import {
  SEED_IDS,
  adminActorFor,
  createAdmin,
  createTestContext,
  makePanelSellable,
  tenantA,
  tenantB,
  type TestContext,
} from './harness';

/**
 * Discounts, end to end, through the services a customer and an operator use
 * (`docs/wp8-pricing-audit.md` P1-P7, P11, P12).
 *
 * Every rule here is created the way an operator creates one — `DiscountAdminService`,
 * INACTIVE, then activated — and every price is read from the ORDER the customer would
 * confirm, never from the engine directly. The engine's own arithmetic has unit tests;
 * these cases are about what reaches an order and what confirmation does with it.
 *
 * The races are real races: an outside transaction holds the row both contenders need,
 * both are PROVEN to be waiting on it in `pg_locks`, and only then is it released. A
 * `Promise.all` alone shows two calls that may simply have run one after the other.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const BOT_B = SEED_IDS.botB1 as BotInstanceId;

const customerActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

const BASE: DiscountRuleWrite = {
  kind: 'AUTOMATIC',
  code: null,
  label: 'حراج',
  type: 'PERCENTAGE',
  value: 20n,
  currency: null,
  appliesTo: ['NEW_SERVICE'],
  productId: null,
  categoryId: null,
  customerId: null,
  firstPurchaseOnly: false,
  minimumSubtotal: null,
  startsAt: null,
  endsAt: null,
  totalLimit: null,
  perCustomerLimit: null,
  priority: 0,
  stackable: false,
};

describe('discounts reach the order, and confirmation keeps its word', () => {
  let ctx: TestContext;
  let products: DrizzleProductRepository;
  let owner: ActorContext;
  let ownerB: ActorContext;
  let panelA: string;
  let panelB: string;
  let customerA: UserId;
  let customerA2: UserId;
  let n = 0;
  const key = (): string => `pricing-key-${(n += 1)}`;

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
    await makePanelSellable(ctx.container, tenantA, panelA);
    await makePanelSellable(ctx.container, tenantB, panelB);
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-pricing', roleKeys: ['owner'] }),
    );
    ownerB = adminActorFor(
      await createAdmin(ctx.container, tenantB, {
        username: 'owner-pricing-b',
        roleKeys: ['owner'],
      }),
    );
    customerA = await customer(tenantA, BOT_A, '910001');
    customerA2 = await customer(tenantA, BOT_A, '910002');
  });

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  async function customer(
    scope: typeof tenantA,
    bot: BotInstanceId,
    telegramUserId: string,
  ): Promise<UserId> {
    const { customer: record } = await ctx.container.customers.resolveFromUpdate(
      scope,
      customerActor(`resolve-${telegramUserId}`),
      {
        idempotencyKey: `resolve-${telegramUserId}`,
        telegramUserId,
        from: { id: Number(telegramUserId), first_name: 'زهرا' },
        botInstanceId: bot,
      },
    );
    return record.id;
  }

  /** An ACTIVE product at `price`, in tenant A unless told otherwise. */
  async function product(
    price: bigint,
    scope: typeof tenantA = tenantA,
    panelId: string = panelA,
  ): Promise<ProductId> {
    const created = await products.create(scope, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن پایه',
        description: 'یک ماهه',
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: panelId as PanelId,
        categoryId: (scope === tenantA
          ? SEED_IDS.categoryA
          : SEED_IDS.categoryB) as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: 2 },
        price: money(price, 'IRT'),
      },
      now: ctx.container.clock.now(),
    });
    await products.setStatus(scope, created.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    return created.id;
  }

  /** A rule created and activated the way an operator does it. Returns its id. */
  async function rule(
    overrides: Partial<DiscountRuleWrite>,
    options: { scope?: typeof tenantA; actor?: ActorContext; active?: boolean } = {},
  ): Promise<string> {
    const scope = options.scope ?? tenantA;
    const actor = options.actor ?? owner;
    const created = await ctx.container.discounts.create(scope, actor, {
      idempotencyKey: key(),
      write: { ...BASE, ...overrides },
    });
    if (options.active !== false) {
      await ctx.container.discounts.activate(scope, actor, {
        idempotencyKey: key(),
        discountId: created.rule.id,
      });
    }
    return created.rule.id;
  }

  const draft = (customerId: UserId, productId: ProductId, scope = tenantA) =>
    ctx.container.orders.createDraft(scope, customerActor(key()), {
      idempotencyKey: key(),
      customerId,
      productId,
    });

  const confirm = (customerId: UserId, order: OrderRecord, scope = tenantA) =>
    ctx.container.orders.confirm(scope, customerActor(key()), {
      idempotencyKey: key(),
      customerId,
      orderId: order.id,
    });

  const applyCode = (customerId: UserId, order: OrderRecord, code: string | null, k = key()) =>
    ctx.container.orders.applyDiscountCode(tenantA, customerActor(k), {
      idempotencyKey: k,
      customerId,
      orderId: order.id,
      code,
    });

  async function count(query: SQL): Promise<number> {
    const result = (await ctx.container.database.db.execute(query as never)) as unknown as {
      rows: { n: number }[];
    };
    return result.rows[0]?.n ?? 0;
  }

  /** Waits until `expected` transactions are blocked on a row lock — the barrier. */
  async function awaitBlocked(expected: number, what: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const blocked = await count(
        sql`SELECT count(*)::int AS n FROM pg_locks
             WHERE NOT granted AND locktype IN ('tuple', 'transactionid')`,
      );
      if (blocked >= expected) return;
      if (Date.now() > deadline) throw new Error(`${what} never blocked.`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /** Holds `SELECT … FOR UPDATE` on one discount row until released. */
  async function holdRule(id: string): Promise<{ release: () => Promise<void> }> {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => (locked = resolve));
    const holder = ctx.container.database.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM discounts WHERE id = ${id} FOR UPDATE`);
      locked();
      await gate;
    });
    await holding;
    return {
      release: async () => {
        open();
        await holder;
      },
    };
  }

  const refusalOf = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      return error as { code: string; kind?: string; details?: Record<string, unknown> };
    }
    throw new Error('expected a refusal');
  };

  // -------------------------------------------------------------------------
  // Precedence, stacking, rounding
  // -------------------------------------------------------------------------

  it('prices a draft through an automatic rule and shows its step in the trace', async () => {
    const id = await rule({ value: 20n });
    const order = await draft(customerA, await product(250_000n));

    expect(order.totals.subtotal.amountMinor).toBe(250_000n);
    expect(order.totals.discount.amountMinor).toBe(50_000n);
    expect(order.totals.total.amountMinor).toBe(200_000n);
    const steps = order.totals.quote.trace.map((s) => [s.step, s.ruleId]);
    expect(steps).toEqual([
      ['BASE_PRICE', null],
      ['PROMOTIONAL_DISCOUNT', id],
    ]);
  });

  it('applies only the highest-priority rule when none may stack', async () => {
    await rule({ label: 'کم', value: 50n, priority: 1 });
    const high = await rule({ label: 'زیاد', value: 10n, priority: 9 });
    const order = await draft(customerA, await product(100_000n));

    // Priority, not the bigger discount: the operator's order is the rule.
    expect(order.totals.total.amountMinor).toBe(90_000n);
    expect(order.totals.quote.trace.filter((s) => s.ruleId !== null).map((s) => s.ruleId)).toEqual([
      high,
    ]);
  });

  it('breaks a priority tie by the older rule, the same way every time', async () => {
    const older = await rule({ label: 'اول', value: 10n, priority: 5 });
    await rule({ label: 'دوم', value: 30n, priority: 5 });
    const order = await draft(customerA, await product(100_000n));
    expect(order.totals.quote.trace.filter((s) => s.ruleId !== null).map((s) => s.ruleId)).toEqual([
      older,
    ]);
  });

  it('stacks stackable rules sequentially on the running amount, and stops at a non-stackable one', async () => {
    const first = await rule({ label: 'الف', value: 50n, priority: 9, stackable: true });
    const second = await rule({ label: 'ب', value: 10n, priority: 5, stackable: true });
    await rule({ label: 'ج', value: 30n, priority: 1, stackable: false });
    const order = await draft(customerA, await product(100_000n));

    // 100 000 → 50 000 → 45 000; the third is not stackable and is left out.
    expect(order.totals.total.amountMinor).toBe(45_000n);
    expect(order.totals.quote.trace.filter((s) => s.ruleId !== null).map((s) => s.ruleId)).toEqual([
      first,
      second,
    ]);
  });

  it('rounds a percentage in the customer’s favour and never below zero', async () => {
    await rule({ value: 33n });
    const odd = await draft(customerA, await product(1_001n));
    // 33% of 1 001 is 330.33; the discount rounds UP to 331.
    expect(odd.totals.discount.amountMinor).toBe(331n);
    expect(odd.totals.total.amountMinor).toBe(670n);
  });

  it('clamps a fixed amount larger than the price to the price', async () => {
    await rule({ type: 'FIXED_AMOUNT', value: 999_999n, currency: 'IRT' });
    const order = await draft(customerA, await product(10_000n));
    expect(order.totals.total.amountMinor).toBe(0n);
    expect(order.totals.discount.amountMinor).toBe(10_000n);
  });

  it('respects the window: not before it starts, not from the moment it ends', async () => {
    const now = ctx.container.clock.now().getTime();
    await rule({ label: 'آینده', startsAt: new Date(now + 3_600_000) });
    await rule({ label: 'گذشته', endsAt: new Date(now - 1) });
    const order = await draft(customerA, await product(100_000n));
    expect(order.totals.discount.amountMinor).toBe(0n);
  });

  it('respects scope: a rule for another product, purpose or customer does not apply', async () => {
    const other = await product(50_000n);
    await rule({ label: 'محصول دیگر', productId: other });
    await rule({ label: 'فقط تمدید', appliesTo: ['RENEW'] });
    await rule({ label: 'مشتری دیگر', customerId: customerA2 });
    const order = await draft(customerA, await product(100_000n));
    expect(order.totals.discount.amountMinor).toBe(0n);

    // And the customer-scoped one does apply to its own customer.
    const theirs = await draft(customerA2, await product(100_000n));
    expect(theirs.totals.discount.amountMinor).toBe(20_000n);
  });

  it('ignores an INACTIVE rule', async () => {
    await rule({ value: 50n }, { active: false });
    const order = await draft(customerA, await product(100_000n));
    expect(order.totals.discount.amountMinor).toBe(0n);
  });

  // -------------------------------------------------------------------------
  // Codes on a draft
  // -------------------------------------------------------------------------

  it('applies an entered code, whatever case it is typed in, and removes it again', async () => {
    const id = await rule({ kind: 'CODE', code: 'SPRING25', value: 25n });
    const order = await draft(customerA, await product(100_000n));
    expect(order.totals.discount.amountMinor).toBe(0n);

    const coded = await applyCode(customerA, order, '  spring25 ');
    expect(coded.discountCode).toBe('SPRING25');
    expect(coded.totals.total.amountMinor).toBe(75_000n);
    expect(coded.totals.quote.trace.some((s) => s.ruleId === id)).toBe(true);

    const removed = await applyCode(customerA, coded, null);
    expect(removed.discountCode).toBeNull();
    expect(removed.totals.total.amountMinor).toBe(100_000n);
  });

  it('refuses every unusable code with ONE code, the reason only in the details', async () => {
    const now = ctx.container.clock.now().getTime();
    await rule({ kind: 'CODE', code: 'LATER', startsAt: new Date(now + 3_600_000) });
    await rule({ kind: 'CODE', code: 'OFF' }, { active: false });
    const order = await draft(customerA, await product(100_000n));

    for (const [code, reason] of [
      ['NOPE', 'UNKNOWN_CODE'],
      ['LATER', 'NOT_STARTED'],
      ['OFF', 'INACTIVE'],
    ] as const) {
      const refusal = await refusalOf(applyCode(customerA, order, code));
      expect(refusal.code, code).toBe('commerce.discount_code_rejected');
      expect(refusal.details?.['reason'], code).toBe(reason);
    }
    // The draft kept the quote it had.
    const [row] = (
      (await ctx.container.database.db.execute(
        sql`SELECT total_amount::text AS total, discount_code FROM orders WHERE id = ${order.id}` as never,
      )) as unknown as { rows: { total: string; discount_code: string | null }[] }
    ).rows;
    expect(row).toEqual({ total: '100000', discount_code: null });
  });

  it('re-quotes a code from the draft’s own snapshot, never from today’s price', async () => {
    await rule({ kind: 'CODE', code: 'TEN', value: 10n });
    const productId = await product(100_000n);
    const order = await draft(customerA, productId);

    // The operator raises the price between the draft and the code.
    await ctx.container.database.db.execute(
      sql`UPDATE products SET price_amount = 500000 WHERE id = ${productId}`,
    );
    const coded = await applyCode(customerA, order, 'TEN');
    expect(coded.totals.subtotal.amountMinor).toBe(100_000n);
    expect(coded.totals.total.amountMinor).toBe(90_000n);
  });

  it('replays an applied code by its key and writes no second audit row', async () => {
    await rule({ kind: 'CODE', code: 'ONCE', value: 10n });
    const order = await draft(customerA, await product(100_000n));
    const k = key();
    const first = await applyCode(customerA, order, 'ONCE', k);
    const second = await applyCode(customerA, order, 'ONCE', k);
    expect(second.id).toBe(first.id);
    expect(second.totals.total.amountMinor).toBe(first.totals.total.amountMinor);
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'order.discount_code' AND entity_id = ${order.id}`,
      ),
    ).toBe(1);
  });

  it('refuses a code on an order that is no longer a draft', async () => {
    await rule({ kind: 'CODE', code: 'LATE', value: 10n });
    const order = await draft(customerA, await product(100_000n));
    await confirm(customerA, order);
    const refusal = await refusalOf(applyCode(customerA, order, 'LATE'));
    expect(refusal.code).not.toBe('commerce.discount_code_rejected');
    expect(
      await count(sql`SELECT count(*)::int AS n FROM orders WHERE discount_code IS NOT NULL`),
    ).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Confirmation: re-decided, never re-priced
  // -------------------------------------------------------------------------

  it('records one redemption per applied rule at confirmation, with the amount the quote took', async () => {
    const a = await rule({ label: 'الف', value: 50n, priority: 9, stackable: true });
    const b = await rule({ label: 'ب', value: 10n, priority: 5, stackable: true });
    const order = await draft(customerA, await product(100_000n));
    const confirmed = await confirm(customerA, order);
    expect(confirmed.state).toBe('AWAITING_PAYMENT');

    const rows = (
      (await ctx.container.database.db.execute(
        sql`SELECT discount_id, amount::text AS amount FROM discount_redemptions
             WHERE order_id = ${order.id} ORDER BY amount DESC` as never,
      )) as unknown as { rows: { discount_id: string; amount: string }[] }
    ).rows;
    expect(rows).toEqual([
      { discount_id: a, amount: '50000' },
      { discount_id: b, amount: '5000' },
    ]);
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM outbox_messages WHERE event_type = 'DiscountRedeemed'`,
      ),
    ).toBe(2);
  });

  it('refuses a confirmation whose rule was withdrawn, and leaves the draft as it was', async () => {
    const id = await rule({ value: 20n });
    const order = await draft(customerA, await product(100_000n));
    await ctx.container.discounts.deactivate(tenantA, owner, {
      idempotencyKey: key(),
      discountId: id,
    });

    const refusal = await refusalOf(confirm(customerA, order));
    expect(refusal.code).toBe('commerce.discount_no_longer_valid');
    expect(refusal.details?.['reason']).toBe('INACTIVE');
    const [row] = (
      (await ctx.container.database.db.execute(
        sql`SELECT state, total_amount::text AS total FROM orders WHERE id = ${order.id}` as never,
      )) as unknown as { rows: { state: string; total: string }[] }
    ).rows;
    expect(row).toEqual({ state: 'DRAFT', total: '80000' });
    expect(await count(sql`SELECT count(*)::int AS n FROM discount_redemptions`)).toBe(0);
  });

  it('confirms at the QUOTED amount after the rule was edited, never at the new one', async () => {
    const id = await rule({ value: 20n });
    const order = await draft(customerA, await product(100_000n));
    await ctx.container.discounts.update(tenantA, owner, {
      idempotencyKey: key(),
      discountId: id,
      write: { ...BASE, value: 60n },
    });

    const confirmed = await confirm(customerA, order);
    expect(confirmed.totals.total.amountMinor).toBe(80_000n);
    expect(
      await count(sql`SELECT count(*)::int AS n FROM discount_redemptions WHERE amount = 20000`),
    ).toBe(1);
  });

  it('refuses a confirmation past the rule’s window, even though the quote had it', async () => {
    const id = await rule({ value: 20n });
    const order = await draft(customerA, await product(100_000n));
    await ctx.container.database.db.execute(
      sql`UPDATE discounts SET ends_at = now() - interval '1 second' WHERE id = ${id}`,
    );
    const refusal = await refusalOf(confirm(customerA, order));
    expect(refusal.code).toBe('commerce.discount_no_longer_valid');
    expect(refusal.details?.['reason']).toBe('ENDED');
  });

  it('writes one redemption and one event on a replayed confirmation', async () => {
    await rule({ value: 20n });
    const order = await draft(customerA, await product(100_000n));
    const k = key();
    const input = { idempotencyKey: k, customerId: customerA, orderId: order.id };
    await ctx.container.orders.confirm(tenantA, customerActor(k), input);
    await ctx.container.orders.confirm(tenantA, customerActor(k), input);
    expect(await count(sql`SELECT count(*)::int AS n FROM discount_redemptions`)).toBe(1);
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM outbox_messages WHERE event_type = 'DiscountRedeemed'`,
      ),
    ).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Limits, under a real race
  // -------------------------------------------------------------------------

  it('serialises two confirmations on the rule’s row lock, so a limit of one sells once', async () => {
    const id = await rule({ kind: 'CODE', code: 'ONLYONE', value: 20n, totalLimit: 1 });
    /*
     * Two PANELS. Two orders on one panel already queue on its row lock before either
     * reaches the rule, so the case passed with the rule lock removed — the falsification
     * pass found it (WP8-01). On separate panels only the rule's row lock orders them.
     */
    const panelA2 = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelA2}, ${tenantA.tenantId}, 'Panel A2', 'sanaei', 'https://a2.example.test', 'ACTIVE')`);
    await makePanelSellable(ctx.container, tenantA, panelA2);
    const first = await applyCode(
      customerA,
      await draft(customerA, await product(100_000n)),
      'ONLYONE',
    );
    const second = await applyCode(
      customerA2,
      await draft(customerA2, await product(100_000n, tenantA, panelA2)),
      'ONLYONE',
    );

    const held = await holdRule(id);
    const a = confirm(customerA, first).then(
      () => 'OK',
      (e: { code: string }) => e.code,
    );
    const b = confirm(customerA2, second).then(
      () => 'OK',
      (e: { code: string }) => e.code,
    );
    await awaitBlocked(2, 'both confirmations');
    await held.release();

    expect((await Promise.all([a, b])).sort()).toEqual(['OK', 'commerce.discount_no_longer_valid']);
    expect(await count(sql`SELECT count(*)::int AS n FROM discount_redemptions`)).toBe(1);
  });

  it('frees a use when the order that held it is cancelled', async () => {
    await rule({ kind: 'CODE', code: 'SINGLE', value: 20n, totalLimit: 1 });
    const productId = await product(100_000n);
    const held = await confirm(
      customerA,
      await applyCode(customerA, await draft(customerA, productId), 'SINGLE'),
    );

    // Taken: the second customer is told no at the code.
    const refusal = await refusalOf(
      applyCode(customerA2, await draft(customerA2, productId), 'SINGLE'),
    );
    expect(refusal.details?.['reason']).toBe('TOTAL_LIMIT');

    await ctx.container.orders.cancelByCustomer(tenantA, customerActor(key()), {
      idempotencyKey: key(),
      customerId: customerA,
      orderId: held.id,
    });
    const freed = await applyCode(customerA2, await draft(customerA2, productId), 'SINGLE');
    expect(freed.totals.total.amountMinor).toBe(80_000n);
  });

  it('holds a per-customer limit per customer, and not across customers', async () => {
    await rule({ kind: 'CODE', code: 'MINE', value: 20n, perCustomerLimit: 1 });
    const productId = await product(100_000n);
    await confirm(customerA, await applyCode(customerA, await draft(customerA, productId), 'MINE'));

    const again = await refusalOf(applyCode(customerA, await draft(customerA, productId), 'MINE'));
    expect(again.details?.['reason']).toBe('CUSTOMER_LIMIT');
    const other = await applyCode(customerA2, await draft(customerA2, productId), 'MINE');
    expect(other.totals.total.amountMinor).toBe(80_000n);
  });

  it('gives a first-purchase rule to a first purchase only', async () => {
    await rule({ firstPurchaseOnly: true, value: 30n });
    const productId = await product(100_000n);
    const first = await draft(customerA, productId);
    expect(first.totals.total.amountMinor).toBe(70_000n);
    await confirm(customerA, first);

    const second = await draft(customerA, productId);
    expect(second.totals.discount.amountMinor).toBe(0n);
  });

  it('refuses the second of two first-purchase confirmations raced by one customer', async () => {
    const id = await rule({ firstPurchaseOnly: true, value: 30n });
    const productId = await product(100_000n);
    const one = await draft(customerA, productId);
    const two = await draft(customerA, productId);

    const held = await holdRule(id);
    const a = confirm(customerA, one).then(
      () => 'OK',
      (e: { code: string }) => e.code,
    );
    const b = confirm(customerA, two).then(
      () => 'OK',
      (e: { code: string }) => e.code,
    );
    await awaitBlocked(2, 'both first-purchase confirmations');
    await held.release();

    expect((await Promise.all([a, b])).sort()).toEqual(['OK', 'commerce.discount_no_longer_valid']);
  });

  it('serialises first purchases through DIFFERENT rules on the customer’s first-purchase lock', async () => {
    /*
     * Two first-purchase rules, each scoped to its own product, so no rule row is shared
     * and the rule locks serialise nothing. What makes the second confirmation see the
     * first is the per-customer advisory lock — held here from outside, both
     * confirmations proven waiting on it, then released.
     */
    // Two PANELS as well: two orders on one panel already queue on its row lock
    // before either reaches the first-purchase lock, which would prove nothing here.
    const panelA2 = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelA2}, ${tenantA.tenantId}, 'Panel A2', 'sanaei', 'https://a2.example.test', 'ACTIVE')`);
    await makePanelSellable(ctx.container, tenantA, panelA2);
    const p1 = await product(100_000n);
    const p2 = await product(100_000n, tenantA, panelA2);
    await rule({ label: 'اول یک', firstPurchaseOnly: true, productId: p1 });
    await rule({ label: 'اول دو', firstPurchaseOnly: true, productId: p2 });
    const one = await draft(customerA, p1);
    const two = await draft(customerA, p2);
    expect(one.totals.discount.amountMinor).toBe(20_000n);
    expect(two.totals.discount.amountMinor).toBe(20_000n);

    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    let held!: () => void;
    const holding = new Promise<void>((resolve) => (held = resolve));
    const holder = ctx.container.database.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`nexa:first-purchase:${String(tenantA.tenantId)}:${customerA}`}, 0))`,
      );
      held();
      await gate;
    });
    await holding;

    const a = confirm(customerA, one).then(
      () => 'OK',
      (e: { code: string }) => e.code,
    );
    const b = confirm(customerA, two).then(
      () => 'OK',
      (e: { code: string }) => e.code,
    );
    try {
      const deadline = Date.now() + 5_000;
      while (
        (await count(
          sql`SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted AND locktype = 'advisory'`,
        )) < 2
      ) {
        if (Date.now() > deadline) throw new Error('the confirmations never queued on the lock');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } finally {
      open();
      await holder;
    }

    expect((await Promise.all([a, b])).sort()).toEqual(['OK', 'commerce.discount_no_longer_valid']);
  });

  // -------------------------------------------------------------------------
  // The operator's side, and isolation
  // -------------------------------------------------------------------------

  it('refuses a second rule with the same code, whatever case it was typed in', async () => {
    await rule({ kind: 'CODE', code: 'TAKEN' });
    const refusal = await refusalOf(
      ctx.container.discounts.create(tenantA, owner, {
        idempotencyKey: key(),
        write: { ...BASE, kind: 'CODE', code: 'taken' },
      }),
    );
    expect(refusal.code).toBe('commerce.discount_code_taken');
  });

  it('refuses to change a rule’s kind or code', async () => {
    const id = await rule({ kind: 'CODE', code: 'FIXED' });
    const refusal = await refusalOf(
      ctx.container.discounts.update(tenantA, owner, {
        idempotencyKey: key(),
        discountId: id,
        write: { ...BASE, kind: 'CODE', code: 'OTHER' },
      }),
    );
    expect(refusal.code).toBe('commerce.request_invalid');
  });

  it('refuses a fixed amount in a currency the tenant does not sell in', async () => {
    const refusal = await refusalOf(
      ctx.container.discounts.create(tenantA, owner, {
        idempotencyKey: key(),
        write: { ...BASE, type: 'FIXED_AMOUNT', value: 1_000n, currency: 'USD' },
      }),
    );
    expect(refusal.code).toBe('commerce.product_currency_unsupported');
  });

  it('charges catalog.discounts.edit to write a rule and denies a role without it', async () => {
    const support = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'support-pricing',
        roleKeys: ['support'],
      }),
    );
    const sales = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'sales-pricing', roleKeys: ['sales'] }),
    );
    const denied = await refusalOf(
      ctx.container.discounts.create(tenantA, support, { idempotencyKey: key(), write: BASE }),
    );
    expect(denied.kind).toBe('PERMISSION_DENIED');
    // Sales holds the discount permission and not the pricing one.
    await rule({ label: 'فروش' }, { actor: sales });
    const cashbackDenied = await refusalOf(
      ctx.container.cashbackRules.create(tenantA, sales, {
        idempotencyKey: key(),
        write: {
          label: 'کش‌بک',
          percent: 5,
          appliesTo: ['NEW_SERVICE'],
          productId: null,
          categoryId: null,
          startsAt: null,
          endsAt: null,
        },
      }),
    );
    expect(cashbackDenied.kind).toBe('PERMISSION_DENIED');
  });

  it('keeps tenants apart: another tenant’s code is unknown, its rule not found, its automatic rule absent', async () => {
    const foreign = await rule(
      { kind: 'CODE', code: 'FOREIGN', value: 50n },
      { scope: tenantB, actor: ownerB },
    );
    await rule({ label: 'خارجی', value: 50n }, { scope: tenantB, actor: ownerB });

    const order = await draft(customerA, await product(100_000n));
    expect(order.totals.discount.amountMinor, 'no automatic rule crossed').toBe(0n);
    const refusal = await refusalOf(applyCode(customerA, order, 'FOREIGN'));
    expect(refusal.details?.['reason']).toBe('UNKNOWN_CODE');
    const missing = await refusalOf(ctx.container.discounts.get(tenantA, owner, foreign));
    expect(missing.code).toBe('commerce.discount_not_found');

    // And the same code may exist in both tenants: the index is per tenant.
    await rule({ kind: 'CODE', code: 'FOREIGN', value: 5n });
    const customerB = await customer(tenantB, BOT_B, '910009');
    const theirs = await ctx.container.orders.createDraft(tenantB, customerActor(key()), {
      idempotencyKey: key(),
      customerId: customerB,
      productId: await product(100_000n, tenantB, panelB),
    });
    expect(theirs.totals.total.amountMinor, 'B’s own automatic 50%').toBe(50_000n);
  });

  it('previews without writing, locking or redeeming anything', async () => {
    const id = await rule({ kind: 'CODE', code: 'PEEK', value: 10n, totalLimit: 1 });
    const productId = await product(100_000n);
    const preview = await ctx.container.pricingRead.preview(tenantA, owner, {
      purpose: 'NEW_SERVICE',
      productId,
      code: 'peek',
    });
    expect(preview.totals.total.amountMinor).toBe(90_000n);
    expect(preview.code).toEqual({ accepted: true, reason: null });
    expect(preview.outcomes.find((o) => o.rule.id === id)?.outcome).toBe('APPLIED');
    expect(await count(sql`SELECT count(*)::int AS n FROM discount_redemptions`)).toBe(0);
    expect(await count(sql`SELECT count(*)::int AS n FROM orders`)).toBe(0);
  });

  it('reports a customer-scoped rule as CUSTOMER_DEPENDENT when the preview names no customer', async () => {
    const id = await rule({ customerId: customerA });
    const preview = await ctx.container.pricingRead.preview(tenantA, owner, {
      purpose: 'NEW_SERVICE',
      productId: await product(100_000n),
    });
    expect(preview.outcomes.find((o) => o.rule.id === id)?.outcome).toBe('CUSTOMER_DEPENDENT');
    expect(preview.totals.discount.amountMinor).toBe(0n);
  });

  it('shows an order’s pricing: its steps, what confirmation redeemed, and its code', async () => {
    const id = await rule({ kind: 'CODE', code: 'SHOW', value: 25n });
    const order = await applyCode(
      customerA,
      await draft(customerA, await product(100_000n)),
      'SHOW',
    );
    await confirm(customerA, order);
    const pricing = await ctx.container.pricingRead.orderPricing(tenantA, owner, order.id);
    expect(pricing.order.discountCode).toBe('SHOW');
    expect(pricing.redemptions.map((r) => [r.discountId, r.amount.amountMinor])).toEqual([
      [id, 25_000n],
    ]);
    expect(pricing.cashback).toBeNull();
  });

  // -------------------------------------------------------------------------
  // What the database refuses on its own
  // -------------------------------------------------------------------------

  it('refuses to edit or delete a redemption, whoever asks', async () => {
    await rule({ value: 20n });
    await confirm(customerA, await draft(customerA, await product(100_000n)));
    await expect(
      ctx.container.database.db.execute(sql`UPDATE discount_redemptions SET amount = 1`),
    ).rejects.toThrow();
    await expect(
      ctx.container.database.db.execute(sql`DELETE FROM discount_redemptions`),
    ).rejects.toThrow();
    expect(await count(sql`SELECT count(*)::int AS n FROM discount_redemptions`)).toBe(1);
  });
});
