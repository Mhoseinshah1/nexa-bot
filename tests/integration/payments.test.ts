import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  money,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type PanelId,
  type PaymentId,
  type ProductId,
  type UserId,
} from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import type { ProductDraft } from '../../apps/api/src/modules/commerce/catalog/application/ports';
import type { OrderRecord } from '../../apps/api/src/modules/commerce/orders/application/ports';
import { DrizzleOrderRepository } from '../../apps/api/src/modules/commerce/orders/infrastructure/drizzle-order.repository';
import { DrizzlePaymentRepository } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-payment.repository';
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
 * Payments, and the settlement they fund.
 *
 * Every case here is one of the ways money and an order could come to disagree:
 *
 *   - the AMOUNT comes from the order's frozen snapshot, never from the caller. A
 *     callback is an intent and an identifier; a figure inside it is ignored.
 *   - the DEBIT equals the total EXACTLY. `LGR-BR-002` measures that rule in the legacy
 *     data (993,000 − 888,000 = 105,000) and `settlementIsFunded` is what enforces it.
 *   - the whole movement is ONE transaction. There is no failure that leaves money moved
 *     and an order unpaid, because there is no second commit to fail.
 *   - the TRANSITION is conditional. A double tap, a redelivered callback and two
 *     replicas produce one settlement and one `OrderSettled`.
 *   - an order reaches PAID and STOPS. Nothing here provisions anything.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const BOT_B = SEED_IDS.botB1 as BotInstanceId;

/** The actor a customer-initiated payment command runs as. Holds `maintenance.run` only. */
const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

describe('payments and settlement', () => {
  let ctx: TestContext;
  let products: DrizzleProductRepository;
  let panelA: string;
  let panelB: string;
  let customerA: UserId;
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
    customerA = await customer(tenantA, BOT_A, '900700');
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'owner-payments',
        roleKeys: ['owner'],
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

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

  /** An order in `AWAITING_PAYMENT`, made the way a customer makes one. */
  async function awaitingPayment(
    scope: typeof tenantA,
    customerId: UserId,
    panelId: string,
    key: string,
    overrides: Partial<ProductDraft> = {},
  ): Promise<OrderRecord> {
    const created = await products.create(scope, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: draft(panelId, overrides),
      now: ctx.container.clock.now(),
    });
    await products.setStatus(scope, created.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());

    const order = await ctx.container.orders.createDraft(scope, systemActor(`${key}-d`), {
      idempotencyKey: `${key}-draft`,
      customerId,
      productId: created.id,
    });
    return ctx.container.orders.confirm(scope, systemActor(`${key}-c`), {
      idempotencyKey: `${key}-confirm`,
      customerId,
      orderId: order.id,
    });
  }

  const credit = (scope: typeof tenantA, customerId: UserId, amountMinor: bigint, key: string) =>
    ctx.container.wallet.adjust(scope, owner, customerId, {
      idempotencyKey: key,
      direction: 'CREDIT',
      amountMinor,
      currency: 'IRT',
      note: 'fixture',
    });

  const settleFromWallet = (
    scope: typeof tenantA,
    customerId: UserId,
    orderId: string,
    key: string,
  ) =>
    ctx.container.payments.settleFromWallet(scope, systemActor(key), customerId, {
      idempotencyKey: key,
      orderId,
    });

  const balanceOf = (scope: typeof tenantA, customerId: UserId) =>
    ctx.container.wallet.balance(scope, owner, customerId);

  const stateOf = async (orderId: string): Promise<{ state: string; settledAt: string | null }> => {
    const rows = (await ctx.container.database.db.execute(
      sql`SELECT state, settled_at FROM orders WHERE id = ${orderId}` as never,
    )) as unknown as { rows: { state: string; settled_at: string | null }[] };
    const row = rows.rows[0];
    if (row === undefined) throw new Error('order vanished');
    return { state: row.state, settledAt: row.settled_at };
  };

  const eventsFor = async (aggregateId: string): Promise<string[]> => {
    const rows = (await ctx.container.database.db.execute(
      sql`SELECT event_type FROM outbox_messages WHERE aggregate_id = ${aggregateId}
          ORDER BY sequence ASC` as never,
    )) as unknown as { rows: { event_type: string }[] };
    return rows.rows.map((r) => r.event_type);
  };

  const countOf = async (table: 'payments' | 'wallet_entries'): Promise<number> => {
    const rows = (await ctx.container.database.db.execute(
      (table === 'payments'
        ? sql`SELECT count(*)::int AS n FROM payments`
        : sql`SELECT count(*)::int AS n FROM wallet_entries`) as never,
    )) as unknown as { rows: { n: number }[] };
    return rows.rows[0]?.n ?? 0;
  };

  // -------------------------------------------------------------------------
  // The wallet settlement
  // -------------------------------------------------------------------------

  it('debits EXACTLY the order total and settles the order, in one transaction', async () => {
    const order = await awaitingPayment(tenantA, customerA, panelA, 'w1');
    await credit(tenantA, customerA, 1_000_000n, 'credit-w1');

    const { payment, order: settled } = await settleFromWallet(
      tenantA,
      customerA,
      order.id,
      'settle-w1-0001',
    );

    expect(payment.state).toBe('CONFIRMED');
    expect(payment.method).toBe('WALLET');
    expect(payment.evidenceKind).toBe('WALLET_DEBIT');
    expect(payment.amount).toEqual(money(250_000n, 'IRT'));
    expect(settled.state).toBe('PAID');

    // `LGR-BR-002`: the difference IS the price, to the minor unit.
    expect(await balanceOf(tenantA, customerA)).toMatchObject({ amountMinor: 750_000n });
    // The state and its timestamp move together, because the constraint binds them.
    expect((await stateOf(order.id)).settledAt).not.toBeNull();
  });

  it('refuses when the balance cannot cover the order, and moves nothing', async () => {
    const order = await awaitingPayment(tenantA, customerA, panelA, 'w2');
    await credit(tenantA, customerA, 100_000n, 'credit-w2');

    await expect(
      settleFromWallet(tenantA, customerA, order.id, 'settle-w2-0001'),
    ).rejects.toMatchObject({
      code: 'commerce.wallet_insufficient_funds',
      details: { shortfallMinor: '150000' },
    });

    expect(await balanceOf(tenantA, customerA)).toMatchObject({ amountMinor: 100_000n });
    expect(await countOf('payments')).toBe(0);
    expect((await stateOf(order.id)).state).toBe('AWAITING_PAYMENT');
  });

  /**
   * The rollback case, and the reason the whole movement is ONE transaction.
   *
   * A partial commit here is a customer charged for an order that never became theirs,
   * so the failure has to arrive AFTER the debit is written — cancelling the order
   * beforehand would be refused by the early read and prove nothing about rollback.
   *
   * So the interleaving is PRODUCED rather than hoped for, the shape `orders.test.ts`
   * uses: a transaction is held open having already settled the order, the service is
   * called and reads `AWAITING_PAYMENT`, writes the payment and the DEBIT, and blocks
   * on the row lock at its conditional UPDATE. The holder commits; the service's UPDATE
   * matches nothing. Everything it wrote must be gone.
   */
  it('rolls the DEBIT back when its own UPDATE settles nothing', async () => {
    const order = await awaitingPayment(tenantA, customerA, panelA, 'w3');
    await credit(tenantA, customerA, 1_000_000n, 'credit-w3');
    const orders = new DrizzleOrderRepository(ctx.container.database.db);

    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
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
      // Uncommitted. Anything reading still sees AWAITING_PAYMENT; anything WRITING blocks.
      await held;
    });

    const racing = settleFromWallet(tenantA, customerA, order.id, 'settle-w3-0001');
    const outcome = racing.then(
      () => 'settled' as const,
      (error: unknown) => error,
    );

    await new Promise((resolve) => setTimeout(resolve, 250));
    release();
    await holder;

    expect(await outcome).toMatchObject({
      code: 'commerce.settlement_not_funded',
      details: { reason: 'ORDER_NOT_AWAITING_PAYMENT' },
    });

    // The credit, and nothing else. No debit, no payment, no half-moved money.
    expect(await balanceOf(tenantA, customerA)).toMatchObject({
      amountMinor: 1_000_000n,
      entryCount: 1,
    });
    expect(await countOf('payments')).toBe(0);
  }, 30_000);

  it('settles ONCE for a repeated command, and writes one OrderSettled', async () => {
    const order = await awaitingPayment(tenantA, customerA, panelA, 'w4');
    await credit(tenantA, customerA, 1_000_000n, 'credit-w4');

    const first = await settleFromWallet(tenantA, customerA, order.id, 'settle-w4-0001');
    const again = await settleFromWallet(tenantA, customerA, order.id, 'settle-w4-0001');

    expect(again.payment.id).toBe(first.payment.id);
    expect(await countOf('payments')).toBe(1);
    // One credit + one purchase debit. A second debit would be a double charge.
    expect(await balanceOf(tenantA, customerA)).toMatchObject({
      amountMinor: 750_000n,
      entryCount: 2,
    });
    expect(await eventsFor(order.id)).toEqual(['OrderConfirmed', 'OrderSettled']);
  });

  /*
   * A DIFFERENT idempotency key for the same order, which is what a customer tapping a
   * stale message produces: the replay lookup finds nothing, so the whole command runs
   * again and is stopped by the ORDER's state rather than by a remembered response.
   */
  it('refuses a second settlement of an order already PAID', async () => {
    const order = await awaitingPayment(tenantA, customerA, panelA, 'w5');
    await credit(tenantA, customerA, 1_000_000n, 'credit-w5');
    await settleFromWallet(tenantA, customerA, order.id, 'settle-w5-0001');

    await expect(
      settleFromWallet(tenantA, customerA, order.id, 'settle-w5-0002'),
    ).rejects.toMatchObject({ code: 'commerce.order_state_invalid' });

    expect(await balanceOf(tenantA, customerA)).toMatchObject({ amountMinor: 750_000n });
    expect(await countOf('payments')).toBe(1);
  });

  it('cannot settle another customer’s order, and says UNKNOWN rather than FORBIDDEN', async () => {
    const other = await customer(tenantA, BOT_A, '900701');
    const order = await awaitingPayment(tenantA, other, panelA, 'w6');
    await credit(tenantA, customerA, 1_000_000n, 'credit-w6');

    await expect(
      settleFromWallet(tenantA, customerA, order.id, 'settle-w6-0001'),
    ).rejects.toMatchObject({ code: 'commerce.order_not_found' });

    expect(await balanceOf(tenantA, customerA)).toMatchObject({ amountMinor: 1_000_000n });
  });

  it('cannot reach another tenant’s order', async () => {
    const customerB = await customer(tenantB, BOT_B, '900702');
    const order = await awaitingPayment(tenantB, customerB, panelB, 'w7');
    await credit(tenantA, customerA, 1_000_000n, 'credit-w7');

    await expect(
      settleFromWallet(tenantA, customerA, order.id, 'settle-w7-0001'),
    ).rejects.toMatchObject({ code: 'commerce.order_not_found' });
  });

  it('refuses an installation that has stopped accepting work', async () => {
    const order = await awaitingPayment(tenantA, customerA, panelA, 'w8');
    await credit(tenantA, customerA, 1_000_000n, 'credit-w8');
    await ctx.container.database.db.execute(
      sql`UPDATE tenants SET status = 'STOPPED' WHERE id = ${tenantA.tenantId}` as never,
    );

    await expect(
      settleFromWallet(tenantA, customerA, order.id, 'settle-w8-0001'),
    ).rejects.toThrow();
    expect(await countOf('payments')).toBe(0);
  });

  // -------------------------------------------------------------------------
  // The manual transfer
  // -------------------------------------------------------------------------

  it('creates a PENDING payment for the order total, with a generated reference', async () => {
    const order = await awaitingPayment(tenantA, customerA, panelA, 'm1');

    const payment = await ctx.container.payments.requestManualTransfer(
      tenantA,
      systemActor('manual-m1'),
      customerA,
      { idempotencyKey: 'manual-m1-0001', orderId: order.id },
    );

    expect(payment.state).toBe('PENDING');
    expect(payment.method).toBe('MANUAL_TRANSFER');
    // The order's frozen total, which is what `bot.payment.manual_instructions` renders.
    expect(payment.amount).toEqual(money(250_000n, 'IRT'));
    expect(payment.reference).toMatch(/^[0-9a-f]{16}:manual$/u);
    // Nothing settled and no money moved. A request is not a payment.
    expect((await stateOf(order.id)).state).toBe('AWAITING_PAYMENT');
    expect(await countOf('wallet_entries')).toBe(0);
  });

  it('confirms a transfer under receipts.review and settles the order with it', async () => {
    const order = await awaitingPayment(tenantA, customerA, panelA, 'm2');
    const pending = await ctx.container.payments.requestManualTransfer(
      tenantA,
      systemActor('manual-m2'),
      customerA,
      { idempotencyKey: 'manual-m2-0001', orderId: order.id },
    );

    const reviewer = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'finance-payments',
        roleKeys: ['finance'],
      }),
    );

    const { payment, order: settled } = await ctx.container.payments.confirmManualTransfer(
      tenantA,
      reviewer,
      pending.id,
      { idempotencyKey: 'confirm-m2-0001', note: 'کارت به کارت، ۴ رقم آخر ۱۲۳۴' },
    );

    expect(payment.state).toBe('CONFIRMED');
    expect(payment.evidenceKind).toBe('OPERATOR_REVIEW');
    // The reviewer and the time are BOTH recorded — `UNK-PR-010` is the legacy review
    // that records neither, which is why "was this approved by a human" is unanswerable.
    expect(payment.confirmedByAdminId).toBe(reviewer.id);
    expect(payment.confirmedAt).not.toBeNull();
    expect(settled?.state).toBe('PAID');
    // Confirming an out-of-band transfer moves no wallet money. It arrived elsewhere.
    expect(await countOf('wallet_entries')).toBe(0);
  });

  it('refuses a confirmation from an operator without receipts.review', async () => {
    const order = await awaitingPayment(tenantA, customerA, panelA, 'm3');
    const pending = await ctx.container.payments.requestManualTransfer(
      tenantA,
      systemActor('manual-m3'),
      customerA,
      { idempotencyKey: 'manual-m3-0001', orderId: order.id },
    );
    const support = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'support-payments',
        roleKeys: ['support'],
      }),
    );

    await expect(
      ctx.container.payments.confirmManualTransfer(tenantA, support, pending.id, {
        idempotencyKey: 'confirm-m3-0001',
        note: 'looks fine',
      }),
    ).rejects.toMatchObject({ code: 'platform.permission_denied' });

    expect((await stateOf(order.id)).state).toBe('AWAITING_PAYMENT');
    const audit = (await ctx.container.database.db.execute(
      sql`SELECT action, result FROM audit_logs WHERE entity_type = 'Payment'
          AND action = 'payment.confirm'` as never,
    )) as unknown as { rows: { action: string; result: string }[] };
    expect(audit.rows).toEqual([{ action: 'payment.confirm', result: 'DENIED' }]);
  });

  it('answers a repeated confirmation with the same payment, and settles once', async () => {
    const order = await awaitingPayment(tenantA, customerA, panelA, 'm4');
    const pending = await ctx.container.payments.requestManualTransfer(
      tenantA,
      systemActor('manual-m4'),
      customerA,
      { idempotencyKey: 'manual-m4-0001', orderId: order.id },
    );
    const reviewer = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'finance-m4',
        roleKeys: ['finance'],
      }),
    );

    const first = await ctx.container.payments.confirmManualTransfer(
      tenantA,
      reviewer,
      pending.id,
      {
        idempotencyKey: 'confirm-m4-0001',
        note: 'received',
      },
    );
    // A SECOND operator pressing approve, with their own key: the replay finds nothing
    // and the conditional UPDATE is what makes it safe.
    const again = await ctx.container.payments.confirmManualTransfer(
      tenantA,
      reviewer,
      pending.id,
      {
        idempotencyKey: 'confirm-m4-0002',
        note: 'received again',
      },
    );

    expect(again.payment.id).toBe(first.payment.id);
    expect(again.payment.confirmedAt).toEqual(first.payment.confirmedAt);
    // The second note did NOT overwrite the first: a CONFIRMED payment is frozen.
    expect(again.payment.evidenceNote).toBe('received');
    expect(await eventsFor(order.id)).toEqual(['OrderConfirmed', 'OrderSettled']);
  });

  // -------------------------------------------------------------------------
  // The guard, and what it refuses
  // -------------------------------------------------------------------------

  /*
   * The amount is the ORDER's, not the payment's, and this proves the direction.
   *
   * The payment's amount is edited behind the service's back to something smaller —
   * which is what a client-supplied amount would have produced — and the settlement is
   * refused rather than under-funding the order. `settlementIsFunded` compares two ROWS.
   */
  it('refuses to settle an order from a payment that does not cover it', async () => {
    const order = await awaitingPayment(tenantA, customerA, panelA, 'g1');
    const pending = await ctx.container.payments.requestManualTransfer(
      tenantA,
      systemActor('manual-g1'),
      customerA,
      { idempotencyKey: 'manual-g1-0001', orderId: order.id },
    );
    await ctx.container.database.db.execute(
      sql`UPDATE payments SET amount = 1 WHERE id = ${pending.id}` as never,
    );
    const reviewer = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'finance-g1', roleKeys: ['finance'] }),
    );

    await expect(
      ctx.container.payments.confirmManualTransfer(tenantA, reviewer, pending.id, {
        idempotencyKey: 'confirm-g1-0001',
        note: 'short',
      }),
    ).rejects.toMatchObject({
      code: 'commerce.settlement_not_funded',
      details: { reason: 'AMOUNT_DOES_NOT_COVER_THE_ORDER' },
    });

    // The confirmation rolled back WITH the settlement. A confirmed payment that funds
    // nothing is money recorded as having bought something it did not buy.
    expect((await stateOf(order.id)).state).toBe('AWAITING_PAYMENT');
    const after = await ctx.container.payments.get(tenantA, owner, pending.id);
    expect(after.state).toBe('PENDING');
    expect(after.confirmedAt).toBeNull();
  });

  it('refuses to settle across currencies rather than converting', async () => {
    const order = await awaitingPayment(tenantA, customerA, panelA, 'g2');
    const pending = await ctx.container.payments.requestManualTransfer(
      tenantA,
      systemActor('manual-g2'),
      customerA,
      { idempotencyKey: 'manual-g2-0001', orderId: order.id },
    );
    await ctx.container.database.db.execute(
      sql`UPDATE payments SET currency = 'IRR' WHERE id = ${pending.id}` as never,
    );
    const reviewer = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'finance-g2', roleKeys: ['finance'] }),
    );

    await expect(
      ctx.container.payments.confirmManualTransfer(tenantA, reviewer, pending.id, {
        idempotencyKey: 'confirm-g2-0001',
        note: 'wrong currency',
      }),
    ).rejects.toMatchObject({
      code: 'commerce.settlement_not_funded',
      // NOT rescaled by ten. No exchange rate exists anywhere in this system.
      details: { reason: 'CURRENCY_DOES_NOT_MATCH_THE_ORDER' },
    });
    expect((await stateOf(order.id)).state).toBe('AWAITING_PAYMENT');
  });

  /*
   * At most ONE confirmed payment per order, enforced by a partial unique index rather
   * than by an application check — two concurrent confirmations cannot both see the
   * absence of the other.
   */
  it('cannot hold two confirmed payments for one order', async () => {
    const order = await awaitingPayment(tenantA, customerA, panelA, 'g3');
    await credit(tenantA, customerA, 1_000_000n, 'credit-g3');
    await settleFromWallet(tenantA, customerA, order.id, 'settle-g3-0001');

    await expect(
      ctx.container.database.withClient((client) =>
        client.query(
          `INSERT INTO payments
             (id, tenant_id, customer_id, order_id, state, method, amount, currency, reference,
              evidence_kind, confirmed_at)
           VALUES ($1, $2, $3, $4, 'CONFIRMED', 'MANUAL_TRANSFER', 250000, 'IRT', $5,
                   'OPERATOR_REVIEW', now())`,
          [ctx.container.ids.uuid(), SEED_IDS.tenantA, customerA, order.id, 'second-confirmed'],
        ),
      ),
    ).rejects.toThrow(/payments_order_confirmed_key/u);
  });

  /*
   * ONE movement, ONE `WalletEntryRecorded` — even when the command runs twice.
   *
   * Self-review finding S3. The event is gated on the append having actually WRITTEN,
   * so a retry whose ledger entry already exists emits nothing further. Driven here
   * through the SERVICE with the same key, which is the path a redelivery takes.
   */
  it('emits one WalletEntryRecorded for one movement, however often it is retried', async () => {
    const order = await awaitingPayment(tenantA, customerA, panelA, 'evt-1');
    await credit(tenantA, customerA, 1_000_000n, 'credit-evt-1');
    await settleFromWallet(tenantA, customerA, order.id, 'settle-evt-0001');
    await settleFromWallet(tenantA, customerA, order.id, 'settle-evt-0001');

    const events = (await ctx.container.database.db.execute(
      sql`SELECT event_type FROM outbox_messages WHERE event_type = 'WalletEntryRecorded'` as never,
    )) as unknown as { rows: { event_type: string }[] };
    // One for the operator's funding credit, one for the purchase debit. Not three.
    expect(events.rows).toHaveLength(2);
  });

  /*
   * ONE command, ONE audit action — for the REFUSAL and the SUCCESS alike.
   *
   * Self-review finding S2, and the identical defect Phase 4B recorded as M36: the
   * pre-replay denial wrote `order.create` while success wrote `order.draft_create`,
   * and the rows that went missing from the established name were exactly the refusals
   * the check existed to record. Here a wallet settlement audited its denial as
   * `payment.wallet_settle` and its success as `payment.confirm` — which also made a
   * customer's own purchase indistinguishable from an operator approving a transfer.
   *
   * Asserted as the ACTION, not as the existence of a row. M36 survived a test that
   * checked only that a denial row existed.
   */
  it('audits a wallet settlement under ONE action, refused or not', async () => {
    const order = await awaitingPayment(tenantA, customerA, panelA, 'audit-1');
    await credit(tenantA, customerA, 1_000_000n, 'credit-audit-1');
    await settleFromWallet(tenantA, customerA, order.id, 'settle-audit-0001');

    const success = (await ctx.container.database.db.execute(
      sql`SELECT action, result FROM audit_logs WHERE entity_type = 'Payment'` as never,
    )) as unknown as { rows: { action: string; result: string }[] };
    expect(success.rows).toEqual([{ action: 'payment.wallet_settle', result: 'SUCCESS' }]);

    // And a refusal of the same command carries the SAME name. `support` holds
    // `maintenance.run`? No — it is an operator role, so it does not, which is what
    // makes it refused here.
    const support = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'support-audit',
        roleKeys: ['support'],
      }),
    );
    const other = await awaitingPayment(tenantA, customerA, panelA, 'audit-2');
    await expect(
      ctx.container.payments.settleFromWallet(tenantA, support, customerA, {
        idempotencyKey: 'settle-audit-0002',
        orderId: other.id,
      }),
    ).rejects.toMatchObject({ code: 'platform.permission_denied' });

    const both = (await ctx.container.database.db.execute(
      sql`SELECT action, result FROM audit_logs WHERE entity_type IN ('Payment', 'Order')
          AND action LIKE 'payment.%' ORDER BY occurred_at ASC, id ASC` as never,
    )) as unknown as { rows: { action: string; result: string }[] };
    expect(both.rows).toEqual([
      { action: 'payment.wallet_settle', result: 'SUCCESS' },
      { action: 'payment.wallet_settle', result: 'DENIED' },
    ]);
  });

  // -------------------------------------------------------------------------
  // The repository's own guarantees
  // -------------------------------------------------------------------------

  /*
   * These three go to the REPOSITORY directly, and that is the point of them.
   *
   * Each rule below is shadowed by a service-level early return — a replay lookup, an
   * already-CONFIRMED branch — so a service-level test cannot reach it: the command
   * returns before the statement that carries the guarantee ever runs. P09 and P10
   * SURVIVED falsification for exactly that reason, which is the "tested the helper,
   * not the call site" shape recorded on the Phase 4B branch, inverted.
   */
  describe('the payment repository', () => {
    it('confirms only from PENDING, and tells the loser it lost', async () => {
      const order = await awaitingPayment(tenantA, customerA, panelA, 'r1');
      const pending = await ctx.container.payments.requestManualTransfer(
        tenantA,
        systemActor('manual-r1'),
        customerA,
        { idempotencyKey: 'manual-r1-0001', orderId: order.id },
      );
      const repository = new DrizzlePaymentRepository(ctx.container.database.db);
      const confirmation = {
        evidenceKind: 'OPERATOR_REVIEW' as const,
        evidenceNote: 'first',
        confirmedByAdminId: null,
        confirmedAt: ctx.container.clock.now(),
      };

      const first = await repository.confirm(
        tenantA,
        pending.id,
        confirmation,
        ctx.container.clock.now(),
      );
      const second = await repository.confirm(
        tenantA,
        pending.id,
        { ...confirmation, evidenceNote: 'second' },
        ctx.container.clock.now(),
      );

      expect(first).toBe(true);
      // `false` IS the mechanism: two operators approving, a replayed request and two
      // replicas all produce one confirmation, with no lock and no read-then-write window.
      expect(second).toBe(false);
      const after = await repository.findById(tenantA, pending.id);
      expect(after?.evidenceNote).toBe('first');
    });

    it('creates ONE payment for a repeated reference, and returns the first', async () => {
      const order = await awaitingPayment(tenantA, customerA, panelA, 'r2');
      const repository = new DrizzlePaymentRepository(ctx.container.database.db);
      const draftFor = (id: string) => ({
        id: id as PaymentId,
        customerId: customerA,
        orderId: order.id,
        method: 'MANUAL_TRANSFER' as const,
        amount: money(250_000n, 'IRT'),
        reference: 'repeated-reference',
        expiresAt: null,
        now: ctx.container.clock.now(),
      });

      const first = await repository.create(tenantA, draftFor(ctx.container.ids.uuid()));
      // A retry recomputes the SAME reference and must land on the existing row rather
      // than mint a second payment the customer could also be asked to pay.
      const again = await repository.create(tenantA, draftFor(ctx.container.ids.uuid()));

      expect(again.id).toBe(first.id);
      expect(await countOf('payments')).toBe(1);
    });

    /*
     * A lookup without the tenant returns another tenant's row and leaves the caller to
     * decide what to do with something it should never have seen. For money that is not
     * a leak, it is a way to confirm somebody else's payment.
     */
    it('cannot see or address another tenant’s payment', async () => {
      const customerB = await customer(tenantB, BOT_B, '900703');
      const orderB = await awaitingPayment(tenantB, customerB, panelB, 'r4');
      const theirs = await ctx.container.payments.requestManualTransfer(
        tenantB,
        systemActor('manual-r4'),
        customerB,
        { idempotencyKey: 'manual-r4-0001', orderId: orderB.id },
      );
      const repository = new DrizzlePaymentRepository(ctx.container.database.db);

      expect(await repository.findById(tenantA, theirs.id)).toBeNull();
      expect(await repository.findByReference(tenantA, theirs.reference)).toBeNull();
      expect((await repository.list(tenantA, {}, 50, null)).items).toEqual([]);
      // And it is genuinely there, read from its own tenant.
      expect((await repository.findById(tenantB, theirs.id))?.id).toBe(theirs.id);

      await expect(
        ctx.container.payments.confirmManualTransfer(tenantA, owner, theirs.id, {
          idempotencyKey: 'confirm-r4-0001',
          note: 'not mine to approve',
        }),
      ).rejects.toMatchObject({ code: 'commerce.payment_not_found' });
    });

    /*
     * The freeze is a TRIGGER, so it is tested through the raw client: the repository
     * has no method that could attempt this, which is the design rather than an
     * omission. `nexa_payments_confirmation_guard` (0035) is what makes a confirmed
     * amount unable to change after the fact.
     */
    it('refuses to change a CONFIRMED payment’s amount, in the database', async () => {
      const order = await awaitingPayment(tenantA, customerA, panelA, 'r3');
      await credit(tenantA, customerA, 1_000_000n, 'credit-r3');
      const { payment } = await settleFromWallet(tenantA, customerA, order.id, 'settle-r3-0001');

      await expect(
        ctx.container.database.withClient((client) =>
          client.query(`UPDATE payments SET amount = 1 WHERE id = $1`, [payment.id]),
        ),
      ).rejects.toThrow();

      const after = await ctx.container.payments.get(tenantA, owner, payment.id);
      expect(after.amount).toEqual(money(250_000n, 'IRT'));
    });
  });

  // -------------------------------------------------------------------------
  // Where this phase stops
  // -------------------------------------------------------------------------

  /*
   * A settled order is PAID and nothing else.
   *
   * Asserted by asking: no service row, no panel call, no provisioning event. A comment
   * saying "we did not build these" cannot notice the commit that does.
   */
  it('settles to PAID and claims nothing beyond it', async () => {
    const order = await awaitingPayment(tenantA, customerA, panelA, 'b1');
    await credit(tenantA, customerA, 1_000_000n, 'credit-b1');
    await settleFromWallet(tenantA, customerA, order.id, 'settle-b1-0001');

    expect((await stateOf(order.id)).state).toBe('PAID');

    const events = (await ctx.container.database.db.execute(
      sql`SELECT DISTINCT event_type FROM outbox_messages` as never,
    )) as unknown as { rows: { event_type: string }[] };
    const types = events.rows.map((r) => r.event_type);
    for (const claimed of [
      'ServiceProvisioned',
      'ServiceStateChanged',
      'ProvisioningOutcomeUnknown',
    ]) {
      expect(types, `${claimed} was emitted by a phase that provisions nothing`).not.toContain(
        claimed,
      );
    }

    const services = (await ctx.container.database.db.execute(
      sql`SELECT count(*)::int AS n FROM services` as never,
    )) as unknown as { rows: { n: number }[] };
    expect(services.rows[0]?.n).toBe(0);
  });

  // -------------------------------------------------------------------------
  // What the SERVICE refuses, regardless of what a surface checked on arrival
  // -------------------------------------------------------------------------

  /*
   * These four are here rather than in the Telegram suite on purpose.
   *
   * `telegram-payment-flow.test.ts` blocks the customer BEFORE the tap, so it proves
   * only that the surface gate works. The case that matters is the operator acting
   * BETWEEN the surface's check and the write, which no surface test can produce — so
   * the service is called directly, which is exactly what that race looks like from
   * here.
   */
  describe('refusals the surface cannot be trusted to make', () => {
    const block = (customerId: UserId) =>
      ctx.container.database.db.execute(
        sql`UPDATE customers SET status = 'BLOCKED', blocked_at = now()
            WHERE id = ${customerId}` as never,
      );

    it('refuses a wallet settlement for a customer blocked after the turn began', async () => {
      const order = await awaitingPayment(tenantA, customerA, panelA, 'blk-w');
      await credit(tenantA, customerA, 1_000_000n, 'blk-w-credit');
      await block(customerA);

      await expect(
        ctx.container.payments.settleFromWallet(tenantA, systemActor('blk-w'), customerA, {
          idempotencyKey: 'blk-w-settle-0001',
          orderId: order.id,
        }),
      ).rejects.toMatchObject({ code: 'commerce.customer_blocked' });

      // No debit, and the order is untouched.
      expect(await balanceOf(tenantA, customerA)).toMatchObject({ amountMinor: 1_000_000n });
      expect((await ctx.container.orders.get(tenantA, owner, order.id)).state).toBe(
        'AWAITING_PAYMENT',
      );
    });

    it('refuses a manual transfer request for a customer blocked after the turn began', async () => {
      const order = await awaitingPayment(tenantA, customerA, panelA, 'blk-m');
      await block(customerA);

      await expect(
        ctx.container.payments.requestManualTransfer(tenantA, systemActor('blk-m'), customerA, {
          idempotencyKey: 'blk-m-request-0001',
          orderId: order.id,
        }),
      ).rejects.toMatchObject({ code: 'commerce.customer_blocked' });
    });

    it('refuses to settle an order whose stated deadline has passed', async () => {
      const order = await awaitingPayment(tenantA, customerA, panelA, 'exp-w');
      await credit(tenantA, customerA, 1_000_000n, 'exp-w-credit');
      /*
       * The deadline moved into the PAST rather than the clock moved forward: it is the
       * order's own `expires_at` the customer was shown, and this is the value the
       * refusal must read. Nothing sweeps a stale order, so it is still AWAITING_PAYMENT
       * — which is precisely why the state check alone never fired.
       */
      await ctx.container.database.db.execute(
        sql`UPDATE orders SET expires_at = now() - interval '1 day' WHERE id = ${order.id}` as never,
      );

      await expect(
        ctx.container.payments.settleFromWallet(tenantA, systemActor('exp-w'), customerA, {
          idempotencyKey: 'exp-w-settle-0001',
          orderId: order.id,
        }),
      ).rejects.toMatchObject({ code: 'commerce.order_expired' });

      expect(await balanceOf(tenantA, customerA)).toMatchObject({ amountMinor: 1_000_000n });
    });

    it('refuses to print transfer instructions for an order whose deadline has passed', async () => {
      const order = await awaitingPayment(tenantA, customerA, panelA, 'exp-m');
      await ctx.container.database.db.execute(
        sql`UPDATE orders SET expires_at = now() - interval '1 day' WHERE id = ${order.id}` as never,
      );

      await expect(
        ctx.container.payments.requestManualTransfer(tenantA, systemActor('exp-m'), customerA, {
          idempotencyKey: 'exp-m-request-0001',
          orderId: order.id,
        }),
      ).rejects.toMatchObject({ code: 'commerce.order_expired' });
    });

    /*
     * The asymmetry, asserted so it cannot be "tidied" into consistency.
     *
     * An OPERATOR confirming a transfer that already arrived is not a customer starting
     * to pay late. The money is in the bank; refusing because the deadline lapsed while
     * the receipt sat in the review queue would strand it, and 4C has no refund path.
     */
    it('still lets an operator confirm a transfer that arrived before the deadline', async () => {
      const lateReviewer = adminActorFor(
        await createAdmin(ctx.container, tenantA, {
          username: 'finance-late',
          roleKeys: ['finance'],
        }),
      );
      const order = await awaitingPayment(tenantA, customerA, panelA, 'exp-c');
      const pending = await ctx.container.payments.requestManualTransfer(
        tenantA,
        systemActor('exp-c'),
        customerA,
        { idempotencyKey: 'exp-c-request-0001', orderId: order.id },
      );
      await ctx.container.database.db.execute(
        sql`UPDATE orders SET expires_at = now() - interval '1 day' WHERE id = ${order.id}` as never,
      );

      const confirmed = await ctx.container.payments.confirmManualTransfer(
        tenantA,
        lateReviewer,
        pending.id,
        { idempotencyKey: 'exp-c-confirm-0001', note: 'arrived in time' },
      );

      expect(confirmed.payment.state).toBe('CONFIRMED');
      expect((await ctx.container.orders.get(tenantA, owner, order.id)).state).toBe('PAID');
    });

    /*
     * ONE open transfer per order, however many times the customer taps.
     *
     * A second tap is a different `update_id`, so a different idempotency key and a
     * different derived reference — which used to mean a second PENDING row. The
     * customer would hold two codes for one order and the operator two identical rows,
     * with nothing saying which the bank reference names.
     */
    it('hands back the open transfer rather than issuing a second code for one order', async () => {
      const order = await awaitingPayment(tenantA, customerA, panelA, 'one-m');

      const first = await ctx.container.payments.requestManualTransfer(
        tenantA,
        systemActor('one-m-1'),
        customerA,
        { idempotencyKey: 'one-m-request-0001', orderId: order.id },
      );
      // A DIFFERENT key: the second tap, not a replay of the first.
      const second = await ctx.container.payments.requestManualTransfer(
        tenantA,
        systemActor('one-m-2'),
        customerA,
        { idempotencyKey: 'one-m-request-0002', orderId: order.id },
      );

      expect(second.id).toBe(first.id);
      expect(second.reference).toBe(first.reference);
      const rows = await ctx.container.database.db.execute(
        sql`SELECT id FROM payments WHERE order_id = ${order.id}` as never,
      );
      expect(
        (rows as unknown as { rows: unknown[] }).rows,
        'a second code was issued',
      ).toHaveLength(1);
    });
  });
});
