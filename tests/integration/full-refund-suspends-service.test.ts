import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  money,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type OrderId,
  type PanelId,
  type PaymentId,
  type ProductCategoryId,
  type ProductId,
  type UserId,
} from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { DrizzleServiceRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service.repository';
import { DrizzleServiceTransferRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service-transfer.repository';
import { startFakeMarzban, type FakeMarzban } from '../support/fake-marzban';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  validatePanelConnection,
  SEED_IDS,
  tenantA,
  type TestContext,
} from './harness';

/**
 * R12 F1 item 3 — an operator's FULL refund of a service purchase or renewal no longer leaves
 * the service live on the panel.
 *
 * Before: `RefundService` moved the order `PAID -> REFUNDED` and wrote `serviceLeftUntouched`
 * on its audit row; the customer had the money back AND the service. Now the refund that makes
 * the payment whole plans a SUSPEND of the order's service in its own transaction, through
 * the operator's suspend planner, and the provisioner applies it on the panel. A partial refund
 * plans nothing; a service that changed hands or is not ACTIVE is left as it is, and the audit
 * says why. Real container, real PostgreSQL, the real Marzban adapter against a fake panel.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const CUSTOMER_TG = '950951';
const OTHER_TG = '950952';
const PRICE = 200_000n;

const botActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

describe('R12 F1 — a full refund suspends the service it paid for', () => {
  let ctx: TestContext;
  let panel: FakeMarzban;
  let products: DrizzleProductRepository;
  let services: DrizzleServiceRepository;
  let panelId: string;
  let customerA: UserId;
  let customerB: UserId;
  let owner: ActorContext;
  let seq = 0;
  const key = (stem: string) => `r12f1-refund-${stem}-${String((seq += 1))}`;

  beforeAll(async () => {
    ctx = await createTestContext({ PANEL_HTTP_ALLOW_LOOPBACK: 'true' });
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  afterEach(async () => {
    await panel?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    ctx.container.setInstallationTenant(tenantA.tenantId);
    products = new DrizzleProductRepository(ctx.container.database.db);
    services = new DrizzleServiceRepository(ctx.container.database.db);
    panel = await startFakeMarzban({ host: '127.0.0.2' });
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-r12-ref', roleKeys: ['owner'] }),
    );
    const created = await ctx.container.panels.create(tenantA, owner, {
      name: 'Marzban A',
      providerType: 'marzban',
      baseUrl: panel.baseUrl,
      credentials: { username: panel.username, password: panel.password },
      activation: { proxyProtocols: ['vless'], inboundTags: { vless: ['VLESS TCP'] } },
      idempotencyKey: 'panel-r12-refund-create',
    });
    panelId = created.view.panel.id;
    await validatePanelConnection(ctx.container, tenantA, panelId);
    customerA = await resolve(CUSTOMER_TG);
    customerB = await resolve(OTHER_TG);
  });

  async function resolve(telegramUserId: string): Promise<UserId> {
    const resolved = await ctx.container.customers.resolveFromUpdate(tenantA, botActor('r'), {
      idempotencyKey: `resolve-${telegramUserId}`,
      telegramUserId,
      from: { id: Number(telegramUserId), first_name: 'سارا' },
      botInstanceId: BOT_A,
    });
    return resolved.customer.id;
  }

  async function credit(amount: bigint): Promise<void> {
    await ctx.container.wallet.adjust(tenantA, owner, customerA, {
      idempotencyKey: key('credit'),
      direction: 'CREDIT',
      amountMinor: amount,
      currency: 'IRT',
      note: 'fixture',
    });
  }

  /** A NEW_SERVICE order paid from the wallet and provisioned: an ACTIVE service. */
  async function boughtService(): Promise<{
    serviceId: string;
    orderId: string;
    paymentId: PaymentId;
  }> {
    const product = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن ماهانه',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: panelId as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: null },
        price: money(PRICE, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, product.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    const k = key('buy');
    const draft = await ctx.container.orders.createDraft(tenantA, botActor(k), {
      idempotencyKey: `${k}-draft`,
      customerId: customerA,
      productId: product.id,
    });
    const confirmed = await ctx.container.orders.confirm(tenantA, botActor(k), {
      idempotencyKey: `${k}-confirm`,
      customerId: customerA,
      orderId: draft.id,
    });
    await credit(PRICE);
    const { payment } = await ctx.container.payments.settleFromWallet(
      tenantA,
      botActor(k),
      customerA,
      { idempotencyKey: `${k}-pay`, orderId: confirmed.id },
    );
    await ctx.container.provisionerLoop.tick();
    const service = await services.findByOrderId(tenantA, confirmed.id as OrderId);
    if (service === null) throw new Error('no service');
    expect(service.state, 'the fixture must start ACTIVE').toBe('ACTIVE');
    return { serviceId: service.id, orderId: confirmed.id, paymentId: payment.id };
  }

  /** A RENEW of that service, paid from the wallet and applied. */
  async function renewed(serviceId: string): Promise<{ orderId: string; paymentId: PaymentId }> {
    const k = key('renew');
    const { order } = await ctx.container.commercialActions.draft(tenantA, botActor(k), customerA, {
      serviceId,
      kind: 'RENEW',
      idempotencyKey: `${k}-quote`,
    });
    await ctx.container.commercialActions.confirm(tenantA, botActor(k), customerA, {
      orderId: order.id,
      idempotencyKey: `${k}-confirm`,
    });
    await credit(order.totals.total.amountMinor);
    const { payment } = await ctx.container.payments.settleFromWallet(
      tenantA,
      botActor(k),
      customerA,
      { idempotencyKey: `${k}-pay`, orderId: order.id },
    );
    await ctx.container.provisionerLoop.tick();
    return { orderId: order.id, paymentId: payment.id };
  }

  const refund = (paymentId: string, amountMinor: bigint) =>
    ctx.container.refunds.request(tenantA, owner, {
      idempotencyKey: key('refund'),
      paymentId,
      amountMinor,
      reason: 'مشتری منصرف شد',
    });

  async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
    return (await ctx.container.database.db.execute(query)).rows as T[];
  }

  const suspends = (serviceId: string) =>
    rows<{ id: string; state: string }>(
      sql`SELECT id, state FROM provisioning_operations
           WHERE service_id = ${serviceId} AND type = 'SUSPEND'`,
    );

  const orderAudit = async (orderId: string) =>
    (
      await rows<{ after: Record<string, unknown> }>(
        sql`SELECT after FROM audit_logs WHERE entity_id = ${orderId} AND action = 'order.refund'`,
      )
    )[0]?.after;

  const serviceState = async (serviceId: string) =>
    (await services.findById(tenantA, serviceId))?.state;

  it('a full wallet refund of a purchase plans the service’s SUSPEND in its transaction, and the panel suspends it', async () => {
    const { serviceId, orderId, paymentId } = await boughtService();

    await refund(paymentId, PRICE);

    const planned = await suspends(serviceId);
    expect(planned).toHaveLength(1);
    expect(await orderAudit(orderId)).toMatchObject({
      state: 'REFUNDED',
      serviceSuspension: { planned: true, serviceId, operationId: planned[0]!.id },
    });
    expect(await orderAudit(orderId)).not.toHaveProperty('serviceLeftUntouched');

    await ctx.container.provisionerLoop.tick();
    expect(await serviceState(serviceId)).toBe('SUSPENDED');
  });

  it('a partial refund leaves the service alone; the refund that makes it whole suspends it, once', async () => {
    const { serviceId, paymentId } = await boughtService();

    await refund(paymentId, PRICE / 2n);
    expect(await suspends(serviceId)).toHaveLength(0);
    await ctx.container.provisionerLoop.tick();
    expect(await serviceState(serviceId)).toBe('ACTIVE');

    await refund(paymentId, PRICE / 2n);
    expect(await suspends(serviceId)).toHaveLength(1);
  });

  it('a full refund of a RENEWAL suspends the renewed service', async () => {
    const { serviceId } = await boughtService();
    const renewal = await renewed(serviceId);
    expect(await serviceState(serviceId)).toBe('ACTIVE');
    const [paid] = await rows<{ amount: string }>(
      sql`SELECT amount::text AS amount FROM payments WHERE id = ${renewal.paymentId}`,
    );

    await refund(renewal.paymentId, BigInt(paid!.amount));

    expect(await suspends(serviceId)).toHaveLength(1);
    expect(await orderAudit(renewal.orderId)).toMatchObject({
      serviceSuspension: { planned: true, serviceId },
    });
  });

  it('a service that has changed hands is not suspended for the old owner’s refund; the audit says why', async () => {
    const { serviceId, orderId, paymentId } = await boughtService();
    // The repository statements both transfer paths share, after the ownership row they need.
    const transfers = new DrizzleServiceTransferRepository(ctx.container.database.db);
    await ctx.container.database.db.transaction(async (tx) => {
      const now = ctx.container.clock.now();
      await transfers.create(
        tenantA,
        {
          id: ctx.container.ids.uuid(),
          serviceId,
          fromCustomerId: customerA,
          toCustomerId: customerB,
          botInstanceId: BOT_A,
          idempotencyKey: 'r12-refund-transfer',
          actorType: 'SYSTEM_JOB',
          actorLabel: 'test',
          correlationId: 'r12-refund-transfer' as CorrelationId,
          now,
        },
        { tx } as never,
      );
      expect(
        await transfers.reassign(
          tenantA,
          { serviceId, fromCustomerId: customerA, toCustomerId: customerB, now },
          { tx } as never,
        ),
      ).toBe(true);
    });

    await refund(paymentId, PRICE);

    expect(await suspends(serviceId)).toHaveLength(0);
    expect(await orderAudit(orderId)).toMatchObject({
      state: 'REFUNDED',
      serviceLeftUntouched: true,
      serviceSuspension: { planned: false, serviceId, reason: 'SERVICE_NOT_OWNED' },
    });
  });

  /*
   * Codex on #360: the refund locks the service's row (the lock a transfer takes first) before
   * its payment, so a transfer racing it cannot commit between the refund's owner check and
   * the suspension. Here a transfer holds the row while the refund starts; the refund waits,
   * the transfer commits, and the refund — seeing the new owner — suspends nothing.
   */
  const lockWaiters = async (): Promise<number> =>
    (
      await rows<{ n: number }>(sql`SELECT count(*)::int AS n FROM pg_stat_activity
                      WHERE datname = current_database() AND wait_event_type = 'Lock'`)
    )[0]?.n ?? 0;

  it('R12 F1: a transfer racing the full refund is never followed by the old owner’s suspension', async () => {
    const { serviceId, orderId, paymentId } = await boughtService();
    const transfers = new DrizzleServiceTransferRepository(ctx.container.database.db);
    let rowLocked!: () => void;
    const locked = new Promise<void>((resolve) => (rowLocked = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const transfer = ctx.container.database.db.transaction(async (tx) => {
      // The transfer's first lock: the service row.
      await tx.execute(sql`SELECT id FROM services WHERE id = ${serviceId} FOR NO KEY UPDATE`);
      rowLocked();
      await gate;
      const now = ctx.container.clock.now();
      await transfers.create(
        tenantA,
        {
          id: ctx.container.ids.uuid(),
          serviceId,
          fromCustomerId: customerA,
          toCustomerId: customerB,
          botInstanceId: BOT_A,
          idempotencyKey: 'r12-refund-race-transfer',
          actorType: 'SYSTEM_JOB',
          actorLabel: 'test',
          correlationId: 'r12-refund-race-transfer' as CorrelationId,
          now,
        },
        { tx } as never,
      );
      await transfers.reassign(
        tenantA,
        { serviceId, fromCustomerId: customerA, toCustomerId: customerB, now },
        { tx } as never,
      );
    });
    await locked;
    let done = false;
    const refunding = refund(paymentId, PRICE).then(
      (value) => {
        done = true;
        return value;
      },
      (error: unknown) => {
        done = true;
        throw error;
      },
    );
    for (let i = 0; i < 200 && !done && (await lockWaiters()) === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    release();
    await transfer;
    await expect(refunding).resolves.toMatchObject({ state: 'COMPLETED' });

    expect(await suspends(serviceId)).toHaveLength(0);
    expect(await orderAudit(orderId)).toMatchObject({
      state: 'REFUNDED',
      serviceSuspension: { planned: false, serviceId, reason: 'SERVICE_NOT_OWNED' },
    });
  });

  it('a service already suspended is left as it is, and the refund still completes', async () => {
    const { serviceId, orderId, paymentId } = await boughtService();
    await ctx.container.database.db.execute(
      sql`UPDATE services SET state = 'SUSPENDED' WHERE id = ${serviceId}`,
    );

    await expect(refund(paymentId, PRICE)).resolves.toMatchObject({ state: 'COMPLETED' });

    expect(await suspends(serviceId)).toHaveLength(0);
    expect(await orderAudit(orderId)).toMatchObject({
      serviceSuspension: { planned: false, reason: 'SERVICE_SUSPENDED' },
    });
  });
});
