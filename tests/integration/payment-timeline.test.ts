import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  money,
  paymentTimelineResponseSchema,
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
import type { ProductDraft } from '../../apps/api/src/modules/commerce/catalog/application/ports';
import type { OrderRecord } from '../../apps/api/src/modules/commerce/orders/application/ports';
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
 * The payment timeline (WP17, `docs/wp17-payment-phase3-audit.md` D1).
 *
 * What each case defends:
 *
 *   - the history is the rows other flows wrote, in time order, and nothing else;
 *   - a section behind another permission is withheld AND named, never silently empty;
 *   - another customer's wallet entry that names this payment is not this payment's;
 *   - the read writes nothing, and one tenant cannot read another's payment.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

describe('payment timeline', () => {
  let ctx: TestContext;
  let products: DrizzleProductRepository;
  let panelA: string;
  let customerA: UserId;
  let owner: ActorContext;
  let ownerB: ActorContext;
  let reviewer: ActorContext;
  let support: ActorContext;

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
    customerA = await customer('950100');
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'owner-timeline',
        roleKeys: ['owner'],
      }),
    );
    ownerB = adminActorFor(
      await createAdmin(ctx.container, tenantB, {
        username: 'owner-timeline-b',
        roleKeys: ['owner'],
      }),
    );
    // `payments.view` and `receipts.view`, but neither `refunds.view` nor `users.view`.
    reviewer = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'reviewer-timeline',
        roleKeys: ['receipt_reviewer'],
      }),
    );
    // `receipts.view` without `payments.view` (OQ-5R-01).
    support = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'support-timeline',
        roleKeys: ['support'],
      }),
    );
  });

  const timeline = (actor: ActorContext, id: string, scope = tenantA) =>
    ctx.container.paymentTimeline.timeline(scope, actor, id);

  it('lists a wallet purchase and two partial refunds in time order, and nothing else', async () => {
    const payment = await walletPayment('w1');
    await refund(owner, payment.id, 50_000n, 'w1-refund-1');
    await refund(owner, payment.id, 70_000n, 'w1-refund-2');

    const view = await timeline(owner, payment.id);

    expect(view.withheld).toEqual([]);
    expect(view.truncated).toBe(false);
    expect(view.entries.map((e) => e.kind)).toEqual([
      'PAYMENT_CREATED',
      'PAYMENT_CONFIRMED',
      'WALLET_ENTRY',
      'REFUND_REQUESTED',
      'REFUND_COMPLETED',
      'CUSTOMER_NOTIFIED',
      'REFUND_REQUESTED',
      'REFUND_COMPLETED',
      'CUSTOMER_NOTIFIED',
    ]);
    // Each partial refund is its own fact, told once (`REFUND_COMPLETED`, subject the refund).
    expect(
      view.entries
        .filter((e) => e.kind === 'CUSTOMER_NOTIFIED')
        .map((e) => ('notificationKind' in e ? e.notificationKind : null)),
    ).toEqual(['REFUND_COMPLETED', 'REFUND_COMPLETED']);
    expect(view.entries[0]).toMatchObject({
      method: 'WALLET',
      amountMinor: '250000',
      currency: 'IRT',
    });
    expect(view.entries[1]).toMatchObject({ evidenceKind: 'WALLET_DEBIT', adminId: null });
    // The purchase debit is this payment's; the two REFUND credits are the refund rows'
    // money and are not repeated as wallet entries.
    expect(view.entries[2]).toMatchObject({
      direction: 'DEBIT',
      reason: 'PURCHASE',
      amountMinor: '250000',
    });
    const refunds = view.entries.filter((e) => e.kind === 'REFUND_COMPLETED');
    expect(refunds.map((e) => ('amountMinor' in e ? e.amountMinor : null))).toEqual([
      '50000',
      '70000',
    ]);
    // Time never goes backwards.
    const times = view.entries.map((e) => Date.parse(e.at));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    // The wire schema accepts what the service produced.
    expect(() =>
      paymentTimelineResponseSchema.parse({
        paymentId: payment.id,
        entries: view.entries,
        withheld: view.withheld,
        truncated: view.truncated,
      }),
    ).not.toThrow();
  });

  it('withholds refunds and wallet movements from a viewer without refunds.view and users.view', async () => {
    const payment = await walletPayment('w2');
    await refund(owner, payment.id, 50_000n, 'w2-refund-1');

    const view = await timeline(reviewer, payment.id);

    expect(view.withheld).toEqual(['REFUNDS', 'WALLET']);
    expect(view.entries.map((e) => e.kind)).toEqual(['PAYMENT_CREATED', 'PAYMENT_CONFIRMED']);
    // Nothing about the refund leaks through another section — not its notification either.
    expect(JSON.stringify(view.entries)).not.toContain('REFUND');
  });

  it("never shows another customer's wallet entry, even one that names this payment", async () => {
    const payment = await walletPayment('w3');
    const referrer = await customer('950199');
    // A referral commission names the referee's payment and lands in the REFERRER's wallet.
    await ctx.container.database.db.execute(sql`
      INSERT INTO wallet_entries (id, tenant_id, customer_id, direction, reason, amount, currency,
                                  reference, payment_id, created_at)
      VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, ${referrer}, 'CREDIT',
              'REFERRAL_COMMISSION', 12500, 'IRT', ${`${payment.id}:referral-test`},
              ${payment.id}, now())`);

    const view = await timeline(owner, payment.id);
    const wallet = view.entries.filter((e) => e.kind === 'WALLET_ENTRY');

    expect(wallet).toHaveLength(1);
    expect(wallet[0]).toMatchObject({ reason: 'PURCHASE' });
  });

  /*
   * `PAYMENT_TRANSFER_RECORDED` is not expected here: it is the lane's FALLBACK for a
   * synchronous reply lost to a 429 (OQ-4H-01), and this signal's reply was not lost.
   */
  it('tells a rejected transfer: created, signalled, receipt, rejected, customer told', async () => {
    const payment = await manualPayment('m1');
    await ctx.container.payments.signalTransferSent(tenantA, systemActor('m1-say'), customerA, {
      idempotencyKey: 'm1-say',
      paymentId: payment.id,
      botInstanceId: BOT_A,
    });
    const receiptId = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO payment_receipts (id, tenant_id, bot_instance_id, customer_id, payment_id, kind,
                                    file_id, file_unique_id, caption, created_at)
      VALUES (${receiptId}, ${tenantA.tenantId}, ${BOT_A}, ${customerA}, ${payment.id}, 'PHOTO',
              'file-m1', 'unique-m1', 'کپشن مشتری', now())`);
    await ctx.container.payments.rejectManualTransfer(tenantA, owner, payment.id, {
      idempotencyKey: 'm1-reject',
      note: 'واریزی پیدا نشد',
    });

    const view = await timeline(owner, payment.id);
    const kinds = view.entries.map((e) => e.kind);

    expect(kinds).toEqual([
      'PAYMENT_CREATED',
      'CUSTOMER_SIGNALLED',
      'RECEIPT_SUBMITTED',
      'PAYMENT_RESOLVED',
      'CUSTOMER_NOTIFIED',
    ]);
    expect(view.entries.find((e) => e.kind === 'PAYMENT_RESOLVED')).toMatchObject({
      state: 'FAILED',
      adminId: owner.id,
    });
    expect(
      view.entries
        .filter((e) => e.kind === 'CUSTOMER_NOTIFIED')
        .map((e) => ('notificationKind' in e ? e.notificationKind : null)),
    ).toEqual(['PAYMENT_REJECTED']);
    expect(view.entries.find((e) => e.kind === 'RECEIPT_SUBMITTED')).toMatchObject({
      receiptId,
      receiptKind: 'PHOTO',
    });
    // No free text: not the rejection reason, not the customer's caption.
    const wire = JSON.stringify(view.entries);
    expect(wire).not.toContain('واریزی پیدا نشد');
    expect(wire).not.toContain('کپشن مشتری');
    expect(wire).not.toContain('file-m1');
  });

  it('times an abandoned manual refund by its close, and never calls it completed', async () => {
    const payment = await manualConfirmed('m2');
    const requested = await refund(owner, payment.id, 100_000n, 'm2-refund');
    expect(requested.state).toBe('AWAITING_EXTERNAL');
    await ctx.container.refunds.fail(tenantA, owner, {
      idempotencyKey: 'm2-fail',
      refundId: requested.id,
      note: 'انصراف',
    });

    const view = await timeline(owner, payment.id);
    const refundKinds = view.entries.filter((e) => e.kind.startsWith('REFUND_')).map((e) => e.kind);

    expect(refundKinds).toEqual(['REFUND_REQUESTED', 'REFUND_CLOSED_FAILED']);
    expect(view.entries.find((e) => e.kind === 'REFUND_REQUESTED')).toMatchObject({
      channel: 'EXTERNAL_MANUAL',
      amountMinor: '100000',
      adminId: owner.id,
    });
  });

  it('writes nothing', async () => {
    const payment = await walletPayment('r1');
    await refund(owner, payment.id, 50_000n, 'r1-refund');
    const before = await snapshot();

    await timeline(owner, payment.id);
    await timeline(reviewer, payment.id);

    expect(await snapshot()).toEqual(before);
  });

  it("refuses without payments.view, hides another tenant's payment, and rejects a malformed id", async () => {
    const payment = await walletPayment('a1');

    await expect(timeline(support, payment.id)).rejects.toMatchObject({
      code: 'platform.permission_denied',
    });
    await expect(timeline(ownerB, payment.id, tenantB)).rejects.toMatchObject({
      code: 'commerce.payment_not_found',
    });
    await expect(timeline(owner, 'not-a-uuid')).rejects.toMatchObject({
      code: 'commerce.request_invalid',
    });
  });

  // -------------------------------------------------------------------------
  // Fixtures — the same flows `refunds.test.ts` drives
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

  const draft = (): ProductDraft => ({
    title: 'پلن پایه',
    description: 'یک ماهه',
    audience: 'EVERYONE',
    sortOrder: 10,
    panelId: panelA as PanelId,
    categoryId: SEED_IDS.categoryA as ProductCategoryId,
    specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: 2 },
    price: money(250_000n, 'IRT'),
    display: EMPTY_PRODUCT_DISPLAY,
  });

  async function awaitingPayment(key: string): Promise<OrderRecord> {
    const created = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: draft(),
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, created.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    const order = await ctx.container.orders.createDraft(tenantA, systemActor(`${key}-d`), {
      idempotencyKey: `${key}-draft`,
      customerId: customerA,
      productId: created.id,
    });
    return ctx.container.orders.confirm(tenantA, systemActor(`${key}-c`), {
      idempotencyKey: `${key}-confirm`,
      customerId: customerA,
      orderId: order.id,
    });
  }

  async function deliver(orderId: string): Promise<void> {
    await ctx.container.database.db.execute(sql`
      UPDATE provisioning_operations
         SET state = 'SUCCEEDED', completed_at = now(), claimed_by = NULL, lease_until = NULL
       WHERE tenant_id = ${tenantA.tenantId} AND order_id = ${orderId}`);
  }

  async function walletPayment(key: string): Promise<{ id: PaymentId }> {
    const order = await awaitingPayment(key);
    await ctx.container.wallet.adjust(tenantA, owner, customerA, {
      idempotencyKey: `${key}-credit`,
      direction: 'CREDIT',
      amountMinor: 1_000_000n,
      currency: 'IRT',
      note: 'fixture',
    });
    const { payment } = await ctx.container.payments.settleFromWallet(
      tenantA,
      systemActor(`${key}-settle`),
      customerA,
      { idempotencyKey: `${key}-settle-0001`, orderId: order.id },
    );
    await deliver(order.id);
    return { id: payment.id };
  }

  async function manualPayment(key: string): Promise<{ id: PaymentId }> {
    const order = await awaitingPayment(key);
    const { payment } = await ctx.container.payments.requestManualTransfer(
      tenantA,
      systemActor(`${key}-manual`),
      customerA,
      { idempotencyKey: `${key}-manual-0001`, orderId: order.id },
    );
    return { id: payment.id };
  }

  async function manualConfirmed(key: string): Promise<{ id: PaymentId }> {
    const pending = await manualPayment(key);
    const { payment } = await ctx.container.payments.confirmManualTransfer(
      tenantA,
      owner,
      pending.id,
      { idempotencyKey: `${key}-confirm-0001`, note: 'کارت به کارت' },
    );
    if (payment.orderId !== null) await deliver(payment.orderId);
    return { id: payment.id };
  }

  const refund = (actor: ActorContext, paymentId: string, amountMinor: bigint, key: string) =>
    ctx.container.refunds.request(tenantA, actor, {
      idempotencyKey: key,
      paymentId,
      amountMinor,
      reason: 'مشتری منصرف شد',
    });

  async function snapshot(): Promise<unknown> {
    const result = (await ctx.container.database.db.execute(sql`
      SELECT (SELECT count(*)::int FROM payments) AS payments,
             (SELECT max(updated_at)::text FROM payments) AS payments_updated,
             (SELECT count(*)::int FROM refunds) AS refunds,
             (SELECT count(*)::int FROM wallet_entries) AS wallet,
             (SELECT count(*)::int FROM customer_notifications) AS notifications,
             (SELECT count(*)::int FROM audit_logs) AS audit,
             (SELECT count(*)::int FROM outbox_messages) AS outbox,
             (SELECT count(*)::int FROM operational_events) AS events`)) as unknown as {
      rows: unknown[];
    };
    return result.rows[0];
  }
});
