import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isNexaError, type ActorContext, type CorrelationId, type UserId } from '@nexa/contracts';
import { DrizzleEndedServicesRepository } from '../../apps/api/src/modules/platform/legacy-materialize/infrastructure/drizzle-ended-services.repository';
import type { NeverPaidOrderState } from '../../apps/api/src/modules/platform/legacy-materialize/application/ended-services.rules';
import { AudienceFixtures } from './audience-fixtures';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
  type TestContext,
} from './harness';

/** The database's own refusal: drizzle wraps it, the trigger's message is the cause's. */
const refusedBy = (text: RegExp) => (e: unknown) =>
  text.test(String((e as { cause?: { message?: string } }).cause?.message ?? ''));

/** The actor a customer-initiated command runs as (as `customer-order-actions.test.ts`). */
const customerCommandActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

/**
 * A NEVER-PAID Mirza invoice's order (owner instruction 2026-10-18) — `LEGACY_HISTORY`,
 * EXPIRED or CANCELLED, no service — run through every lane that could act on an order: the
 * sweeps leave it alone, no payment can be taken for it, the customer cannot cancel it, the
 * database refuses to move it, and no report counts it. Each lane is asked with the customer
 * holding enough in the wallet to pay, so a refusal is the order's doing, not the balance's.
 *
 * The rows are written by the step's own repository, so they are exactly what the import
 * writes, and they are dated NOW so every report window that could see them does. SYNTHETIC.
 */
describe('never-paid Mirza orders: no lane acts on them', () => {
  let ctx: TestContext;
  let fx: AudienceFixtures;
  let owner: ActorContext;
  let customerId: string;
  let panelId: string;
  let productId: string;
  const orderIds: Record<NeverPaidOrderState, string> = { EXPIRED: '', CANCELLED: '' };

  const db = () => ctx.container.database.db;
  const count = async (query: string): Promise<number> =>
    Number((await db().execute<{ n: number }>(sql.raw(query))).rows[0]?.n ?? 0);
  const everything = async (): Promise<Record<string, unknown>> => {
    const out: Record<string, unknown> = {};
    for (const table of [
      'provisioning_operations',
      'service_username_reservations',
      'wallet_entries',
      'outbox_messages',
      'customer_notifications',
      'service_reminders',
      'payments',
      'services',
      'orders',
      'panel_capacity_reservations',
    ]) {
      out[table] = await count(`SELECT count(*)::int AS n FROM ${table}`);
    }
    out['orderStates'] = (
      await db().execute<{ v: string }>(
        sql`SELECT coalesce(string_agg(id::text || ':' || state || ':' || total_amount::text || ':' || coalesce(cancelled_at::text, '-') || ':' || updated_at::text, ',' ORDER BY id), '') AS v FROM orders`,
      )
    ).rows[0]?.v;
    return out;
  };

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 600_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    fx = new AudienceFixtures(ctx, tenantA.tenantId as string);
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-unpaid', roleKeys: ['owner'] }),
    );
    customerId = await fx.customer({ telegramUserId: '7200000001' });
    panelId = await fx.panel('unpaid');
    productId = await fx.product(panelId, 'سرویس پرداخت‌نشده');
    // Enough to pay either order from the wallet, so only the order can refuse.
    await ctx.container.wallet.adjust(tenantA, owner, customerId as UserId, {
      idempotencyKey: 'unpaid-lanes-credit',
      direction: 'CREDIT',
      amountMinor: 1_000_000n,
      currency: 'IRT',
      note: 'fixture',
    });
    const repo = new DrizzleEndedServicesRepository(db());
    const now = ctx.container.clock.now();
    for (const state of ['EXPIRED', 'CANCELLED'] as const) {
      const orderId = ctx.container.ids.uuid();
      orderIds[state] = orderId;
      await ctx.container.uow.run(tenantA, (tx) =>
        repo.insertNeverPaid(
          tenantA,
          {
            orderId,
            sourceRef: `invoice-never-paid:${state === 'EXPIRED' ? 'a0000001' : 'a0000002'}`,
            state,
            customerId,
            panelId,
            product: {
              productId,
              title: 'سرویس پرداخت‌نشده',
              durationDays: 30,
              trafficBytes: 53_687_091_200n,
            },
            lineTitle: 'سرویس پرداخت‌نشده',
            amountMinor: 250_000n,
            currency: 'IRT',
            createdAt: now,
            now,
          },
          tx,
        ),
      );
    }
  });

  it('is a LEGACY_HISTORY order marked Mirza in its terminal state, never settled, with nothing beside it', async () => {
    const rows = (
      await db().execute<Record<string, unknown>>(
        sql`SELECT state, origin, purpose, source, source_ref, total_amount, settled_at, confirmed_at,
                   cancelled_at, expires_at FROM orders ORDER BY source_ref`,
      )
    ).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      state: 'EXPIRED',
      origin: 'LEGACY_HISTORY',
      purpose: 'NEW_SERVICE',
      source: 'MIRZA',
      source_ref: 'invoice-never-paid:a0000001',
      total_amount: 250_000n,
      settled_at: null,
      confirmed_at: null,
      cancelled_at: null,
      expires_at: null,
    });
    expect(rows[1]).toMatchObject({
      state: 'CANCELLED',
      source_ref: 'invoice-never-paid:a0000002',
      settled_at: null,
      expires_at: null,
    });
    expect(rows[1]?.['cancelled_at']).not.toBeNull();
    for (const table of ['services', 'payments', 'provisioning_operations']) {
      expect(await count(`SELECT count(*)::int AS n FROM ${table}`), table).toBe(0);
    }
    // The fixture's wallet credit is the outbox's one event; neither order is any event's.
    expect(await count(`SELECT count(*)::int AS n FROM outbox_messages`)).toBe(1);
    for (const orderId of Object.values(orderIds)) {
      expect(
        await count(
          `SELECT count(*)::int AS n FROM outbox_messages WHERE aggregate_id = '${orderId}' OR payload::text LIKE '%${orderId}%'`,
        ),
      ).toBe(0);
    }
  });

  it('the payment expiry sweep, the pending-payment reminders, the service reminders and the provisioner write nothing', async () => {
    const before = await everything();
    await ctx.container.paymentExpirySweep.runOnce(tenantA);
    await ctx.container.pendingPaymentReminderSweep.runOnce(tenantA);
    await ctx.container.serviceReminderSweep.runOnce(tenantA);
    await ctx.container.provisioner.runOnce(tenantA);
    expect(await everything()).toEqual(before);
  });

  it('cannot be paid: the wallet settlement and a manual transfer are refused, and nothing moves', async () => {
    const before = await everything();
    for (const [state, orderId] of Object.entries(orderIds)) {
      await expect(
        ctx.container.payments.settleFromWallet(
          tenantA,
          customerCommandActor(`unpaid-wallet-${state}`),
          customerId as UserId,
          { idempotencyKey: `unpaid-wallet-${state}`, orderId },
        ),
        state,
      ).rejects.toSatisfy((e: unknown) => isNexaError(e));
      await expect(
        ctx.container.payments.requestManualTransfer(
          tenantA,
          customerCommandActor(`unpaid-manual-${state}`),
          customerId as UserId,
          { idempotencyKey: `unpaid-manual-${state}`, orderId },
        ),
        state,
      ).rejects.toSatisfy((e: unknown) => isNexaError(e));
      // …and it is not an order awaiting payment to anyone who asks.
      expect(
        await ctx.container.orders.awaitingPaymentForCustomer(
          tenantA,
          customerId as UserId,
          orderId,
        ),
      ).toBeNull();
    }
    expect(await everything()).toEqual(before);
  });

  it('the customer cannot cancel it, and the database refuses every move', async () => {
    const before = await everything();
    // An EXPIRED one is refused: it is not awaiting payment.
    await expect(
      ctx.container.orders.cancelByCustomer(tenantA, customerCommandActor('unpaid-c-expired'), {
        idempotencyKey: 'unpaid-cancel-expired',
        customerId,
        orderId: orderIds.EXPIRED,
      }),
    ).rejects.toMatchObject({ code: 'commerce.order_state_invalid' });
    // A CANCELLED one is already the end state asked for: `cancelByCustomer` answers a second
    // tap with the order as it is, and moves nothing (no state, no stamp, no payment).
    const again = await ctx.container.orders.cancelByCustomer(
      tenantA,
      customerCommandActor('unpaid-c-cancelled'),
      { idempotencyKey: 'unpaid-cancel-cancelled', customerId, orderId: orderIds.CANCELLED },
    );
    expect(again.state).toBe('CANCELLED');
    expect(await everything()).toEqual(before);
    // Each a CONSISTENT move (the stamps its target state needs, `orders_settled_at_check`
    // and the rest satisfied), so only the 0253 trigger stands in the way, not a CHECK.
    const moves = (other: 'EXPIRED' | 'CANCELLED') => [
      sql`state = 'AWAITING_PAYMENT', cancelled_at = NULL, expires_at = now() + interval '1 hour'`,
      sql`state = 'PAID', cancelled_at = NULL, settled_at = now()`,
      sql`state = 'REFUNDED', cancelled_at = NULL, settled_at = now(), refunded_at = now()`,
      other === 'CANCELLED'
        ? sql`state = 'CANCELLED', cancelled_at = now()`
        : sql`state = 'EXPIRED', cancelled_at = NULL`,
      sql`total_amount = 1, subtotal_amount = 1, line_unit_price_amount = 1`,
    ];
    for (const [orderId, other] of [
      [orderIds.EXPIRED, 'CANCELLED'],
      [orderIds.CANCELLED, 'EXPIRED'],
    ] as const) {
      for (const set of moves(other)) {
        await expect(
          db().execute(sql`UPDATE orders SET ${set} WHERE id = ${orderId}`),
        ).rejects.toSatisfy(refusedBy(/LEGACY_HISTORY order/));
      }
    }
    expect(await everything()).toEqual(before);
  });

  it('no report counts it: no sale, no revenue, no successful order, no drill-down row', async () => {
    const request = { range: 'TODAY' as const };
    const summary = await ctx.container.reports.summary(tenantA, owner, request);
    expect(summary.sales.current).toBe(0);
    const dashboard = await ctx.container.reports.dashboard(tenantA, owner, request);
    expect(dashboard.today.sales.current).toBe(0);
    expect(JSON.stringify(dashboard.today.revenue)).not.toContain('250000');
    const financial = await ctx.container.reports.financial(tenantA, owner, request, 'DAY');
    for (const lines of financial.totals) {
      expect(lines).toMatchObject({
        sales: '0',
        grossSales: '0',
        netSales: '0',
        customerPaid: '0',
      });
    }
    const drill = await ctx.container.reports.orders(tenantA, owner, request, {});
    expect(drill.response.rows).toEqual([]);
  });
});
