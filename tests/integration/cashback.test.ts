import { sql, type SQL } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  cashbackTargetMinor,
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
import type {
  CashbackRuleWrite,
  DiscountRuleWrite,
} from '../../apps/api/src/modules/commerce/pricing/application/ports';
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
 * Cashback, from the promise a quote makes to the credit delivery earns and the
 * reversal a refund owes (`docs/wp8-pricing-audit.md` P8, P9).
 *
 * The rules under test, each a way to give away or keep money that is not ours:
 *
 * - earned EXACTLY ONCE, and only at delivery — an operation of the order's
 *   `PURCHASED_AS` type `SUCCEEDED`;
 * - an order that ends without delivery earns NOTHING and its promise is VOID;
 * - a refund takes back the share it made owed, by the cumulative formula, so partial
 *   refunds sum to what one full refund would take;
 * - what the balance cannot cover is RECORDED as unrecovered, never collected, and the
 *   wallet never goes negative;
 * - the promise's terms are frozen and its history is append-only, in the database.
 *
 * Delivery is simulated by moving the order's operation to `SUCCEEDED` in SQL: the
 * provisioner's own path to that state has its suites, and what this file owns is what
 * the cashback lane does once it is there.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;

const customerActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

const TEN_PERCENT: CashbackRuleWrite = {
  label: 'کش‌بک ده درصد',
  percent: 10,
  appliesTo: ['NEW_SERVICE'],
  productId: null,
  categoryId: null,
  startsAt: null,
  endsAt: null,
};

describe('cashback is earned once, at delivery, and a refund takes its share back', () => {
  let ctx: TestContext;
  let products: DrizzleProductRepository;
  let owner: ActorContext;
  let finance: ActorContext;
  let panelA: string;
  let customerA: UserId;
  let n = 0;
  const key = (): string => `cashback-key-${(n += 1)}`;

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
        username: 'owner-cashback',
        roleKeys: ['owner'],
      }),
    );
    finance = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'finance-cashback',
        roleKeys: ['finance'],
      }),
    );
    const { customer } = await ctx.container.customers.resolveFromUpdate(
      tenantA,
      customerActor('resolve-cashback'),
      {
        idempotencyKey: 'resolve-cashback',
        telegramUserId: '920001',
        from: { id: 920001, first_name: 'زهرا' },
        botInstanceId: BOT_A,
      },
    );
    customerA = customer.id;
  });

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  async function product(price: bigint): Promise<ProductId> {
    const created = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن پایه',
        description: 'یک ماهه',
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: panelA as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: 2 },
        price: money(price, 'IRT'),
      },
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, created.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    return created.id;
  }

  async function cashbackRule(write: Partial<CashbackRuleWrite> = {}): Promise<string> {
    const created = await ctx.container.cashbackRules.create(tenantA, owner, {
      idempotencyKey: key(),
      write: { ...TEN_PERCENT, ...write },
    });
    await ctx.container.cashbackRules.activate(tenantA, owner, {
      idempotencyKey: key(),
      ruleId: created.id,
    });
    return created.id;
  }

  async function discountRule(write: Partial<DiscountRuleWrite>): Promise<void> {
    const created = await ctx.container.discounts.create(tenantA, owner, {
      idempotencyKey: key(),
      write: {
        kind: 'AUTOMATIC',
        code: null,
        label: 'حراج',
        type: 'PERCENTAGE',
        value: 50n,
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
        ...write,
      },
    });
    await ctx.container.discounts.activate(tenantA, owner, {
      idempotencyKey: key(),
      discountId: created.rule.id,
    });
  }

  async function confirmed(price: bigint): Promise<OrderRecord> {
    const order = await ctx.container.orders.createDraft(tenantA, customerActor(key()), {
      idempotencyKey: key(),
      customerId: customerA,
      productId: await product(price),
    });
    return ctx.container.orders.confirm(tenantA, customerActor(key()), {
      idempotencyKey: key(),
      customerId: customerA,
      orderId: order.id,
    });
  }

  const credit = (amountMinor: bigint) =>
    ctx.container.wallet.adjust(tenantA, owner, customerA, {
      idempotencyKey: key(),
      direction: 'CREDIT',
      amountMinor,
      currency: 'IRT',
      note: 'موجودی آزمون',
    });

  const debit = (amountMinor: bigint) =>
    ctx.container.wallet.adjust(tenantA, owner, customerA, {
      idempotencyKey: key(),
      direction: 'DEBIT',
      amountMinor,
      currency: 'IRT',
      note: 'خرج شد',
    });

  /** Paid from the wallet. Returns the payment id. */
  async function paidFromWallet(order: OrderRecord): Promise<string> {
    await credit(order.totals.total.amountMinor);
    const { payment } = await ctx.container.payments.settleFromWallet(
      tenantA,
      customerActor(key()),
      customerA,
      { idempotencyKey: key(), orderId: order.id },
    );
    return payment.id;
  }

  /** Paid by a bank transfer an operator confirmed. Returns the payment id. */
  async function paidByTransfer(order: OrderRecord): Promise<string> {
    const { payment } = await ctx.container.payments.requestManualTransfer(
      tenantA,
      customerActor(key()),
      customerA,
      { idempotencyKey: key(), orderId: order.id },
    );
    await ctx.container.payments.confirmManualTransfer(tenantA, finance, payment.id, {
      idempotencyKey: key(),
      note: 'کارت به کارت',
    });
    return payment.id;
  }

  const deliver = (orderId: string) =>
    ctx.container.database.db.execute(sql`
      UPDATE provisioning_operations
         SET state = 'SUCCEEDED', completed_at = now(), claimed_by = NULL, lease_until = NULL
       WHERE order_id = ${orderId}`);

  const refund = (paymentId: string, amountMinor: bigint) =>
    ctx.container.refunds.request(tenantA, owner, {
      idempotencyKey: key(),
      paymentId,
      amountMinor,
      reason: 'درخواست مشتری',
    });

  async function rows<T>(query: SQL): Promise<T[]> {
    return ((await ctx.container.database.db.execute(query as never)) as unknown as { rows: T[] })
      .rows;
  }

  async function count(query: SQL): Promise<number> {
    return (await rows<{ n: number }>(query))[0]?.n ?? 0;
  }

  const promise = async (orderId: string) =>
    (
      await rows<{ state: string; amount: string; earned_amount: string | null }>(
        sql`SELECT state, amount::text AS amount, earned_amount::text AS earned_amount
              FROM order_cashback WHERE order_id = ${orderId}`,
      )
    )[0];

  const balance = async (): Promise<bigint> =>
    BigInt(
      (
        await rows<{ b: string }>(
          sql`SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0)::text AS b
                FROM wallet_entries WHERE customer_id = ${customerA}`,
        )
      )[0]?.b ?? '0',
    );

  const entries = (reason: string) =>
    rows<{ id: string; amount: string; reference: string; reverses_entry_id: string | null }>(
      sql`SELECT id, amount::text AS amount, reference, reverses_entry_id
            FROM wallet_entries WHERE reason = ${reason} ORDER BY created_at, id`,
    );

  const reversals = () =>
    rows<{ refund_id: string; due: string; recovered: string; unrecovered: string }>(
      sql`SELECT refund_id, due_amount::text AS due, recovered_amount::text AS recovered,
                 unrecovered_amount::text AS unrecovered
            FROM cashback_reversals ORDER BY created_at, id`,
    );

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

  /** Runs `hold` in an outside transaction and keeps it open until released. */
  async function holding(
    hold: (tx: { execute: (q: SQL) => Promise<unknown> }) => Promise<void>,
    finish: 'COMMIT' | 'ROLLBACK' = 'COMMIT',
  ): Promise<{ release: () => Promise<void> }> {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    let held!: () => void;
    const ready = new Promise<void>((resolve) => (held = resolve));
    const rollback = new Error('rolled back on purpose');
    const holder = ctx.container.database.db
      .transaction(async (tx) => {
        await hold(tx as never);
        held();
        await gate;
        if (finish === 'ROLLBACK') throw rollback;
      })
      .catch((error: unknown) => {
        if (error !== rollback) throw error;
      });
    await ready;
    return {
      release: async () => {
        open();
        await holder;
      },
    };
  }

  // -------------------------------------------------------------------------
  // The promise
  // -------------------------------------------------------------------------

  it('promises cashback on the final total, and records the promise at confirmation', async () => {
    const ruleId = await cashbackRule();
    const order = await confirmed(100_000n);
    expect(order.totals.quote.cashback?.amount.amountMinor).toBe(10_000n);
    expect(order.totals.quote.cashback?.ruleId).toBe(ruleId);
    expect(await promise(order.id)).toEqual({
      state: 'PENDING',
      amount: '10000',
      earned_amount: null,
    });
  });

  it('computes cashback on what is paid AFTER discounts, rounding down', async () => {
    await discountRule({ value: 50n });
    await cashbackRule({ percent: 7 });
    const order = await confirmed(100_001n);
    // 100 001 → 50 000 after a 50% discount rounded in the customer's favour; 7% of that.
    expect(order.totals.total.amountMinor).toBe(50_000n);
    expect(order.totals.quote.cashback?.amount.amountMinor).toBe(3_500n);
  });

  it('takes the highest percent when several rules apply, and never stacks them', async () => {
    await cashbackRule({ label: 'پنج', percent: 5 });
    const best = await cashbackRule({ label: 'دوازده', percent: 12 });
    const order = await confirmed(100_000n);
    expect(order.totals.quote.cashback).toMatchObject({ ruleId: best, percent: 12 });
    expect(order.totals.quote.cashback?.amount.amountMinor).toBe(12_000n);
  });

  it('promises nothing on an order a discount made free', async () => {
    await discountRule({ value: 100n });
    await cashbackRule();
    const order = await confirmed(100_000n);
    expect(order.totals.total.amountMinor).toBe(0n);
    expect(order.totals.quote.cashback).toBeUndefined();
    expect(await promise(order.id)).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Earning
  // -------------------------------------------------------------------------

  it('earns nothing before delivery, then credits exactly once', async () => {
    await cashbackRule();
    const order = await confirmed(100_000n);
    await paidFromWallet(order);

    expect(await ctx.container.cashback.settleDue(tenantA, 50), 'paid is not delivered').toBe(0);
    expect((await promise(order.id))?.state).toBe('PENDING');

    await deliver(order.id);
    expect(await ctx.container.cashback.settleDue(tenantA, 50)).toBe(1);
    expect(await ctx.container.cashback.settleDue(tenantA, 50), 'and never again').toBe(0);
    expect(await ctx.container.cashback.settle(tenantA, order.id)).toBe(false);

    expect(await promise(order.id)).toEqual({
      state: 'EARNED',
      amount: '10000',
      earned_amount: '10000',
    });
    const credits = await entries('CASHBACK_PURCHASE');
    expect(credits.map((e) => [e.amount, e.reference])).toEqual([
      ['10000', `${order.id}:cashback`],
    ]);
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM outbox_messages WHERE event_type = 'CashbackEarned'`,
      ),
    ).toBe(1);
    expect(await balance()).toBe(10_000n);
  });

  it('serialises two earners on the customer’s wallet lock, so one credit is written', async () => {
    await cashbackRule();
    const order = await confirmed(100_000n);
    await paidFromWallet(order);
    await deliver(order.id);

    const held = await holding(async (tx) => {
      await tx.execute(sql`SELECT id FROM customers WHERE id = ${customerA} FOR UPDATE`);
    });
    const a = ctx.container.cashback.settle(tenantA, order.id);
    const b = ctx.container.cashback.settle(tenantA, order.id);
    await awaitBlocked(2, 'both earners');
    await held.release();

    expect((await Promise.all([a, b])).sort()).toEqual([false, true]);
    expect(await entries('CASHBACK_PURCHASE')).toHaveLength(1);
  });

  it('voids the promise of an order cancelled before it was paid', async () => {
    await cashbackRule();
    const order = await confirmed(100_000n);
    await ctx.container.orders.cancelByCustomer(tenantA, customerActor(key()), {
      idempotencyKey: key(),
      customerId: customerA,
      orderId: order.id,
    });
    expect(await ctx.container.cashback.settleDue(tenantA, 50)).toBe(1);
    expect((await promise(order.id))?.state).toBe('VOID');
    expect(await entries('CASHBACK_PURCHASE')).toHaveLength(0);
  });

  it('voids the promise of a paid order refunded because it could not be delivered', async () => {
    await cashbackRule();
    const order = await confirmed(100_000n);
    const { payment } = await ctx.container.payments.requestManualTransfer(
      tenantA,
      customerActor(key()),
      customerA,
      { idempotencyKey: key(), orderId: order.id },
    );
    // The panel stops being sellable while the transfer waits for review.
    await ctx.container.database.db.execute(
      sql`UPDATE panels SET status = 'DISABLED' WHERE id = ${panelA}`,
    );
    const settled = await ctx.container.payments.confirmManualTransfer(
      tenantA,
      finance,
      payment.id,
      {
        idempotencyKey: key(),
        note: 'کارت به کارت',
      },
    );
    expect(settled.order?.state).toBe('REFUNDED');

    await ctx.container.cashback.settleDue(tenantA, 50);
    expect((await promise(order.id))?.state).toBe('VOID');
    expect(await entries('CASHBACK_PURCHASE')).toHaveLength(0);
    expect(await reversals()).toHaveLength(0);
  });

  it('keeps tenants apart: another tenant’s sweep decides nothing here', async () => {
    await cashbackRule();
    const order = await confirmed(100_000n);
    await paidFromWallet(order);
    await deliver(order.id);
    expect(await ctx.container.cashback.settleDue(tenantB, 50)).toBe(0);
    expect(await ctx.container.cashback.settle(tenantB, order.id)).toBe(false);
    expect((await promise(order.id))?.state).toBe('PENDING');
  });

  // -------------------------------------------------------------------------
  // Reversal
  // -------------------------------------------------------------------------

  it('takes earned cashback back in full when the whole payment is refunded', async () => {
    await cashbackRule();
    const order = await confirmed(100_000n);
    const paymentId = await paidFromWallet(order);
    await deliver(order.id);
    await ctx.container.cashback.settleDue(tenantA, 50);
    const [earned] = await entries('CASHBACK_PURCHASE');

    const refunded = await refund(paymentId, 100_000n);

    expect(await reversals()).toEqual([
      { refund_id: refunded.id, due: '10000', recovered: '10000', unrecovered: '0' },
    ]);
    const debits = await entries('CASHBACK_REVERSAL');
    expect(debits.map((e) => [e.amount, e.reference, e.reverses_entry_id])).toEqual([
      ['10000', `${refunded.id}:cashback-reversal`, earned?.id],
    ]);
    // 100 000 paid in, 100 000 refunded, 10 000 earned and 10 000 taken back.
    expect(await balance()).toBe(100_000n);
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM outbox_messages WHERE event_type = 'CashbackReversed'`,
      ),
    ).toBe(1);
  });

  it('reverses exactly what one full refund would, across partial refunds that do not divide evenly', async () => {
    await cashbackRule({ percent: 7 });
    const order = await confirmed(99_999n);
    const paymentId = await paidFromWallet(order);
    await deliver(order.id);
    await ctx.container.cashback.settleDue(tenantA, 50);
    const promised = 6_999n; // floor(99 999 × 7 / 100)
    expect((await promise(order.id))?.earned_amount).toBe(promised.toString());

    await refund(paymentId, 33_333n);
    await refund(paymentId, 33_333n);
    await refund(paymentId, 33_333n);

    const dues = (await reversals()).map((r) => BigInt(r.due));
    // Each due is the cumulative target's step, so they sum to the whole promise.
    expect(dues).toEqual([
      promised - cashbackTargetMinor(promised, 99_999n, 33_333n),
      cashbackTargetMinor(promised, 99_999n, 33_333n) -
        cashbackTargetMinor(promised, 99_999n, 66_666n),
      cashbackTargetMinor(promised, 99_999n, 66_666n),
    ]);
    expect(dues.reduce((a, b) => a + b, 0n)).toBe(promised);
  });

  it('records what a spent balance cannot cover, and never takes the wallet below zero', async () => {
    await cashbackRule();
    const order = await confirmed(100_000n);
    const paymentId = await paidByTransfer(order);
    await deliver(order.id);
    await ctx.container.cashback.settleDue(tenantA, 50);
    // Six thousand of the ten thousand earned is spent.
    await debit(6_000n);
    expect(await balance()).toBe(4_000n);

    const manual = await refund(paymentId, 100_000n);
    expect(manual.state, 'a bank refund waits for the bank').toBe('AWAITING_EXTERNAL');
    expect(await reversals(), 'nothing is owed until the money has gone back').toHaveLength(0);

    await ctx.container.refunds.complete(tenantA, owner, {
      idempotencyKey: key(),
      refundId: manual.id,
      note: 'واریز شد',
      externalReference: null,
    });

    expect(await reversals()).toEqual([
      { refund_id: manual.id, due: '10000', recovered: '4000', unrecovered: '6000' },
    ]);
    expect(await balance()).toBe(0n);
  });

  it('reverses nothing twice for a replayed completion', async () => {
    await cashbackRule();
    const order = await confirmed(100_000n);
    const paymentId = await paidByTransfer(order);
    await deliver(order.id);
    await ctx.container.cashback.settleDue(tenantA, 50);
    const manual = await refund(paymentId, 100_000n);
    const input = {
      idempotencyKey: key(),
      refundId: manual.id,
      note: 'واریز شد',
      externalReference: null,
    };
    await ctx.container.refunds.complete(tenantA, owner, input);
    await ctx.container.refunds.complete(tenantA, owner, input);
    expect(await reversals()).toHaveLength(1);
    expect(await entries('CASHBACK_REVERSAL')).toHaveLength(1);
  });

  it('earns only the refunded-down share when the refund completed before delivery was noticed', async () => {
    await cashbackRule();
    const order = await confirmed(100_000n);
    const paymentId = await paidFromWallet(order);
    await refund(paymentId, 40_000n);
    await deliver(order.id);
    await ctx.container.cashback.settleDue(tenantA, 50);
    // 60% of the payment stands, so 60% of the promise is earned and nothing is reversed.
    expect((await promise(order.id))?.earned_amount).toBe('6000');
    expect(await reversals()).toHaveLength(0);
  });

  it('never misses a reversal when a refund completes while the earner is mid-credit', async () => {
    /*
     * The interleaving the reversal's lock order exists for.
     *
     * The earner has taken the customer's lock, read the refunds (none COMPLETED yet)
     * and is writing the full credit. It is held THERE by an outside transaction that
     * has inserted the same ledger reference and not committed — the unique index makes
     * the earner's insert wait on it. Meanwhile a manual refund completes. Before the
     * fix, the reversal read the promise unlocked, saw PENDING, and returned: the full
     * credit then committed with nothing to take its share back. Now the reversal waits
     * on the customer's lock behind the earner and sees the promise EARNED.
     */
    await cashbackRule();
    const order = await confirmed(100_000n);
    const paymentId = await paidByTransfer(order);
    await deliver(order.id);
    const manual = await refund(paymentId, 50_000n);

    const blocker = await holding(async (tx) => {
      await tx.execute(sql`
        INSERT INTO wallet_entries (id, tenant_id, customer_id, direction, reason, amount,
                                    currency, reference)
        VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, ${customerA}, 'CREDIT',
                'CASHBACK_PURCHASE', 1, 'IRT', ${`${order.id}:cashback`})`);
    }, 'ROLLBACK');

    const earning = ctx.container.cashback.settle(tenantA, order.id);
    await awaitBlocked(1, 'the earner at its ledger insert');
    const completing = ctx.container.refunds.complete(tenantA, owner, {
      idempotencyKey: key(),
      refundId: manual.id,
      note: 'واریز شد',
      externalReference: null,
    });
    await awaitBlocked(2, 'the refund completion behind the earner');
    await blocker.release();

    expect(await earning).toBe(true);
    await completing;

    const earned = BigInt((await promise(order.id))?.earned_amount ?? '0');
    const reversed = (await reversals()).reduce((sum, r) => sum + BigInt(r.due), 0n);
    expect(earned, 'the earner read no completed refund').toBe(10_000n);
    expect(earned - reversed, 'half the payment stands, so half the promise').toBe(5_000n);
  });

  // -------------------------------------------------------------------------
  // The operator's view, and what the database refuses on its own
  // -------------------------------------------------------------------------

  it('shows an order’s cashback: promised, earned, reversed and unrecovered', async () => {
    await cashbackRule();
    const order = await confirmed(100_000n);
    const paymentId = await paidByTransfer(order);
    await deliver(order.id);
    await ctx.container.cashback.settleDue(tenantA, 50);
    await debit(10_000n);
    const manual = await refund(paymentId, 100_000n);
    await ctx.container.refunds.complete(tenantA, owner, {
      idempotencyKey: key(),
      refundId: manual.id,
      note: 'واریز شد',
      externalReference: null,
    });

    const pricing = await ctx.container.pricingRead.orderPricing(tenantA, owner, order.id);
    expect(pricing.cashback?.promise.state).toBe('EARNED');
    expect(pricing.cashback?.promise.earnedAmount).toBe(10_000n);
    expect(pricing.cashback?.reversals.map((r) => [r.due, r.recovered, r.unrecovered])).toEqual([
      [10_000n, 0n, 10_000n],
    ]);
  });

  it('freezes a promise’s terms, allows only PENDING onward, and refuses deletes', async () => {
    await cashbackRule();
    const order = await confirmed(100_000n);
    const db = ctx.container.database.db;
    await expect(
      db.execute(sql`UPDATE order_cashback SET amount = 1 WHERE order_id = ${order.id}`),
    ).rejects.toThrow();
    await expect(
      db.execute(sql`UPDATE order_cashback SET percent = 50 WHERE order_id = ${order.id}`),
    ).rejects.toThrow();
    await expect(db.execute(sql`DELETE FROM order_cashback`)).rejects.toThrow();

    await ctx.container.orders.cancelByCustomer(tenantA, customerActor(key()), {
      idempotencyKey: key(),
      customerId: customerA,
      orderId: order.id,
    });
    await ctx.container.cashback.settleDue(tenantA, 50);
    await expect(
      db.execute(
        sql`UPDATE order_cashback SET state = 'PENDING', voided_at = NULL WHERE order_id = ${order.id}`,
      ),
      'a VOID promise does not come back',
    ).rejects.toThrow();
  });

  it('refuses to edit or delete a reversal', async () => {
    await cashbackRule();
    const order = await confirmed(100_000n);
    const paymentId = await paidFromWallet(order);
    await deliver(order.id);
    await ctx.container.cashback.settleDue(tenantA, 50);
    await refund(paymentId, 100_000n);
    const db = ctx.container.database.db;
    await expect(db.execute(sql`UPDATE cashback_reversals SET due_amount = 1`)).rejects.toThrow();
    await expect(db.execute(sql`DELETE FROM cashback_reversals`)).rejects.toThrow();
    expect(await reversals()).toHaveLength(1);
  });
});
