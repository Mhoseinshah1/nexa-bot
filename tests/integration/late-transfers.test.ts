import { sql, type SQL } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COMMERCE_ERROR_CODES,
  money,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type PanelId,
  type PaymentId,
  type ProductCategoryId,
  type ProductId,
  type UserId,
} from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import type { OrderRecord } from '../../apps/api/src/modules/commerce/orders/application/ports';
import type { LateTransferServiceDeps } from '../../apps/api/src/modules/commerce/payments/application/late-transfer.service';
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
 * The late-review lane (`docs/wp10-payments-audit.md` P1, closing D1).
 *
 * The owner's expiry rule stands: a transfer's payment and its order close at the
 * deadline and nothing reopens either. What this suite defends is the money that arrived
 * anyway, for a customer who VOUCHED for it — a signal or a receipt:
 *
 *   - who is in the lane: an EXPIRED manual transfer somebody vouched for, undecided —
 *     and nobody else, whatever state they are in;
 *   - the two decisions, each recorded ONCE: a credit of the payment's exact amount under
 *     `LATE_TRANSFER`, and a dismissal with a reason, both leaving the payment EXPIRED
 *     and the order closed;
 *   - one decision under a produced race, not a hoped-for one: the payment's row lock is
 *     what the second reviewer waits on, and `pg_stat_activity` is asked to prove it;
 *   - the database refusing on its own: the decision's key, the ledger's partial unique
 *     index, the append-only guard and the insert guard, each without the service;
 *   - what the customer is told at expiry, which now depends on whether they vouched.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

describe('the late-review lane', () => {
  let ctx: TestContext;
  let products: DrizzleProductRepository;
  let panelA: string;
  let customerA: UserId;
  let owner: ActorContext;
  let ownerB: ActorContext;
  let support: ActorContext;
  let sequence = 0;
  const key = (): string => `late-${String((sequence += 1)).padStart(4, '0')}`;

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    await ctx.reset();
    products = new DrizzleProductRepository(ctx.container.database.db);
    panelA = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelA}, ${tenantA.tenantId}, 'Panel A', 'sanaei', 'https://a.example.test', 'ACTIVE')`);
    await makePanelSellable(ctx.container, tenantA, panelA);
    customerA = await customer('940500');
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-late', roleKeys: ['owner'] }),
    );
    ownerB = adminActorFor(
      await createAdmin(ctx.container, tenantB, { username: 'owner-late-b', roleKeys: ['owner'] }),
    );
    support = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'support-late',
        roleKeys: ['support'],
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Who is in the lane
  // -------------------------------------------------------------------------

  describe('eligibility', () => {
    it('admits an expired transfer the customer signalled', async () => {
      const { payment } = await expiredTransfer({ signal: true });
      expect((await view(payment.id)).eligible).toBe(true);
      expect(await laneIds()).toEqual([payment.id]);
    });

    it('admits an expired transfer that carries only a receipt', async () => {
      const { payment } = await expiredTransfer({ receipt: true });
      expect((await view(payment.id)).eligible).toBe(true);
      expect(await laneIds()).toEqual([payment.id]);
      await credit(payment.id);
      expect(await lateEntries(payment.id)).toHaveLength(1);
    });

    it('refuses an expired transfer nobody vouched for', async () => {
      const { payment } = await expiredTransfer({});

      await expect(credit(payment.id)).rejects.toMatchObject({
        code: COMMERCE_ERROR_CODES.LATE_TRANSFER_NOT_ELIGIBLE,
        details: { reason: 'NOT_VOUCHED_FOR' },
      });
      await expect(dismiss(payment.id)).rejects.toMatchObject({
        code: COMMERCE_ERROR_CODES.LATE_TRANSFER_NOT_ELIGIBLE,
      });
      expect((await view(payment.id)).eligible).toBe(false);
      expect(await laneIds()).toEqual([]);
      expect(await lateEntries(payment.id)).toHaveLength(0);
    });

    it('refuses a PENDING transfer and a CONFIRMED one, vouched for or not', async () => {
      const pending = await vouchedPending();
      await expect(credit(pending.payment.id)).rejects.toMatchObject({
        code: COMMERCE_ERROR_CODES.LATE_TRANSFER_NOT_ELIGIBLE,
        details: { reason: 'NOT_EXPIRED' },
      });

      const confirmed = await vouchedPending();
      await ctx.container.payments.confirmManualTransfer(tenantA, owner, confirmed.payment.id, {
        idempotencyKey: key(),
        note: 'واریز دیده شد',
      });
      await expect(credit(confirmed.payment.id)).rejects.toMatchObject({
        code: COMMERCE_ERROR_CODES.LATE_TRANSFER_NOT_ELIGIBLE,
        details: { reason: 'NOT_EXPIRED' },
      });
      expect(await laneIds()).toEqual([]);
      expect(await count(sql`SELECT count(*)::int AS n FROM late_transfer_decisions`)).toBe(0);
    });

    it('admits a top-up transfer on the same terms, and credits it with no order', async () => {
      const topup = await expiredTopup();
      expect((await view(topup)).eligible).toBe(true);

      await credit(topup);

      const [entry] = await lateEntries(topup);
      expect(entry).toMatchObject({ amount: '75000', order_id: null, payment_id: topup });
    });

    it('lists the lane and nothing else under lateReview, and drops a row once decided', async () => {
      const signalled = await expiredTransfer({ signal: true });
      const lapsed = await expiredTransfer({});
      const pending = await vouchedPending();

      expect(await laneIds()).toEqual([signalled.payment.id]);
      const others = await laneIds(false);
      expect(others).toContain(lapsed.payment.id);
      expect(others).toContain(pending.payment.id);
      expect(others).not.toContain(signalled.payment.id);

      await credit(signalled.payment.id);
      expect(await laneIds(), 'a decided payment has left the lane').toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // The credit
  // -------------------------------------------------------------------------

  describe('a credit', () => {
    it('credits exactly the payment’s amount once and leaves the payment EXPIRED and the order closed', async () => {
      const { order, payment } = await expiredTransfer({ signal: true });

      const outcome = await credit(payment.id);

      expect(outcome.decision).toMatchObject({ decision: 'CREDITED', reason: null });
      expect(outcome.decision.amount).toEqual(money(250_000n, 'IRT'));
      const entries = await lateEntries(payment.id);
      expect(entries).toEqual([
        {
          direction: 'CREDIT',
          amount: '250000',
          currency: 'IRT',
          reference: `${payment.id}:late`,
          order_id: order.id,
          payment_id: payment.id,
          actor_admin_id: owner.id,
        },
      ]);
      expect(await balance()).toBe(250_000n);
      // Nothing reopened: the owner's expiry rule stands.
      expect(await stateOf('payments', payment.id)).toBe('EXPIRED');
      expect(await stateOf('orders', order.id)).toBe('EXPIRED');

      const decision = await rows<Record<string, unknown>>(
        sql`SELECT decision, reason, amount::text AS amount, currency, wallet_entry_id,
                   decided_by_admin_id
              FROM late_transfer_decisions WHERE payment_id = ${payment.id}`,
      );
      expect(decision).toEqual([
        {
          decision: 'CREDITED',
          reason: null,
          amount: '250000',
          currency: 'IRT',
          wallet_entry_id: outcome.decision.walletEntryId,
          decided_by_admin_id: owner.id,
        },
      ]);
      expect(await notified('LATE_TRANSFER_CREDITED', payment.id)).toBe(1);
      expect(await walletEvents('LATE_TRANSFER')).toBe(1);
      expect(await audited('payment.late_credit')).toBe(1);
      const after = await view(payment.id);
      expect(after.eligible).toBe(false);
      expect(after.decision?.decision).toBe('CREDITED');
    });

    it('answers a replay with the same decision and credits nothing more', async () => {
      const { payment } = await expiredTransfer({ signal: true });
      const idempotencyKey = key();

      const first = await credit(payment.id, idempotencyKey);
      const replay = await credit(payment.id, idempotencyKey);

      expect(replay.decision.walletEntryId).toBe(first.decision.walletEntryId);
      expect(await lateEntries(payment.id)).toHaveLength(1);
      expect(await balance()).toBe(250_000n);
      expect(await audited('payment.late_credit')).toBe(1);
    });

    it('refuses a second credit under a new key as already decided, and credits nothing', async () => {
      const { payment } = await expiredTransfer({ signal: true });
      await credit(payment.id);

      await expect(credit(payment.id)).rejects.toMatchObject({
        code: COMMERCE_ERROR_CODES.LATE_TRANSFER_ALREADY_DECIDED,
        details: { decision: 'CREDITED' },
      });
      expect(await lateEntries(payment.id)).toHaveLength(1);
      expect(await balance()).toBe(250_000n);
    });

    it('treats the same key reused for the other decision as a mismatch, not a replay', async () => {
      const { payment } = await expiredTransfer({ signal: true });
      const idempotencyKey = key();
      await credit(payment.id, idempotencyKey);

      await expect(dismiss(payment.id, idempotencyKey)).rejects.toMatchObject({
        code: 'platform.idempotency_payload_mismatch',
      });
    });

    it('refuses an actor without receipts.review, writes nothing, and records the denial', async () => {
      const { payment } = await expiredTransfer({ signal: true });

      await expect(
        ctx.container.lateTransfers.credit(tenantA, support, payment.id, {
          idempotencyKey: key(),
        }),
      ).rejects.toMatchObject({ code: 'platform.permission_denied' });

      expect(await lateEntries(payment.id)).toHaveLength(0);
      expect(
        await count(
          sql`SELECT count(*)::int AS n FROM audit_logs
               WHERE action = 'payment.late_credit' AND result = 'DENIED'`,
        ),
      ).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // The dismissal
  // -------------------------------------------------------------------------

  describe('a dismissal', () => {
    it('records the reason, moves nothing, and tells the customer PAYMENT_REJECTED', async () => {
      const { order, payment } = await expiredTransfer({ signal: true });

      const outcome = await dismiss(payment.id);

      expect(outcome.decision).toMatchObject({
        decision: 'DISMISSED',
        reason: 'AMOUNT_UNDERPAID',
        note: 'فقط نیمی از مبلغ رسید',
        amount: null,
        walletEntryId: null,
      });
      expect(await lateEntries(payment.id)).toHaveLength(0);
      expect(await balance()).toBe(0n);
      expect(await stateOf('payments', payment.id)).toBe('EXPIRED');
      expect(await stateOf('orders', order.id)).toBe('EXPIRED');
      expect(await notified('PAYMENT_REJECTED', payment.id)).toBe(1);
      expect(await audited('payment.late_dismiss')).toBe(1);
      expect(await laneIds()).toEqual([]);
    });

    it('refuses a dismissal after a credit, and a credit after a dismissal', async () => {
      const credited = await expiredTransfer({ signal: true });
      await credit(credited.payment.id);
      await expect(dismiss(credited.payment.id)).rejects.toMatchObject({
        code: COMMERCE_ERROR_CODES.LATE_TRANSFER_ALREADY_DECIDED,
      });

      const dismissed = await expiredTransfer({ signal: true });
      await dismiss(dismissed.payment.id);
      await expect(credit(dismissed.payment.id)).rejects.toMatchObject({
        code: COMMERCE_ERROR_CODES.LATE_TRANSFER_ALREADY_DECIDED,
        details: { decision: 'DISMISSED' },
      });
      expect(await lateEntries(dismissed.payment.id)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Produced races
  // -------------------------------------------------------------------------

  describe('two reviewers at once', () => {
    it('serialises two concurrent credits on the payment lock: one credit, one refusal', async () => {
      const { payment } = await expiredTransfer({ signal: true });
      const race = await heldInsideTheLock();

      const first = credit(payment.id);
      first.catch(() => undefined);
      await race.inside;
      const second = credit(payment.id);
      second.catch(() => undefined);
      await race.secondWaitsOnThePayment();

      race.release();
      const results = await Promise.allSettled([first, second]);
      expect(results[0].status).toBe('fulfilled');
      expect(results[1]).toMatchObject({
        status: 'rejected',
        reason: { code: COMMERCE_ERROR_CODES.LATE_TRANSFER_ALREADY_DECIDED },
      });
      expect(await lateEntries(payment.id)).toHaveLength(1);
      expect(await balance()).toBe(250_000n);
      expect(await count(sql`SELECT count(*)::int AS n FROM late_transfer_decisions`)).toBe(1);
    });

    it('lets a credit racing a dismissal produce one decision', async () => {
      const { payment } = await expiredTransfer({ signal: true });
      const race = await heldInsideTheLock();

      const crediting = credit(payment.id);
      crediting.catch(() => undefined);
      await race.inside;
      const dismissing = dismiss(payment.id);
      dismissing.catch(() => undefined);
      await race.secondWaitsOnThePayment();

      race.release();
      const [credited, dismissed] = await Promise.allSettled([crediting, dismissing]);
      expect(credited.status).toBe('fulfilled');
      expect(dismissed).toMatchObject({
        status: 'rejected',
        reason: {
          code: COMMERCE_ERROR_CODES.LATE_TRANSFER_ALREADY_DECIDED,
          details: { decision: 'CREDITED' },
        },
      });
      expect(
        await rows<{ decision: string }>(
          sql`SELECT decision FROM late_transfer_decisions WHERE payment_id = ${payment.id}`,
        ),
      ).toEqual([{ decision: 'CREDITED' }]);
      expect(await notified('PAYMENT_REJECTED', payment.id)).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // What the database refuses on its own
  // -------------------------------------------------------------------------

  describe('the database', () => {
    it('refuses a second decision row for one payment', async () => {
      const { payment } = await expiredTransfer({ signal: true });
      await credit(payment.id);

      await expect(
        rawQuery(`INSERT INTO late_transfer_decisions
                    (tenant_id, payment_id, decision, reason, decided_by_admin_id, decided_at)
                  VALUES ('${tenantA.tenantId}', '${payment.id}', 'DISMISSED', 'NOT_RECEIVED',
                          '${owner.id}', now())`),
      ).rejects.toMatchObject({ code: '23505', constraint: 'late_transfer_decisions_pkey' });
    });

    it('refuses a second LATE_TRANSFER ledger entry for one payment, under any reference', async () => {
      const { payment } = await expiredTransfer({ signal: true });
      await credit(payment.id);

      await expect(
        rawQuery(`INSERT INTO wallet_entries
                    (id, tenant_id, customer_id, direction, reason, amount, currency, reference,
                     payment_id)
                  VALUES ('${ctx.container.ids.uuid()}', '${tenantA.tenantId}', '${customerA}',
                          'CREDIT', 'LATE_TRANSFER', 250000, 'IRT', 'another-reference',
                          '${payment.id}')`),
      ).rejects.toMatchObject({
        code: '23505',
        constraint: 'wallet_entries_late_transfer_payment_key',
      });
      expect(await balance()).toBe(250_000n);
    });

    it('refuses UPDATE and DELETE on a decision', async () => {
      const { payment } = await expiredTransfer({ signal: true });
      await dismiss(payment.id);

      await expect(
        rawQuery(`UPDATE late_transfer_decisions SET reason = 'OTHER'
                   WHERE payment_id = '${payment.id}'`),
      ).rejects.toThrow(/append-only; UPDATE is not permitted/);
      await expect(
        rawQuery(`DELETE FROM late_transfer_decisions WHERE payment_id = '${payment.id}'`),
      ).rejects.toThrow(/append-only; DELETE is not permitted/);
    });

    it('refuses a decision about a payment that is not an expired transfer', async () => {
      const { payment } = await vouchedPending();

      await expect(
        rawQuery(`INSERT INTO late_transfer_decisions
                    (tenant_id, payment_id, decision, reason, decided_by_admin_id, decided_at)
                  VALUES ('${tenantA.tenantId}', '${payment.id}', 'DISMISSED', 'NOT_RECEIVED',
                          '${owner.id}', now())`),
      ).rejects.toThrow(/only about an EXPIRED manual transfer/);
    });

    it('refuses a credit decision whose amount is not the payment’s', async () => {
      const { payment } = await expiredTransfer({ signal: true });
      const entryId = ctx.container.ids.uuid();
      await rawQuery(`INSERT INTO wallet_entries
                        (id, tenant_id, customer_id, direction, reason, amount, currency,
                         reference, payment_id)
                      VALUES ('${entryId}', '${tenantA.tenantId}', '${customerA}', 'CREDIT',
                              'LATE_TRANSFER', 1, 'IRT', '${payment.id}:late', '${payment.id}')`);

      await expect(
        rawQuery(`INSERT INTO late_transfer_decisions
                    (tenant_id, payment_id, decision, amount, currency, wallet_entry_id,
                     decided_by_admin_id, decided_at)
                  VALUES ('${tenantA.tenantId}', '${payment.id}', 'CREDITED', 1, 'IRT',
                          '${entryId}', '${owner.id}', now())`),
      ).rejects.toThrow(/the payment's exact amount/);
    });
  });

  // -------------------------------------------------------------------------
  // What the customer is told when the window closes
  // -------------------------------------------------------------------------

  describe('the expiry sentence', () => {
    it('tells a customer who signalled PAYMENT_EXPIRED_UNDER_REVIEW instead of PAYMENT_EXPIRED', async () => {
      const { payment } = await expiredTransfer({ signal: true });
      expect(await notified('PAYMENT_EXPIRED_UNDER_REVIEW', payment.id)).toBe(1);
      expect(await notified('PAYMENT_EXPIRED', payment.id)).toBe(0);
    });

    it('tells a customer who only sent a receipt PAYMENT_EXPIRED_UNDER_REVIEW', async () => {
      const { payment } = await expiredTransfer({ receipt: true });
      expect(await notified('PAYMENT_EXPIRED_UNDER_REVIEW', payment.id)).toBe(1);
      expect(await notified('PAYMENT_EXPIRED', payment.id)).toBe(0);
    });

    it('tells a customer who vouched for nothing PAYMENT_EXPIRED, as before', async () => {
      const { payment } = await expiredTransfer({});
      expect(await notified('PAYMENT_EXPIRED', payment.id)).toBe(1);
      expect(await notified('PAYMENT_EXPIRED_UNDER_REVIEW', payment.id)).toBe(0);
    });
  });

  it('decides nothing for a tenant that has stopped accepting work', async () => {
    const { payment } = await expiredTransfer({ signal: true });
    await ctx.container.database.db.execute(
      sql`UPDATE tenants SET status = 'STOPPED' WHERE id = ${tenantA.tenantId}`,
    );

    await expect(credit(payment.id)).rejects.toMatchObject({
      code: COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
    });
    await expect(dismiss(payment.id)).rejects.toMatchObject({
      code: COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
    });
    expect(await lateEntries(payment.id)).toHaveLength(0);
    expect(await count(sql`SELECT count(*)::int AS n FROM late_transfer_decisions`)).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Tenancy
  // -------------------------------------------------------------------------

  it('keeps the lane per tenant: another tenant’s owner can neither see nor decide it', async () => {
    const { payment } = await expiredTransfer({ signal: true });

    await expect(
      ctx.container.lateTransfers.credit(tenantB, ownerB, payment.id, { idempotencyKey: key() }),
    ).rejects.toMatchObject({ code: COMMERCE_ERROR_CODES.PAYMENT_NOT_FOUND });
    await expect(
      ctx.container.lateTransfers.dismiss(tenantB, ownerB, payment.id, {
        idempotencyKey: key(),
        reason: 'NOT_RECEIVED',
        note: null,
      }),
    ).rejects.toMatchObject({ code: COMMERCE_ERROR_CODES.PAYMENT_NOT_FOUND });
    const listed = await ctx.container.payments.list(tenantB, ownerB, {
      search: { lateReview: true },
    });
    expect(listed.items).toEqual([]);
    expect(await laneIds()).toEqual([payment.id]);
    expect(await lateEntries(payment.id)).toHaveLength(0);
  });

  // =========================================================================
  // Fixtures
  // =========================================================================

  const rawQuery = (text: string) =>
    ctx.container.database.withClient((client) => client.query(text));

  async function rows<T>(query: SQL): Promise<T[]> {
    const result = (await ctx.container.database.db.execute(query as never)) as unknown as {
      rows: T[];
    };
    return result.rows;
  }

  async function count(query: SQL): Promise<number> {
    return (await rows<{ n: number }>(query))[0]?.n ?? 0;
  }

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

  async function awaitingPayment(): Promise<OrderRecord> {
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
        price: money(250_000n, 'IRT'),
      },
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, created.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    const draft = await ctx.container.orders.createDraft(tenantA, systemActor(key()), {
      idempotencyKey: key(),
      customerId: customerA,
      productId: created.id,
    });
    return ctx.container.orders.confirm(tenantA, systemActor(key()), {
      idempotencyKey: key(),
      customerId: customerA,
      orderId: draft.id,
    });
  }

  /** A PENDING transfer of 250,000 IRT, optionally signalled and optionally with a receipt. */
  async function transfer(vouch: { signal?: boolean; receipt?: boolean }) {
    const order = await awaitingPayment();
    const { payment } = await ctx.container.payments.requestManualTransfer(
      tenantA,
      systemActor(key()),
      customerA,
      { idempotencyKey: key(), orderId: order.id },
    );
    if (vouch.signal === true) {
      await ctx.container.payments.signalTransferSent(tenantA, systemActor(key()), customerA, {
        idempotencyKey: key(),
        paymentId: payment.id,
        botInstanceId: BOT_A,
      });
    }
    if (vouch.receipt === true) await receiptFor(payment.id);
    return { order, payment };
  }

  /** A pending transfer the customer vouched for, whose window is still open. */
  const vouchedPending = () => transfer({ signal: true });

  /**
   * The same, run past its deadline and through the REAL expiry sweep, so the payment and
   * its order are EXPIRED the way production expires them and the sweep's sentence is
   * the one it chose.
   */
  async function expiredTransfer(vouch: { signal?: boolean; receipt?: boolean }) {
    const { order, payment } = await transfer(vouch);
    await ctx.container.database.db.execute(
      sql`UPDATE payments SET expires_at = now() - interval '1 hour' WHERE id = ${payment.id}`,
    );
    await ctx.container.database.db.execute(
      sql`UPDATE orders SET expires_at = now() - interval '1 hour' WHERE id = ${order.id}`,
    );
    await ctx.container.paymentExpirySweep.runOnce(tenantA);
    return { order, payment };
  }

  /**
   * An expired TOP-UP transfer the customer signalled: no order, 75,000 IRT.
   *
   * Written as the rows a top-up leaves, because a top-up's route and presets are a
   * different suite's subject; the lane only asks that it be an expired manual transfer
   * somebody vouched for, which is what these three statements make true.
   */
  async function expiredTopup(): Promise<PaymentId> {
    const id = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO payments (id, tenant_id, customer_id, order_id, method, amount, currency,
                            reference, expires_at, created_at, updated_at)
      VALUES (${id}, ${tenantA.tenantId}, ${customerA}, NULL, 'MANUAL_TRANSFER', 75000, 'IRT',
              ${`TOPUP-${id.slice(0, 8)}`}, now() - interval '1 hour', now(), now())`);
    await ctx.container.database.db.execute(
      sql`UPDATE payments SET customer_signalled_at = now() WHERE id = ${id}`,
    );
    await ctx.container.paymentExpirySweep.runOnce(tenantA);
    expect(await stateOf('payments', id)).toBe('EXPIRED');
    return id as PaymentId;
  }

  async function receiptFor(paymentId: string): Promise<void> {
    await ctx.container.database.db.execute(sql`
      INSERT INTO payment_receipts (id, tenant_id, bot_instance_id, customer_id, payment_id,
                                    kind, file_id, file_unique_id)
      VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, ${BOT_A}, ${customerA},
              ${paymentId}, 'PHOTO', 'fixture-file-id', ${`fixture-${paymentId.slice(0, 8)}`})`);
  }

  const credit = (paymentId: string, idempotencyKey: string = key()) =>
    ctx.container.lateTransfers.credit(tenantA, owner, paymentId, { idempotencyKey });

  const dismiss = (paymentId: string, idempotencyKey: string = key()) =>
    ctx.container.lateTransfers.dismiss(tenantA, owner, paymentId, {
      idempotencyKey,
      reason: 'AMOUNT_UNDERPAID',
      note: 'فقط نیمی از مبلغ رسید',
    });

  async function view(paymentId: string) {
    const payment = await ctx.container.payments.get(tenantA, owner, paymentId);
    const views = await ctx.container.lateTransfers.viewsFor(tenantA, owner, [payment]);
    const found = views.get(payment.id);
    if (found === undefined) throw new Error('no view for the payment');
    return found;
  }

  async function laneIds(lateReview = true): Promise<string[]> {
    const page = await ctx.container.payments.list(tenantA, owner, { search: { lateReview } });
    return page.items.map((payment) => payment.id);
  }

  const lateEntries = (paymentId: string) =>
    rows<Record<string, unknown>>(
      sql`SELECT direction, amount::text AS amount, currency, reference, order_id, payment_id,
                 actor_admin_id
            FROM wallet_entries WHERE reason = 'LATE_TRANSFER' AND payment_id = ${paymentId}`,
    );

  async function balance(): Promise<bigint> {
    return (await ctx.container.wallet.balance(tenantA, owner, customerA)).amountMinor;
  }

  async function stateOf(table: 'payments' | 'orders', id: string): Promise<string> {
    const query =
      table === 'payments'
        ? sql`SELECT state FROM payments WHERE id = ${id}`
        : sql`SELECT state FROM orders WHERE id = ${id}`;
    return (await rows<{ state: string }>(query))[0]?.state ?? 'MISSING';
  }

  const notified = (kind: string, subjectId: string) =>
    count(
      sql`SELECT count(*)::int AS n FROM customer_notifications
           WHERE kind = ${kind} AND subject_id = ${subjectId}`,
    );

  const walletEvents = (reason: string) =>
    count(
      sql`SELECT count(*)::int AS n FROM outbox_messages
           WHERE event_type = 'WalletEntryRecorded' AND payload->>'reason' = ${reason}`,
    );

  const audited = (action: string) =>
    count(
      sql`SELECT count(*)::int AS n FROM audit_logs
           WHERE action = ${action} AND result = 'SUCCESS'`,
    );

  /**
   * The CONTROLLED interleaving, the shape `resellers.test.ts` uses.
   *
   * The FIRST decision is held inside its own transaction at the moment it reads whether a
   * decision exists — which `lockEligible` does only after `findByIdForUpdate` — so it
   * holds the payment row's lock while it waits. The second is then started and must be
   * seen WAITING on a lock in `pg_stat_activity`, on its own `FOR UPDATE` of the payment,
   * before the first is released. It can therefore only read the decision after the
   * first has committed it.
   */
  async function heldInsideTheLock() {
    const decisions = (ctx.container.lateTransfers as unknown as { deps: LateTransferServiceDeps })
      .deps.decisions;
    const original = decisions.findDecision.bind(decisions);
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    let calls = 0;
    vi.spyOn(decisions, 'findDecision').mockImplementation(async (...args) => {
      calls += 1;
      if (calls === 1) {
        entered();
        await gate;
      }
      return original(...args);
    });
    return {
      inside,
      release: open,
      secondWaitsOnThePayment: async () => {
        const deadline = Date.now() + 5_000;
        for (;;) {
          const waiting = await rows<{ query: string }>(sql`
            SELECT query FROM pg_stat_activity
             WHERE datname = current_database() AND wait_event_type = 'Lock'
               AND pid <> pg_backend_pid()`);
          if (waiting.length >= 1) {
            expect(waiting[0]?.query.toLowerCase()).toContain('from "payments"');
            expect(waiting[0]?.query.toLowerCase()).toContain('for update');
            break;
          }
          if (Date.now() > deadline) throw new Error('the second decision never waited');
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(calls, 'the second has read no decision yet').toBe(1);
      },
    };
  }
});
