import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type { ProviderProbeOutcome, ProviderType, TenantContext } from '@nexa/contracts';
import {
  auditLogs,
  operationalEvents,
  panelHealth,
  panels,
} from '../../apps/api/src/infrastructure/persistence/schema';
import { PanelService } from '../../apps/api/src/modules/platform/panels/application/panel.service';
import {
  PANEL_MONITOR_JOB_ID,
  PanelMonitorService,
} from '../../apps/api/src/modules/platform/panels/application/panel-monitor.service';
import type { ProbeCoreDeps } from '../../apps/api/src/modules/platform/panels/application/probe-core';
import {
  DrizzlePanelMonitorRepository,
  DrizzlePanelRepository,
} from '../../apps/api/src/modules/platform/panels/infrastructure/drizzle-panel.repository';
import { DrizzlePanelCredentialStore } from '../../apps/api/src/modules/platform/panels/infrastructure/drizzle-panel-credentials';
import { providerAdapter } from '../../apps/api/src/modules/platform/providers/infrastructure/adapter-registry';
import { SafeHttpClient } from '../../apps/api/src/infrastructure/net/safe-http';
import type { MonitorCadence } from '../../apps/api/src/modules/platform/panels/domain/monitor-cadence';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
  tenantB,
  type SeededAdmin,
  type TestContext,
} from './harness';

/**
 * The background panel-health monitor, against a real database.
 *
 * What these tests are for is the half of the design that lives in SQL and in
 * concurrency: which panels a bounded, tenant-fair query returns; that two
 * monitors racing one panel make one outbound call; that background work cannot
 * spend an operator's last unit of probe capacity; and that a `DISABLED` panel
 * is not dialled by anything, ever.
 *
 * Both seeded tenants are used throughout. Fairness and isolation are not
 * expressible with one tenant: every id is absent from a database that has one
 * tenant in it, so such a test passes whether or not the predicate exists.
 */

const USERNAME = 'monitor-admin-k2';
const PASSWORD = 'monitor-secret-do-not-leak-P8';

const CADENCE: MonitorCadence = {
  healthyIntervalMs: 10 * 60 * 1000,
  retryableIntervalMs: 2 * 60 * 1000,
  nonRetryableIntervalMs: 60 * 60 * 1000,
};

const HEALTHY: ProviderProbeOutcome = { ok: true, providerVersion: '1.0.0', degraded: false };
const DEGRADED: ProviderProbeOutcome = { ok: true, providerVersion: '1.0.0', degraded: true };
const REJECTED: ProviderProbeOutcome = {
  ok: false,
  failure: 'AUTHENTICATION_FAILED',
  status: 401,
};
const TIMED_OUT: ProviderProbeOutcome = { ok: false, failure: 'TIMEOUT', status: null };

let sequence = 0;
const key = (): string => `01920000-0000-7000-8000-${String(++sequence).padStart(12, '0')}`;

describe('the panel health monitor', () => {
  let ctx: TestContext;
  let ownerA: SeededAdmin;
  let ownerB: SeededAdmin;

  /** What the scripted adapter answers next, and how many times it was asked. */
  let outcome: ProviderProbeOutcome;
  let probes: string[];
  /** Advanced by tests that need time to pass without waiting for it. */
  let now: Date;

  beforeEach(async () => {
    ctx ??= await createTestContext({ PANEL_HTTP_ALLOW_LOOPBACK: 'true' });
    await ctx.reset();
    ownerA = await createAdmin(ctx.container, tenantA, {
      username: 'owner_a',
      roleKeys: ['owner'],
    });
    ownerB = await createAdmin(ctx.container, tenantB, {
      username: 'owner_b',
      roleKeys: ['owner'],
    });
    outcome = HEALTHY;
    probes = [];
    now = new Date('2026-03-01T12:00:00.000Z');
  });

  afterAll(async () => {
    await ctx?.close();
  });

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  /** A clock the tests drive, so cadences are exercised without waiting them out. */
  const clock = { now: () => now };

  function probeDeps(overrides: Partial<ProbeCoreDeps> = {}): ProbeCoreDeps {
    return {
      repository: new DrizzlePanelRepository(ctx.container.database.db),
      credentials: new DrizzlePanelCredentialStore(ctx.container.database.db, ctx.container.cipher),
      uow: ctx.container.uow,
      clock,
      http: new SafeHttpClient({
        allowLoopback: true,
        totalTimeoutMs: 1_000,
        maxResponseBytes: 1_024,
        maxRetries: 0,
      }),
      urlPolicy: { allowLoopback: true },
      adapters: (type: ProviderType) => ({
        ...providerAdapter(type),
        probe: async (target) => {
          probes.push(target.baseUrl);
          return outcome;
        },
      }),
      // No per-panel throttle by default: these tests probe one panel across
      // several ticks to watch a cadence move, and the cooldown has its own
      // suite where it is the subject rather than an obstacle.
      probeCooldownMs: 0,
      probeBudget: { capacity: 10_000, refillPerMs: 1 },
      cadence: CADENCE,
      ...overrides,
    };
  }

  function monitor(
    options: {
      batchSize?: number;
      concurrency?: number;
      budgetReserve?: number;
      probe?: Partial<ProbeCoreDeps>;
    } = {},
  ): PanelMonitorService {
    return new PanelMonitorService(
      {
        discovery: new DrizzlePanelMonitorRepository(ctx.container.database.db),
        probe: probeDeps(options.probe ?? {}),
        guard: ctx.container.guard,
        audit: ctx.container.audit,
        opsLog: ctx.container.opsLog,
        sessions: ctx.container.sessions,
        uow: ctx.container.uow,
        clock,
        ids: ctx.container.ids,
        logger: ctx.container.logger,
        batchSize: options.batchSize ?? 50,
        concurrency: options.concurrency ?? 4,
        budgetReserve: options.budgetReserve ?? 0,
      },
      30_000,
    );
  }

  function service(probe: Partial<ProbeCoreDeps> = {}): PanelService {
    const deps = probeDeps(probe);
    return new PanelService({
      repository: deps.repository,
      credentials: deps.credentials,
      guard: ctx.container.guard,
      audit: ctx.container.audit,
      opsLog: ctx.container.opsLog,
      sessions: ctx.container.sessions,
      uow: ctx.container.uow,
      idempotency: ctx.container.idempotency,
      clock,
      ids: ctx.container.ids,
      http: deps.http,
      urlPolicy: deps.urlPolicy,
      adapters: deps.adapters,
      probeCooldownMs: deps.probeCooldownMs,
      probeBudget: deps.probeBudget,
      cadence: deps.cadence,
    });
  }

  async function createPanel(
    admin: SeededAdmin,
    scope: TenantContext,
    name: string,
    baseUrl = 'https://panel.example.test',
  ): Promise<string> {
    const { view } = await service().create(scope, adminActorFor(admin), {
      name,
      providerType: 'marzban',
      baseUrl,
      credentials: { username: USERNAME, password: PASSWORD },
      idempotencyKey: key(),
    });
    return view.panel.id;
  }

  const healthOf = async (panelId: string) => {
    const [row] = await ctx.container.database.db
      .select()
      .from(panelHealth)
      .where(eq(panelHealth.panelId, panelId));
    return row;
  };

  const eventCodes = async (tenantId: string) =>
    (
      await ctx.container.database.db
        .select({ code: operationalEvents.code, count: operationalEvents.occurrenceCount })
        .from(operationalEvents)
        .where(eq(operationalEvents.tenantId, tenantId))
    ).sort((a, b) => a.code.localeCompare(b.code));

  // -------------------------------------------------------------------------
  // Which panels are monitored
  // -------------------------------------------------------------------------

  it('probes an ACTIVE panel that has never been checked', async () => {
    const panelId = await createPanel(ownerA, tenantA, 'never-checked');
    const result = await monitor().tick();

    expect(result.considered).toBe(1);
    expect(result.probed).toBe(1);
    expect(probes).toHaveLength(1);
    const health = await healthOf(panelId);
    expect(health?.state).toBe('HEALTHY');
    // Absence of a row IS `UNCHECKED`, so a first probe is the row's first
    // appearance rather than an update of a fabricated one.
    expect(health?.checkedAt.getTime()).toBe(now.getTime());
  });

  it('never probes a DISABLED panel', async () => {
    // Non-negotiable. `DISABLED` is the operator saying stop using this for
    // now; unattended dialling is exactly what that forbids.
    const panelId = await createPanel(ownerA, tenantA, 'disabled');
    await service().setStatus(tenantA, adminActorFor(ownerA), panelId, {
      status: 'DISABLED',
      idempotencyKey: key(),
    });

    const result = await monitor().tick();
    expect(result.considered).toBe(0);
    expect(probes).toHaveLength(0);
    expect(await healthOf(panelId)).toBeUndefined();
  });

  it('never probes an ARCHIVED panel', async () => {
    const panelId = await createPanel(ownerA, tenantA, 'archived');
    await service().setStatus(tenantA, adminActorFor(ownerA), panelId, {
      status: 'ARCHIVED',
      idempotencyKey: key(),
    });

    const result = await monitor().tick();
    expect(result.considered).toBe(0);
    expect(probes).toHaveLength(0);
  });

  it('stops probing a panel the moment it is disabled', async () => {
    const panelId = await createPanel(ownerA, tenantA, 'to-disable');
    await monitor().tick();
    expect(probes).toHaveLength(1);

    await service().setStatus(tenantA, adminActorFor(ownerA), panelId, {
      status: 'DISABLED',
      idempotencyKey: key(),
    });
    // A status change is a configuration change, so this panel would be due at
    // once were it still ACTIVE. It is not probed, which is the point: the
    // freshly-due path does not bypass the status rule.
    now = new Date(now.getTime() + 1_000);
    const result = await monitor().tick();
    expect(result.considered).toBe(0);
    expect(probes).toHaveLength(1);
  });

  it('refuses a panel disabled between discovery and the probe', async () => {
    // The race the second check exists for. Discovery filters ACTIVE, and a
    // panel can be disabled in the window between the query and the probe —
    // so the probe core checks again, against the row it just read.
    const panelId = await createPanel(ownerA, tenantA, 'raced');
    const deps = probeDeps();
    const discovery = new DrizzlePanelMonitorRepository(ctx.container.database.db);
    const due = await discovery.dueForMonitoring(now, 50);
    expect(due).toHaveLength(1);

    await service().setStatus(tenantA, adminActorFor(ownerA), panelId, {
      status: 'DISABLED',
      idempotencyKey: key(),
    });

    const { attemptProbe } =
      await import('../../apps/api/src/modules/platform/panels/application/probe-core');
    const view = await deps.repository.find(tenantA, panelId);
    const attempt = await attemptProbe(deps, tenantA, view!, {
      probeableStatuses: ['ACTIVE'],
      budgetReserve: 0,
    });
    expect(attempt.probed).toBe(false);
    expect(probes).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Cadence
  // -------------------------------------------------------------------------

  it('does not re-probe a healthy panel before its interval', async () => {
    await createPanel(ownerA, tenantA, 'healthy-cadence');
    await monitor().tick();
    expect(probes).toHaveLength(1);

    now = new Date(now.getTime() + CADENCE.healthyIntervalMs - 1);
    expect((await monitor().tick()).considered).toBe(0);
    expect(probes).toHaveLength(1);

    // Past the interval AND past the largest spread it can add.
    now = new Date(now.getTime() + CADENCE.healthyIntervalMs);
    expect((await monitor().tick()).probed).toBe(1);
    expect(probes).toHaveLength(2);
  });

  it('re-probes a retryable failure sooner than a healthy panel', async () => {
    const panelId = await createPanel(ownerA, tenantA, 'timeout');
    outcome = TIMED_OUT;
    await monitor().tick();

    const health = await healthOf(panelId);
    expect(health?.failure).toBe('TIMEOUT');
    expect(health?.consecutiveFailures).toBe(1);
    const wait = (health?.nextProbeAt.getTime() ?? 0) - now.getTime();
    expect(wait).toBeGreaterThanOrEqual(CADENCE.retryableIntervalMs);
    expect(wait).toBeLessThan(CADENCE.healthyIntervalMs);
  });

  it('backs a rejected credential off far beyond the healthy cadence', async () => {
    // The lockout rule, at the storage level. 3X-UI v3.7.0 locks an
    // IP-and-username pair after enough failed logins, so a monitor that
    // resubmitted a rejected password every ten minutes would lock the
    // operator out of their own panel on Nexa's behalf.
    const panelId = await createPanel(ownerA, tenantA, 'rejected');
    outcome = REJECTED;
    await monitor().tick();

    const first = await healthOf(panelId);
    expect(first?.state).toBe('AUTH_FAILED');
    expect(first?.consecutiveFailures).toBe(1);
    expect((first?.nextProbeAt.getTime() ?? 0) - now.getTime()).toBeGreaterThanOrEqual(
      CADENCE.nonRetryableIntervalMs,
    );

    // Nothing happens on the healthy cadence, however many ticks run.
    now = new Date(now.getTime() + CADENCE.healthyIntervalMs * 3);
    for (let i = 0; i < 5; i += 1) await monitor().tick();
    expect(probes).toHaveLength(1);
  });

  it('doubles the backoff for a failure that keeps failing, to a bound', async () => {
    const panelId = await createPanel(ownerA, tenantA, 'streak');
    outcome = TIMED_OUT;

    const waits: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const before = await healthOf(panelId);
      now = new Date(Math.max(now.getTime() + 1, before?.nextProbeAt.getTime() ?? now.getTime()));
      const result = await monitor().tick();
      expect(result.probed).toBe(1);
      const after = await healthOf(panelId);
      expect(after?.consecutiveFailures).toBe(i + 1);
      waits.push((after?.nextProbeAt.getTime() ?? 0) - now.getTime());
    }

    // Growing, then flat. Never unbounded: a panel an operator repaired must
    // not be abandoned to a backoff measured in months.
    expect(waits[1]).toBeGreaterThan(waits[0]!);
    expect(waits[2]).toBeGreaterThan(waits[1]!);
    expect(waits[4]).toBe(waits[3]);
    expect(waits[5]).toBe(waits[4]);
  });

  it('resets the streak on the first success', async () => {
    const panelId = await createPanel(ownerA, tenantA, 'recovering');
    outcome = TIMED_OUT;
    await monitor().tick();
    now = new Date((await healthOf(panelId))!.nextProbeAt.getTime());
    await monitor().tick();
    expect((await healthOf(panelId))?.consecutiveFailures).toBe(2);

    outcome = HEALTHY;
    now = new Date((await healthOf(panelId))!.nextProbeAt.getTime());
    await monitor().tick();
    const healed = await healthOf(panelId);
    expect(healed?.consecutiveFailures).toBe(0);
    expect(healed?.state).toBe('HEALTHY');
    expect((healed?.nextProbeAt.getTime() ?? 0) - now.getTime()).toBeGreaterThanOrEqual(
      CADENCE.healthyIntervalMs,
    );
  });

  it('makes a panel due at once when its address changes, without erasing its health', async () => {
    const panelId = await createPanel(ownerA, tenantA, 'reconfigured');
    outcome = REJECTED;
    await monitor().tick();
    const before = await healthOf(panelId);
    expect(before?.state).toBe('AUTH_FAILED');

    now = new Date(now.getTime() + 1_000);
    await service().update(tenantA, adminActorFor(ownerA), panelId, {
      baseUrl: 'https://panel-moved.example.test',
      idempotencyKey: key(),
    });

    // Well inside the non-retryable backoff, and due anyway.
    const discovery = new DrizzlePanelMonitorRepository(ctx.container.database.db);
    const due = await discovery.dueForMonitoring(now, 50);
    expect(due).toEqual([{ tenantId: tenantA.tenantId, panelId, reason: 'CONFIGURATION_CHANGED' }]);

    // And the previous answer is still on the row while it is due. Erasing it
    // to force a re-check would throw away `lastHealthyAt` and the state an
    // operator is reading, to say something the timestamps already say.
    const still = await healthOf(panelId);
    expect(still?.state).toBe('AUTH_FAILED');
    expect(still?.checkedAt.getTime()).toBe(before?.checkedAt.getTime());
  });

  it('makes a panel due at once when a credential is replaced', async () => {
    const panelId = await createPanel(ownerA, tenantA, 'recredentialed');
    outcome = REJECTED;
    await monitor().tick();

    now = new Date(now.getTime() + 1_000);
    await service().setCredentials(tenantA, adminActorFor(ownerA), panelId, {
      credentials: { password: 'a-corrected-password-9Q' },
      idempotencyKey: key(),
    });

    const discovery = new DrizzlePanelMonitorRepository(ctx.container.database.db);
    const due = await discovery.dueForMonitoring(now, 50);
    expect(due.map((d) => d.reason)).toEqual(['CONFIGURATION_CHANGED']);
  });

  it("lets an operator's manual test satisfy the monitor's schedule", async () => {
    // A manual test is a real probe with a real answer. A monitor that
    // re-dialled the panel a second later would be asking a question that was
    // just answered — and against a rejected credential, asking it again.
    const panelId = await createPanel(ownerA, tenantA, 'manually-tested');
    await service().testConnection(tenantA, adminActorFor(ownerA), panelId, {
      idempotencyKey: key(),
    });
    expect(probes).toHaveLength(1);

    now = new Date(now.getTime() + 1_000);
    expect((await monitor().tick()).considered).toBe(0);
    expect(probes).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Discovery: bounds, ordering and fairness
  // -------------------------------------------------------------------------

  it('returns no more than the batch size', async () => {
    for (let i = 0; i < 7; i += 1) await createPanel(ownerA, tenantA, `bounded-${i}`);
    const discovery = new DrizzlePanelMonitorRepository(ctx.container.database.db);
    expect(await discovery.dueForMonitoring(now, 3)).toHaveLength(3);
    expect(await discovery.dueForMonitoring(now, 7)).toHaveLength(7);
  });

  it('interleaves tenants rather than letting one occupy every cycle', async () => {
    // The fairness property, and it is why discovery ranks per tenant instead
    // of ordering by due time and taking the first N. Tenant A has five
    // overdue panels and tenant B has one; a batch of two must still consider
    // tenant B.
    for (let i = 0; i < 5; i += 1) await createPanel(ownerA, tenantA, `crowded-${i}`);
    await createPanel(ownerB, tenantB, 'lonely');

    const discovery = new DrizzlePanelMonitorRepository(ctx.container.database.db);
    const due = await discovery.dueForMonitoring(now, 2);
    expect(due).toHaveLength(2);
    expect(new Set(due.map((d) => d.tenantId))).toEqual(
      new Set([tenantA.tenantId, tenantB.tenantId]),
    );
  });

  it('is deterministic: the same state gives the same order', async () => {
    for (let i = 0; i < 6; i += 1) await createPanel(ownerA, tenantA, `ordered-${i}`);
    await createPanel(ownerB, tenantB, 'ordered-b');
    const discovery = new DrizzlePanelMonitorRepository(ctx.container.database.db);
    const first = await discovery.dueForMonitoring(now, 4);
    for (let i = 0; i < 5; i += 1) {
      expect(await discovery.dueForMonitoring(now, 4)).toEqual(first);
    }
  });

  it('names why each panel is due', async () => {
    const fresh = await createPanel(ownerA, tenantA, 'fresh');
    const discovery = new DrizzlePanelMonitorRepository(ctx.container.database.db);
    expect((await discovery.dueForMonitoring(now, 50))[0]).toEqual({
      tenantId: tenantA.tenantId,
      panelId: fresh,
      reason: 'NEVER_CHECKED',
    });

    await monitor().tick();
    now = new Date(now.getTime() + CADENCE.healthyIntervalMs * 2);
    expect((await discovery.dueForMonitoring(now, 50))[0]?.reason).toBe('INTERVAL_ELAPSED');
  });

  it('spreads panels probed in one tick across the following window', async () => {
    // The anti-herd property, and it is DETERMINISTIC rather than random:
    // random jitter regenerated on every process restart gives a fleet that
    // re-clusters after each deploy.
    for (let i = 0; i < 12; i += 1) await createPanel(ownerA, tenantA, `herd-${i}`);
    await monitor().tick();

    const rows = await ctx.container.database.db
      .select({ nextProbeAt: panelHealth.nextProbeAt })
      .from(panelHealth);
    const offsets = new Set(rows.map((r) => r.nextProbeAt.getTime()));
    expect(rows).toHaveLength(12);
    // All probed in the same tick, at the same clock instant, and NOT all due
    // together afterwards.
    expect(offsets.size).toBeGreaterThan(6);
  });

  // -------------------------------------------------------------------------
  // Multi-instance correctness
  // -------------------------------------------------------------------------

  it('makes one outbound call when two monitors reach the same panel', async () => {
    // Two monitor replicas is what a rolling update is, briefly. Neither
    // decides: they both ask the database, and its conditional write grants
    // one. A process-local set of in-flight panels would be wrong the moment
    // there are two processes.
    await createPanel(ownerA, tenantA, 'contended');
    const a = monitor({ probe: { probeCooldownMs: 60_000 } });
    const b = monitor({ probe: { probeCooldownMs: 60_000 } });

    const [first, second] = await Promise.all([a.tick(), b.tick()]);
    expect(probes).toHaveLength(1);
    expect(first.probed + second.probed).toBe(1);
    expect(first.refused + second.refused).toBe(1);
  });

  it('does not overlap its own ticks', async () => {
    await createPanel(ownerA, tenantA, 'slow');
    const m = monitor();
    const [a, b] = await Promise.all([m.tick(), m.tick()]);
    // The second call finds a tick already running and IS that pass.
    expect(a.considered + b.considered).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Capacity: the monitor must not lock an operator out
  // -------------------------------------------------------------------------

  it('leaves an operator capacity the background loop cannot take', async () => {
    // The floor, at the only level where it means anything: one bucket, one
    // global bound, and a reserve the background lane must leave behind. A
    // second bucket for the monitor would raise the tenant's total outbound
    // rate, which is the thing the bound exists to cap.
    const budget = { capacity: 4, refillPerMs: 0 };
    for (let i = 0; i < 6; i += 1) await createPanel(ownerA, tenantA, `hungry-${i}`);

    const m = monitor({
      budgetReserve: 2,
      probe: { probeBudget: budget, probeCooldownMs: 0 },
    });
    const result = await m.tick();

    // Two spent by the monitor, two left standing: the reserve held.
    expect(result.probed).toBe(2);
    expect(result.refused).toBe(4);

    // And an operator can still test a panel, which is the whole point.
    const panelId = await createPanel(ownerA, tenantA, 'operator-turn');
    const { probed } = await service({ probeBudget: budget, probeCooldownMs: 0 }).testConnection(
      tenantA,
      adminActorFor(ownerA),
      panelId,
      { idempotencyKey: key() },
    );
    expect(probed).toBe(true);
  });

  it("does not spend another tenant's capacity", async () => {
    const budget = { capacity: 2, refillPerMs: 0 };
    for (let i = 0; i < 4; i += 1) await createPanel(ownerA, tenantA, `a-${i}`);
    await createPanel(ownerB, tenantB, 'b-0');

    const result = await monitor({ probe: { probeBudget: budget } }).tick();
    // Tenant A's bucket is spent; tenant B's is its own.
    expect(result.probed).toBe(3);
    const bRows = await ctx.container.database.db
      .select({ id: panelHealth.panelId })
      .from(panelHealth)
      .where(eq(panelHealth.tenantId, tenantB.tenantId));
    expect(bRows).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // What a probe is allowed to change
  // -------------------------------------------------------------------------

  it('changes health and nothing else', async () => {
    const panelId = await createPanel(ownerA, tenantA, 'unchanged');
    const [before] = await ctx.container.database.db
      .select()
      .from(panels)
      .where(eq(panels.id, panelId));
    outcome = REJECTED;
    await monitor().tick();

    const [after] = await ctx.container.database.db
      .select()
      .from(panels)
      .where(eq(panels.id, panelId));
    expect(after).toEqual(before);
    // A failing probe does not disable the panel, and does not touch its
    // address or its credentials.
    expect(after?.status).toBe('ACTIVE');
  });

  it('stores no credential, cookie or provider text in the health row', async () => {
    const panelId = await createPanel(ownerA, tenantA, 'no-leak');
    outcome = REJECTED;
    await monitor().tick();
    const health = await healthOf(panelId);
    const serialized = JSON.stringify(health);
    expect(serialized).not.toContain(PASSWORD);
    expect(serialized).not.toContain(USERNAME);
    // The failure column is a normalized kind, never a message.
    expect(health?.failure).toBe('AUTHENTICATION_FAILED');
    expect(Object.keys(health ?? {})).not.toContain('detail');
  });

  it('carries lastHealthyAt across a failure', async () => {
    const panelId = await createPanel(ownerA, tenantA, 'was-healthy');
    await monitor().tick();
    const healthy = await healthOf(panelId);
    expect(healthy?.lastHealthyAt?.getTime()).toBe(now.getTime());

    outcome = TIMED_OUT;
    now = new Date(healthy!.nextProbeAt.getTime());
    await monitor().tick();
    const failed = await healthOf(panelId);
    expect(failed?.state).toBe('UNREACHABLE');
    // "Unreachable, last worked four minutes ago" and "unreachable, last
    // worked in March" are the same state and completely different problems.
    expect(failed?.lastHealthyAt?.getTime()).toBe(healthy?.lastHealthyAt?.getTime());
  });

  it('keeps exactly one health row per panel however many times it is probed', async () => {
    const panelId = await createPanel(ownerA, tenantA, 'one-row');
    for (let i = 0; i < 4; i += 1) {
      await monitor().tick();
      now = new Date((await healthOf(panelId))!.nextProbeAt.getTime());
    }
    const rows = await ctx.container.database.db
      .select({ n: sql<number>`count(*)::int` })
      .from(panelHealth)
      .where(eq(panelHealth.panelId, panelId));
    expect(rows[0]?.n).toBe(1);
    expect(probes.length).toBeGreaterThan(1);
  });

  it('discards a result that describes a configuration the operator has replaced', async () => {
    // The config-race guard. A probe runs outside the transaction that stores
    // it, so the panel can be edited while the answer is in flight — and health
    // is what an operator trusts when deciding whether their fix worked.
    // Writing the OLD configuration's verdict against the new one is the bug.
    const panelId = await createPanel(ownerA, tenantA, 'raced-config');
    let released: (() => void) | null = null;
    const inFlight = new Promise<void>((resolve) => {
      released = resolve;
    });

    const m = monitor({
      probe: {
        adapters: (type: ProviderType) => ({
          ...providerAdapter(type),
          probe: async (target) => {
            probes.push(target.baseUrl);
            await inFlight;
            return REJECTED;
          },
        }),
      },
    });
    const tick = m.tick();
    // Let the probe start, then move the panel underneath it.
    await new Promise((resolve) => setTimeout(resolve, 20));
    now = new Date(now.getTime() + 1_000);
    await service().update(tenantA, adminActorFor(ownerA), panelId, {
      baseUrl: 'https://panel-elsewhere.example.test',
      idempotencyKey: key(),
    });
    released!();

    const result = await tick;
    expect(probes).toHaveLength(1);
    // The conflict is one panel's failure, isolated like any other.
    expect(result.failed).toBe(1);
    // And nothing was stored: the answer described an address that is no
    // longer this panel's.
    expect(await healthOf(panelId)).toBeUndefined();
  });

  it('does not let a slow result overwrite a newer one', async () => {
    // Stale-result protection, at the storage level. Probes finish out of
    // order — an operator's manual test can overtake a background probe still
    // on the wire — and the older answer must not move `checked_at` backwards.
    const panelId = await createPanel(ownerA, tenantA, 'out-of-order');
    await monitor().tick();
    const fresh = await healthOf(panelId);
    expect(fresh?.state).toBe('HEALTHY');

    // A result stamped EARLIER than the row, written afterwards.
    const repository = new DrizzlePanelRepository(ctx.container.database.db);
    await ctx.container.uow.run(tenantA, (tx) =>
      repository.recordHealth(
        tenantA,
        panelId,
        {
          state: 'AUTH_FAILED',
          checkedAt: new Date(fresh!.checkedAt.getTime() - 60_000),
          latencyMs: 1,
          failure: 'AUTHENTICATION_FAILED',
          statusCode: 401,
          providerVersion: null,
          lastHealthyAt: null,
          consecutiveFailures: 1,
          nextProbeAt: new Date(fresh!.checkedAt.getTime()),
        },
        tx,
      ),
    );

    const after = await healthOf(panelId);
    expect(after?.state).toBe('HEALTHY');
    expect(after?.checkedAt.getTime()).toBe(fresh?.checkedAt.getTime());
  });

  it('refuses a panel whose address the policy now rejects, before any call', async () => {
    // The policy is applied to the STORED address on every probe, not only when
    // it was written: an installation's denied subnets can change underneath a
    // panel that was legal when it was created.
    const panelId = await createPanel(
      ownerA,
      tenantA,
      'now-blocked',
      'https://127.0.0.1:9443/panel',
    );
    const m = monitor({ probe: { urlPolicy: { allowLoopback: false } } });
    const result = await m.tick();

    expect(result.refused).toBe(1);
    // The refusal costs nothing: no socket, and no health row inventing a
    // verdict about a panel nothing contacted.
    expect(probes).toHaveLength(0);
    expect(await healthOf(panelId)).toBeUndefined();
  });

  it('does not contact a panel with no usable credentials', async () => {
    const panelId = await createPanel(ownerA, tenantA, 'no-credentials');
    await service().setCredentials(tenantA, adminActorFor(ownerA), panelId, {
      credentials: { password: null },
      idempotencyKey: key(),
    });

    const result = await monitor().tick();
    expect(result.refused).toBe(1);
    // Sending an empty password to find out would be one more failed login on
    // the operator's own panel.
    expect(probes).toHaveLength(0);
    expect(await healthOf(panelId)).toBeUndefined();
  });

  it('writes no health for a probe the budget refused', async () => {
    // The tenant's whole capacity is one token, and the operator spends it —
    // so the monitor's probe is refused by the bound rather than by anything
    // about the panel. A refusal must leave no trace: no socket, and no health
    // row inventing a verdict about a panel nothing contacted.
    const budget = { capacity: 1, refillPerMs: 0 };
    const spender = await createPanel(ownerA, tenantA, 'budget-spender');
    await service({ probeBudget: budget, probeCooldownMs: 0 }).testConnection(
      tenantA,
      adminActorFor(ownerA),
      spender,
      { idempotencyKey: key() },
    );
    expect(probes).toHaveLength(1);

    const target = await createPanel(ownerA, tenantA, 'budget-refused');
    const result = await monitor({
      budgetReserve: 0,
      probe: { probeBudget: budget },
    }).tick();

    expect(result.probed).toBe(0);
    expect(result.refused).toBeGreaterThan(0);
    expect(result.failed).toBe(0);
    expect(probes).toHaveLength(1);
    expect(await healthOf(target)).toBeUndefined();
  });

  it('refuses the monitor rather than writing a negative budget', async () => {
    // A reserve at or above capacity is a configuration mistake, and the two
    // branches of the budget statement must not disagree about it: a tenant
    // with no row takes the INSERT branch, which spends from a full bucket. If
    // that branch ignored an impossible floor, the first probe would succeed
    // and every one after it would be refused — indistinguishable from a
    // broken monitor. The floor is clamped inside the repository, so the
    // insert stays consistent with the update.
    await createPanel(ownerA, tenantA, 'impossible-reserve');
    const result = await monitor({
      budgetReserve: 500,
      probe: { probeBudget: { capacity: 2, refillPerMs: 0 } },
    }).tick();
    // One token is always reachable from a full bucket; nothing throws.
    expect(result.failed).toBe(0);
    expect(result.probed + result.refused).toBe(1);
    const rows = await ctx.container.database.db
      .select({ tokens: sql<number>`tokens` })
      .from(sql`panel_probe_budgets`);
    for (const row of rows) expect(Number(row.tokens)).toBeGreaterThanOrEqual(0);
  });

  it('keeps no more probes in flight than its concurrency allows', async () => {
    for (let i = 0; i < 8; i += 1) await createPanel(ownerA, tenantA, `parallel-${i}`);
    let inFlight = 0;
    let peak = 0;
    const m = monitor({
      concurrency: 3,
      probe: {
        adapters: (type: ProviderType) => ({
          ...providerAdapter(type),
          probe: async (target) => {
            probes.push(target.baseUrl);
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            await new Promise((resolve) => setTimeout(resolve, 15));
            inFlight -= 1;
            return HEALTHY;
          },
        }),
      },
    });
    const result = await m.tick();
    expect(result.probed).toBe(8);
    // A `Promise.all` over the candidate set would open one socket and take one
    // pool connection per panel — a batch-size change away from exhausting both.
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('monitors a token-authenticated provider through the same core', async () => {
    // The monitor never asks which provider a panel is. Credential resolution
    // happens once, in the shared core, from the descriptor's declared shape —
    // so a provider whose credential is an opaque token needs no monitor
    // change at all.
    const { view } = await service().create(tenantA, adminActorFor(ownerA), {
      name: 'sanaei-panel',
      providerType: 'sanaei',
      baseUrl: 'https://xui.example.test/mypath',
      credentials: { apiToken: 'monitor-token-4Q' },
      idempotencyKey: key(),
    });

    const result = await monitor().tick();
    expect(result.probed).toBe(1);
    expect((await healthOf(view.panel.id))?.state).toBe('HEALTHY');
  });

  // -------------------------------------------------------------------------
  // Actor, authorization and audit
  // -------------------------------------------------------------------------

  it('acts as SYSTEM_JOB with a stable job identity', async () => {
    const panelId = await createPanel(ownerA, tenantA, 'audited');
    outcome = REJECTED;
    await monitor().tick();

    const rows = await ctx.container.database.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, panelId), eq(auditLogs.action, 'panel.monitor.probe')));
    expect(rows).toHaveLength(1);
    // Never a fabricated administrator. A job is a job, and it holds a job's
    // permission rather than borrowing an operator's.
    expect(rows[0]?.actorType).toBe('SYSTEM_JOB');
    expect(rows[0]?.actorId).toBe(PANEL_MONITOR_JOB_ID);
  });

  it('writes an audit row on a transition and not on a steady state', async () => {
    // A row per tick would be a health-history table wearing the audit log's
    // name — six per panel per hour, for ever, in a table that refuses DELETE.
    const panelId = await createPanel(ownerA, tenantA, 'steady');
    await monitor().tick();
    now = new Date((await healthOf(panelId))!.nextProbeAt.getTime());
    await monitor().tick();
    now = new Date((await healthOf(panelId))!.nextProbeAt.getTime());
    await monitor().tick();
    expect(probes).toHaveLength(3);

    const rows = await ctx.container.database.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'panel.monitor.probe'));
    // Three healthy probes from UNCHECKED: the first is not a transition into
    // a reportable condition, and neither are the two after it.
    expect(rows).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Operational events
  // -------------------------------------------------------------------------

  it('announces a failure once, however long it lasts', async () => {
    const panelId = await createPanel(ownerA, tenantA, 'flapping');
    outcome = TIMED_OUT;
    for (let i = 0; i < 4; i += 1) {
      await monitor().tick();
      now = new Date((await healthOf(panelId))!.nextProbeAt.getTime());
    }
    expect(probes).toHaveLength(4);

    const events = await eventCodes(tenantA.tenantId);
    expect(events.map((e) => e.code)).toEqual(['panel.health.failed']);
    // One row, whose counter says how often. The legacy log group posted the
    // same expired-certificate error 60 times in a day because nothing could
    // tell the occurrences apart.
    expect(events[0]?.count).toBe(1);
  });

  it('says nothing at all while a panel stays healthy', async () => {
    const panelId = await createPanel(ownerA, tenantA, 'quiet');
    for (let i = 0; i < 3; i += 1) {
      await monitor().tick();
      now = new Date((await healthOf(panelId))!.nextProbeAt.getTime());
    }
    expect(await eventCodes(tenantA.tenantId)).toEqual([]);
  });

  it('announces recovery, and only after a failure', async () => {
    const panelId = await createPanel(ownerA, tenantA, 'recovers');
    outcome = TIMED_OUT;
    await monitor().tick();
    now = new Date((await healthOf(panelId))!.nextProbeAt.getTime());
    outcome = HEALTHY;
    await monitor().tick();

    const events = await eventCodes(tenantA.tenantId);
    expect(events.map((e) => e.code)).toEqual(['panel.health.failed', 'panel.health.recovered']);
  });

  it('distinguishes degraded from failed', async () => {
    const panelId = await createPanel(ownerA, tenantA, 'degrades');
    outcome = DEGRADED;
    await monitor().tick();
    expect((await healthOf(panelId))?.state).toBe('DEGRADED');
    expect((await eventCodes(tenantA.tenantId)).map((e) => e.code)).toEqual([
      'panel.health.degraded',
    ]);
  });

  it('keeps one tenant events out of another', async () => {
    await createPanel(ownerA, tenantA, 'a-fails');
    await createPanel(ownerB, tenantB, 'b-fine');
    outcome = TIMED_OUT;
    await monitor().tick();

    expect((await eventCodes(tenantA.tenantId)).map((e) => e.code)).toEqual([
      'panel.health.failed',
    ]);
    expect((await eventCodes(tenantB.tenantId)).map((e) => e.code)).toEqual([
      'panel.health.failed',
    ]);
    // Two tenants, two rows — not one row visible to both.
    const all = await ctx.container.database.db.select().from(operationalEvents);
    expect(all).toHaveLength(2);
    expect(new Set(all.map((e) => e.tenantId)).size).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Failure isolation and liveness
  // -------------------------------------------------------------------------

  it('keeps going when one panel throws', async () => {
    const good = await createPanel(ownerA, tenantA, 'good');
    const bad = await createPanel(ownerA, tenantA, 'bad');
    const m = monitor({
      concurrency: 1,
      probe: {
        adapters: (type: ProviderType) => ({
          ...providerAdapter(type),
          probe: async (target) => {
            probes.push(target.baseUrl);
            throw new Error('the adapter exploded');
          },
        }),
      },
    });
    // Both panels are attempted; neither stops the sweep.
    const result = await m.tick();
    expect(result.considered).toBe(2);
    expect(result.failed).toBe(2);
    expect(await healthOf(good)).toBeUndefined();
    expect(await healthOf(bad)).toBeUndefined();
  });

  it('reports its loop as stale until a tick completes, and fresh after one', async () => {
    const m = monitor();
    // The heartbeat's second question. A process whose timer fires while every
    // tick throws is not monitoring anything.
    expect(m.iterationIsFresh(now.getTime())).toBe(false);
    await m.tick();
    expect(m.iterationIsFresh(now.getTime())).toBe(true);
    // And it goes stale again if ticks stop.
    expect(m.iterationIsFresh(now.getTime() + 30_000 * 4)).toBe(false);
  });

  it('does not report a completed tick when discovery itself fails', async () => {
    const m = new PanelMonitorService(
      {
        discovery: {
          dueForMonitoring: async () => {
            throw new Error('the database is gone');
          },
        },
        probe: probeDeps(),
        guard: ctx.container.guard,
        audit: ctx.container.audit,
        opsLog: ctx.container.opsLog,
        sessions: ctx.container.sessions,
        uow: ctx.container.uow,
        clock,
        ids: ctx.container.ids,
        logger: ctx.container.logger,
        batchSize: 50,
        concurrency: 4,
        budgetReserve: 0,
      },
      30_000,
    );
    await m.tick();
    // A tick that could not run is not a tick that ran. Reporting it fresh
    // would keep the container healthy while it monitored nothing.
    expect(m.iterationIsFresh(now.getTime())).toBe(false);
  });

  it('stops cleanly and probes nothing afterwards', async () => {
    await createPanel(ownerA, tenantA, 'shutdown');
    const m = monitor();
    await m.stop();
    // start() is what schedules work; a stopped monitor that was never started
    // must not have left a timer behind either.
    expect(probes).toHaveLength(0);
  });
});
