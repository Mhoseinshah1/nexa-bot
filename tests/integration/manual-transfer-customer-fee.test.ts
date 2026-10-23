import { sql, type SQL } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  money,
  routeTakesCustomerFee,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
  type UserId,
} from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import type { OrderRecord } from '../../apps/api/src/modules/commerce/orders/application/ports';
import { DrizzleReportingRepository } from '../../apps/api/src/modules/commerce/reporting/infrastructure/drizzle-reporting.repository';
import { amountToTransfer } from '../../apps/api/src/modules/commerce/payments/domain/amount-to-transfer';
import {
  SEED_IDS,
  adminActorFor,
  createAdmin,
  createTestContext,
  makePanelSellable,
  tenantA,
  type TestContext,
} from './harness';

/**
 * R6 item 4: the manual card-to-card route can carry a customer fee, through the SAME
 * snapshot an online gateway uses (`payments.customer_fee_*`).
 *
 * The rules, each a way to charge a customer a number they did not see or to give money away:
 *
 * - rate 0 (the default) snapshots nothing - the payment is exactly what it was before;
 * - at 10 % the payable is principal + fee, half-up on bigint, and `amount` stays the principal;
 * - the wallet receives the principal only, the fee is booked beside it, never as revenue;
 * - a refund returns the principal and never the fee;
 * - a payment keeps the fee it was issued with when the route's rate changes later;
 * - the reviewer's figure (caption, queue, credit prompt) is the payable the customer had to send.
 */
const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const customerActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

describe('the card-to-card customer fee', () => {
  let ctx: TestContext;
  let products: DrizzleProductRepository;
  let owner: ActorContext;
  let finance: ActorContext;
  let panelA: string;
  let customerA: UserId;
  let n = 0;
  const key = (): string => `manual-fee-key-${(n += 1)}`;

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
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-mfee', roleKeys: ['owner'] }),
    );
    finance = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'finance-mfee',
        roleKeys: ['finance'],
      }),
    );
    const { customer } = await ctx.container.customers.resolveFromUpdate(
      tenantA,
      customerActor('resolve-mfee'),
      {
        idempotencyKey: 'resolve-mfee',
        telegramUserId: '930001',
        from: { id: 930001, first_name: 'مریم' },
        botInstanceId: BOT_A,
      },
    );
    customerA = customer.id;
  });

  async function rows<T>(query: SQL): Promise<T[]> {
    return ((await ctx.container.database.db.execute(query as never)) as unknown as { rows: T[] })
      .rows;
  }

  /** The route's fee, set the way the Web Admin does: through the configure command. */
  async function setFee(basisPoints: number): Promise<void> {
    await ctx.container.paymentGateways.configure(tenantA, owner, {
      idempotencyKey: key(),
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
        topupCashbackPercent: 0,
        allowServicePurchase: true,
        allowWalletTopup: true,
        customerFeeBasisPoints: basisPoints,
      },
    });
  }

  async function product(price: bigint): Promise<ProductId> {
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
        price: money(price, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, created.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    return created.id;
  }

  async function confirmedOrder(price: bigint): Promise<OrderRecord> {
    const order = await ctx.container.orders.createDraft(tenantA, customerActor(key()), {
      idempotencyKey: key(),
      customerId: customerA,
      productId: await product(price),
    });
    return ctx.container.orders.confirm(tenantA, customerActor(key()), {
      idempotencyKey: key(),
      customerId: customerA,
      orderId: order.id,
    });
  }

  const requestTransfer = (orderId: string) =>
    ctx.container.payments.requestManualTransfer(tenantA, customerActor(key()), customerA, {
      idempotencyKey: key(),
      orderId,
    });

  const confirm = (paymentId: string) =>
    ctx.container.payments.confirmManualTransfer(tenantA, finance, paymentId, {
      idempotencyKey: key(),
      note: 'کارت به کارت',
    });

  const feeRow = async (paymentId: string) =>
    (
      await rows<{
        amount: string;
        customer_fee_basis_points: number | null;
        customer_fee_amount: string | null;
        payable_amount: string | null;
      }>(
        sql`SELECT amount::text AS amount, customer_fee_basis_points, customer_fee_amount::text AS customer_fee_amount,
                   payable_amount::text AS payable_amount
              FROM payments WHERE id = ${paymentId}`,
      )
    )[0];

  const ledger = () =>
    rows<{ reason: string; direction: string; amount: string }>(
      sql`SELECT reason, direction, amount::text AS amount FROM wallet_entries
           WHERE customer_id = ${customerA} ORDER BY created_at, id`,
    );

  it('rate 0 behaves as before: no snapshot, the payable is the order total', async () => {
    const order = await confirmedOrder(200_000n);
    const { payment } = await requestTransfer(order.id);
    expect(payment.customerFee).toBeNull();
    expect(await feeRow(payment.id)).toEqual({
      amount: '200000',
      customer_fee_basis_points: null,
      customer_fee_amount: null,
      payable_amount: null,
    });
    expect(amountToTransfer(payment).amountMinor).toBe(200_000n);
    // A route configured to 0 explicitly is the same.
    await setFee(0);
    const again = await confirmedOrder(100_000n);
    const second = await requestTransfer(again.id);
    expect(second.payment.customerFee).toBeNull();
  });

  it('10 %: the payable is principal + fee, the amount stays the principal, and the order settles at its own total', async () => {
    await setFee(1_000);
    const order = await confirmedOrder(200_000n);
    const { payment } = await requestTransfer(order.id);
    expect(await feeRow(payment.id)).toEqual({
      amount: '200000',
      customer_fee_basis_points: 1_000,
      customer_fee_amount: '20000',
      payable_amount: '220000',
    });
    expect(amountToTransfer(payment).amountMinor).toBe(220_000n);

    const settled = await confirm(payment.id);
    expect(settled.order?.state).toBe('PAID');
    // No wallet money moved for an order paid by transfer, fee included.
    expect(await ledger()).toEqual([]);
  });

  it('a top-up credits the principal only; the fee is never on the wallet', async () => {
    await setFee(1_000);
    const { payment } = await ctx.container.payments.requestWalletTopupTyped(
      tenantA,
      customerActor(key()),
      customerA,
      { idempotencyKey: key(), amount: money(100_000n, 'IRT'), provider: 'MANUAL_TRANSFER' },
    );
    expect(await feeRow(payment.id)).toMatchObject({
      amount: '100000',
      customer_fee_amount: '10000',
      payable_amount: '110000',
    });
    await confirm(payment.id);
    const entries = await ledger();
    expect(entries).toEqual([{ reason: 'TOPUP_RECEIPT', direction: 'CREDIT', amount: '100000' }]);
  });

  it('the fee is booked beside the principal in the financial report, not inside it', async () => {
    await setFee(1_000);
    const order = await confirmedOrder(200_000n);
    const { payment } = await requestTransfer(order.id);
    await confirm(payment.id);
    const reporting = new DrizzleReportingRepository(ctx.container.database.db);
    const cash = await reporting.financialCash(tenantA, [
      new Date(Date.now() - 86_400_000 * 2),
      new Date(Date.now() + 86_400_000 * 2),
    ]);
    const manual = cash.filter((row) => row.method === 'MANUAL_TRANSFER');
    expect(manual).toHaveLength(1);
    expect(manual[0]).toMatchObject({ principal: 200_000n, fee: 20_000n, payable: 220_000n });
  });

  it('a refund returns the principal and never the fee', async () => {
    await setFee(1_000);
    const order = await confirmedOrder(200_000n);
    const { payment } = await requestTransfer(order.id);
    // The panel stops being sellable while the transfer waits: the order is refunded automatically.
    await ctx.container.database.db.execute(
      sql`UPDATE panels SET status = 'DISABLED' WHERE id = ${panelA}`,
    );
    const settled = await confirm(payment.id);
    expect(settled.order?.state).toBe('REFUNDED');
    const credits = (await ledger()).filter((entry) => entry.direction === 'CREDIT');
    expect(credits.map((entry) => entry.amount)).toEqual(['200000']);
  });

  it('an operator’s refund cannot exceed the principal: the fee is not refundable', async () => {
    await setFee(1_000);
    const order = await confirmedOrder(200_000n);
    const { payment } = await requestTransfer(order.id);
    await confirm(payment.id);
    await ctx.container.database.db.execute(
      sql`UPDATE provisioning_operations
             SET state = 'SUCCEEDED', completed_at = now(), claimed_by = NULL, lease_until = NULL
           WHERE order_id = ${order.id}`,
    );
    await expect(
      ctx.container.refunds.request(tenantA, owner, {
        idempotencyKey: key(),
        paymentId: payment.id,
        amountMinor: 220_000n,
        reason: 'با کارمزد',
      }),
    ).rejects.toBeDefined();
    await ctx.container.refunds.request(tenantA, owner, {
      idempotencyKey: key(),
      paymentId: payment.id,
      amountMinor: 200_000n,
      reason: 'اصل مبلغ',
    });
  });

  it('a payment keeps the fee it was issued with when the rate changes, and a reissue is not re-priced', async () => {
    await setFee(1_000);
    const order = await confirmedOrder(200_000n);
    const first = await requestTransfer(order.id);
    await setFee(5_000);
    const again = await requestTransfer(order.id);
    expect(again.payment.id).toBe(first.payment.id);
    expect(await feeRow(first.payment.id)).toMatchObject({
      customer_fee_basis_points: 1_000,
      payable_amount: '220000',
    });
    const other = await confirmedOrder(100_000n);
    const next = await requestTransfer(other.id);
    expect(await feeRow(next.payment.id)).toMatchObject({
      customer_fee_basis_points: 5_000,
      payable_amount: '150000',
    });
  });

  it('only a route that settles through a gateway or a card transfer takes a fee', () => {
    expect(routeTakesCustomerFee('MANUAL_TRANSFER')).toBe(true);
    expect(routeTakesCustomerFee('TONPAYS')).toBe(true);
  });
});
