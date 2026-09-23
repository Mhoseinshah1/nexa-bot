import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
  type UserId,
} from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { DrizzleServiceRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service.repository';
import { startFakeRickpanel, type FakeRickpanel } from '../support/fake-rickpanel';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  validatePanelConnection,
  SEED_IDS,
  tenantA,
  tenantB,
  type TestContext,
} from './harness';

/**
 * The free trial, end to end (WP6-A, plan §7.1, `docs/wp6-audit.md` §2).
 *
 * Through the shipped container — `TrialService`, the real provisioning path, the real
 * provisioner, the real `RickpanelAdapter` over `SafeHttpClient`, the real delivery lane
 * and a Telegram stand-in on a socket — against `tests/support/fake-rickpanel.ts`.
 *
 * What each case holds, in the plan's words: tenant-scoped; disabled by default;
 * explicit configuration required; the paid-product values snapshotted; idempotent;
 * the customer's identity, not a name; a failed create does not consume eligibility;
 * no wallet debit, payment, cashback, referral or reseller margin; the panel decided
 * again before anything is written.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

describe('a free trial', () => {
  let ctx: TestContext;
  let telegram: Server;
  let sent: { url: string; body: Record<string, unknown> }[];
  let panel: FakeRickpanel;
  let products: DrizzleProductRepository;
  let services: DrizzleServiceRepository;
  let panelId: string;
  let customerId: UserId;
  let owner: ActorContext;
  let trialProductId: ProductId;

  beforeAll(async () => {
    telegram = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        sent.push({
          url: request.url ?? '',
          body: raw.length === 0 ? {} : (JSON.parse(raw) as Record<string, unknown>),
        });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, result: { message_id: 7 } }));
      });
    });
    await new Promise<void>((resolve) => telegram.listen(0, '127.0.0.1', resolve));
    const address = telegram.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    ctx = await createTestContext({
      PANEL_HTTP_ALLOW_LOOPBACK: 'true',
      TELEGRAM_API_BASE_URL: `http://127.0.0.1:${String(address.port)}`,
    });
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
    telegram.closeAllConnections();
    await new Promise<void>((resolve) => telegram.close(() => resolve()));
  });

  afterEach(async () => {
    await panel?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    ctx.container.setInstallationTenant(tenantA.tenantId);
    products = new DrizzleProductRepository(ctx.container.database.db);
    services = new DrizzleServiceRepository(ctx.container.database.db);
    sent = [];

    panel = await startFakeRickpanel({ host: '127.0.0.2' });
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-trial', roleKeys: ['owner'] }),
    );
    const created = await ctx.container.panels.create(tenantA, owner, {
      name: 'Rick',
      providerType: 'rickpanel',
      baseUrl: panel.baseUrl,
      credentials: { username: panel.username, password: panel.password },
      activation: {},
      idempotencyKey: 'panel-trial-create',
    });
    panelId = created.view.panel.id;
    await validatePanelConnection(ctx.container, tenantA, panelId);

    customerId = await customer('950950');

    // A trial product has NO price: that is what keeps it out of the catalogue.
    const product = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'تست یک‌روزه',
        description: null,
        audience: 'HIDDEN',
        sortOrder: 90,
        panelId: panelId as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
        specification: { durationDays: 1, trafficBytes: 1_073_741_824n, deviceLimit: null },
        price: null,
      },
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, product.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    trialProductId = product.id;
  });

  async function customer(telegramId: string): Promise<UserId> {
    const resolved = await ctx.container.customers.resolveFromUpdate(
      tenantA,
      systemActor(`r-${telegramId}`),
      {
        idempotencyKey: `resolve-${telegramId}`,
        telegramUserId: telegramId,
        from: { id: Number(telegramId), first_name: 'سارا' },
        botInstanceId: BOT_A,
      },
    );
    return resolved.customer.id;
  }

  const setSetting = (key: string, value: unknown) =>
    ctx.container.settingsService.set(tenantA, owner, {
      key,
      value,
      expectedVersion: null,
      idempotencyKey: randomUUID(),
    });

  async function configureTrial(input: {
    readonly enabled?: boolean;
    readonly product?: boolean;
    readonly limit?: number;
  }): Promise<void> {
    if (input.enabled ?? true) {
      await ctx.container.featureFlags.set(tenantA, owner, {
        key: 'trials',
        enabled: true,
        expectedVersion: null,
        // TENANT_WIDE: the flag names itself and says why (ADR-0010).
        confirmKey: 'trials',
        reason: 'offer a trial',
        idempotencyKey: randomUUID(),
      });
    }
    if (input.product ?? true) await setSetting('trial.product_id', trialProductId);
    if (input.limit !== undefined) {
      const current = await ctx.container.settingsService.get(
        tenantA,
        owner,
        'trial.limit_per_customer',
      );
      await ctx.container.settingsService.set(tenantA, owner, {
        key: 'trial.limit_per_customer',
        value: input.limit,
        expectedVersion: current.version,
        idempotencyKey: randomUUID(),
      });
    }
  }

  const claim = (who: UserId, key: string) =>
    ctx.container.trials.claim(tenantA, systemActor(key), who, { idempotencyKey: key });

  const count = async (query: ReturnType<typeof sql>): Promise<number> => {
    const rows = (await ctx.container.database.db.execute(query as never)) as unknown as {
      rows: { n: number }[];
    };
    return rows.rows[0]?.n ?? 0;
  };
  const moneyRows = async () => ({
    wallet: await count(sql`SELECT count(*)::int AS n FROM wallet_entries`),
    payments: await count(sql`SELECT count(*)::int AS n FROM payments`),
    refunds: await count(sql`SELECT count(*)::int AS n FROM refunds`),
  });
  const orderRow = async (id: string) =>
    (
      (await ctx.container.database.db.execute(
        sql`SELECT state, purpose, total_amount::text AS total, line_duration_days AS days,
                   line_traffic_bytes::text AS traffic, confirmed_at, settled_at, refunded_at
              FROM orders WHERE id = ${id}` as never,
      )) as unknown as {
        rows: {
          state: string;
          purpose: string;
          total: string;
          days: number;
          traffic: string;
          confirmed_at: Date | null;
          settled_at: Date | null;
          refunded_at: Date | null;
        }[];
      }
    ).rows[0];
  const grantRow = async (orderId: string) =>
    (
      (await ctx.container.database.db.execute(
        sql`SELECT customer_id, service_id, released_at FROM trial_grants WHERE order_id = ${orderId}` as never,
      )) as unknown as {
        rows: { customer_id: string; service_id: string | null; released_at: Date | null }[];
      }
    ).rows[0];

  /** Waits until `expected` transactions are blocked on a row lock — the barrier. */
  async function awaitBlocked(expected: number, what: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const n = await count(
        sql`SELECT count(*)::int AS n FROM pg_locks
             WHERE NOT granted AND locktype IN ('tuple', 'transactionid')`,
      );
      if (n >= expected) return;
      if (Date.now() > deadline) {
        throw new Error(`${what} never blocked on the customer row.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  it('is off by default, and says so without writing anything', async () => {
    expect(
      await ctx.container.trials.availabilityFor(tenantA, systemActor('a'), customerId),
    ).toEqual({ available: false, reason: 'UNCONFIGURED' });
    expect(await claim(customerId, 'off')).toEqual({ outcome: 'REFUSED', reason: 'UNCONFIGURED' });
    // A product configured while the flag is off is still no trial: the flag is the
    // switch, and a configuration is inert until it is on.
    await configureTrial({ enabled: false });
    expect(await claim(customerId, 'product-only')).toEqual({
      outcome: 'REFUSED',
      reason: 'UNCONFIGURED',
    });
    // The flag on with no product is still unconfigured: the flag alone is not enough.
    const configured = await ctx.container.settingsService.get(tenantA, owner, 'trial.product_id');
    await ctx.container.settingsService.set(tenantA, owner, {
      key: 'trial.product_id',
      value: null,
      expectedVersion: configured.version,
      idempotencyKey: randomUUID(),
    });
    await configureTrial({ product: false });
    expect(await claim(customerId, 'no-product')).toEqual({
      outcome: 'REFUSED',
      reason: 'UNCONFIGURED',
    });
    expect(await count(sql`SELECT count(*)::int AS n FROM orders`)).toBe(0);
    expect(await count(sql`SELECT count(*)::int AS n FROM trial_grants`)).toBe(0);
  });

  it('issues a trial through the purchase path, delivers its link, and moves no money', async () => {
    await configureTrial({});
    expect(
      await ctx.container.trials.availabilityFor(tenantA, systemActor('a'), customerId),
    ).toEqual({ available: true });

    const issued = await claim(customerId, 'first');
    if (issued.outcome !== 'ISSUED') throw new Error(`refused: ${issued.reason}`);
    expect(issued.replayed).toBe(false);

    // The order: a zero-total TRIAL that reached PAID through GRANT, confirmed and
    // settled in the same instant, carrying the trial product's specification.
    const order = await orderRow(issued.orderId);
    expect(order).toMatchObject({ state: 'PAID', purpose: 'TRIAL', total: '0', days: 1 });
    expect(order?.traffic).toBe('1073741824');
    expect(order?.confirmed_at).not.toBeNull();
    expect(order?.settled_at).not.toBeNull();

    // The grant counts, and names the service.
    const grant = await grantRow(issued.orderId);
    expect(grant?.customer_id).toBe(customerId);
    expect(grant?.service_id).toBe(issued.serviceId);
    expect(grant?.released_at).toBeNull();

    // The provisioner creates it on the panel, and the ordinary lane sends the link.
    await ctx.container.provisionerLoop.tick();
    const service = await services.findById(tenantA, issued.serviceId as never);
    expect(service?.state).toBe('ACTIVE');
    expect(service?.trafficLimitBytes).toBe(1_073_741_824n);
    expect(panel.users.get(service?.providerUsername ?? '')).toBeDefined();
    expect(service?.deliveryState).toBe('DELIVERED');
    expect(sent.some((one) => one.url.endsWith('/sendMessage'))).toBe(true);

    // No wallet entry, no payment, no refund: a trial is free and touches no ledger.
    expect(await moneyRows()).toEqual({ wallet: 0, payments: 0, refunds: 0 });
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM outbox_messages WHERE event_type = 'TrialIssued'`,
      ),
    ).toBe(1);
  });

  it('keeps what was granted when the trial product is edited afterwards', async () => {
    await configureTrial({});
    const issued = await claim(customerId, 'snap');
    if (issued.outcome !== 'ISSUED') throw new Error(`refused: ${issued.reason}`);

    await products.update(
      tenantA,
      trialProductId,
      {
        title: 'تست بزرگ',
        description: null,
        audience: 'HIDDEN',
        sortOrder: 90,
        panelId: panelId as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 107_374_182_400n, deviceLimit: null },
        price: null,
      },
      ctx.container.clock.now(),
    );

    await ctx.container.provisionerLoop.tick();
    const order = await orderRow(issued.orderId);
    expect(order?.days).toBe(1);
    expect(order?.traffic).toBe('1073741824');
    const service = await services.findById(tenantA, issued.serviceId as never);
    expect(service?.trafficLimitBytes).toBe(1_073_741_824n);
  });

  it('answers a replayed claim with the same trial, and writes it once', async () => {
    await configureTrial({});
    const first = await claim(customerId, 'same-key');
    const second = await claim(customerId, 'same-key');
    if (first.outcome !== 'ISSUED' || second.outcome !== 'ISSUED') throw new Error('refused');
    expect(second.orderId).toBe(first.orderId);
    expect(second.serviceId).toBe(first.serviceId);
    expect(second.replayed).toBe(true);
    expect(await count(sql`SELECT count(*)::int AS n FROM trial_grants`)).toBe(1);
  });

  it('counts against the limit, and zero means none', async () => {
    await configureTrial({ limit: 2 });
    expect((await claim(customerId, 'l-1')).outcome).toBe('ISSUED');
    expect((await claim(customerId, 'l-2')).outcome).toBe('ISSUED');
    expect(await claim(customerId, 'l-3')).toEqual({ outcome: 'REFUSED', reason: 'LIMIT_REACHED' });

    // A second customer has their own allowance: the limit is per customer.
    const other = await customer('950951');
    expect((await claim(other, 'o-1')).outcome).toBe('ISSUED');

    await configureTrial({ enabled: false, product: false, limit: 0 });
    const third = await customer('950952');
    expect(await claim(third, 'z-1')).toEqual({ outcome: 'REFUSED', reason: 'LIMIT_REACHED' });
  });

  it('serialises two claims on the customer lock, so the second counts the first', async () => {
    /*
     * The barrier is the customer row itself. An outside transaction holds it; both
     * claims are started and PROVEN to be waiting on it before it is released — so the
     * two genuinely race for the same decision, rather than one finishing before the
     * other begins, which is all `Promise.all` alone would show.
     */
    await configureTrial({});
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => (locked = resolve));
    const holder = ctx.container.database.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM customers WHERE id = ${customerId} FOR UPDATE`);
      locked();
      await gate;
    });
    await holding;

    const a = claim(customerId, 'race-a');
    const b = claim(customerId, 'race-b');
    await awaitBlocked(2, 'both trial claims');
    release();
    await holder;

    const outcomes = await Promise.all([a, b]);
    expect(outcomes.map((one) => one.outcome).sort()).toEqual(['ISSUED', 'REFUSED']);
    expect(outcomes.find((one) => one.outcome === 'REFUSED')).toEqual({
      outcome: 'REFUSED',
      reason: 'LIMIT_REACHED',
    });
    expect(await count(sql`SELECT count(*)::int AS n FROM trial_grants`)).toBe(1);
  });

  it('gives the trial back when its service definitively cannot be created', async () => {
    await configureTrial({});
    panel.behaviour = 'refuses-rule';
    const issued = await claim(customerId, 'fails');
    if (issued.outcome !== 'ISSUED') throw new Error(`refused: ${issued.reason}`);

    await ctx.container.provisionerLoop.tick();

    // The service ended, the order closed as REFUNDED — for nothing — and the grant was
    // released, so it no longer counts.
    const service = await services.findById(tenantA, issued.serviceId as never);
    expect(service?.state).toBe('TERMINATED');
    const order = await orderRow(issued.orderId);
    expect(order?.state).toBe('REFUNDED');
    expect(order?.refunded_at).not.toBeNull();
    expect((await grantRow(issued.orderId))?.released_at).not.toBeNull();
    expect(await moneyRows()).toEqual({ wallet: 0, payments: 0, refunds: 0 });

    // The customer is told the truth, by the trial's own sentence — not "refunded to
    // your wallet", which would be false.
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM customer_notifications
             WHERE kind = 'TRIAL_NOT_DELIVERED' AND subject_id = ${issued.orderId}`,
      ),
    ).toBe(1);
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM customer_notifications WHERE kind = 'ORDER_REFUNDED_TO_WALLET'`,
      ),
    ).toBe(0);

    // And the allowance is back: with a limit of one, the customer may take another.
    panel.behaviour = 'healthy';
    expect((await claim(customerId, 'again')).outcome).toBe('ISSUED');
  });

  it('keeps the trial counted while its create is still being retried', async () => {
    /*
     * Only a DEFINITIVE failure gives a trial back. A panel that cannot be reached is
     * retried, and while it is the customer's grant still counts — otherwise a second
     * claim during the outage would hand them two trials the moment it recovers.
     * (`server-error` is not this case: the adapter reads back after a 500, proves the
     * account absent, and that IS definitive — the case above.)
     */
    await configureTrial({});
    const issued = await claim(customerId, 'retrying');
    if (issued.outcome !== 'ISSUED') throw new Error(`refused: ${issued.reason}`);
    await panel.close();

    await ctx.container.provisionerLoop.tick();

    const service = await services.findById(tenantA, issued.serviceId as never);
    expect(service?.state).toBe('PENDING_PROVISION');
    expect((await orderRow(issued.orderId))?.state).toBe('PAID');
    expect((await grantRow(issued.orderId))?.released_at).toBeNull();
    expect(await claim(customerId, 'retrying-again')).toEqual({
      outcome: 'REFUSED',
      reason: 'LIMIT_REACHED',
    });
  });

  it('refuses a trial product id that is not a product of this tenant', async () => {
    await expect(setSetting('trial.product_id', ctx.container.ids.uuid())).rejects.toThrow();
    await setSetting('trial.product_id', trialProductId);
  });

  it('refuses a blocked customer, and a panel that cannot take a new account, without writing', async () => {
    await configureTrial({});
    await ctx.container.panels.setStatus(tenantA, owner, panelId, {
      status: 'DISABLED',
      idempotencyKey: 'trial-panel-off',
    });
    expect(await claim(customerId, 'panel-off')).toEqual({
      outcome: 'REFUSED',
      reason: 'PRODUCT_UNAVAILABLE',
    });
    // The order, the name and the slot all rolled back with the refusal.
    expect(await count(sql`SELECT count(*)::int AS n FROM orders`)).toBe(0);
    expect(await count(sql`SELECT count(*)::int AS n FROM service_username_reservations`)).toBe(0);
    expect(await count(sql`SELECT count(*)::int AS n FROM trial_grants`)).toBe(0);

    await ctx.container.database.db.execute(
      sql`UPDATE customers SET status = 'BLOCKED', blocked_at = now() WHERE id = ${customerId}` as never,
    );
    expect(await claim(customerId, 'blocked')).toEqual({
      outcome: 'REFUSED',
      reason: 'CUSTOMER_BLOCKED',
    });
  });

  it('does not offer a trial its panel could not deliver', async () => {
    /*
     * Codex, PR #64: the offer checked only that the product had a panel, so a panel
     * that was disabled, full, unhealthy or would not choose a name for the customer
     * still drew the button — for a tap that could only be refused. The offer now asks
     * the catalogue's own eligibility evaluator and the username lane, read-only.
     */
    await configureTrial({});
    const offered = () =>
      ctx.container.trials.availabilityFor(tenantA, systemActor('offer'), customerId);
    expect(await offered()).toEqual({ available: true });

    await ctx.container.database.db.execute(
      sql`UPDATE panels SET allow_custom_username = true, allow_automatic_username = false
           WHERE id = ${panelId}` as never,
    );
    expect(await offered()).toEqual({ available: false, reason: 'PRODUCT_UNAVAILABLE' });
    await ctx.container.database.db.execute(
      sql`UPDATE panels SET allow_automatic_username = true WHERE id = ${panelId}` as never,
    );
    expect(await offered()).toEqual({ available: true });

    await ctx.container.panels.setStatus(tenantA, owner, panelId, {
      status: 'DISABLED',
      idempotencyKey: 'trial-offer-panel-off',
    });
    expect(await offered()).toEqual({ available: false, reason: 'PRODUCT_UNAVAILABLE' });
    // A courtesy writes nothing.
    expect(await count(sql`SELECT count(*)::int AS n FROM orders`)).toBe(0);
  });

  it('answers a redelivered update with the refusal it already gave', async () => {
    // Codex, PR #64: a refusal is an answer, and a replay of the same update gets the
    // same one even after the configuration that produced it changes.
    await configureTrial({ limit: 0 });
    expect(await claim(customerId, 'once')).toEqual({
      outcome: 'REFUSED',
      reason: 'LIMIT_REACHED',
    });
    await configureTrial({ enabled: false, product: false, limit: 1 });
    expect(await claim(customerId, 'once')).toEqual({
      outcome: 'REFUSED',
      reason: 'LIMIT_REACHED',
      replayed: true,
    });
    expect(await count(sql`SELECT count(*)::int AS n FROM trial_grants`)).toBe(0);
    // A new tap is a new question.
    expect((await claim(customerId, 'twice')).outcome).toBe('ISSUED');
  });

  it('answers two concurrent deliveries of one update with one trial', async () => {
    /*
     * Codex, PR #64: both deliveries miss the idempotency lookup, the first issues, and
     * the second — which found the limit spent under the lock — said "unavailable" to
     * the tap the first had just served. The barrier is the customer row: both claims
     * are PROVEN to be waiting on it before it is released.
     */
    await configureTrial({});
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => (locked = resolve));
    const holder = ctx.container.database.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM customers WHERE id = ${customerId} FOR UPDATE`);
      locked();
      await gate;
    });
    await holding;

    const first = claim(customerId, 'same-update');
    const second = claim(customerId, 'same-update');
    await awaitBlocked(2, 'both deliveries');
    release();
    await holder;

    const outcomes = await Promise.all([first, second]);
    expect(outcomes.map((one) => one.outcome)).toEqual(['ISSUED', 'ISSUED']);
    const [a, b] = outcomes;
    if (a?.outcome !== 'ISSUED' || b?.outcome !== 'ISSUED') throw new Error('unreachable');
    expect(a.orderId).toBe(b.orderId);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(await count(sql`SELECT count(*)::int AS n FROM trial_grants`)).toBe(1);
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'trial.claim' AND result = 'FAILED'`,
      ),
    ).toBe(0);
  });

  it('recovers a trial the previous release stranded, through the operator retry', async () => {
    /*
     * Codex, PR #64 (P1). A rollback to the release before WP6-A can claim a trial's
     * PROVISION and, on a definitive failure, cannot settle it: its PURCHASED_AS has no
     * TRIAL, so it fails the operation and leaves the order PAID, the service pending
     * and the grant counted. That release cannot be changed, and `FAILED` alone cannot
     * tell its leftovers apart from `retireExhausted`'s (an unknown outcome, which must
     * keep the grant) — so nothing sweeps it automatically. What this release owes is
     * that the shape is RECOVERABLE through the operator's retry, which is the remedy
     * `retireExhausted`'s stalled trials already rely on. Both outcomes of the retry:
     */
    await configureTrial({ limit: 2 });
    const strand = async (key: string) => {
      const issued = await claim(customerId, key);
      if (issued.outcome !== 'ISSUED') throw new Error(`refused: ${issued.reason}`);
      // The old release's leftovers, written as it leaves them.
      await ctx.container.database.db.execute(
        sql`UPDATE provisioning_operations
               SET state = 'FAILED', completed_at = now(), claimed_by = NULL, lease_until = NULL
             WHERE order_id = ${issued.orderId}` as never,
      );
      return issued;
    };

    // A retry that succeeds delivers the trial, and the grant keeps counting.
    const delivered = await strand('stranded-ok');
    await ctx.container.provisioning.retryProvisioning(tenantA, owner, delivered.serviceId, {
      idempotencyKey: 'retry-ok',
    });
    await ctx.container.provisionerLoop.tick();
    expect((await services.findById(tenantA, delivered.serviceId as never))?.state).toBe('ACTIVE');
    expect((await grantRow(delivered.orderId))?.released_at).toBeNull();

    // A retry that is definitively refused gives the trial back, as a fresh claim would.
    const refused = await strand('stranded-no');
    panel.behaviour = 'refuses-rule';
    await ctx.container.provisioning.retryProvisioning(tenantA, owner, refused.serviceId, {
      idempotencyKey: 'retry-no',
    });
    await ctx.container.provisionerLoop.tick();
    expect((await services.findById(tenantA, refused.serviceId as never))?.state).toBe(
      'TERMINATED',
    );
    expect((await orderRow(refused.orderId))?.state).toBe('REFUNDED');
    expect((await grantRow(refused.orderId))?.released_at).not.toBeNull();
    expect(await moneyRows()).toEqual({ wallet: 0, payments: 0, refunds: 0 });
  });

  // =========================================================================
  // The Telegram surface: an offer only when it can be taken, decided again on tap
  // =========================================================================

  let updateSeq = 0;
  const tap = (data: string, telegramUserId: string) => {
    updateSeq += 1;
    return {
      idempotencyKey: `trial-update-${String(updateSeq)}`,
      botInstanceId: BOT_A,
      update: {
        update_id: updateSeq,
        callback_query: {
          id: `cbq-${String(updateSeq)}`,
          from: { id: Number(telegramUserId), is_bot: false, first_name: 'سارا' },
          data,
          message: {
            message_id: updateSeq,
            date: 0,
            chat: { id: Number(telegramUserId), type: 'private' },
            from: { id: 999_999, is_bot: true, first_name: 'Nexa' },
          },
        },
      },
      telegramUserId,
      from: { id: Number(telegramUserId), first_name: 'سارا' },
    };
  };
  const lastMessage = () =>
    JSON.stringify(sent.filter((one) => one.url.includes('/sendMessage')).at(-1) ?? {});

  it('draws the trial button only when the customer can take one, and issues it on the tap', async () => {
    const runtime = ctx.container.botRuntime;

    // Off: the catalogue offers no trial, and a crafted tap is refused by the server.
    await runtime.handle(tenantA, systemActor('tg'), tap('cg:0', '950950'));
    expect(lastMessage()).not.toContain('"tr:"');
    const crafted = await runtime.handle(tenantA, systemActor('tg'), tap('tr:', '950950'));
    expect(crafted.replyKey).toBe('bot.trial.unavailable');
    expect(await count(sql`SELECT count(*)::int AS n FROM trial_grants`)).toBe(0);

    // On: offered, and the tap issues it.
    await configureTrial({});
    await runtime.handle(tenantA, systemActor('tg'), tap('cg:0', '950950'));
    expect(lastMessage()).toContain('"tr:"');
    const taken = await runtime.handle(tenantA, systemActor('tg'), tap('tr:', '950950'));
    expect(taken.replyKey).toBe('bot.trial.issued');
    expect(await count(sql`SELECT count(*)::int AS n FROM trial_grants`)).toBe(1);

    // Used up: no longer offered, and a second tap is refused.
    await runtime.handle(tenantA, systemActor('tg'), tap('cg:0', '950950'));
    expect(lastMessage()).not.toContain('"tr:"');
    const again = await runtime.handle(tenantA, systemActor('tg'), tap('tr:', '950950'));
    expect(again.replyKey).toBe('bot.trial.unavailable');
    expect(await count(sql`SELECT count(*)::int AS n FROM trial_grants`)).toBe(1);
  });

  it('is scoped to its tenant: another tenant sees no trial', async () => {
    await configureTrial({});
    expect(
      await ctx.container.trials.availabilityFor(tenantB, systemActor('b'), customerId),
    ).toEqual({ available: false, reason: 'UNCONFIGURED' });
  });
});
