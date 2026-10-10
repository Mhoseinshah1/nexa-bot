import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  JOB_LOOP_RECOVERED_CODE,
  JOB_LOOP_STALLED_CODE,
  MAX_REQUESTS_PER_PROBE,
  type OperationalEventInput,
  type TenantContext,
} from '@nexa/contracts';
import {
  LoopStallReporter,
  loopStallConditionKey,
  stalledAfterGrace,
} from '../../apps/api/src/modules/platform/opslog/application/loop-stall-reporter';
import {
  PROVISIONER_LANES,
  ProvisionerLoop,
  STALE_TICK_MULTIPLE,
} from '../../apps/api/src/modules/commerce/provisioning/application/provisioner-loop';
import { operationalEventDetails } from '../../apps/api/src/modules/control/notifications/application/event-details';
import type { ProvisionerService } from '../../apps/api/src/modules/commerce/provisioning/application/provisioner.service';
import type { DeliveryService } from '../../apps/api/src/modules/commerce/provisioning/application/delivery.service';
import type { OperationOutcomeAnnouncer } from '../../apps/api/src/modules/commerce/messaging/application/operation-outcome-announcer';
import {
  RecoveryExecutor,
  type RecoveryExecutorDeps,
} from '../../apps/api/src/modules/platform/recovery/application/recovery-executor';
import { configSchema } from '../../apps/api/src/infrastructure/config/config.schema';

/**
 * FIX-03 (batch 2026-10-10): the provisioner, monitor and recovery roles report a stalled
 * loop to the operations log, as the worker has since FIX-05. Before this, a provisioner
 * whose refund lane threw on every tick logged an error line and went stale in its own
 * container's health check — and nothing reached an operator.
 */

const scope = { tenantId: 'tenant-1', botInstanceId: null } as unknown as TenantContext;
const TICK_MS = 5_000;
const WINDOW = TICK_MS * STALE_TICK_MULTIPLE;

function provisionerWith(failing: Set<string>, clock: { now: number }) {
  const lane = (name: string) => ({
    settleDue: async () => {
      if (failing.has(name)) throw new Error(`${name} row failed`);
      return 0;
    },
  });
  const executor = {
    runOnce: async () => {
      if (failing.has('drain')) throw new Error('drain failed');
      return { kind: 'IDLE' };
    },
  } as unknown as ProvisionerService;
  return new ProvisionerLoop(
    executor,
    { deliverDue: async () => undefined } as unknown as DeliveryService,
    {
      announce: async () => undefined,
      announceDue: async () => undefined,
    } as unknown as OperationOutcomeAnnouncer,
    {
      scope: () => scope,
      cashback: lane('cashback'),
      referrals: lane('referrals'),
      serviceRefunds: lane('serviceRefunds'),
      tickMs: TICK_MS,
      now: () => clock.now,
      logger: { info: () => undefined, error: () => undefined },
    },
  );
}

function reporterFor(role: 'provisioner' | 'monitor' | 'recovery', clock: { now: number }) {
  const events: OperationalEventInput[] = [];
  const reporter = new LoopStallReporter({
    recorder: {
      record: async (_scope: unknown, event: OperationalEventInput) => {
        events.push(event);
        return {} as never;
      },
    },
    conditions: { openConditions: async () => [] },
    scope: () => scope,
    clock: { now: () => new Date(clock.now) },
    logger: { warn: vi.fn() },
    role,
  });
  return { reporter, events };
}

describe('a stalled provisioner lane is a condition in the operations log', () => {
  it('opens job.loop_stalled naming the lane and the role, and closes it when the lane recovers', async () => {
    const clock = { now: 1_000_000 };
    const failing = new Set(['serviceRefunds']);
    const loop = provisionerWith(failing, clock);
    const { reporter, events } = reporterFor('provisioner', clock);

    await loop.tick();
    // Inside the window: nothing is stalled yet, and nothing is said.
    await reporter.observe(loop.laneStatuses(clock.now));
    expect(events).toEqual([]);

    clock.now += WINDOW + 1;
    await loop.tick();
    const statuses = loop.laneStatuses(clock.now);
    expect(statuses.filter((lane) => lane.stalled).map((lane) => lane.name)).toEqual([
      'provisioner-service-refunds',
    ]);
    await reporter.observe(statuses);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      code: JOB_LOOP_STALLED_CODE,
      severity: 'ERROR',
      dedupeKey: loopStallConditionKey('provisioner-service-refunds'),
      message: 'Provisioner loop "provisioner-service-refunds" has stopped making progress.',
      context: { kind: 'provisioner-service-refunds', processRole: 'provisioner' },
    });
    // The group message carries both names, through the allow-list.
    const details = operationalEventDetails(events[0]?.context);
    expect(details).toContain('kind: provisioner-service-refunds');
    expect(details).toContain('processRole: provisioner');

    failing.clear();
    await loop.tick();
    await reporter.observe(loop.laneStatuses(clock.now));
    expect(events.map((event) => event.code)).toEqual([
      JOB_LOOP_STALLED_CODE,
      JOB_LOOP_RECOVERED_CODE,
    ]);
    expect(events[1]).toMatchObject({
      recoversCode: JOB_LOOP_STALLED_CODE,
      recoversDedupeKey: loopStallConditionKey('provisioner-service-refunds'),
    });
  });

  it('names the drain itself when the provisioning drain is what fails', async () => {
    const clock = { now: 1_000_000 };
    const loop = provisionerWith(new Set(['drain']), clock);
    await loop.tick();
    clock.now += WINDOW + 1;
    await loop.tick();
    expect(
      loop
        .laneStatuses(clock.now)
        .filter((lane) => lane.stalled)
        .map((lane) => lane.name),
    ).toEqual(['provisioner']);
    // Readiness is unchanged: any failure in a tick still costs its progress.
    expect(loop.iterationIsFresh(clock.now)).toBe(false);
  });

  it('reports nothing stalled for a loop never started (the provisioner disabled)', () => {
    const loop = provisionerWith(new Set(), { now: 1 });
    expect(loop.laneStatuses(10 * WINDOW)).toEqual(
      PROVISIONER_LANES.map((name) => ({ name, stalled: false })),
    );
  });

  it('prefixes every lane, so none shares a dedupe key with a worker loop', () => {
    const worker = readFileSync(join(__dirname, '../../apps/api/src/main.worker.ts'), 'utf8');
    const workerLoops = [...worker.matchAll(/\[\s*'([a-z-]+)',\s*(?:true|config\.)/g)].map(
      (match) => match[1],
    );
    expect(workerLoops.length).toBeGreaterThan(10);
    for (const lane of PROVISIONER_LANES) {
      expect(lane.startsWith('provisioner')).toBe(true);
      expect(workerLoops).not.toContain(lane);
    }
  });
});

describe('stalledAfterGrace: no false alarm on the first heartbeat after a restart', () => {
  it('is stalled only once the grace since start has passed without progress', () => {
    const base = { startedAtMs: 0, graceMs: 100 };
    expect(stalledAfterGrace({ ...base, fresh: false, nowMs: 100 })).toBeNull();
    expect(stalledAfterGrace({ ...base, fresh: false, nowMs: 101 })).toBe(true);
    expect(stalledAfterGrace({ ...base, fresh: true, nowMs: 10_000 })).toBe(false);
  });

  it('never calls a loop that was not started stalled', () => {
    expect(stalledAfterGrace({ fresh: false, startedAtMs: null, nowMs: 1e12, graceMs: 1 })).toBe(
      false,
    );
  });

  it('names the monitor and the recovery executor as their own roles', async () => {
    for (const role of ['monitor', 'recovery'] as const) {
      const clock = { now: 0 };
      const { reporter, events } = reporterFor(role, clock);
      await reporter.observe([{ name: `${role}-loop`, stalled: true }]);
      expect(events[0]?.context).toMatchObject({ processRole: role });
      expect(events[0]?.message).toMatch(/^(Monitor|Recovery) loop /);
    }
  });
});

describe('every background role reports its stalled loops', () => {
  const src = join(__dirname, '../../apps/api/src');
  /**
   * Read from disk rather than listed: a role added later that starts a heartbeat and does
   * not report is the defect this batch closed for three roles. The assistant is the one
   * stated exception — its stall is raised from the worker, by the watch that sees due AI
   * work unclaimed (`support.assistant.stalled`), which a dead assistant cannot suppress.
   */
  const roles = readdirSync(src)
    .filter((name) => /^main\.\w+\.ts$/.test(name))
    .map((name) => [name, readFileSync(join(src, name), 'utf8')] as const)
    .filter(([, source]) => source.includes('startHeartbeat('));

  it('finds the roles, so the rule below cannot pass vacuously', () => {
    expect(roles.map(([name]) => name).sort()).toEqual([
      'main.assistant.ts',
      'main.monitor.ts',
      'main.provisioner.ts',
      'main.recovery.ts',
      'main.worker.ts',
    ]);
  });

  it('builds a reporter for its own role and feeds it from the heartbeat', () => {
    for (const [name, source] of roles) {
      if (name === 'main.assistant.ts') continue;
      const role = /^main\.(\w+)\.ts$/.exec(name)?.[1];
      expect(source, name).toContain(`loopStallReporterFor(container, '${role}')`);
      expect(source, name).toMatch(/void loopStalls\.observe\(/);
    }
  });
});

/**
 * Codex P2 on #258 (A3): inside the startup grace a loop has no verdict. Reading that as
 * FRESH resolved a stall the previous life left open before this process had made a single
 * successful pass — and the condition reopened the moment the grace ran out.
 */
describe('the startup grace is UNKNOWN, never fresh', () => {
  function inheritedReporter(
    role: 'provisioner' | 'monitor',
    openKey: string,
    clock: { now: number },
  ) {
    const events: OperationalEventInput[] = [];
    const reporter = new LoopStallReporter({
      recorder: {
        record: async (_scope: unknown, event: OperationalEventInput) => {
          events.push(event);
          return {} as never;
        },
      },
      conditions: {
        openConditions: async (_scope: TenantContext, keys: readonly string[]) =>
          keys.includes(loopStallConditionKey(openKey)) ? [JOB_LOOP_STALLED_CODE] : [],
      },
      scope: () => scope,
      clock: { now: () => new Date(clock.now) },
      logger: { warn: vi.fn() },
      role,
    });
    return { reporter, events };
  }

  it('stalledAfterGrace answers null inside the grace for a loop with no progress yet', () => {
    expect(stalledAfterGrace({ fresh: false, startedAtMs: 0, nowMs: 50, graceMs: 100 })).toBeNull();
  });

  it('a restarted monitor keeps an inherited stall open until its first successful pass', async () => {
    const clock = { now: 1_000_000 };
    const { reporter, events } = inheritedReporter('monitor', 'panel-monitor', clock);
    const startedAtMs = clock.now;
    const status = (fresh: boolean) => [
      {
        name: 'panel-monitor',
        stalled: stalledAfterGrace({ fresh, startedAtMs, nowMs: clock.now, graceMs: 3_000 }),
      },
    ];
    // Restarted, inside the grace, no pass yet: nothing recorded, nothing resolved.
    await reporter.observe(status(false));
    clock.now += 1_000;
    await reporter.observe(status(false));
    expect(events).toEqual([]);
    // The first successful pass is what resolves it.
    await reporter.observe(status(true));
    expect(events.map((event) => [event.code, event.recoversDedupeKey])).toEqual([
      [JOB_LOOP_RECOVERED_CODE, loopStallConditionKey('panel-monitor')],
    ]);
  });

  it('a restarted provisioner lane keeps an inherited stall open until the lane succeeds', async () => {
    const clock = { now: 1_000_000 };
    const failing = new Set(['cashback']);
    const loop = provisionerWith(failing, clock);
    const { reporter, events } = inheritedReporter('provisioner', 'provisioner-cashback', clock);
    await loop.tick();
    const cashback = () =>
      loop.laneStatuses(clock.now).find((lane) => lane.name === 'provisioner-cashback');
    expect(cashback()?.stalled).toBeNull();
    await reporter.observe(loop.laneStatuses(clock.now));
    expect(events).toEqual([]);
    failing.clear();
    await loop.tick();
    expect(cashback()?.stalled).toBe(false);
    await reporter.observe(loop.laneStatuses(clock.now));
    expect(events.map((event) => [event.code, event.recoversDedupeKey])).toEqual([
      [JOB_LOOP_RECOVERED_CODE, loopStallConditionKey('provisioner-cashback')],
    ]);
  });
});

/**
 * Codex P2 on #258 (A2): at the supported extremes — PANEL_HTTP_TIMEOUT_MS=120000 and
 * PROVISIONER_TICK_MS=1000 — one ordinary provider call in flight outlasts the tick window
 * many times over. It is not a stall until it outlasts its own deadline.
 */
describe('a provider call in flight within its deadline is not a stalled provisioner', () => {
  const TICK = 1_000;
  const HTTP_TIMEOUT = 120_000;
  const ALLOWANCE = HTTP_TIMEOUT * MAX_REQUESTS_PER_PROBE;

  it('accepts those settings, so the case is reachable', () => {
    const result = configSchema.safeParse({
      PANEL_HTTP_TIMEOUT_MS: String(HTTP_TIMEOUT),
      PROVISIONER_TICK_MS: String(TICK),
      // The monitor's own cadence rule asks for this at a 120 s timeout; it is unrelated.
      PANEL_MONITOR_HEALTHY_INTERVAL_MS: String(HTTP_TIMEOUT * MAX_REQUESTS_PER_PROBE),
    });
    const issues = result.success ? [] : result.error.issues;
    const aboutThese = issues.filter((issue) =>
      /PANEL_HTTP_TIMEOUT_MS|PROVISIONER_TICK_MS/.test(`${issue.path.join('.')} ${issue.message}`),
    );
    expect(aboutThese).toEqual([]);
  });

  it('the container gives the loop the panel HTTP timeout as its in-flight allowance', () => {
    const container = readFileSync(join(__dirname, '../../apps/api/src/container.ts'), 'utf8');
    expect(container).toMatch(
      /inFlightAllowanceMs:\s*config\.PANEL_HTTP_TIMEOUT_MS \* \(1 \+ PANEL_HTTP_RETRIES\) \* MAX_REQUESTS_PER_PROBE/,
    );
  });

  it('reports nothing while the call is inside its deadline, and a stall once it is past it', async () => {
    const clock = { now: 1_000_000 };
    let release: (() => void) | null = null;
    let hang = false;
    const executor = {
      runOnce: async () => {
        if (hang) await new Promise<void>((resolve) => (release = resolve));
        return { kind: 'IDLE' };
      },
    } as unknown as ProvisionerService;
    const ok = { settleDue: async () => 0 };
    const loop = new ProvisionerLoop(
      executor,
      { deliverDue: async () => undefined } as unknown as DeliveryService,
      {
        announce: async () => undefined,
        announceDue: async () => undefined,
      } as unknown as OperationOutcomeAnnouncer,
      {
        scope: () => scope,
        cashback: ok,
        referrals: ok,
        serviceRefunds: ok,
        tickMs: TICK,
        inFlightAllowanceMs: ALLOWANCE,
        now: () => clock.now,
        logger: { info: () => undefined, error: () => undefined },
      },
    );
    const { reporter, events } = reporterFor('provisioner', clock);
    await loop.tick();
    expect(loop.laneStatuses(clock.now).every((lane) => lane.stalled === false)).toBe(true);

    hang = true;
    const inFlight = loop.tick();
    // 100 s into a call allowed 120 s: every lane's last success is long past the 3 s
    // window, and none of them is stalled.
    clock.now += 100_000;
    expect(loop.laneStatuses(clock.now).some((lane) => lane.stalled === true)).toBe(false);
    await reporter.observe(loop.laneStatuses(clock.now));
    expect(events).toEqual([]);

    // Past the call's own deadline and the window: that is a hang.
    clock.now += TICK * STALE_TICK_MULTIPLE + ALLOWANCE;
    expect(loop.laneStatuses(clock.now).every((lane) => lane.stalled === true)).toBe(true);

    hang = false;
    (release as (() => void) | null)?.();
    await inFlight;
  });
});

/**
 * Codex P2 on #258 (A1): the recovery executor's long-running exemption belongs to a
 * CLAIMED recovery. A tick hung before any claim — the cutover journal, the reclaim, the
 * claim queries — was reported fresh for ever while the heartbeat's `SELECT 1` succeeded.
 */
describe('the recovery executor is fresh during a run, not during any tick', () => {
  const TICK = 15_000;

  function executorWith(input: {
    journalPending: () => Promise<string[]>;
    claimOwn: () => Promise<unknown>;
    readiness: () => Promise<{ degraded: boolean }>;
    clock: { now: number };
  }) {
    const requests = {
      reclaimStale: async () => [],
      claimOwn: input.claimOwn,
      claimConfirmed: async () => null,
      heartbeat: async () => undefined,
      byIdUnscoped: async () => null,
      transition: async () => true,
    };
    return new RecoveryExecutor({
      requests,
      journal: { pending: input.journalPending },
      readiness: input.readiness,
      clock: { now: () => new Date(input.clock.now) },
      opsLog: { record: async () => ({}) as never },
      scope: () => scope,
      leaseOwner: 'recovery:this-host',
      tickIntervalMs: TICK,
      resumeReadiness: { attempts: 1, initialDelayMs: 1, maxDelayMs: 1 },
      sleep: async () => undefined,
      logger: { info() {}, warn() {}, error() {} },
    } as unknown as RecoveryExecutorDeps);
  }

  it('goes stale when a tick hangs before claiming anything', async () => {
    const clock = { now: 1_000_000 };
    let hang = false;
    let release: (() => void) | null = null;
    const executor = executorWith({
      journalPending: async () => {
        if (hang) await new Promise<void>((resolve) => (release = resolve));
        return [];
      },
      claimOwn: async () => null,
      readiness: async () => ({ degraded: false }),
      clock,
    });
    await executor.tick();
    expect(executor.isFresh(clock.now)).toBe(true);
    hang = true;
    const hung = executor.tick();
    clock.now += TICK * 3 + 1;
    expect(executor.isFresh(clock.now)).toBe(false);
    (release as (() => void) | null)?.();
    await hung;
  });

  it('stays fresh through a claimed recovery that runs for an hour', async () => {
    const clock = { now: 1_000_000 };
    let release: (() => void) | null = null;
    const executor = executorWith({
      journalPending: async () => [],
      claimOwn: async () => ({
        id: '0192f000-0000-7000-8000-00000000r001',
        state: 'RESTARTING',
        leaseOwner: 'recovery:this-host',
        cutoverAt: new Date(clock.now),
        displacedDatabase: 'nexa_pre_restore_x',
        candidateDatabase: 'nexa_candidate_x',
      }),
      readiness: async () => {
        await new Promise<void>((resolve) => (release = resolve));
        return { degraded: false };
      },
      clock,
    });
    const running = executor.tick();
    await new Promise((resolve) => setImmediate(resolve));
    expect(release).not.toBeNull();
    clock.now += 60 * 60_000;
    expect(executor.isFresh(clock.now)).toBe(true);
    (release as (() => void) | null)?.();
    await running;
    // And fresh the moment it ends: the finished run is progress, not an hour-old claim.
    expect(executor.isFresh(clock.now)).toBe(true);
  });
});
