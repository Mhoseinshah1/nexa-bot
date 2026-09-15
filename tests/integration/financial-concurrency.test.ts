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
import { DrizzleOrderRepository } from '../../apps/api/src/modules/commerce/orders/infrastructure/drizzle-order.repository';
import { DrizzlePaymentRepository } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-payment.repository';
import { DrizzleWalletRepository } from '../../apps/api/src/modules/commerce/wallet/infrastructure/drizzle-wallet.repository';
import type { OrderRecord } from '../../apps/api/src/modules/commerce/orders/application/ports';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  SEED_IDS,
  tenantA,
  type TestContext,
} from './harness';

/**
 * Adversarial interleavings, PRODUCED rather than hoped for.
 *
 * `Promise.allSettled` does not reliably interleave — the Phase 4B branch has a named
 * regression for a concurrency test that could not fail because of it, and
 * `docs/phase4b-falsification.md` records M05 surviving against it. Every case here
 * either drives the mechanism twice itself, or MAKES the interleaving by holding a
 * transaction open while the service blocks on a row lock.
 *
 * What each one defends:
 *
 *   - two debits cannot spend the same money twice;
 *   - an admin debit racing a purchase cannot drive a balance negative;
 *   - two operators approving one transfer produce ONE confirmation and ONE settlement;
 *   - an order that moves between the read and the commit does not settle anyway.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

describe('financial concurrency', () => {
  let ctx: TestContext;
  let products: DrizzleProductRepository;
  let panelA: string;
  let customerA: UserId;
  let owner: ActorContext;
  /** Constructed here rather than exposed on the container: a repository is not a surface. */
  let wallet: DrizzleWalletRepository;

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    products = new DrizzleProductRepository(ctx.container.database.db);
    wallet = new DrizzleWalletRepository(ctx.container.database.db);
    panelA = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelA}, ${tenantA.tenantId}, 'Panel A', 'sanaei', 'https://a.example.test', 'ACTIVE')`);
    const resolved = await ctx.container.customers.resolveFromUpdate(tenantA, systemActor('r'), {
      idempotencyKey: 'resolve-concurrency',
      telegramUserId: '900900',
      from: { id: 900900, first_name: 'زهرا' },
      botInstanceId: BOT_A,
    });
    customerA = resolved.customer.id;
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-conc', roleKeys: ['owner'] }),
    );
  });

  async function awaitingPayment(key: string): Promise<OrderRecord> {
    const created = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن پایه',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: panelA as PanelId,
        specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: 2 },
        price: money(250_000n, 'IRT'),
      },
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, created.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    const order = await ctx.container.orders.createDraft(tenantA, systemActor(key), {
      idempotencyKey: `${key}-draft`,
      customerId: customerA,
      productId: created.id,
    });
    return ctx.container.orders.confirm(tenantA, systemActor(key), {
      idempotencyKey: `${key}-confirm`,
      customerId: customerA,
      orderId: order.id,
    });
  }

  const credit = (amountMinor: bigint, key: string) =>
    ctx.container.wallet.adjust(tenantA, owner, customerA, {
      idempotencyKey: key,
      direction: 'CREDIT',
      amountMinor,
      currency: 'IRT',
      note: 'fixture',
    });

  const debit = (amountMinor: bigint, key: string) =>
    ctx.container.wallet.adjust(tenantA, owner, customerA, {
      idempotencyKey: key,
      direction: 'DEBIT',
      amountMinor,
      currency: 'IRT',
      note: 'withdrawal',
    });

  const balance = () => ctx.container.wallet.balance(tenantA, owner, customerA);

  const countOf = async (table: 'payments' | 'wallet_entries'): Promise<number> => {
    const rows = (await ctx.container.database.db.execute(
      (table === 'payments'
        ? sql`SELECT count(*)::int AS n FROM payments`
        : sql`SELECT count(*)::int AS n FROM wallet_entries`) as never,
    )) as unknown as { rows: { n: number }[] };
    return rows.rows[0]?.n ?? 0;
  };

  // -------------------------------------------------------------------------
  // The wallet
  // -------------------------------------------------------------------------

  /*
   * Two debits of the same money, each of which the balance could cover ALONE.
   *
   * Not `Promise.allSettled`: that is not guaranteed to interleave, and a sequential
   * run would pass on an implementation with no check at all. The race is PRODUCED —
   * a transaction is held open having already debited, the second debit is called and
   * blocks on the row the first wrote, and the holder then commits.
   *
   * `balanceOf` inside the second transaction must then see the first debit. If it
   * read a snapshot from before it, both would commit and the balance would go
   * negative — the defect `WALLET_ALLOWS_NEGATIVE_BALANCE` exists to make impossible.
   */
  it('will not let two debits spend the same money', async () => {
    await credit(100_000n, 'race-credit-0001');

    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    /*
     * The holder ANNOUNCES that its write has landed, and the racer waits for it.
     *
     * Starting the racer straight after creating the holder's promise is a hope, not a
     * fact: `uow.run` is not awaited, so at that moment the holder may not have opened
     * its transaction, let alone taken the row lock. Under load — the full suite, a busy
     * CI runner — the racer can win that start, acquire the lock first, and complete
     * before the holder has written anything, which turns a case about contention into a
     * case about nothing and fails on the wrong assertion.
     *
     * It is the lesson `docs/phase4d-falsification.md` records as F4D-05 in another
     * module: the interleaving is MADE, not hoped for. The sleep below keeps its
     * separate job — giving the racer time to reach the lock and BLOCK on it — which is
     * a wait for a state nothing in-process can observe.
     */
    let holding: () => void = () => undefined;
    const locked = new Promise<void>((resolve) => {
      holding = resolve;
    });
    let first: 'ok' | 'failed' = 'failed';
    const holder = ctx.container.uow.run(tenantA, async (tx) => {
      await wallet.append(
        tenantA,
        {
          id: ctx.container.ids.uuid(),
          customerId: customerA,
          direction: 'DEBIT',
          reason: 'ADMIN_DEBIT',
          amount: money(80_000n, 'IRT'),
          reference: 'held-debit',
          note: 'held open',
          now: ctx.container.clock.now(),
        },
        tx,
      );
      first = 'ok';
      holding();
      await held;
    });

    // Started only once the holder's write has landed, so its transaction is provably
    // open and holding the row. Its own balance read happens inside its own
    // transaction, which begins before the holder commits.
    await locked;
    const racing = debit(80_000n, 'race-debit-0002').then(
      () => 'settled' as const,
      (error: unknown) => error,
    );

    await new Promise((resolve) => setTimeout(resolve, 250));
    release();
    await holder;
    const outcome = await racing;

    expect(first).toBe('ok');
    // The second debit is REFUSED. Both are legal alone and only one can happen.
    expect(outcome, 'the second debit spent money the first had already taken').toMatchObject({
      code: 'commerce.wallet_insufficient_funds',
    });
    const after = await balance();
    // The invariant, stated on its own so a future change that allows an overdraft
    // fails here even if the refusal above is relaxed.
    expect(after.amountMinor, 'the balance went negative').toBeGreaterThanOrEqual(0n);
    expect(after.amountMinor).toBe(20_000n);
    expect(await countOf('wallet_entries')).toBe(2);
  }, 30_000);

  it('applies two DIFFERENT legitimate adjustments, and one repeated one once', async () => {
    await credit(100_000n, 'both-credit-0001');
    await credit(50_000n, 'both-credit-0002');
    // The SAME key and payload: a retry, not a second command.
    await credit(50_000n, 'both-credit-0002');

    const after = await balance();
    expect(after.amountMinor).toBe(150_000n);
    expect(after.entryCount).toBe(2);
  });

  // -------------------------------------------------------------------------
  // The wallet settlement
  // -------------------------------------------------------------------------

  /*
   * An admin debit racing a customer's purchase.
   *
   * The wallet holds exactly the order total. Both movements are legal on their own and
   * only one can happen — and the one that loses must be REFUSED rather than allowed to
   * drive the balance below zero.
   */
  it('will not let an admin debit and a purchase both take the last of the money', async () => {
    const order = await awaitingPayment('race-settle');
    await credit(250_000n, 'race-settle-credit');

    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    /*
     * The holder ANNOUNCES that its write has landed, and the racer waits for it.
     *
     * Starting the racer straight after creating the holder's promise is a hope, not a
     * fact: `uow.run` is not awaited, so at that moment the holder may not have opened
     * its transaction, let alone taken the row lock. Under load — the full suite, a busy
     * CI runner — the racer can win that start, acquire the lock first, and complete
     * before the holder has written anything, which turns a case about contention into a
     * case about nothing and fails on the wrong assertion.
     *
     * It is the lesson `docs/phase4d-falsification.md` records as F4D-05 in another
     * module: the interleaving is MADE, not hoped for. The sleep below keeps its
     * separate job — giving the racer time to reach the lock and BLOCK on it — which is
     * a wait for a state nothing in-process can observe.
     */
    let holding: () => void = () => undefined;
    const locked = new Promise<void>((resolve) => {
      holding = resolve;
    });
    const holder = ctx.container.uow.run(tenantA, async (tx) => {
      await wallet.append(
        tenantA,
        {
          id: ctx.container.ids.uuid(),
          customerId: customerA,
          direction: 'DEBIT',
          reason: 'ADMIN_DEBIT',
          amount: money(250_000n, 'IRT'),
          reference: 'held-admin-debit',
          note: 'held open',
          now: ctx.container.clock.now(),
        },
        tx,
      );
      holding();
      await held;
    });

    await locked;
    const racing = ctx.container.payments
      .settleFromWallet(tenantA, systemActor('race-pay'), customerA, {
        idempotencyKey: 'race-settle-0001',
        orderId: order.id,
      })
      .then(
        () => 'settled' as const,
        (error: unknown) => error,
      );

    await new Promise((resolve) => setTimeout(resolve, 250));
    release();
    await holder;
    const outcome = await racing;

    const after = await balance();
    expect(after.amountMinor, 'the balance went negative').toBeGreaterThanOrEqual(0n);
    expect(outcome, 'the purchase spent money the admin debit had already taken').toMatchObject({
      code: 'commerce.wallet_insufficient_funds',
    });
    // And nothing half-happened: no payment, and the order is untouched.
    expect(await countOf('payments')).toBe(0);
    const rows = (await ctx.container.database.db.execute(
      sql`SELECT state FROM orders WHERE id = ${order.id}` as never,
    )) as unknown as { rows: { state: string }[] };
    expect(rows.rows[0]?.state).toBe('AWAITING_PAYMENT');
  }, 30_000);

  // -------------------------------------------------------------------------
  // The manual confirmation
  // -------------------------------------------------------------------------

  /*
   * Two operators pressing approve on the same transfer.
   *
   * Driven through the REPOSITORY twice rather than through two service calls, because
   * the service returns early on an already-CONFIRMED payment and would never reach the
   * statement that makes this safe. The conditional UPDATE is the mechanism; this is
   * the case that exercises it.
   */
  it('converges two confirmations of one transfer on ONE confirmation', async () => {
    const order = await awaitingPayment('race-manual');
    const pending = await ctx.container.payments.requestManualTransfer(
      tenantA,
      systemActor('race-manual'),
      customerA,
      { idempotencyKey: 'race-manual-0001', orderId: order.id },
    );
    const repository = new DrizzlePaymentRepository(ctx.container.database.db);
    const confirmation = {
      evidenceKind: 'OPERATOR_REVIEW' as const,
      evidenceNote: 'first operator',
      confirmedByAdminId: null,
      confirmedAt: ctx.container.clock.now(),
    };

    const results = await Promise.all([
      repository.confirm(tenantA, pending.id, confirmation, ctx.container.clock.now()),
      repository.confirm(
        tenantA,
        pending.id,
        { ...confirmation, evidenceNote: 'second operator' },
        ctx.container.clock.now(),
      ),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);

    /*
     * The WINNER's note, identified by which call returned true — not 'first operator'.
     *
     * Nothing orders two statements handed to `Promise.all`, so asserting a fixed note
     * made this fail on a scheduling accident rather than on a production change. What
     * IS a rule: the note stored is the one belonging to the call that won, because the
     * conditional UPDATE writes every column of the winner and none of the loser's.
     */
    const winner = results[0] === true ? 'first operator' : 'second operator';
    const after = await repository.findById(tenantA, pending.id);
    expect(after?.evidenceNote).toBe(winner);
  });

  /*
   * The order moves between the payment's read and the settlement's UPDATE.
   *
   * PRODUCED, not hoped for: a transaction is held open having already settled the
   * order, the confirmation reads `AWAITING_PAYMENT`, confirms the payment and blocks
   * at its own conditional UPDATE. The holder commits; the UPDATE matches nothing.
   *
   * The whole transaction must roll back — INCLUDING the confirmation. A confirmed
   * payment against an order it did not settle is money recorded as having bought
   * something it did not buy.
   */
  /*
   * TWO wallet settlements of ONE order, interleaved on purpose.
   *
   * `telegram-payment-flow.test.ts` claimed this case with `Promise.allSettled`, whose
   * assertions all held under plain serialisation — the second tap is refused by the
   * order state and writes nothing either way. So the shape it was written to catch was
   * invisible to it, and the shape was real.
   *
   * Produced here: a holder transaction does what a COMPLETED settlement does — it
   * takes the customer row and moves the order to PAID — and the racer calls the real
   * service while that is open. The racer blocks on `lockCustomer`, and what it reads
   * AFTER the lock decides the outcome.
   *
   * The order used to be read BEFORE the lock. The racer therefore held an
   * `AWAITING_PAYMENT` snapshot taken before the holder committed, passed `canCover`,
   * appended a second debit and only failed at `payments_order_confirmed_key` — a raw
   * 23505 nothing maps, which the webhook swallows into a failed turn, so the customer
   * who double-tapped got no reply at all.
   */
  it('refuses the loser of two interleaved settlements instead of violating an index', async () => {
    const order = await awaitingPayment('race-double-settle');
    await credit(1_000_000n, 'race-double-credit-0001');
    const orders = new DrizzleOrderRepository(ctx.container.database.db);

    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    /*
     * The holder ANNOUNCES that its write has landed, and the racer waits for it.
     *
     * Starting the racer straight after creating the holder's promise is a hope, not a
     * fact: `uow.run` is not awaited, so at that moment the holder may not have opened
     * its transaction, let alone taken the row lock. Under load — the full suite, a busy
     * CI runner — the racer can win that start, acquire the lock first, and complete
     * before the holder has written anything, which turns a case about contention into a
     * case about nothing and fails on the wrong assertion.
     *
     * It is the lesson `docs/phase4d-falsification.md` records as F4D-05 in another
     * module: the interleaving is MADE, not hoped for. The sleep below keeps its
     * separate job — giving the racer time to reach the lock and BLOCK on it — which is
     * a wait for a state nothing in-process can observe.
     */
    let holding: () => void = () => undefined;
    const locked = new Promise<void>((resolve) => {
      holding = resolve;
    });
    const holder = ctx.container.uow.run(tenantA, async (tx) => {
      // The customer row, so the racer blocks exactly where a real settlement would.
      expect(await wallet.lockCustomer(tenantA, customerA, tx)).toBe(true);
      // And the order settled, which is what the racer must see once it gets the lock.
      const moved = await orders.transition(
        tenantA,
        order.id,
        'AWAITING_PAYMENT',
        'PAID',
        { settledAt: ctx.container.clock.now() },
        ctx.container.clock.now(),
        tx,
      );
      expect(moved).toBe(true);
      holding();
      await held;
    });

    await locked;
    const racing = ctx.container.payments
      .settleFromWallet(tenantA, systemActor('race-double'), customerA, {
        idempotencyKey: 'race-double-settle-0001',
        orderId: order.id,
      })
      .then(
        () => 'settled' as const,
        (error: unknown) => error,
      );

    await new Promise((resolve) => setTimeout(resolve, 250));
    release();
    await holder;

    /*
     * The ORDINARY refusal, by code. Asserting the code rather than merely that it
     * threw is the point: a raw `duplicate key value violates unique constraint` also
     * throws, and that is the defect this test exists to catch.
     */
    expect(await racing).toMatchObject({ code: 'commerce.order_state_invalid' });

    // Nothing of the loser survives: no debit, no payment row.
    expect(await countOf('wallet_entries')).toBe(1);
    expect(await countOf('payments')).toBe(0);
    const after = await balance();
    expect(after.amountMinor).toBe(1_000_000n);
  }, 30_000);

  it('rolls a confirmation back when the order settles underneath it', async () => {
    const order = await awaitingPayment('race-stale');
    const pending = await ctx.container.payments.requestManualTransfer(
      tenantA,
      systemActor('race-stale'),
      customerA,
      { idempotencyKey: 'race-stale-0001', orderId: order.id },
    );
    const reviewer = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'finance-race',
        roleKeys: ['finance'],
      }),
    );
    const orders = new DrizzleOrderRepository(ctx.container.database.db);

    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    /*
     * The holder ANNOUNCES that its write has landed, and the racer waits for it.
     *
     * Starting the racer straight after creating the holder's promise is a hope, not a
     * fact: `uow.run` is not awaited, so at that moment the holder may not have opened
     * its transaction, let alone taken the row lock. Under load — the full suite, a busy
     * CI runner — the racer can win that start, acquire the lock first, and complete
     * before the holder has written anything, which turns a case about contention into a
     * case about nothing and fails on the wrong assertion.
     *
     * It is the lesson `docs/phase4d-falsification.md` records as F4D-05 in another
     * module: the interleaving is MADE, not hoped for. The sleep below keeps its
     * separate job — giving the racer time to reach the lock and BLOCK on it — which is
     * a wait for a state nothing in-process can observe.
     */
    let holding: () => void = () => undefined;
    const locked = new Promise<void>((resolve) => {
      holding = resolve;
    });
    const holder = ctx.container.uow.run(tenantA, async (tx) => {
      const moved = await orders.transition(
        tenantA,
        order.id,
        'AWAITING_PAYMENT',
        'PAID',
        { settledAt: ctx.container.clock.now() },
        ctx.container.clock.now(),
        tx,
      );
      expect(moved).toBe(true);
      holding();
      await held;
    });

    await locked;
    const racing = ctx.container.payments
      .confirmManualTransfer(tenantA, reviewer, pending.id, {
        idempotencyKey: 'race-stale-confirm-0001',
        note: 'arrived',
      })
      .then(
        () => 'confirmed' as const,
        (error: unknown) => error,
      );

    await new Promise((resolve) => setTimeout(resolve, 250));
    release();
    await holder;

    expect(await racing).toMatchObject({
      code: 'commerce.settlement_not_funded',
      details: { reason: 'ORDER_NOT_AWAITING_PAYMENT' },
    });

    // The confirmation rolled back with it.
    const after = await ctx.container.payments.get(tenantA, owner, pending.id);
    expect(after.state).toBe('PENDING');
    expect(after.confirmedAt).toBeNull();
    expect(after.evidenceKind).toBeNull();
    // And no wallet movement was ever involved in a manual transfer.
    expect(await countOf('wallet_entries')).toBe(0);
  }, 30_000);
});
