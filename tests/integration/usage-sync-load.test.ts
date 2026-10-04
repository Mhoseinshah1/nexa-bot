import { appendFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ActorContext, OrderId, UserId } from '@nexa/contracts';
import { monitorBudgetReserveFor, usageSyncBudgetReserveFor } from '../../apps/api/src/container';
import { DRAIN_LIMIT } from '../../apps/api/src/modules/commerce/provisioning/application/provisioner-loop';
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
  systemActor,
  type Harness,
  type OperationRow,
} from './usage-sync-fixtures';

/**
 * Blocker C2 (Item 10): usage-sync load and priority, at migration scale, measured.
 *
 * A deterministic load harness, not a benchmark. Thousands of real rows in PostgreSQL,
 * the PRODUCTION executor and loop (drain limit, break-on-refusal, claim statement,
 * budget statement), the real RickPanel adapter over a real socket against a fake panel
 * that holds every account. The one thing simulated is TIME: each tick advances a fixed
 * clock by the production tick (5 s), so the token bucket refills exactly as it would in
 * production regardless of how fast this machine is. Every number below is therefore a
 * function of the rules, and reproduces run to run.
 *
 * What is measured, and asserted, per `docs/migration-p1-usage-sync.md` §C2:
 *
 *   - claim order: every paid create and every customer refresh is claimed in the FIRST
 *     tick after it exists, ahead of thousands of older scheduled reads;
 *   - capacity: the scheduled sweep never takes the bucket below its floor, and total
 *     spend never exceeds capacity + refill;
 *   - drain: the backlog still drains — at the refill rate under the production budget,
 *     and at the drain limit (10 per tick) when the budget is raised;
 *   - no starvation either way, no cross-tenant claim or spend, a retry never jumps a
 *     class, and nothing but paid creates ever mutates the panel.
 *
 * Each case reports one metrics line (`report`); the doc's numbers are copied from it.
 */

const TICK_MS = 5_000;

/**
 * The measurements, as one JSON line per case, appended to `$C2_METRICS_OUT` when it is
 * set (the integration project does not surface console output). The doc's numbers are
 * copied from that file; nothing here depends on it.
 */
function report(metrics: Record<string, unknown>): void {
  const out = process.env.C2_METRICS_OUT;
  if (out !== undefined && out !== '') appendFileSync(out, `${JSON.stringify(metrics)}\n`);
}
const FIVE_YEARS_AGO = new Date(Date.now() - 5 * 365 * 86_400_000);

describe('Blocker C2: usage-sync load and priority', () => {
  let ctx: TestContext;
  let panel: FakeRickpanel;
  let owner: ActorContext;
  let panelId: string;
  let buyer: UserId;

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
    panel = await startFakeRickpanel({ host: '127.0.0.2' });
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-c2', roleKeys: ['owner'] }),
    );
    panelId = await rickPanel(ctx, tenantA, owner, panel, 'c2');
    await validatePanelConnection(ctx.container, tenantA, panelId);
    buyer = await resolveCustomer(ctx, tenantA, '910912');
  });

  /** The migrated fleet and its scheduled backlog, planned an hour before the run starts. */
  async function migratedFleet(count: number, start: Date): Promise<string[]> {
    const names = await seedFleet(ctx, tenantA.tenantId, panelId, {
      count,
      prefix: 'mig',
      createdBefore: FIVE_YEARS_AGO,
    });
    names.forEach((name, i) => seedPanelUser(panel, name, 1_000 + i));
    const planned = await seedBackgroundBacklog(
      ctx,
      tenantA.tenantId,
      'mig',
      new Date(start.getTime() - 3_600_000),
    );
    expect(planned).toBe(count);
    return names;
  }

  /** Tenant B: its own fleet and an even OLDER backlog, which A must never touch. */
  async function neighbour(count: number, start: Date): Promise<void> {
    const fxB = new AudienceFixtures(ctx, tenantB.tenantId);
    const panelB = await fxB.panel('c2-b');
    await seedFleet(ctx, tenantB.tenantId, panelB, {
      count,
      prefix: 'bee',
      createdBefore: FIVE_YEARS_AGO,
    });
    await seedBackgroundBacklog(
      ctx,
      tenantB.tenantId,
      'bee',
      new Date(start.getTime() - 7_200_000),
    );
  }

  async function serviceOf(username: string): Promise<{ id: string; customerId: string }> {
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

  async function pendingBackground(): Promise<number> {
    const result = await ctx.container.database.withClient((client) =>
      client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM provisioning_operations
          WHERE tenant_id = $1::uuid AND background AND state IN ('PLANNED', 'IN_FLIGHT')`,
        [tenantA.tenantId],
      ),
    );
    return result.rows[0]?.n ?? 0;
  }

  interface TickRecord {
    readonly tick: number;
    readonly claimed: readonly string[];
    /** The subset that reached the panel (and so spent a token). */
    readonly attempted: readonly string[];
    readonly tokensAfter: number | null;
  }

  /**
   * Runs ticks, recording which operations each claimed (by id, in order) and the bucket
   * after it. `before(tick)` injects work before a tick runs.
   */
  async function run(
    h: Harness,
    ticks: number,
    before: (tick: number) => Promise<void> = async () => undefined,
    until?: () => Promise<boolean>,
  ): Promise<TickRecord[]> {
    const log: TickRecord[] = [];
    for (let tick = 1; tick <= ticks; tick += 1) {
      await before(tick);
      // Never behind the real clock: work planned through the product is stamped with it.
      const real = Date.now();
      h.clock.set(new Date(Math.max(h.clock.now().getTime() + TICK_MS, real)));
      const from = h.results.length;
      await h.loop.tick();
      const claimed = h.results
        .slice(from)
        .flatMap((one) => (one.kind === 'IDLE' ? [] : [one.operationId]));
      const attempted = h.results
        .slice(from)
        .flatMap((one) => (one.kind === 'ATTEMPTED' ? [one.operationId] : []));
      log.push({
        tick,
        claimed,
        attempted,
        tokensAfter: await bucketTokens(ctx, tenantA.tenantId),
      });
      if (until !== undefined && (await until())) break;
    }
    return log;
  }

  function classify(rows: readonly OperationRow[]): Map<string, OperationRow> {
    return new Map(rows.map((row) => [row.id, row]));
  }

  /** The tick in which an operation was first claimed, or null. */
  function claimedAt(log: readonly TickRecord[], id: string): number | null {
    return log.find((record) => record.claimed.includes(id))?.tick ?? null;
  }

  /** The FIRST create planned for an order's service. */
  async function provisionOf(orderId: OrderId): Promise<OperationRow> {
    const result = await ctx.container.database.withClient((client) =>
      client.query<OperationRow>(
        `SELECT o.id, o.type, o.state, o.background, o.requested_by_customer_id, o.attempts
           FROM provisioning_operations o
           JOIN services s ON s.tenant_id = o.tenant_id AND s.id = o.service_id
          WHERE o.tenant_id = $1::uuid AND s.order_id = $2::uuid AND o.type = 'PROVISION'
          ORDER BY o.created_at, o.id
          LIMIT 1`,
        [tenantA.tenantId, orderId],
      ),
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error(`no PROVISION for ${orderId}`);
    return row;
  }

  it('production budget: 3000-read backlog, paid work and a refresh first, sweep at its floor', async () => {
    const start = new Date();
    const names = await migratedFleet(3_000, start);
    await neighbour(1_000, start);
    // The simulated clock starts once the fixtures exist, so every run spans exactly 120 ticks.
    const t0 = new Date();
    const h = harnessFor(ctx, tenantA, t0);
    const floor = usageSyncBudgetReserveFor(100, monitorBudgetReserveFor(100, 40));
    expect(floor).toBe(50);

    const paidAt = new Map<number, OrderId[]>();
    let refreshId = '';
    let refreshTick = 0;
    let lostCreate: OrderId | null = null;
    const log = await run(h, 120, async (tick) => {
      if (tick === 10 || tick === 40 || tick === 80) {
        const orders: OrderId[] = [];
        for (let i = 0; i < 3; i += 1) {
          orders.push(
            await paidOrder(ctx, tenantA, owner, {
              panelId,
              customerId: buyer,
              key: `c2a-${tick}-${i}`,
            }),
          );
        }
        paidAt.set(tick, orders);
      }
      if (tick === 60) {
        // A customer taps «refresh» on a service whose scheduled read is ~2900th in line.
        const target = await serviceOf(names[2_900] ?? '');
        const asked = await ctx.container.provisioning.requestSyncFromCustomer(
          tenantA,
          systemActor('c2-refresh'),
          target.customerId as UserId,
          target.id,
          { idempotencyKey: 'c2-refresh' },
        );
        refreshId = asked.id;
        refreshTick = tick;
      }
      if (tick === 90) {
        // A create whose answer is lost: UNKNOWN, then a reconcile — never a re-create.
        panel.behaviour = 'server-error';
        lostCreate = await paidOrder(ctx, tenantA, owner, {
          panelId,
          customerId: buyer,
          key: 'c2a-lost',
        });
      }
      if (tick === 91) panel.behaviour = 'healthy';
      if (tick === 30) {
        // Five reads in a row are rate-limited: retryable, backed off, still housekeeping.
        panel.rateLimitedReads = 5;
      }
    });

    const ops = classify(await operationsOf(ctx, tenantA.tenantId));
    const isBackground = (id: string): boolean => ops.get(id)?.background === true;

    // Claim order: each paid create is claimed in the tick that first sees it, and
    // ahead of every background row in that tick.
    const paidLatency: number[] = [];
    for (const [tick, orders] of paidAt) {
      for (const orderId of orders) {
        const provision = await provisionOf(orderId);
        const at = claimedAt(log, provision.id);
        expect(at, `paid order planned before tick ${tick}`).toBe(tick);
        const sameTick = log[tick - 1]?.claimed ?? [];
        const firstBackground = sameTick.findIndex(isBackground);
        expect(firstBackground === -1 || sameTick.indexOf(provision.id) < firstBackground).toBe(
          true,
        );
        paidLatency.push((at ?? Infinity) - tick);
      }
    }
    expect(Math.max(...paidLatency), 'ticks a paid create waited').toBe(0);
    // Nine paid creates and the lost one. An eleventh is legitimate and only one: WP15
    // G3 re-plans a create once a reconcile has read the account absent TWICE.
    expect(panel.createCalls()).toBeGreaterThanOrEqual(10);
    expect(panel.createCalls()).toBeLessThanOrEqual(11);

    // The customer's refresh: claimed in the tick it was asked in, below the floor.
    expect(claimedAt(log, refreshId)).toBe(refreshTick);
    expect(ops.get(refreshId)?.background).toBe(false);
    expect(ops.get(refreshId)?.state).toBe('SUCCEEDED');

    // UNKNOWN is unchanged: the lost create is UNKNOWN, its reconcile is not
    // housekeeping and runs ahead of the backlog once due, and no create is repeated.
    const lost = await provisionOf(lostCreate as unknown as OrderId);
    const lostOutcome = h.results.find(
      (one) => one.kind === 'ATTEMPTED' && one.operationId === lost.id,
    );
    expect(lostOutcome?.kind === 'ATTEMPTED' && lostOutcome.outcome).toBe('UNKNOWN');
    // Attempted once, never retried as itself: whatever later resolved it was a READ.
    expect(lost.attempts).toBe(1);
    const reconcile = [...ops.values()].find((row) => row.type === 'RECONCILE');
    expect(reconcile?.background).toBe(false);
    const reconcileTick = reconcile === undefined ? null : claimedAt(log, reconcile.id);
    expect(reconcileTick, 'the reconcile was claimed within the run').not.toBeNull();
    expect(log[(reconcileTick ?? 1) - 1]?.claimed[0], 'first in its tick').toBe(reconcile?.id);

    // Retries: the rate-limited reads went back to PLANNED as background, never UNKNOWN.
    // A row that needed a second attempt, or is backing off for one.
    const retried = [...ops.values()].filter(
      (row) =>
        row.background && (row.attempts >= 2 || (row.state === 'PLANNED' && row.attempts === 1)),
    );
    expect(retried).toHaveLength(5);
    expect(retried.every((row) => row.state === 'PLANNED' || row.state === 'SUCCEEDED')).toBe(true);

    // Capacity: the sweep never took the bucket below its floor. Only a paid create, a
    // refresh or a reconcile ever spends below it — so after any tick in which the
    // sweep alone spent, at least the floor remains.
    const backgroundOnlyTicks = log.filter(
      (record) => record.attempted.length > 0 && record.claimed.every(isBackground),
    );
    const minAfterBackground = Math.min(
      ...backgroundOnlyTicks.map((record) => record.tokensAfter ?? 100),
    );
    expect(minAfterBackground).toBeGreaterThanOrEqual(floor);

    // Bounded: total reads + creates within capacity + refill over the simulated span.
    const simulatedSeconds = (h.clock.now().getTime() - t0.getTime()) / 1_000;
    const backgroundDone = [...ops.values()].filter(
      (row) => row.background && row.state === 'SUCCEEDED',
    ).length;
    const spent = panel.requests.filter((one) => one.path.split('?')[0] !== '/api/admin/token');
    expect(spent.length).toBeLessThanOrEqual(100 + simulatedSeconds / 3 + 20 /* read-backs */);

    // The backlog still drains: at the refill rate, not at zero.
    const remaining = await pendingBackground();
    expect(backgroundDone).toBeGreaterThan(150);
    // Every seeded row is done or still queued; the one the customer promoted left
    // the background lane.
    expect(remaining).toBe(3_000 - backgroundDone - 1);

    // Isolation: tenant B's backlog and bucket are exactly as seeded.
    const b = await operationsOf(ctx, tenantB.tenantId);
    expect(b).toHaveLength(1_000);
    expect(b.every((row) => row.state === 'PLANNED' && row.attempts === 0)).toBe(true);
    expect(await bucketTokens(ctx, tenantB.tenantId)).toBeNull();

    // No provider mutation but the paid creates (their POST and nothing else).
    expect(new Set(mutatingRequests(panel))).toEqual(new Set(['POST /api/user']));

    // Steady state: after the initial burst, ticks in which only the sweep claimed.
    const steady = log.slice(30).filter((record) => record.claimed.every(isBackground));
    const perTick = steady.map((record) => record.attempted.length);
    report({
      case: 'production-budget',
      backlog: 3_000,
      ticks: log.length,
      simulatedSeconds,
      backgroundDone,
      remaining,
      firstTicksBackground: log.slice(0, 6).map((record) => record.claimed.length),
      steadyBackgroundPerTick: perTick.reduce((a, b) => a + b, 0) / Math.max(perTick.length, 1),
      backgroundPerSecond: backgroundDone / simulatedSeconds,
      minTokensAfterBackgroundOnlyTick: minAfterBackground,
      tokensAfter: log.filter((_, i) => i % 10 === 0).map((record) => record.tokensAfter),
      paidLatencyTicks: paidLatency,
      refreshLatencyTicks: (claimedAt(log, refreshId) ?? NaN) - refreshTick,
      reconcileClaimTick: reconcileTick,
      rateLimitedRetries: retried.length,
      createCalls: panel.createCalls(),
    });
  }, 600_000);

  it('raised budget: a 2000-read backlog drains at the drain limit around a steady paid stream', async () => {
    const start = new Date();
    await migratedFleet(2_000, start);
    // Capacity 1000 per minute: refill ~83 tokens per tick, so the loop's own drain
    // limit (10 per tick) is what binds, which is the throughput ceiling of one replica.
    const capacity = 1_000;
    const h = harnessFor(ctx, tenantA, start, {
      probeBudget: { capacity, refillPerMs: capacity / 60_000 },
      backgroundBudgetReserve: usageSyncBudgetReserveFor(
        capacity,
        monitorBudgetReserveFor(capacity, 40),
      ),
    });

    const paid: { tick: number; orderId: OrderId }[] = [];
    const started = Date.now();
    const log = await run(
      h,
      400,
      async (tick) => {
        // A paid order every fifth tick, the whole way through.
        if (tick % 5 === 0) {
          paid.push({
            tick,
            orderId: await paidOrder(ctx, tenantA, owner, {
              panelId,
              customerId: buyer,
              key: `c2b-${tick}`,
            }),
          });
        }
      },
      async () => (await pendingBackground()) === 0,
    );
    const wallSeconds = (Date.now() - started) / 1_000;

    const ops = classify(await operationsOf(ctx, tenantA.tenantId));
    const isBackground = (id: string): boolean => ops.get(id)?.background === true;
    expect(await pendingBackground(), 'the whole backlog drained').toBe(0);

    const latencies: number[] = [];
    for (const { tick, orderId } of paid) {
      const provision = await provisionOf(orderId);
      const at = claimedAt(log, provision.id);
      expect(at).toBe(tick);
      expect(log[tick - 1]?.claimed[0], 'first in its tick').toBe(provision.id);
      latencies.push((at ?? Infinity) - tick);
    }
    expect(Math.max(...latencies)).toBe(0);

    // No starvation the other way: every tick but the last ran its full drain limit,
    // background filling whatever paid work left.
    const full = log.slice(0, -1);
    expect(full.every((record) => record.claimed.length === DRAIN_LIMIT)).toBe(true);
    const backgroundPerTick = full.map((record) => record.claimed.filter(isBackground).length);
    expect(Math.min(...backgroundPerTick)).toBeGreaterThanOrEqual(DRAIN_LIMIT - 1);

    const backgroundDone = [...ops.values()].filter(
      (row) => row.background && row.state === 'SUCCEEDED',
    ).length;
    expect(backgroundDone).toBe(2_000);
    expect(new Set(mutatingRequests(panel))).toEqual(new Set(['POST /api/user']));
    const minTokens = Math.min(...log.map((record) => record.tokensAfter ?? capacity));
    expect(minTokens).toBeGreaterThanOrEqual(0);

    report({
      case: 'raised-budget',
      backlog: 2_000,
      capacityPerMinute: capacity,
      ticksToDrain: log.length,
      simulatedSecondsToDrain: (log.length * TICK_MS) / 1_000,
      paidOrders: paid.length,
      paidLatencyTicks: [...new Set(latencies)],
      backgroundPerTickMin: Math.min(...backgroundPerTick),
      backgroundPerTickMax: Math.max(...backgroundPerTick),
      minTokens,
      wallSeconds,
      wallMsPerTick: (wallSeconds * 1_000) / log.length,
    });
  }, 900_000);
});
