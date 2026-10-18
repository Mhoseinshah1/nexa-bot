import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isNexaError, type ActorContext } from '@nexa/contracts';
import { OPERATOR_SERVICE_OPERATIONS } from '../../apps/api/src/modules/commerce/provisioning/application/provisioning.service';
import { DrizzleServiceRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service.repository';
import { DrizzleEndedServicesRepository } from '../../apps/api/src/modules/platform/legacy-materialize/infrastructure/drizzle-ended-services.repository';
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

/**
 * An ENDED Mirza service and its LEGACY_HISTORY order run through every lane that could act
 * on a service or an order (owner decision 2026-10-17): none of them picks the rows up, none
 * of them writes anything, and the refund eligibility refuses even when a CONFIRMED payment is
 * linked to the history order (as the payment import may link a Mirza payment).
 *
 * The rows are written by the step's own repository, so they are exactly what the import
 * writes. SYNTHETIC data.
 */
describe('ended Mirza services: no lane acts on them', () => {
  let ctx: TestContext;
  let fx: AudienceFixtures;
  let owner: ActorContext;
  let serviceId: string;
  let orderId: string;
  let customerId: string;
  let panelId: string;

  const db = () => ctx.container.database.db;
  const count = async (query: string): Promise<number> =>
    Number((await db().execute<{ n: number }>(sql.raw(query))).rows[0]?.n ?? 0);
  const everything = async (): Promise<Record<string, number>> => {
    const out: Record<string, number> = {};
    for (const table of [
      'provisioning_operations',
      'service_username_reservations',
      'wallet_entries',
      'outbox_messages',
      'customer_notifications',
      'service_reminders',
      'service_commercial_actions',
      'service_refund_requests',
      'orders',
      'services',
      'payments',
    ]) {
      out[table] = await count(`SELECT count(*)::int AS n FROM ${table}`);
    }
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
      await createAdmin(ctx.container, tenantA, { username: 'owner-ended', roleKeys: ['owner'] }),
    );
    customerId = await fx.customer({ telegramUserId: '7100000001' });
    panelId = await fx.panel('ended');
    const productId = await fx.product(panelId, 'سرویس قدیمی');
    serviceId = ctx.container.ids.uuid();
    orderId = ctx.container.ids.uuid();
    const repo = new DrizzleEndedServicesRepository(db());
    // Bought long ago: its recorded expiry is in the past, so every expiry-keyed lane would
    // want it if it could see it.
    const purchasedAt = new Date('2024-01-01T00:00:00.000Z');
    await ctx.container.uow.run(tenantA, (tx) =>
      repo.insertEnded(
        tenantA,
        {
          orderId,
          serviceId,
          sourceRef: 'invoice:a0000001',
          customerId,
          panelId,
          product: {
            productId,
            title: 'سرویس قدیمی',
            durationDays: 30,
            trafficBytes: 53_687_091_200n,
          },
          lineTitle: 'سرویس قدیمی',
          providerUsername: 'ended_ali',
          subscriptionRef: 'a'.repeat(32),
          amountMinor: 250_000n,
          currency: 'IRT',
          purchasedAt,
          isTest: false,
          now: ctx.container.clock.now(),
        },
        tx,
      ),
    );
  });

  async function serviceRecord() {
    const record = await new DrizzleServiceRepository(db()).findById(tenantA, serviceId);
    if (record === null) throw new Error('the ended service is not readable');
    return record;
  }

  it('is a TERMINATED service and a PAID history order, both marked Mirza, with no operation or hold', async () => {
    const [service] = (
      await db().execute<Record<string, unknown>>(
        sql`SELECT state, source, source_ref, provisioned_at, terminated_at, expires_at FROM services WHERE id = ${serviceId}`,
      )
    ).rows;
    expect(service).toMatchObject({
      state: 'TERMINATED',
      source: 'MIRZA',
      source_ref: 'invoice:a0000001',
      provisioned_at: null,
    });
    expect(service?.['terminated_at']).not.toBeNull();
    const [order] = (
      await db().execute<Record<string, unknown>>(
        sql`SELECT state, origin, purpose, source, total_amount FROM orders WHERE id = ${orderId}`,
      )
    ).rows;
    expect(order).toMatchObject({
      state: 'PAID',
      origin: 'LEGACY_HISTORY',
      purpose: 'NEW_SERVICE',
      source: 'MIRZA',
      total_amount: 250_000n,
    });
    expect(await count('SELECT count(*)::int AS n FROM provisioning_operations')).toBe(0);
    expect(await count('SELECT count(*)::int AS n FROM service_username_reservations')).toBe(0);
  });

  it('the reminder sweep, the provisioner and the payment expiry sweep leave both rows alone and write nothing', async () => {
    const before = await everything();
    await ctx.container.serviceReminderSweep.runOnce(tenantA);
    await ctx.container.provisioner.runOnce(tenantA);
    await ctx.container.paymentExpirySweep.runOnce(tenantA);
    expect(await everything()).toEqual(before);
    expect(
      await count(
        `SELECT count(*)::int AS n FROM services WHERE id = '${serviceId}' AND state = 'TERMINATED'`,
      ),
    ).toBe(1);
    expect(
      await count(
        `SELECT count(*)::int AS n FROM orders WHERE id = '${orderId}' AND state = 'PAID'`,
      ),
    ).toBe(1);
  });

  it('an operator cannot suspend, resume, terminate, sync or rotate it, and no operation is planned', async () => {
    const before = await everything();
    for (const type of OPERATOR_SERVICE_OPERATIONS) {
      await expect(
        ctx.container.provisioning.requestFromOperator(tenantA, owner, serviceId, type, {
          idempotencyKey: `ended-${type}`,
        }),
        type,
      ).rejects.toSatisfy((e: unknown) => isNexaError(e));
    }
    expect(await everything()).toEqual(before);
  });

  it('offers no commercial action and no refresh button on it', async () => {
    const service = await serviceRecord();
    expect(await ctx.container.commercialActions.availableFor(tenantA, owner, service)).toEqual([]);
    expect(await ctx.container.provisioning.customerSyncOffered(tenantA, service)).toBe(false);
  });

  it('a refund is refused on it even with a CONFIRMED payment linked to the history order', async () => {
    await db().execute(sql`
      INSERT INTO payments (id, tenant_id, customer_id, order_id, state, method, amount, currency,
                            reference, evidence_kind, confirmed_at, expires_at, created_at,
                            source, source_ref)
      VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, ${customerId}, ${orderId},
              'CONFIRMED', 'MANUAL_TRANSFER', 250000, 'IRT', 'MIRZA-1', 'LEGACY_IMPORT', now(),
              now() + interval '1 hour', now(), 'MIRZA', 'payment:1')`);
    const service = await serviceRecord();
    expect(
      await ctx.container.serviceRefundRequests.eligibilityOf(tenantA, service, {
        checkFlag: false,
      }),
    ).toEqual({ eligible: false, reason: 'SERVICE_STATE' });
    const before = await everything();
    await expect(
      ctx.container.serviceRefundRequests.deleteWithRefund(tenantA, owner, {
        serviceId,
        amountMinor: 250_000n,
        idempotencyKey: 'ended-delete-refund',
      }),
    ).rejects.toSatisfy((e: unknown) => isNexaError(e));
    expect(await everything()).toEqual(before);
    expect(await count('SELECT count(*)::int AS n FROM wallet_entries')).toBe(0);
  });

  it('a refund is refused on any service whose order is not a sale of this installation', async () => {
    // A LIVE service behind an imported/adopted order (not STANDARD) with a confirmed payment
    // linked to it: the eligibility must still say there is nothing this installation took.
    const adoptedOrder = ctx.container.ids.uuid();
    const liveService = ctx.container.ids.uuid();
    const productId = await fx.product(panelId, 'adopted');
    const quote = JSON.stringify({
      productId,
      quotedAt: '2026-03-01T00:00:00.000Z',
      currency: 'IRT',
      finalAmount: { amountMinor: '0', currency: 'IRT' },
      trace: [
        {
          step: 'BASE_PRICE',
          effect: 'REPLACES',
          ruleId: null,
          ruleLabel: 'legacy adoption',
          amountBefore: { amountMinor: '0', currency: 'IRT' },
          amountAfter: { amountMinor: '0', currency: 'IRT' },
        },
      ],
    });
    await db().execute(sql`
      INSERT INTO orders
        (id, tenant_id, customer_id, state, purpose, origin, product_id, panel_id, line_title,
         line_duration_days, line_traffic_bytes, line_unit_price_amount, line_quantity,
         subtotal_amount, discount_amount, total_amount, currency, quote, settled_at,
         confirmed_at, source, source_ref)
      VALUES (${adoptedOrder}, ${tenantA.tenantId}, ${customerId}, 'PAID', 'NEW_SERVICE',
              'LEGACY_ADOPTION', ${productId}, ${panelId}, 'adopted', 30, 53687091200, 0, 1, 0, 0, 0,
              'IRT', ${quote}::jsonb, now(), now(), 'MIRZA', 'invoice:b0000002')`);
    await db().execute(sql`
      INSERT INTO services
        (id, tenant_id, customer_id, order_id, panel_id, product_id, provider_username, state,
         delivery_state, traffic_limit_bytes, traffic_used_bytes, expires_at, provisioned_at,
         delivered_at, source, source_ref)
      VALUES (${liveService}, ${tenantA.tenantId}, ${customerId}, ${adoptedOrder}, ${panelId},
              ${productId}, 'live_adopted', 'ACTIVE', 'DELIVERED', 53687091200, 0,
              now() + interval '10 days', now(), now(), 'MIRZA', 'invoice:b0000002')`);
    await db().execute(sql`
      INSERT INTO payments (id, tenant_id, customer_id, order_id, state, method, amount, currency,
                            reference, evidence_kind, confirmed_at, expires_at, created_at,
                            source, source_ref)
      VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, ${customerId}, ${adoptedOrder},
              'CONFIRMED', 'MANUAL_TRANSFER', 250000, 'IRT', 'MIRZA-2', 'LEGACY_IMPORT', now(),
              now() + interval '1 hour', now(), 'MIRZA', 'payment:2')`);
    const record = await new DrizzleServiceRepository(db()).findById(tenantA, liveService);
    if (record === null) throw new Error('no live service');
    expect(
      await ctx.container.serviceRefundRequests.eligibilityOf(tenantA, record, {
        checkFlag: false,
      }),
    ).toEqual({ eligible: false, reason: 'NO_PAID_SOURCE' });
  });

  it('only a Mirza row can be a test service', async () => {
    const nexa = await fx.service({ customerId, panelId });
    await expect(
      db().execute(sql`UPDATE services SET is_test = true WHERE id = ${nexa}`),
    ).rejects.toThrow();
    // …while the imported ended service can carry the mark.
    await db().execute(sql`UPDATE services SET is_test = true WHERE id = ${serviceId}`);
    expect(await count(`SELECT count(*)::int AS n FROM services WHERE is_test`)).toBe(1);
  });

  it('the database refuses to resume the service or to cancel, refund or re-price the order', async () => {
    // A fully consistent resume (state, no end time, a provisioning time): only the trigger
    // stands in the way, not a CHECK.
    await expect(
      db().execute(
        sql`UPDATE services SET state = 'ACTIVE', terminated_at = NULL, provisioned_at = now()
             WHERE id = ${serviceId}`,
      ),
    ).rejects.toSatisfy(refusedBy(/is TERMINATED and stays so/));
    for (const set of [
      sql`state = 'REFUNDED', refunded_at = now()`,
      sql`state = 'CANCELLED', cancelled_at = now()`,
      sql`total_amount = 1`,
    ]) {
      await expect(
        db().execute(sql`UPDATE orders SET ${set} WHERE id = ${orderId}`),
      ).rejects.toSatisfy(refusedBy(/LEGACY_HISTORY order/));
    }
  });
});
