import { sql } from 'drizzle-orm';
import type { ProductCategoryId } from '@nexa/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COMMERCE_ERROR_CODES,
  PLATFORM_ERROR_CODES,
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
import { DrizzleWalletRepository } from '../../apps/api/src/modules/commerce/wallet/infrastructure/drizzle-wallet.repository';
import type { OrderRecord } from '../../apps/api/src/modules/commerce/orders/application/ports';
import type { PaymentServiceDeps } from '../../apps/api/src/modules/commerce/payments/application/payment.service';
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
 * A card-to-card receipt under Payment File 02: it never expires (§9, D1), and it leaves
 * review through exactly one of three dispositions — approve, reject, or credit to the
 * wallet (§11, §12, D2). `docs/payments-file02-design.md` is the design.
 *
 * Every race here is PRODUCED, never hoped for: one command is held inside its own
 * transaction just after the write that takes the payment's row, the other is started
 * and seen WAITING on that row in `pg_stat_activity`, and only then is the first
 * released. A `Promise.all` of two commands proves nothing — see the header of
 * `financial-concurrency.test.ts`.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

describe('a submitted receipt and its three dispositions', () => {
  let ctx: TestContext;
  let products: DrizzleProductRepository;
  let wallet: DrizzleWalletRepository;
  let panelA: string;
  let customerA: UserId;
  /** `owner`: every key, both of the credit's included. */
  let owner: ActorContext;
  /** `finance`: `receipts.review` and `users.wallet.credit`. */
  let finance: ActorContext;
  let finance2: ActorContext;
  /** `receipt_reviewer`: `receipts.review` and NOT `users.wallet.credit`. */
  let reviewer: ActorContext;
  let n = 0;
  const key = (): string => `disp-key-${String((n += 1))}`;

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
    wallet = new DrizzleWalletRepository(ctx.container.database.db);
    panelA = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelA}, ${tenantA.tenantId}, 'Panel A', 'sanaei', 'https://a.example.test', 'ACTIVE')`);
    await makePanelSellable(ctx.container, tenantA, panelA);
    const resolved = await ctx.container.customers.resolveFromUpdate(tenantA, systemActor('r'), {
      idempotencyKey: 'resolve-dispositions',
      telegramUserId: '930930',
      from: { id: 930930, first_name: 'زهرا' },
      botInstanceId: BOT_A,
    });
    customerA = resolved.customer.id;
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-disp', roleKeys: ['owner'] }),
    );
    finance = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'finance-disp',
        roleKeys: ['finance'],
      }),
    );
    finance2 = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'finance-disp-2',
        roleKeys: ['finance'],
      }),
    );
    reviewer = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'reviewer-disp',
        roleKeys: ['receipt_reviewer'],
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  async function awaitingPayment(k: string): Promise<OrderRecord> {
    const created = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن پایه',
        description: null,
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

  /** A pending transfer for a fresh order, with `receipts` receipts on file. */
  async function receipted(
    k: string,
    receipts = 1,
  ): Promise<{ order: OrderRecord; paymentId: PaymentId }> {
    const order = await awaitingPayment(k);
    const { payment } = await ctx.container.payments.requestManualTransfer(
      tenantA,
      systemActor(k),
      customerA,
      { idempotencyKey: `${k}-manual`, orderId: order.id },
    );
    await fileReceipts(payment.id, k, receipts);
    return { order, paymentId: payment.id };
  }

  async function fileReceipts(paymentId: PaymentId, k: string, receipts: number): Promise<void> {
    if (receipts === 0) return;
    await ctx.container.payments.signalTransferSent(tenantA, systemActor(k), customerA, {
      idempotencyKey: `${k}-signal`,
      paymentId,
      botInstanceId: BOT_A,
    });
    for (let index = 0; index < receipts; index += 1) {
      await ctx.container.receipts.submit(tenantA, systemActor(k), customerA, {
        idempotencyKey: `${k}-file-${String(index)}`,
        botInstanceId: BOT_A,
        file: {
          kind: 'PHOTO',
          fileId: `file-${k}-${String(index)}`,
          fileUniqueId: `u-${k}-${String(index)}`,
          mimeType: null,
          fileSize: 2_048n,
          fileName: null,
          telegramMessageId: BigInt(100 + index),
          caption: index === 0 ? 'از کارت همسرم واریز شد' : null,
        },
      });
    }
  }

  const credit = (
    actor: ActorContext,
    paymentId: string,
    amountMinor: bigint,
    idempotencyKey = key(),
    note: string | null = null,
  ) =>
    ctx.container.receiptDispositions.creditToWallet(tenantA, actor, {
      idempotencyKey,
      paymentId,
      amountMinor,
      note,
    });

  const approve = (actor: ActorContext, paymentId: string, idempotencyKey = key()) =>
    ctx.container.payments.confirmManualTransfer(tenantA, actor, paymentId, {
      idempotencyKey,
      note: 'واریز رسید',
    });

  const reject = (actor: ActorContext, paymentId: string, idempotencyKey = key()) =>
    ctx.container.payments.rejectManualTransfer(tenantA, actor, paymentId, {
      idempotencyKey,
      note: 'واریزی پیدا نشد',
    });

  async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
    return ((await ctx.container.database.db.execute(query as never)) as unknown as { rows: T[] })
      .rows;
  }

  const paymentRow = async (id: string) =>
    (
      await rows<{
        state: string;
        resolved_by_admin_id: string | null;
        resolution_note: string | null;
        confirmed_at: string | null;
      }>(
        sql`SELECT state, resolved_by_admin_id, resolution_note, confirmed_at::text AS confirmed_at
              FROM payments WHERE id = ${id}`,
      )
    )[0];

  const orderState = async (id: string) =>
    (await rows<{ state: string }>(sql`SELECT state FROM orders WHERE id = ${id}`))[0]?.state;

  const ledger = (reason: string) =>
    rows<{ amount: string; reference: string; payment_id: string; actor_admin_id: string | null }>(
      sql`SELECT amount::text AS amount, reference, payment_id, actor_admin_id
            FROM wallet_entries WHERE reason = ${reason} ORDER BY created_at, id`,
    );

  const credits = () =>
    rows<{ payment_id: string; amount: string; decided_by_admin_id: string; note: string | null }>(
      sql`SELECT payment_id, amount::text AS amount, decided_by_admin_id, note
            FROM receipt_credits ORDER BY decided_at`,
    );

  const notices = (kind: string) =>
    rows<{ subject_id: string }>(
      sql`SELECT subject_id FROM customer_notifications WHERE kind = ${kind}`,
    );

  const audits = (action: string, result = 'SUCCESS') =>
    rows<{ entity_id: string | null }>(
      sql`SELECT entity_id FROM audit_logs WHERE action = ${action} AND result = ${result}`,
    );

  const balance = async () =>
    (await ctx.container.wallet.balance(tenantA, owner, customerA)).amountMinor;

  /** The database's own refusal, under whatever the driver wrapped it in. */
  async function refusedWith(work: Promise<unknown>, pattern: RegExp): Promise<void> {
    const error = await work.then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error, 'the database accepted it').not.toBeNull();
    let message = '';
    for (let at: unknown = error, depth = 0; at instanceof Error && depth < 5; depth += 1) {
      message += ` ${at.message}`;
      at = (at as { cause?: unknown }).cause;
    }
    expect(message).toMatch(pattern);
  }

  /** Backdates both deadlines, which is what an hour passing does. */
  async function backdate(paymentId: string, orderId: string): Promise<void> {
    await ctx.container.database.db.execute(
      sql`UPDATE payments SET expires_at = now() - interval '1 hour' WHERE id = ${paymentId}`,
    );
    await ctx.container.database.db.execute(
      sql`UPDATE orders SET expires_at = now() - interval '1 hour' WHERE id = ${orderId}`,
    );
  }

  /**
   * Holds the FIRST call of one of the payment repository's writes inside its caller's
   * transaction, just after it returned — the row is locked and nothing has committed.
   * The same instance serves `PaymentService` and `ReceiptDispositionService`.
   */
  function holdAfter<K extends 'confirm' | 'resolve'>(method: K) {
    const repository = (ctx.container.payments as unknown as { deps: PaymentServiceDeps }).deps
      .repository;
    const original = repository[method].bind(repository) as (...args: unknown[]) => unknown;
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    let calls = 0;
    vi.spyOn(repository, method).mockImplementation((async (...args: unknown[]) => {
      const result = await original(...args);
      calls += 1;
      if (calls === 1) {
        entered();
        await gate;
      }
      return result;
    }) as never);
    return { inside, release: open };
  }

  /** Waits until another session is seen blocked on a lock, running `fragment`. */
  async function awaitWaitingOn(fragment: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const waiting = await rows<{ query: string }>(
        sql`SELECT query FROM pg_stat_activity
             WHERE datname = current_database() AND wait_event_type = 'Lock'
               AND pid <> pg_backend_pid()`,
      );
      if (waiting.length >= 1) {
        expect(waiting[0]?.query.toLowerCase()).toContain(fragment);
        return;
      }
      if (Date.now() > deadline) throw new Error(`nothing ever waited on ${fragment}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  // =========================================================================
  // §9 — a submitted receipt never expires (D1)
  // =========================================================================

  describe('a receipt has no timer (§9, D1)', () => {
    it('keeps a receipted transfer and its order open through the sweep', async () => {
      const { order, paymentId } = await receipted('d1-1');
      // The customer's own caption is kept for the reviewer (D3), exactly as normalised.
      expect(
        await rows<{ caption: string | null }>(
          sql`SELECT caption FROM payment_receipts WHERE payment_id = ${paymentId}`,
        ),
      ).toEqual([{ caption: 'از کارت همسرم واریز شد' }]);
      await backdate(paymentId, order.id);

      const report = await ctx.container.paymentExpirySweep.runOnce(tenantA);

      expect(report).toEqual({ payments: 0, orders: 0, usernameHolds: 0 });
      expect((await paymentRow(paymentId))?.state).toBe('PENDING');
      expect(await orderState(order.id)).toBe('AWAITING_PAYMENT');
      expect(await notices('PAYMENT_EXPIRED')).toEqual([]);
      // And a second pass an hour later decides nothing either.
      expect(await ctx.container.paymentExpirySweep.runOnce(tenantA)).toEqual({
        payments: 0,
        orders: 0,
        usernameHolds: 0,
      });
    });

    it('keeps the username hold, and a late approval provisions under that very name', async () => {
      const { order, paymentId } = await receipted('d1-2');
      const [held] = await rows<{ username: string; expires_at: string }>(
        sql`SELECT username, expires_at::text AS expires_at
              FROM service_username_reservations WHERE order_id = ${order.id}`,
      );
      expect(held, 'the order went through the real flow and holds a name').toBeDefined();
      await backdate(paymentId, order.id);
      // The hold's own deadline passed too: this is the state the sweep deletes a hold in.
      await ctx.container.database.db.execute(
        sql`UPDATE service_username_reservations SET expires_at = now() - interval '1 hour'
             WHERE order_id = ${order.id}`,
      );

      const report = await ctx.container.paymentExpirySweep.runOnce(tenantA);
      expect(report.usernameHolds, 'the hold of an order awaiting review stays').toBe(0);

      const { payment } = await approve(finance, paymentId);
      expect(payment.state).toBe('CONFIRMED');
      expect(await orderState(order.id)).toBe('PAID');
      const [service] = await rows<{ provider_username: string }>(
        sql`SELECT provider_username FROM services WHERE order_id = ${order.id}`,
      );
      expect(service?.provider_username, 'the name the customer was holding').toBe(held?.username);
    });

    it('still sweeps an abandoned draft’s expired hold', async () => {
      // A draft that never became an order: the sweep's own population, unchanged.
      const created = await products.create(tenantA, {
        id: ctx.container.ids.uuid() as ProductId,
        draft: {
          title: 'پلن',
          description: null,
          audience: 'EVERYONE',
          sortOrder: 10,
          panelId: panelA as PanelId,
          categoryId: SEED_IDS.categoryA as ProductCategoryId,
          specification: { durationDays: 30, trafficBytes: 1_073_741_824n, deviceLimit: 1 },
          price: money(250_000n, 'IRT'),
        },
        now: ctx.container.clock.now(),
      });
      await products.setStatus(
        tenantA,
        created.id,
        'INACTIVE',
        'ACTIVE',
        ctx.container.clock.now(),
      );
      const draft = await ctx.container.orders.createDraft(tenantA, systemActor('d1-3'), {
        idempotencyKey: 'd1-3-draft',
        customerId: customerA,
        productId: created.id,
      });
      await ctx.container.orders.chooseUsername(tenantA, systemActor('d1-3c'), {
        idempotencyKey: 'd1-3-choose',
        customerId: customerA,
        orderId: draft.id,
        choice: { mode: 'AUTOMATIC' },
      });
      const before = await rows<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM service_username_reservations WHERE order_id = ${draft.id}`,
      );
      expect(before[0]?.n, 'the draft holds a name').toBe(1);
      await ctx.container.database.db.execute(
        sql`UPDATE service_username_reservations SET expires_at = now() - interval '1 hour'`,
      );
      expect((await ctx.container.paymentExpirySweep.runOnce(tenantA)).usernameHolds).toBe(1);
      const after = await rows<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM service_username_reservations WHERE order_id = ${draft.id}`,
      );
      expect(after[0]?.n, 'a DRAFT is not awaiting payment, so its hold still goes').toBe(0);
    });

    it('refuses the customer’s withdrawal of a transfer they sent a receipt for', async () => {
      const { order, paymentId } = await receipted('d1-4');

      await expect(
        ctx.container.payments.withdrawPending(tenantA, systemActor('d1-4w'), customerA, {
          idempotencyKey: 'd1-4-withdraw',
          paymentId,
        }),
      ).rejects.toMatchObject({ code: COMMERCE_ERROR_CODES.ORDER_TRANSFER_UNDER_REVIEW });

      expect((await paymentRow(paymentId))?.state).toBe('PENDING');
      expect(await orderState(order.id)).toBe('AWAITING_PAYMENT');
      expect(await audits('payment.withdraw')).toEqual([]);
    });

    it('still lets the customer withdraw a transfer they only said they sent', async () => {
      const order = await awaitingPayment('d1-5');
      const { payment } = await ctx.container.payments.requestManualTransfer(
        tenantA,
        systemActor('d1-5'),
        customerA,
        { idempotencyKey: 'd1-5-manual', orderId: order.id },
      );
      await ctx.container.payments.signalTransferSent(tenantA, systemActor('d1-5'), customerA, {
        idempotencyKey: 'd1-5-signal',
        paymentId: payment.id,
        botInstanceId: BOT_A,
      });

      const withdrawn = await ctx.container.payments.withdrawPending(
        tenantA,
        systemActor('d1-5w'),
        customerA,
        { idempotencyKey: 'd1-5-withdraw', paymentId: payment.id },
      );
      expect(withdrawn.state).toBe('CANCELLED');
    });

    it('still expires a transfer with no receipt — a signal alone — and says PAYMENT_EXPIRED', async () => {
      const order = await awaitingPayment('d1-6');
      const { payment } = await ctx.container.payments.requestManualTransfer(
        tenantA,
        systemActor('d1-6'),
        customerA,
        { idempotencyKey: 'd1-6-manual', orderId: order.id },
      );
      await ctx.container.payments.signalTransferSent(tenantA, systemActor('d1-6'), customerA, {
        idempotencyKey: 'd1-6-signal',
        paymentId: payment.id,
        botInstanceId: BOT_A,
      });
      await backdate(payment.id, order.id);

      const report = await ctx.container.paymentExpirySweep.runOnce(tenantA);

      expect(report).toMatchObject({ payments: 1, orders: 1 });
      expect((await paymentRow(payment.id))?.state).toBe('EXPIRED');
      expect(await notices('PAYMENT_EXPIRED')).toEqual([{ subject_id: payment.id }]);
    });

    it('hands the receipted transfer back to a customer who asks to pay by transfer again', async () => {
      const { order, paymentId } = await receipted('d1-7');
      // Only the PAYMENT's own window closed; the order's deadline is still ahead.
      await ctx.container.database.db.execute(
        sql`UPDATE payments SET expires_at = now() - interval '1 minute' WHERE id = ${paymentId}`,
      );

      const again = await ctx.container.payments.requestManualTransfer(
        tenantA,
        systemActor('d1-7b'),
        customerA,
        { idempotencyKey: 'd1-7-manual-again', orderId: order.id },
      );

      expect(again.payment.id, 'the one under review, not a second reference').toBe(paymentId);
      expect((await paymentRow(paymentId))?.state).toBe('PENDING');
      expect(await audits('payment.expire')).toEqual([]);
    });
  });

  // =========================================================================
  // §12 — crediting a receipt to the wallet (D2)
  // =========================================================================

  describe('credit to wallet (§12, D2)', () => {
    it('credits exactly the entered amount, fails the payment, and leaves the order open', async () => {
      const { order, paymentId } = await receipted('d2-1');

      const { payment, credit: disposition } = await credit(
        finance,
        paymentId,
        240_000n,
        'd2-1-credit',
        '  ده هزار تومان کمتر رسید  ',
      );

      expect(payment.state).toBe('FAILED');
      expect(disposition).toMatchObject({
        paymentId,
        decidedByAdminId: finance.id,
        note: 'ده هزار تومان کمتر رسید',
      });
      expect(disposition.amount).toEqual(money(240_000n, 'IRT'));
      expect(await paymentRow(paymentId)).toMatchObject({
        state: 'FAILED',
        resolved_by_admin_id: finance.id,
        resolution_note: 'ده هزار تومان کمتر رسید',
        confirmed_at: null,
      });
      // The REVIEWER's figure, not the payment's 250 000, under its own reason.
      expect(await ledger('RECEIPT_CREDIT')).toEqual([
        {
          amount: '240000',
          reference: `${paymentId}:receipt-credit`,
          payment_id: paymentId,
          actor_admin_id: finance.id,
        },
      ]);
      expect(await credits()).toEqual([
        {
          payment_id: paymentId,
          amount: '240000',
          decided_by_admin_id: finance.id,
          note: 'ده هزار تومان کمتر رسید',
        },
      ]);
      expect(await balance()).toBe(240_000n);
      // NOT a settlement: the order is still the customer's to pay or let lapse.
      expect(await orderState(order.id)).toBe('AWAITING_PAYMENT');
      expect(await ledger('TOPUP_RECEIPT')).toEqual([]);
      expect(await notices('RECEIPT_CREDITED_TO_WALLET')).toEqual([{ subject_id: paymentId }]);
      expect(await notices('PAYMENT_REJECTED')).toEqual([]);
      expect(await audits('payment.receipt_credit')).toEqual([{ entity_id: paymentId }]);
      const events = await rows<{ reason: string; amount: string }>(
        sql`SELECT payload->>'reason' AS reason, payload->>'amountMinor' AS amount
              FROM outbox_messages WHERE event_type = 'WalletEntryRecorded'
                AND payload->>'reason' = 'RECEIPT_CREDIT'`,
      );
      expect(events).toEqual([{ reason: 'RECEIPT_CREDIT', amount: '240000' }]);
    });

    it('lets the customer pay the still-open order from the credited wallet', async () => {
      const { order, paymentId } = await receipted('d2-2');
      await credit(finance, paymentId, 250_000n);

      const { order: paid } = await ctx.container.payments.settleFromWallet(
        tenantA,
        systemActor('d2-2p'),
        customerA,
        { idempotencyKey: 'd2-2-pay', orderId: order.id },
      );

      expect(paid.state).toBe('PAID');
      expect(await balance()).toBe(0n);
    });

    it('answers a replay with the first result, and refuses a different amount under the key', async () => {
      const { paymentId } = await receipted('d2-3');
      const first = await credit(finance, paymentId, 100_000n, 'd2-3-credit');
      const again = await credit(finance, paymentId, 100_000n, 'd2-3-credit');

      expect(again.credit).toEqual(first.credit);
      expect(await ledger('RECEIPT_CREDIT')).toHaveLength(1);
      expect(await notices('RECEIPT_CREDITED_TO_WALLET')).toHaveLength(1);

      await expect(credit(finance, paymentId, 100_001n, 'd2-3-credit')).rejects.toMatchObject({
        code: PLATFORM_ERROR_CODES.IDEMPOTENCY_PAYLOAD_MISMATCH,
      });
      expect(await ledger('RECEIPT_CREDIT')).toHaveLength(1);
      expect(await balance()).toBe(100_000n);
    });

    it('refuses a reviewer without users.wallet.credit, who can still approve', async () => {
      const { paymentId } = await receipted('d2-4');

      await expect(credit(reviewer, paymentId, 250_000n)).rejects.toMatchObject({
        code: PLATFORM_ERROR_CODES.PERMISSION_DENIED,
        details: { permission: 'users.wallet.credit' },
      });
      expect(await ledger('RECEIPT_CREDIT')).toEqual([]);
      expect((await paymentRow(paymentId))?.state).toBe('PENDING');
      expect(await audits('payment.receipt_credit', 'DENIED')).toEqual([{ entity_id: paymentId }]);

      // The SAME reviewer approves the same receipt: the separation is the credit's.
      const { payment } = await approve(reviewer, paymentId);
      expect(payment.state).toBe('CONFIRMED');
    });

    it('refuses an operator who may credit wallets but not review receipts', async () => {
      const { paymentId } = await receipted('d2-5');
      const roleId = ctx.container.ids.uuid();
      await ctx.container.database.db.execute(sql`
        INSERT INTO roles (id, tenant_id, key, name, is_system)
        VALUES (${roleId}, ${tenantA.tenantId}, 'wallet_only', 'Wallet only', false)`);
      await ctx.container.database.db.execute(sql`
        INSERT INTO role_permissions (tenant_id, role_id, permission_key)
        VALUES (${tenantA.tenantId}, ${roleId}, 'users.view'),
               (${tenantA.tenantId}, ${roleId}, 'users.wallet.credit')`);
      const walletOnly = await createAdmin(ctx.container, tenantA, { username: 'wallet-only' });
      await ctx.container.database.db.execute(sql`
        INSERT INTO admin_roles (tenant_id, admin_id, role_id)
        VALUES (${tenantA.tenantId}, ${walletOnly.id}, ${roleId})`);

      await expect(credit(adminActorFor(walletOnly), paymentId, 250_000n)).rejects.toMatchObject({
        code: PLATFORM_ERROR_CODES.PERMISSION_DENIED,
        details: { permission: 'receipts.review' },
      });
      expect(await ledger('RECEIPT_CREDIT')).toEqual([]);
    });

    it('refuses a transfer with no receipt, a wallet payment, and an amount out of bounds', async () => {
      const order = await awaitingPayment('d2-6');
      const { payment } = await ctx.container.payments.requestManualTransfer(
        tenantA,
        systemActor('d2-6'),
        customerA,
        { idempotencyKey: 'd2-6-manual', orderId: order.id },
      );
      await expect(credit(finance, payment.id, 250_000n)).rejects.toMatchObject({
        code: COMMERCE_ERROR_CODES.PAYMENT_STATE_INVALID,
        details: { reason: 'NO_RECEIPT' },
      });

      const { paymentId } = await receipted('d2-6b');
      for (const amount of [0n, -1n, 1_000_000_000_001n]) {
        await expect(credit(finance, paymentId, amount), String(amount)).rejects.toMatchObject({
          code: COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        });
      }
      expect(await ledger('RECEIPT_CREDIT')).toEqual([]);
      expect((await paymentRow(paymentId))?.state).toBe('PENDING');
    });

    it('cannot reach another tenant’s payment, and decides nothing for a stopped tenant', async () => {
      const { paymentId } = await receipted('d2-7');
      const ownerB = adminActorFor(
        await createAdmin(ctx.container, tenantB, {
          username: 'owner-disp-b',
          roleKeys: ['owner'],
        }),
      );
      await expect(
        ctx.container.receiptDispositions.creditToWallet(tenantB, ownerB, {
          idempotencyKey: 'd2-7-foreign',
          paymentId,
          amountMinor: 250_000n,
        }),
      ).rejects.toMatchObject({ code: COMMERCE_ERROR_CODES.PAYMENT_NOT_FOUND });

      await ctx.container.database.db.execute(
        sql`UPDATE tenants SET status = 'STOPPED' WHERE id = ${tenantA.tenantId}`,
      );
      await expect(credit(finance, paymentId, 250_000n)).rejects.toMatchObject({
        code: COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
      });
      await ctx.container.database.db.execute(
        sql`UPDATE tenants SET status = 'ACTIVE' WHERE id = ${tenantA.tenantId}`,
      );
      expect(await ledger('RECEIPT_CREDIT')).toEqual([]);
      expect((await paymentRow(paymentId))?.state).toBe('PENDING');
    });

    it('earns no top-up gift: a credited top-up receipt is not a top-up', async () => {
      await ctx.container.paymentGateways.configure(tenantA, owner, {
        idempotencyKey: 'd2-8-gift',
        provider: 'MANUAL_TRANSFER',
        config: {
          displayName: null,
          instructions: null,
          minAmountMinor: 0n,
          maxAmountMinor: 0n,
          eligibility: {
            activateAfterPayments: 0,
            deactivateAfterPayments: 0,
            activateAfterAccountDays: 0,
          },
          sortOrder: 0,
          topupCashbackPercent: 10,
        },
      });
      await ctx.container.database.db.execute(sql`
        INSERT INTO setting_values (id, tenant_id, setting_key, value, version, updated_at)
        VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, 'wallet.topup.presets',
                ${JSON.stringify([{ amountMinor: '500000', currency: 'IRT' }])}::jsonb, 1, now())
        ON CONFLICT (tenant_id, setting_key) DO UPDATE SET value = EXCLUDED.value`);
      const amount = money(500_000n, 'IRT');
      const { payment } = await ctx.container.payments.requestWalletTopup(
        tenantA,
        systemActor('d2-8'),
        customerA,
        { idempotencyKey: 'd2-8-topup', amountMinor: amount.amountMinor },
      );
      expect(payment.topupCashbackPercent).toBe(10);
      await fileReceipts(payment.id, 'd2-8', 1);

      await credit(finance, payment.id, amount.amountMinor);

      expect(await ledger('RECEIPT_CREDIT')).toHaveLength(1);
      expect(await ledger('CASHBACK_TOPUP'), 'no gift on a manual credit').toEqual([]);
      expect(await ledger('TOPUP_RECEIPT')).toEqual([]);
      expect(await notices('WALLET_TOPUP_GIFT_CREDITED')).toEqual([]);
    });

    it('shows the disposition to a reader, and refuses it without payments.view', async () => {
      const { paymentId } = await receipted('d2-9');
      await credit(finance, paymentId, 230_000n);
      const read = await ctx.container.receiptDispositions.creditFor(tenantA, reviewer, paymentId);
      expect(read?.amount).toEqual(money(230_000n, 'IRT'));

      const technical = adminActorFor(
        await createAdmin(ctx.container, tenantA, {
          username: 'tech-disp',
          roleKeys: ['technical'],
        }),
      );
      await expect(
        ctx.container.receiptDispositions.creditFor(tenantA, technical, paymentId),
      ).rejects.toMatchObject({ code: PLATFORM_ERROR_CODES.PERMISSION_DENIED });
    });
  });

  // =========================================================================
  // §11 — the three are mutually exclusive, in sequence and in a race
  // =========================================================================

  describe('mutual exclusion (§11, invariant 7)', () => {
    it('refuses a rejection and an approval after a credit, as already resolved', async () => {
      const { order, paymentId } = await receipted('x-1');
      await credit(finance, paymentId, 250_000n);

      await expect(reject(finance2, paymentId)).rejects.toMatchObject({
        code: COMMERCE_ERROR_CODES.PAYMENT_STATE_INVALID,
        details: { state: 'FAILED', disposition: 'CREDITED_TO_WALLET' },
      });
      await expect(approve(finance2, paymentId)).rejects.toMatchObject({
        code: COMMERCE_ERROR_CODES.PAYMENT_STATE_INVALID,
        details: { state: 'FAILED' },
      });
      expect(await notices('PAYMENT_REJECTED')).toEqual([]);
      expect(await orderState(order.id)).toBe('AWAITING_PAYMENT');
      expect(await balance()).toBe(250_000n);
    });

    it('refuses a credit after an approval and after a rejection', async () => {
      const approved = await receipted('x-2a');
      await approve(finance, approved.paymentId);
      await expect(credit(finance2, approved.paymentId, 250_000n)).rejects.toMatchObject({
        code: COMMERCE_ERROR_CODES.PAYMENT_STATE_INVALID,
        details: { state: 'CONFIRMED' },
      });

      const rejected = await receipted('x-2r');
      await reject(finance, rejected.paymentId);
      await expect(credit(finance2, rejected.paymentId, 250_000n)).rejects.toMatchObject({
        code: COMMERCE_ERROR_CODES.PAYMENT_STATE_INVALID,
        details: { state: 'FAILED' },
      });
      expect(await ledger('RECEIPT_CREDIT')).toEqual([]);
      expect(await credits()).toEqual([]);
    });

    it('races approve against approve: one confirmation, one settlement', async () => {
      const { order, paymentId } = await receipted('r-aa');
      const held = holdAfter('confirm');

      const first = approve(finance, paymentId);
      first.catch(() => undefined);
      await held.inside;
      const second = approve(finance2, paymentId);
      second.catch(() => undefined);
      await awaitWaitingOn('update "payments"');
      held.release();

      const [a, b] = await Promise.allSettled([first, second]);
      expect(a.status).toBe('fulfilled');
      // The loser is answered with the end state it asked for, and adds nothing.
      expect(b).toMatchObject({ status: 'fulfilled', value: { payment: { state: 'CONFIRMED' } } });
      expect(await orderState(order.id)).toBe('PAID');
      const settled = await rows<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM outbox_messages WHERE event_type = 'OrderSettled'`,
      );
      expect(settled[0]?.n).toBe(1);
      expect(await audits('payment.confirm')).toHaveLength(1);
    }, 30_000);

    it('races approve against reject: the approval wins, the rejection changes nothing', async () => {
      const { order, paymentId } = await receipted('r-ar');
      const held = holdAfter('confirm');

      const approving = approve(finance, paymentId);
      approving.catch(() => undefined);
      await held.inside;
      const rejecting = reject(finance2, paymentId);
      rejecting.catch(() => undefined);
      await awaitWaitingOn('update "payments"');
      held.release();

      const [a, r] = await Promise.allSettled([approving, rejecting]);
      expect(a.status).toBe('fulfilled');
      expect(r).toMatchObject({
        status: 'rejected',
        reason: { code: COMMERCE_ERROR_CODES.PAYMENT_STATE_INVALID },
      });
      expect((await paymentRow(paymentId))?.state).toBe('CONFIRMED');
      expect(await orderState(order.id)).toBe('PAID');
      expect(await notices('PAYMENT_REJECTED')).toEqual([]);
      expect(await audits('payment.reject')).toEqual([]);
    }, 30_000);

    it('races approve against credit: the approval wins, nothing is credited', async () => {
      const { order, paymentId } = await receipted('r-ac');
      const held = holdAfter('confirm');

      const approving = approve(finance, paymentId);
      approving.catch(() => undefined);
      await held.inside;
      const crediting = credit(finance2, paymentId, 250_000n);
      crediting.catch(() => undefined);
      await awaitWaitingOn('for update');
      held.release();

      const [a, c] = await Promise.allSettled([approving, crediting]);
      expect(a.status).toBe('fulfilled');
      expect(c).toMatchObject({
        status: 'rejected',
        reason: {
          code: COMMERCE_ERROR_CODES.PAYMENT_STATE_INVALID,
          details: { state: 'CONFIRMED' },
        },
      });
      expect(await orderState(order.id)).toBe('PAID');
      expect(await ledger('RECEIPT_CREDIT')).toEqual([]);
      expect(await credits()).toEqual([]);
      expect(await notices('RECEIPT_CREDITED_TO_WALLET')).toEqual([]);
      expect(await balance()).toBe(0n);
    }, 30_000);

    it('races credit against approve: the credit wins, the order is not settled', async () => {
      const { order, paymentId } = await receipted('r-ca');
      const held = holdAfter('resolve');

      const crediting = credit(finance, paymentId, 250_000n);
      crediting.catch(() => undefined);
      await held.inside;
      const approving = approve(finance2, paymentId);
      approving.catch(() => undefined);
      await awaitWaitingOn('update "payments"');
      held.release();

      const [c, a] = await Promise.allSettled([crediting, approving]);
      expect(c.status).toBe('fulfilled');
      expect(a).toMatchObject({
        status: 'rejected',
        reason: { code: COMMERCE_ERROR_CODES.PAYMENT_STATE_INVALID, details: { state: 'FAILED' } },
      });
      expect(await orderState(order.id)).toBe('AWAITING_PAYMENT');
      expect(await ledger('RECEIPT_CREDIT')).toHaveLength(1);
      const settled = await rows<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM outbox_messages WHERE event_type = 'OrderSettled'`,
      );
      expect(settled[0]?.n).toBe(0);
    }, 30_000);

    it('races reject against credit: the rejection wins, nothing is credited', async () => {
      const { paymentId } = await receipted('r-rc');
      const held = holdAfter('resolve');

      const rejecting = reject(finance, paymentId);
      rejecting.catch(() => undefined);
      await held.inside;
      const crediting = credit(finance2, paymentId, 250_000n);
      crediting.catch(() => undefined);
      await awaitWaitingOn('for update');
      held.release();

      const [r, c] = await Promise.allSettled([rejecting, crediting]);
      expect(r.status).toBe('fulfilled');
      expect(c).toMatchObject({
        status: 'rejected',
        reason: { code: COMMERCE_ERROR_CODES.PAYMENT_STATE_INVALID, details: { state: 'FAILED' } },
      });
      expect(await ledger('RECEIPT_CREDIT')).toEqual([]);
      expect(await credits()).toEqual([]);
      expect(await notices('PAYMENT_REJECTED')).toEqual([{ subject_id: paymentId }]);
    }, 30_000);

    it('races credit against reject: the credit wins, nothing is rejected', async () => {
      const { paymentId } = await receipted('r-cr');
      const held = holdAfter('resolve');

      const crediting = credit(finance, paymentId, 250_000n);
      crediting.catch(() => undefined);
      await held.inside;
      const rejecting = reject(finance2, paymentId);
      rejecting.catch(() => undefined);
      await awaitWaitingOn('update "payments"');
      held.release();

      const [c, r] = await Promise.allSettled([crediting, rejecting]);
      expect(c.status).toBe('fulfilled');
      expect(r).toMatchObject({
        status: 'rejected',
        reason: { code: COMMERCE_ERROR_CODES.PAYMENT_STATE_INVALID },
      });
      expect(await ledger('RECEIPT_CREDIT')).toHaveLength(1);
      expect(await notices('PAYMENT_REJECTED')).toEqual([]);
      expect(await audits('payment.reject')).toEqual([]);
    }, 30_000);

    it('races credit against credit: one credit, the second is told it was already credited', async () => {
      const { paymentId } = await receipted('r-cc');
      const held = holdAfter('resolve');

      const first = credit(finance, paymentId, 250_000n);
      first.catch(() => undefined);
      await held.inside;
      // A DIFFERENT figure from a different reviewer: whatever it says, it must not land.
      const second = credit(finance2, paymentId, 200_000n);
      second.catch(() => undefined);
      await awaitWaitingOn('for update');
      held.release();

      const [a, b] = await Promise.allSettled([first, second]);
      expect(a.status).toBe('fulfilled');
      expect(b).toMatchObject({
        status: 'rejected',
        reason: {
          code: COMMERCE_ERROR_CODES.PAYMENT_STATE_INVALID,
          details: { state: 'FAILED', disposition: 'CREDITED_TO_WALLET' },
        },
      });
      expect(await ledger('RECEIPT_CREDIT')).toHaveLength(1);
      expect(await credits()).toMatchObject([
        { amount: '250000', decided_by_admin_id: finance.id },
      ]);
      expect(await notices('RECEIPT_CREDITED_TO_WALLET')).toHaveLength(1);
      expect(await balance()).toBe(250_000n);
    }, 30_000);
  });

  // =========================================================================
  // The database, for a writer that skipped the service (invariant 8)
  // =========================================================================

  describe('the database backstops', () => {
    async function creditedPayment(k: string): Promise<PaymentId> {
      const { paymentId } = await receipted(k);
      await credit(finance, paymentId, 250_000n);
      return paymentId;
    }

    it('refuses a second RECEIPT_CREDIT ledger entry for one payment, under any reference', async () => {
      const paymentId = await creditedPayment('db-1');
      await refusedWith(
        wallet.append(tenantA, {
          id: ctx.container.ids.uuid(),
          customerId: customerA,
          direction: 'CREDIT',
          reason: 'RECEIPT_CREDIT',
          amount: money(1n, 'IRT'),
          reference: 'some-other-reference',
          paymentId,
          now: ctx.container.clock.now(),
        }),
        /wallet_entries_receipt_credit_payment_key/u,
      );
      expect(await ledger('RECEIPT_CREDIT')).toHaveLength(1);
    });

    it('refuses a RECEIPT_CREDIT that names no payment', async () => {
      await refusedWith(
        wallet.append(tenantA, {
          id: ctx.container.ids.uuid(),
          customerId: customerA,
          direction: 'CREDIT',
          reason: 'RECEIPT_CREDIT',
          amount: money(1n, 'IRT'),
          reference: 'orphan-receipt-credit',
          now: ctx.container.clock.now(),
        }),
        /wallet_entries_receipt_credit_payment_check/u,
      );
    });

    it('refuses UPDATE and DELETE on a disposition, and a second one for the payment', async () => {
      const paymentId = await creditedPayment('db-2');
      await refusedWith(
        ctx.container.database.db.execute(
          sql`UPDATE receipt_credits SET amount = 1 WHERE payment_id = ${paymentId}`,
        ),
        /append-only|not permitted|immutable/iu,
      );
      await refusedWith(
        ctx.container.database.db.execute(
          sql`DELETE FROM receipt_credits WHERE payment_id = ${paymentId}`,
        ),
        /append-only|not permitted|immutable/iu,
      );
      const [entry] = await rows<{ id: string }>(
        sql`SELECT id FROM wallet_entries WHERE reason = 'RECEIPT_CREDIT'`,
      );
      await refusedWith(
        ctx.container.database.db.execute(sql`
          INSERT INTO receipt_credits (tenant_id, payment_id, amount, currency, wallet_entry_id,
                                       decided_by_admin_id, decided_at)
          VALUES (${tenantA.tenantId}, ${paymentId}, 250000, 'IRT', ${entry?.id ?? ''},
                  ${finance.id}, now())`),
        /receipt_credits_pkey/u,
      );
    });

    it('refuses a disposition on a payment that is not a FAILED transfer, or of another amount', async () => {
      const { paymentId } = await receipted('db-3');
      // A RECEIPT_CREDIT entry written by hand, with no decision behind it.
      const entryId = ctx.container.ids.uuid();
      await wallet.append(tenantA, {
        id: entryId,
        customerId: customerA,
        direction: 'CREDIT',
        reason: 'RECEIPT_CREDIT',
        amount: money(250_000n, 'IRT'),
        reference: `${paymentId}:receipt-credit`,
        paymentId,
        now: ctx.container.clock.now(),
      });
      const insert = (amount: bigint) =>
        ctx.container.database.db.execute(sql`
          INSERT INTO receipt_credits (tenant_id, payment_id, amount, currency, wallet_entry_id,
                                       decided_by_admin_id, decided_at)
          VALUES (${tenantA.tenantId}, ${paymentId}, ${amount}, 'IRT', ${entryId},
                  ${finance.id}, now())`);

      // Still PENDING: nothing was decided.
      await refusedWith(insert(250_000n), /FAILED manual transfer/u);

      await ctx.container.database.db.execute(sql`
        UPDATE payments SET state = 'FAILED', resolved_at = now(),
                            resolved_by_admin_id = ${finance.id}
         WHERE id = ${paymentId}`);
      // An amount the entry does not hold.
      await refusedWith(insert(249_999n), /RECEIPT_CREDIT credit it wrote/u);
      // And by somebody other than the administrator who resolved the payment.
      await refusedWith(
        ctx.container.database.db.execute(sql`
          INSERT INTO receipt_credits (tenant_id, payment_id, amount, currency, wallet_entry_id,
                                       decided_by_admin_id, decided_at)
          VALUES (${tenantA.tenantId}, ${paymentId}, 250000, 'IRT', ${entryId},
                  ${finance2.id}, now())`),
        /administrator who resolved/u,
      );
      await expect(insert(250_000n)).resolves.toBeDefined();
    });

    it('refuses to delete a payment', async () => {
      const { paymentId } = await receipted('db-4');
      await refusedWith(
        ctx.container.database.db.execute(sql`DELETE FROM payments WHERE id = ${paymentId}`),
        /append-only|not permitted|immutable/iu,
      );
    });
  });
});
