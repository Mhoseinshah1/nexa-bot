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
import type { ProductDraft } from '../../apps/api/src/modules/commerce/catalog/application/ports';
import type { OrderRecord } from '../../apps/api/src/modules/commerce/orders/application/ports';
import { DrizzlePaymentRepository } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-payment.repository';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  makePanelSellable,
  SEED_IDS,
  tenantA,
  tenantB,
  type TestContext,
} from './harness';

/**
 * The two things a customer could not do to their own unpaid order, and the one
 * combination of them that must never be performed.
 *
 * `docs/phase4h-audit.md` §3 and §4 measured both gaps. The bot handed out bank details
 * and a reference and then went silent in both directions: no way for the customer to
 * say they had transferred the money, and `ORDER_MACHINE`'s CANCEL edge — made WRITABLE
 * by 4G — with no caller at all, so `bot.order.cancelled` was a frozen sentence with
 * nowhere to be sent from.
 *
 * What every case here is really about is the boundary between a CLAIM and EVIDENCE.
 * The customer's "I have sent it" is a claim; it changes one timestamp an operator can
 * see and nothing about the money. `PRBR-004` records the legacy system collapsing the
 * two — "receipt" and "payment" naming one record — and every rule below is a way of
 * keeping them apart under concurrency.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const BOT_B = SEED_IDS.botB1 as BotInstanceId;

/** The actor a customer-initiated command runs as. Holds `maintenance.run` only. */
const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

describe('a customer acting on their own order', () => {
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
    customerA = await customer(tenantA, BOT_A, '910100');
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'owner-customer-actions',
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

  async function awaitingPayment(
    scope: typeof tenantA,
    customerId: UserId,
    panelId: string,
    key: string,
  ): Promise<OrderRecord> {
    const created = await products.create(scope, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: draft(panelId),
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

  const transferFor = (scope: typeof tenantA, customerId: UserId, orderId: string, key: string) =>
    ctx.container.payments
      .requestManualTransfer(scope, systemActor(key), customerId, {
        idempotencyKey: key,
        orderId,
      })
      .then((issued) => issued.payment);

  const paymentRow = async (
    id: string,
  ): Promise<{
    state: string;
    customer_signalled_at: string | null;
    resolved_at: string | null;
  }> => {
    const rows = (await ctx.container.database.db.execute(
      sql`SELECT state, customer_signalled_at, resolved_at FROM payments WHERE id = ${id}` as never,
    )) as unknown as {
      rows: { state: string; customer_signalled_at: string | null; resolved_at: string | null }[];
    };
    const row = rows.rows[0];
    if (row === undefined) throw new Error('payment vanished');
    return row;
  };

  const orderRow = async (id: string): Promise<{ state: string; cancelled_at: string | null }> => {
    const rows = (await ctx.container.database.db.execute(
      sql`SELECT state, cancelled_at FROM orders WHERE id = ${id}` as never,
    )) as unknown as { rows: { state: string; cancelled_at: string | null }[] };
    const row = rows.rows[0];
    if (row === undefined) throw new Error('order vanished');
    return row;
  };

  const auditActions = async (entityId: string): Promise<string[]> => {
    const rows = (await ctx.container.database.db.execute(
      sql`SELECT action FROM audit_logs WHERE entity_id = ${entityId} ORDER BY occurred_at ASC, id ASC` as never,
    )) as unknown as { rows: { action: string }[] };
    return rows.rows.map((r) => r.action);
  };

  // -------------------------------------------------------------------------
  // "I have sent it"
  // -------------------------------------------------------------------------

  it('records the claim without moving the payment', async () => {
    const order = await awaitingPayment(tenantA, customerA, panelA, 'signal-1');
    const payment = await transferFor(tenantA, customerA, order.id, 'signal-1-pay');

    const after = await ctx.container.payments.signalTransferSent(
      tenantA,
      systemActor('signal-1-say'),
      customerA,
      { idempotencyKey: 'signal-1-say', paymentId: payment.id, botInstanceId: BOT_A },
    );

    /*
     * The state did NOT move, and that is the assertion this whole slice rests on. A
     * claim is not evidence: `PAYMENT_MACHINE` takes no edge, the evidence kind stays
     * null, and an operator with `receipts.review` still has to confirm it.
     */
    expect(after.payment.state).toBe('PENDING');
    expect(after.payment.evidenceKind).toBeNull();
    expect(after.payment.customerSignalledAt).not.toBeNull();
    /*
     * And the tap opened the upload window, which is the other half of what the
     * combined button promises. `minutes` is what the reply tells the customer, so it
     * must be a real number of minutes rather than zero.
     */
    expect(after.receiptWindow).not.toBeNull();
    expect(after.receiptWindow?.minutes).toBeGreaterThan(0);

    const row = await paymentRow(payment.id);
    expect(row.state).toBe('PENDING');
    expect(row.resolved_at).toBeNull();
    expect(row.customer_signalled_at).not.toBeNull();
  });

  it('keeps the FIRST claim when the customer taps again', async () => {
    /*
     * The moment an operator compares against their bank statement must not move. Two
     * distinct idempotency keys, so this is a genuine second command rather than a
     * replay the store short-circuits.
     */
    const order = await awaitingPayment(tenantA, customerA, panelA, 'signal-2');
    const payment = await transferFor(tenantA, customerA, order.id, 'signal-2-pay');

    const first = await ctx.container.payments.signalTransferSent(
      tenantA,
      systemActor('signal-2-a'),
      customerA,
      { idempotencyKey: 'signal-2-a', paymentId: payment.id, botInstanceId: BOT_A },
    );
    const second = await ctx.container.payments.signalTransferSent(
      tenantA,
      systemActor('signal-2-b'),
      customerA,
      { idempotencyKey: 'signal-2-b', paymentId: payment.id, botInstanceId: BOT_A },
    );

    expect(second.payment.customerSignalledAt?.toISOString()).toBe(
      first.payment.customerSignalledAt?.toISOString(),
    );
    /*
     * The second tap gets a window too, and the FIRST one is superseded rather than
     * left open: a customer tapping again is a customer who wants to send the receipt,
     * and `receipt_captures_open_key` allows only one open row per customer per bot.
     */
    expect(second.receiptWindow).not.toBeNull();
    /* And the audit log grew ONE claim row, not one per tap. */
    const signals = (await auditActions(payment.id)).filter((a) => a === 'payment.signal_sent');
    expect(signals).toHaveLength(1);
  });

  it('refuses a claim about a payment that has already ended', async () => {
    const order = await awaitingPayment(tenantA, customerA, panelA, 'signal-3');
    const payment = await transferFor(tenantA, customerA, order.id, 'signal-3-pay');
    await ctx.container.payments.withdrawPending(tenantA, systemActor('signal-3-x'), customerA, {
      idempotencyKey: 'signal-3-x',
      paymentId: payment.id,
    });

    await expect(
      ctx.container.payments.signalTransferSent(tenantA, systemActor('signal-3-s'), customerA, {
        idempotencyKey: 'signal-3-s',
        paymentId: payment.id,
        botInstanceId: BOT_A,
      }),
    ).rejects.toMatchObject({ code: 'commerce.payment_state_invalid' });

    expect((await paymentRow(payment.id)).customer_signalled_at).toBeNull();
  });

  it("answers a claim about somebody else's payment as unknown", async () => {
    /*
     * The same sentence an id that does not exist gets. A distinct refusal for "not
     * yours" is an oracle for anybody willing to guess, and a payment id travels in a
     * screenshot.
     */
    const other = await customer(tenantA, BOT_A, '910101');
    const order = await awaitingPayment(tenantA, other, panelA, 'signal-4');
    const payment = await transferFor(tenantA, other, order.id, 'signal-4-pay');

    await expect(
      ctx.container.payments.signalTransferSent(tenantA, systemActor('signal-4-s'), customerA, {
        idempotencyKey: 'signal-4-s',
        paymentId: payment.id,
        botInstanceId: BOT_A,
      }),
    ).rejects.toMatchObject({ code: 'commerce.payment_not_found' });

    expect((await paymentRow(payment.id)).customer_signalled_at).toBeNull();
  });

  it('answers a claim from another tenant as unknown', async () => {
    const order = await awaitingPayment(tenantA, customerA, panelA, 'signal-5');
    const payment = await transferFor(tenantA, customerA, order.id, 'signal-5-pay');
    const outsider = await customer(tenantB, BOT_B, '910102');

    await expect(
      ctx.container.payments.signalTransferSent(tenantB, systemActor('signal-5-s'), outsider, {
        idempotencyKey: 'signal-5-s',
        paymentId: payment.id,
        botInstanceId: BOT_A,
      }),
    ).rejects.toMatchObject({ code: 'commerce.payment_not_found' });

    expect((await paymentRow(payment.id)).customer_signalled_at).toBeNull();
  });

  it('cannot be stamped onto a payment that is already over, even below the service', async () => {
    /*
     * The schema's own guard (migration 0058), reached directly rather than through the
     * service. `botctl rollback` never restores the database, so an installation rolled
     * back to yesterday's image keeps today's rows and the binary writing them predates
     * the application rule. This is the guard an old binary cannot be missing.
     */
    const order = await awaitingPayment(tenantA, customerA, panelA, 'signal-6');
    const payment = await transferFor(tenantA, customerA, order.id, 'signal-6-pay');
    await ctx.container.payments.withdrawPending(tenantA, systemActor('signal-6-x'), customerA, {
      idempotencyKey: 'signal-6-x',
      paymentId: payment.id,
    });

    /*
     * Drizzle wraps the driver error, so the guard's own sentence is on `cause`.
     * Asserted against that rather than against "it threw": a NOT NULL violation or a
     * missing column would also throw, and neither would prove the trigger fired.
     */
    const failure = await ctx.container.database.db
      .execute(
        sql`UPDATE payments SET customer_signalled_at = now() WHERE id = ${payment.id}` as never,
      )
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failure).not.toBeNull();
    expect(String((failure as { cause?: unknown }).cause)).toMatch(/cannot be reopened/u);
  });

  it('refuses a claim stamped onto a payment that is not an out-of-band transfer', async () => {
    /*
     * `payments_customer_signal_check`. A wallet settlement commits its debit in the
     * same transaction and a gateway is reached over the wire; in neither case is there
     * anything for a customer to assert that this installation does not already know.
     *
     * Reached by moving a live PENDING transfer's METHOD, because a wallet payment is
     * never PENDING — it is CONFIRMED in the transaction that creates it — and a
     * CONFIRMED row is stopped one layer earlier, by the freeze guard, which is the
     * case below. Both layers are asserted because they refuse for different reasons.
     */
    const order = await awaitingPayment(tenantA, customerA, panelA, 'signal-7');
    const payment = await transferFor(tenantA, customerA, order.id, 'signal-7-pay');

    const failure = await ctx.container.database.db
      .execute(
        sql`UPDATE payments SET method = 'WALLET', customer_signalled_at = now()
              WHERE id = ${payment.id}` as never,
      )
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failure).not.toBeNull();
    expect(String((failure as { cause?: unknown }).cause)).toMatch(
      /payments_customer_signal_check/u,
    );
  });

  it('refuses the stamp at the REPOSITORY when the payment has ended', async () => {
    /*
     * The repository's own `state = 'PENDING'` predicate, reached directly.
     *
     * Through the service this rule is unreachable — `signalTransferSent` refuses a
     * non-PENDING payment first — so mutating it away left the whole file green. A rule
     * no test can distinguish is a rule that gets silently reverted, and this one is
     * worth keeping: it is what makes `signalSent`'s `false` mean "nothing to record"
     * rather than "the caller checked", and the next caller may not check.
     */
    const order = await awaitingPayment(tenantA, customerA, panelA, 'signal-9');
    const payment = await transferFor(tenantA, customerA, order.id, 'signal-9-pay');
    await ctx.container.payments.withdrawPending(tenantA, systemActor('signal-9-x'), customerA, {
      idempotencyKey: 'signal-9-x',
      paymentId: payment.id,
    });

    const repository = new DrizzlePaymentRepository(ctx.container.database.db);
    await expect(
      repository.signalSent(tenantA, payment.id, ctx.container.clock.now()),
    ).resolves.toBe(false);
    expect((await paymentRow(payment.id)).customer_signalled_at).toBeNull();
  });

  it('cannot acquire a claim after an operator has confirmed it', async () => {
    /*
     * The CONFIRMED branch of the freeze guard, which 0058 extended to cover this
     * column. A claim appearing after the approval would read as though the approval
     * preceded the claim it rests on, and an operator reading the row later could not
     * tell that from a claim made while the payment was live.
     */
    await ctx.container.wallet.adjust(tenantA, owner, customerA, {
      idempotencyKey: 'signal-8-credit',
      direction: 'CREDIT',
      amountMinor: 500_000n,
      currency: 'IRT',
      note: 'fixture',
    });
    const order = await awaitingPayment(tenantA, customerA, panelA, 'signal-8');
    const { payment } = await ctx.container.payments.settleFromWallet(
      tenantA,
      systemActor('signal-8-pay'),
      customerA,
      { idempotencyKey: 'signal-8-pay', orderId: order.id },
    );

    const failure = await ctx.container.database.db
      .execute(
        sql`UPDATE payments SET customer_signalled_at = now() WHERE id = ${payment.id}` as never,
      )
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failure).not.toBeNull();
    expect(String((failure as { cause?: unknown }).cause)).toMatch(/what the customer claimed/u);
  });

  // -------------------------------------------------------------------------
  // Cancelling the order
  // -------------------------------------------------------------------------

  it('cancels an unpaid order and stamps the moment', async () => {
    const order = await awaitingPayment(tenantA, customerA, panelA, 'cancel-1');

    const after = await ctx.container.orders.cancelByCustomer(tenantA, systemActor('cancel-1-do'), {
      idempotencyKey: 'cancel-1-do',
      customerId: customerA,
      orderId: order.id,
    });

    expect(after.state).toBe('CANCELLED');
    const row = await orderRow(order.id);
    expect(row.state).toBe('CANCELLED');
    /* `orders_cancelled_at_check` — the state and the stamp travel together or neither. */
    expect(row.cancelled_at).not.toBeNull();
  });

  it('closes the live transfer instruction with the order', async () => {
    /*
     * The half-state `PaymentExpiryService`'s docblock names as the dangerous one: an
     * order that no longer exists with a live instruction to send money for it. Both
     * halves are in ONE transaction, so there is no window in which one holds.
     */
    const order = await awaitingPayment(tenantA, customerA, panelA, 'cancel-2');
    const payment = await transferFor(tenantA, customerA, order.id, 'cancel-2-pay');

    await ctx.container.orders.cancelByCustomer(tenantA, systemActor('cancel-2-do'), {
      idempotencyKey: 'cancel-2-do',
      customerId: customerA,
      orderId: order.id,
    });

    const row = await paymentRow(payment.id);
    expect(row.state).toBe('CANCELLED');
    expect(row.resolved_at).not.toBeNull();
  });

  it('refuses to cancel once the customer has said they paid', async () => {
    /*
     * The one combination 4H must not perform. The claim says money may be in flight,
     * and there is no version of cancelling that is safe once it is: the transfer
     * arrives against a reference belonging to a closed payment on a cancelled order.
     */
    const order = await awaitingPayment(tenantA, customerA, panelA, 'cancel-3');
    const payment = await transferFor(tenantA, customerA, order.id, 'cancel-3-pay');
    await ctx.container.payments.signalTransferSent(tenantA, systemActor('cancel-3-s'), customerA, {
      idempotencyKey: 'cancel-3-s',
      paymentId: payment.id,
      botInstanceId: BOT_A,
    });

    await expect(
      ctx.container.orders.cancelByCustomer(tenantA, systemActor('cancel-3-do'), {
        idempotencyKey: 'cancel-3-do',
        customerId: customerA,
        orderId: order.id,
      }),
    ).rejects.toMatchObject({ code: 'commerce.order_transfer_under_review' });

    /* Neither half moved. The refusal is before any write. */
    expect((await orderRow(order.id)).state).toBe('AWAITING_PAYMENT');
    expect((await paymentRow(payment.id)).state).toBe('PENDING');
  });

  it('allows the cancellation again once the claimed payment is resolved', async () => {
    /*
     * The refusal is about a PENDING claim, not about the claim having ever been made.
     * An operator who rejected the transfer has answered the question the refusal was
     * waiting for, and the customer is not locked out of their own order for ever.
     */
    const order = await awaitingPayment(tenantA, customerA, panelA, 'cancel-4');
    const payment = await transferFor(tenantA, customerA, order.id, 'cancel-4-pay');
    await ctx.container.payments.signalTransferSent(tenantA, systemActor('cancel-4-s'), customerA, {
      idempotencyKey: 'cancel-4-s',
      paymentId: payment.id,
      botInstanceId: BOT_A,
    });
    await ctx.container.payments.rejectManualTransfer(tenantA, owner, payment.id, {
      idempotencyKey: 'cancel-4-reject',
      note: 'no transfer found',
    });

    const after = await ctx.container.orders.cancelByCustomer(tenantA, systemActor('cancel-4-do'), {
      idempotencyKey: 'cancel-4-do',
      customerId: customerA,
      orderId: order.id,
    });
    expect(after.state).toBe('CANCELLED');
  });

  it('treats a second cancellation as the end state it asked for', async () => {
    const order = await awaitingPayment(tenantA, customerA, panelA, 'cancel-5');
    await ctx.container.orders.cancelByCustomer(tenantA, systemActor('cancel-5-a'), {
      idempotencyKey: 'cancel-5-a',
      customerId: customerA,
      orderId: order.id,
    });

    /* A different key, so this is a genuine second command and not a replay. */
    const again = await ctx.container.orders.cancelByCustomer(tenantA, systemActor('cancel-5-b'), {
      idempotencyKey: 'cancel-5-b',
      customerId: customerA,
      orderId: order.id,
    });
    expect(again.state).toBe('CANCELLED');
    /* One cancellation in the log, not two. */
    expect((await auditActions(order.id)).filter((a) => a === 'order.cancel')).toHaveLength(1);
  });

  it('refuses to cancel an order that has been paid', async () => {
    await ctx.container.wallet.adjust(tenantA, owner, customerA, {
      idempotencyKey: 'cancel-6-credit',
      direction: 'CREDIT',
      amountMinor: 500_000n,
      currency: 'IRT',
      note: 'fixture',
    });
    const order = await awaitingPayment(tenantA, customerA, panelA, 'cancel-6');
    await ctx.container.payments.settleFromWallet(tenantA, systemActor('cancel-6-pay'), customerA, {
      idempotencyKey: 'cancel-6-pay',
      orderId: order.id,
    });

    await expect(
      ctx.container.orders.cancelByCustomer(tenantA, systemActor('cancel-6-do'), {
        idempotencyKey: 'cancel-6-do',
        customerId: customerA,
        orderId: order.id,
      }),
    ).rejects.toMatchObject({ code: 'commerce.order_state_invalid' });
    expect((await orderRow(order.id)).state).toBe('PAID');
  });

  it("answers a cancellation of somebody else's order as unknown", async () => {
    const other = await customer(tenantA, BOT_A, '910103');
    const order = await awaitingPayment(tenantA, other, panelA, 'cancel-7');

    await expect(
      ctx.container.orders.cancelByCustomer(tenantA, systemActor('cancel-7-do'), {
        idempotencyKey: 'cancel-7-do',
        customerId: customerA,
        orderId: order.id,
      }),
    ).rejects.toMatchObject({ code: 'commerce.order_not_found' });
    expect((await orderRow(order.id)).state).toBe('AWAITING_PAYMENT');
  });

  it('answers a cancellation from another tenant as unknown', async () => {
    const order = await awaitingPayment(tenantA, customerA, panelA, 'cancel-8');
    const outsider = await customer(tenantB, BOT_B, '910104');

    await expect(
      ctx.container.orders.cancelByCustomer(tenantB, systemActor('cancel-8-do'), {
        idempotencyKey: 'cancel-8-do',
        customerId: outsider,
        orderId: order.id,
      }),
    ).rejects.toMatchObject({ code: 'commerce.order_not_found' });
    expect((await orderRow(order.id)).state).toBe('AWAITING_PAYMENT');
  });

  /**
   * The same refusal, with the OWNERSHIP predicate taken out of the argument.
   *
   * The case above passes a different tenant AND a different customer, so either
   * predicate alone refuses it — which means it cannot tell you that tenant scoping
   * works. Measured rather than reasoned: removing `orders.tenantId` from the
   * repository's `findById` leaves that case green.
   *
   * Here the customer id is tenant A's own, so `before.customerId !== customerId` is
   * FALSE and cannot refuse anything. The only thing left that can is the tenant
   * predicate in the repository query, which is exactly what this asserts. Deleting
   * that predicate turns this red.
   */
  it('refuses another tenant even when the customer id would match', async () => {
    const order = await awaitingPayment(tenantA, customerA, panelA, 'cancel-10');

    await expect(
      ctx.container.orders.cancelByCustomer(tenantB, systemActor('cancel-10-do'), {
        idempotencyKey: 'cancel-10-do',
        /* Tenant A's customer, asked for through tenant B's scope. */
        customerId: customerA,
        orderId: order.id,
      }),
    ).rejects.toMatchObject({ code: 'commerce.order_not_found' });
    expect((await orderRow(order.id)).state).toBe('AWAITING_PAYMENT');
  });

  it('answers both when two taps arrive together', async () => {
    /*
     * Two commands with different keys, started together: both are answered with the
     * end state the customer asked for, and neither throws.
     *
     * What this case does NOT establish, despite how it reads: the interleaving. It
     * used to claim it was "the conditional UPDATE carrying the whole concurrency
     * story", and it is not — `Promise.all` does not interleave these two inside the
     * window. The second transaction's opening read happens after the first has
     * committed, so it takes the EARLY return at the top of `cancelByCustomer` and
     * never reaches the `!changed` branch at all. Measured, not assumed: this case
     * passes with the WP4 fix reverted.
     *
     * That is the shape `CLAUDE.md` names and the C4 case below already had to solve
     * once. The real race is driven with a row lock in
     * `writes no audit row for a cancellation that lost the transition`; this case
     * keeps its own smaller claim — that two taps are both answered, and that the
     * ordinary path logs exactly one cancellation.
     */
    const order = await awaitingPayment(tenantA, customerA, panelA, 'cancel-9');

    const results = await Promise.all([
      ctx.container.orders.cancelByCustomer(tenantA, systemActor('cancel-9-a'), {
        idempotencyKey: 'cancel-9-a',
        customerId: customerA,
        orderId: order.id,
      }),
      ctx.container.orders.cancelByCustomer(tenantA, systemActor('cancel-9-b'), {
        idempotencyKey: 'cancel-9-b',
        customerId: customerA,
        orderId: order.id,
      }),
    ]);

    expect(results.map((r) => r.state)).toEqual(['CANCELLED', 'CANCELLED']);
    expect((await auditActions(order.id)).filter((a) => a === 'order.cancel')).toHaveLength(1);
  });

  /**
   * The three races the Codex review of PR #30 found, each of which told a customer
   * something false.
   *
   * All three are the same shape: a conditional write LOST, and the method carried on
   * as though it had won. READ COMMITTED is what opens every one of them — the guard
   * read and the write are two statements, and another transaction commits between.
   */
  describe('a decision that lost its race', () => {
    /**
     * C1. Cancelling must not withdraw a transfer the customer has just claimed.
     *
     * `claimedPendingFor` runs before any write, and a `signalTransferSent` that
     * commits after it leaves the guard's answer stale — so `cancelPendingForOrder`,
     * whose UPDATE matched only `state = 'PENDING'`, cancelled the payment the customer
     * had been told was recorded for review. Both halves are fixed: the UPDATE refuses
     * a signalled row, and the guard is re-asked afterwards so a row left behind
     * becomes a refusal rather than a silent partial cancellation.
     */
    it('refuses to cancel an order whose transfer was signalled during the attempt', async () => {
      const order = await awaitingPayment(tenantA, customerA, panelA, 'race-1');
      const payment = await transferFor(tenantA, customerA, order.id, 'race-1-pay');

      const [signal, cancel] = await Promise.allSettled([
        ctx.container.payments.signalTransferSent(tenantA, systemActor('race-1-s'), customerA, {
          idempotencyKey: 'race-1-signal',
          paymentId: payment.id,
          botInstanceId: BOT_A,
        }),
        ctx.container.orders.cancelByCustomer(tenantA, systemActor('race-1-c'), {
          idempotencyKey: 'race-1-cancel',
          customerId: customerA,
          orderId: order.id,
        }),
      ]);

      /*
       * Whichever order they interleave in, the one invariant holds: a payment that
       * carries a customer's claim is NOT cancelled. Either the cancel ran first (the
       * signal then refuses a non-pending payment) or the signal did (the cancel
       * refuses), and both are legitimate — what must never happen is a CANCELLED
       * payment with a `customer_signalled_at`.
       */
      const after = await paymentRow(payment.id);
      expect(
        after.customer_signalled_at === null || after.state !== 'CANCELLED',
        'a claimed transfer was cancelled anyway',
      ).toBe(true);
      expect(
        signal.status === 'fulfilled' || cancel.status === 'fulfilled',
        'both refused; one of the two had to win',
      ).toBe(true);
    });

    /**
     * C4. A cancel that lost to a settlement must not be reported as a cancellation.
     *
     * `transition` returned `false`, and the method audited SUCCESS, stored the
     * idempotency result and returned the now-`PAID` row — which `BotRuntime` renders
     * as "your order was cancelled". A customer whose payment had just settled would be
     * told it was withdrawn.
     */
    it('refuses a cancellation when the order settles first', async () => {
      /*
       * The window is DRIVEN with a real row lock, not hoped for.
       *
       * The first version of this case started a settlement and a cancellation with
       * `Promise.allSettled` and asserted an invariant. It passed — and it passed with
       * the fix REVERTED, because the two never interleaved inside the window: the
       * settlement committed before the cancellation's opening read, so the pre-read
       * guard refused and the `!changed` branch was never reached. A test that cannot
       * fail is not a test, and `CLAUDE.md` names this exact shape.
       *
       * So the test holds the pending payment's row lock on its own connection. The
       * cancellation reads the order as `AWAITING_PAYMENT`, then BLOCKS inside
       * `withdrawPendingFor` on that lock. While it is blocked the order is settled and
       * the lock released, so the cancellation resumes into precisely the state the
       * branch exists for: its opening read said `AWAITING_PAYMENT` and its conditional
       * transition matches nothing.
       */
      const order = await awaitingPayment(tenantA, customerA, panelA, 'race-2');
      const payment = await transferFor(tenantA, customerA, order.id, 'race-2-pay');

      const cancelled = await ctx.container.database.withClient(async (holder) => {
        await holder.query('BEGIN');
        try {
          await holder.query('SELECT id FROM payments WHERE id = $1 FOR UPDATE', [payment.id]);

          const attempt = ctx.container.orders.cancelByCustomer(tenantA, systemActor('race-2-c'), {
            idempotencyKey: 'race-2-cancel',
            customerId: customerA,
            orderId: order.id,
          });
          /* Swallowed here and asserted below: an unhandled rejection fails the file. */
          const settled = attempt.then(
            () => ({ ok: true }) as const,
            (error: unknown) => ({ ok: false, error }) as const,
          );

          /*
           * Long enough for the cancellation to reach the lock and stop there. It
           * cannot proceed past `withdrawPendingFor` while this transaction holds the
           * row, so the wait establishes the ordering rather than hoping for it.
           */
          await new Promise((resolve) => setTimeout(resolve, 250));
          /*
           * `settled_at` moves with the state because `orders_settled_at_check` binds
           * them — `(state = 'PAID' OR state = 'REFUNDED') = (settled_at IS NOT NULL)`.
           * The first version of this wrote the state alone, which aborted this
           * transaction and handed a poisoned connection back to the pool.
           */
          await holder.query(
            "UPDATE orders SET state = 'PAID', settled_at = now(), updated_at = now() WHERE id = $1",
            [order.id],
          );
          await holder.query('COMMIT');
          return settled;
        } catch (error: unknown) {
          await holder.query('ROLLBACK');
          throw error;
        }
      });

      const outcome = await cancelled;
      expect(
        outcome.ok,
        'an order settled under the cancellation must not report a cancellation',
      ).toBe(false);

      const settled = await orderRow(order.id);
      expect(settled.state).toBe('PAID');
      /* And never the impossible pair: PAID carrying a cancellation stamp. */
      expect(settled.cancelled_at).toBeNull();
    });

    /**
     * WP4. The loser releases nothing twice, and leaves nothing behind.
     *
     * Both releases run unconditionally, including for a loser, and that is
     * deliberate: a winner that cancelled and then died before releasing would leave
     * the hold standing until its deadline. It is safe only because each is a single
     * conditional DELETE returning a boolean, so a second call deletes nothing.
     *
     * This asserts the OUTCOME of that rather than the shape of the SQL — after a
     * race in which both transactions ran the releases, the order holds neither a
     * capacity slot nor a username reservation, and nothing errored. A release that
     * stopped being idempotent would surface here as a failed transaction rather than
     * as a duplicate row, which is why the loser's own success is asserted too.
     */
    it('releases the slot and the name exactly once across a lost race', async () => {
      const order = await awaitingPayment(tenantA, customerA, panelA, 'race-7');
      const payment = await transferFor(tenantA, customerA, order.id, 'race-7-pay');

      const losing = await ctx.container.database.withClient(async (holder) => {
        await holder.query('BEGIN');
        try {
          await holder.query('SELECT id FROM payments WHERE id = $1 FOR UPDATE', [payment.id]);
          const attempt = ctx.container.orders.cancelByCustomer(tenantA, systemActor('race-7-c'), {
            idempotencyKey: 'race-7-cancel',
            customerId: customerA,
            orderId: order.id,
          });
          const settled = attempt.then(
            () => ({ ok: true }) as const,
            (error: unknown) => ({ ok: false, error }) as const,
          );
          await new Promise((resolve) => setTimeout(resolve, 250));
          await holder.query(
            "UPDATE orders SET state = 'CANCELLED', cancelled_at = now(), updated_at = now() WHERE id = $1",
            [order.id],
          );
          await holder.query('COMMIT');
          return settled;
        } catch (error: unknown) {
          await holder.query('ROLLBACK');
          throw error;
        }
      });

      expect((await losing).ok, 'an idempotent release must not fail the loser').toBe(true);

      const slots = (await ctx.container.database.db.execute(
        sql`SELECT count(*)::int AS n FROM panel_capacity_reservations WHERE order_id = ${order.id}` as never,
      )) as unknown as { rows: { n: number }[] };
      const names = (await ctx.container.database.db.execute(
        sql`SELECT count(*)::int AS n FROM service_username_reservations WHERE order_id = ${order.id}` as never,
      )) as unknown as { rows: { n: number }[] };
      expect(slots.rows[0]?.n, 'a capacity slot survived the cancellation').toBe(0);
      expect(names.rows[0]?.n, 'a username reservation survived the cancellation').toBe(0);
    });

    /**
     * WP4. Cancellation has no asynchronous effect to duplicate.
     *
     * Recorded as an assertion rather than trusted: the audit found that
     * `cancelByCustomer` writes no outbox row and enqueues no customer notification —
     * the `ORDER_CANCELLED` fallback lives in `BotRuntime`, outside the transaction,
     * and fires per REPLY rather than per transition.
     *
     * If either ever gains one, the duplicate-effect question this package answers
     * reopens, and it reopens HERE rather than in production.
     */
    it('enqueues nothing asynchronous for either racer to duplicate', async () => {
      const order = await awaitingPayment(tenantA, customerA, panelA, 'race-8');

      await ctx.container.orders.cancelByCustomer(tenantA, systemActor('race-8-a'), {
        idempotencyKey: 'race-8-a',
        customerId: customerA,
        orderId: order.id,
      });
      /* A different key, so this is a genuine second command reaching the service. */
      await ctx.container.orders.cancelByCustomer(tenantA, systemActor('race-8-b'), {
        idempotencyKey: 'race-8-b',
        customerId: customerA,
        orderId: order.id,
      });

      const outbox = (await ctx.container.database.db.execute(
        sql`SELECT count(*)::int AS n FROM outbox_messages WHERE payload::text LIKE ${'%' + order.id + '%'}` as never,
      )) as unknown as { rows: { n: number }[] };
      const notes = (await ctx.container.database.db.execute(
        sql`SELECT count(*)::int AS n FROM customer_notifications WHERE subject_id = ${order.id}` as never,
      )) as unknown as { rows: { n: number }[] };
      expect(outbox.rows[0]?.n, 'cancellation gained an outbox message').toBe(0);
      expect(notes.rows[0]?.n, 'cancellation gained a customer notification').toBe(0);
    });

    /**
     * WP4. The same key twice is a REPLAY, and is answered from the record.
     *
     * The other half of the concurrency story, and a different mechanism from the one
     * above: Telegram redelivering ONE update reuses its id, so the key is the same
     * and `replay` short-circuits before the transaction opens. No second transition,
     * and no second audit row — which the winner's own row must survive.
     */
    it('answers a redelivered cancellation from the idempotency record', async () => {
      const order = await awaitingPayment(tenantA, customerA, panelA, 'race-9');

      const first = await ctx.container.orders.cancelByCustomer(tenantA, systemActor('race-9'), {
        idempotencyKey: 'race-9-cancel',
        customerId: customerA,
        orderId: order.id,
      });
      const replayed = await ctx.container.orders.cancelByCustomer(tenantA, systemActor('race-9'), {
        idempotencyKey: 'race-9-cancel',
        customerId: customerA,
        orderId: order.id,
      });

      expect(replayed.id).toBe(first.id);
      expect(replayed.state).toBe('CANCELLED');
      /* Exactly the winner's row: the replay added none and removed none. */
      expect((await auditActions(order.id)).filter((a) => a === 'order.cancel')).toHaveLength(1);
    });

    /**
     * WP4. The rollback path leaves neither the transition nor a claim behind.
     *
     * The second `claimedPendingFor`, asked AFTER the withdrawal, is the one that
     * throws: a customer's claim committing between the pre-write guard and the write
     * means `withdrawPendingFor`'s UPDATE refuses the signalled row, and carrying on
     * would be a partial cancellation with a live transfer instruction still attached.
     *
     * Throwing rolls back the withdrawal, and it must roll back everything else with
     * it. Asserted as three absences rather than one, because a rollback that leaves
     * ANY of them is the failure: no transition, no cancellation stamp, and no
     * `order.cancel` row claiming an order was withdrawn that is still awaiting
     * payment.
     *
     * Driven with the row lock rather than hoped for, for the reason the C4 case
     * carries in full.
     */
    it('leaves no transition and no claim when the cancellation rolls back', async () => {
      const order = await awaitingPayment(tenantA, customerA, panelA, 'race-6');
      const payment = await transferFor(tenantA, customerA, order.id, 'race-6-pay');

      const attempted = await ctx.container.database.withClient(async (holder) => {
        await holder.query('BEGIN');
        try {
          await holder.query('SELECT id FROM payments WHERE id = $1 FOR UPDATE', [payment.id]);

          const attempt = ctx.container.orders.cancelByCustomer(tenantA, systemActor('race-6-c'), {
            idempotencyKey: 'race-6-cancel',
            customerId: customerA,
            orderId: order.id,
          });
          const settled = attempt.then(
            () => ({ ok: true }) as const,
            (error: unknown) => ({ ok: false, error }) as const,
          );

          await new Promise((resolve) => setTimeout(resolve, 250));
          /*
           * The customer's claim lands while the cancellation is blocked. Written
           * directly because `signalTransferSent` would queue behind the same lock.
           */
          await holder.query(
            'UPDATE payments SET customer_signalled_at = now(), updated_at = now() WHERE id = $1',
            [payment.id],
          );
          await holder.query('COMMIT');
          return settled;
        } catch (error: unknown) {
          await holder.query('ROLLBACK');
          throw error;
        }
      });

      const outcome = await attempted;
      expect(outcome.ok, 'a cancellation that could not withdraw the claim must refuse').toBe(
        false,
      );

      const row = await orderRow(order.id);
      expect(row.state, 'the order moved despite the rollback').toBe('AWAITING_PAYMENT');
      expect(row.cancelled_at, 'a cancellation stamp survived the rollback').toBeNull();
      expect(
        (await auditActions(order.id)).filter((a) => a === 'order.cancel'),
        'a rolled-back cancellation left a claim in the audit log',
      ).toHaveLength(0);
      /* And the claim it refused to cancel is still there for an operator. */
      const stillPending = await paymentRow(payment.id);
      expect(stillPending.state).toBe('PENDING');
      expect(stillPending.customer_signalled_at).not.toBeNull();
    });

    /**
     * WP4. A cancellation that LOST must not claim it performed one.
     *
     * The loser's conditional UPDATE matches nothing, so `changed` is false — but by
     * then the winner has committed, so the re-read says `CANCELLED` and the guard
     * above admits it. That is correct for the ANSWER: the customer asked for a
     * cancelled order and has one. What was wrong is that it went on to write a
     * second `order.cancel` row with `result: 'SUCCESS'` for a transition it did not
     * perform.
     *
     * The proof this was a defect rather than a policy is an asymmetry. A request
     * arriving AFTER the cancellation commits reads `CANCELLED` at the top, takes the
     * early return, and writes NO audit row. Same customer, same intent, same end
     * state — one row or two depending purely on interleaving, in the one log that
     * exists to answer who did what and when.
     *
     * ## Why the winner is a raw UPDATE
     *
     * `Promise.all` does not reproduce this, and the case above already records why
     * in full: the two never interleave inside the window, so the second call reads
     * `CANCELLED` and takes the early return. `cancel-9` above is exactly that shape
     * and it passes with this fix reverted — it is measuring serialisation, not the
     * race it names. So this drives the window with the same row lock C4 uses.
     *
     * The winner is a direct UPDATE rather than a second service call because both
     * service calls would block on the SAME payment lock, which is the only seam
     * there is. It produces precisely the state the branch exists for and it writes
     * no audit row of its own, which is what makes the assertion exact: every
     * `order.cancel` row this test can see belongs to the LOSER, so the count is a
     * direct measurement of what the loser claimed.
     */
    it('writes no audit row for a cancellation that lost the transition', async () => {
      const order = await awaitingPayment(tenantA, customerA, panelA, 'race-4');
      const payment = await transferFor(tenantA, customerA, order.id, 'race-4-pay');

      const losing = await ctx.container.database.withClient(async (holder) => {
        await holder.query('BEGIN');
        try {
          await holder.query('SELECT id FROM payments WHERE id = $1 FOR UPDATE', [payment.id]);

          const attempt = ctx.container.orders.cancelByCustomer(tenantA, systemActor('race-4-c'), {
            idempotencyKey: 'race-4-cancel',
            customerId: customerA,
            orderId: order.id,
          });
          const settled = attempt.then(
            (row) => ({ ok: true, state: row.state }) as const,
            (error: unknown) => ({ ok: false, error }) as const,
          );

          /* Long enough to reach the lock and stop there, establishing the order. */
          await new Promise((resolve) => setTimeout(resolve, 250));
          /*
           * The winner, as the database sees it. `cancelled_at` travels with the state
           * because `orders_cancelled_at_check` binds them.
           */
          await holder.query(
            "UPDATE orders SET state = 'CANCELLED', cancelled_at = now(), updated_at = now() WHERE id = $1",
            [order.id],
          );
          await holder.query('COMMIT');
          return settled;
        } catch (error: unknown) {
          await holder.query('ROLLBACK');
          throw error;
        }
      });

      const outcome = await losing;
      /*
       * The customer is still answered, and answered truthfully: their order is
       * cancelled. Narrowing what the loser CLAIMS must not change what it RETURNS.
       */
      expect(outcome.ok, 'the loser must still answer the customer').toBe(true);
      if (outcome.ok) expect(outcome.state).toBe('CANCELLED');

      /*
       * And it claimed nothing. Zero rather than one because the winner here is a raw
       * UPDATE that writes none — so this counts only what the LOSER wrote.
       */
      expect(
        (await auditActions(order.id)).filter((a) => a === 'order.cancel'),
        'a cancellation that moved no row claimed one in the audit log',
      ).toHaveLength(0);
    });

    /**
     * The other half, so the fix cannot be satisfied by writing no rows at all: the
     * transaction that DID perform the cancellation still records it, exactly once.
     */
    it('still records the cancellation that did perform one', async () => {
      const order = await awaitingPayment(tenantA, customerA, panelA, 'race-5');

      await ctx.container.orders.cancelByCustomer(tenantA, systemActor('race-5-c'), {
        idempotencyKey: 'race-5-cancel',
        customerId: customerA,
        orderId: order.id,
      });

      expect((await auditActions(order.id)).filter((a) => a === 'order.cancel')).toHaveLength(1);
    });

    /**
     * C3. A signal that was not recorded must not say it was.
     *
     * `signalSent` returning `false` was read as "already on record". One of its three
     * causes is a payment that moved out of `PENDING` between the read and the update,
     * and there `customer_signalled_at` stays null: no operator ever sees the claim,
     * and the bot said it was filed. The method now re-reads and follows the evidence.
     */
    it('refuses a transfer signal when the payment is rejected first', async () => {
      /*
       * Driven by a row lock, for the reason the case above carries in full.
       *
       * The window is between `signalTransferSent`'s own read — which sees `PENDING`
       * and passes its state check — and its conditional UPDATE. Started as two
       * concurrent calls the rejection simply finished first, the pre-read check
       * refused, and the `!stamped` branch was never reached: the test passed with the
       * fix reverted.
       *
       * Holding the payment row makes the ordering a fact. The signal reads `PENDING`,
       * blocks on the UPDATE, and by the time it is granted the row the rejection has
       * committed — so its `state = 'PENDING'` predicate matches nothing, which is
       * exactly the `false` that used to be read as "already on record".
       */
      const order = await awaitingPayment(tenantA, customerA, panelA, 'race-3');
      const payment = await transferFor(tenantA, customerA, order.id, 'race-3-pay');

      const signalled = await ctx.container.database.withClient(async (holder) => {
        await holder.query('BEGIN');
        try {
          await holder.query('SELECT id FROM payments WHERE id = $1 FOR UPDATE', [payment.id]);

          const attempt = ctx.container.payments.signalTransferSent(
            tenantA,
            systemActor('race-3-s'),
            customerA,
            { idempotencyKey: 'race-3-signal', paymentId: payment.id, botInstanceId: BOT_A },
          );
          const outcome = attempt.then(
            () => ({ ok: true }) as const,
            (error: unknown) => ({ ok: false, error }) as const,
          );

          await new Promise((resolve) => setTimeout(resolve, 250));
          /*
           * `resolved_at` moves with the state because `payments_resolved_check` binds
           * them for FAILED, CANCELLED and EXPIRED alike.
           */
          await holder.query(
            "UPDATE payments SET state = 'FAILED', resolved_at = now(), updated_at = now() WHERE id = $1",
            [payment.id],
          );
          await holder.query('COMMIT');
          return outcome;
        } catch (error: unknown) {
          await holder.query('ROLLBACK');
          throw error;
        }
      });

      const result = await signalled;
      expect(result.ok, 'an unrecorded claim must not report success').toBe(false);

      const after = await paymentRow(payment.id);
      /* The evidence the reply would have been claiming: it is not there. */
      expect(after.customer_signalled_at).toBeNull();
      expect(after.state).toBe('FAILED');
    });
  });
});
