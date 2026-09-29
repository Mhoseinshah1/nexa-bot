import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
  type UserId,
} from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';
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
 * The free trial, end to end (WP6-A, plan §7.1, `docs/wp6-audit.md` §2; R1).
 *
 * Since R1 a trial is configured PER PANEL — enabled, traffic, hours — and is issued from
 * NO product. Through the shipped container — `TrialService`, the real provisioning path,
 * the real provisioner, the real `RickpanelAdapter` over `SafeHttpClient`, the real
 * delivery lane and a Telegram stand-in on a socket — against
 * `tests/support/fake-rickpanel.ts`.
 *
 * What each case holds: tenant-scoped; disabled by default; explicit configuration
 * required; the configuration snapshotted on the order; no product anywhere; idempotent;
 * a failed create does not consume eligibility; one trial per customer under a double tap
 * and a replayed update; only valid, enabled panels offered; no wallet debit, payment,
 * cashback, referral or reseller margin; the panel decided again before anything is
 * written.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const MB = 1_048_576n;

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
  let others: FakeRickpanel[] = [];
  let services: DrizzleServiceRepository;
  let panelId: string;
  let customerId: UserId;
  let owner: ActorContext;

  beforeAll(async () => {
    telegram = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        // A photo goes out as multipart; a body that is not JSON is kept raw rather
        // than thrown on, which would leave the request unanswered and the send UNCONFIRMED.
        let body: Record<string, unknown>;
        try {
          body = raw.length === 0 ? {} : (JSON.parse(raw) as Record<string, unknown>);
        } catch {
          body = { unparseable: raw };
        }
        sent.push({ url: request.url ?? '', body });
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
    for (const other of others) await other.close();
    others = [];
  });

  beforeEach(async () => {
    await ctx.reset();
    ctx.container.setInstallationTenant(tenantA.tenantId);
    services = new DrizzleServiceRepository(ctx.container.database.db);
    sent = [];

    panel = await startFakeRickpanel({ host: '127.0.0.2' });
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-trial', roleKeys: ['owner'] }),
    );
    panelId = await newPanel('Rick', panel);
    customerId = await customer('950950');
  });

  async function newPanel(name: string, fake: FakeRickpanel): Promise<string> {
    const created = await ctx.container.panels.create(tenantA, owner, {
      name,
      providerType: 'rickpanel',
      baseUrl: fake.baseUrl,
      credentials: { username: fake.username, password: fake.password },
      activation: {},
      idempotencyKey: `panel-${name}`,
    });
    await validatePanelConnection(ctx.container, tenantA, created.view.panel.id);
    return created.view.panel.id;
  }

  /** Another fake panel on its own loopback address, closed after the test. */
  async function extraFake(host: string): Promise<FakeRickpanel> {
    const fake = await startFakeRickpanel({ host });
    others.push(fake);
    return fake;
  }

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

  async function setFlag(enabled: boolean): Promise<void> {
    const current = (await ctx.container.featureFlags.list(tenantA, owner)).find(
      (flag) => flag.key === 'trials',
    );
    if (current?.enabled === enabled) return;
    await ctx.container.featureFlags.set(tenantA, owner, {
      key: 'trials',
      enabled,
      expectedVersion: current?.version ?? null,
      confirmKey: 'trials',
      reason: 'offer a trial',
      idempotencyKey: randomUUID(),
    });
  }

  async function setLimit(limit: number): Promise<void> {
    const current = await ctx.container.settingsService.get(
      tenantA,
      owner,
      'trial.limit_per_customer',
    );
    await ctx.container.settingsService.set(tenantA, owner, {
      key: 'trial.limit_per_customer',
      value: limit,
      expectedVersion: current.version,
      idempotencyKey: randomUUID(),
    });
  }

  /** A panel's trial, through the operator's own write path. */
  async function configurePanel(
    id: string,
    input: {
      readonly enabled?: boolean;
      readonly amount?: string;
      readonly unit?: 'GB' | 'MB';
      readonly hours?: number;
      readonly label?: string | null;
    } = {},
  ): Promise<void> {
    const current = await ctx.container.panelTrials.get(tenantA, owner, id);
    await ctx.container.panelTrials.update(tenantA, owner, id, {
      idempotencyKey: randomUUID(),
      expectedRevision: current.revision,
      enabled: input.enabled ?? true,
      trafficAmount: input.amount ?? '100',
      trafficUnit: input.unit ?? 'MB',
      durationHours: input.hours ?? 72,
      label: input.label ?? null,
    });
  }

  /** The flag on and the main panel offering 100 MB for 72 hours — the owner's example. */
  async function configureTrial(input: { readonly limit?: number } = {}): Promise<void> {
    await setFlag(true);
    await configurePanel(panelId);
    if (input.limit !== undefined) await setLimit(input.limit);
  }

  const claim = (who: UserId, key: string, on: string = panelId) =>
    ctx.container.trials.claim(tenantA, systemActor(key), who, {
      idempotencyKey: key,
      panelId: on,
    });

  const offered = async (who: UserId = customerId) => {
    const availability = await ctx.container.trials.availabilityFor(
      tenantA,
      systemActor('offer'),
      who,
    );
    return availability.available
      ? availability.offers.map((offer) => offer.panelId)
      : availability.reason;
  };

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
        sql`SELECT state, purpose, product_id, panel_id, total_amount::text AS total,
                   line_duration_days AS days, line_duration_hours AS hours, line_title AS title,
                   line_traffic_bytes::text AS traffic, confirmed_at, settled_at, refunded_at
              FROM orders WHERE id = ${id}` as never,
      )) as unknown as {
        rows: {
          state: string;
          purpose: string;
          product_id: string | null;
          panel_id: string;
          total: string;
          days: number;
          hours: number | null;
          title: string;
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
        sql`SELECT customer_id, product_id, service_id, released_at FROM trial_grants
             WHERE order_id = ${orderId}` as never,
      )) as unknown as {
        rows: {
          customer_id: string;
          product_id: string | null;
          service_id: string | null;
          released_at: Date | null;
        }[];
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
    expect(await offered()).toBe('UNCONFIGURED');
    expect(await claim(customerId, 'off')).toEqual({ outcome: 'REFUSED', reason: 'UNCONFIGURED' });
    // A panel configured while the flag is off is still no trial: the flag is the switch.
    await configurePanel(panelId);
    expect(await claim(customerId, 'config-only')).toEqual({
      outcome: 'REFUSED',
      reason: 'UNCONFIGURED',
    });
    // The flag on with no panel offering one is still no trial.
    await configurePanel(panelId, { enabled: false });
    await setFlag(true);
    expect(await offered()).toBe('UNCONFIGURED');
    expect(await claim(customerId, 'no-panel')).toEqual({
      outcome: 'REFUSED',
      reason: 'PRODUCT_UNAVAILABLE',
    });
    expect(await count(sql`SELECT count(*)::int AS n FROM orders`)).toBe(0);
    expect(await count(sql`SELECT count(*)::int AS n FROM trial_grants`)).toBe(0);
  });

  it('does not require a product: the order, the grant and the service name none', async () => {
    /*
     * R1, the owner's first required regression. The tenant has NO product at all — not a
     * hidden one, not an unpriced one — and the trial is issued, provisioned and delivered
     * from the panel's own configuration.
     */
    await ctx.container.database.db.execute(sql`DELETE FROM products` as never);
    await configureTrial();
    expect(await offered()).toEqual([panelId]);

    const issued = await claim(customerId, 'first');
    if (issued.outcome !== 'ISSUED') throw new Error(`refused: ${JSON.stringify(issued)}`);
    expect(issued.replayed).toBe(false);

    // The order: a zero-total TRIAL that reached PAID through GRANT, naming no product,
    // carrying the panel's hours and traffic — and the days rounded up for day-only readers.
    const order = await orderRow(issued.orderId);
    expect(order).toMatchObject({
      state: 'PAID',
      purpose: 'TRIAL',
      product_id: null,
      panel_id: panelId,
      total: '0',
      days: 3,
      hours: 72,
      title: 'Rick',
    });
    expect(order?.traffic).toBe(String(100n * MB));
    expect(order?.confirmed_at).not.toBeNull();
    expect(order?.settled_at).not.toBeNull();

    const grant = await grantRow(issued.orderId);
    expect(grant).toMatchObject({
      customer_id: customerId,
      product_id: null,
      service_id: issued.serviceId,
      released_at: null,
    });

    // The provisioner creates it on the panel, and the ordinary lane sends the link.
    const before = ctx.container.clock.now().getTime();
    await ctx.container.provisionerLoop.tick();
    const service = await services.findById(tenantA, issued.serviceId as never);
    expect(service?.state).toBe('ACTIVE');
    expect(service?.productId).toBeNull();
    // The database marks it a trial, from the order — the application never wrote it.
    expect(service?.isTrial).toBe(true);
    expect(service?.trafficLimitBytes).toBe(100n * MB);
    // Seventy-two HOURS from the create.
    const left = (service?.expiresAt?.getTime() ?? 0) - before;
    expect(left).toBeGreaterThanOrEqual(72 * 3_600_000 - 60_000);
    expect(left).toBeLessThanOrEqual(72 * 3_600_000 + 60_000);
    expect(panel.users.get(service?.providerUsername ?? '')).toBeDefined();
    expect(service?.deliveryState).toBe('DELIVERED');
    expect(sent.some((one) => one.url.endsWith('/sendPhoto'))).toBe(true);

    // No product was created to fit the old model, and no money moved.
    expect(await count(sql`SELECT count(*)::int AS n FROM products`)).toBe(0);
    expect(await moneyRows()).toEqual({ wallet: 0, payments: 0, refunds: 0 });
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM outbox_messages
             WHERE event_type = 'TrialIssued' AND payload->>'panelId' = ${panelId}
               AND payload->'productId' = 'null'::jsonb`,
      ),
    ).toBe(1);
  });

  it('marks is_trial in the database, and never lets it change', async () => {
    await configureTrial();
    const issued = await claim(customerId, 'mark');
    if (issued.outcome !== 'ISSUED') throw new Error('refused');
    await expect(
      ctx.container.database.db.execute(
        sql`UPDATE services SET is_trial = false WHERE id = ${issued.serviceId}` as never,
      ),
    ).rejects.toThrow();
    expect((await services.findById(tenantA, issued.serviceId as never))?.isTrial).toBe(true);
  });

  it('keeps what was granted when the panel’s trial is edited afterwards', async () => {
    await configureTrial();
    const issued = await claim(customerId, 'snap');
    if (issued.outcome !== 'ISSUED') throw new Error(`refused: ${JSON.stringify(issued)}`);

    await configurePanel(panelId, { amount: '5', unit: 'GB', hours: 240, label: 'بزرگ' });

    await ctx.container.provisionerLoop.tick();
    const order = await orderRow(issued.orderId);
    expect(order).toMatchObject({ hours: 72, days: 3, title: 'Rick' });
    expect(order?.traffic).toBe(String(100n * MB));
    const service = await services.findById(tenantA, issued.serviceId as never);
    expect(service?.trafficLimitBytes).toBe(100n * MB);
  });

  it('computes a short trial’s expiry from its hours, not from whole days', async () => {
    await setFlag(true);
    await configurePanel(panelId, { hours: 12, amount: '0.5', unit: 'GB' });
    const issued = await claim(customerId, 'short');
    if (issued.outcome !== 'ISSUED') throw new Error('refused');
    expect(await orderRow(issued.orderId)).toMatchObject({ hours: 12, days: 1 });
    const before = ctx.container.clock.now().getTime();
    await ctx.container.provisionerLoop.tick();
    const service = await services.findById(tenantA, issued.serviceId as never);
    expect(service?.trafficLimitBytes).toBe(512n * MB);
    const left = (service?.expiresAt?.getTime() ?? 0) - before;
    expect(left).toBeGreaterThanOrEqual(12 * 3_600_000 - 60_000);
    expect(left).toBeLessThanOrEqual(12 * 3_600_000 + 60_000);
  });

  it('answers a replayed claim with the same trial, and writes it once', async () => {
    await configureTrial();
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
    expect(await offered()).toBe('LIMIT_REACHED');

    // A second customer has their own allowance: the limit is per customer.
    const other = await customer('950951');
    expect((await claim(other, 'o-1')).outcome).toBe('ISSUED');

    await setLimit(0);
    const third = await customer('950952');
    expect(await claim(third, 'z-1')).toEqual({ outcome: 'REFUSED', reason: 'LIMIT_REACHED' });
  });

  it('serialises two claims on the customer lock, so the second counts the first', async () => {
    /*
     * One trial per customer under a double tap: two different updates, each its own key,
     * racing for the same decision. The barrier is the customer row itself — both claims
     * are PROVEN to be waiting on it before it is released.
     */
    await configureTrial();
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
    await configureTrial();
    panel.behaviour = 'refuses-rule';
    const issued = await claim(customerId, 'fails');
    if (issued.outcome !== 'ISSUED') throw new Error(`refused: ${JSON.stringify(issued)}`);

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

    // The customer is told the truth, by the trial's own sentence.
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
    await configureTrial();
    const issued = await claim(customerId, 'retrying');
    if (issued.outcome !== 'ISSUED') throw new Error(`refused: ${JSON.stringify(issued)}`);
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

  async function trialProduct(durationDays: number): Promise<ProductId> {
    const products = new DrizzleProductRepository(ctx.container.database.db);
    const product = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'تست',
        description: null,
        audience: 'HIDDEN',
        sortOrder: 90,
        panelId: panelId as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
        specification: { durationDays, trafficBytes: 1_073_741_824n, deviceLimit: null },
        price: null,
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, product.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    await ctx.container.settingsService.set(tenantA, owner, {
      key: 'trial.product_id',
      value: product.id,
      expectedVersion: null,
      idempotencyKey: randomUUID(),
    });
    return product.id;
  }

  it('refuses a trial product id that is not a product of this tenant', async () => {
    // The retired key keeps its guard: a stored value is still a product of this tenant.
    await expect(
      ctx.container.settingsService.set(tenantA, owner, {
        key: 'trial.product_id',
        value: ctx.container.ids.uuid(),
        expectedVersion: null,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow();
    await trialProduct(1);
  });

  it('issues nothing from the retired product setting', async () => {
    // A tenant that still has `trial.product_id` stored and no panel configured has no
    // trial: nothing reads the key since R1.
    await trialProduct(1);
    await setFlag(true);
    expect(await offered()).toBe('UNCONFIGURED');
    expect(await count(sql`SELECT count(*)::int AS n FROM orders`)).toBe(0);
  });

  it('carries a configured trial product forward onto its panel, once', async () => {
    /*
     * The upgrade: migration 0142's own INSERT, replayed on a tenant that had configured a
     * trial product before R1. The product's panel gets its traffic and its duration in
     * hours; a replay changes nothing.
     */
    await trialProduct(2);
    const migration = readFileSync(
      'apps/api/drizzle/0142_r1_trial_per_panel_and_main_menu.sql',
      'utf8',
    );
    const carry = migration.slice(migration.indexOf('INSERT INTO panel_trial_configs'));
    await ctx.container.database.db.execute(sql.raw(carry));
    await ctx.container.database.db.execute(sql.raw(carry));
    expect(await ctx.container.panelTrials.get(tenantA, owner, panelId)).toMatchObject({
      enabled: true,
      trafficBytes: '1073741824',
      durationHours: 48,
      revision: 1,
    });
  });

  it('refuses a blocked customer, and a panel that cannot take a new account, without writing', async () => {
    await configureTrial();
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

  it('refuses a panel whose trial is switched off, or was never configured', async () => {
    await configureTrial();
    const bare = await newPanel('Bare', await extraFake('127.0.0.3'));
    expect(await claim(customerId, 'unconfigured-panel', bare)).toEqual({
      outcome: 'REFUSED',
      reason: 'PRODUCT_UNAVAILABLE',
    });
    await configurePanel(panelId, { enabled: false });
    expect(await claim(customerId, 'switched-off')).toEqual({
      outcome: 'REFUSED',
      reason: 'PRODUCT_UNAVAILABLE',
    });
    expect(await count(sql`SELECT count(*)::int AS n FROM orders`)).toBe(0);
  });

  it('offers only panels with a valid, enabled trial', async () => {
    /*
     * R1, the owner's second required regression. Four panels: one offering a trial; one
     * whose trial is switched off; one whose trial is on but which the operator DISABLED;
     * one whose trial is on but whose username policy will not let the installation choose
     * a name. Only the first is offered — the one eligibility evaluator decides the panel,
     * the configuration decides the trial.
     */
    await configureTrial();
    const switchedOff = await newPanel('SwitchedOff', await extraFake('127.0.0.3'));
    const disabled = await newPanel('Disabled', await extraFake('127.0.0.4'));
    const namedOnly = await newPanel('NamedOnly', await extraFake('127.0.0.5'));
    await configurePanel(switchedOff, { enabled: false });
    await configurePanel(disabled);
    await configurePanel(namedOnly);
    await ctx.container.panels.setStatus(tenantA, owner, disabled, {
      status: 'DISABLED',
      idempotencyKey: 'trial-disabled-panel',
    });
    await ctx.container.database.db.execute(
      sql`UPDATE panels SET allow_custom_username = true, allow_automatic_username = false
           WHERE id = ${namedOnly}` as never,
    );
    expect(await offered()).toEqual([panelId]);

    // The operator's overview asks the same evaluator.
    const overview = await ctx.container.panelTrials.overview(tenantA, owner);
    expect(
      Object.fromEntries(overview.panels.map((row) => [row.panelName, row.offeredNow])),
    ).toEqual({ Rick: true, SwitchedOff: false, Disabled: false, NamedOnly: false });

    // Switching a second valid panel on offers both, by their customer-facing names.
    await configurePanel(switchedOff, { enabled: true, label: 'Alpha' });
    expect(await offered()).toEqual([switchedOff, panelId]);
    // A courtesy writes nothing.
    expect(await count(sql`SELECT count(*)::int AS n FROM orders`)).toBe(0);
  });

  it('answers a redelivered update with the refusal it already gave', async () => {
    await configureTrial({ limit: 0 });
    expect(await claim(customerId, 'once')).toEqual({
      outcome: 'REFUSED',
      reason: 'LIMIT_REACHED',
    });
    await setLimit(1);
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
    await configureTrial();
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
    await configureTrial({ limit: 2 });
    const strand = async (key: string) => {
      const issued = await claim(customerId, key);
      if (issued.outcome !== 'ISSUED') throw new Error(`refused: ${JSON.stringify(issued)}`);
      await ctx.container.database.db.execute(
        sql`UPDATE provisioning_operations
               SET state = 'FAILED', completed_at = now(), claimed_by = NULL, lease_until = NULL
             WHERE order_id = ${issued.orderId}` as never,
      );
      return issued;
    };

    const delivered = await strand('stranded-ok');
    await ctx.container.provisioning.retryProvisioning(tenantA, owner, delivered.serviceId, {
      idempotencyKey: 'retry-ok',
    });
    await ctx.container.provisionerLoop.tick();
    expect((await services.findById(tenantA, delivered.serviceId as never))?.state).toBe('ACTIVE');
    expect((await grantRow(delivered.orderId))?.released_at).toBeNull();

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

  it('offers no panel in the operator’s overview while the trials switch is off (Codex, PR #111)', async () => {
    await configureTrial();
    expect(
      (await ctx.container.panelTrials.overview(tenantA, owner)).panels.map(
        (row) => row.offeredNow,
      ),
    ).toEqual([true]);
    await setFlag(false);
    expect(
      (await ctx.container.panelTrials.overview(tenantA, owner)).panels.map(
        (row) => row.offeredNow,
      ),
    ).toEqual([false]);
  });

  it('keeps a carried-forward byte count when the traffic figure is saved as shown (Codex, PR #111)', async () => {
    // 10^9 bytes, as migration 0142 may carry a product's traffic forward; shown as 953.67 MB.
    await configurePanel(panelId);
    await ctx.container.database.db.execute(
      sql`UPDATE panel_trial_configs SET traffic_bytes = 1000000000 WHERE panel_id = ${panelId}` as never,
    );
    const current = await ctx.container.panelTrials.get(tenantA, owner, panelId);
    await ctx.container.panelTrials.update(tenantA, owner, panelId, {
      idempotencyKey: randomUUID(),
      expectedRevision: current.revision,
      enabled: true,
      trafficAmount: '953.67',
      trafficUnit: 'MB',
      durationHours: 48,
      label: null,
    });
    expect(await ctx.container.panelTrials.get(tenantA, owner, panelId)).toMatchObject({
      trafficBytes: '1000000000',
      durationHours: 48,
    });
    // A figure the operator DID change is what they typed.
    const edited = await ctx.container.panelTrials.get(tenantA, owner, panelId);
    await ctx.container.panelTrials.update(tenantA, owner, panelId, {
      idempotencyKey: randomUUID(),
      expectedRevision: edited.revision,
      enabled: true,
      trafficAmount: '900',
      trafficUnit: 'MB',
      durationHours: 48,
      label: null,
    });
    expect((await ctx.container.panelTrials.get(tenantA, owner, panelId)).trafficBytes).toBe(
      String(900n * MB),
    );
  });

  it('refuses a stale configuration write, and says when a save changed nothing', async () => {
    await configurePanel(panelId);
    expect(await ctx.container.panelTrials.get(tenantA, owner, panelId)).toMatchObject({
      enabled: true,
      trafficBytes: String(100n * MB),
      durationHours: 72,
      revision: 1,
    });
    await expect(
      ctx.container.panelTrials.update(tenantA, owner, panelId, {
        idempotencyKey: randomUUID(),
        expectedRevision: 0,
        enabled: false,
        trafficAmount: '1',
        trafficUnit: 'GB',
        durationHours: 1,
        label: null,
      }),
    ).rejects.toMatchObject({ code: 'commerce.trial_config_stale' });
    const saved = await ctx.container.panelTrials.update(tenantA, owner, panelId, {
      idempotencyKey: randomUUID(),
      expectedRevision: 1,
      enabled: true,
      trafficAmount: '100',
      trafficUnit: 'MB',
      durationHours: 72,
      label: null,
    });
    expect(saved.changed).toBe(false);
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM audit_logs
             WHERE action = 'panel.trial_update' AND result = 'SUCCESS'`,
      ),
    ).toBe(1);
  });

  // =========================================================================
  // The Telegram surface: the main-menu button, the choice, and a double tap
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
  const typed = (text: string, telegramUserId: string) => {
    updateSeq += 1;
    return {
      idempotencyKey: `trial-update-${String(updateSeq)}`,
      botInstanceId: BOT_A,
      update: {
        update_id: updateSeq,
        message: {
          message_id: updateSeq,
          date: 0,
          text,
          chat: { id: Number(telegramUserId), type: 'private' },
          from: { id: Number(telegramUserId), is_bot: false, first_name: 'سارا' },
        },
      },
      telegramUserId,
      from: { id: Number(telegramUserId), first_name: 'سارا' },
    };
  };
  const lastMessage = () =>
    JSON.stringify(sent.filter((one) => one.url.includes('/sendMessage')).at(-1) ?? {});
  const grants = () => count(sql`SELECT count(*)::int AS n FROM trial_grants`);

  it('takes the trial straight from the main-menu button when one panel offers it', async () => {
    const runtime = ctx.container.botRuntime;
    const button = CATALOGUE_FA['bot.menu.trial'];

    // Off: the tap is answered with the one sentence, and nothing is written.
    const off = await runtime.handle(tenantA, systemActor('tg'), typed(button, '950950'));
    expect(off.replyKey).toBe('bot.trial.unavailable');
    expect(await grants()).toBe(0);

    await configureTrial();
    const taken = await runtime.handle(tenantA, systemActor('tg'), typed(button, '950950'));
    expect(taken.replyKey).toBe('bot.trial.issued');
    expect(await grants()).toBe(1);

    // Used up: a second tap is refused, in the same words, and issues nothing.
    const again = await runtime.handle(tenantA, systemActor('tg'), typed(button, '950950'));
    expect(again.replyKey).toBe('bot.trial.unavailable');
    // `/trial` is the same path.
    const typedCommand = await runtime.handle(
      tenantA,
      systemActor('tg'),
      typed('/trial', '950950'),
    );
    expect(typedCommand.replyKey).toBe('bot.trial.unavailable');
    expect(await grants()).toBe(1);
  });

  it('answers a redelivered menu tap with the trial it already issued (Codex, PR #111)', async () => {
    const runtime = ctx.container.botRuntime;
    await configureTrial();
    const update = typed(CATALOGUE_FA['bot.menu.trial'], '950950');
    const first = await runtime.handle(tenantA, systemActor('tg'), update);
    // Telegram redelivers the SAME update: the allowance is spent now, and the answer is
    // still the one the first delivery gave.
    const again = await runtime.handle(tenantA, systemActor('tg'), update);
    expect(first.replyKey).toBe('bot.trial.issued');
    expect(again.replyKey).toBe('bot.trial.issued');
    expect(await grants()).toBe(1);
  });

  it('answers a redelivered menu tap with the refusal it already gave, even once a panel offers a trial (Codex, PR #111)', async () => {
    const runtime = ctx.container.botRuntime;
    await setFlag(true);
    const update = typed(CATALOGUE_FA['bot.menu.trial'], '950950');
    expect((await runtime.handle(tenantA, systemActor('tg'), update)).replyKey).toBe(
      'bot.trial.unavailable',
    );
    await configurePanel(panelId);
    expect((await runtime.handle(tenantA, systemActor('tg'), update)).replyKey).toBe(
      'bot.trial.unavailable',
    );
    expect(await grants()).toBe(0);
    // A NEW tap is a new question, and is served.
    const fresh = await runtime.handle(
      tenantA,
      systemActor('tg'),
      typed(CATALOGUE_FA['bot.menu.trial'], '950950'),
    );
    expect(fresh.replyKey).toBe('bot.trial.issued');
  });

  it('shows the panel choice when several offer a trial, and issues one trial for a double tap', async () => {
    const runtime = ctx.container.botRuntime;
    await configureTrial();
    const second = await newPanel('Second', await extraFake('127.0.0.3'));
    await configurePanel(second, { label: 'آلمان', amount: '1', unit: 'GB', hours: 24 });

    const choice = await runtime.handle(
      tenantA,
      systemActor('tg'),
      typed(CATALOGUE_FA['bot.menu.trial'], '950950'),
    );
    expect(choice.replyKey).toBe('bot.trial.choose_panel');
    const drawn = lastMessage();
    expect(drawn).toContain(`"tq:${panelId}"`);
    expect(drawn).toContain(`"tq:${second}"`);
    expect(await count(sql`SELECT count(*)::int AS n FROM orders`)).toBe(0);

    // A double tap: two updates for one button. One trial; the second is told no.
    const first = await runtime.handle(tenantA, systemActor('tg'), tap(`tq:${second}`, '950950'));
    const duplicate = await runtime.handle(
      tenantA,
      systemActor('tg'),
      tap(`tq:${second}`, '950950'),
    );
    expect(first.replyKey).toBe('bot.trial.issued');
    expect(duplicate.replyKey).toBe('bot.trial.unavailable');
    expect(await grants()).toBe(1);

    // A REPLAYED callback — Telegram redelivering the same update — is answered as it was.
    await customer('950951');
    const replayed = tap(`tq:${panelId}`, '950951');
    const once = await runtime.handle(tenantA, systemActor('tg'), replayed);
    const twice = await runtime.handle(tenantA, systemActor('tg'), replayed);
    expect(once.replyKey).toBe('bot.trial.issued');
    expect(twice.replyKey).toBe('bot.trial.issued');
    expect(await grants()).toBe(2);
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM orders o JOIN services s ON s.order_id = o.id
             WHERE o.purpose = 'TRIAL' AND s.is_trial AND o.product_id IS NULL`,
      ),
    ).toBe(2);
  });

  it('refuses a crafted choice for a panel that offers no trial', async () => {
    const runtime = ctx.container.botRuntime;
    await setFlag(true);
    const crafted = await runtime.handle(
      tenantA,
      systemActor('tg'),
      tap(`tq:${panelId}`, '950950'),
    );
    expect(crafted.replyKey).toBe('bot.trial.unavailable');
    const malformed = await runtime.handle(tenantA, systemActor('tg'), tap('tq:nope', '950950'));
    expect(malformed.replyKey).not.toBe('bot.trial.issued');
    expect(await grants()).toBe(0);
  });

  it('draws the trial button only when the customer can take one, and issues it on the tap', async () => {
    const runtime = ctx.container.botRuntime;
    await runtime.handle(tenantA, systemActor('tg'), tap('cg:0', '950950'));
    expect(lastMessage()).not.toContain('"tr:"');
    await configureTrial();
    await runtime.handle(tenantA, systemActor('tg'), tap('cg:0', '950950'));
    expect(lastMessage()).toContain('"tr:"');
    const taken = await runtime.handle(tenantA, systemActor('tg'), tap('tr:', '950950'));
    expect(taken.replyKey).toBe('bot.trial.issued');
    await runtime.handle(tenantA, systemActor('tg'), tap('cg:0', '950950'));
    expect(lastMessage()).not.toContain('"tr:"');
  });

  it('is scoped to its tenant: another tenant sees no trial', async () => {
    await configureTrial();
    expect(
      await ctx.container.trials.availabilityFor(tenantB, systemActor('b'), customerId),
    ).toEqual({ available: false, reason: 'UNCONFIGURED' });
  });
});
