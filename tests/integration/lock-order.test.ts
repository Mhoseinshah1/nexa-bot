import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  money,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type PanelId,
  type ProductId,
  type UserId,
} from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import type { OrderRecord } from '../../apps/api/src/modules/commerce/orders/application/ports';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  makePanelSellable,
  SEED_IDS,
  tenantA,
  type TestContext,
} from './harness';

/**
 * The order in which one order's three rows are locked, and why it has to be one order.
 *
 * Codex M3 on PR #50. Four transactions touch the same three rows — the ORDER, its
 * PANEL and its capacity RESERVATION — and before this file they did not agree on the
 * sequence:
 *
 * | path                        | locks, in order                        |
 * | --------------------------- | -------------------------------------- |
 * | `OrderService.confirm`      | panel (`acquire`) → reservation → order |
 * | wallet / manual settlement  | payment → panel (`consume`) → reservation → order |
 * | `OrderService.cancelByCustomer` | payment → order → reservation      |
 * | `PaymentExpiryService.sweep`| order (`expireDue`) → reservation       |
 *
 * The last two take the ORDER before the RESERVATION and the first two take them the
 * other way round, which is a cycle: settlement holding the reservation and waiting
 * for the order, cancellation holding the order and waiting for the reservation.
 * PostgreSQL resolves that by aborting one of them with `40P01`, so a customer's
 * purchase — or their cancellation — fails with a serialization error instead of the
 * answer the product has for that race, which is that one of the two wins cleanly.
 *
 * The canonical order this file pins is **order → panel → reservation**. It was chosen
 * over the reverse because the two release paths already obey it and cannot easily do
 * otherwise: the expiry sweep is a BATCH whose `expireDue` discovers and transitions
 * due orders in one statement, so it cannot know which reservations to release before
 * it has taken the order locks.
 *
 * ## How the interleaving is produced
 *
 * Not with a sleep. A transaction opened by the test takes the order's row lock — the
 * first thing both release paths do — and the racing request is then started and
 * WAITED FOR, by polling `pg_stat_activity` until a backend of this database is
 * actually blocked on a lock. That is the state `financial-concurrency.test.ts` says
 * "nothing in-process can observe": nothing in-process, but PostgreSQL will say so.
 * Only then does the holder take the second lock, which is the step that closes the
 * cycle if one exists.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'lock-order:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

/** PostgreSQL's deadlock: `deadlock_detected`. */
const DEADLOCK = '40P01';

const codeOf = (thrown: unknown): string | null => {
  const seen = new Set<unknown>();
  let cursor: unknown = thrown;
  while (cursor !== null && typeof cursor === 'object' && !seen.has(cursor)) {
    seen.add(cursor);
    const code = (cursor as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return null;
};

describe('the order in which an order, its panel and its reservation are locked', () => {
  let ctx: TestContext;
  let products: DrizzleProductRepository;
  let panelA: string;
  let customerA: UserId;
  let owner: ActorContext;
  let n = 0;
  const key = (): string => `lock-order-key-${(n += 1)}`;

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
    /*
     * Made GENUINELY sellable, not left as a bare row.
     *
     * A panel with no credentials, no activation and no probe cannot create an
     * account, and since this hotfix `decideEligibility` refuses to take money
     * for one. A fixture that expects a sale therefore has to describe a panel
     * that could deliver it; `makePanelSellable` writes the three things a sale
     * now requires, using the production identity function so it cannot drift.
     */
    await makePanelSellable(ctx.container, tenantA, panelA);
    const resolved = await ctx.container.customers.resolveFromUpdate(tenantA, systemActor('r'), {
      idempotencyKey: 'resolve-lock-order',
      telegramUserId: '900700',
      from: { id: 900700, first_name: 'سارا' },
      botInstanceId: BOT_A,
    });
    customerA = resolved.customer.id;
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-locks', roleKeys: ['owner'] }),
    );
  });

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  async function awaitingPayment(): Promise<OrderRecord> {
    const k = key();
    const created = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن قفل',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: panelA as PanelId,
        specification: { durationDays: 30, trafficBytes: 0n, deviceLimit: 1 },
        price: money(250_000n, 'IRT'),
      },
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, created.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    const draft = await ctx.container.orders.createDraft(tenantA, systemActor(k), {
      idempotencyKey: `${k}-draft`,
      customerId: customerA,
      productId: created.id,
    });
    return ctx.container.orders.confirm(tenantA, systemActor(k), {
      idempotencyKey: `${k}-confirm`,
      customerId: customerA,
      orderId: draft.id,
    });
  }

  const fund = (amountMinor: bigint) =>
    ctx.container.wallet.adjust(tenantA, owner, customerA, {
      idempotencyKey: key(),
      direction: 'CREDIT',
      amountMinor,
      currency: 'IRT',
      note: 'fixture',
    });

  /** A manual transfer awaiting review — the money is in the bank by now. */
  const pendingTransfer = async (order: OrderRecord): Promise<string> => {
    const k = key();
    const { payment } = await ctx.container.payments.requestManualTransfer(
      tenantA,
      systemActor(k),
      customerA,
      { idempotencyKey: `${k}-manual`, orderId: order.id },
    );
    return payment.id;
  };

  const confirmTransfer = (paymentId: string) =>
    ctx.container.payments
      .confirmManualTransfer(tenantA, owner, paymentId, {
        idempotencyKey: key(),
        note: 'کارت به کارت',
      })
      .then(
        () => null,
        (error: unknown) => error,
      );

  /**
   * Waits until PostgreSQL reports `count` backends of this database blocked on a lock.
   *
   * The barrier, and the reason nothing here sleeps for a fixed time: a fixed wait is
   * either too short on a loaded runner — in which case the case tests nothing and
   * fails on the wrong assertion — or too long on every green run. This waits for the
   * exact condition the next step depends on, and gives up loudly rather than
   * proceeding to an assertion whose premise never held.
   */
  const awaitBlocked = async (): Promise<void> => {
    for (let attempt = 0; attempt < 2_500; attempt += 1) {
      const rows = (await ctx.container.database.db.execute(
        sql`SELECT count(*)::int AS n
              FROM pg_stat_activity
             WHERE datname = current_database()
               AND wait_event_type = 'Lock'
               AND query NOT ILIKE '%pg_stat_activity%'` as never,
      )) as unknown as { rows: { n: number }[] };
      if ((rows.rows[0]?.n ?? 0) >= 1) return;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    throw new Error('nothing ever blocked on a lock; the interleaving never happened');
  };

  /**
   * Holds the ORDER's row lock — the first lock both release paths take — and
   * releases it only when the caller says so, or when the caller throws.
   *
   * The `finally` is not tidiness. A holder left open by a failing assertion keeps a
   * row lock for the rest of the FILE, and the next case's `ctx.reset()` blocks on
   * its own TRUNCATE: one real failure then reports as four, and the fourth is a
   * hook timeout that names nothing. That happened while writing this file.
   */
  const holdingTheOrder = async (
    orderId: string,
    within: (releaseLock: () => void) => Promise<void>,
  ): Promise<void> => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holding: () => void = () => undefined;
    const locked = new Promise<void>((resolve) => {
      holding = resolve;
    });
    const holder = ctx.container.uow.run(tenantA, async (tx) => {
      await tx.tx.execute(sql`SELECT id FROM orders WHERE id = ${orderId} FOR UPDATE`);
      holding();
      await held;
    });
    try {
      await locked;
      await within(release);
    } finally {
      release();
      await holder;
    }
  };

  const stateOf = async (orderId: string): Promise<string> => {
    const rows = (await ctx.container.database.db.execute(
      sql`SELECT state FROM orders WHERE id = ${orderId}` as never,
    )) as unknown as { rows: { state: string }[] };
    return rows.rows[0]?.state as string;
  };

  const reservations = async (orderId: string): Promise<number> => {
    const rows = (await ctx.container.database.db.execute(
      sql`SELECT count(*)::int AS n FROM panel_capacity_reservations
           WHERE order_id = ${orderId}` as never,
    )) as unknown as { rows: { n: number }[] };
    return rows.rows[0]?.n ?? 0;
  };

  const settle = (order: OrderRecord) =>
    ctx.container.payments
      .settleFromWallet(tenantA, systemActor(key()), customerA, {
        idempotencyKey: key(),
        orderId: order.id,
      })
      .then(
        () => null,
        (error: unknown) => error,
      );

  const cancel = (order: OrderRecord) =>
    ctx.container.orders
      .cancelByCustomer(tenantA, systemActor(key()), {
        idempotencyKey: key(),
        customerId: customerA,
        orderId: order.id,
      })
      .then(
        () => null,
        (error: unknown) => error,
      );

  // -------------------------------------------------------------------------
  // The reproduction
  // -------------------------------------------------------------------------

  /*
   * The cycle itself, scripted on one side so that it is certain rather than likely.
   *
   * The holder does exactly what `cancelByCustomer` and the expiry sweep do, in their
   * order: take the ORDER's row lock, then delete the RESERVATION. The other side is
   * the real settlement. Against a settlement that takes the panel and the reservation
   * BEFORE the order, this is a guaranteed deadlock — the holder waits for a
   * reservation the settlement holds, the settlement waits for an order the holder
   * holds — and PostgreSQL aborts one of them with `40P01`.
   *
   * Against the canonical order it is not a race at all: the settlement blocks on the
   * order lock before it has taken anything, the holder's delete finds nothing in its
   * way, and whichever commits first the other sees a consistent order.
   */
  it('does not deadlock when a release path holds the order and wants the reservation', async () => {
    for (let round = 0; round < 3; round += 1) {
      const order = await awaitingPayment();
      await fund(500_000n);

      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let holding: () => void = () => undefined;
      const locked = new Promise<void>((resolve) => {
        holding = resolve;
      });

      const holder = ctx.container.uow
        .run(tenantA, async (tx) => {
          // 1. The order, exactly as `transition` and `expireDue` take it.
          await tx.tx.execute(sql`SELECT id FROM orders WHERE id = ${order.id} FOR UPDATE`);
          holding();
          await held;
          // 2. The reservation, exactly as `panelSales.release` takes it.
          await tx.tx.execute(
            sql`DELETE FROM panel_capacity_reservations WHERE order_id = ${order.id}`,
          );
        })
        .then(
          () => null,
          (error: unknown) => error,
        );

      await locked;
      const racing = settle(order);
      /*
       * The settlement is now genuinely blocked on a row lock, not merely started.
       *
       * The statement it blocks on is worth naming, because it is not the one you
       * would predict: `INSERT INTO payments`. `payments.order_id` references the
       * order, so the insert takes `FOR KEY SHARE` on that row, and the holder's
       * `FOR UPDATE` conflicts with it. So a settlement reaches for the order EVEN
       * EARLIER than the explicit lock this fix added — through a foreign key — and
       * the canonical order is what the whole transaction obeys rather than a rule
       * about one statement.
       */
      await awaitBlocked();
      release();

      const [holderOutcome, settleOutcome] = await Promise.all([holder, racing]);
      expect(codeOf(holderOutcome), `round ${String(round)}: the release path deadlocked`).not.toBe(
        DEADLOCK,
      );
      expect(codeOf(settleOutcome), `round ${String(round)}: the settlement deadlocked`).not.toBe(
        DEADLOCK,
      );
    }
  }, 60_000);

  /*
   * The same graph with the real cancellation on the other side, three times.
   *
   * Both requests are started while the test holds the order's lock, so both are
   * waiting on the same row before either can proceed — which is the interleaving the
   * production paths would have to survive. Exactly one of the two may win, and the
   * order must end in the state the winner wrote with no reservation left behind
   * either way.
   */
  it('lets exactly one of a settlement and a cancellation win, three times over', async () => {
    for (let round = 0; round < 3; round += 1) {
      const order = await awaitingPayment();
      await fund(500_000n);

      let both: Promise<[unknown, unknown]> = Promise.resolve([null, null]);
      await holdingTheOrder(order.id, async (releaseLock) => {
        both = Promise.all([settle(order), cancel(order)]);
        await awaitBlocked();
        releaseLock();
      });
      const [settleOutcome, cancelOutcome] = await both;

      for (const outcome of [settleOutcome, cancelOutcome]) {
        expect(codeOf(outcome), `round ${String(round)}: deadlock`).not.toBe(DEADLOCK);
      }
      // One winner, never two and never none.
      expect(
        [settleOutcome, cancelOutcome].filter((outcome) => outcome === null),
        `round ${String(round)}`,
      ).toHaveLength(1);
      expect(await stateOf(order.id)).toBe(settleOutcome === null ? 'PAID' : 'CANCELLED');
      expect(await reservations(order.id), 'the slot went back either way').toBe(0);
    }
  }, 60_000);

  /*
   * The expiry sweep against an order somebody else is holding.
   *
   * The sweep is the one release path that CANNOT be made to wait for an order:
   * `expireDue` finds its candidates with `FOR UPDATE SKIP LOCKED`, so an order
   * another transaction has locked is passed over rather than queued behind. That is
   * what keeps a BATCH out of the cycle entirely — a sweep that waited would hold the
   * order locks of every row it had already claimed while doing so.
   *
   * It is also why the canonical order is order-first rather than reservation-first:
   * `expireDue` discovers and transitions in one statement, so it cannot know which
   * reservations to release until it holds the order locks. The two acquisition paths
   * are the ones that had to move.
   */
  it('passes over an order another transaction holds rather than queueing behind it', async () => {
    const order = await awaitingPayment();
    await ctx.container.database.db.execute(
      sql`UPDATE orders SET expires_at = now() - interval '1 hour' WHERE id = ${order.id}`,
    );

    let report: { readonly orders: number } = { orders: -1 };
    await holdingTheOrder(order.id, async (releaseLock) => {
      // No barrier and no race: the sweep must RETURN rather than block, so simply
      // awaiting it inside the hold is the assertion. If it queued, this would hang.
      report = await ctx.container.paymentExpirySweep.runOnce(tenantA);
      releaseLock();
    });

    expect(report.orders, 'the locked order was skipped, not waited for').toBe(0);
    expect(await stateOf(order.id)).toBe('AWAITING_PAYMENT');
    expect(await reservations(order.id), 'and its slot was not released either').toBe(1);

    // And the next tick, with nobody holding it, does the work.
    const second = await ctx.container.paymentExpirySweep.runOnce(tenantA);
    expect(second.orders).toBe(1);
    expect(await stateOf(order.id)).toBe('EXPIRED');
    expect(await reservations(order.id)).toBe(0);
  }, 60_000);

  /*
   * The duplicate: the same order settled twice at once, under different keys so the
   * idempotency store cannot answer either of them.
   *
   * Nothing about this is new behaviour — `financial-concurrency.test.ts` owns the
   * money half — but the lock order is what decides whether the loser is REFUSED or
   * killed by the server, and only the first of those is an answer.
   */
  it('refuses the loser of a duplicate settlement rather than deadlocking', async () => {
    const order = await awaitingPayment();
    await fund(1_000_000n);

    const [first, second] = await Promise.all([settle(order), settle(order)]);

    for (const outcome of [first, second]) expect(codeOf(outcome)).not.toBe(DEADLOCK);
    expect([first, second].filter((outcome) => outcome === null)).toHaveLength(1);
    expect(await stateOf(order.id)).toBe('PAID');
  }, 60_000);

  /*
   * The SECOND cycle on the same three-transaction graph, and a different pair of rows:
   * the CUSTOMER and the PANEL.
   *
   * `settleFromWallet` locks the customer before it goes anywhere near a panel, because
   * it is about to debit that wallet. The manual-transfer settlement reached the same
   * customer row only through `RefundService.creditWallet` on its refunding branch —
   * which runs AFTER `prepareFulfilment` has taken the panel's row. So the two
   * settlement paths took `customer -> panel` and `panel -> customer`, and a wallet
   * purchase racing an operator's review of a transfer for the same customer on the
   * same panel closed the cycle. `DrizzleUnitOfWork` has no retry, so one of the two
   * failed outright with `40P01`: a customer's payment request answered with a
   * serialization error, or an arrived transfer left neither confirmed nor refunded.
   * Found by Codex.
   *
   * The holder scripts the wallet side exactly — customer first, panel second — and the
   * other side is the real `confirmManualTransfer`, on a panel that has been DISABLED
   * so it takes the refunding branch, which is the branch that reaches the customer at
   * all. It passes only because `confirmAndSettle` now takes the customer lock
   * unconditionally, before `prepareFulfilment`.
   */
  it('does not deadlock when a wallet settlement holds the customer and wants the panel', async () => {
    for (let round = 0; round < 3; round += 1) {
      // The previous round left it DISABLED, and a disabled panel refuses the
      // confirmation that starts this one.
      await ctx.container.database.db.execute(
        sql`UPDATE panels SET status = 'ACTIVE' WHERE id = ${panelA}`,
      );
      const order = await awaitingPayment();
      const paymentId = await pendingTransfer(order);
      // DISABLED, so the settlement cannot deliver and must refund — the only branch
      // of this path that credits the wallet, and so the only one that used to reach
      // the customer's row after the panel's.
      await ctx.container.database.db.execute(
        sql`UPDATE panels SET status = 'DISABLED' WHERE id = ${panelA}`,
      );

      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let holding: () => void = () => undefined;
      const locked = new Promise<void>((resolve) => {
        holding = resolve;
      });

      const holder = ctx.container.uow
        .run(tenantA, async (tx) => {
          // 1. The customer, exactly as `WalletRepository.lockCustomer` takes it.
          await tx.tx.execute(sql`SELECT id FROM customers WHERE id = ${customerA} FOR UPDATE`);
          holding();
          await held;
          // 2. The panel, exactly as `PanelSalesGate.consume` takes it.
          await tx.tx.execute(sql`SELECT id FROM panels WHERE id = ${panelA} FOR UPDATE`);
        })
        .then(
          () => null,
          (error: unknown) => error,
        );

      await locked;
      const racing = confirmTransfer(paymentId);
      /*
       * Which row the confirmation blocks on is the whole finding.
       *
       * With the fix it blocks on the CUSTOMER, holding no panel — so step 2 above
       * walks straight through. Without it, it blocks on the customer while ALREADY
       * HOLDING the panel, and step 2 completes the cycle. The barrier is satisfied
       * either way, which is what makes this a reproduction rather than a
       * coincidence: the two worlds differ only in the outcome asserted below.
       */
      await awaitBlocked();
      release();

      const [holderOutcome, confirmOutcome] = await Promise.all([holder, racing]);
      expect(codeOf(holderOutcome), `round ${String(round)}: the wallet side deadlocked`).not.toBe(
        DEADLOCK,
      );
      expect(
        codeOf(confirmOutcome),
        `round ${String(round)}: the transfer confirmation deadlocked`,
      ).not.toBe(DEADLOCK);
      expect(confirmOutcome, `round ${String(round)}: and it really did settle`).toBeNull();
      expect(await stateOf(order.id), 'the money arrived and went straight back').toBe('REFUNDED');
    }
  }, 60_000);

  /*
   * Release against consume, with no scripted holder at all: a cancellation and a
   * settlement started together, repeatedly. This is the shape a real customer
   * produces by double-tapping two buttons, and it is the one that would show an
   * intermittent `40P01` in production rather than in a test.
   */
  it('survives a cancellation and a settlement started together, five times', async () => {
    for (let round = 0; round < 5; round += 1) {
      const order = await awaitingPayment();
      await fund(500_000n);

      const [settleOutcome, cancelOutcome] = await Promise.all([settle(order), cancel(order)]);

      for (const outcome of [settleOutcome, cancelOutcome]) {
        expect(codeOf(outcome), `round ${String(round)}`).not.toBe(DEADLOCK);
      }
      expect(await reservations(order.id), `round ${String(round)}`).toBe(0);
    }
  }, 60_000);
});
