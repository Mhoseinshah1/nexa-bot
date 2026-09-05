import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { errors } from '@nexa/contracts';
import type { ProviderProbeOutcome, ProviderType, TenantContext } from '@nexa/contracts';
import {
  auditLogs,
  operationalEvents,
  panelHealth,
  panelMonitorSchedule,
  panelMonitorTenants,
  panelProbeBudgets,
  panelProbeClaims,
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
import {
  MONITOR_NONRETRYABLE_FLOOR_MS,
  MONITOR_STABLE_DEFERRAL_MS,
  SCHEDULE_SUSPENDED_AT,
  type MonitorCadence,
} from '../../apps/api/src/modules/platform/panels/domain/monitor-cadence';
import type { PanelMonitorRepository } from '../../apps/api/src/modules/platform/panels/application/ports';
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
/** The panel wants a second factor. A different remedy from a wrong password. */
const NEEDS_INTERACTION: ProviderProbeOutcome = {
  ok: false,
  failure: 'AUTHENTICATION_REQUIRES_INTERACTION',
  status: 200,
};

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
      tenantsPerTick?: number;
      concurrency?: number;
      budgetReserve?: number;
      probe?: Partial<ProbeCoreDeps>;
      /**
       * A stand-in for the discovery query.
       *
       * Used only where the point is what the monitor does with a candidate
       * the real query would no longer return — the window between the query
       * and the probe. Everywhere else the real repository runs, because
       * discovery IS half of the behaviour under test.
       */
      discovery?: PanelMonitorRepository;
    } = {},
  ): PanelMonitorService {
    return new PanelMonitorService(
      {
        discovery:
          options.discovery ?? new DrizzlePanelMonitorRepository(ctx.container.database.db),
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
        tenantsPerTick: options.tenantsPerTick ?? 10,
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

  const scheduleOf = async (panelId: string) => {
    const [row] = await ctx.container.database.db
      .select()
      .from(panelMonitorSchedule)
      .where(eq(panelMonitorSchedule.panelId, panelId));
    return row;
  };

  const rotationOf = async (tenantId: string) => {
    const [row] = await ctx.container.database.db
      .select()
      .from(panelMonitorTenants)
      .where(eq(panelMonitorTenants.tenantId, tenantId));
    return row;
  };

  /** Runs one tick and reports what it did, for readability at the call sites. */
  const tick = async (m = monitor()) => m.tick();

  // ===========================================================================
  // 1-4. Authorization happens BEFORE any side effect
  // ===========================================================================

  describe('authorization before side effects', () => {
    /**
     * A guard that refuses `maintenance.run`, wired the same way the real one
     * is so the denial travels the real path.
     *
     * The test that matters is not "it returns false" — it is that NOTHING
     * happened: no credential decrypted, no claim taken, no budget spent, no
     * socket opened. A permission checked after any of those has prevented
     * nothing, and the first version of this service checked it in the
     * transaction that stored the RESULT.
     */
    function denyingMonitor(counters: { credentialReads: number }): {
      service: PanelMonitorService;
      probeDeps: ProbeCoreDeps;
    } {
      const deps = probeDeps();
      const watched: ProbeCoreDeps = {
        ...deps,
        credentials: {
          read: async (...args) => {
            counters.credentialReads += 1;
            return deps.credentials.read(...args);
          },
          write: deps.credentials.write.bind(deps.credentials),
        },
      };
      const service = new PanelMonitorService(
        {
          discovery: new DrizzlePanelMonitorRepository(ctx.container.database.db),
          probe: watched,
          // A guard that denies everything, standing in for a job whose
          // permission has been narrowed or revoked.
          guard: {
            check: async () => {
              throw errors.permissionDenied(
                'access.permission_denied',
                'This job may not run maintenance for this tenant.',
                { permission: 'maintenance.run' },
              );
            },
            denialEvent: ctx.container.guard.denialEvent.bind(ctx.container.guard),
          } as unknown as typeof ctx.container.guard,
          audit: ctx.container.audit,
          opsLog: ctx.container.opsLog,
          sessions: ctx.container.sessions,
          uow: ctx.container.uow,
          clock,
          ids: ctx.container.ids,
          logger: ctx.container.logger,
          batchSize: 50,
          tenantsPerTick: 10,
          concurrency: 4,
          budgetReserve: 0,
        },
        30_000,
      );
      return { service, probeDeps: watched };
    }

    it('makes no network call, spends no claim and no budget when denied', async () => {
      const panelId = await createPanel(ownerA, tenantA, 'denied');
      const counters = { credentialReads: 0 };
      const { service: denied } = denyingMonitor(counters);

      const result = await denied.tick();

      expect(result.deferred).toBe(1);
      expect(result.probed).toBe(0);
      // 1-4, in order: no credential decrypted, no outbound call, no claim, no
      // budget.
      expect(counters.credentialReads).toBe(0);
      expect(probes).toHaveLength(0);
      const claims = await ctx.container.database.db.select().from(panelProbeClaims);
      expect(claims).toHaveLength(0);
      const budgets = await ctx.container.database.db.select().from(panelProbeBudgets);
      expect(budgets).toHaveLength(0);
      // And no health invented for a panel nothing contacted.
      expect(await healthOf(panelId)).toBeUndefined();
    });

    it('records the denial and defers the panel', async () => {
      const panelId = await createPanel(ownerA, tenantA, 'denied-audited');
      const counters = { credentialReads: 0 };
      await denyingMonitor(counters).service.tick();

      // The same trail a refused operator leaves.
      const audits = await ctx.container.database.db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.action, 'panel.monitor.probe'));
      expect(audits).toHaveLength(1);
      expect(audits[0]?.result).toBe('DENIED');
      expect(audits[0]?.actorType).toBe('SYSTEM_JOB');

      // And the panel steps back rather than being retried every tick.
      const schedule = await scheduleOf(panelId);
      expect(schedule?.deferredReason).toBe('NOT_AUTHORIZED');
      expect(schedule?.nextEligibleAt.getTime()).toBeGreaterThan(now.getTime());
    });
  });

  // ===========================================================================
  // 5-16. Discovery: what is due, bounded, deterministic and fair
  // ===========================================================================

  describe('discovery', () => {
    it('probes an ACTIVE panel that has never been checked', async () => {
      const panelId = await createPanel(ownerA, tenantA, 'never-checked');
      const result = await tick();

      expect(result.considered).toBe(1);
      expect(result.probed).toBe(1);
      expect(probes).toHaveLength(1);
      const health = await healthOf(panelId);
      expect(health?.state).toBe('HEALTHY');
      expect(health?.checkedAt.getTime()).toBe(now.getTime());
    });

    it('does not re-probe a fresh panel', async () => {
      await createPanel(ownerA, tenantA, 'fresh');
      await tick();
      expect(probes).toHaveLength(1);

      now = new Date(now.getTime() + CADENCE.healthyIntervalMs - 1);
      expect((await tick()).probed).toBe(0);
      expect(probes).toHaveLength(1);
    });

    it('probes it again once the interval has elapsed', async () => {
      const panelId = await createPanel(ownerA, tenantA, 'due-again');
      await tick();
      now = new Date((await scheduleOf(panelId))!.nextEligibleAt.getTime());
      expect((await tick()).probed).toBe(1);
      expect(probes).toHaveLength(2);
    });

    it('never probes a DISABLED panel', async () => {
      // Non-negotiable. `DISABLED` is the operator saying stop using this for
      // now; unattended dialling is exactly what that forbids.
      const panelId = await createPanel(ownerA, tenantA, 'disabled');
      await service().setStatus(tenantA, adminActorFor(ownerA), panelId, {
        status: 'DISABLED',
        idempotencyKey: key(),
      });

      // The schedule is the status filter: the panel is not skipped by the
      // scan, it is outside the range the scan reads.
      expect((await scheduleOf(panelId))?.nextEligibleAt.getTime()).toBe(
        SCHEDULE_SUSPENDED_AT.getTime(),
      );

      const result = await tick();
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
      expect((await tick()).considered).toBe(0);
      expect(probes).toHaveLength(0);
    });

    it('resumes a re-enabled panel immediately', async () => {
      const panelId = await createPanel(ownerA, tenantA, 'resumed');
      await service().setStatus(tenantA, adminActorFor(ownerA), panelId, {
        status: 'DISABLED',
        idempotencyKey: key(),
      });
      await tick();
      expect(probes).toHaveLength(0);

      now = new Date(now.getTime() + 1_000);
      await service().setStatus(tenantA, adminActorFor(ownerA), panelId, {
        status: 'ACTIVE',
        idempotencyKey: key(),
      });
      expect((await tick()).probed).toBe(1);
    });

    it('refuses a panel disabled between discovery and the probe', async () => {
      // The race the second status check exists for, driven through the
      // MONITOR: a test that passes `probeableStatuses` itself pins the test's
      // own choice, not the monitor's, and would go on passing if the monitor
      // started accepting DISABLED panels.
      const panelId = await createPanel(ownerA, tenantA, 'raced');
      await service().setStatus(tenantA, adminActorFor(ownerA), panelId, {
        status: 'DISABLED',
        idempotencyKey: key(),
      });

      const m = monitor({
        discovery: {
          claimTenants: async () => [tenantA.tenantId],
          dueForTenants: async () => [{ tenantId: tenantA.tenantId, panelId }],
          refreshTenantBounds: async () => {},
        },
      });
      const result = await m.tick();

      expect(result.considered).toBe(1);
      expect(result.probed).toBe(0);
      expect(probes).toHaveLength(0);
      expect(await healthOf(panelId)).toBeUndefined();
      // And it repairs the schedule it found disagreeing with the panel.
      expect((await scheduleOf(panelId))?.deferredReason).toBe('STATUS_NOT_PROBEABLE');
    });

    it('makes a panel due at once when its address changes', async () => {
      const panelId = await createPanel(ownerA, tenantA, 'readdressed');
      outcome = REJECTED;
      await tick();
      const before = await healthOf(panelId);
      expect(before?.state).toBe('AUTH_FAILED');
      // Well inside the long non-retryable backoff.
      expect((await scheduleOf(panelId))!.nextEligibleAt.getTime()).toBeGreaterThan(
        now.getTime() + 20 * 60 * 1000,
      );

      now = new Date(now.getTime() + 1_000);
      await service().update(tenantA, adminActorFor(ownerA), panelId, {
        baseUrl: 'https://panel-moved.example.test',
        idempotencyKey: key(),
      });

      expect((await scheduleOf(panelId))!.nextEligibleAt.getTime()).toBe(now.getTime());
      // And the previous answer is still on the row. Erasing it to force a
      // re-check would throw away `lastHealthyAt` and the state an operator is
      // reading, to say something the schedule already says.
      const still = await healthOf(panelId);
      expect(still?.state).toBe('AUTH_FAILED');
      expect(still?.checkedAt.getTime()).toBe(before?.checkedAt.getTime());
    });

    it('makes a panel due at once when a credential is replaced', async () => {
      const panelId = await createPanel(ownerA, tenantA, 'recredentialed');
      outcome = REJECTED;
      await tick();

      now = new Date(now.getTime() + 1_000);
      await service().setCredentials(tenantA, adminActorFor(ownerA), panelId, {
        credentials: { password: 'a-corrected-password-9Q' },
        idempotencyKey: key(),
      });

      const schedule = await scheduleOf(panelId);
      expect(schedule!.nextEligibleAt.getTime()).toBe(now.getTime());
      // The backoff streak went with it: it was evidence about a credential
      // that no longer exists.
      expect(schedule!.consecutiveFailures).toBe(0);
    });

    it("lets an operator's manual test satisfy the monitor's schedule", async () => {
      const panelId = await createPanel(ownerA, tenantA, 'manually-tested');
      await service().testConnection(tenantA, adminActorFor(ownerA), panelId, {
        idempotencyKey: key(),
      });
      expect(probes).toHaveLength(1);

      now = new Date(now.getTime() + 1_000);
      expect((await tick()).probed).toBe(0);
      expect(probes).toHaveLength(1);
    });

    it('returns no more than the batch size', async () => {
      for (let i = 0; i < 7; i += 1) await createPanel(ownerA, tenantA, `bounded-${i}`);
      const result = await tick(monitor({ batchSize: 3 }));
      expect(result.considered).toBe(3);
    });

    it('is deterministic: the same state gives the same candidates', async () => {
      for (let i = 0; i < 6; i += 1) await createPanel(ownerA, tenantA, `ordered-${i}`);
      const discovery = new DrizzlePanelMonitorRepository(ctx.container.database.db);
      const first = await discovery.dueForTenants([tenantA.tenantId], now, 4, 4);
      for (let i = 0; i < 5; i += 1) {
        expect(await discovery.dueForTenants([tenantA.tenantId], now, 4, 4)).toEqual(first);
      }
    });

    it('interleaves two tenants rather than letting one occupy every cycle', async () => {
      for (let i = 0; i < 5; i += 1) await createPanel(ownerA, tenantA, `crowded-${i}`);
      await createPanel(ownerB, tenantB, 'lonely');

      const result = await tick(monitor({ batchSize: 2, tenantsPerTick: 2 }));
      expect(result.tenants).toBe(2);
      const probedTenants = await ctx.container.database.db.select().from(panelHealth);
      expect(new Set(probedTenants.map((r) => r.tenantId)).size).toBe(2);
    });
  });

  // ===========================================================================
  // 17-20. Preflight refusals defer; they never invent health
  // ===========================================================================

  describe('preflight refusals', () => {
    it('does not hot-loop a panel with no usable credential', async () => {
      // The starvation bug this replaces: with the schedule kept on the health
      // row, a panel that could never be probed had no row, was rediscovered on
      // every tick for ever, and spent its tenant's slot to learn nothing.
      const panelId = await createPanel(ownerA, tenantA, 'no-credentials');
      await service().setCredentials(tenantA, adminActorFor(ownerA), panelId, {
        credentials: { password: null },
        idempotencyKey: key(),
      });

      const result = await tick();
      expect(result.deferred).toBe(1);
      expect(probes).toHaveLength(0);
      // No provider was contacted, so nothing is claimed about the provider.
      expect(await healthOf(panelId)).toBeUndefined();

      const schedule = await scheduleOf(panelId);
      expect(schedule?.deferredReason).toBe('CREDENTIALS_MISSING');
      expect(schedule!.nextEligibleAt.getTime()).toBe(now.getTime() + MONITOR_STABLE_DEFERRAL_MS);

      // And it is genuinely out of the way on the next tick.
      now = new Date(now.getTime() + 60_000);
      expect((await tick()).considered).toBe(0);
    });

    it('does not hot-loop a panel whose address the policy refuses', async () => {
      const panelId = await createPanel(
        ownerA,
        tenantA,
        'now-blocked',
        'https://127.0.0.1:9443/panel',
      );
      const m = monitor({ probe: { urlPolicy: { allowLoopback: false } } });
      const result = await m.tick();

      expect(result.deferred).toBe(1);
      expect(probes).toHaveLength(0);
      expect(await healthOf(panelId)).toBeUndefined();
      expect((await scheduleOf(panelId))?.deferredReason).toBe('TARGET_BLOCKED');
    });

    it('lets a corrected credential make a deferred panel eligible at once', async () => {
      const panelId = await createPanel(ownerA, tenantA, 'fixable');
      await service().setCredentials(tenantA, adminActorFor(ownerA), panelId, {
        credentials: { password: null },
        idempotencyKey: key(),
      });
      await tick();
      expect((await scheduleOf(panelId))?.deferredReason).toBe('CREDENTIALS_MISSING');

      now = new Date(now.getTime() + 1_000);
      await service().setCredentials(tenantA, adminActorFor(ownerA), panelId, {
        credentials: { password: 'a-real-password-Q7' },
        idempotencyKey: key(),
      });
      const schedule = await scheduleOf(panelId);
      expect(schedule?.deferredReason).toBeNull();
      expect(schedule!.nextEligibleAt.getTime()).toBe(now.getTime());
      expect((await tick()).probed).toBe(1);
    });

    it('does not let one unusable panel occupy its tenant slot every tick', async () => {
      // The starvation shape, end to end: an old credential-less panel and a
      // later working one, in one tenant, with room for one panel per tick.
      const broken = await createPanel(ownerA, tenantA, 'broken-old');
      await service().setCredentials(tenantA, adminActorFor(ownerA), broken, {
        credentials: { password: null },
        idempotencyKey: key(),
      });
      now = new Date(now.getTime() + 1_000);
      const working = await createPanel(ownerA, tenantA, 'working-new');

      // First tick: the broken panel is oldest, gets the slot, and defers.
      const first = await tick(monitor({ batchSize: 1 }));
      expect(first.deferred).toBe(1);
      expect(probes).toHaveLength(0);

      // Second tick: the broken panel is out of the way, so the working one is
      // reached. Under the old model it never would have been.
      now = new Date(now.getTime() + 1_000);
      const second = await tick(monitor({ batchSize: 1 }));
      expect(second.probed).toBe(1);
      expect((await healthOf(working))?.state).toBe('HEALTHY');
    });
  });

  // ===========================================================================
  // 21-28. Concurrency, claims, budget and manual headroom
  // ===========================================================================

  describe('concurrency and capacity', () => {
    it('makes one outbound call when two monitors reach the same panel', async () => {
      // Two monitor replicas is what a rolling update is, briefly. Neither
      // decides: they both ask the database, and its conditional write grants
      // one. `claimTenants` is exclusive, so the two also take disjoint
      // tenants — this drives them at ONE tenant deliberately, to exercise the
      // per-panel claim rather than the rotation.
      await createPanel(ownerA, tenantA, 'contended');
      const a = monitor({ probe: { probeCooldownMs: 60_000 } });
      const b = monitor({ probe: { probeCooldownMs: 60_000 } });

      const [first, second] = await Promise.all([
        a.tick(),
        new Promise<Awaited<ReturnType<typeof b.tick>>>((resolve) => {
          setTimeout(() => void b.tick().then(resolve), 5);
        }),
      ]);
      expect(probes).toHaveLength(1);
      expect(first.probed + second.probed).toBe(1);
    });

    it('gives two replicas disjoint tenants', async () => {
      await createPanel(ownerA, tenantA, 'a');
      await createPanel(ownerB, tenantB, 'b');
      const discovery = new DrizzlePanelMonitorRepository(ctx.container.database.db);
      const [first, second] = await Promise.all([
        discovery.claimTenants(now, 1),
        discovery.claimTenants(now, 1),
      ]);
      // `FOR UPDATE SKIP LOCKED`: one takes a tenant, the other takes the
      // other or nothing — never the same one twice.
      const all = [...first, ...second];
      expect(new Set(all).size).toBe(all.length);
    });

    it('does not overlap its own ticks', async () => {
      await createPanel(ownerA, tenantA, 'slow');
      const m = monitor();
      const [a, b] = await Promise.all([m.tick(), m.tick()]);
      expect(a.considered + b.considered).toBe(1);
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
      // A `Promise.all` over the candidate set would open one socket and take
      // one pool connection per panel.
      expect(peak).toBeLessThanOrEqual(3);
    });

    it('leaves an operator the last token at capacity 1', async () => {
      // The invariant, at the capacity where it matters most. The old clamp
      // reduced a positive reserve to `capacity - 1`, which at capacity 1 is
      // zero — the protection switched off exactly where it was needed.
      const budget = { capacity: 1, refillPerMs: 0 };
      await createPanel(ownerA, tenantA, 'tiny-budget');

      const result = await tick(monitor({ budgetReserve: 1, probe: { probeBudget: budget } }));
      expect(result.probed).toBe(0);
      expect(probes).toHaveLength(0);

      // And the operator still has their probe.
      const operatorPanel = await createPanel(ownerA, tenantA, 'operator-turn');
      const { probed } = await service({ probeBudget: budget }).testConnection(
        tenantA,
        adminActorFor(ownerA),
        operatorPanel,
        { idempotencyKey: key() },
      );
      expect(probed).toBe(true);
    });

    it('leaves an operator headroom at capacity 2', async () => {
      const budget = { capacity: 2, refillPerMs: 0 };
      for (let i = 0; i < 4; i += 1) await createPanel(ownerA, tenantA, `two-${i}`);

      const result = await tick(monitor({ budgetReserve: 1, probe: { probeBudget: budget } }));
      // One for the monitor, one held back.
      expect(result.probed).toBe(1);

      const operatorPanel = await createPanel(ownerA, tenantA, 'operator-two');
      const { probed } = await service({ probeBudget: budget }).testConnection(
        tenantA,
        adminActorFor(ownerA),
        operatorPanel,
        { idempotencyKey: key() },
      );
      expect(probed).toBe(true);
    });

    it('holds the reserve at a normal capacity', async () => {
      const budget = { capacity: 4, refillPerMs: 0 };
      for (let i = 0; i < 6; i += 1) await createPanel(ownerA, tenantA, `hungry-${i}`);

      const result = await tick(monitor({ budgetReserve: 2, probe: { probeBudget: budget } }));
      expect(result.probed).toBe(2);

      const operatorPanel = await createPanel(ownerA, tenantA, 'operator-normal');
      const { probed } = await service({ probeBudget: budget }).testConnection(
        tenantA,
        adminActorFor(ownerA),
        operatorPanel,
        { idempotencyKey: key() },
      );
      expect(probed).toBe(true);
    });

    it('holds the reserve across racing replicas', async () => {
      const budget = { capacity: 3, refillPerMs: 0 };
      for (let i = 0; i < 6; i += 1) await createPanel(ownerA, tenantA, `raced-${i}`);

      // Two monitors working the same tenant at once. The floor is inside the
      // conditional write, so it holds however they interleave.
      await Promise.all([
        tick(monitor({ budgetReserve: 2, probe: { probeBudget: budget } })),
        tick(monitor({ budgetReserve: 2, probe: { probeBudget: budget } })),
      ]);
      expect(probes.length).toBeLessThanOrEqual(1);

      const operatorPanel = await createPanel(ownerA, tenantA, 'operator-raced');
      const { probed } = await service({ probeBudget: budget }).testConnection(
        tenantA,
        adminActorFor(ownerA),
        operatorPanel,
        { idempotencyKey: key() },
      );
      expect(probed).toBe(true);
    });

    it("does not spend another tenant's capacity", async () => {
      const budget = { capacity: 2, refillPerMs: 0 };
      for (let i = 0; i < 4; i += 1) await createPanel(ownerA, tenantA, `a-${i}`);
      await createPanel(ownerB, tenantB, 'b-0');

      await tick(monitor({ budgetReserve: 1, probe: { probeBudget: budget } }));
      const bRows = await ctx.container.database.db
        .select()
        .from(panelHealth)
        .where(eq(panelHealth.tenantId, tenantB.tenantId));
      expect(bRows).toHaveLength(1);
    });
  });

  // ===========================================================================
  // 29-35. Cadence, backoff and rollback compatibility
  // ===========================================================================

  describe('cadence', () => {
    it('re-probes a retryable failure sooner than a healthy panel', async () => {
      const panelId = await createPanel(ownerA, tenantA, 'timeout');
      outcome = TIMED_OUT;
      await tick();

      const schedule = await scheduleOf(panelId);
      expect(schedule!.consecutiveFailures).toBe(1);
      const wait = schedule!.nextEligibleAt.getTime() - now.getTime();
      expect(wait).toBeGreaterThanOrEqual(CADENCE.retryableIntervalMs);
      expect(wait).toBeLessThan(CADENCE.healthyIntervalMs);
    });

    it('backs a rejected credential off far beyond the healthy cadence', async () => {
      // The lockout rule at the storage level. 3X-UI v3.7.0 locks an
      // IP-and-username pair after enough failed logins, so a monitor that
      // resubmitted a rejected password every ten minutes would lock the
      // operator out of their own panel on Nexa's behalf.
      const panelId = await createPanel(ownerA, tenantA, 'rejected');
      outcome = REJECTED;
      await tick();

      const schedule = await scheduleOf(panelId);
      expect(schedule!.consecutiveFailures).toBe(1);
      expect(schedule!.nextEligibleAt.getTime() - now.getTime()).toBeGreaterThanOrEqual(
        MONITOR_NONRETRYABLE_FLOOR_MS,
      );

      now = new Date(now.getTime() + CADENCE.healthyIntervalMs * 3);
      for (let i = 0; i < 5; i += 1) await tick();
      expect(probes).toHaveLength(1);
    });

    it('doubles the backoff and then stops doubling', async () => {
      const panelId = await createPanel(ownerA, tenantA, 'streak');
      outcome = TIMED_OUT;

      const waits: number[] = [];
      for (let i = 0; i < 6; i += 1) {
        now = new Date(
          Math.max(now.getTime() + 1, (await scheduleOf(panelId))!.nextEligibleAt.getTime()),
        );
        expect((await tick()).probed).toBe(1);
        const schedule = await scheduleOf(panelId);
        expect(schedule!.consecutiveFailures).toBe(i + 1);
        waits.push(schedule!.nextEligibleAt.getTime() - now.getTime());
      }
      expect(waits[1]).toBeGreaterThan(waits[0]!);
      expect(waits[2]).toBeGreaterThan(waits[1]!);
      // Bounded: a panel an operator repaired must not be abandoned to a
      // backoff measured in months.
      expect(waits[4]).toBe(waits[3]);
      expect(waits[5]).toBe(waits[4]);
    });

    it('resets the streak on the first success', async () => {
      const panelId = await createPanel(ownerA, tenantA, 'recovering');
      outcome = TIMED_OUT;
      await tick();
      now = new Date((await scheduleOf(panelId))!.nextEligibleAt.getTime());
      await tick();
      expect((await scheduleOf(panelId))!.consecutiveFailures).toBe(2);

      outcome = HEALTHY;
      now = new Date((await scheduleOf(panelId))!.nextEligibleAt.getTime());
      await tick();
      const healed = await scheduleOf(panelId);
      expect(healed!.consecutiveFailures).toBe(0);
      expect(healed!.nextEligibleAt.getTime() - now.getTime()).toBeGreaterThanOrEqual(
        CADENCE.healthyIntervalMs,
      );
    });

    it('does not inherit a stale streak an older release left behind', async () => {
      // The rollback-and-forward case, emulated exactly: the new release builds
      // a streak, an OLD release completes a successful manual probe — writing
      // only the health row, because it does not know the scheduler table — and
      // then the new release probes again and fails.
      const panelId = await createPanel(ownerA, tenantA, 'rolled-back');
      outcome = TIMED_OUT;
      for (let i = 0; i < 4; i += 1) {
        now = new Date(
          Math.max(now.getTime() + 1, (await scheduleOf(panelId))!.nextEligibleAt.getTime()),
        );
        await tick();
      }
      expect((await scheduleOf(panelId))!.consecutiveFailures).toBe(4);
      const backedOff = (await scheduleOf(panelId))!.nextEligibleAt.getTime() - now.getTime();

      // The old binary: health only, scheduler table untouched.
      now = new Date(now.getTime() + 60_000);
      await ctx.container.database.db
        .update(panelHealth)
        .set({
          state: 'HEALTHY',
          checkedAt: now,
          failure: null,
          statusCode: null,
          latencyMs: 5,
          lastHealthyAt: now,
        })
        .where(eq(panelHealth.panelId, panelId));
      expect((await scheduleOf(panelId))!.consecutiveFailures).toBe(4);

      // Forward again. The next failure starts a NEW streak, because the stored
      // health says the panel worked since — truth beats bookkeeping.
      now = new Date(now.getTime() + 60_000);
      await ctx.container.database.db
        .update(panelMonitorSchedule)
        .set({ nextEligibleAt: now })
        .where(eq(panelMonitorSchedule.panelId, panelId));
      outcome = TIMED_OUT;
      await tick();

      const after = await scheduleOf(panelId);
      expect(after!.consecutiveFailures).toBe(1);
      expect(after!.nextEligibleAt.getTime() - now.getTime()).toBeLessThan(backedOff);
    });
  });

  // ===========================================================================
  // 36-38. Races: configuration changed, stale writes, phantom events
  // ===========================================================================

  describe('races', () => {
    it('discards a result that describes a configuration the operator replaced', async () => {
      const panelId = await createPanel(ownerA, tenantA, 'raced-config');
      const gate: { started?: () => void; release?: () => void } = {};
      const inFlight = new Promise<void>((resolve) => {
        gate.release = resolve;
      });
      const probeStarted = new Promise<void>((resolve) => {
        gate.started = resolve;
      });

      const m = monitor({
        probe: {
          adapters: (type: ProviderType) => ({
            ...providerAdapter(type),
            probe: async (target) => {
              probes.push(target.baseUrl);
              gate.started?.();
              await inFlight;
              return REJECTED;
            },
          }),
        },
      });
      const running = m.tick();
      // Wait for the probe to have actually started, rather than guessing with
      // a timer — a timer makes this test pass or fail on machine speed.
      await probeStarted;
      now = new Date(now.getTime() + 1_000);
      await service().update(tenantA, adminActorFor(ownerA), panelId, {
        baseUrl: 'https://panel-elsewhere.example.test',
        idempotencyKey: key(),
      });
      gate.release?.();

      const result = await running;
      expect(probes).toHaveLength(1);
      expect(result.failed).toBe(1);
      // Nothing stored: the answer described an address that is no longer this
      // panel's.
      expect(await healthOf(panelId)).toBeUndefined();
    });

    it('does not let a slow result overwrite a newer one', async () => {
      const panelId = await createPanel(ownerA, tenantA, 'out-of-order');
      await tick();
      const fresh = await healthOf(panelId);
      expect(fresh?.state).toBe('HEALTHY');

      const repository = new DrizzlePanelRepository(ctx.container.database.db);
      const outcomeOfWrite = await ctx.container.uow.run(tenantA, (tx) =>
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
          },
          tx,
        ),
      );

      expect(outcomeOfWrite).toBe('STALE_IGNORED');
      const after = await healthOf(panelId);
      expect(after?.state).toBe('HEALTHY');
      expect(after?.checkedAt.getTime()).toBe(fresh?.checkedAt.getTime());
    });

    it('announces nothing for a result the storage discarded', async () => {
      // The phantom-event race. A slow AUTH_FAILED probe finishes after a newer
      // HEALTHY one of the SAME configuration: the storage refuses the stale
      // write, and announcing its transition anyway would tell an operator
      // their panel is broken while the row in front of them says healthy.
      const panelId = await createPanel(ownerA, tenantA, 'phantom');
      await tick();
      expect((await healthOf(panelId))?.state).toBe('HEALTHY');

      // A probe stamped EARLIER than the stored row, driven through the whole
      // monitor path so the announcement logic runs.
      const stale = new Date(now.getTime() - 60_000);
      const m = monitor({
        probe: {
          clock: { now: () => stale },
          probeCooldownMs: 0,
          adapters: (type: ProviderType) => ({
            ...providerAdapter(type),
            probe: async (target) => {
              probes.push(target.baseUrl);
              return REJECTED;
            },
          }),
        },
        discovery: {
          claimTenants: async () => [tenantA.tenantId],
          dueForTenants: async () => [{ tenantId: tenantA.tenantId, panelId }],
          refreshTenantBounds: async () => {},
        },
      });
      await m.tick();

      expect((await healthOf(panelId))?.state).toBe('HEALTHY');
      expect(await eventCodes(tenantA.tenantId)).toEqual([]);
      const audits = await ctx.container.database.db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.action, 'panel.monitor.probe'));
      expect(audits).toHaveLength(0);
    });
  });

  // ===========================================================================
  // 39-44. Transitions: exact conditions, no spam, obsolete conditions resolved
  // ===========================================================================

  describe('transition events', () => {
    /** Drives one probe with a given outcome, at a time the schedule allows. */
    async function probeWith(panelId: string, next: ProviderProbeOutcome): Promise<void> {
      outcome = next;
      const schedule = await scheduleOf(panelId);
      if (schedule) {
        now = new Date(Math.max(now.getTime() + 1, schedule.nextEligibleAt.getTime()));
      }
      const result = await tick();
      expect(result.probed).toBe(1);
    }

    /**
     * The panel PROBLEMS an operator would still see as unresolved.
     *
     * Severity-filtered on purpose: `panel.health.recovered` is an INFO record
     * that something got better, not a condition, so it is never resolved and
     * counting it would make "nothing is wrong" impossible to express.
     */
    const openConditions = async (tenantId: string) =>
      (
        await ctx.container.database.db
          .select({
            code: operationalEvents.code,
            severity: operationalEvents.severity,
            resolvedAt: operationalEvents.resolvedAt,
          })
          .from(operationalEvents)
          .where(eq(operationalEvents.tenantId, tenantId))
      )
        .filter((row) => row.resolvedAt === null && row.severity !== 'INFO')
        .map((row) => row.code)
        .sort();

    it('announces HEALTHY to UNREACHABLE', async () => {
      const panelId = await createPanel(ownerA, tenantA, 'to-unreachable');
      await probeWith(panelId, HEALTHY);
      expect(await eventCodes(tenantA.tenantId)).toEqual([]);
      await probeWith(panelId, TIMED_OUT);
      expect(await openConditions(tenantA.tenantId)).toEqual(['panel.health.unreachable']);
    });

    it('announces UNREACHABLE to AUTH_FAILED as a change of remedy', async () => {
      // The transition the old broad "FAILED" class swallowed entirely. "Look
      // at the host" and "look at the credential" are not two shades of one
      // problem, and an operator told nothing would keep looking at a network
      // that is fine.
      const panelId = await createPanel(ownerA, tenantA, 'unreachable-then-auth');
      await probeWith(panelId, TIMED_OUT);
      expect(await openConditions(tenantA.tenantId)).toEqual(['panel.health.unreachable']);

      await probeWith(panelId, REJECTED);
      // The new condition is open and the old one is RESOLVED, not left
      // standing beside it.
      expect(await openConditions(tenantA.tenantId)).toEqual(['panel.health.auth_failed']);
    });

    it('announces AUTH_FAILED to UNREACHABLE', async () => {
      const panelId = await createPanel(ownerA, tenantA, 'auth-then-unreachable');
      await probeWith(panelId, REJECTED);
      await probeWith(panelId, TIMED_OUT);
      expect(await openConditions(tenantA.tenantId)).toEqual(['panel.health.unreachable']);
    });

    it('announces DEGRADED to AUTH_FAILED', async () => {
      const panelId = await createPanel(ownerA, tenantA, 'degraded-then-auth');
      await probeWith(panelId, DEGRADED);
      expect(await openConditions(tenantA.tenantId)).toEqual(['panel.health.degraded']);
      await probeWith(panelId, REJECTED);
      expect(await openConditions(tenantA.tenantId)).toEqual(['panel.health.auth_failed']);
    });

    it('distinguishes a second factor from a rejected password', async () => {
      // Same health state, different operator job: one is "replace the
      // credentials", the other is "this panel wants a code Nexa cannot
      // produce, configure an API token".
      const panelId = await createPanel(ownerA, tenantA, 'needs-2fa');
      await probeWith(panelId, REJECTED);
      await probeWith(panelId, NEEDS_INTERACTION);
      expect(await openConditions(tenantA.tenantId)).toEqual([
        'panel.health.auth_interaction_required',
      ]);
    });

    it('announces recovery and closes the open condition', async () => {
      const panelId = await createPanel(ownerA, tenantA, 'recovers');
      await probeWith(panelId, TIMED_OUT);
      await probeWith(panelId, HEALTHY);
      expect(await openConditions(tenantA.tenantId)).toEqual([]);
      expect((await eventCodes(tenantA.tenantId)).map((e) => e.code)).toContain(
        'panel.health.recovered',
      );
    });

    it('says nothing while a panel stays healthy', async () => {
      const panelId = await createPanel(ownerA, tenantA, 'quiet');
      for (let i = 0; i < 3; i += 1) await probeWith(panelId, HEALTHY);
      expect(await eventCodes(tenantA.tenantId)).toEqual([]);
    });

    it('does not repeat an unchanged condition', async () => {
      const panelId = await createPanel(ownerA, tenantA, 'flapping');
      for (let i = 0; i < 4; i += 1) await probeWith(panelId, TIMED_OUT);
      const events = await eventCodes(tenantA.tenantId);
      expect(events.map((e) => e.code)).toEqual(['panel.health.unreachable']);
      // One row, whose counter says how often — not four rows.
      expect(events[0]?.count).toBe(1);
    });

    it('keeps at most one panel-health condition open per panel', async () => {
      const panelId = await createPanel(ownerA, tenantA, 'never-two-open');
      for (const next of [TIMED_OUT, REJECTED, DEGRADED, NEEDS_INTERACTION, HEALTHY, TIMED_OUT]) {
        await probeWith(panelId, next);
        expect((await openConditions(tenantA.tenantId)).length).toBeLessThanOrEqual(1);
      }
    });

    it('writes an audit row on a transition and not on a steady state', async () => {
      const panelId = await createPanel(ownerA, tenantA, 'steady');
      for (let i = 0; i < 3; i += 1) await probeWith(panelId, HEALTHY);
      const rows = await ctx.container.database.db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.action, 'panel.monitor.probe'));
      expect(rows).toHaveLength(0);

      await probeWith(panelId, TIMED_OUT);
      const after = await ctx.container.database.db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.action, 'panel.monitor.probe'));
      expect(after).toHaveLength(1);
      expect(after[0]?.actorType).toBe('SYSTEM_JOB');
      expect(after[0]?.actorId).toBe(PANEL_MONITOR_JOB_ID);
    });

    it('keeps one tenant events out of another', async () => {
      await createPanel(ownerA, tenantA, 'a-fails');
      await createPanel(ownerB, tenantB, 'b-fails');
      outcome = TIMED_OUT;
      await tick();

      const all = await ctx.container.database.db.select().from(operationalEvents);
      expect(all).toHaveLength(2);
      expect(new Set(all.map((e) => e.tenantId)).size).toBe(2);
    });

    it('puts no credential or provider text in an event or an audit row', async () => {
      const panelId = await createPanel(ownerA, tenantA, 'no-leak');
      outcome = REJECTED;
      await tick();

      const events = await ctx.container.database.db.select().from(operationalEvents);
      const audits = await ctx.container.database.db.select().from(auditLogs);
      const serialized = JSON.stringify({ events, audits, health: await healthOf(panelId) });
      expect(serialized).not.toContain(PASSWORD);
      expect(serialized).not.toContain(USERNAME);
    });
  });

  // ===========================================================================
  // 45-51. Process health: truthful, progress-based, no startup grace
  // ===========================================================================

  describe('process health', () => {
    /** A monitor whose discovery always throws, wired to the real everything else. */
    function brokenDiscovery(): PanelMonitorService {
      return monitor({
        discovery: {
          claimTenants: async () => {
            throw new Error('the scheduler query is broken');
          },
          dueForTenants: async () => [],
          refreshTenantBounds: async () => {},
        },
      });
    }

    it('is not healthy before its first successful discovery', async () => {
      // No startup grace, deliberately. A monitor that has never succeeded has
      // never done its job, and reporting it healthy for the first few minutes
      // is how a release whose scheduler is broken gets accepted.
      const m = monitor();
      expect(m.iterationIsFresh(now.getTime())).toBe(false);
    });

    it('stays unhealthy for ever when discovery always throws', async () => {
      // `SELECT 1` would succeed here — the database is fine. What is broken is
      // the scheduler, and the heartbeat has to be able to tell those apart.
      const m = brokenDiscovery();
      for (let i = 0; i < 5; i += 1) {
        await m.tick();
        expect(m.iterationIsFresh(now.getTime())).toBe(false);
        now = new Date(now.getTime() + 30_000);
      }
    });

    it('is healthy after a successful discovery that found nothing', async () => {
      // An installation with no due panels is a working installation.
      const m = monitor();
      const result = await m.tick();
      expect(result.considered).toBe(0);
      expect(m.iterationIsFresh(now.getTime())).toBe(true);
    });

    it('stays healthy through a slow but progressing batch', async () => {
      // A bounded batch of slow providers can outlast several intervals. A
      // monitor working through it is not broken, so each finished panel counts
      // as progress — the alternative is a false negative that restarts a
      // healthy container mid-sweep.
      for (let i = 0; i < 4; i += 1) await createPanel(ownerA, tenantA, `slow-${i}`);
      let finished = 0;
      const m = monitor({
        concurrency: 1,
        probe: {
          adapters: (type: ProviderType) => ({
            ...providerAdapter(type),
            probe: async (target) => {
              probes.push(target.baseUrl);
              // Each probe takes longer than the whole freshness window would
              // allow if only completed TICKS counted.
              now = new Date(now.getTime() + 30_000 * 4);
              finished += 1;
              return HEALTHY;
            },
          }),
        },
      });
      const running = m.tick();
      await running;
      expect(finished).toBe(4);
      // Still fresh at the end, because progress kept being made.
      expect(m.iterationIsFresh(now.getTime())).toBe(true);
    });

    it('goes stale when the loop stops getting anywhere', async () => {
      const m = monitor();
      await m.tick();
      expect(m.iterationIsFresh(now.getTime())).toBe(true);
      // Three intervals of silence and it is not alive any more.
      expect(m.iterationIsFresh(now.getTime() + 30_000 * 3)).toBe(true);
      expect(m.iterationIsFresh(now.getTime() + 30_000 * 3 + 1)).toBe(false);
    });

    it('stops cleanly and reports itself not alive afterwards', async () => {
      await createPanel(ownerA, tenantA, 'shutdown');
      const m = monitor();
      await m.tick();
      expect(m.iterationIsFresh(now.getTime())).toBe(true);
      await m.stop();
      // A draining monitor must not be reported as alive.
      expect(m.iterationIsFresh(now.getTime())).toBe(false);
    });
  });

  // ===========================================================================
  // 54-61. Both providers, through the same core, with no branching
  // ===========================================================================

  describe('providers', () => {
    async function createSanaei(name: string, credentials: Record<string, string>) {
      const { view } = await service().create(tenantA, adminActorFor(ownerA), {
        name,
        providerType: 'sanaei',
        baseUrl: 'https://xui.example.test/mypath',
        credentials,
        idempotencyKey: key(),
      });
      return view.panel.id;
    }

    it('monitors a Marzban panel that answers', async () => {
      const panelId = await createPanel(ownerA, tenantA, 'marzban-ok');
      expect((await tick()).probed).toBe(1);
      expect((await healthOf(panelId))?.state).toBe('HEALTHY');
    });

    it('records a Marzban authentication failure as AUTH_FAILED', async () => {
      const panelId = await createPanel(ownerA, tenantA, 'marzban-auth');
      outcome = REJECTED;
      await tick();
      const health = await healthOf(panelId);
      expect(health?.state).toBe('AUTH_FAILED');
      expect(health?.failure).toBe('AUTHENTICATION_FAILED');
    });

    it('records a Marzban unreachable host as UNREACHABLE', async () => {
      const panelId = await createPanel(ownerA, tenantA, 'marzban-down');
      outcome = { ok: false, failure: 'UNREACHABLE', status: null };
      await tick();
      expect((await healthOf(panelId))?.state).toBe('UNREACHABLE');
    });

    it('monitors a Sanaei panel authenticated by Bearer token', async () => {
      // Credential resolution happens once, in the shared core, from the
      // descriptor's declared shape — so a provider whose credential is an
      // opaque token needs no monitor change at all.
      const panelId = await createSanaei('sanaei-token', { apiToken: 'monitor-token-4Q' });
      expect((await tick()).probed).toBe(1);
      expect((await healthOf(panelId))?.state).toBe('HEALTHY');
    });

    it('monitors a Sanaei panel authenticated by session login', async () => {
      const panelId = await createSanaei('sanaei-session', {
        username: USERNAME,
        password: PASSWORD,
      });
      expect((await tick()).probed).toBe(1);
      expect((await healthOf(panelId))?.state).toBe('HEALTHY');
    });

    it('records a Sanaei authentication failure', async () => {
      const panelId = await createSanaei('sanaei-auth', { apiToken: 'wrong-token' });
      outcome = REJECTED;
      await tick();
      expect((await healthOf(panelId))?.state).toBe('AUTH_FAILED');
    });

    it('reports a Sanaei panel wanting a second factor as its own condition', async () => {
      // Nexa stores no TOTP seed and generates no code. The remedy is an API
      // token, and the failure kind — and the event — say so rather than
      // sending an operator to retype a password that is probably correct.
      const panelId = await createSanaei('sanaei-2fa', {
        username: USERNAME,
        password: PASSWORD,
      });
      outcome = NEEDS_INTERACTION;
      await tick();
      const health = await healthOf(panelId);
      expect(health?.state).toBe('AUTH_FAILED');
      expect(health?.failure).toBe('AUTHENTICATION_REQUIRES_INTERACTION');
      expect((await eventCodes(tenantA.tenantId)).map((e) => e.code)).toEqual([
        'panel.health.auth_interaction_required',
      ]);
    });

    it('stores no credential, cookie or provider text in any monitor state', async () => {
      const panelId = await createSanaei('sanaei-secrets', { apiToken: 'tok-secret-zz9' });
      outcome = REJECTED;
      await tick();
      const serialized = JSON.stringify({
        health: await healthOf(panelId),
        schedule: await scheduleOf(panelId),
        rotation: await rotationOf(tenantA.tenantId),
      });
      expect(serialized).not.toContain('tok-secret-zz9');
      expect(serialized).not.toContain(PASSWORD);
      expect(serialized).not.toContain(USERNAME);
    });
  });
});
