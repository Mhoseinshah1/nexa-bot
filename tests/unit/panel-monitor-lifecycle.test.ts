import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Clock, IdGenerator, Logger } from '@nexa/contracts';
import {
  PanelMonitorService,
  type PanelMonitorDeps,
} from '../../apps/api/src/modules/platform/panels/application/panel-monitor.service';
import type {
  DuePanel,
  PanelMonitorRepository,
} from '../../apps/api/src/modules/platform/panels/application/ports';

/**
 * The timer lifecycle, driven rather than waited out.
 *
 * `start()`, `stop()` and the interval they own had NO test. Every other
 * monitor test called `tick()` directly, which is the right way to test a
 * sweep and says nothing about the loop that runs it: whether the first pass
 * happens immediately or an interval late, whether a second `start()` doubles
 * the probe rate, whether `stop()` actually cancels, whether it waits for work
 * in flight, and whether a draining monitor still claims to be alive.
 *
 * Every one of those is a real production behaviour with a comment in the
 * service asserting it, and a comment is not a test.
 *
 * There is not one real sleep here. Fake timers make the schedule exact: a
 * test that slept would be asserting the scheduler AND the machine's load, and
 * would be the flake that gets retried until it passes.
 */

/**
 * A dependency this test's paths never reach.
 *
 * Throws rather than returning a stub, so "unused" is a claim the run checks
 * rather than a claim this comment makes. With `claimTenants` answering an
 * empty list, the sweep returns before it needs a guard, an actor, a
 * transaction or an audit row.
 */
function unreachable<T>(what: string): T {
  return new Proxy(
    {},
    {
      get() {
        throw new Error(`the lifecycle tests should never reach ${what}`);
      },
    },
  ) as T;
}

const silentLogger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};

const INTERVAL_MS = 30_000;

describe('the panel monitor timer lifecycle', () => {
  /** The clock the service reads. Moved by hand, in step with the fake timers. */
  let now: Date;
  let claims: number;
  let reconciles: number;
  /** Set to hold `claimTenants` open, which holds the whole tick open. */
  let holdClaim: (() => void) | null;
  /** Set to make discovery fail the way an unreachable database does. */
  let claimThrows: boolean;

  const clock: Clock = { now: () => now };

  function discovery(): PanelMonitorRepository {
    return {
      reconcileSchedules: async () => {
        reconciles += 1;
        return 0;
      },
      claimTenants: async (): Promise<string[]> => {
        claims += 1;
        if (claimThrows) throw new Error('discovery is unreachable');
        if (holdClaim !== null) {
          await new Promise<void>((resolve) => {
            holdClaim = resolve;
          });
        }
        return [];
      },
      dueForTenants: async (): Promise<DuePanel[]> => [],
      refreshTenantBounds: async () => {},
      activePanelCount: async () => 0,
      overBudgetTenants: async () => [],
    };
  }

  function monitor(): PanelMonitorService {
    const deps: PanelMonitorDeps = {
      discovery: discovery(),
      probe: unreachable('the probe core'),
      guard: unreachable('the permission guard'),
      audit: unreachable('the audit writer'),
      opsLog: unreachable('the operational log'),
      sessions: unreachable('the session repository'),
      uow: unreachable('the unit of work'),
      clock,
      ids: unreachable<IdGenerator>('the id generator'),
      logger: silentLogger,
      batchSize: 50,
      tenantsPerTick: 10,
      concurrency: 4,
      budgetReserve: 0,
      tenantBudgetUpperBound: 60,
      schedulerUpperBound: 1_000,
      capacityAssessmentIntervalMs: 10 * 60 * 1000,
    };
    return new PanelMonitorService(deps, INTERVAL_MS);
  }

  /** Advances the fake timers AND the clock together, so they never disagree. */
  async function advance(ms: number): Promise<void> {
    now = new Date(now.getTime() + ms);
    await vi.advanceTimersByTimeAsync(ms);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    now = new Date('2026-03-01T12:00:00.000Z');
    claims = 0;
    reconciles = 0;
    holdClaim = null;
    claimThrows = false;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs its first pass immediately, not one interval later', async () => {
    const m = monitor();
    m.start();
    // Zero elapsed time. `start()` calls `tick()` directly before arming the
    // interval, because a monitor restarting more often than its interval — a
    // crash loop, a day of deploys — would otherwise never probe anything.
    await advance(0);
    expect(claims).toBe(1);

    await m.stop();
  });

  it('runs again on the interval, and not before it', async () => {
    const m = monitor();
    m.start();
    await advance(0);
    expect(claims).toBe(1);

    // One millisecond short. The interval is a floor, and a test that advanced
    // straight to it could not tell a 30s interval from a 1ms one.
    await advance(INTERVAL_MS - 1);
    expect(claims).toBe(1);

    await advance(1);
    expect(claims).toBe(2);

    await advance(INTERVAL_MS);
    expect(claims).toBe(3);

    await m.stop();
  });

  it('does not arm a second loop when start is called twice', async () => {
    const m = monitor();
    m.start();
    await advance(0);
    // The second call must be a no-op. Two intervals on one service would
    // double this installation's outbound probe rate while every configured
    // bound still read as satisfied — and would leak the first timer, so
    // `stop()` could not cancel it.
    m.start();
    await advance(0);
    expect(claims).toBe(1);

    await advance(INTERVAL_MS * 3);
    expect(claims).toBe(4);

    await m.stop();
  });

  it('stops scheduling once stopped, however long the process then runs', async () => {
    const m = monitor();
    m.start();
    await advance(0);
    await advance(INTERVAL_MS);
    expect(claims).toBe(2);

    await m.stop();

    await advance(INTERVAL_MS * 10);
    expect(claims).toBe(2);
  });

  it('can be started again after being stopped', async () => {
    const m = monitor();
    m.start();
    await advance(0);
    await m.stop();
    expect(claims).toBe(1);

    m.start();
    await advance(0);
    expect(claims).toBe(2);

    await m.stop();
  });

  it('waits for the pass in flight instead of abandoning it', async () => {
    const m = monitor();
    // `holdClaim` non-null makes the next claim block until released, which
    // holds the whole tick open — standing in for a sweep whose probes have
    // already spent claims and budget tokens.
    holdClaim = () => {};
    m.start();
    await advance(0);
    expect(claims).toBe(1);

    let drained = false;
    const stopping = m.stop().then(() => {
      drained = true;
    });

    // `stop()` polls every 10ms for the tick to finish. Several polls go by
    // and it is still waiting, because the tick has not finished.
    await advance(100);
    expect(drained).toBe(false);

    holdClaim?.();
    await advance(50);
    await stopping;
    expect(drained).toBe(true);
  });

  it('does not schedule another pass while it is draining', async () => {
    const m = monitor();
    holdClaim = () => {};
    m.start();
    await advance(0);

    const stopping = m.stop();
    // Two whole intervals pass while the first tick is stuck. `stop()` clears
    // the interval before it waits, so nothing new is armed.
    await advance(INTERVAL_MS * 2);
    expect(claims).toBe(1);

    holdClaim?.();
    await advance(50);
    await stopping;
    expect(claims).toBe(1);
  });

  it('is not alive before it has started', () => {
    const m = monitor();
    // No grace period. A monitor that has never completed a pass has never
    // done its job, and a release that ships one must not be accepted.
    expect(m.iterationIsFresh(now.getTime())).toBe(false);
  });

  it('is alive after its first pass and goes stale after three intervals', async () => {
    const m = monitor();
    m.start();
    await advance(0);
    expect(m.iterationIsFresh(now.getTime())).toBe(true);

    await m.stop();

    // Read against a clock the loop is no longer moving. Exactly three
    // intervals is still fresh; one millisecond more is not.
    const markedAt = now.getTime();
    expect(m.iterationIsFresh(markedAt + INTERVAL_MS * 3)).toBe(false);
  });

  it('reports itself not alive the moment it is stopped', async () => {
    const m = monitor();
    m.start();
    await advance(0);
    expect(m.iterationIsFresh(now.getTime())).toBe(true);

    await m.stop();
    // A draining monitor is not a live one, and this must not depend on
    // `main.monitor.ts` happening to stop the heartbeat first.
    expect(m.iterationIsFresh(now.getTime())).toBe(false);
  });

  it('does not inherit the previous run\u2019s liveness after a restart', async () => {
    const m = monitor();
    m.start();
    await advance(0);
    expect(m.iterationIsFresh(now.getTime())).toBe(true);
    await m.stop();

    // Restarted into a broken database. Reconciliation still succeeds \u2014 it is
    // the CLAIM that fails \u2014 so `reconciled` goes back to true and stops
    // masking the progress mark. This is the one path that separates the two
    // halves of the liveness reset, and without `stop()` nulling
    // `lastProgressAt` the monitor would report itself alive on the strength of
    // a pass its previous life completed.
    claimThrows = true;
    m.start();
    await advance(0);
    expect(claims).toBe(2);
    expect(m.iterationIsFresh(now.getTime())).toBe(false);

    await m.stop();
  });

  it('does not let a pass that finishes while draining re-arm liveness', async () => {
    const m = monitor();
    holdClaim = () => {};
    m.start();
    await advance(0);

    const stopping = m.stop();
    // `stop()` has nulled the mark by now and is waiting for the held tick.
    // Releasing it lets that tick run to completion \u2014 including its call to
    // `noteProgress`, which is the one that must stay silent. The probes in
    // flight when SIGTERM arrives each finish, and each of them used to write
    // a fresh mark, so `stop()` nulled the field and then waited for the very
    // ticks that put it back.
    holdClaim?.();
    await advance(50);
    await stopping;

    // Restarted into a broken database, which is what makes the stale mark
    // visible: reconciliation succeeds and stops masking it, and nothing in
    // this life has made progress.
    holdClaim = null;
    claimThrows = true;
    m.start();
    await advance(0);
    expect(m.iterationIsFresh(now.getTime())).toBe(false);

    await m.stop();
  });

  it('reconciles once per start, not once per tick', async () => {
    const m = monitor();
    m.start();
    await advance(0);
    await advance(INTERVAL_MS * 3);
    expect(claims).toBe(4);
    // The anti-join is paid once per process, not every thirty seconds.
    expect(reconciles).toBe(1);

    await m.stop();
    m.start();
    await advance(0);
    // A restart re-reconciles: the rollback-and-forward sequence that leaves
    // orphaned panels ends at a process start. `stop()` is what re-arms it \u2014
    // `start()` clears the same flag, and that line is redundant with this one
    // rather than separately load-bearing, which mutation says plainly.
    expect(reconciles).toBe(2);

    await m.stop();
  });
});
