import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  COMMERCE_ERROR_CODES,
  money,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type PanelId,
  type PaymentId,
  type ProductId,
  type UserId,
  type ProductCategoryId,
} from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import type { ProductDraft } from '../../apps/api/src/modules/commerce/catalog/application/ports';
import type { OrderRecord } from '../../apps/api/src/modules/commerce/orders/application/ports';
import { DrizzleOrderRepository } from '../../apps/api/src/modules/commerce/orders/infrastructure/drizzle-order.repository';
import { DrizzlePaymentRepository } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-payment.repository';
import { PaymentExpiryService } from '../../apps/api/src/modules/commerce/payments/application/payment-expiry.service';
import { CustomerNotifier } from '../../apps/api/src/modules/commerce/messaging/application/customer-notifier';
import { DrizzleCustomerNotificationRepository } from '../../apps/api/src/modules/commerce/messaging/infrastructure/drizzle-customer-notification.repository';
import { DrizzleCustomerRepository } from '../../apps/api/src/modules/commerce/customers/infrastructure/drizzle-customer.repository';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  makePanelSellable,
  SEED_IDS,
  seededCategoryFor,
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
    await makePanelSellable(ctx.container, tenantB, panelB);
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

  const draft = (
    scope: typeof tenantA,
    panelId: string,
    overrides: Partial<ProductDraft> = {},
  ): ProductDraft => ({
    title: 'پلن پایه',
    description: 'یک ماهه',
    audience: 'EVERYONE',
    sortOrder: 10,
    panelId: panelId as PanelId,
    /*
     * The category of the tenant this product is being written for, never a fixed one.
     * `products_tenant_category_fk` is composite, so a tenant B product filed under
     * tenant A's category is refused by the database — which is right, and which turns
     * a cross-tenant isolation test into a foreign-key error instead of the assertion
     * it was written to make.
     */
    categoryId: seededCategoryFor(scope) as ProductCategoryId,
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
      draft: draft(scope, panelId, overrides),
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
    // A wallet settlement goes through no route and promises no top-up gift (D5).
    expect(payment).toMatchObject({ gatewayProvider: null, topupCashbackPercent: null });
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

    const payment = await ctx.container.payments
      .requestManualTransfer(tenantA, systemActor('manual-m1'), customerA, {
        idempotencyKey: 'manual-m1-0001',
        orderId: order.id,
      })
      .then((issued) => issued.payment);

    expect(payment.state).toBe('PENDING');
    expect(payment.method).toBe('MANUAL_TRANSFER');
    // The order's frozen total, which is what `bot.payment.manual_instructions` renders.
    expect(payment.amount).toEqual(money(250_000n, 'IRT'));
    expect(payment.reference).toMatch(/^[0-9a-f]{16}:manual$/u);
    // The route it was offered through, and NO gift: a top-up's alone (D5).
    expect(payment).toMatchObject({
      gatewayProvider: 'MANUAL_TRANSFER',
      topupCashbackPercent: null,
    });
    // Nothing settled and no money moved. A request is not a payment.
    expect((await stateOf(order.id)).state).toBe('AWAITING_PAYMENT');
    expect(await countOf('wallet_entries')).toBe(0);
  });

  it('confirms a transfer under receipts.review and settles the order with it', async () => {
    const order = await awaitingPayment(tenantA, customerA, panelA, 'm2');
    const pending = await ctx.container.payments
      .requestManualTransfer(tenantA, systemActor('manual-m2'), customerA, {
        idempotencyKey: 'manual-m2-0001',
        orderId: order.id,
      })
      .then((issued) => issued.payment);

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
    const pending = await ctx.container.payments
      .requestManualTransfer(tenantA, systemActor('manual-m3'), customerA, {
        idempotencyKey: 'manual-m3-0001',
        orderId: order.id,
      })
      .then((issued) => issued.payment);
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
    const pending = await ctx.container.payments
      .requestManualTransfer(tenantA, systemActor('manual-m4'), customerA, {
        idempotencyKey: 'manual-m4-0001',
        orderId: order.id,
      })
      .then((issued) => issued.payment);
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
    const pending = await ctx.container.payments
      .requestManualTransfer(tenantA, systemActor('manual-g1'), customerA, {
        idempotencyKey: 'manual-g1-0001',
        orderId: order.id,
      })
      .then((issued) => issued.payment);
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
    const pending = await ctx.container.payments
      .requestManualTransfer(tenantA, systemActor('manual-g2'), customerA, {
        idempotencyKey: 'manual-g2-0001',
        orderId: order.id,
      })
      .then((issued) => issued.payment);
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
    /*
     * The repository's OWN guard, exercised without the service in front of it.
     *
     * `rejectManualTransfer` and `withdrawPending` both check the state before calling
     * `resolve`, so every case driven through them is refused one layer higher and says
     * nothing about this one. The layer that matters is the one that survives a race:
     * two operators, a customer and the sweep, and a replayed command all reach the
     * same row, and it is `WHERE state = 'PENDING'` that makes one of them win rather
     * than the last writer.
     */
    it('resolves only from PENDING, and tells the loser it lost', async () => {
      const order = await awaitingPayment(tenantA, customerA, panelA, 'r0');
      const pending = await ctx.container.payments
        .requestManualTransfer(tenantA, systemActor('manual-r0'), customerA, {
          idempotencyKey: 'manual-r0-0001',
          orderId: order.id,
        })
        .then((issued) => issued.payment);
      const repository = new DrizzlePaymentRepository(ctx.container.database.db);
      const now = ctx.container.clock.now();

      const first = await repository.resolve(
        tenantA,
        pending.id,
        'FAILED',
        { resolvedByAdminId: null, resolutionNote: 'first', resolvedAt: now },
        now,
      );
      // The SAME target, which is the case a state check in the service never sees:
      // both callers believed the row was PENDING when they read it.
      const second = await repository.resolve(
        tenantA,
        pending.id,
        'FAILED',
        { resolvedByAdminId: null, resolutionNote: 'second', resolvedAt: now },
        now,
      );

      expect(first).toBe(true);
      expect(second).toBe(false);
      expect((await paymentRow(pending.id)).resolution_note).toBe('first');
    });

    it('will not resolve a payment that was confirmed', async () => {
      const order = await awaitingPayment(tenantA, customerA, panelA, 'r0b');
      const pending = await ctx.container.payments
        .requestManualTransfer(tenantA, systemActor('manual-r0b'), customerA, {
          idempotencyKey: 'manual-r0b-0001',
          orderId: order.id,
        })
        .then((issued) => issued.payment);
      await ctx.container.payments.confirmManualTransfer(tenantA, owner, pending.id, {
        idempotencyKey: 'manual-r0b-confirm-0001',
        note: 'money arrived',
      });
      const repository = new DrizzlePaymentRepository(ctx.container.database.db);
      const now = ctx.container.clock.now();

      // Money moved. Nothing below the service may take it back, and the guard that
      // stops it is the same one that settles the race above.
      const moved = await repository.resolve(
        tenantA,
        pending.id,
        'FAILED',
        { resolvedByAdminId: null, resolutionNote: 'too late', resolvedAt: now },
        now,
      );

      expect(moved).toBe(false);
      expect((await paymentRow(pending.id)).state).toBe('CONFIRMED');
    });

    /*
     * The `cancelled_at` stamp, which is what makes `ORDER_MACHINE`'s CANCEL edge
     * callable at all.
     *
     * `orders_cancelled_at_check` is `(state = 'CANCELLED') = (cancelled_at IS NOT
     * NULL)`, so before 4G the repository could name CANCELLED as its target and be
     * refused by the database every time. There is no caller yet — whether an operator
     * may end an order is OQ-4G-02 — and a parameter with no caller and no test is the
     * shape CLAUDE.md says gets silently reverted, so the mechanism is proved here
     * rather than asserted in a docblock.
     */
    it('cancels an order only when the statement carries the stamp the schema requires', async () => {
      const order = await awaitingPayment(tenantA, customerA, panelA, 'cx');
      const orders = new DrizzleOrderRepository(ctx.container.database.db);
      const now = ctx.container.clock.now();

      // Without it, the database refuses — the measurement `docs/phase4g-audit.md`
      // records, run against the real constraint rather than a temp table.
      await expect(
        orders.transition(tenantA, order.id, 'AWAITING_PAYMENT', 'CANCELLED', {}, now),
      ).rejects.toMatchObject({
        cause: { constraint: 'orders_cancelled_at_check' },
      });
      expect((await stateOf(order.id)).state).toBe('AWAITING_PAYMENT');

      const moved = await orders.transition(
        tenantA,
        order.id,
        'AWAITING_PAYMENT',
        'CANCELLED',
        { cancelledAt: now },
        now,
      );
      expect(moved).toBe(true);
      expect((await stateOf(order.id)).state).toBe('CANCELLED');
    });

    it('confirms only from PENDING, and tells the loser it lost', async () => {
      const order = await awaitingPayment(tenantA, customerA, panelA, 'r1');
      const pending = await ctx.container.payments
        .requestManualTransfer(tenantA, systemActor('manual-r1'), customerA, {
          idempotencyKey: 'manual-r1-0001',
          orderId: order.id,
        })
        .then((issued) => issued.payment);
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
        gatewayProvider: 'MANUAL_TRANSFER' as const,
        topupCashbackPercent: null,
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
      const theirs = await ctx.container.payments
        .requestManualTransfer(tenantB, systemActor('manual-r4'), customerB, {
          idempotencyKey: 'manual-r4-0001',
          orderId: orderB.id,
        })
        .then((issued) => issued.payment);
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
  it('settles to PAID, plans the service, and still touches no provider', async () => {
    const order = await awaitingPayment(tenantA, customerA, panelA, 'b1');
    await credit(tenantA, customerA, 1_000_000n, 'credit-b1');
    await settleFromWallet(tenantA, customerA, order.id, 'settle-b1-0001');

    expect((await stateOf(order.id)).state).toBe('PAID');

    /*
     * The boundary this case guards MOVED in Phase 4D, and it is worth saying how.
     *
     * Before 4D it asserted a settled order produced no service row at all, because
     * nothing could provision. That is now false by design: the service and its
     * PROVISION operation are written in this very transaction, which is what makes
     * "one settled order produces at most one logical service" a unique index rather
     * than a worker's discipline.
     *
     * What has NOT moved, and what this case is really about, is that settlement still
     * contacts nothing. So the assertions invert from "no row" to "a row in
     * PENDING_PROVISION, an operation in PLANNED, and no event that claims an external
     * effect" — which is a stronger statement than the one it replaces, because a
     * service row that appeared ACTIVE here would mean a panel had been called inside a
     * money transaction.
     */
    const services = (await ctx.container.database.db.execute(
      sql`SELECT state, provisioned_at, subscription_url, delivery_state FROM services` as never,
    )) as unknown as {
      rows: {
        state: string;
        provisioned_at: string | null;
        subscription_url: string | null;
        delivery_state: string;
      }[];
    };
    expect(services.rows, 'a settled order is owed exactly one service').toHaveLength(1);
    expect(services.rows[0]?.state).toBe('PENDING_PROVISION');
    expect(services.rows[0]?.provisioned_at, 'nothing has provisioned it').toBeNull();
    expect(services.rows[0]?.subscription_url, 'no provider has issued anything').toBeNull();
    expect(services.rows[0]?.delivery_state, 'nobody has been told anything').toBe('PENDING');

    const operations = (await ctx.container.database.db.execute(
      sql`SELECT type, state, attempts, call_started_at FROM provisioning_operations` as never,
    )) as unknown as {
      rows: { type: string; state: string; attempts: number; call_started_at: string | null }[];
    };
    expect(operations.rows).toHaveLength(1);
    expect(operations.rows[0]?.type).toBe('PROVISION');
    expect(operations.rows[0]?.state).toBe('PLANNED');
    expect(operations.rows[0]?.attempts, 'nothing has been attempted').toBe(0);
    expect(operations.rows[0]?.call_started_at, 'no provider call was started').toBeNull();

    const events = (await ctx.container.database.db.execute(
      sql`SELECT DISTINCT event_type FROM outbox_messages` as never,
    )) as unknown as { rows: { event_type: string }[] };
    const types = events.rows.map((r) => r.event_type);
    /*
     * Still none of these, and for the same reason as before: each one asserts
     * something happened on somebody else's machine, and nothing has been contacted.
     * `ServiceProvisioned` is written by the executor, outside every transaction.
     */
    for (const claimed of [
      'ServiceProvisioned',
      'ServiceStateChanged',
      'ProvisioningOutcomeUnknown',
    ]) {
      expect(types, `${claimed} claims an external effect settlement did not have`).not.toContain(
        claimed,
      );
    }
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
        ctx.container.payments
          .requestManualTransfer(tenantA, systemActor('blk-m'), customerA, {
            idempotencyKey: 'blk-m-request-0001',
            orderId: order.id,
          })
          .then((issued) => issued.payment),
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
        ctx.container.payments
          .requestManualTransfer(tenantA, systemActor('exp-m'), customerA, {
            idempotencyKey: 'exp-m-request-0001',
            orderId: order.id,
          })
          .then((issued) => issued.payment),
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
      const pending = await ctx.container.payments
        .requestManualTransfer(tenantA, systemActor('exp-c'), customerA, {
          idempotencyKey: 'exp-c-request-0001',
          orderId: order.id,
        })
        .then((issued) => issued.payment);
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

      const first = await ctx.container.payments
        .requestManualTransfer(tenantA, systemActor('one-m-1'), customerA, {
          idempotencyKey: 'one-m-request-0001',
          orderId: order.id,
        })
        .then((issued) => issued.payment);
      // A DIFFERENT key: the second tap, not a replay of the first.
      const second = await ctx.container.payments
        .requestManualTransfer(tenantA, systemActor('one-m-2'), customerA, {
          idempotencyKey: 'one-m-request-0002',
          orderId: order.id,
        })
        .then((issued) => issued.payment);

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

  // -------------------------------------------------------------------------
  // Phase 4G — the four outcomes that were declared and unreachable
  // -------------------------------------------------------------------------

  /**
   * The sweep, built here rather than taken off the container.
   *
   * `container.paymentExpiryLoop` resolves its scope from the INSTALLATION's tenant,
   * and this suite drives two tenants deliberately. Constructing the service directly
   * is what lets a test expire tenant A's rows and assert that tenant B's are untouched
   * — which is the isolation claim, and a loop that can only ever see one tenant could
   * not make it.
   */
  const expirySweep = () =>
    new PaymentExpiryService({
      panelSales: ctx.container.panelSales,
      // The username hold's counterpart to the panel slot. Off the container: the
      // lane is stateless and the isolation claim is about tenants, not about it.
      usernames: ctx.container.usernameLane,
      payments: new DrizzlePaymentRepository(ctx.container.database.db),
      orders: new DrizzleOrderRepository(ctx.container.database.db),
      uow: ctx.container.uow,
      audit: ctx.container.audit,
      scopeActivity: ctx.container.tenants,
      clock: ctx.container.clock,
      ids: ctx.container.ids,
      /*
       * The customer notification lane, real rather than stubbed.
       *
       * A stub here would let the sweep's enqueue drift from the lane's constraint
       * without any test noticing, and the enqueue is INSIDE the sweep's transaction —
       * so the thing worth asserting is that an expiry and the notification it owes
       * commit together or not at all.
       */
      notifier: new CustomerNotifier({
        notifications: new DrizzleCustomerNotificationRepository(ctx.container.database.db),
        bots: {
          botFor: async (scope, customerId, tx) =>
            (
              await new DrizzleCustomerRepository(ctx.container.database.db).findById(
                scope,
                customerId,
                tx,
              )
            )?.firstBotInstanceId ?? null,
        },
        ids: ctx.container.ids,
      }),
    });

  const paymentRow = async (
    id: string,
  ): Promise<{
    state: string;
    resolved_at: string | null;
    resolved_by_admin_id: string | null;
    resolution_note: string | null;
  }> => {
    const rows = (await ctx.container.database.db.execute(
      sql`SELECT state, resolved_at, resolved_by_admin_id, resolution_note
            FROM payments WHERE id = ${id}` as never,
    )) as unknown as {
      rows: {
        state: string;
        resolved_at: string | null;
        resolved_by_admin_id: string | null;
        resolution_note: string | null;
      }[];
    };
    const row = rows.rows[0];
    if (row === undefined) throw new Error('payment vanished');
    return row;
  };

  const auditCount = async (action: string): Promise<number> => {
    const rows = (await ctx.container.database.db.execute(
      sql`SELECT count(*)::int AS n FROM audit_logs WHERE action = ${action}` as never,
    )) as unknown as { rows: { n: number }[] };
    return rows.rows[0]?.n ?? 0;
  };

  const pendingTransfer = async (key: string) => {
    const order = await awaitingPayment(tenantA, customerA, panelA, key);
    const payment = await ctx.container.payments
      .requestManualTransfer(tenantA, systemActor(key), customerA, {
        idempotencyKey: `${key}-request-0001`,
        orderId: order.id,
      })
      .then((issued) => issued.payment);
    return { order, payment };
  };

  describe('an operator rejecting a receipt', () => {
    it('records who, when and why, and leaves the order awaiting payment', async () => {
      const { order, payment } = await pendingTransfer('rej-1');

      const rejected = await ctx.container.payments.rejectManualTransfer(
        tenantA,
        owner,
        payment.id,
        { idempotencyKey: 'rej-1-reject-0001', note: 'هیچ واریزی با این کد پیدا نشد' },
      );

      expect(rejected.state).toBe('FAILED');
      const row = await paymentRow(payment.id);
      expect(row.state).toBe('FAILED');
      // All three, because the state alone is what the legacy receipt review records
      // and `UNK-PR-010` is the question that cannot be answered from it.
      expect(row.resolved_at).not.toBeNull();
      expect(row.resolved_by_admin_id).toBe(owner.id);
      expect(row.resolution_note).toBe('هیچ واریزی با این کد پیدا نشد');
      // The confirmation's own columns stay empty: a rejection is not a confirmation
      // with a different label, and `payments_confirmed_check` is what makes that true.
      expect(rejected.confirmedAt).toBeNull();
      expect(rejected.evidenceKind).toBeNull();

      // THE ORDER IS UNTOUCHED. The customer may still pay another way inside their
      // window, which is the whole reason this is not a cancellation.
      expect((await stateOf(order.id)).state).toBe('AWAITING_PAYMENT');
    });

    it('answers a replay with the same payment and writes one audit row', async () => {
      const { payment } = await pendingTransfer('rej-2');
      const input = { idempotencyKey: 'rej-2-reject-0001', note: 'no transfer arrived' };

      const first = await ctx.container.payments.rejectManualTransfer(
        tenantA,
        owner,
        payment.id,
        input,
      );
      const replay = await ctx.container.payments.rejectManualTransfer(
        tenantA,
        owner,
        payment.id,
        input,
      );

      expect(replay.id).toBe(first.id);
      expect(replay.resolvedAt?.toISOString()).toBe(first.resolvedAt?.toISOString());
      expect(await auditCount('payment.reject')).toBe(1);
    });

    it('answers a second operator with the end state rather than an error', async () => {
      const { payment } = await pendingTransfer('rej-3');
      await ctx.container.payments.rejectManualTransfer(tenantA, owner, payment.id, {
        idempotencyKey: 'rej-3-reject-0001',
        note: 'first',
      });

      // A DIFFERENT key and a different note: a second operator pressing reject, not a
      // replay. They get the payment as it stands, and the first reviewer's note is
      // NOT overwritten — 0052 would refuse the write in any case.
      const second = await ctx.container.payments.rejectManualTransfer(tenantA, owner, payment.id, {
        idempotencyKey: 'rej-3-reject-0002',
        note: 'second',
      });
      expect(second.state).toBe('FAILED');
      expect((await paymentRow(payment.id)).resolution_note).toBe('first');
    });

    it('refuses to reject a payment that was confirmed', async () => {
      const { payment } = await pendingTransfer('rej-4');
      await ctx.container.payments.confirmManualTransfer(tenantA, owner, payment.id, {
        idempotencyKey: 'rej-4-confirm-0001',
        note: 'money arrived',
      });

      await expect(
        ctx.container.payments.rejectManualTransfer(tenantA, owner, payment.id, {
          idempotencyKey: 'rej-4-reject-0001',
          note: 'changed my mind',
        }),
      ).rejects.toMatchObject({ code: 'commerce.payment_state_invalid' });
      expect((await paymentRow(payment.id)).state).toBe('CONFIRMED');
    });

    it('is reachable by the seeded receipt_reviewer role, end to end', async () => {
      const { payment } = await pendingTransfer('rej-7');
      const reviewer = adminActorFor(
        await createAdmin(ctx.container, tenantA, {
          username: 'receipt-reviewer-only',
          roleKeys: ['receipt_reviewer'],
        }),
      );

      /*
       * The role named for reviewing receipts, holding nothing else.
       *
       * It could not do this before: `receipt_reviewer` was seeded with `receipts.view`
       * and `receipts.review`, and BOTH the payment read and the Web Admin route that
       * renders the detail charge `payments.view`. So the approve form had been
       * unreachable for it since 4C and the reject form would have shipped the same way
       * — a catalogue promising something the seeded role cannot do.
       *
       * The READ is asserted first and deliberately: the write alone would pass with the
       * old seed, because `rejectManualTransfer` charges `receipts.review`. What was
       * broken is getting to the screen.
       */
      const seen = await ctx.container.payments.get(tenantA, reviewer, payment.id);
      expect(seen.id).toBe(payment.id);

      const rejected = await ctx.container.payments.rejectManualTransfer(
        tenantA,
        reviewer,
        payment.id,
        { idempotencyKey: 'rej-7-reject-0001', note: 'no transfer arrived' },
      );
      expect(rejected.state).toBe('FAILED');
      expect((await paymentRow(payment.id)).resolved_by_admin_id).toBe(reviewer.id);
    });

    it('refuses an operator who does not hold receipts.review', async () => {
      const { payment } = await pendingTransfer('rej-5');
      const observer = adminActorFor(
        await createAdmin(ctx.container, tenantA, {
          username: 'observer-rejects',
          roleKeys: ['observer'],
        }),
      );

      await expect(
        ctx.container.payments.rejectManualTransfer(tenantA, observer, payment.id, {
          idempotencyKey: 'rej-5-reject-0001',
          note: 'not mine to make',
        }),
      ).rejects.toMatchObject({ kind: 'PERMISSION_DENIED' });
      expect((await paymentRow(payment.id)).state).toBe('PENDING');
    });

    it('cannot reach another tenant’s payment', async () => {
      const { payment } = await pendingTransfer('rej-6');
      const ownerB = adminActorFor(
        await createAdmin(ctx.container, tenantB, {
          username: 'owner-other-tenant',
          roleKeys: ['owner'],
        }),
      );

      // NOT_FOUND rather than FORBIDDEN: a distinct refusal answers "does this payment
      // exist" for anybody willing to guess ids.
      await expect(
        ctx.container.payments.rejectManualTransfer(tenantB, ownerB, payment.id, {
          idempotencyKey: 'rej-6-reject-0001',
          note: 'across the boundary',
        }),
      ).rejects.toMatchObject({ code: 'commerce.payment_not_found' });
      expect((await paymentRow(payment.id)).state).toBe('PENDING');
    });
  });

  describe('a wallet payment for an order with an open transfer (WP10 P2)', () => {
    it('withdraws an unsignalled pending transfer and settles from the wallet', async () => {
      const { order, payment } = await pendingTransfer('p2-1');
      await credit(tenantA, customerA, 1_000_000n, 'p2-1-credit');

      const { order: settled } = await settleFromWallet(
        tenantA,
        customerA,
        order.id,
        'p2-1-settle-0001',
      );

      expect(settled.state).toBe('PAID');
      // No orphan left to lapse into a PAYMENT_EXPIRED about an order already paid.
      expect((await paymentRow(payment.id)).state).toBe('CANCELLED');
      expect(await balanceOf(tenantA, customerA)).toMatchObject({ amountMinor: 750_000n });
      const withdrawals = (await ctx.container.database.db.execute(
        sql`SELECT after->>'withdrawnBy' AS by FROM audit_logs
             WHERE action = 'payment.withdraw' AND entity_id = ${payment.id}` as never,
      )) as unknown as { rows: { by: string }[] };
      expect(withdrawals.rows).toEqual([{ by: 'WALLET_SETTLEMENT' }]);
    });

    it('refuses with ORDER_TRANSFER_UNDER_REVIEW while a signalled transfer waits, and debits nothing', async () => {
      const { order, payment } = await pendingTransfer('p2-2');
      await ctx.container.payments.signalTransferSent(tenantA, systemActor('p2-2-s'), customerA, {
        idempotencyKey: 'p2-2-signal-0001',
        paymentId: payment.id,
        botInstanceId: BOT_A,
      });
      await credit(tenantA, customerA, 1_000_000n, 'p2-2-credit');
      const entriesBefore = await countOf('wallet_entries');

      await expect(
        settleFromWallet(tenantA, customerA, order.id, 'p2-2-settle-0001'),
      ).rejects.toMatchObject({ code: COMMERCE_ERROR_CODES.ORDER_TRANSFER_UNDER_REVIEW });

      expect(await countOf('wallet_entries'), 'no debit').toBe(entriesBefore);
      expect(await balanceOf(tenantA, customerA)).toMatchObject({ amountMinor: 1_000_000n });
      expect((await paymentRow(payment.id)).state, 'the claim keeps its payment').toBe('PENDING');
      expect((await stateOf(order.id)).state).toBe('AWAITING_PAYMENT');
      expect(await countOf('payments'), 'no wallet payment row').toBe(1);
    });
  });

  describe('a customer withdrawing a pending transfer', () => {
    it('closes the payment and leaves the order open', async () => {
      const { order, payment } = await pendingTransfer('wd-1');

      const withdrawn = await ctx.container.payments.withdrawPending(
        tenantA,
        systemActor('wd-1'),
        customerA,
        { idempotencyKey: 'wd-1-cancel-0001', paymentId: payment.id },
      );

      expect(withdrawn.state).toBe('CANCELLED');
      const row = await paymentRow(payment.id);
      expect(row.resolved_at).not.toBeNull();
      // No administrator and no note. Nobody reviewed this, and
      // `payments_resolution_reviewer_check` would refuse an admin id here anyway.
      expect(row.resolved_by_admin_id).toBeNull();
      expect(row.resolution_note).toBeNull();
      expect((await stateOf(order.id)).state).toBe('AWAITING_PAYMENT');
    });

    it('lets the customer start a new transfer afterwards', async () => {
      const { order, payment } = await pendingTransfer('wd-2');
      await ctx.container.payments.withdrawPending(tenantA, systemActor('wd-2'), customerA, {
        idempotencyKey: 'wd-2-cancel-0001',
        paymentId: payment.id,
      });

      /*
       * The point of leaving the order open, proved rather than asserted in a comment.
       * `requestManualTransfer` answers a second tap with the PENDING payment already
       * open; once that one is withdrawn there is none, so this issues a new code.
       */
      const second = await ctx.container.payments
        .requestManualTransfer(tenantA, systemActor('wd-2b'), customerA, {
          idempotencyKey: 'wd-2-request-0002',
          orderId: order.id,
        })
        .then((issued) => issued.payment);
      expect(second.id).not.toBe(payment.id);
      expect(second.state).toBe('PENDING');
    });

    it('answers another customer’s payment id as not found', async () => {
      const { payment } = await pendingTransfer('wd-3');
      const otherCustomer = await customer(tenantA, BOT_A, '900701');

      await expect(
        ctx.container.payments.withdrawPending(tenantA, systemActor('wd-3'), otherCustomer, {
          idempotencyKey: 'wd-3-cancel-0001',
          paymentId: payment.id,
        }),
      ).rejects.toMatchObject({ code: 'commerce.payment_not_found' });
      expect((await paymentRow(payment.id)).state).toBe('PENDING');
    });

    it('refuses to withdraw a payment that was already confirmed', async () => {
      const { payment } = await pendingTransfer('wd-4');
      await ctx.container.payments.confirmManualTransfer(tenantA, owner, payment.id, {
        idempotencyKey: 'wd-4-confirm-0001',
        note: 'money arrived',
      });

      await expect(
        ctx.container.payments.withdrawPending(tenantA, systemActor('wd-4'), customerA, {
          idempotencyKey: 'wd-4-cancel-0001',
          paymentId: payment.id,
        }),
      ).rejects.toMatchObject({ code: 'commerce.payment_state_invalid' });
    });
  });

  describe('the expiry sweep', () => {
    /*
     * Two statements, not one with a semicolon: `pg` refuses multiple commands in a
     * prepared statement, and a single `execute` carrying both fails with 42601 rather
     * than backdating anything.
     */
    const backdate = async (paymentId: string, orderId: string): Promise<void> => {
      await ctx.container.database.db.execute(
        sql`UPDATE payments SET expires_at = now() - interval '1 hour' WHERE id = ${paymentId}` as never,
      );
      await ctx.container.database.db.execute(
        sql`UPDATE orders SET expires_at = now() - interval '1 hour' WHERE id = ${orderId}` as never,
      );
    };

    it('expires a stale payment and the order it was against, in one pass', async () => {
      const { order, payment } = await pendingTransfer('sw-1');
      await backdate(payment.id, order.id);

      const report = await expirySweep().runOnce(tenantA);

      // One hold freed per expired order, because these orders went through the real
      // flow and each reserved a name. Before the expiry sweep released them, that
      // name stayed out of circulation for ever — the unique index on
      // `(namespace_key, username)` does not read `expires_at`.
      expect(report).toEqual({ payments: 1, orders: 1, usernameHolds: 1 });
      expect((await paymentRow(payment.id)).state).toBe('EXPIRED');
      expect((await stateOf(order.id)).state).toBe('EXPIRED');
      // An audit row for each, and no operational event: the passage of time is the
      // product working, not a condition an operator has to act on.
      expect(await auditCount('payment.expire')).toBe(1);
      expect(await auditCount('order.expire')).toBe(1);
    });

    it('leaves a payment whose deadline has not passed', async () => {
      const { order, payment } = await pendingTransfer('sw-2');

      const report = await expirySweep().runOnce(tenantA);

      expect(report).toEqual({ payments: 0, orders: 0, usernameHolds: 0 });
      expect((await paymentRow(payment.id)).state).toBe('PENDING');
      expect((await stateOf(order.id)).state).toBe('AWAITING_PAYMENT');
    });

    it('never touches a confirmed payment or the order it settled', async () => {
      const { order, payment } = await pendingTransfer('sw-3');
      await ctx.container.payments.confirmManualTransfer(tenantA, owner, payment.id, {
        idempotencyKey: 'sw-3-confirm-0001',
        note: 'money arrived',
      });
      /*
       * Backdated AFTER the confirmation, so the deadline is genuinely in the past and
       * the only thing standing between this row and the sweep is the state predicate.
       * A test that left the deadline in the future would pass with every predicate
       * removed.
       */
      await backdate(payment.id, order.id);

      const report = await expirySweep().runOnce(tenantA);

      expect(report).toEqual({ payments: 0, orders: 0, usernameHolds: 0 });
      expect((await paymentRow(payment.id)).state).toBe('CONFIRMED');
      expect((await stateOf(order.id)).state).toBe('PAID');
    });

    it('expires one tenant’s rows and not the other’s', async () => {
      const { order: orderA, payment: paymentA } = await pendingTransfer('sw-4');
      const customerB = await customer(tenantB, BOT_B, '900800');
      const orderB = await awaitingPayment(tenantB, customerB, panelB, 'sw-4b');
      const paymentB = await ctx.container.payments
        .requestManualTransfer(tenantB, systemActor('sw-4b'), customerB, {
          idempotencyKey: 'sw-4b-request-0001',
          orderId: orderB.id,
        })
        .then((issued) => issued.payment);
      await backdate(paymentA.id, orderA.id);
      await backdate(paymentB.id, orderB.id);

      // Tenant A's scope only. Both tenants' rows are due; one tenant's sweep must move
      // exactly its own.
      const report = await expirySweep().runOnce(tenantA);

      // One hold freed per expired order, because these orders went through the real
      // flow and each reserved a name. Before the expiry sweep released them, that
      // name stayed out of circulation for ever — the unique index on
      // `(namespace_key, username)` does not read `expires_at`.
      expect(report).toEqual({ payments: 1, orders: 1, usernameHolds: 1 });
      expect((await paymentRow(paymentA.id)).state).toBe('EXPIRED');
      expect((await paymentRow(paymentB.id)).state).toBe('PENDING');
      expect((await stateOf(orderB.id)).state).toBe('AWAITING_PAYMENT');
    });

    it('moves each row once when two passes run concurrently', async () => {
      const { order, payment } = await pendingTransfer('sw-5');
      await backdate(payment.id, order.id);

      /*
       * Two worker replicas, which is the normal case on every rolling update. The
       * claim is not that one pass wins — it is that the TOTAL is one, which is what
       * `FOR UPDATE SKIP LOCKED` plus the state predicate in the UPDATE buys.
       */
      const [first, second] = await Promise.all([
        expirySweep().runOnce(tenantA),
        expirySweep().runOnce(tenantA),
      ]);

      expect(first.payments + second.payments).toBe(1);
      expect(first.orders + second.orders).toBe(1);
      expect(await auditCount('payment.expire')).toBe(1);
      expect(await auditCount('order.expire')).toBe(1);
    });

    it('expires nothing for a tenant that has stopped, and does not call that a failure', async () => {
      const { order, payment } = await pendingTransfer('sw-6');
      await backdate(payment.id, order.id);
      await ctx.container.database.db.execute(
        sql`UPDATE tenants SET status = 'STOPPED' WHERE id = ${tenantA.tenantId}` as never,
      );

      /*
       * A zero report, NOT a throw, and the distinction is the worker's health.
       *
       * `PaymentExpiryLoop` records progress only for a pass that completed, so a pass
       * that threw would take the loop stale in three minutes — and `worker` is in
       * `NEXA_READY_SERVICES`, so `botctl update` would then fail its readiness wait and
       * back the release out after the migration had already run. An operator who
       * stopped a tenant would have caused that, and the error would have named the
       * release.
       */
      const report = await expirySweep().runOnce(tenantA);

      expect(report).toEqual({ payments: 0, orders: 0, usernameHolds: 0 });
      // Nothing decayed while the tenant was stopped; the rows simply wait.
      expect((await paymentRow(payment.id)).state).toBe('PENDING');
      expect((await stateOf(order.id)).state).toBe('AWAITING_PAYMENT');
    });

    it('never expires an order while a payment against it is still pending', async () => {
      const { order, payment } = await pendingTransfer('sw-8');
      await backdate(payment.id, order.id);
      /*
       * The bound, reached without three hundred fixtures.
       *
       * The two halves are separately bounded and separately ordered, so the state this
       * guards against is "the payment half ran out of budget before it reached this
       * row". Expiring the payment out from under the sweep is not possible, so the
       * equivalent is a payment the payment half cannot take: its deadline has not
       * passed, while its order's has.
       *
       * That is the shape a backlog produces, and the outcome the sweep must not have:
       * an order marked EXPIRED while the customer holds live bank instructions for it,
       * against which a transfer could never be confirmed.
       */
      await ctx.container.database.db.execute(
        sql`UPDATE payments SET expires_at = now() + interval '1 hour' WHERE id = ${payment.id}` as never,
      );

      const report = await expirySweep().runOnce(tenantA);

      expect(report).toEqual({ payments: 0, orders: 0, usernameHolds: 0 });
      expect((await stateOf(order.id)).state).toBe('AWAITING_PAYMENT');
      expect((await paymentRow(payment.id)).state).toBe('PENDING');
    });

    it('closes the door on a late confirmation, which is the owner’s rule applied', async () => {
      const { order, payment } = await pendingTransfer('sw-7');
      await backdate(payment.id, order.id);
      await expirySweep().runOnce(tenantA);

      /*
       * `OPERATOR_MAY_CONFIRM_LATE` exempts an operator from the ORDER's deadline, and
       * it still does. What it never did was exempt them from the PAYMENT's state, and
       * once the sweep has closed the payment there is nothing left to confirm. Asserted
       * because it is a real behaviour change: before 4G this confirmation succeeded.
       */
      await expect(
        ctx.container.payments.confirmManualTransfer(tenantA, owner, payment.id, {
          idempotencyKey: 'sw-7-confirm-0001',
          note: 'it arrived, late',
        }),
      ).rejects.toMatchObject({ code: 'commerce.payment_state_invalid' });
      expect((await stateOf(order.id)).state).toBe('EXPIRED');
    });
  });

  describe('the review decision is part of a command\u2019s identity', () => {
    it('will not honour a confirmation under the key a rejection already used', async () => {
      const { order, payment } = await pendingTransfer('key-1');
      const key = 'review-collision-0001';

      await ctx.container.payments.rejectManualTransfer(tenantA, owner, payment.id, {
        idempotencyKey: key,
        note: 'no transfer arrived',
      });

      /*
       * The SAME key and the SAME note, a different command.
       *
       * Both halves of `receipts.review` act in one namespace, and a client deriving its
       * key from the payment — the obvious thing to do — would otherwise be answered
       * from the rejection's own record: HTTP 200, no state change, no audit row, and a
       * caller told the order settled when it did not. The store's payload guard cannot
       * see it, because the payload really is identical; only the decision differs, so
       * the decision is in the hash.
       */
      await expect(
        ctx.container.payments.confirmManualTransfer(tenantA, owner, payment.id, {
          idempotencyKey: key,
          note: 'no transfer arrived',
        }),
      ).rejects.toMatchObject({ code: 'platform.idempotency_payload_mismatch' });

      expect((await paymentRow(payment.id)).state).toBe('FAILED');
      expect((await stateOf(order.id)).state).toBe('AWAITING_PAYMENT');
    });
  });

  describe('a window too short to pay in', () => {
    it('refuses to issue bank instructions that would die before the customer acts', async () => {
      const order = await awaitingPayment(tenantA, customerA, panelA, 'short-1');
      // Half a minute left. The customer passes the order's own deadline check and
      // would be handed a reference the sweep closes within the minute.
      await ctx.container.database.db.execute(
        sql`UPDATE orders SET expires_at = now() + interval '30 seconds' WHERE id = ${order.id}` as never,
      );

      await expect(
        ctx.container.payments
          .requestManualTransfer(tenantA, systemActor('short-1'), customerA, {
            idempotencyKey: 'short-1-request-0001',
            orderId: order.id,
          })
          .then((issued) => issued.payment),
      ).rejects.toMatchObject({ code: 'commerce.payment_window_too_short' });

      expect(await countOf('payments')).toBe(0);
    });

    it('closes a stale reference instead of handing it back, and issues a live one', async () => {
      const { order, payment } = await pendingTransfer('stale-1');
      /*
       * The window between a payment's own deadline and the sweep reaching it. The row
       * still reads PENDING and is already dead; before this fix the reissue path
       * exempted every existing payment from the deadline check and handed it straight
       * back, so the customer got bank instructions for a reference that becomes
       * permanently unconfirmable the moment the sweep catches up.
       */
      await ctx.container.database.db.execute(
        sql`UPDATE payments SET expires_at = now() - interval '1 minute' WHERE id = ${payment.id}` as never,
      );

      const fresh = await ctx.container.payments
        .requestManualTransfer(tenantA, systemActor('stale-1b'), customerA, {
          idempotencyKey: 'stale-1-request-0002',
          orderId: order.id,
        })
        .then((issued) => issued.payment);

      expect(fresh.id).not.toBe(payment.id);
      expect(fresh.state).toBe('PENDING');
      // The stale one is closed rather than left behind: two PENDING transfers for one
      // order is the state `requestManualTransfer` exists to prevent.
      expect((await paymentRow(payment.id)).state).toBe('EXPIRED');
      expect(await auditCount('payment.expire')).toBe(1);
    });

    it('refuses rather than reissuing when the order itself has no window left', async () => {
      const { order, payment } = await pendingTransfer('stale-2');
      await ctx.container.database.db.execute(
        sql`UPDATE payments SET expires_at = now() - interval '1 minute' WHERE id = ${payment.id}` as never,
      );
      // There is not enough ORDER left to mint a new reference against, so the customer
      // is told rather than handed a second dead code. The two rules compose: closing
      // the stale one does not skip the floor, and the floor does not skip the close.
      await ctx.container.database.db.execute(
        sql`UPDATE orders SET expires_at = now() + interval '30 seconds' WHERE id = ${order.id}` as never,
      );

      await expect(
        ctx.container.payments
          .requestManualTransfer(tenantA, systemActor('stale-2b'), customerA, {
            idempotencyKey: 'stale-2-request-0002',
            orderId: order.id,
          })
          .then((issued) => issued.payment),
      ).rejects.toMatchObject({ code: 'commerce.payment_window_too_short' });

      /*
       * The stale payment is still PENDING, and that is correct rather than a gap: the
       * refusal throws, so the whole transaction rolls back and the inline close goes
       * with it. A refused command leaves NOTHING behind — no half-closed payment, no
       * audit row for a decision nobody made — and the sweep closes the row on its next
       * pass regardless. Asserted rather than assumed, because the tempting "fix" is to
       * commit the close before refusing, which would make a refusal a partial write.
       */
      expect((await paymentRow(payment.id)).state).toBe('PENDING');
      expect(await auditCount('payment.expire')).toBe(0);
    });

    it('still answers a customer who already holds a reference for that order', async () => {
      const { order, payment } = await pendingTransfer('short-2');
      // The window closes in on them AFTER they were given the code.
      await ctx.container.database.db.execute(
        sql`UPDATE orders SET expires_at = now() + interval '30 seconds' WHERE id = ${order.id}` as never,
      );

      /*
       * Refusing here would take away the instruction the customer is looking at, which
       * is strictly worse than letting a short window run out. The refusal is on the
       * CREATE path only.
       */
      const again = await ctx.container.payments
        .requestManualTransfer(tenantA, systemActor('short-2b'), customerA, {
          idempotencyKey: 'short-2-request-0002',
          orderId: order.id,
        })
        .then((issued) => issued.payment);
      expect(again.id).toBe(payment.id);
      expect(again.reference).toBe(payment.reference);
    });
  });

  describe('a resolved payment stays resolved', () => {
    it('refuses a raw UPDATE that would reopen a rejected payment', async () => {
      const { payment } = await pendingTransfer('frz-1');
      await ctx.container.payments.rejectManualTransfer(tenantA, owner, payment.id, {
        idempotencyKey: 'frz-1-reject-0001',
        note: 'no transfer arrived',
      });

      /*
       * The write an OLD BINARY could make. `botctl rollback` never restores the
       * database, so the guard in the schema is the only one a rolled-back image cannot
       * be missing — migration 0052's whole argument, exercised.
       *
       * The driver wraps the error, so the trigger's own message is on `cause`.
       */
      await expect(
        ctx.container.database.db.execute(
          sql`UPDATE payments SET state = 'PENDING' WHERE id = ${payment.id}` as never,
        ),
      ).rejects.toMatchObject({
        cause: { message: expect.stringContaining('cannot be reopened') },
      });
      expect((await paymentRow(payment.id)).state).toBe('FAILED');
    });

    it('refuses a raw UPDATE that would stamp a confirmation time on a rejection', async () => {
      const { payment } = await pendingTransfer('frz-5');
      await ctx.container.payments.rejectManualTransfer(tenantA, owner, payment.id, {
        idempotencyKey: 'frz-5-reject-0001',
        note: 'no transfer arrived',
      });

      /*
       * The column 0053 missed and 0054 closed. `payments_confirmed_check` cannot catch
       * it either: with `evidence_kind` still NULL, the right-hand side of that equality
       * stays false for a resolved row however the timestamp moves — leaving a rejected
       * payment reading as though somebody confirmed it at a moment somebody chose.
       */
      await expect(
        ctx.container.database.db.execute(
          sql`UPDATE payments SET confirmed_at = now() WHERE id = ${payment.id}` as never,
        ),
      ).rejects.toMatchObject({
        cause: { message: expect.stringContaining('cannot be reopened') },
      });
      expect((await paymentRow(payment.id)).state).toBe('FAILED');
    });

    it('refuses a raw UPDATE that would dress a rejection up as a review', async () => {
      const { payment } = await pendingTransfer('frz-4');
      await ctx.container.payments.rejectManualTransfer(tenantA, owner, payment.id, {
        idempotencyKey: 'frz-4-reject-0001',
        note: 'no transfer arrived',
      });

      /*
       * The three columns 0052 left writable, closed by 0053.
       *
       * `payments_confirmed_check` does not catch this: it is an equality between
       * `state = 'CONFIRMED'` and `confirmed_at IS NOT NULL AND evidence_kind IS NOT
       * NULL`, so setting `evidence_kind` ALONE on a resolved row leaves both sides
       * false and satisfies it — while the row acquires the appearance of a review that
       * never happened. A rejected payment reading `OPERATOR_REVIEW` is what an operator
       * would read as an approval.
       */
      await expect(
        ctx.container.database.db.execute(
          sql`UPDATE payments SET evidence_kind = 'OPERATOR_REVIEW' WHERE id = ${payment.id}` as never,
        ),
      ).rejects.toMatchObject({
        cause: { message: expect.stringContaining('cannot be reopened') },
      });
      expect((await paymentRow(payment.id)).state).toBe('FAILED');
    });

    it('refuses an administrator on a withdrawal, at the schema', async () => {
      const { payment } = await pendingTransfer('frz-3');

      /*
       * `payments_resolution_reviewer_check` in isolation, which needs a PENDING row.
       *
       * On an already-resolved payment 0052's trigger fires first and raises before any
       * CHECK is evaluated, so a test written that way proves the trigger twice and the
       * constraint never. Moving a PENDING row straight to CANCELLED with an admin id
       * is the one statement that reaches the constraint: the trigger's resolved-state
       * branch does not apply, and the check does.
       *
       * The rule it holds: nobody decides a withdrawal — the customer performs it — so
       * an operator id on one would answer "who decided this" with somebody who did not.
       * `withdrawPending` passes null, and this is the half that stays true if a later
       * edit to that file does not.
       */
      await expect(
        ctx.container.database.db.execute(
          sql`UPDATE payments
                 SET state = 'CANCELLED', resolved_at = now(), resolved_by_admin_id = ${owner.id}
               WHERE id = ${payment.id}` as never,
        ),
      ).rejects.toMatchObject({
        cause: { constraint: 'payments_resolution_reviewer_check' },
      });
      expect((await paymentRow(payment.id)).state).toBe('PENDING');
    });

    it('refuses a raw UPDATE that would rewrite why it was rejected', async () => {
      const { payment } = await pendingTransfer('frz-2');
      await ctx.container.payments.rejectManualTransfer(tenantA, owner, payment.id, {
        idempotencyKey: 'frz-2-reject-0001',
        note: 'no transfer arrived',
      });

      await expect(
        ctx.container.database.db.execute(
          sql`UPDATE payments SET resolution_note = 'something else' WHERE id = ${payment.id}` as never,
        ),
      ).rejects.toMatchObject({
        cause: { message: expect.stringContaining('immutable') },
      });
      expect((await paymentRow(payment.id)).resolution_note).toBe('no transfer arrived');
    });
  });

  describe('the payment window', () => {
    it('holds a transfer open for the configured window, not the order’s', async () => {
      const order = await awaitingPayment(tenantA, customerA, panelA, 'win-1');
      // The order's own window at its ceiling: fourteen days. Before 4G the payment
      // inherited it, so bank instructions stayed live for a fortnight.
      await ctx.container.database.db.execute(
        sql`UPDATE orders SET expires_at = now() + interval '14 days' WHERE id = ${order.id}` as never,
      );

      const payment = await ctx.container.payments
        .requestManualTransfer(tenantA, systemActor('win-1'), customerA, {
          idempotencyKey: 'win-1-request-0001',
          orderId: order.id,
        })
        .then((issued) => issued.payment);

      // The default window is the owner's ceiling, sixty minutes. Two hours is the
      // slack that keeps this from being a clock-skew test rather than a rule test.
      const held = (payment.expiresAt?.getTime() ?? 0) - ctx.container.clock.now().getTime();
      expect(held).toBeGreaterThan(0);
      expect(held).toBeLessThan(2 * 3_600_000);
    });

    it('never outlives the order it names', async () => {
      const order = await awaitingPayment(tenantA, customerA, panelA, 'win-2');
      // An order with only ten minutes left. The payment takes the EARLIER of the two,
      // so it must not be handed a fresh hour past the order's own death.
      await ctx.container.database.db.execute(
        sql`UPDATE orders SET expires_at = now() + interval '10 minutes' WHERE id = ${order.id}` as never,
      );

      const payment = await ctx.container.payments
        .requestManualTransfer(tenantA, systemActor('win-2'), customerA, {
          idempotencyKey: 'win-2-request-0001',
          orderId: order.id,
        })
        .then((issued) => issued.payment);

      const orderRow = await ctx.container.orders.get(tenantA, owner, order.id);
      expect(payment.expiresAt?.getTime()).toBe(orderRow.expiresAt?.getTime());
    });
  });
  // -------------------------------------------------------------------------
  // A route an operator switched off stops ORDER payments too (FBR-002)
  // -------------------------------------------------------------------------

  /**
   * The enable/disable toggle has to switch something off, and before this it half did.
   *
   * `FBR-002` records it as deciding "whether customers can pay through that route at
   * all". 5C bound it to the wallet top-up path and nowhere else, so an operator could
   * disable MANUAL_TRANSFER on the Payment Gateways screen and watch order payments keep
   * arriving through it — a control that does not do what it says, which is the
   * write-only-setting class of defect with money attached.
   *
   * STATUS only. The route's amount bounds and eligibility thresholds are `OQ-5C-01`, an
   * open product decision, and these cases are written to pass whichever way it goes:
   * the route keeps its default bounds and no thresholds, so the only thing that varies
   * is whether it is ACTIVE.
   */
  const disableManualRoute = () =>
    ctx.container.database.db.execute(
      sql`UPDATE payment_gateways SET status = 'DISABLED'
           WHERE tenant_id = ${tenantA.tenantId} AND provider = 'MANUAL_TRANSFER'`,
    );

  it('refuses to issue an order transfer through a route that is switched off', async () => {
    const order = await awaitingPayment(tenantA, customerA, panelA, 'gwoff1');
    await disableManualRoute();

    await expect(
      ctx.container.payments.requestManualTransfer(tenantA, systemActor('gwoff1'), customerA, {
        idempotencyKey: 'gwoff1-manual-0001',
        orderId: order.id,
      }),
    ).rejects.toMatchObject({ code: 'commerce.payment_method_unavailable' });

    // Nothing issued, so there is no reference a customer could act on.
    expect(await countOf('payments')).toBe(0);
    expect((await stateOf(order.id)).state).toBe('AWAITING_PAYMENT');
  });

  it('issues one again once the operator switches the route back on', async () => {
    const order = await awaitingPayment(tenantA, customerA, panelA, 'gwoff2');
    await disableManualRoute();
    await ctx.container.database.db.execute(
      sql`UPDATE payment_gateways SET status = 'ACTIVE'
           WHERE tenant_id = ${tenantA.tenantId} AND provider = 'MANUAL_TRANSFER'`,
    );

    const { payment } = await ctx.container.payments.requestManualTransfer(
      tenantA,
      systemActor('gwoff2'),
      customerA,
      { idempotencyKey: 'gwoff2-manual-0001', orderId: order.id },
    );
    expect(payment.state).toBe('PENDING');
    expect(payment.method).toBe('MANUAL_TRANSFER');
  });

  it('still answers a reference the customer was already given', async () => {
    /*
     * The refusal is on the CREATE path only, beside the destination check and for the
     * same reason: a customer who holds a reference may already have sent the money, and
     * answering them "not available" would strand a transfer that is in flight.
     */
    const order = await awaitingPayment(tenantA, customerA, panelA, 'gwoff3');
    const { payment } = await ctx.container.payments.requestManualTransfer(
      tenantA,
      systemActor('gwoff3'),
      customerA,
      { idempotencyKey: 'gwoff3-manual-0001', orderId: order.id },
    );
    await disableManualRoute();

    const again = await ctx.container.payments.requestManualTransfer(
      tenantA,
      systemActor('gwoff3'),
      customerA,
      { idempotencyKey: 'gwoff3-manual-0001', orderId: order.id },
    );
    expect(again.payment.id).toBe(payment.id);
    expect(again.payment.state).toBe('PENDING');
  });

  it('leaves the wallet rail alone, because a wallet is not a route', async () => {
    // `WALLET` settles from the customer's own balance and no `payment_gateways` row
    // describes it, so switching every route off must not stop a wallet purchase.
    const order = await awaitingPayment(tenantA, customerA, panelA, 'gwoff4');
    await credit(tenantA, customerA, 1_000_000n, 'gwoff4-credit');
    await disableManualRoute();

    const { payment } = await settleFromWallet(tenantA, customerA, order.id, 'gwoff4-settle-0001');
    expect(payment.state).toBe('CONFIRMED');
    expect(payment.method).toBe('WALLET');
  });
});
