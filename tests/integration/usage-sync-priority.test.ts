import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { USAGE_SYNC_PLAN_LIMIT, type ActorContext, type UserId } from '@nexa/contracts';
import { DrizzleServiceRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service.repository';
import { DrizzleOperationRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-operation.repository';
import {
  ProvisioningService,
  type ProvisioningServiceDeps,
} from '../../apps/api/src/modules/commerce/provisioning/application/provisioning.service';
import { startFakeRickpanel, type FakeRickpanel } from '../support/fake-rickpanel';
import { AudienceFixtures } from './audience-fixtures';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
  tenantB,
  validatePanelConnection,
  type TestContext,
} from './harness';
import {
  bucketTokens,
  harnessFor,
  mutatingRequests,
  operationsOf,
  paidOrder,
  resolveCustomer,
  rickPanel,
  seedBackgroundBacklog,
  seedFleet,
  seedPanelUser,
  setBucket,
  systemActor,
  type Harness,
} from './usage-sync-fixtures';

/**
 * Migration P1 (H5): usage-sync eligibility and queue protection.
 *
 * The three defects the migration handoff named, each written as the failing case it
 * was first, plus the properties the fix must not cost:
 *
 *   1. an ACTIVE username-keyed service (RickPanel/Marzban answer `providerUserId: null`)
 *      was never eligible for background usage sync;
 *   2. an older scheduled SYNC_USAGE outranked a newly paid create in the claim;
 *   3. the scheduled sweep could spend the tenant's outbound budget to zero, so a paid
 *      create met BUDGET_EXHAUSTED.
 *
 * Real PostgreSQL, the real executor and loop, the real RickPanel adapter and HTTP client
 * against a deterministic RickPanel on a real socket. Only the clock is fixed, so the
 * bucket refills by simulated ticks (`usage-sync-fixtures.ts`).
 *
 * The bucket is the default shape — 100 tokens per five minutes, monitor reserve 40% — so
 * the scheduled sweep's floor is 50 tokens (`usageSyncBudgetReserveFor`).
 */

const SWEEP_FLOOR = 50;
const FIVE_YEARS_AGO = new Date(Date.now() - 5 * 365 * 86_400_000);

describe('Migration P1: usage sync eligibility and queue protection', () => {
  let ctx: TestContext;
  let panel: FakeRickpanel;
  let owner: ActorContext;
  let panelId: string;
  let buyer: UserId;
  let services: DrizzleServiceRepository;

  beforeAll(async () => {
    ctx = await createTestContext({
      PANEL_HTTP_ALLOW_LOOPBACK: 'true',
      PANEL_HTTP_TIMEOUT_MS: '1000',
      PANEL_PROBE_TENANT_LIMIT: '100',
      PANEL_PROBE_TENANT_WINDOW_MS: '300000',
      PANEL_MONITOR_BUDGET_RESERVE_PERCENT: '40',
    });
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
    services = new DrizzleServiceRepository(ctx.container.database.db);
    panel = await startFakeRickpanel({ host: '127.0.0.2' });
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-p1', roleKeys: ['owner'] }),
    );
    panelId = await rickPanel(ctx, tenantA, owner, panel, 'p1');
    await validatePanelConnection(ctx.container, tenantA, panelId);
    buyer = await resolveCustomer(ctx, tenantA, '910911');
  });

  /** A fleet of `count` stale username-keyed services, each with an account on the panel. */
  async function fleet(count: number, prefix = 'mig'): Promise<string[]> {
    const names = await seedFleet(ctx, tenantA.tenantId, panelId, {
      count,
      prefix,
      createdBefore: FIVE_YEARS_AGO,
    });
    names.forEach((name, i) => seedPanelUser(panel, name, 1_000 * (i + 1)));
    return names;
  }

  async function serviceIdOf(username: string): Promise<{ id: string; customerId: string }> {
    const result = await ctx.container.database.withClient((client) =>
      client.query<{ id: string; customer_id: string }>(
        'SELECT id, customer_id FROM services WHERE tenant_id = $1::uuid AND provider_username = $2',
        [tenantA.tenantId, username],
      ),
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error(`no service ${username}`);
    return { id: row.id, customerId: row.customer_id };
  }

  /** Plans the scheduled backlog with the PRODUCTION sweep, at `at`, with nothing spendable. */
  async function planBacklogAt(h: Harness, at: Date): Promise<void> {
    h.clock.set(at);
    await setBucket(ctx, tenantA.tenantId, 0, at);
    await h.executor.runOnce(tenantA);
  }

  const reads = (): number =>
    panel.requests.filter((one) => one.method === 'GET' && /^\/api\/user\/[^/]+$/.test(one.path))
      .length;

  // -------------------------------------------------------------------------
  // 1. Eligibility
  // -------------------------------------------------------------------------

  it('an ACTIVE username-keyed service with a NULL provider_user_id is due for usage sync', async () => {
    const names = await fleet(3);
    const now = new Date();
    const due = await services.listUsageSyncDue(tenantA, new Date(now.getTime() - 3_600_000), 50);
    expect(due.map((one) => one.providerUsername).sort()).toEqual([...names].sort());
    expect(due.every((one) => one.providerUserId === null)).toBe(true);

    const h = harnessFor(ctx, tenantA, now);
    await h.loop.tick();

    expect(reads(), 'each account was read by its stored username').toBe(3);
    for (const [i, name] of names.entries()) {
      const service = await services.findById(tenantA, (await serviceIdOf(name)).id);
      expect(service?.trafficUsedBytes).toBe(BigInt(1_000 * (i + 1)));
      expect(service?.usageSyncedAt?.getTime()).toBe(now.getTime());
      expect(service?.providerUserId, 'no provider id is invented').toBeNull();
    }
    expect(mutatingRequests(panel), 'a usage read writes nothing to the panel').toEqual([]);
  });

  it('a stale service whose read failed terminally does not block the rest of the fleet', async () => {
    // 50 services with no account on the panel (a read answers 404 → not retryable), then
    // 5 healthy ones BEHIND them in staleness order. Before P1 the 50 broken ones held the
    // top of the stalest-first page for the whole window and nothing else was planned.
    const broken = await seedFleet(ctx, tenantA.tenantId, panelId, {
      count: 50,
      prefix: 'gone',
      createdBefore: new Date(FIVE_YEARS_AGO.getTime() - 86_400_000),
    });
    expect(broken).toHaveLength(50);
    const healthy = await fleet(5, 'live');
    const h = harnessFor(ctx, tenantA, new Date());
    for (let tick = 0; tick < 20; tick += 1) {
      h.clock.advanceMs(5_000);
      await h.loop.tick();
    }
    for (const name of healthy) {
      const service = await services.findById(tenantA, (await serviceIdOf(name)).id);
      expect(service?.usageSyncedAt, `${name} was synced`).not.toBeNull();
    }
  });

  it('a service read within the cadence is not listed again, whatever became of the read', async () => {
    // Fifty stalest services whose scheduled read FAILED terminally a minute ago, and ten
    // healthy ones behind them. Listing the fifty again would hand the sweep fifty ids
    // that conflict with this window's, plan nothing, and keep the ten waiting all window.
    const failed = await seedFleet(ctx, tenantA.tenantId, panelId, {
      count: 50,
      prefix: 'dead',
      createdBefore: new Date(FIVE_YEARS_AGO.getTime() - 86_400_000),
    });
    const healthy = await fleet(10, 'next');
    const now = new Date();
    await ctx.container.database.withClient((client) =>
      client.query(
        `INSERT INTO provisioning_operations
           (id, tenant_id, operation_id, service_id, order_id, panel_id, type, state, attempts,
            failure_kind, completed_at, background, created_at, updated_at)
         SELECT gen_random_uuid(), s.tenant_id, substr(md5(s.id::text || ':dead'), 1, 16), s.id,
                s.order_id, s.panel_id, 'SYNC_USAGE', 'FAILED', 5, 'PROVIDER_ERROR', $2::timestamptz,
                true, $2::timestamptz, $2::timestamptz
           FROM services s WHERE s.tenant_id = $1::uuid AND s.provider_username LIKE 'dead%'`,
        [tenantA.tenantId, new Date(now.getTime() - 60_000).toISOString()],
      ),
    );
    const due = await services.listUsageSyncDue(
      tenantA,
      new Date(now.getTime() - 240 * 60_000),
      USAGE_SYNC_PLAN_LIMIT,
    );
    expect(due.map((one) => one.providerUsername).sort()).toEqual([...healthy].sort());
    expect(due.some((one) => failed.includes(one.providerUsername))).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 2. Claim order
  // -------------------------------------------------------------------------

  it('a newly paid create outranks an OLDER scheduled usage read', async () => {
    await fleet(20);
    const h = harnessFor(ctx, tenantA, new Date());
    await planBacklogAt(h, new Date(Date.now() - 10 * 60_000));
    const backlog = (await operationsOf(ctx, tenantA.tenantId)).filter(
      (one) => one.type === 'SYNC_USAGE',
    );
    expect(backlog.length).toBe(20);

    const orderId = await paidOrder(ctx, tenantA, owner, {
      panelId,
      customerId: buyer,
      key: 'p1-paid',
    });
    const later = new Date(Date.now() + 60_000);
    h.clock.set(later);
    await setBucket(ctx, tenantA.tenantId, 100, later);

    const first = await h.executor.runOnce(tenantA);
    expect(first.kind).toBe('ATTEMPTED');
    const claimed = (await operationsOf(ctx, tenantA.tenantId)).find(
      (one) => first.kind !== 'IDLE' && one.id === first.operationId,
    );
    expect(claimed?.type, 'the paid create is claimed before the scheduled backlog').toBe(
      'PROVISION',
    );
    expect(panel.createCalls()).toBe(1);
    expect((await services.findByOrderId(tenantA, orderId))?.state).toBe('ACTIVE');
  });

  it('a retried scheduled read keeps housekeeping priority; a retried paid create keeps its', async () => {
    const [name] = await fleet(1);
    const h = harnessFor(ctx, tenantA, new Date(Date.now() - 20 * 60_000));
    // The read is rate-limited once: a RETRYABLE failure, re-planned with a backoff.
    panel.rateLimitedReads = 1;
    await h.loop.tick();
    const retried = (await operationsOf(ctx, tenantA.tenantId)).find(
      (one) => one.type === 'SYNC_USAGE',
    );
    expect(retried?.state, 'a 429 is retried, never UNKNOWN').toBe('PLANNED');
    expect(retried?.attempts).toBe(1);
    expect(retried?.background, 'the retry is still housekeeping').toBe(true);

    await paidOrder(ctx, tenantA, owner, { panelId, customerId: buyer, key: 'p1-retry-paid' });
    h.clock.set(new Date(Date.now() + 60_000));
    const first = await h.executor.runOnce(tenantA);
    const claimed = (await operationsOf(ctx, tenantA.tenantId)).find(
      (one) => first.kind !== 'IDLE' && one.id === first.operationId,
    );
    expect(claimed?.type, 'a due retry of housekeeping does not jump a paid create').toBe(
      'PROVISION',
    );
    // And the read still happens afterwards: housekeeping waits, it is not dropped.
    await h.executor.runOnce(tenantA);
    const service = await services.findById(tenantA, (await serviceIdOf(name ?? '')).id);
    expect(service?.usageSyncedAt).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // 3. Budget
  // -------------------------------------------------------------------------

  it('the scheduled sweep stops at its floor and leaves the rest of the bucket to paid work', async () => {
    await fleet(120);
    // A frozen clock: nothing refills, so every token spent is visible.
    const at = new Date();
    const h = harnessFor(ctx, tenantA, at);
    await setBucket(ctx, tenantA.tenantId, 100, at);
    for (let tick = 0; tick < 12; tick += 1) await h.loop.tick();

    expect(reads(), 'the sweep read exactly down to its floor').toBe(100 - SWEEP_FLOOR);
    expect(await bucketTokens(ctx, tenantA.tenantId)).toBe(SWEEP_FLOOR);
    const held = h.results.filter(
      (one) => one.kind === 'REFUSED' && one.reason === 'BUDGET_EXHAUSTED',
    );
    expect(held.length, 'the next read was held, not failed').toBeGreaterThan(0);
    expect(held.every((one) => one.kind === 'REFUSED' && one.terminal === false)).toBe(true);

    const orderId = await paidOrder(ctx, tenantA, owner, {
      panelId,
      customerId: buyer,
      key: 'p1-floor-paid',
    });
    // The create is planned at the REAL time; move the clock there and pin the bucket
    // where the sweep left it, so no refill is mistaken for headroom.
    const paidAt = new Date(Date.now() + 1_000);
    h.clock.set(paidAt);
    await setBucket(ctx, tenantA.tenantId, SWEEP_FLOOR, paidAt);
    await h.loop.tick();
    expect(panel.createCalls(), 'the paid create found capacity').toBe(1);
    expect((await services.findByOrderId(tenantA, orderId))?.state).toBe('ACTIVE');
    expect(await bucketTokens(ctx, tenantA.tenantId)).toBe(SWEEP_FLOOR - 1);

    // And the scheduled queue stayed bounded: topped up to the plan limit, never grown by
    // it every tick while the budget held reads back.
    const untried = (await operationsOf(ctx, tenantA.tenantId)).filter(
      (one) => one.background && one.state === 'PLANNED' && one.attempts === 0,
    );
    expect(untried.length).toBeLessThanOrEqual(USAGE_SYNC_PLAN_LIMIT);
  });

  // -------------------------------------------------------------------------
  // Interactive reads are not housekeeping
  // -------------------------------------------------------------------------

  it("a customer's refresh is not demoted: it is claimed ahead of the backlog and spends below the floor", async () => {
    const names = await fleet(10);
    const h = harnessFor(ctx, tenantA, new Date());
    await planBacklogAt(h, new Date(Date.now() - 10 * 60_000));

    // The customer taps «refresh» on a service whose scheduled read is still queued.
    const target = await serviceIdOf(names[9] ?? '');
    const asked = await ctx.container.provisioning.requestSyncFromCustomer(
      tenantA,
      systemActor('refresh'),
      target.customerId as UserId,
      target.id,
      { idempotencyKey: 'p1-refresh' },
    );
    expect(asked.background, 'the queued read became the customer’s').toBe(false);
    expect(asked.requestedByCustomerId).toBe(target.customerId);
    const syncsForService = (await operationsOf(ctx, tenantA.tenantId)).filter(
      (one) => one.type === 'SYNC_USAGE' && one.id === asked.id,
    );
    expect(syncsForService).toHaveLength(1);

    // The bucket sits AT the sweep's floor: housekeeping may not spend, a customer may.
    const later = new Date(Date.now() + 60_000);
    h.clock.set(later);
    await setBucket(ctx, tenantA.tenantId, SWEEP_FLOOR, later);
    const first = await h.executor.runOnce(tenantA);
    expect(first.kind === 'ATTEMPTED' && first.operationId).toBe(asked.id);
    const second = await h.executor.runOnce(tenantA);
    expect(second.kind === 'REFUSED' && second.reason).toBe('BUDGET_EXHAUSTED');
    expect(await bucketTokens(ctx, tenantA.tenantId)).toBe(SWEEP_FLOOR - 1);
  });

  it("an operator's sync is not demoted either", async () => {
    const names = await fleet(5);
    const h = harnessFor(ctx, tenantA, new Date());
    await planBacklogAt(h, new Date(Date.now() - 10 * 60_000));
    const target = await serviceIdOf(names[4] ?? '');
    const asked = await ctx.container.provisioning.requestFromOperator(
      tenantA,
      owner,
      target.id,
      'SYNC_USAGE',
      { idempotencyKey: 'p1-operator-sync' },
    );
    expect(asked.background).toBe(false);
    expect(asked.requestedByCustomerId, 'an operator is not a customer').toBeNull();
    const later = new Date(Date.now() + 60_000);
    h.clock.set(later);
    await setBucket(ctx, tenantA.tenantId, SWEEP_FLOOR, later);
    const first = await h.executor.runOnce(tenantA);
    expect(first.kind === 'ATTEMPTED' && first.operationId).toBe(asked.id);
  });

  // -------------------------------------------------------------------------
  // Isolation, UNKNOWN, and what the database refuses
  // -------------------------------------------------------------------------

  it("never claims, spends or plans for another tenant's backlog", async () => {
    const fxB = new AudienceFixtures(ctx, tenantB.tenantId);
    const panelB = await fxB.panel('b');
    await seedFleet(ctx, tenantB.tenantId, panelB, {
      count: 300,
      prefix: 'bee',
      createdBefore: FIVE_YEARS_AGO,
    });
    const old = new Date(Date.now() - 3_600_000);
    expect(await seedBackgroundBacklog(ctx, tenantB.tenantId, 'bee', old)).toBe(300);

    await paidOrder(ctx, tenantA, owner, { panelId, customerId: buyer, key: 'p1-iso-paid' });
    const h = harnessFor(ctx, tenantA, new Date(Date.now() + 60_000));
    for (let tick = 0; tick < 3; tick += 1) {
      h.clock.advanceMs(5_000);
      await h.loop.tick();
    }
    expect(panel.createCalls()).toBe(1);
    const b = await operationsOf(ctx, tenantB.tenantId);
    expect(b).toHaveLength(300);
    expect(b.every((one) => one.state === 'PLANNED' && one.attempts === 0)).toBe(true);
    expect(
      await bucketTokens(ctx, tenantB.tenantId),
      "tenant B's bucket was never touched",
    ).toBeNull();
  });

  it('a create whose answer is lost is still UNKNOWN, and its reconcile outranks the backlog', async () => {
    await fleet(15);
    const h = harnessFor(ctx, tenantA, new Date());
    await planBacklogAt(h, new Date(Date.now() - 10 * 60_000));
    panel.behaviour = 'server-error';
    const orderId = await paidOrder(ctx, tenantA, owner, {
      panelId,
      customerId: buyer,
      key: 'p1-unknown',
    });
    const later = new Date(Date.now() + 60_000);
    h.clock.set(later);
    await setBucket(ctx, tenantA.tenantId, 100, later);
    const first = await h.executor.runOnce(tenantA);
    expect(first.kind === 'ATTEMPTED' && first.outcome, 'a 500 on a create is UNKNOWN').toBe(
      'UNKNOWN',
    );
    expect((await services.findByOrderId(tenantA, orderId))?.state).toBe('UNRECONCILED');

    panel.behaviour = 'healthy';
    // The reconcile is planned by the next tick and, by WP15 G3, first asks one backoff
    // later; that tick spends its claim on housekeeping because nothing else is DUE.
    h.clock.advanceMs(60_000);
    await h.executor.runOnce(tenantA);
    const reconcile = (await operationsOf(ctx, tenantA.tenantId)).find(
      (one) => one.type === 'RECONCILE',
    );
    expect(reconcile?.state).toBe('PLANNED');
    expect(reconcile?.background).toBe(false);
    h.clock.advanceMs(10 * 60_000);
    const next = await h.executor.runOnce(tenantA);
    const claimed = (await operationsOf(ctx, tenantA.tenantId)).find(
      (one) => next.kind !== 'IDLE' && one.id === next.operationId,
    );
    expect(claimed?.type, 'the reconcile is not housekeeping').toBe('RECONCILE');
    expect(claimed?.background).toBe(false);
    expect(panel.createCalls(), 'an UNKNOWN create is never retried as a create').toBe(1);
  });

  // -------------------------------------------------------------------------
  // Codex review of #172
  // -------------------------------------------------------------------------

  it('a read that failed for good after a cadence of retries is skipped for a cadence FROM THE FAILURE', async () => {
    // Fifty stalest services whose scheduled read was planned six hours ago — more than one
    // 240-minute cadence — and only failed for good a minute ago. Measured from when it was
    // planned it is already "old", so the same fifty were listed again at once.
    await seedFleet(ctx, tenantA.tenantId, panelId, {
      count: 50,
      prefix: 'slow',
      createdBefore: new Date(FIVE_YEARS_AGO.getTime() - 86_400_000),
    });
    const healthy = await fleet(10, 'well');
    const now = new Date();
    const planned = new Date(now.getTime() - 6 * 3_600_000);
    const failed = new Date(now.getTime() - 60_000);
    await ctx.container.database.withClient((client) =>
      client.query(
        `INSERT INTO provisioning_operations
           (id, tenant_id, operation_id, service_id, order_id, panel_id, type, state, attempts,
            failure_kind, completed_at, background, created_at, updated_at)
         SELECT gen_random_uuid(), s.tenant_id, substr(md5(s.id::text || ':slow'), 1, 16), s.id,
                s.order_id, s.panel_id, 'SYNC_USAGE', 'FAILED', 5, 'TIMEOUT', $3::timestamptz,
                true, $2::timestamptz, $3::timestamptz
           FROM services s WHERE s.tenant_id = $1::uuid AND s.provider_username LIKE 'slow%'`,
        [tenantA.tenantId, planned.toISOString(), failed.toISOString()],
      ),
    );
    const due = await services.listUsageSyncDue(
      tenantA,
      new Date(now.getTime() - 240 * 60_000),
      USAGE_SYNC_PLAN_LIMIT,
    );
    expect(due.map((one) => one.providerUsername).sort()).toEqual([...healthy].sort());

    // And through the real sweep: the healthy services behind them are read.
    const h = harnessFor(ctx, tenantA, now);
    await h.loop.tick();
    for (const name of healthy) {
      const service = await services.findById(tenantA, (await serviceIdOf(name)).id);
      expect(service?.usageSyncedAt, `${name} was synced`).not.toBeNull();
    }
  });

  async function auditCount(action: string): Promise<number> {
    const result = await ctx.container.database.withClient((client) =>
      client.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id = $1::uuid AND action = $2',
        [tenantA.tenantId, action],
      ),
    );
    return result.rows[0]?.n ?? 0;
  }

  it('a promoted request keeps its idempotency key: a retry replays it, with no new read and no new audit', async () => {
    const names = await fleet(2);
    const h = harnessFor(ctx, tenantA, new Date());
    await planBacklogAt(h, new Date(Date.now() - 10 * 60_000));
    const customerTarget = await serviceIdOf(names[0] ?? '');
    const operatorTarget = await serviceIdOf(names[1] ?? '');

    const asked = await ctx.container.provisioning.requestSyncFromCustomer(
      tenantA,
      systemActor('replay'),
      customerTarget.customerId as UserId,
      customerTarget.id,
      { idempotencyKey: 'p1-replay' },
    );
    const byOperator = await ctx.container.provisioning.requestFromOperator(
      tenantA,
      owner,
      operatorTarget.id,
      'SYNC_USAGE',
      { idempotencyKey: 'p1-op-replay' },
    );
    expect(asked.background).toBe(false);
    expect(byOperator.background).toBe(false);
    expect(
      (
        await ctx.container.provisioning.findCustomerRequest(
          tenantA,
          customerTarget.id,
          'SYNC_USAGE',
          'p1-replay',
        )
      )?.id,
      'the request is found by its own key',
    ).toBe(asked.id);

    // Both reads run to completion.
    const later = new Date(Date.now() + 60_000);
    h.clock.set(later);
    await setBucket(ctx, tenantA.tenantId, 100, later);
    await h.executor.runOnce(tenantA);
    await h.executor.runOnce(tenantA);
    const done = await operationsOf(ctx, tenantA.tenantId);
    expect(done.find((one) => one.id === asked.id)?.state).toBe('SUCCEEDED');
    expect(done.find((one) => one.id === byOperator.id)?.state).toBe('SUCCEEDED');
    const audits = await auditCount('service.request_sync_usage');
    expect(audits).toBe(2);

    const again = await ctx.container.provisioning.requestSyncFromCustomer(
      tenantA,
      systemActor('replay-2'),
      customerTarget.customerId as UserId,
      customerTarget.id,
      { idempotencyKey: 'p1-replay' },
    );
    const operatorAgain = await ctx.container.provisioning.requestFromOperator(
      tenantA,
      owner,
      operatorTarget.id,
      'SYNC_USAGE',
      { idempotencyKey: 'p1-op-replay' },
    );
    expect(again.id, 'the customer retry replays').toBe(asked.id);
    expect(operatorAgain.id, 'the operator retry replays').toBe(byOperator.id);
    expect(await operationsOf(ctx, tenantA.tenantId)).toHaveLength(done.length);
    expect(await auditCount('service.request_sync_usage')).toBe(audits);
  });

  it('a scheduled row claimed between the lookup and the promotion does not swallow the request', async () => {
    const [name] = await fleet(1);
    const h = harnessFor(ctx, tenantA, new Date());
    await planBacklogAt(h, new Date(Date.now() - 10 * 60_000));
    const target = await serviceIdOf(name ?? '');
    const scheduled = (await operationsOf(ctx, tenantA.tenantId)).find(
      (one) => one.type === 'SYNC_USAGE',
    );
    expect(scheduled?.background).toBe(true);

    // The race, made deterministic: the provisioner claims the scheduled row in its own
    // transaction at the instant the request tries to promote it.
    const real = new DrizzleOperationRepository(ctx.container.database.db);
    const claimAt = new Date(Date.now() + 60_000);
    let raced = false;
    const racing = new Proxy(real, {
      get(target_, property, receiver) {
        if (property === 'promoteBackground') {
          return async (...args: Parameters<DrizzleOperationRepository['promoteBackground']>) => {
            const claimed = await ctx.container.uow.run(tenantA, (tx) =>
              real.claimDue(
                tenantA,
                'provisioner:racer',
                claimAt,
                new Date(claimAt.getTime() + 60_000),
                tx,
              ),
            );
            raced = claimed?.id === scheduled?.id;
            return real.promoteBackground(...args);
          };
        }
        const value: unknown = Reflect.get(target_, property, receiver);
        return typeof value === 'function'
          ? (value as (...a: unknown[]) => unknown).bind(real)
          : value;
      },
    });
    const deps = (ctx.container.provisioning as unknown as { deps: ProvisioningServiceDeps }).deps;
    const provisioning = new ProvisioningService({ ...deps, operations: racing });

    const asked = await provisioning.requestSyncFromCustomer(
      tenantA,
      systemActor('race'),
      target.customerId as UserId,
      target.id,
      { idempotencyKey: 'p1-race' },
    );
    expect(raced, 'the scheduled row was claimed mid-request').toBe(true);
    expect(asked.id, 'the request is not the claimed housekeeping row').not.toBe(scheduled?.id);
    expect(asked.background).toBe(false);
    expect(asked.requestedByCustomerId).toBe(target.customerId);

    // The claimed read is held off at the sweep's floor and goes back to the backlog...
    await ctx.container.uow.run(tenantA, (tx) =>
      real.holdOff(tenantA, scheduled?.id ?? '', claimAt, 'floor', claimAt, tx),
    );
    // ...and the customer's own read is still claimed first, below the floor.
    h.clock.set(new Date(claimAt.getTime() + 1_000));
    await setBucket(ctx, tenantA.tenantId, SWEEP_FLOOR, h.clock.now());
    const first = await h.executor.runOnce(tenantA);
    expect(first.kind === 'ATTEMPTED' && first.operationId).toBe(asked.id);
  });

  it('the database refuses a background row that is not a scheduled usage read', async () => {
    const [name] = await fleet(1);
    const { id } = await serviceIdOf(name ?? '');
    const insert = (type: string, requestedBy: string | null) =>
      ctx.container.database.withClient((client) =>
        client.query(
          `INSERT INTO provisioning_operations
             (id, tenant_id, operation_id, service_id, panel_id, type, state, background,
              requested_by_customer_id)
           VALUES (gen_random_uuid(), $1::uuid, substr(md5(random()::text), 1, 16), $2::uuid,
                   $3::uuid, $4, 'PLANNED', true, $5::uuid)`,
          [tenantA.tenantId, id, panelId, type, requestedBy],
        ),
      );
    await expect(insert('PROVISION', null)).rejects.toThrow(
      /provisioning_operations_background_check/,
    );
    await expect(insert('SYNC_USAGE', buyer)).rejects.toThrow(
      /provisioning_operations_background_check/,
    );
    await insert('SYNC_USAGE', null);
    await expect(insert('SYNC_USAGE', null), 'one open scheduled read per service').rejects.toThrow(
      /provisioning_operations_open_background_sync_key/,
    );
  });
});
