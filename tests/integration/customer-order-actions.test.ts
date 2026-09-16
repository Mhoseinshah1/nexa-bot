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
    ctx.container.payments.requestManualTransfer(scope, systemActor(key), customerId, {
      idempotencyKey: key,
      orderId,
    });

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
      { idempotencyKey: 'signal-1-say', paymentId: payment.id },
    );

    /*
     * The state did NOT move, and that is the assertion this whole slice rests on. A
     * claim is not evidence: `PAYMENT_MACHINE` takes no edge, the evidence kind stays
     * null, and an operator with `receipts.review` still has to confirm it.
     */
    expect(after.state).toBe('PENDING');
    expect(after.evidenceKind).toBeNull();
    expect(after.customerSignalledAt).not.toBeNull();

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
      { idempotencyKey: 'signal-2-a', paymentId: payment.id },
    );
    const second = await ctx.container.payments.signalTransferSent(
      tenantA,
      systemActor('signal-2-b'),
      customerA,
      { idempotencyKey: 'signal-2-b', paymentId: payment.id },
    );

    expect(second.customerSignalledAt?.toISOString()).toBe(
      first.customerSignalledAt?.toISOString(),
    );
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

  it('cancels once when two taps arrive together', async () => {
    /*
     * The conditional UPDATE carrying the whole concurrency story. Two commands with
     * different keys, started together: one moves the row, the other finds it already
     * CANCELLED and returns the end state. Neither throws.
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
});
