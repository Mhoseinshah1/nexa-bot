import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  money,
  templateDefinition,
  PANEL_UNHEALTHY_AFTER_FAILURES,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type PanelId,
  type ProductId,
  type UserId,
  type ProductCategoryId,
} from '@nexa/contracts';
import { CATALOGUE_FA, formatMoney, renderTemplateBody } from '@nexa/i18n';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { DrizzleWalletRepository } from '../../apps/api/src/modules/commerce/wallet/infrastructure/drizzle-wallet.repository';
import type { ProductDraft } from '../../apps/api/src/modules/commerce/catalog/application/ports';
import type { OrderRecord } from '../../apps/api/src/modules/commerce/orders/application/ports';
import {
  SEED_IDS,
  adminActorFor,
  createAdmin,
  createTestContext,
  makePanelSellable,
  tenantA,
  tenantB,
  type SeededAdmin,
  type TestContext,
} from './harness';

/**
 * Money that arrived for something this installation cannot deliver goes back.
 *
 * Two outcomes and no third. The order is FULFILLED or it is REFUNDED, and the
 * refund is automatic, for the exact amount, in the transaction that discovers the
 * delivery is impossible. There is no state for "paid, undelivered, somebody will
 * decide later" and no operator action that produces one.
 *
 * Two rules carry everything here, and they pull in opposite directions on purpose:
 *
 *   - recording the RECEIPT of money is independent of the ability to fulfil it, so
 *     a bank transfer whose panel filled up while the receipt sat in the queue is
 *     CONFIRMED rather than refused. Refusing left it `PENDING` — neither
 *     confirmable nor refundable — with the money in the bank and no record of what
 *     it was for (Codex C4 on PR #50);
 *
 *   - a WALLET purchase is refused instead, and never refunded, because the debit is
 *     written in the settling transaction and dies with it. Crediting it back would
 *     be a credit for money that never left, and an installation that cannot deliver
 *     should not take money it can still decline.
 *
 * Everything else is a consequence: exactly one credit, exactly one refund row, the
 * capacity slot back, one record for an operator, one message for the customer, and
 * none of it twice on a replay.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

describe('an order that cannot be delivered is refunded', () => {
  let ctx: TestContext;
  let products: DrizzleProductRepository;
  let panelA: string;
  let panelSpare: string;
  /**
   * A MARZBAN panel, because a renewal needs a provider that can perform one.
   *
   * 3X-UI declares `CREATE_USER` and nothing else, so `decideOperability` refuses a
   * `RENEW` on it before anything else is asked — which would make the commercial
   * cases below pass for the wrong reason. Created through `PanelService` rather
   * than inserted, because operability also reads the CREDENTIAL timestamps and the
   * activation, and a hand-written row has neither: the refusal would then be
   * `CREDENTIALS_MISSING`, which is the same colour and a different fact.
   *
   * Its base URL names nothing that answers, and nothing here dials it: these cases
   * end at the settlement, which writes rows. The panel is contacted by the
   * provisioner, which `service-management.test.ts` drives against a real fake.
   */
  let panelRenew: string;
  let panelForeign: string;
  let customerA: UserId;
  let owner: ActorContext;
  let finance: ActorContext;
  let n = 0;
  const key = (): string => `refund-key-${(n += 1)}`;

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
    panelSpare = ctx.container.ids.uuid();
    panelForeign = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelA}, ${tenantA.tenantId}, 'Panel A', 'sanaei', 'https://a.example.test', 'ACTIVE'),
             (${panelSpare}, ${tenantA.tenantId}, 'Panel Spare', 'sanaei', 'https://s.example.test', 'ACTIVE'),
             (${panelForeign}, ${tenantB.tenantId}, 'Panel B', 'sanaei', 'https://b.example.test', 'ACTIVE')`);
    /*
     * Each one made GENUINELY sellable, rather than left as a bare row.
     *
     * A panel with no credentials, no activation and no probe cannot create an
     * account, and since this hotfix `decideEligibility` refuses to take money
     * for one — which is the whole fix. These cases are about what happens when
     * a panel that COULD deliver stops being able to, so the fixture has to be a
     * panel that could. `makePanelSellable` writes the three things a sale now
     * requires, using the production identity function so it cannot drift.
     */
    await makePanelSellable(ctx.container, tenantA, panelA);
    await makePanelSellable(ctx.container, tenantA, panelSpare);
    await makePanelSellable(ctx.container, tenantB, panelForeign);
    customerA = await customer('900801');
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'owner-refund',
        roleKeys: ['owner'],
      }),
    );
    finance = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'finance-refund',
        roleKeys: ['finance'],
      }),
    );
    const renewable = await ctx.container.panels.create(tenantA, owner, {
      name: 'Panel Renew',
      providerType: 'marzban',
      baseUrl: 'https://renew.example.test',
      credentials: { username: 'nexa', password: 'not-a-real-password' },
      activation: { proxyProtocols: ['vless'], inboundTags: { vless: ['VLESS TCP'] } },
      idempotencyKey: 'panel-renew-create',
    });
    panelRenew = renewable.view.panel.id;
  });

  // -------------------------------------------------------------------------
  // Fixtures
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

  const draft = (panelId: string): ProductDraft => ({
    title: 'پلن پایه',
    description: 'یک ماهه',
    audience: 'EVERYONE',
    sortOrder: 10,
    panelId: panelId as PanelId,
    categoryId: SEED_IDS.categoryA as ProductCategoryId,
    specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: 2 },
    price: money(250_000n, 'IRT'),
  });

  /** An order in `AWAITING_PAYMENT`, made the way a customer makes one. */
  async function awaitingPayment(panelId: string): Promise<OrderRecord> {
    const created = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: draft(panelId),
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, created.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    const k = key();
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

  /** A manual transfer awaiting review — the money is in the bank by now. */
  async function pendingTransfer(order: OrderRecord): Promise<string> {
    const k = key();
    const { payment } = await ctx.container.payments.requestManualTransfer(
      tenantA,
      systemActor(k),
      customerA,
      { idempotencyKey: `${k}-manual`, orderId: order.id },
    );
    return payment.id;
  }

  const confirmTransfer = (paymentId: string, reviewer: ActorContext = finance) =>
    ctx.container.payments.confirmManualTransfer(tenantA, reviewer, paymentId, {
      idempotencyKey: key(),
      note: 'کارت به کارت',
    });

  const setCap = (panelId: string, cap: number | null) =>
    ctx.container.database.db.execute(
      sql`UPDATE panels SET max_services = ${cap} WHERE id = ${panelId}`,
    );

  const setStatus = (panelId: string, status: string) =>
    ctx.container.database.db.execute(sql`
      UPDATE panels
         SET status = ${status},
             archived_at = CASE WHEN ${status} = 'ARCHIVED' THEN now() ELSE NULL END
       WHERE id = ${panelId}`);

  const setHealth = (panelId: string, state: string, streak: number) =>
    ctx.container.database.db.execute(sql`
      INSERT INTO panel_health (panel_id, tenant_id, state, checked_at, latency_ms, failure,
                                unusable_streak)
      VALUES (${panelId}, ${tenantA.tenantId}, ${state}, ${ctx.container.clock.now()}, 5,
              'AUTHENTICATION_FAILED', ${streak})
      ON CONFLICT (panel_id) DO UPDATE
         SET state = EXCLUDED.state, checked_at = EXCLUDED.checked_at,
             failure = EXCLUDED.failure, unusable_streak = EXCLUDED.unusable_streak`);

  /** Drops the order's hold, which is what an expired reservation amounts to. */
  const expireHold = (orderId: string) =>
    ctx.container.database.db.execute(
      sql`DELETE FROM panel_capacity_reservations WHERE order_id = ${orderId}`,
    );

  /** Occupy the panel with somebody else's service, so its last slot is gone. */
  async function occupy(panelId: string): Promise<string> {
    const other = await customer(`9008${String(80 + n)}`);
    const product = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: draft(panelId),
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, product.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    const k = key();
    const order = await ctx.container.orders.createDraft(tenantA, systemActor(k), {
      idempotencyKey: `${k}-occupy`,
      customerId: other,
      productId: product.id,
    });
    return placeService(panelId, other, order.id, product.id);
  }

  /**
   * An ACTIVE service on a panel, written directly.
   *
   * Direct SQL, because what these cases need is a service that EXISTS so a
   * commercial order can be drafted against it — not a provisioning run. The real
   * create path is `provisioning.test.ts`'s and `service-management.test.ts`'s, both
   * of which drive a fake panel; reproducing that here would test the panel rather
   * than the refund.
   */
  async function placeService(
    panelId: string,
    customerId: UserId,
    orderId: string,
    productId: string,
  ): Promise<string> {
    const id = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO services (id, tenant_id, customer_id, order_id, panel_id, product_id,
                            provider_username, subscription_ref, provider_client_id,
                            traffic_limit_bytes, state, provisioned_at, expires_at)
      VALUES (${id}, ${tenantA.tenantId}, ${customerId}, ${orderId},
              ${panelId}, ${productId}, ${'u' + String(n) + Math.random().toString(16).slice(2, 8)},
              ${Math.random().toString(16).slice(2).padEnd(32, '0').slice(0, 32)},
              ${ctx.container.ids.uuid()}, 0, 'ACTIVE', now(), now() + interval '30 days')`);
    return id;
  }

  /** A customer's own ACTIVE service, for the commercial cases. */
  async function ownService(panelId: string): Promise<string> {
    const created = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: draft(panelId),
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, created.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    const k = key();
    const order = await ctx.container.orders.createDraft(tenantA, systemActor(k), {
      idempotencyKey: `${k}-own`,
      customerId: customerA,
      productId: created.id,
    });
    return placeService(panelId, customerA, order.id, created.id);
  }

  /** A RENEW of that service, confirmed and awaiting a manual transfer. */
  async function renewalByTransfer(
    serviceId: string,
  ): Promise<{ orderId: string; paymentId: string }> {
    const k = key();
    const { order } = await ctx.container.commercialActions.draft(
      tenantA,
      systemActor(k),
      customerA,
      { serviceId, kind: 'RENEW', idempotencyKey: `${k}-quote` },
    );
    await ctx.container.commercialActions.confirm(tenantA, systemActor(k), customerA, {
      orderId: order.id,
      idempotencyKey: `${k}-confirm`,
    });
    const { payment } = await ctx.container.payments.requestManualTransfer(
      tenantA,
      systemActor(k),
      customerA,
      { idempotencyKey: `${k}-manual`, orderId: order.id },
    );
    return { orderId: order.id, paymentId: payment.id };
  }

  const orderRow = async (orderId: string) => {
    const rows = (await ctx.container.database.db.execute(
      sql`SELECT state, settled_at, refunded_at, panel_id FROM orders WHERE id = ${orderId}` as never,
    )) as unknown as {
      rows: {
        state: string;
        // Raw `execute` bypasses drizzle's column mapping, so these arrive as the
        // driver's own text form rather than a Date. Typed as they actually are.
        settled_at: string | null;
        refunded_at: string | null;
        panel_id: string;
      }[];
    };
    return rows.rows[0];
  };

  /** Every refund against one order, so "exactly one" is asserted and not assumed. */
  const refundsFor = async (orderId: string) => {
    const rows = (await ctx.container.database.db.execute(
      sql`SELECT state, channel, reason, amount::text AS amount, currency,
                 requested_by_admin_id, completed_by_admin_id
            FROM refunds WHERE order_id = ${orderId}` as never,
    )) as unknown as {
      rows: {
        state: string;
        channel: string;
        reason: string;
        amount: string;
        currency: string;
        requested_by_admin_id: string | null;
        completed_by_admin_id: string | null;
      }[];
    };
    return rows.rows;
  };

  /** Every wallet movement for one customer, direction and reason included. */
  const walletEntriesFor = async (customerId: UserId) => {
    const rows = (await ctx.container.database.db.execute(
      sql`SELECT direction, reason, amount::text AS amount, reference
            FROM wallet_entries WHERE customer_id = ${customerId}
           ORDER BY created_at, id` as never,
    )) as unknown as {
      rows: { direction: string; reason: string; amount: string; reference: string }[];
    };
    return rows.rows;
  };

  /** What the customer lane holds for one order. */
  const customerNotices = async (orderId: string): Promise<string[]> => {
    const rows = (await ctx.container.database.db.execute(
      sql`SELECT kind FROM customer_notifications WHERE subject_id = ${orderId}` as never,
    )) as unknown as { rows: { kind: string }[] };
    return rows.rows.map((row) => row.kind);
  };

  const outboxCount = async (eventType: string): Promise<number> => {
    const rows = (await ctx.container.database.db.execute(
      sql`SELECT count(*)::int AS n FROM outbox_messages WHERE event_type = ${eventType}` as never,
    )) as unknown as { rows: { n: number }[] };
    return rows.rows[0]?.n ?? 0;
  };

  const holdsFor = async (orderId: string): Promise<number> => {
    const rows = (await ctx.container.database.db.execute(
      sql`SELECT count(*)::int AS n FROM panel_capacity_reservations
           WHERE order_id = ${orderId}` as never,
    )) as unknown as { rows: { n: number }[] };
    return rows.rows[0]?.n ?? 0;
  };

  const countOf = async (table: 'services' | 'refunds' | 'notifications'): Promise<number> => {
    const rows = (await ctx.container.database.db.execute(
      sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)}` as never,
    )) as unknown as { rows: { n: number }[] };
    return rows.rows[0]?.n ?? 0;
  };

  const openConditions = async (code: string): Promise<number> => {
    const rows = (await ctx.container.database.db.execute(
      sql`SELECT count(*)::int AS n FROM operational_events
           WHERE code = ${code} AND resolved_at IS NULL` as never,
    )) as unknown as { rows: { n: number }[] };
    return rows.rows[0]?.n ?? 0;
  };

  /**
   * The paid amount, as the order itself records it.
   *
   * Read off the row rather than typed as a literal, because "the exact amount" is
   * the claim under test: a fixture that hard-coded 250,000 would agree with a
   * refund that credited the product price instead of what was actually charged.
   */
  const totalOf = async (orderId: string): Promise<string> => {
    const rows = (await ctx.container.database.db.execute(
      sql`SELECT total_amount::text AS total FROM orders WHERE id = ${orderId}` as never,
    )) as unknown as { rows: { total: string }[] };
    return rows.rows[0]?.total as string;
  };

  /**
   * The whole outcome of one undeliverable order, asserted in one place.
   *
   * A helper rather than six repeated expectations, because the claim is that these
   * six things happen TOGETHER: any one of them alone is a state the product no
   * longer has. A case that asserted only the order state would pass for an order
   * marked refunded with the money still taken.
   */
  async function assertRefunded(orderId: string, expected: { services: number }): Promise<void> {
    const row = await orderRow(orderId);
    expect(row?.state, 'the order is REFUNDED').toBe('REFUNDED');
    expect(row?.settled_at, 'the money did arrive, and the row still says so').not.toBeNull();
    expect(row?.refunded_at, 'and when it went back').not.toBeNull();

    const total = await totalOf(orderId);
    const refunds = await refundsFor(orderId);
    expect(refunds, 'exactly one refund, for the exact amount, on the wallet channel').toEqual([
      {
        state: 'COMPLETED',
        channel: 'WALLET_CREDIT',
        reason: 'UNDELIVERABLE',
        amount: total,
        currency: 'IRT',
        // Nobody decided it, so nobody is recorded on either side of it. A
        // fabricated actor on a money record is what the schema now refuses.
        requested_by_admin_id: null,
        completed_by_admin_id: null,
      },
    ]);

    const credits = (await walletEntriesFor(customerA)).filter(
      (entry) => entry.reason === 'REFUND',
    );
    expect(credits, 'exactly one ledger credit, for the same figure').toEqual([
      expect.objectContaining({ direction: 'CREDIT', amount: total }),
    ]);

    expect(await holdsFor(orderId), 'and the capacity hold is back').toBe(0);
    expect(await countOf('services'), 'no service was created for it').toBe(expected.services);
    expect(await customerNotices(orderId), 'and the customer was told, once').toEqual([
      'ORDER_REFUNDED_TO_WALLET',
    ]);
  }

  /**
   * THE SENTENCE THE CUSTOMER ACTUALLY RECEIVES.
   *
   * v0.2.8 told them the money had come back and named no amount and no balance.
   * A customer who cannot see their own wallet had then no way to tell a full
   * refund from a partial one, or from a message about a different order.
   *
   * The figures are read from the LEDGER by order id at send time, not carried
   * in a payload: ADR-0030 §1 refuses a parameterised payload on this lane, and
   * the reminder kinds already establish that a frozen figure is read back from
   * its durable subject. So this asserts that what `refundedForOrder` produces
   * IS what the transaction committed — the same two numbers the ledger and the
   * balance hold, read independently of the notification.
   *
   * It also asserts what must NOT be there. `ACTIVATION_INCOMPLETE` is the
   * operator's word for a panel they can go and fix; to a customer it is a code
   * they can do nothing with, and the order page is where it belongs.
   */
  it('gives the customer notice the exact committed refund and the resulting balance', async () => {
    await ctx.container.wallet.adjust(tenantA, owner, customerA, {
      idempotencyKey: key(),
      direction: 'CREDIT',
      amountMinor: 2_000_000n,
      currency: 'IRT',
      note: 'موجودی اولیه',
    });

    const order = await awaitingPayment(panelA);
    const paymentId = await pendingTransfer(order);
    await setStatus(panelA, 'DISABLED');
    await confirmTransfer(paymentId);

    // What the ledger committed, read without going near the notification.
    const credits = (await walletEntriesFor(customerA)).filter((one) => one.reason === 'REFUND');
    expect(credits, 'exactly one credit to describe').toHaveLength(1);
    const committed = BigInt(credits[0]?.amount ?? '0');
    const balance = await ctx.container.wallet.balanceForCustomer(tenantA, owner, customerA);

    // And what the lane will render from, read through the production path.
    const figures = await new DrizzleWalletRepository(ctx.container.database.db).refundedForOrder(
      tenantA,
      order.id,
    );
    expect(figures, 'the lane can name a figure at all').not.toBeNull();
    if (figures === null) return;
    expect(figures.amount.amountMinor, 'the amount is the committed credit').toBe(committed);
    expect(figures.amount.currency).toBe('IRT');
    expect(figures.balanceAfter.amountMinor, 'the balance is the one that resulted').toBe(
      balance.amountMinor,
    );

    /*
     * The rendered sentence, through the SAME catalogue the dispatcher uses.
     * A test that built its own string would pass while the template said
     * something else, which is the shape `check:i18n` exists to refuse.
     */
    const body = renderTemplateBody(
      templateDefinition('bot.order.refunded_to_wallet'),
      CATALOGUE_FA['bot.order.refunded_to_wallet'],
      { refundAmount: figures.amount, walletBalance: figures.balanceAfter },
    );
    expect(body).toContain(formatMoney(figures.amount));
    expect(body).toContain(formatMoney(figures.balanceAfter));
    for (const internal of ['ACTIVATION_INCOMPLETE', 'PANEL', 'PROVIDER', 'UNKNOWN']) {
      expect(body, `the customer was shown "${internal}"`).not.toContain(internal);
    }
    expect(await customerNotices(order.id)).toEqual(['ORDER_REFUNDED_TO_WALLET']);
  });

  // -------------------------------------------------------------------------
  // A transfer that arrived, for a purchase that cannot be delivered
  // -------------------------------------------------------------------------

  it('confirms the transfer and refunds when the hold expired and the panel is full', async () => {
    /*
     * The headline case. The customer paid, their hold lapsed while the receipt was
     * in the queue, and somebody else took the last slot. The money is real, so the
     * payment is confirmed; the service is impossible, so the money goes back.
     */
    const order = await awaitingPayment(panelA);
    const paymentId = await pendingTransfer(order);
    await setCap(panelA, 1);
    await expireHold(order.id);
    await occupy(panelA);

    const { payment, order: settled } = await confirmTransfer(paymentId);

    expect(payment.state, 'the transfer really arrived').toBe('CONFIRMED');
    expect(settled?.state).toBe('REFUNDED');
    // One service, and it is the OTHER customer's — the occupier, not this order's.
    await assertRefunded(order.id, { services: 1 });
  });

  it('refunds when the panel was DISABLED after the transfer', async () => {
    const order = await awaitingPayment(panelA);
    const paymentId = await pendingTransfer(order);
    await setStatus(panelA, 'DISABLED');

    const { payment } = await confirmTransfer(paymentId);

    expect(payment.state).toBe('CONFIRMED');
    await assertRefunded(order.id, { services: 0 });
  });

  it('refunds when the panel was ARCHIVED after the transfer', async () => {
    const order = await awaitingPayment(panelA);
    const paymentId = await pendingTransfer(order);
    await setStatus(panelA, 'ARCHIVED');

    await confirmTransfer(paymentId);

    await assertRefunded(order.id, { services: 0 });
  });

  it('refunds when the panel is CONFIRMED unhealthy', async () => {
    // Confirmed, not merely worrying: the hysteresis threshold is what makes this a
    // refusal rather than one bad probe deciding a customer's purchase.
    const order = await awaitingPayment(panelA);
    const paymentId = await pendingTransfer(order);
    await setHealth(panelA, 'UNREACHABLE', PANEL_UNHEALTHY_AFTER_FAILURES);

    await confirmTransfer(paymentId);

    await assertRefunded(order.id, { services: 0 });
  });

  // -------------------------------------------------------------------------
  // And the deliveries that still work
  // -------------------------------------------------------------------------

  it('consumes the original hold when it is still valid, and provisions normally', async () => {
    // The ordinary path, asserted here too: the change must not make a healthy
    // settlement take the refund branch.
    const order = await awaitingPayment(panelA);
    const paymentId = await pendingTransfer(order);
    await setCap(panelA, 1);

    const { order: settled } = await confirmTransfer(paymentId);

    expect(settled?.state).toBe('PAID');
    expect((await orderRow(order.id))?.refunded_at).toBeNull();
    expect(await countOf('services')).toBe(1);
    expect(await countOf('refunds'), 'and nothing went back').toBe(0);
    expect(await customerNotices(order.id)).toEqual([]);
  });

  it('acquires a FRESH slot when the hold expired and the panel has room', async () => {
    /*
     * The hold lapsed, so there is nothing to consume — the order competes for a slot
     * exactly as a new one would, under the panel's lock, and wins because there is
     * one.
     */
    const order = await awaitingPayment(panelA);
    const paymentId = await pendingTransfer(order);
    await setCap(panelA, 2);
    await expireHold(order.id);

    const { order: settled } = await confirmTransfer(paymentId);

    expect(settled?.state).toBe('PAID');
    expect(await countOf('services')).toBe(1);
    expect(await countOf('refunds')).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Exactly once
  // -------------------------------------------------------------------------

  it('refunds ONCE when the same confirmation is delivered twice', async () => {
    /*
     * The duplicate an operator's double-click, or a retried request, produces. A
     * replay is answered from the idempotency store before the settling transaction
     * opens, so nothing downstream may run a second time: not a second refund row,
     * not a second ledger credit, not a second message, and not a second event.
     *
     * The second half is the other caller — a FRESH key against a payment that is
     * already CONFIRMED. `confirmManualTransfer` answers that with the end state
     * rather than an error, because two operators pressing approve must not be told
     * the payment is broken, so what is asserted is that it changes nothing.
     */
    const order = await awaitingPayment(panelA);
    const paymentId = await pendingTransfer(order);
    await setStatus(panelA, 'DISABLED');
    const idempotencyKey = key();
    const confirm = (k: string) =>
      ctx.container.payments.confirmManualTransfer(tenantA, finance, paymentId, {
        idempotencyKey: k,
        note: 'کارت به کارت',
      });

    const first = await confirm(idempotencyKey);
    const afterFirst = await orderRow(order.id);
    const replay = await confirm(idempotencyKey);

    expect(first.payment.state).toBe('CONFIRMED');
    expect(replay.payment.state).toBe('CONFIRMED');
    expect((await orderRow(order.id))?.refunded_at, 'the replay did not re-stamp it').toBe(
      afterFirst?.refunded_at,
    );
    await assertRefunded(order.id, { services: 0 });
    expect(await outboxCount('OrderRefunded'), 'one event').toBe(1);

    const second = await confirm(key());
    expect(second.payment.state).toBe('CONFIRMED');
    expect(second.order?.state).toBe('REFUNDED');
    await assertRefunded(order.id, { services: 0 });
    expect(await outboxCount('OrderRefunded'), 'still one event').toBe(1);
    const paid = (await ctx.container.database.db.execute(
      sql`SELECT count(*)::int AS n FROM payments WHERE state = 'CONFIRMED'` as never,
    )) as unknown as { rows: { n: number }[] };
    expect(paid.rows[0]?.n, 'one payment, not two').toBe(1);
  });

  it('refuses a WALLET settlement instead, and debits nothing', async () => {
    /*
     * The asymmetry, asserted as a pair with the manual cases above, and asserted on
     * the LEDGER rather than on the refusal alone. A wallet debit is written in the
     * settling transaction and dies with it, so the whole point is that there is
     * nothing to give back: a refund here would be a credit for money that never
     * left, and the balance would grow by the price of a failed purchase.
     */
    const order = await awaitingPayment(panelA);
    await ctx.container.wallet.adjust(tenantA, owner, customerA, {
      idempotencyKey: key(),
      direction: 'CREDIT',
      amountMinor: 1_000_000n,
      currency: 'IRT',
      note: 'برای آزمون',
    });
    await setStatus(panelA, 'DISABLED');

    await expect(
      ctx.container.payments.settleFromWallet(tenantA, systemActor(key()), customerA, {
        idempotencyKey: key(),
        orderId: order.id,
      }),
    ).rejects.toMatchObject({ code: 'commerce.panel_not_eligible' });

    const row = await orderRow(order.id);
    expect(row?.state, 'the order is untouched').toBe('AWAITING_PAYMENT');
    expect(row?.settled_at).toBeNull();
    const entries = await walletEntriesFor(customerA);
    expect(
      entries.map((entry) => entry.reason),
      'the top-up, and nothing else',
    ).toEqual(['ADMIN_CREDIT']);
    expect(await countOf('refunds')).toBe(0);
    expect(await customerNotices(order.id)).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // A renewal nobody could apply
  // -------------------------------------------------------------------------

  it('refunds a RENEW the panel can no longer perform, and creates no account', async () => {
    /*
     * A commercial order buys an operation on a service that already exists, so the
     * failure modes are different — and the outcome is the same. `planCommercialAction`
     * refuses when the panel stopped being operable between the customer's
     * confirmation and the operator's review, and that refusal used to roll the
     * settlement back and leave an arrived transfer PENDING.
     *
     * The two negatives are what make this case worth its length: no SECOND service
     * (a renewal routed through the create path would be a duplicate account the
     * customer pays for once and occupies twice), and no capacity slot (Codex N1 —
     * only a purchase that creates a service takes one).
     */
    const serviceId = await ownService(panelRenew);
    const { orderId, paymentId } = await renewalByTransfer(serviceId);
    await setStatus(panelRenew, 'DISABLED');

    const { payment, order: settled } = await confirmTransfer(paymentId);

    expect(payment.state).toBe('CONFIRMED');
    expect(settled?.state).toBe('REFUNDED');
    // The one service is the customer's OWN, untouched: a renewal that was refunded
    // must not have created a second account and must not have ended the first.
    await assertRefunded(orderId, { services: 1 });
    const state = (await ctx.container.database.db.execute(
      sql`SELECT state FROM services WHERE id = ${serviceId}` as never,
    )) as unknown as { rows: { state: string }[] };
    expect(state.rows[0]?.state, 'the service they already had is untouched').toBe('ACTIVE');
    const operations = (await ctx.container.database.db.execute(
      sql`SELECT count(*)::int AS n FROM provisioning_operations` as never,
    )) as unknown as { rows: { n: number }[] };
    expect(operations.rows[0]?.n, 'and no operation was queued for it').toBe(0);
  });

  it('applies a RENEW the panel still can, and refunds nothing', async () => {
    const serviceId = await ownService(panelRenew);
    const { orderId, paymentId } = await renewalByTransfer(serviceId);

    const { order: settled } = await confirmTransfer(paymentId);

    expect(settled?.state).toBe('PAID');
    expect(await countOf('refunds')).toBe(0);
    expect(await customerNotices(orderId)).toEqual([]);
    const operations = (await ctx.container.database.db.execute(
      sql`SELECT type FROM provisioning_operations` as never,
    )) as unknown as { rows: { type: string }[] };
    expect(operations.rows.map((row) => row.type)).toEqual(['RENEW']);
  });

  // -------------------------------------------------------------------------
  // What an operator and a reconciler see
  // -------------------------------------------------------------------------

  it('records the refund as a fact, not as an open condition', async () => {
    /*
     * The classification, asserted because getting it wrong rebuilds the queue this
     * whole change removed. `order.refunded_undeliverable` is a ONE-SHOT: nobody acts
     * on it, and filed as a condition it would be an unresolvable open ERROR per
     * refunded order.
     *
     * The panel problem is a different row with a different code, and the negative
     * assertion is the one that would catch a regression: no condition is opened
     * under the retired `order.fulfilment_failed` name either.
     */
    const order = await awaitingPayment(panelA);
    const paymentId = await pendingTransfer(order);
    await setStatus(panelA, 'DISABLED');

    await confirmTransfer(paymentId);

    const rows = (await ctx.container.database.db.execute(
      sql`SELECT severity, resolved_at, context FROM operational_events
           WHERE code = 'order.refunded_undeliverable'` as never,
    )) as unknown as {
      rows: { severity: string; resolved_at: string | null; context: Record<string, unknown> }[];
    };
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.severity, 'a fact, not a call to action').toBe('INFO');
    expect(rows.rows[0]?.context).toMatchObject({ reason: 'DISABLED', orderId: order.id });
    expect(await openConditions('order.fulfilment_failed'), 'the retired code is gone').toBe(0);
  });

  it('counts a refunded order as money that arrived, and as money that went back', async () => {
    /*
     * Reconciliation. `ORDER_SETTLED_STATES` is what `orders_settled_at_check` is
     * built from and `REFUNDED` is in it: a refund is a SECOND movement, not an
     * erasure of the first, and a report that dropped the receipt would under-state
     * what this installation took.
     */
    const order = await awaitingPayment(panelA);
    const paymentId = await pendingTransfer(order);
    await setStatus(panelA, 'DISABLED');
    await confirmTransfer(paymentId);

    const settledRows = (await ctx.container.database.db.execute(
      sql`SELECT count(*)::int AS n FROM orders
           WHERE settled_at IS NOT NULL AND id = ${order.id}` as never,
    )) as unknown as { rows: { n: number }[] };
    expect(settledRows.rows[0]?.n).toBe(1);

    const page = await ctx.container.payments.list(tenantA, finance, { limit: 20, search: {} });
    expect(page.items.filter((item) => item.state === 'CONFIRMED')).toHaveLength(1);
  });

  it('moves the balance by exactly what was paid, and by nothing else', async () => {
    const order = await awaitingPayment(panelA);
    const paymentId = await pendingTransfer(order);
    await setStatus(panelA, 'DISABLED');
    const before = await ctx.container.wallet.balance(tenantA, owner, customerA);

    await confirmTransfer(paymentId);

    const after = await ctx.container.wallet.balance(tenantA, owner, customerA);
    const total = BigInt(await totalOf(order.id));
    expect(after.amountMinor - before.amountMinor).toBe(total);
  });

  // -------------------------------------------------------------------------
  // Tenancy
  // -------------------------------------------------------------------------

  it('credits this tenant s customer and nobody in the other', async () => {
    /*
     * Asserted as the exact set on BOTH sides, not as "the other tenant has no
     * entry". An empty result satisfies the weaker reading and is also what a lane
     * broken in any other way produces, so it would pass for the wrong reason on the
     * day it mattered.
     */
    const order = await awaitingPayment(panelA);
    const paymentId = await pendingTransfer(order);
    await setStatus(panelA, 'DISABLED');

    await confirmTransfer(paymentId);

    const ours = (await ctx.container.database.db.execute(
      sql`SELECT tenant_id::text AS tenant_id FROM wallet_entries WHERE reason = 'REFUND'` as never,
    )) as unknown as { rows: { tenant_id: string }[] };
    expect(ours.rows.map((row) => row.tenant_id)).toEqual([tenantA.tenantId]);

    const foreign = (await ctx.container.database.db.execute(
      sql`SELECT count(*)::int AS n FROM refunds WHERE tenant_id = ${tenantB.tenantId}` as never,
    )) as unknown as { rows: { n: number }[] };
    expect(foreign.rows[0]?.n).toBe(0);
  });

  it('keeps one tenant s refunded order out of another tenant s reach', async () => {
    const order = await awaitingPayment(panelA);
    const paymentId = await pendingTransfer(order);
    await setStatus(panelA, 'DISABLED');
    await confirmTransfer(paymentId);
    const outsider = adminActorFor(
      await createAdmin(ctx.container, tenantB, {
        username: 'owner-other-tenant',
        roleKeys: ['owner'],
      }),
    );

    await expect(ctx.container.orders.get(tenantB, outsider, order.id)).rejects.toMatchObject({
      code: 'commerce.order_not_found',
    });
    expect((await orderRow(order.id))?.state).toBe('REFUNDED');
  });

  // -------------------------------------------------------------------------
  // The currency the credit would be denominated in
  // -------------------------------------------------------------------------

  /**
   * `sales.currency`, moved through the real write path so the veto is exercised.
   *
   * Direct SQL into `setting_values` would bypass `SettingsService.set` entirely,
   * which is where the guard runs — and a case that wrote the row itself would pass
   * whether the guard existed or not.
   */
  const changeSalesCurrency = (to: string, expectedVersion: number | null = null) =>
    ctx.container.settingsService.set(tenantA, owner, {
      key: 'sales.currency',
      value: to,
      expectedVersion,
      idempotencyKey: key(),
    });

  it('refuses to retire a currency that still has money owed in it', async () => {
    /*
     * An automatic refund credits the wallet in the PAYMENT's currency — it has to,
     * because that is the amount that arrived, and converting it would be the implicit
     * FX conversion at a rate nobody chose that `FBR-010` refuses.
     *
     * Every wallet READ, though, resolves `sales.currency` as it is TODAY. So after a
     * currency change, an undeliverable older order credited a balance the customer was
     * TOLD about by `ORDER_REFUNDED_TO_WALLET` and could then neither see nor spend:
     * money returned in name only, with the notification lane vouching for it. Found
     * by Codex.
     *
     * The operator is stopped at the moment the problem is still cheap, and the
     * refusal names how many payments stand in the way. `confirmAndCredit` already
     * refuses the same condition for a top-up, which is the precedent.
     */
    const order = await awaitingPayment(panelA);
    const paymentId = await pendingTransfer(order);
    await confirmTransfer(paymentId);

    await expect(changeSalesCurrency('IRR')).rejects.toMatchObject({
      code: 'control.invalid_value',
      message: expect.stringContaining('1 confirmed payment(s) in IRT'),
    });

    const stored = (await ctx.container.database.db.execute(
      sql`SELECT count(*)::int AS n FROM setting_values
           WHERE setting_key = 'sales.currency' AND tenant_id = ${tenantA.tenantId}` as never,
    )) as unknown as { rows: { n: number }[] };
    expect(stored.rows[0]?.n, 'and nothing was written').toBe(0);
  });

  it('allows the change once nothing is left to refund', async () => {
    /*
     * The other half, and the one that makes the refusal a GUARD rather than a ban.
     * The exposure is bounded and temporary: it clears as those payments are settled
     * or refunded. A case that asserted only the refusal would pass for a rule that
     * refused for ever.
     *
     * Here the whole payment goes back automatically, so nothing remains refundable
     * and the currency moves.
     */
    const order = await awaitingPayment(panelA);
    const paymentId = await pendingTransfer(order);
    await setStatus(panelA, 'DISABLED');
    await confirmTransfer(paymentId);
    await assertRefunded(order.id, { services: 0 });

    const result = await changeSalesCurrency('IRR');
    expect(result.setting.value, 'the whole payment went back, so nothing is owed in IRT').toBe(
      'IRR',
    );
    expect(result.changed).toBe(true);
  });

  it('leaves an installation that has never taken money free to choose', async () => {
    // No payments at all, so no exposure — and a guard that refused here would make
    // a fresh installation unable to set its own currency.
    const result = await changeSalesCurrency('IRR');
    expect(result.setting.value).toBe('IRR');
  });

  // -------------------------------------------------------------------------
  // The permission that cannot be held alone, against real sessions
  // -------------------------------------------------------------------------

  /**
   * An administrator composed OUTSIDE the seeded roles.
   *
   * The unit suite proves `resolveEffectivePermissions` narrows the set; this proves
   * the narrowing reaches the REQUEST. Every seeded role that holds
   * `receipts.review` holds `payments.view` beside it, which is exactly why the shape
   * could not be reproduced with one — and a custom role is not exotic here: `roles`
   * is tenant data with an `is_system` flag, and an installation is one INSERT from
   * having one.
   */
  const customRole = async (roleKey: string, permissions: readonly string[]): Promise<string> => {
    const roleId = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO roles (id, tenant_id, key, name, is_system)
      VALUES (${roleId}, ${tenantA.tenantId}, ${roleKey}, ${roleKey}, false)`);
    for (const permission of permissions) {
      await ctx.container.database.db.execute(sql`
        INSERT INTO role_permissions (tenant_id, role_id, permission_key)
        VALUES (${tenantA.tenantId}, ${roleId}, ${permission})`);
    }
    return roleId;
  };

  /**
   * An administrator holding ONLY a custom role, and what their session carries.
   *
   * Through `login` rather than the resolver directly. The unit suite proves the
   * resolution; what this proves is that the narrowing reaches the list a Web Admin
   * session is issued with — a rule that narrowed the guard while leaving the
   * session's list intact would still render a control that then answered 403, which
   * is the divergence rather than the fix.
   */
  const withCustomRole = async (
    username: string,
    roleKey: string,
    permissions: readonly string[],
  ): Promise<{ readonly admin: SeededAdmin }> => {
    const roleId = await customRole(roleKey, permissions);
    const admin = await createAdmin(ctx.container, tenantA, { username });
    await ctx.container.database.db.execute(sql`
      INSERT INTO admin_roles (tenant_id, admin_id, role_id)
      VALUES (${tenantA.tenantId}, ${admin.id}, ${roleId})`);
    return { admin };
  };

  const heldBy = async (roleKey: string, permissions: readonly string[]): Promise<string[]> => {
    const username = `custom-${roleKey}`;
    const { admin } = await withCustomRole(username, roleKey, permissions);
    const result = await ctx.container.auth.login(
      tenantA,
      {
        type: 'API' as const,
        id: null,
        label: null,
        surface: 'WEB' as const,
        correlationId: 'test-correlation' as never,
      },
      { username: admin.username, password: admin.password },
      { ip: '203.0.113.10', userAgent: 'vitest' },
    );
    return [...result.permissions].sort();
  };

  it('does not let a custom role hold receipts.review without payments.view', async () => {
    expect(await heldBy('review_only', ['users.view', 'receipts.review'])).toEqual(['users.view']);
  });

  it('keeps both for a custom role granted both', async () => {
    expect(await heldBy('review_and_view', ['payments.view', 'receipts.review'])).toEqual([
      'payments.view',
      'receipts.review',
    ]);
  });

  it('refuses the confirmation to an administrator a custom role could not authorise', async () => {
    /*
     * The narrowing reaching the guard, not just the session list. An administrator
     * who holds `receipts.review` and cannot open a payment is refused the write, so
     * the catalogue promises nothing the role cannot do.
     */
    const { admin } = await withCustomRole('custom-review-no-read', 'review_no_read', [
      'users.view',
      'receipts.review',
    ]);
    const order = await awaitingPayment(panelA);
    const paymentId = await pendingTransfer(order);

    await expect(
      ctx.container.payments.confirmManualTransfer(tenantA, adminActorFor(admin), paymentId, {
        idempotencyKey: key(),
        note: 'کارت به کارت',
      }),
    ).rejects.toMatchObject({ code: 'platform.permission_denied' });
    expect((await orderRow(order.id))?.state).toBe('AWAITING_PAYMENT');
  });
});
