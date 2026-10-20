import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  money,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type DomainEvent,
  type TemplateKey,
  type UserId,
} from '@nexa/contracts';
import { DrizzleOpsLogFacts } from '../../apps/api/src/modules/commerce/ops-log/infrastructure/drizzle-ops-log-facts';
import { i18nOpsLogWords as words } from '../../apps/api/src/modules/commerce/ops-log/infrastructure/i18n-ops-log-words';
import { FinancialLogConsumer } from '../../apps/api/src/modules/commerce/payments/application/financial-log.consumer';
import { DrizzlePaymentRepository } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-payment.repository';
import { DrizzleCustomerRepository } from '../../apps/api/src/modules/commerce/customers/infrastructure/drizzle-customer.repository';
import { DrizzleGatewayInvoiceRepository } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-gateway-invoice.repository';
import { DrizzleServiceRefundRequestRepository } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-service-refund-request.repository';
import {
  serviceAlert,
  serviceChanged,
  serviceCreated,
  type Built,
} from '../../apps/api/src/modules/commerce/ops-log/application/presenters';
import type {
  CustomerFact,
  OrderFact,
  ServiceFact,
} from '../../apps/api/src/modules/commerce/ops-log/application/ports';
import {
  SEED_IDS,
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
  type TestContext,
} from './harness';

/**
 * Round 4 PR-D — the money the operations log prints, against the real SQL (Codex and money
 * review of #301).
 *
 *  - The wallet before → after is in COMMIT order. A writer stamps its entry before it waits
 *    for the customer lock, so the debit that waited carries the earlier `created_at`; the
 *    race is reproduced here with the lock held on a second connection.
 *  - The financial log's array predicates (`IN (…)`) run for real: a top-up with its gift, a
 *    wallet-funded order, and two partial wallet refunds, each message around ITS OWN credit.
 *  - A message with bigint placeholders survives queue → dispatch → render.
 *  - The storm roll-up counts the error that lost the roll-up's create race.
 *
 * MUTATION (each reverted, the named test failed, restored):
 *  - `balanceAround` ordered by `(created_at, id)` again -> the race test (0 → -100 000);
 *  - L6 reading the payment's newest REFUND entry -> the partial-refunds test;
 *  - `deserialiseValues` leaving a whole-number string a string -> the dispatch test;
 *  - the bump after a conflicting roll-up create removed -> the storm race test (count 1).
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const GIB = 1024n ** 3n;
const irt = (n: bigint) => money(n, 'IRT');
const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

describe('the operations log’s money, through the real SQL', () => {
  let ctx: TestContext;
  let owner: ActorContext;
  let facts: DrizzleOpsLogFacts;
  let seq = 0;
  const key = (label: string) => `oplog-money-${label}-${String((seq += 1))}`;
  const exec = (query: ReturnType<typeof sql>) => ctx.container.database.db.execute(query);
  const uuid = () => ctx.container.ids.uuid();
  const run = <T>(work: (tx: never) => Promise<T>) =>
    ctx.container.uow.run(tenantA, (tx) => work(tx as never));

  beforeAll(async () => {
    ctx = await createTestContext({ NOTIFICATION_TRANSPORT: 'recording' });
  }, 120_000);
  afterAll(async () => {
    await ctx?.close();
  });
  beforeEach(async () => {
    await ctx.reset();
    ctx.container.setInstallationTenant(tenantA.tenantId);
    facts = new DrizzleOpsLogFacts(ctx.container.database.db);
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'owner-oplog-money',
        roleKeys: ['owner'],
      }),
    );
  });

  async function customer(telegramId: string): Promise<UserId> {
    const { customer: created } = await ctx.container.customers.resolveFromUpdate(
      tenantA,
      systemActor(`resolve-${telegramId}`),
      {
        idempotencyKey: `resolve-${telegramId}`,
        telegramUserId: telegramId,
        from: { id: Number(telegramId), first_name: 'نیما', username: `u${telegramId}` },
        botInstanceId: BOT_A,
      },
    );
    return created.id;
  }

  // -------------------------------------------------------------------------------------
  // B1 — commit order, not created_at
  // -------------------------------------------------------------------------------------

  it('a debit that waited behind a credit shows the balance in COMMIT order, never its earlier stamp', async () => {
    const c = await customer('951001');
    const adjust = (direction: 'CREDIT' | 'DEBIT', label: string) =>
      ctx.container.wallet.adjust(tenantA, owner, c, {
        idempotencyKey: key(label),
        direction,
        amountMinor: 100_000n,
        currency: 'IRT',
        note: 'آزمایش ترتیب',
      });

    // A second connection holds the customer's row the way any UPDATE of it does (FOR NO KEY
    // UPDATE — a profile refresh, a block): the debit's `lockCustomer` (FOR UPDATE) waits on
    // it, and the credit's foreign-key check (FOR KEY SHARE) does not.
    const holder = await ctx.container.database.pool.connect();
    let debit: Promise<unknown>;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM customers WHERE id = $1 FOR NO KEY UPDATE', [c]);
      // The debit stamps its entry NOW and then waits for the lock.
      debit = adjust('DEBIT', 'debit');
      const deadline = Date.now() + 10_000;
      for (;;) {
        // Asked on the pool, not on the holder: inside a transaction the activity view is a
        // snapshot taken once, and would never show the waiter.
        const waiting = (await exec(
          sql`SELECT 1 FROM pg_stat_activity
               WHERE datname = current_database() AND wait_event_type = 'Lock'
                 AND query ILIKE '%from "customers"%for update%'` as never,
        )) as unknown as { rows: unknown[] };
        if (waiting.rows.length > 0) break;
        if (Date.now() > deadline) throw new Error('the debit never waited for the lock');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      // An operator's credit takes no customer lock: it commits while the debit waits, with a
      // LATER created_at than the debit's, and takes the wallet's outbox sequence first.
      await adjust('CREDIT', 'credit');
      await holder.query('COMMIT');
    } finally {
      holder.release();
    }
    await debit;

    const rows = (
      (await exec(
        sql`SELECT id, direction, created_at FROM wallet_entries
             WHERE customer_id = ${c} ORDER BY created_at, id` as never,
      )) as unknown as { rows: { id: string; direction: string }[] }
    ).rows;
    // The race really happened: the debit carries the earlier stamp.
    expect(rows.map((row) => row.direction)).toEqual(['DEBIT', 'CREDIT']);
    const debitId = rows[0]!.id;
    const creditId = rows[1]!.id;

    const around = (id: string) => run((tx) => facts.balanceAround(tenantA, c, 'IRT', [id], tx));
    expect(await around(creditId)).toEqual({ before: irt(0n), after: irt(100_000n) });
    // Summed by created_at this was 0 → -100 000.
    expect(await around(debitId)).toEqual({ before: irt(100_000n), after: irt(0n) });
  }, 30_000);

  // -------------------------------------------------------------------------------------
  // A1 / B2 — the financial log's SQL
  // -------------------------------------------------------------------------------------

  async function payment(input: {
    customerId: string;
    orderId: string | null;
    method: string;
    amount: bigint;
  }): Promise<string> {
    const id = uuid();
    await exec(sql`INSERT INTO payments (id, tenant_id, customer_id, order_id, state, method, amount,
        currency, reference, evidence_kind, confirmed_at, resolved_at, created_at)
      VALUES (${id}, ${tenantA.tenantId}, ${input.customerId}, ${input.orderId}, 'CONFIRMED',
        ${input.method}, ${input.amount.toString()}, 'IRT', ${key('NGT')}, 'OPERATOR_REVIEW',
        now(), NULL, now())`);
    return id;
  }

  async function entry(input: {
    customerId: string;
    direction: 'CREDIT' | 'DEBIT';
    reason: string;
    amount: bigint;
    at: string;
    paymentId?: string | null;
    orderId?: string | null;
    reference?: string;
  }): Promise<string> {
    const id = uuid();
    await exec(sql`INSERT INTO wallet_entries (id, tenant_id, customer_id, direction, reason, amount,
        currency, reference, payment_id, order_id, created_at)
      VALUES (${id}, ${tenantA.tenantId}, ${input.customerId}, ${input.direction}, ${input.reason},
        ${input.amount.toString()}, 'IRT', ${input.reference ?? key('ref')},
        ${input.paymentId ?? null}, ${input.orderId ?? null}, ${input.at}::timestamptz)`);
    return id;
  }

  async function order(customerId: string): Promise<string> {
    const panelId = uuid();
    const productId = uuid();
    const id = uuid();
    await exec(sql`INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelId}, ${tenantA.tenantId}, 'پنل ۱', 'sanaei', 'https://a.example.test', 'ACTIVE')`);
    await exec(sql`INSERT INTO products (id, tenant_id, title, status, duration_days, traffic_bytes, panel_id, price_amount, price_currency)
      VALUES (${productId}, ${tenantA.tenantId}, 'Plan', 'ACTIVE', 30, 1073741824, ${panelId}, 250000, 'IRT')`);
    await exec(sql`INSERT INTO orders (id, tenant_id, customer_id, state, purpose, product_id, panel_id,
        line_title, line_duration_days, line_traffic_bytes, line_quantity, line_unit_price_amount,
        line_category_name, subtotal_amount, discount_amount, total_amount, currency, quote,
        confirmed_at, settled_at, created_at)
      VALUES (${id}, ${tenantA.tenantId}, ${customerId}, 'PAID', 'NEW_SERVICE', ${productId}, ${panelId},
        'Plan', 30, 1073741824, 1, 250000, 'دسته', 250000, 0, 250000, 'IRT', '{}'::jsonb,
        now(), now(), now())`);
    return id;
  }

  function consumer(queued: { templateKey: string; values: Record<string, unknown> }[]) {
    const db = ctx.container.database.db;
    return new FinancialLogConsumer({
      lane: {
        financialDestination: async () =>
          ({ transport: 'TELEGRAM', chatId: '-1001', topicId: null }) as never,
        queue: async (_scope, input) => {
          queued.push({ templateKey: input.templateKey, values: input.values as never });
          return undefined;
        },
      },
      payments: new DrizzlePaymentRepository(db),
      customers: new DrizzleCustomerRepository(db),
      invoices: new DrizzleGatewayInvoiceRepository(db),
      facts,
      words,
      refundRequests: new DrizzleServiceRefundRequestRepository(db),
    });
  }

  function event(eventType: string, aggregateId: string, payload: unknown): DomainEvent {
    return {
      eventId: uuid(),
      eventType,
      eventVersion: 1,
      tenantId: String(tenantA.tenantId),
      aggregateType: 'Payment',
      aggregateId,
      sequence: 1,
      correlationId: 'oplog-money',
      causationId: null,
      actor: { type: 'SYSTEM_JOB', id: null },
      occurredAt: new Date().toISOString(),
      payload,
    } as unknown as DomainEvent;
  }

  it('a top-up with its gift, a wallet order and two partial wallet refunds, each around its own entries', async () => {
    const c = await customer('951002');
    await entry({
      customerId: c,
      direction: 'CREDIT',
      reason: 'ADMIN_CREDIT',
      amount: 10_000n,
      at: '2026-10-12T08:00:00Z',
    });

    // A top-up: the principal and the gift, two reasons of one payment (an IN list of reasons).
    const topup = await payment({
      customerId: c,
      orderId: null,
      method: 'MANUAL_TRANSFER',
      amount: 500_000n,
    });
    await entry({
      customerId: c,
      direction: 'CREDIT',
      reason: 'TOPUP_RECEIPT',
      amount: 500_000n,
      at: '2026-10-12T08:10:00Z',
      paymentId: topup,
    });
    await entry({
      customerId: c,
      direction: 'CREDIT',
      reason: 'CASHBACK_TOPUP',
      amount: 50_000n,
      at: '2026-10-12T08:10:01Z',
      paymentId: topup,
    });

    // A wallet-funded order: its purchase debit.
    const ordered = await order(c);
    const walletPayment = await payment({
      customerId: c,
      orderId: ordered,
      method: 'WALLET',
      amount: 250_000n,
    });
    await entry({
      customerId: c,
      direction: 'DEBIT',
      reason: 'PURCHASE',
      amount: 250_000n,
      at: '2026-10-12T08:20:00Z',
      orderId: ordered,
      paymentId: walletPayment,
    });

    // Two partial refunds of it, the second written before the first's message is rendered.
    await entry({
      customerId: c,
      direction: 'CREDIT',
      reason: 'REFUND',
      amount: 100_000n,
      at: '2026-10-12T08:30:00Z',
      orderId: ordered,
      paymentId: walletPayment,
      reference: 'rf-a:refund',
    });
    await entry({
      customerId: c,
      direction: 'CREDIT',
      reason: 'REFUND',
      amount: 50_000n,
      at: '2026-10-12T08:40:00Z',
      orderId: ordered,
      paymentId: walletPayment,
      reference: 'rf-b:refund',
    });

    const queued: { templateKey: string; values: Record<string, unknown> }[] = [];
    const log = consumer(queued);
    const confirmed = (paymentId: string, orderId: string | null, method: string, amount: string) =>
      event('PaymentConfirmed', paymentId, {
        customerId: c,
        orderId,
        method,
        evidenceKind: 'OPERATOR_REVIEW',
        amountMinor: amount,
        currency: 'IRT',
      });
    const refunded = (refundId: string, amount: string) =>
      event('RefundCompleted', walletPayment, {
        refundId,
        customerId: c,
        paymentId: walletPayment,
        orderId: ordered,
        channel: 'WALLET_CREDIT',
        amountMinor: amount,
        currency: 'IRT',
      });

    await run((tx) => log.handle(confirmed(topup, null, 'MANUAL_TRANSFER', '500000'), tx));
    await run((tx) => log.handle(confirmed(walletPayment, ordered, 'WALLET', '250000'), tx));
    await run((tx) => log.handle(refunded('rf-a', '100000'), tx));
    await run((tx) => log.handle(refunded('rf-b', '50000'), tx));

    expect(queued.map((one) => one.templateKey)).toEqual([
      'ops.financial.topup_credited',
      'ops.financial.order_paid',
      'ops.financial.refund_completed',
      'ops.financial.refund_completed',
    ]);
    const [top, paid, first, second] = queued.map((one) => one.values);
    // The top-up's two entries together: 10 000 → 560 000, and the gift read from the ledger.
    expect(top).toMatchObject({
      balanceBefore: irt(10_000n),
      balanceAfter: irt(560_000n),
      gift: irt(50_000n),
    });
    expect(paid).toMatchObject({ balanceBefore: irt(560_000n), balanceAfter: irt(310_000n) });
    // Each refund around ITS OWN credit, not the payment's newest.
    expect(first).toMatchObject({ balanceBefore: irt(310_000n), balanceAfter: irt(410_000n) });
    expect(second).toMatchObject({ balanceBefore: irt(410_000n), balanceAfter: irt(460_000n) });
  });

  it('reads role names and permission counts for a list of role keys through the real SQL', async () => {
    const names = await run((tx) => facts.roleNames(tenantA, ['owner', 'finance', 'nope'], tx));
    expect([...names.keys()].sort()).toEqual(['finance', 'owner']);
    const one = await run((tx) => facts.permissionCountOf(tenantA, ['finance'], tx));
    const both = await run((tx) => facts.permissionCountOf(tenantA, ['finance', 'owner'], tx));
    expect(one).toBeGreaterThan(0);
    expect(both).toBeGreaterThanOrEqual(one);
    expect(await run((tx) => facts.permissionCountOf(tenantA, [], tx))).toBe(0);
  });

  // -------------------------------------------------------------------------------------
  // A2 — queue → dispatch → render with bigint placeholders
  // -------------------------------------------------------------------------------------

  async function enableLane(): Promise<void> {
    await ctx.container.featureFlags.set(tenantA, owner, {
      key: 'ops_notifications',
      enabled: true,
      expectedVersion: null,
      idempotencyKey: key('flag'),
      confirmKey: 'ops_notifications',
      reason: 'ops log money test',
    });
    await ctx.container.settingsService.set(tenantA, owner, {
      key: 'ops.notifications.telegram_chat_id',
      value: '-1001234567890',
      expectedVersion: null,
      idempotencyKey: key('chat'),
    });
  }

  const customerFact: CustomerFact = {
    id: 'cust-1',
    telegramUserId: '700100200',
    username: 'nima_t',
    firstName: 'نیما',
    lastName: null,
    phone: null,
    source: 'NEXA',
    status: 'ACTIVE',
    blockedReason: null,
  };
  const orderFact = (purpose: string): OrderFact => ({
    id: 'ord-1',
    code: 'KQ7M2X9T',
    customerId: 'cust-1',
    purpose,
    origin: 'STANDARD',
    source: 'NEXA',
    state: 'FULFILLED',
    title: 'پلن آزمایشی',
    durationDays: 30,
    trafficBytes: 50n * GIB,
    panelId: 'pan-1',
    panelName: 'پنل آزمایشی',
    locationLabel: null,
    subtotal: irt(250_000n),
    discount: irt(0n),
    total: irt(250_000n),
    settledAt: new Date('2026-10-12T09:30:00Z'),
    isFirstPurchase: true,
    reseller: false,
    resellerListPrice: null,
  });
  const serviceFact: ServiceFact = {
    id: 'svc-1',
    code: 'SV3H5J7K',
    customerId: 'cust-1',
    orderId: 'ord-1',
    panelId: 'pan-1',
    panelName: 'پنل آزمایشی',
    providerUsername: 'nxtest01',
    isTrial: false,
    state: 'ACTIVE',
    expiresAt: new Date('2026-11-11T00:00:00Z'),
    trafficLimitBytes: 60n * GIB,
    trafficUsedBytes: 10n * GIB,
    lastSeenAt: null,
    source: 'NEXA',
  };
  const AT = new Date('2026-10-12T09:30:00Z');
  const operationFact = (type: string) => ({
    id: 'op-1',
    type,
    state: 'SUCCEEDED',
    serviceId: 'svc-1',
    orderId: 'ord-1',
    requestedByCustomerId: 'cust-1',
    panelId: 'pan-1',
    failureKind: null,
    failureMessage: null,
    targetExpiresAt: new Date('2026-12-11T00:00:00Z'),
    targetTrafficLimitBytes: 60n * GIB,
    completedAt: AT,
  });

  it('a service created, extra traffic, a renewal and an alert are rendered and SENT, not render_failed', async () => {
    await enableLane();
    const built: Built[] = [
      serviceCreated({
        order: orderFact('NEW_SERVICE'),
        service: serviceFact,
        customer: customerFact,
        payment: null,
        walletBalance: null,
        at: AT,
        words,
      }),
      serviceChanged({
        kind: 'ADD_TRAFFIC',
        order: { ...orderFact('ADD_TRAFFIC'), trafficBytes: 10n * GIB },
        service: serviceFact,
        operation: operationFact('ADD_TRAFFIC'),
        before: { expiresAt: null, trafficLimitBytes: 50n * GIB, trafficUsedBytes: 5n * GIB },
        customer: customerFact,
        payment: null,
        walletBalance: null,
        at: AT,
        words,
      }),
      serviceChanged({
        kind: 'RENEW',
        order: orderFact('RENEW'),
        service: serviceFact,
        operation: operationFact('RENEW'),
        before: {
          expiresAt: new Date('2026-11-11T00:00:00Z'),
          trafficLimitBytes: 50n * GIB,
          trafficUsedBytes: 42n * GIB,
        },
        customer: customerFact,
        payment: null,
        walletBalance: null,
        at: AT,
        words,
      }),
      serviceAlert({
        kind: 'USAGE_FIRST',
        service: serviceFact,
        customer: customerFact,
        remainingDays: 3,
        at: AT,
        words,
      }),
    ];
    // Each carries a bigint value — the shape that used to fail at render.
    for (const one of built) {
      expect(
        Object.values(one.values).some((value) => typeof value === 'bigint'),
        one.templateKey,
      ).toBe(true);
      const result = await ctx.container.notifications.queue(tenantA, {
        kind: 'OPERATIONAL_EVENT',
        dedupeKey: key(`dispatch-${one.logType}`),
        templateKey: one.templateKey as TemplateKey,
        values: one.values,
        logType: one.logType,
        buttons: one.buttons,
      });
      expect(result.created, one.templateKey).toBe(true);
    }
    for (let round = 0; round < 5; round += 1) await ctx.container.notificationDispatcher.tick();
    const rows = (
      (await exec(
        sql`SELECT n.template_key, n.status,
                   (SELECT a.error_code FROM notification_delivery_attempts a
                     WHERE a.notification_id = n.id ORDER BY a.attempt_number DESC LIMIT 1) AS error
              FROM notifications n
             WHERE n.tenant_id = ${tenantA.tenantId} AND n.kind = 'OPERATIONAL_EVENT'
             ORDER BY n.template_key` as never,
      )) as unknown as { rows: { template_key: string; status: string; error: string | null }[] }
    ).rows;
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.error, row.template_key).not.toBe('notification.render_failed');
      expect(row.status, row.template_key).toBe('SENT');
    }
  }, 60_000);

  // -------------------------------------------------------------------------------------
  // A4 — the storm roll-up's create race
  // -------------------------------------------------------------------------------------

  it('an error that loses the roll-up’s create race is counted into the roll-up that won', async () => {
    await enableLane();
    for (const [settingKey, value] of [
      ['ops.log.storm_rollup_enabled', true],
      ['ops.log.storm_threshold', 2],
    ] as const) {
      await ctx.container.settingsService.set(tenantA, owner, {
        key: settingKey,
        value,
        expectedVersion: null,
        idempotencyKey: key('storm'),
      });
    }
    const input = (customerKey: string, dedupeKey: string) => ({
      kind: 'OPERATIONAL_EVENT' as const,
      dedupeKey,
      templateKey: 'ops.log.error_provision' as TemplateKey,
      values: {
        displayName: 'نیما',
        username: '@nima',
        telegramId: customerKey,
        cause: 'ساخت روی پنل ممکن نشد',
        technical: 'HTTP 502',
        impact: 'هیچ مبلغی برنگشت',
        productTitle: 'پلن',
        amount: irt(1_000n),
        at: AT,
      },
      logType: 'ERROR_PROVISION' as const,
      storm: {
        key: 'panel-race:502',
        customer: customerKey,
        rollup: {
          heading: 'خطای ساخت سرویس',
          cause: 'ساخت روی پنل ممکن نشد',
          technical: 'HTTP 502',
        },
      },
    });
    // The first two errors are their own messages; the window is now at its threshold.
    expect((await ctx.container.notifications.queue(tenantA, input('c0', 'race-0'))).created).toBe(
      true,
    );
    expect((await ctx.container.notifications.queue(tenantA, input('c1', 'race-1'))).created).toBe(
      true,
    );

    // Replica A, inside an open transaction, creates the roll-up and has not committed.
    const replicaA = ctx.container.uow.run(tenantA, async (tx) => {
      await ctx.container.notifications.queue(tenantA, input('c2', 'race-2'), tx);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    // Replica B finds no roll-up to bump (A's is uncommitted), and its create waits on A's key.
    const replicaB = ctx.container.notifications.queue(tenantA, input('c3', 'race-3'));
    await replicaA;
    expect((await replicaB).created).toBe(false);

    const rollup = (
      (await exec(
        sql`SELECT payload FROM notifications
             WHERE tenant_id = ${tenantA.tenantId} AND template_key = 'ops.log.storm_rollup'` as never,
      )) as unknown as { rows: { payload: Record<string, unknown> }[] }
    ).rows;
    expect(rollup).toHaveLength(1);
    // Two errors, from two customers: the one that lost the race is not lost.
    expect(rollup[0]!.payload).toMatchObject({ count: 2, users: 2 });
  }, 30_000);
});
