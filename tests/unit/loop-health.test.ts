import { describe, expect, it } from 'vitest';
import {
  stalledLoops,
  type LoopHealth,
} from '../../apps/api/src/infrastructure/lifecycle/loop-health';

/**
 * The worker's readiness verdict, as a function.
 *
 * `tests/unit/worker-health-coverage.test.ts` proves every freshness-bearing
 * loop is NAMED in the check. It reads the source, so it cannot prove the check
 * then does anything with what it reads — and it did not: replacing the
 * aggregation with an empty array made the worker report healthy with every
 * loop dead, and the whole suite stayed green. The comment above it said the
 * aggregation "needs no test".
 *
 * The two tests are complementary and neither is redundant: one is about
 * coverage of the list, this one is about what the list is for.
 */
describe('stalled loops', () => {
  const fresh = (name: string): LoopHealth => [name, true, () => true];
  const stale = (name: string): LoopHealth => [name, true, () => false];

  it('is empty when every enabled loop is fresh', () => {
    // Healthy is the common case and it must be reachable, or a worker that is
    // working reports otherwise and an operator learns to ignore the signal.
    expect(stalledLoops([fresh('relay'), fresh('session-sweeper')])).toEqual([]);
  });

  it('names a loop that has stopped making progress', () => {
    // The whole point. A worker with a dead dispatcher must not report healthy:
    // the dispatcher drains the queue by which the installation says anything is
    // wrong, so its silence is indistinguishable from nothing being wrong.
    expect(stalledLoops([fresh('relay'), stale('notification-dispatcher')])).toEqual([
      'notification-dispatcher',
    ]);
  });

  it('names every stalled loop, not the first', () => {
    // An operator reading one name fixes one loop and redeploys into the same
    // failure. The log line is the diagnosis, so it has to be complete.
    expect(
      stalledLoops([stale('relay'), fresh('session-sweeper'), stale('backup-scheduler')]),
    ).toEqual(['relay', 'backup-scheduler']);
  });

  it('treats a disabled loop as healthy rather than as broken', () => {
    // A disabled loop never had `begin()` called, so its `isFresh` is false for
    // ever. Read as a failure, a deployment with the relay switched off would be
    // permanently unhealthy — so this direction matters as much as the other.
    expect(stalledLoops([['relay', false, () => false]])).toEqual([]);
  });

  it('does not consult a disabled loop at all', () => {
    // Not merely ignored after the fact. Reading `isFresh` on a loop that was
    // never started is reading a value that means "no claim", and a future
    // implementation is free to make that read assert or do work.
    let asked = 0;
    const result = stalledLoops([
      [
        'relay',
        false,
        () => {
          asked += 1;
          return false;
        },
      ],
    ]);
    expect(result).toEqual([]);
    expect(asked).toBe(0);
  });
});
