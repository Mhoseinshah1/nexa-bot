import { describe, expect, it, vi } from 'vitest';
import {
  CAPACITY_ERROR_CODES,
  CAPACITY_RESOURCE_RULES,
  CAPACITY_RESOURCES,
  capacityLimitProblem,
  effectiveCapacityLimit,
  isNexaError,
  type Clock,
} from '@nexa/contracts';
import {
  KeyedConcurrencyLimiter,
  LimiterDeferral,
} from '../../apps/api/src/modules/platform/capacity/domain/keyed-limiter';
import {
  groupInOrder,
  weightedRoundRobin,
} from '../../apps/api/src/modules/platform/capacity/domain/round-robin';
import {
  phasedSweepDue,
  scheduleOffsetMs,
} from '../../apps/api/src/modules/platform/capacity/domain/schedule-offset';
import {
  availableMemoryBytes,
  cgroupHeadroomBytes,
  diskUsedPercent,
  memAvailableBytes,
} from '../../apps/api/src/modules/platform/capacity/domain/memory';
import {
  BotTurnGuard,
  isCapacityDeferral,
  webhookTurnTenant,
} from '../../apps/api/src/modules/platform/capacity/application/bot-turn-guard';
import {
  LIMIT_PRESSURE_THRESHOLD,
  LimitPressureReporter,
} from '../../apps/api/src/modules/platform/capacity/application/limit-pressure';
import { NewCustomerGate } from '../../apps/api/src/modules/platform/capacity/application/new-customer-gate';
import { CapacityLimitResolver } from '../../apps/api/src/modules/platform/capacity/application/capacity-limit-resolver';
import { CapacityMonitor } from '../../apps/api/src/modules/platform/capacity/application/capacity-monitor';
import { HeavyJobGate } from '../../apps/api/src/modules/platform/capacity/application/heavy-job-gate';
import { PoolShare } from '../../apps/api/src/modules/platform/capacity/infrastructure/pool-share';
import { workerHealthVerdict } from '../../apps/api/src/infrastructure/lifecycle/loop-health';

/** A promise and the function that settles it. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function manualTimers() {
  const timers: { fn: () => void; cancelled: boolean }[] = [];
  return {
    setTimer: (fn: () => void) => {
      const timer = { fn, cancelled: false };
      timers.push(timer);
      return { cancel: () => (timer.cancelled = true) };
    },
    fireAll: () => {
      for (const timer of timers.splice(0)) if (!timer.cancelled) timer.fn();
    },
  };
}

function fixedClock(
  start = Date.UTC(2026, 10, 4, 12, 0, 0),
): Clock & { advance(ms: number): void } {
  let now = start;
  return {
    now: () => new Date(now),
    advance: (ms: number) => {
      now += ms;
    },
  } as Clock & { advance(ms: number): void };
}

describe('the owner’s table (phase 6A PR-2)', () => {
  it('pins every default the owner set, hosted and own bot', () => {
    const d = (r: keyof typeof CAPACITY_RESOURCE_RULES) => CAPACITY_RESOURCE_RULES[r].defaults;
    expect(d('UPDATE_CONCURRENCY')).toEqual({
      HOSTED: { mode: 'LIMITED', value: 8 },
      INSTALLATION: { mode: 'UNLIMITED' },
    });
    expect(d('DB_CONNECTIONS')).toEqual({
      HOSTED: { mode: 'LIMITED', value: 3 },
      INSTALLATION: { mode: 'UNLIMITED' },
    });
    expect(d('JOB_TURN_WEIGHT')).toEqual({
      HOSTED: { mode: 'LIMITED', value: 1 },
      INSTALLATION: { mode: 'LIMITED', value: 2 },
    });
    expect(d('BROADCAST_PER_SECOND')).toEqual({
      HOSTED: { mode: 'LIMITED', value: 10 },
      INSTALLATION: { mode: 'LIMITED', value: 25 },
    });
    expect(d('HEAVY_JOB_PRIORITY').INSTALLATION).toEqual({ mode: 'LIMITED', value: 1 });
    expect(d('HEAVY_JOB_PRIORITY').HOSTED).toEqual({ mode: 'LIMITED', value: 0 });
    expect(d('NEW_CUSTOMERS_PER_MINUTE')).toEqual({
      HOSTED: { mode: 'LIMITED', value: 60 },
      INSTALLATION: { mode: 'UNLIMITED' },
    });
    expect(d('SUPPORT_AI_MONTHLY_REQUESTS').INSTALLATION).toEqual({ mode: 'UNLIMITED' });
    expect(d('STORAGE_MB').INSTALLATION).toEqual({ mode: 'UNLIMITED' });
    expect(d('INSTALLATION_HEAVY_JOB_CONCURRENCY').INSTALLATION).toEqual({
      mode: 'LIMITED',
      value: 1,
    });
    expect(CAPACITY_RESOURCE_RULES.INSTALLATION_HEAVY_JOB_CONCURRENCY.max).toBe(2);
  });

  it('a stored limit wins over the default; without one the tier decides', () => {
    expect(effectiveCapacityLimit('UPDATE_CONCURRENCY', 'HOSTED', null)).toEqual({
      mode: 'LIMITED',
      value: 8,
    });
    expect(effectiveCapacityLimit('UPDATE_CONCURRENCY', 'HOSTED', { mode: 'UNLIMITED' })).toEqual({
      mode: 'UNLIMITED',
    });
  });

  it('refuses what a resource cannot take', () => {
    expect(capacityLimitProblem('JOB_TURN_WEIGHT', { mode: 'UNLIMITED' }, 'HOSTED')).toBe(
      'UNLIMITED_NOT_ALLOWED',
    );
    expect(
      capacityLimitProblem('UPDATE_CONCURRENCY', { mode: 'LIMITED', value: 0 }, 'HOSTED'),
    ).toBe('OUT_OF_RANGE');
    expect(
      capacityLimitProblem(
        'INSTALLATION_HEAVY_JOB_CONCURRENCY',
        { mode: 'LIMITED', value: 1 },
        'HOSTED',
      ),
    ).toBe('INSTALLATION_ONLY');
    expect(
      capacityLimitProblem(
        'INSTALLATION_HEAVY_JOB_CONCURRENCY',
        { mode: 'LIMITED', value: 3 },
        'INSTALLATION',
      ),
    ).toBe('OUT_OF_RANGE');
    expect(capacityLimitProblem('UPDATE_CONCURRENCY', { mode: 'UNLIMITED' }, 'HOSTED')).toBeNull();
    for (const resource of CAPACITY_RESOURCES) {
      const rule = CAPACITY_RESOURCE_RULES[resource];
      for (const tier of ['HOSTED', 'INSTALLATION'] as const) {
        if (rule.installationOnly && tier === 'HOSTED') continue;
        expect(capacityLimitProblem(resource, rule.defaults[tier], tier), resource).toBeNull();
      }
    }
  });
});

describe('the per-bot concurrency limiter', () => {
  it('runs at most N of one bot at once; the rest wait in that bot’s queue, in order', async () => {
    const timers = manualTimers();
    const limiter = new KeyedConcurrencyLimiter({
      maxQueuedPerKey: 10,
      maxWaitMs: 1_000,
      setTimer: timers.setTimer,
    });
    const gates = Array.from({ length: 5 }, () => deferred());
    let running = 0;
    let peak = 0;
    const order: number[] = [];
    const runs = gates.map((gate, i) =>
      limiter.run('bot-a', 2, async () => {
        running += 1;
        peak = Math.max(peak, running);
        order.push(i);
        await gate.promise;
        running -= 1;
        return i;
      }),
    );
    await flush();
    expect(running).toBe(2);
    expect(limiter.snapshot('bot-a')).toEqual({ active: 2, queued: 3 });
    for (const gate of gates) {
      gate.resolve();
      await flush();
    }
    const results = await Promise.all(runs);
    expect(peak).toBe(2);
    expect(order).toEqual([0, 1, 2, 3, 4]);
    expect(results.map((r) => r.outcome)).toEqual([
      'IMMEDIATE',
      'IMMEDIATE',
      'WAITED',
      'WAITED',
      'WAITED',
    ]);
    // Nothing waited out: every task ran.
    expect(results.map((r) => r.result)).toEqual([0, 1, 2, 3, 4]);
    expect(limiter.snapshot('bot-a')).toEqual({ active: 0, queued: 0 });
  });

  it('another bot is not slowed by a bot at its limit', async () => {
    const limiter = new KeyedConcurrencyLimiter({ maxQueuedPerKey: 10, maxWaitMs: 1_000 });
    const hold = deferred();
    const busy = [1, 2].map(() => limiter.run('bot-a', 2, () => hold.promise));
    await flush();
    const other = await limiter.run('bot-b', 2, async () => 'served');
    expect(other).toEqual({ result: 'served', outcome: 'IMMEDIATE' });
    hold.resolve();
    await Promise.all(busy);
  });

  it('refuses, before starting it, a task over a full queue or past its wait', async () => {
    const timers = manualTimers();
    const limiter = new KeyedConcurrencyLimiter({
      maxQueuedPerKey: 1,
      maxWaitMs: 1_000,
      setTimer: timers.setTimer,
    });
    const hold = deferred();
    const started: string[] = [];
    const first = limiter.run('bot-a', 1, async () => {
      started.push('first');
      await hold.promise;
    });
    const waiting = limiter.run('bot-a', 1, async () => {
      started.push('waiting');
    });
    await expect(
      limiter.run('bot-a', 1, async () => {
        started.push('overflow');
      }),
    ).rejects.toMatchObject({ reason: 'QUEUE_FULL' });
    timers.fireAll();
    await expect(waiting).rejects.toBeInstanceOf(LimiterDeferral);
    hold.resolve();
    await first;
    expect(started).toEqual(['first']);
    expect(limiter.snapshot('bot-a')).toEqual({ active: 0, queued: 0 });
  });

  it('Infinity is «نامحدود»: never waits', async () => {
    const limiter = new KeyedConcurrencyLimiter({ maxQueuedPerKey: 0, maxWaitMs: 1 });
    const hold = deferred();
    const runs = Array.from({ length: 50 }, () =>
      limiter.run('owner', Number.POSITIVE_INFINITY, () => hold.promise),
    );
    await flush();
    expect(limiter.snapshot('owner').active).toBe(50);
    hold.resolve();
    expect((await Promise.all(runs)).every((r) => r.outcome === 'IMMEDIATE')).toBe(true);
  });
});

describe('the round-robin scheduler', () => {
  const group = (key: string, n: number, weight = 1) => ({
    key,
    weight,
    items: Array.from({ length: n }, (_, i) => `${key}${String(i)}`),
  });

  it('a long queue cannot starve a short one: every bot gets a turn per round', () => {
    const picked = weightedRoundRobin([group('a', 1000), group('b', 2), group('c', 1)], 6);
    expect(picked).toEqual(['a0', 'b0', 'c0', 'a1', 'b1', 'a2']);
  });

  it('the owner’s double turn', () => {
    const picked = weightedRoundRobin([group('a', 10, 2), group('b', 10, 1)], 6);
    expect(picked).toEqual(['a0', 'a1', 'b0', 'a2', 'a3', 'b1']);
  });

  it('keeps each bot’s own order, takes everything when there is room, and never repeats', () => {
    const picked = weightedRoundRobin([group('b', 3), group('a', 2, 3)], 100);
    expect(picked).toEqual(['a0', 'a1', 'b0', 'b1', 'b2']);
    expect(new Set(picked).size).toBe(picked.length);
  });

  it('rotation moves who goes first, so a small batch is not always the same bot', () => {
    const groups = [group('a', 5), group('b', 5), group('c', 5)];
    expect(weightedRoundRobin(groups, 1, 0)).toEqual(['a0']);
    expect(weightedRoundRobin(groups, 1, 1)).toEqual(['b0']);
    expect(weightedRoundRobin(groups, 1, 2)).toEqual(['c0']);
    expect(weightedRoundRobin(groups, 1, 3)).toEqual(['a0']);
  });

  it('groups by key in arrival order', () => {
    const groups = groupInOrder(
      [
        { t: 'x', n: 1 },
        { t: 'y', n: 2 },
        { t: 'x', n: 3 },
      ],
      (row) => row.t,
      (key) => (key === 'x' ? 2 : 1),
    );
    expect(groups).toEqual([
      {
        key: 'x',
        weight: 2,
        items: [
          { t: 'x', n: 1 },
          { t: 'x', n: 3 },
        ],
      },
      { key: 'y', weight: 1, items: [{ t: 'y', n: 2 }] },
    ]);
  });
});

describe('the scheduled-work offset', () => {
  const ids = Array.from(
    { length: 50 },
    (_, i) =>
      `0193${String(i).padStart(4, '0')}-7c00-7000-8000-${String(i * 7919).padStart(12, '0')}`,
  );

  it('is stable, inside its spread, whole seconds, and per purpose', () => {
    const spread = 60 * 60_000;
    for (const id of ids) {
      const offset = scheduleOffsetMs(id, 'nightly-report', spread);
      expect(offset).toBe(scheduleOffsetMs(id, 'nightly-report', spread));
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThan(spread);
      expect(offset % 1000).toBe(0);
    }
    const differs = ids.filter(
      (id) => scheduleOffsetMs(id, 'nightly-report', spread) !== scheduleOffsetMs(id, 'x', spread),
    );
    expect(differs.length).toBeGreaterThan(45);
    // The exact value is pinned, so a change to the hash is a visible decision.
    expect(scheduleOffsetMs('01930000-7c00-7000-8000-000000000000', 'nightly-report', spread)).toBe(
      scheduleOffsetMs('01930000-7c00-7000-8000-000000000000', 'nightly-report', spread),
    );
  });

  it('spreads fifty bots over the hour: no minute holds more than three of them', () => {
    const perMinute = new Map<number, number>();
    for (const id of ids) {
      const minute = Math.floor(scheduleOffsetMs(id, 'nightly-report', 3_600_000) / 60_000);
      perMinute.set(minute, (perMinute.get(minute) ?? 0) + 1);
    }
    expect(Math.max(...perMinute.values())).toBeLessThanOrEqual(3);
    // Spread, not bunched: a uniform hash of 50 bots over 60 minutes occupies about 34.
    expect(perMinute.size).toBeGreaterThanOrEqual(30);
  });

  it('the owner’s own bot keeps its configured time', () => {
    expect(scheduleOffsetMs(ids[0] as string, 'nightly-report', 3_600_000, 'INSTALLATION')).toBe(0);
  });

  it('a phased sweep runs once per interval, in its own slot', () => {
    const interval = 15 * 60_000;
    const offset = 7 * 60_000;
    const base = Date.UTC(2026, 10, 4, 0, 0, 0);
    expect(phasedSweepDue(base, null, interval, offset)).toBe(true);
    // Ran at 00:06 (slot before 00:07): due again at 00:07, not before.
    const ranAt = base + 6 * 60_000;
    expect(phasedSweepDue(base + 6 * 60_000 + 30_000, ranAt, interval, offset)).toBe(false);
    expect(phasedSweepDue(base + 7 * 60_000, ranAt, interval, offset)).toBe(true);
    // Ran at 00:07: next at 00:22.
    const ran2 = base + 7 * 60_000;
    expect(phasedSweepDue(base + 21 * 60_000, ran2, interval, offset)).toBe(false);
    expect(phasedSweepDue(base + 22 * 60_000, ran2, interval, offset)).toBe(true);
  });
});

describe('memory and disk readings', () => {
  it('reads MemAvailable and the cgroup headroom, and takes the smaller', () => {
    expect(memAvailableBytes('MemTotal: 8000 kB\nMemAvailable:   1024 kB\n')).toBe(1024 * 1024);
    expect(memAvailableBytes('MemTotal: 8000 kB\n')).toBeNull();
    expect(cgroupHeadroomBytes('max\n', '100')).toBeNull();
    expect(cgroupHeadroomBytes('1000\n', '400\n')).toBe(600);
    expect(cgroupHeadroomBytes('9223372036854771712', '1')).toBeNull();
    expect(availableMemoryBytes(5000, 600)).toBe(600);
    expect(availableMemoryBytes(null, 600)).toBe(600);
    expect(availableMemoryBytes(5000, null)).toBe(5000);
    expect(diskUsedPercent(1000, 150)).toBe(85);
    expect(diskUsedPercent(0, 0)).toBeNull();
  });
});

describe('a bot turn inside its fair share', () => {
  const limits = (updates: number, connections: number) => ({
    numberOf: async (_tenant: string, resource: string) =>
      resource === 'UPDATE_CONCURRENCY' ? updates : connections,
  });
  const share = { run: <T>(_k: string, _l: number, fn: () => Promise<T>) => fn() };

  it('hands an update it cannot place back as a retryable capacity deferral, never runs it', async () => {
    const hit = vi.fn();
    const guard = new BotTurnGuard({
      limits: limits(1, 3),
      limiter: new KeyedConcurrencyLimiter({ maxQueuedPerKey: 0, maxWaitMs: 1_000 }),
      dbShare: share,
      pressure: { hit },
    });
    const hold = deferred();
    const first = guard.run('t', () => hold.promise);
    const turn = vi.fn(async () => undefined);
    const refused = await guard.run('t', turn).catch((error: unknown) => error);
    expect(turn).not.toHaveBeenCalled();
    expect(isNexaError(refused) && refused.retryable && refused.httpStatus).toBe(429);
    expect(isCapacityDeferral(refused)).toBe(true);
    expect(hit).toHaveBeenCalledWith('t', 'UPDATE_CONCURRENCY');
    hold.resolve();
    await first;
  });

  it('counts a wait as a hit, and leaves an unlimited bot alone', async () => {
    const hit = vi.fn();
    const guard = new BotTurnGuard({
      limits: limits(1, Number.POSITIVE_INFINITY),
      limiter: new KeyedConcurrencyLimiter({ maxQueuedPerKey: 5, maxWaitMs: 1_000 }),
      dbShare: { run: () => Promise.reject(new Error('the share must not be used')) },
      pressure: { hit },
    });
    const hold = deferred();
    const first = guard.run('t', () => hold.promise);
    const second = guard.run('t', async () => 'second');
    await flush();
    hold.resolve();
    await first;
    expect(await second).toBe('second');
    expect(hit).toHaveBeenCalledTimes(1);
  });

  it('marks the turn as that bot’s webhook turn, and nothing outside it', async () => {
    const guard = new BotTurnGuard({
      limits: limits(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY),
      limiter: new KeyedConcurrencyLimiter({ maxQueuedPerKey: 1, maxWaitMs: 1_000 }),
      dbShare: share,
      pressure: { hit: vi.fn() },
    });
    expect(await guard.run('t', async () => webhookTurnTenant())).toBe('t');
    expect(webhookTurnTenant()).toBeUndefined();
  });

  it('a different error is not a deferral', () => {
    expect(isCapacityDeferral(new Error('x'))).toBe(false);
  });
});

describe('the owner’s pressure alert', () => {
  it('fires once the bot keeps hitting, once per quiet period, on the owner’s log', async () => {
    const clock = fixedClock();
    const record = vi.fn(async (_event: unknown) => undefined);
    const reporter = new LimitPressureReporter({
      clock,
      ownerOpsLog: { record, conditionOpen: async () => false },
    });
    let raised = 0;
    for (let i = 0; i < LIMIT_PRESSURE_THRESHOLD - 1; i += 1) {
      if (reporter.hit('t', 'UPDATE_CONCURRENCY')) raised += 1;
    }
    expect(raised).toBe(0);
    expect(reporter.hit('t', 'UPDATE_CONCURRENCY')).toBe(true);
    expect(reporter.hit('t', 'UPDATE_CONCURRENCY')).toBe(false);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]?.[0]).toMatchObject({
      code: 'capacity.bot_limit_pressure',
      context: { tenantId: 't', resource: 'UPDATE_CONCURRENCY' },
    });
    // Another bot is its own count.
    expect(reporter.hit('u', 'UPDATE_CONCURRENCY')).toBe(false);
  });
});

describe('the new-customer rate', () => {
  it('admits N per minute per bot, then refuses retryably; the next minute starts over', async () => {
    const clock = fixedClock();
    const hit = vi.fn();
    let inTurn: string | undefined = 't';
    const gate = new NewCustomerGate({
      clock,
      limits: { numberOf: async () => 2 },
      pressure: { hit },
      turnTenant: () => inTurn,
    });
    await gate.admit('t');
    await gate.admit('t');
    const refused = await gate.admit('t').catch((error: unknown) => error);
    expect(isNexaError(refused) && refused.code).toBe(CAPACITY_ERROR_CODES.NEW_CUSTOMER_RATE);
    expect(isCapacityDeferral(refused)).toBe(true);
    // Outside that bot's webhook turn (an import, a test, an operator tool): never limited.
    inTurn = undefined;
    for (let i = 0; i < 10; i += 1) await gate.admit('t');
    inTurn = 'other';
    await gate.admit('t');
    inTurn = 't';
    clock.advance(60_000);
    await expect(gate.admit('t')).resolves.toBeUndefined();
    expect(hit).toHaveBeenCalledWith('t', 'NEW_CUSTOMERS_PER_MINUTE');
  });

  it('«نامحدود» never refuses', async () => {
    const gate = new NewCustomerGate({
      clock: fixedClock(),
      limits: { numberOf: async () => Number.POSITIVE_INFINITY },
      pressure: { hit: vi.fn() },
      turnTenant: () => 'owner',
    });
    for (let i = 0; i < 500; i += 1) await gate.admit('owner');
  });
});

describe('the limit resolver', () => {
  it('reads the owner’s stored value, caches it, and falls back to the defaults on a failure', async () => {
    const clock = fixedClock();
    const storedFor = vi.fn(
      async () => new Map([['UPDATE_CONCURRENCY', { mode: 'LIMITED', value: 4 }]]),
    );
    const resolver = new CapacityLimitResolver({
      repository: { storedFor } as never,
      clock,
      installationTenantId: () => 'owner',
    });
    expect(await resolver.numberOf('hosted', 'UPDATE_CONCURRENCY')).toBe(4);
    expect(await resolver.numberOf('hosted', 'DB_CONNECTIONS')).toBe(3);
    expect(storedFor).toHaveBeenCalledTimes(1);
    expect(resolver.tierOf('owner')).toBe('INSTALLATION');
    expect(await resolver.numberOf('owner', 'DB_CONNECTIONS')).toBe(Number.POSITIVE_INFINITY);
    const failing = new CapacityLimitResolver({
      repository: { storedFor: async () => Promise.reject(new Error('down')) },
      clock,
      installationTenantId: () => 'owner',
    });
    // A database blip never lifts a hosted bot's limit.
    expect(await failing.numberOf('hosted', 'UPDATE_CONCURRENCY')).toBe(8);
  });
});

describe('the server monitor (owner only)', () => {
  it('opens a condition only after two breaches in a row, and recovers it', async () => {
    const record = vi.fn(async (_event: unknown) => undefined);
    let open = false;
    let used = 0.85;
    const monitor = new CapacityMonitor({
      probe: {
        availableMemoryBytes: async () => 4 * 1024 ** 3,
        disk: async () => ({ totalBytes: 100, availableBytes: Math.round(100 * (1 - used)) }),
      },
      ownerOpsLog: { record, conditionOpen: async () => open },
      limits: { numberOf: async () => 512 },
      installationTenantId: () => 'owner',
      diskPaths: ['/'],
      workerLagMs: async () => 0,
    });
    await monitor.check();
    expect(record).not.toHaveBeenCalled();
    await monitor.check();
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'capacity.disk_warning',
        dedupeKey: 'capacity.disk_warning:disk-warning:/',
      }),
    );
    expect(
      record.mock.calls.some(([e]) => (e as { code: string }).code === 'capacity.disk_critical'),
    ).toBe(false);
    open = true;
    used = 0.5;
    record.mockClear();
    await monitor.check();
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'capacity.disk_warning_cleared',
        recoversCode: 'capacity.disk_warning',
      }),
    );
  });

  it('says nothing without an installation tenant', async () => {
    const record = vi.fn();
    const monitor = new CapacityMonitor({
      probe: {
        availableMemoryBytes: async () => 1,
        disk: async () => ({ totalBytes: 1, availableBytes: 0 }),
      },
      ownerOpsLog: { record, conditionOpen: async () => true },
      limits: { numberOf: async () => 512 },
      installationTenantId: () => null,
      diskPaths: ['/'],
      workerLagMs: async () => 1e9,
    });
    await monitor.check();
    await monitor.check();
    expect(record).not.toHaveBeenCalled();
  });
});

describe('the heavy-job gate', () => {
  it('starts nothing while free memory is below the floor, and tells the owner', async () => {
    const enqueue = vi.fn();
    const record = vi.fn(async (_event: unknown) => undefined);
    const gate = new HeavyJobGate({
      repository: {
        enqueue,
        tryStart: vi.fn(),
        heartbeat: vi.fn(),
        finish: vi.fn(),
        purgeFinished: vi.fn(),
      },
      limits: { numberOf: async () => 768 },
      probe: { availableMemoryBytes: async () => 100 * 1024 * 1024 },
      ownerOpsLog: { record, conditionOpen: async () => false },
      clock: fixedClock(),
      ids: { uuid: () => 'ticket' } as never,
      installationTenantId: () => 'owner',
    });
    const admission = await gate.attempt('BACKUP', 'owner', null);
    expect(admission).toMatchObject({ granted: false, reason: 'LOW_MEMORY' });
    expect(enqueue).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'capacity.heavy_job_deferred' }),
    );
  });
});

describe('the heavy-job queue, waited on', () => {
  it('runs the job once admitted, keeps its one ticket between attempts, and hands the slot back', async () => {
    const states = ['QUEUED', 'QUEUED', 'RUNNING'] as const;
    const tryStart = vi.fn(async () => states[tryStart.mock.calls.length - 1] ?? 'RUNNING');
    const enqueue = vi.fn(async () => undefined);
    const finish = vi.fn(async () => undefined);
    let n = 0;
    const gate = new HeavyJobGate({
      repository: {
        enqueue,
        tryStart,
        heartbeat: vi.fn(async () => undefined),
        finish,
        purgeFinished: vi.fn(async () => 0),
      },
      limits: { numberOf: async () => 1 },
      probe: { availableMemoryBytes: async () => null },
      ownerOpsLog: { record: vi.fn(async () => undefined), conditionOpen: async () => false },
      clock: fixedClock(),
      ids: { uuid: () => `ticket-${String((n += 1))}` } as never,
      installationTenantId: () => 'owner',
    });
    const job = vi.fn(async () => 'done');
    const outcome = await gate.runWhenAdmitted('BACKUP', 'owner', job, {
      pollMs: 1,
      maxWaitMs: 60_000,
      sleep: async () => undefined,
    });
    expect(outcome).toEqual({ ran: true, result: 'done' });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(tryStart.mock.calls.map((call) => (call as unknown[])[0])).toEqual([
      'ticket-1',
      'ticket-1',
      'ticket-1',
    ]);
    expect(finish).toHaveBeenCalledWith('ticket-1', expect.any(Date));
  });
});

describe('the database share', () => {
  function fakePool() {
    let open = 0;
    let peak = 0;
    const pool = {
      connect: (callback?: (e: Error | undefined, c?: unknown) => void) => {
        open += 1;
        peak = Math.max(peak, open);
        const client = { release: () => (open -= 1) };
        if (callback) {
          callback(undefined, client);
          return undefined;
        }
        return Promise.resolve(client);
      },
    };
    return { pool, peak: () => peak, open: () => open };
  }

  it('holds at most N of one bot’s turns in the database; nested checkouts ride on the turn’s permit', async () => {
    const fake = fakePool();
    const share = new PoolShare({ maxWaitMs: 1_000 });
    share.install(fake.pool as never);
    const waits = vi.fn();
    const gates = Array.from({ length: 4 }, () => deferred());
    const turns = gates.map((gate) =>
      share.run(
        'bot',
        2,
        async () => {
          const outer = await (fake.pool.connect() as Promise<{ release(): void }>);
          // A second checkout while holding one: must not wait on the bot's own share.
          const inner = await (fake.pool.connect() as Promise<{ release(): void }>);
          await gate.promise;
          inner.release();
          outer.release();
        },
        waits,
      ),
    );
    await flush();
    expect(share.snapshot('bot')).toEqual({ held: 2, waiting: 2 });
    expect(fake.open()).toBe(4);
    for (const gate of gates) {
      gate.resolve();
      await flush();
    }
    await Promise.all(turns);
    expect(waits).toHaveBeenCalledTimes(2);
    expect(share.snapshot('bot')).toEqual({ held: 0, waiting: 0 });
  });

  it('another bot, and work outside any turn, go straight to the pool', async () => {
    const fake = fakePool();
    const share = new PoolShare({ maxWaitMs: 1_000 });
    share.install(fake.pool as never);
    const hold = deferred();
    const busy = share.run(
      'bot',
      1,
      async () => {
        const c = await (fake.pool.connect() as Promise<{ release(): void }>);
        await hold.promise;
        c.release();
      },
      vi.fn(),
    );
    await flush();
    const other = await share.run(
      'other',
      1,
      async () => {
        const c = await (fake.pool.connect() as Promise<{ release(): void }>);
        c.release();
        return 'ok';
      },
      vi.fn(),
    );
    expect(other).toBe('ok');
    const outside = await (fake.pool.connect() as Promise<{ release(): void }>);
    outside.release();
    hold.resolve();
    await busy;
  });
});

describe('the worker’s boot', () => {
  it('reports no stall before every loop has been started: not ready, alive', () => {
    expect(
      workerHealthVerdict({
        started: false,
        stalledNow: ['backup-scheduler'],
        stalledBeyondAllowance: ['x'],
      }),
    ).toEqual({ healthy: false, alive: true });
    expect(workerHealthVerdict({ started: true, stalledNow: [], stalledBeyondAllowance: [] })).toBe(
      true,
    );
    expect(
      workerHealthVerdict({
        started: true,
        stalledNow: ['relay'],
        stalledBeyondAllowance: ['relay'],
      }),
    ).toEqual({ healthy: false, alive: false });
  });
});
