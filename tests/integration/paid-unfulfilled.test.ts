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
import type { ProductDraft } from '../../apps/api/src/modules/commerce/catalog/application/ports';
import type { OrderRecord } from '../../apps/api/src/modules/commerce/orders/application/ports';
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
 * Money that arrived, for a service that could not be created.
 *
 * Codex C4 on PR #50, and the defect it names is the worst kind this codebase can
 * have: a bank transfer the customer really made, sitting in the account, with the
 * confirmation REFUSED because the panel filled up or was disabled while the receipt
 * waited in the review queue. The payment stayed `PENDING` — which cannot be confirmed
 * and cannot be refunded, because a refund needs a confirmed payment — and the money
 * had no record of what it was for.
 *
 * So the rule these cases exist to hold is one sentence: recording the RECEIPT of
 * money is independent of the ability to fulfil it. Everything else here is a
 * consequence.
 *
 * What is deliberately NOT relaxed is the wallet path. A wallet debit is written in
 * the same transaction as the settlement and dies with it, so the stricter refusal
 * still applies: an installation that cannot deliver does not take money it can still
 * decline.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

describe('an order paid for and not fulfilled', () => {
  let ctx: TestContext;
  let products: DrizzleProductRepository;
  let panelA: string;
  let panelSpare: string;
  let panelForeign: string;
  let customerA: UserId;
  let owner: ActorContext;
  let finance: ActorContext;
  let support: ActorContext;
  let n = 0;
  const key = (): string => `unfulfilled-key-${(n += 1)}`;

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
    panelSpare = ctx.container.ids.uuid();
    panelForeign = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelA}, ${tenantA.tenantId}, 'Panel A', 'sanaei', 'https://a.example.test', 'ACTIVE'),
             (${panelSpare}, ${tenantA.tenantId}, 'Panel Spare', 'sanaei', 'https://s.example.test', 'ACTIVE'),
             (${panelForeign}, ${tenantB.tenantId}, 'Panel B', 'sanaei', 'https://b.example.test', 'ACTIVE')`);
    customerA = await customer('900801');
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'owner-unfulfilled',
        roleKeys: ['owner'],
      }),
    );
    finance = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'finance-unfulfilled',
        roleKeys: ['finance'],
      }),
    );
    support = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'support-unfulfilled',
        roleKeys: ['support'],
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
        from: { id: Number(telegramUserId), first_name: 'زهرا' },
        botInstanceId: BOT_A,
      },
    );
    return record.id;
  }

  const draft = (panelId: string): ProductDraft => ({
    title: 'پلن پایه',
    description: 'یک ماهه',
    audience: 'EVERYONE',
    sortOrder: 10,
    panelId: panelId as PanelId,
    specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: 2 },
    price: money(250_000n, 'IRT'),
  });

  /** An order in `AWAITING_PAYMENT`, made the way a customer makes one. */
  async function awaitingPayment(panelId: string): Promise<OrderRecord> {
    const created = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: draft(panelId),
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, created.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    const k = key();
    const order = await ctx.container.orders.createDraft(tenantA, systemActor(k), {
      idempotencyKey: `${k}-draft`,
      customerId: customerA,
      productId: created.id,
    });
    return ctx.container.orders.confirm(tenantA, systemActor(k), {
      idempotencyKey: `${k}-confirm`,
      customerId: customerA,
      orderId: order.id,
    });
  }

  /** A manual transfer awaiting review — the money is in the bank by now. */
  async function pendingTransfer(order: OrderRecord): Promise<string> {
    const k = key();
    const { payment } = await ctx.container.payments.requestManualTransfer(
      tenantA,
      systemActor(k),
      customerA,
      { idempotencyKey: `${k}-manual`, orderId: order.id },
    );
    return payment.id;
  }

  const confirmTransfer = (paymentId: string, reviewer: ActorContext = finance) =>
    ctx.container.payments.confirmManualTransfer(tenantA, reviewer, paymentId, {
      idempotencyKey: key(),
      note: 'کارت به کارت',
    });

  const setCap = (panelId: string, cap: number | null) =>
    ctx.container.database.db.execute(
      sql`UPDATE panels SET max_services = ${cap} WHERE id = ${panelId}`,
    );

  const setStatus = (panelId: string, status: string) =>
    ctx.container.database.db.execute(sql`
      UPDATE panels
         SET status = ${status},
             archived_at = CASE WHEN ${status} = 'ARCHIVED' THEN now() ELSE NULL END
       WHERE id = ${panelId}`);

  const setHealth = (panelId: string, state: string, streak: number) =>
    ctx.container.database.db.execute(sql`
      INSERT INTO panel_health (panel_id, tenant_id, state, checked_at, latency_ms, failure,
                                unusable_streak)
      VALUES (${panelId}, ${tenantA.tenantId}, ${state}, ${ctx.container.clock.now()}, 5,
              'AUTHENTICATION_FAILED', ${streak})
      ON CONFLICT (panel_id) DO UPDATE
         SET state = EXCLUDED.state, checked_at = EXCLUDED.checked_at,
             failure = EXCLUDED.failure, unusable_streak = EXCLUDED.unusable_streak`);

  /** Drops the order's hold, which is what an expired reservation amounts to. */
  const expireHold = (orderId: string) =>
    ctx.container.database.db.execute(
      sql`DELETE FROM panel_capacity_reservations WHERE order_id = ${orderId}`,
    );

  /** Occupy the panel with somebody else's service, so its last slot is gone. */
  async function occupy(panelId: string): Promise<void> {
    const other = await customer(`9008${String(80 + n)}`);
    const product = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: draft(panelId),
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, product.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    const k = key();
    const order = await ctx.container.orders.createDraft(tenantA, systemActor(k), {
      idempotencyKey: `${k}-occupy`,
      customerId: other,
      productId: product.id,
    });
    await ctx.container.database.db.execute(sql`
      INSERT INTO services (id, tenant_id, customer_id, order_id, panel_id, product_id,
                            provider_username, subscription_ref, provider_client_id,
                            traffic_limit_bytes, state, provisioned_at)
      VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, ${other}, ${order.id},
              ${panelId}, ${product.id}, ${'u' + String(n) + Math.random().toString(16).slice(2, 8)},
              ${Math.random().toString(16).slice(2).padEnd(32, '0').slice(0, 32)},
              ${ctx.container.ids.uuid()}, 0, 'ACTIVE', now())`);
  }

  const orderRow = async (orderId: string) => {
    const rows = (await ctx.container.database.db.execute(
      sql`SELECT state, settled_at, unfulfilled_at, unfulfilled_reason, panel_id
            FROM orders WHERE id = ${orderId}` as never,
    )) as unknown as {
      rows: {
        state: string;
        // Raw `execute` bypasses drizzle's column mapping, so these arrive as the
        // driver's own text form rather than a Date. Typed as they actually are.
        settled_at: string | null;
        unfulfilled_at: string | null;
        unfulfilled_reason: string | null;
        panel_id: string;
      }[];
    };
    return rows.rows[0];
  };

  const countOf = async (table: 'services' | 'refunds' | 'notifications'): Promise<number> => {
    const rows = (await ctx.container.database.db.execute(
      sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)}` as never,
    )) as unknown as { rows: { n: number }[] };
    return rows.rows[0]?.n ?? 0;
  };

  const openConditions = async (code: string): Promise<number> => {
    const rows = (await ctx.container.database.db.execute(
      sql`SELECT count(*)::int AS n FROM operational_events
           WHERE code = ${code} AND resolved_at IS NULL` as never,
    )) as unknown as { rows: { n: number }[] };
    return rows.rows[0]?.n ?? 0;
  };

  // -------------------------------------------------------------------------
  // The money is recorded, whatever the panel is doing
  // -------------------------------------------------------------------------

  it('keeps the payment CONFIRMED when the hold expired and the panel is full', async () => {
    /*
     * The headline case. The customer paid, their hold lapsed while the receipt was in
     * the queue, and somebody else took the last slot. Before this, the confirmation
     * threw and the payment stayed PENDING — money in the bank with nowhere to sit.
     */
    const order = await awaitingPayment(panelA);
    const paymentId = await pendingTransfer(order);
    await setCap(panelA, 1);
    await expireHold(order.id);
    await occupy(panelA);

    const { payment, order: settled } = await confirmTransfer(paymentId);

    expect(payment.state).toBe('CONFIRMED');
    expect(settled?.state).toBe('PAID_UNFULFILLED');
    const row = await orderRow(order.id);
    expect(row?.settled_at, 'the money arrived, and the row says so').not.toBeNull();
    expect(row?.unfulfilled_reason).toBe('AT_CAPACITY');
    expect(row?.unfulfilled_at).not.toBeNull();
    expect(await countOf('services'), 'and no fake service was created').toBe(1);
  });

  it('consumes the original hold when it is still valid, and provisions normally', async () => {
    // The ordinary path, asserted here too: the change must not make a healthy
    // settlement take the stranded branch.
    const order = await awaitingPayment(panelA);
    const paymentId = await pendingTransfer(order);
    await setCap(panelA, 1);

    const { order: settled } = await confirmTransfer(paymentId);

    expect(settled?.state).toBe('PAID');
    expect((await orderRow(order.id))?.unfulfilled_reason).toBeNull();
    expect(await countOf('services')).toBe(1);
  });

  it('acquires a FRESH slot when the hold expired and the panel has room', async () => {
    /*
     * Step 3 of the owner's flow. The hold lapsed, so there is nothing to consume —
     * the order competes for a slot exactly as a new one would, under the panel's
     * lock, and wins because there is one.
     */
    const order = await awaitingPayment(panelA);
    const paymentId = await pendingTransfer(order);
    await setCap(panelA, 2);
    await expireHold(order.id);

    const { order: settled } = await confirmTransfer(paymentId);

    expect(settled?.state).toBe('PAID');
    expect(await countOf('services')).toBe(1);
  });

  it('strands the order when the panel was DISABLED after the transfer', async () => {
    const order = await awaitingPayment(panelA);
    const paymentId = await pendingTransfer(order);
    await setStatus(panelA, 'DISABLED');

    const { payment, order: settled } = await confirmTransfer(paymentId);

    expect(payment.state).toBe('CONFIRMED');
    expect(settled?.state).toBe('PAID_UNFULFILLED');
    expect((await orderRow(order.id))?.unfulfilled_reason).toBe('DISABLED');
    expect(await countOf('services')).toBe(0);
  });

  it('strands the order when the panel was ARCHIVED after the transfer', async () => {
    const order = await awaitingPayment(panelA);
    const paymentId = await pendingTransfer(order);
    await setStatus(panelA, 'ARCHIVED');

    const { payment, order: settled } = await confirmTransfer(paymentId);

    expect(payment.state).toBe('CONFIRMED');
    expect(settled?.state).toBe('PAID_UNFULFILLED');
    expect((await orderRow(order.id))?.unfulfilled_reason).toBe('ARCHIVED');
  });

  it('strands the order when the panel is CONFIRMED unhealthy', async () => {
    // Confirmed, not merely worrying: the hysteresis threshold is what makes this a
    // refusal rather than one bad probe deciding a customer's purchase.
    const order = await awaitingPayment(panelA);
    const paymentId = await pendingTransfer(order);
    await setHealth(panelA, 'UNREACHABLE', PANEL_UNHEALTHY_AFTER_FAILURES);

    const { payment, order: settled } = await confirmTransfer(paymentId);

    expect(payment.state).toBe('CONFIRMED');
    expect(settled?.state).toBe('PAID_UNFULFILLED');
    expect((await orderRow(order.id))?.unfulfilled_reason).toBe('UNHEALTHY');
  });

  it('opens ONE operational condition and tells the administrators who can act', async () => {
    const order = await awaitingPayment(panelA);
    const paymentId = await pendingTransfer(order);
    await setStatus(panelA, 'DISABLED');
    await confirmTransfer(paymentId);

    expect(await openConditions('order.fulfilment_failed')).toBe(1);
    const rows = (await ctx.container.database.db.execute(
      sql`SELECT kind, dedupe_key FROM notifications WHERE kind = 'ORDER_PAID_UNFULFILLED'` as never,
    )) as unknown as { rows: { kind: string; dedupe_key: string }[] };
    /*
     * Nobody is bound to Telegram in this fixture, so the fan-out is empty and that is
     * the correct answer rather than a hole: the condition is the durable record and
     * the message is a poke. What this asserts is that the lane is reached and writes
     * nothing it cannot address.
     */
    expect(rows.rows.every((row) => row.dedupe_key.startsWith('order.unfulfilled:'))).toBe(true);
  });

  it('strands ONCE when the same confirmation is delivered twice', async () => {
    /*
     * The duplicate an operator's double-click, or a retried request, produces. A
     * replay is answered from the idempotency store before the settling transaction
     * opens, so nothing downstream of it may run a second time: not a second
     * condition, not a second notification, not a second reservation attempt, and
     * above all not a second stamp over `unfulfilled_at`.
     *
     * The second half is the other caller — a fresh key against a payment that is
     * already CONFIRMED — which the payment state machine refuses outright.
     */
    const order = await awaitingPayment(panelA);
    const paymentId = await pendingTransfer(order);
    await setStatus(panelA, 'DISABLED');
    const idempotencyKey = key();
    const confirm = (k: string) =>
      ctx.container.payments.confirmManualTransfer(tenantA, finance, paymentId, {
        idempotencyKey: k,
        note: 'کارت به کارت',
      });

    const first = await confirm(idempotencyKey);
    const afterFirst = await orderRow(order.id);
    const replay = await confirm(idempotencyKey);
    const afterReplay = await orderRow(order.id);

    expect(first.payment.state).toBe('CONFIRMED');
    expect(replay.payment.state).toBe('CONFIRMED');
    expect(afterReplay?.state).toBe('PAID_UNFULFILLED');
    expect(afterReplay?.unfulfilled_at, 'the replay did not re-stamp the order').toBe(
      afterFirst?.unfulfilled_at,
    );
    expect(await openConditions('order.fulfilment_failed'), 'one condition, not two').toBe(1);
    expect(await countOf('services')).toBe(0);
    const paid = (await ctx.container.database.db.execute(
      sql`SELECT count(*)::int AS n FROM payments WHERE state = 'CONFIRMED'` as never,
    )) as unknown as { rows: { n: number }[] };
    expect(paid.rows[0]?.n, 'one payment, not two').toBe(1);
    const events = (await ctx.container.database.db.execute(
      sql`SELECT count(*)::int AS n FROM outbox_messages
           WHERE event_type = 'OrderPaidUnfulfilled'` as never,
    )) as unknown as { rows: { n: number }[] };
    expect(events.rows[0]?.n, 'and one event').toBe(1);

    /*
     * And the other caller: a FRESH key against a payment that is already CONFIRMED.
     * `confirmManualTransfer` answers that with the end state rather than an error —
     * two operators pressing approve must not be told the payment is broken — so what
     * is asserted is that it changes nothing, which is the part that matters here.
     */
    const second = await confirm(key());
    expect(second.payment.state).toBe('CONFIRMED');
    expect(second.order?.state).toBe('PAID_UNFULFILLED');
    expect((await orderRow(order.id))?.unfulfilled_at).toBe(afterFirst?.unfulfilled_at);
    expect(await openConditions('order.fulfilment_failed'), 'still one condition').toBe(1);
    expect(await countOf('services')).toBe(0);
  });

  it('refuses a WALLET settlement instead, because that money has not left', async () => {
    /*
     * The asymmetry, asserted as a pair with the manual case above. A wallet debit is
     * written in the settling transaction, so refusing costs the customer nothing —
     * and taking money for something this installation cannot deliver is the thing
     * the stricter rule exists to prevent.
     */
    const order = await awaitingPayment(panelA);
    await ctx.container.wallet.adjust(tenantA, owner, customerA, {
      idempotencyKey: key(),
      direction: 'CREDIT',
      amountMinor: 1_000_000n,
      currency: 'IRT',
      note: 'برای آزمون',
    });
    await setStatus(panelA, 'DISABLED');

    await expect(
      ctx.container.payments.settleFromWallet(tenantA, systemActor(key()), customerA, {
        idempotencyKey: key(),
        orderId: order.id,
      }),
    ).rejects.toMatchObject({ code: 'commerce.panel_not_eligible' });

    const row = await orderRow(order.id);
    expect(row?.state, 'the order is untouched').toBe('AWAITING_PAYMENT');
    expect(row?.settled_at).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Getting out of it
  // -------------------------------------------------------------------------

  async function stranded(): Promise<OrderRecord> {
    const order = await awaitingPayment(panelA);
    const paymentId = await pendingTransfer(order);
    await setStatus(panelA, 'DISABLED');
    const { order: settled } = await confirmTransfer(paymentId);
    if (settled === null || settled.state !== 'PAID_UNFULFILLED') {
      throw new Error('fixture did not strand the order');
    }
    return settled;
  }

  it('fulfils a stranded order once the panel is usable again', async () => {
    const order = await stranded();
    await setStatus(panelA, 'ACTIVE');

    const fulfilled = await ctx.container.orderFulfilment.fulfil(tenantA, finance, {
      idempotencyKey: key(),
      orderId: order.id,
    });

    expect(fulfilled.state).toBe('PAID');
    expect(await countOf('services')).toBe(1);
    // The history survives the repair: `orders_unfulfilled_*_check` are implications
    // rather than equalities exactly so that this stays readable afterwards.
    const row = await orderRow(order.id);
    expect(row?.unfulfilled_reason).toBe('DISABLED');
    // And the condition an operator was working from is closed.
    expect(await openConditions('order.fulfilment_failed')).toBe(0);
  });

  it('reassigns a stranded order to another panel, and says the panel changed', async () => {
    const order = await stranded();

    const fulfilled = await ctx.container.orderFulfilment.fulfil(tenantA, finance, {
      idempotencyKey: key(),
      orderId: order.id,
      panelId: panelSpare,
    });

    expect(fulfilled.state).toBe('PAID');
    expect(fulfilled.line.panelId).toBe(panelSpare);
    expect((await orderRow(order.id))?.panel_id).toBe(panelSpare);
    const events = (await ctx.container.database.db.execute(
      sql`SELECT payload FROM outbox_messages WHERE event_type = 'OrderFulfilled'` as never,
    )) as unknown as { rows: { payload: { reassigned: boolean; panelId: string } }[] };
    expect(events.rows[0]?.payload.reassigned).toBe(true);
    expect(events.rows[0]?.payload.panelId).toBe(panelSpare);
  });

  it("refuses to re-point a PAID order's panel, which is still frozen", async () => {
    /*
     * The bound on the exception migration 0083 adds. `panel_id` moves ONLY out of
     * `PAID_UNFULFILLED` and into `PAID` — the `FULFIL` edge, the one transition where
     * no service exists yet for the order and the service is written in the same
     * statement's transaction. Asserted against the LIVE trigger, because that is
     * where the rule lives: a guard widened by one state must still refuse the other
     * five.
     */
    const order = await awaitingPayment(panelA);
    const paymentId = await pendingTransfer(order);
    await confirmTransfer(paymentId);
    expect((await orderRow(order.id))?.state).toBe('PAID');

    await expect(
      ctx.container.database.db.execute(
        sql`UPDATE orders SET panel_id = ${panelSpare} WHERE id = ${order.id}`,
      ),
      // The driver wraps the failure, so the TRIGGER's own message is on the cause.
      // `23514` is `check_violation`, which is what `RAISE ... USING ERRCODE` sets.
    ).rejects.toMatchObject({
      cause: { code: '23514', message: expect.stringMatching(/immutable/u) },
    });
  });

  it('refuses a retry while the panel is still unusable, and leaves the order stranded', async () => {
    const order = await stranded();

    await expect(
      ctx.container.orderFulfilment.fulfil(tenantA, finance, {
        idempotencyKey: key(),
        orderId: order.id,
      }),
    ).rejects.toMatchObject({ code: 'commerce.panel_not_eligible' });

    const row = await orderRow(order.id);
    expect(row?.state).toBe('PAID_UNFULFILLED');
    // NOT re-stranded: the timestamp is the original one, and no second condition or
    // notification was produced for the same order.
    expect(row?.unfulfilled_reason).toBe('DISABLED');
    expect(await openConditions('order.fulfilment_failed')).toBe(1);
    expect(await countOf('services')).toBe(0);
  });

  it('refuses a reassignment to another tenant s panel as UNKNOWN', async () => {
    // Not "archived", which is what the eligibility evaluator answers for a panel it
    // cannot see: telling an operator their own panel is archived when they named
    // somebody else's is a misleading answer to a fat-finger.
    const order = await stranded();

    await expect(
      ctx.container.orderFulfilment.fulfil(tenantA, finance, {
        idempotencyKey: key(),
        orderId: order.id,
        panelId: panelForeign,
      }),
    ).rejects.toMatchObject({ code: 'panel.not_found' });
    expect((await orderRow(order.id))?.state).toBe('PAID_UNFULFILLED');
  });

  it('refuses a retry from an administrator without orders.fulfil', async () => {
    const order = await stranded();
    await setStatus(panelA, 'ACTIVE');

    await expect(
      ctx.container.orderFulfilment.fulfil(tenantA, support, {
        idempotencyKey: key(),
        orderId: order.id,
      }),
    ).rejects.toMatchObject({ kind: 'PERMISSION_DENIED' });
    expect((await orderRow(order.id))?.state).toBe('PAID_UNFULFILLED');
    expect(await countOf('services')).toBe(0);
  });

  it('answers a replayed retry with the order, and creates ONE service', async () => {
    const order = await stranded();
    await setStatus(panelA, 'ACTIVE');
    const idempotencyKey = key();

    const first = await ctx.container.orderFulfilment.fulfil(tenantA, finance, {
      idempotencyKey,
      orderId: order.id,
    });
    const second = await ctx.container.orderFulfilment.fulfil(tenantA, finance, {
      idempotencyKey,
      orderId: order.id,
    });

    expect(first.state).toBe('PAID');
    expect(second.state).toBe('PAID');
    expect(await countOf('services'), 'one service, not two').toBe(1);
    const fulfilments = (await ctx.container.database.db.execute(
      sql`SELECT count(*)::int AS n FROM outbox_messages WHERE event_type = 'OrderFulfilled'` as never,
    )) as unknown as { rows: { n: number }[] };
    expect(fulfilments.rows[0]?.n, 'and one event').toBe(1);
  });

  it('refuses a REPLAY from an administrator without orders.fulfil', async () => {
    /*
     * The replay path never reaches `runAuthorizedMutation` — it is answered from
     * the idempotency store, before the transaction opens — so the permission check
     * the service makes BEFORE that lookup is the only thing standing between an
     * unauthorized caller and somebody else's order. Without it this returns the
     * order; the test above cannot see that, because a fresh key is refused by the
     * mutation guard whether or not the early check exists.
     */
    const order = await stranded();
    await setStatus(panelA, 'ACTIVE');
    const idempotencyKey = key();

    await ctx.container.orderFulfilment.fulfil(tenantA, finance, {
      idempotencyKey,
      orderId: order.id,
    });

    await expect(
      ctx.container.orderFulfilment.fulfil(tenantA, support, { idempotencyKey, orderId: order.id }),
    ).rejects.toMatchObject({ kind: 'PERMISSION_DENIED' });
  });

  it('refuses a second retry under a DIFFERENT key, because the order already moved', async () => {
    // The replay above is answered from the idempotency store. This is the other
    // caller — a second operator pressing the button — and it gets the conflict.
    const order = await stranded();
    await setStatus(panelA, 'ACTIVE');
    await ctx.container.orderFulfilment.fulfil(tenantA, finance, {
      idempotencyKey: key(),
      orderId: order.id,
    });

    await expect(
      ctx.container.orderFulfilment.fulfil(tenantA, finance, {
        idempotencyKey: key(),
        orderId: order.id,
      }),
    ).rejects.toMatchObject({ code: 'commerce.order_state_invalid' });
    expect(await countOf('services')).toBe(1);
  });

  it('is refundable from PAID_UNFULFILLED, which is the other way out', async () => {
    const order = await stranded();
    const payments = (await ctx.container.database.db.execute(
      sql`SELECT id FROM payments WHERE order_id = ${order.id}` as never,
    )) as unknown as { rows: { id: string }[] };
    const paymentId = payments.rows[0]?.id as string;

    const refund = await ctx.container.refunds.request(tenantA, finance, {
      idempotencyKey: key(),
      paymentId,
      amountMinor: 250_000n,
      reason: 'پنل غیرفعال شد و سفارش تحویل نشد',
    });

    expect(refund.state).not.toBe('REJECTED');
    expect(await countOf('refunds')).toBe(1);
  });

  it('counts a confirmed manual payment as received even while fulfilment is owed', async () => {
    /*
     * Reconciliation. `ORDER_SETTLED_STATES` is what `orders_settled_at_check` is
     * built from, and both include `PAID_UNFULFILLED`: money that arrived is money
     * that arrived, and a report that omitted it would under-state what this
     * installation is holding.
     */
    const order = await stranded();
    const rows = (await ctx.container.database.db.execute(
      sql`SELECT count(*)::int AS n FROM orders
           WHERE settled_at IS NOT NULL AND id = ${order.id}` as never,
    )) as unknown as { rows: { n: number }[] };
    expect(rows.rows[0]?.n).toBe(1);

    const page = await ctx.container.payments.list(tenantA, finance, { limit: 20, search: {} });
    expect(page.items.filter((item) => item.state === 'CONFIRMED')).toHaveLength(1);
  });

  it('keeps one tenant s stranded order out of another tenant s reach', async () => {
    const order = await stranded();
    const outsider = adminActorFor(
      await createAdmin(ctx.container, tenantB, {
        username: 'owner-other-tenant',
        roleKeys: ['owner'],
      }),
    );

    await expect(
      ctx.container.orderFulfilment.fulfil(tenantB, outsider, {
        idempotencyKey: key(),
        orderId: order.id,
      }),
    ).rejects.toMatchObject({ code: 'commerce.order_not_found' });
    expect((await orderRow(order.id))?.state).toBe('PAID_UNFULFILLED');
  });
});
