import { describe, expect, it } from 'vitest';
import {
  PROCESS_RESTART_STORM_MIN_RESTARTS,
  PROCESS_RESTART_STORM_WINDOW_MS,
  PROCESS_RUN_STABLE_AFTER_MS,
} from '@nexa/contracts';
import {
  endedYoung,
  recordBoot,
  recordStable,
  recordStopped,
  restartStormConditionKey,
  type ProcessRunRecord,
} from '../../apps/api/src/modules/platform/opslog/application/process-run-state';

/**
 * R11 A3: the rules that decide what a RESTART is, on the persisted record alone. A process
 * that has crashed remembers nothing, so everything below is a function of the previous
 * life's row and the clock — the same function the database store and the unit tests' store
 * both run.
 */

const T0 = new Date('2026-10-27T10:00:00.000Z');
const at = (ms: number): Date => new Date(T0.getTime() + ms);

/** A role's life as boot left it (crashed or still running: neither stable nor stopped). */
function life(overrides: Partial<ProcessRunRecord> = {}): ProcessRunRecord {
  return {
    runId: 'run-0',
    startedAt: T0,
    stableAt: null,
    stoppedAt: null,
    restarts: 0,
    restartsSince: null,
    ...overrides,
  };
}

describe('the contract numbers are real', () => {
  it('a storm needs several restarts, in a window longer than one stable run', () => {
    expect(PROCESS_RESTART_STORM_MIN_RESTARTS).toBeGreaterThanOrEqual(2);
    expect(PROCESS_RESTART_STORM_WINDOW_MS).toBeGreaterThan(PROCESS_RUN_STABLE_AFTER_MS);
  });
});

describe('recordBoot: the streak of crashed lives', () => {
  it('the very first boot of a role is no restart', () => {
    const next = recordBoot(null, 'run-1', at(0));
    expect(next).toMatchObject({ runId: 'run-1', restarts: 0, restartsSince: null });
    expect(next.stableAt).toBeNull();
    expect(next.stoppedAt).toBeNull();
  });

  it('a previous life that crashed young is one restart, counted from its own start', () => {
    const next = recordBoot(life({ runId: 'run-1' }), 'run-2', at(13_000));
    expect(next.restarts).toBe(1);
    expect(next.restartsSince).toEqual(T0);
  });

  it('every further crashed life lengthens the streak and keeps its first start', () => {
    let state = recordBoot(null, 'run-0', at(0));
    for (let boot = 1; boot <= 10; boot += 1) {
      state = recordBoot(state, `run-${String(boot)}`, at(boot * 13_000));
      expect(state.restarts).toBe(boot);
      expect(state.restartsSince).toEqual(T0);
    }
  });

  it('a previous life that stayed up the stable window ends the streak', () => {
    const streak = life({ restarts: 5, restartsSince: T0 });
    const stable = recordStable(streak, at(PROCESS_RUN_STABLE_AFTER_MS));
    const next = recordBoot(stable, 'run-2', at(PROCESS_RUN_STABLE_AFTER_MS + 5_000));
    expect(next.restarts).toBe(0);
    expect(next.restartsSince).toBeNull();
  });

  it('a previous life that was stopped on purpose is no crash', () => {
    const stopped = recordStopped(life({ restarts: 2, restartsSince: T0 }), at(4_000));
    const next = recordBoot(stopped, 'run-2', at(6_000));
    expect(next.restarts).toBe(0);
    expect(next.restartsSince).toBeNull();
  });

  it('restarts spread over more than the window start a new streak instead of growing the old one', () => {
    const old = life({
      restarts: 2,
      restartsSince: T0,
      startedAt: at(PROCESS_RESTART_STORM_WINDOW_MS),
    });
    const justInside = recordBoot(old, 'run-3', at(PROCESS_RESTART_STORM_WINDOW_MS));
    expect(justInside.restarts).toBe(3);
    const justOutside = recordBoot(old, 'run-3', at(PROCESS_RESTART_STORM_WINDOW_MS + 1));
    expect(justOutside.restarts).toBe(1);
    expect(justOutside.restartsSince).toEqual(old.startedAt);
  });

  it('writes a fresh life: not stable, not stopped', () => {
    const next = recordBoot(life({ stableAt: at(1), stoppedAt: at(2) }), 'run-2', at(10));
    expect(next.stableAt).toBeNull();
    expect(next.stoppedAt).toBeNull();
    expect(next.startedAt).toEqual(at(10));
  });
});

describe('endedYoung', () => {
  it('is a crash only when the life neither reached the stable mark nor was stopped', () => {
    expect(endedYoung(life())).toBe(true);
    expect(endedYoung(life({ stableAt: at(60_000) }))).toBe(false);
    expect(endedYoung(life({ stoppedAt: at(5_000) }))).toBe(false);
  });
});

describe('the marks', () => {
  it('stable and stopped both clear the streak, and keep the rest of the record', () => {
    const streak = life({ restarts: 4, restartsSince: T0 });
    expect(recordStable(streak, at(60_000))).toMatchObject({
      runId: 'run-0',
      restarts: 0,
      restartsSince: null,
      stableAt: at(60_000),
    });
    expect(recordStopped(streak, at(3_000))).toMatchObject({
      runId: 'run-0',
      restarts: 0,
      restartsSince: null,
      stoppedAt: at(3_000),
    });
  });
});

describe('the dedupe key', () => {
  it('is one condition per role', () => {
    expect(restartStormConditionKey('worker')).toBe('process.restart_storm:worker');
    expect(restartStormConditionKey('worker')).not.toBe(restartStormConditionKey('monitor'));
  });
});
