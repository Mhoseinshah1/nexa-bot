import { describe, expect, it } from 'vitest';
import { LoopProgress } from '../../apps/api/src/infrastructure/lifecycle/loop-progress';

/**
 * Whether a background loop is still doing its job.
 *
 * Every case here is a state the worker's health check must distinguish, and
 * the two that matter are the ones a naive implementation gets wrong in
 * opposite directions: a loop that has started but not yet ticked is NOT a
 * failure, and a loop whose ticks are all throwing IS one even though its timer
 * is alive and its process is fine.
 */
describe('loop progress', () => {
  const INTERVAL = 1_000;
  const SLACK = INTERVAL * 3;

  it('is not fresh before it has started', () => {
    // A loop that was never started makes no claim, so it cannot be healthy.
    // This is what stops a disabled loop from reporting as a working one.
    expect(new LoopProgress(INTERVAL).isFresh(0)).toBe(false);
  });

  it('is fresh from the moment it starts, for one slack window', () => {
    const progress = new LoopProgress(INTERVAL);
    progress.begin(0);
    // The startup grace. Before the first tick is even due, no progress is
    // evidence of a process that started a moment ago, not of a broken loop —
    // and a strict rule here would report a fresh deploy as unhealthy, which is
    // a different lie rather than a stricter truth.
    expect(progress.isFresh(0)).toBe(true);
    expect(progress.isFresh(SLACK)).toBe(true);
    expect(progress.isFresh(SLACK + 1)).toBe(false);
  });

  it('measures from the last completed tick once one has happened', () => {
    const progress = new LoopProgress(INTERVAL);
    progress.begin(0);
    progress.record(SLACK);
    // The grace is spent, and the tick renews it.
    expect(progress.isFresh(SLACK + 1)).toBe(true);
    expect(progress.isFresh(SLACK * 2)).toBe(true);
    expect(progress.isFresh(SLACK * 2 + 1)).toBe(false);
  });

  it('goes stale when ticks stop, even though nothing threw at the caller', () => {
    // The failure this whole class exists for: a live timer achieving nothing.
    const progress = new LoopProgress(INTERVAL);
    progress.begin(0);
    progress.record(100);
    expect(progress.isFresh(100 + SLACK)).toBe(true);
    expect(progress.isFresh(100 + SLACK + 1)).toBe(false);
  });

  it('is not fresh once stopped', () => {
    const progress = new LoopProgress(INTERVAL);
    progress.begin(0);
    progress.record(10);
    progress.end();
    // A draining worker must not look like a working one for a slack window.
    expect(progress.isFresh(11)).toBe(false);
  });

  it('scales its tolerance with the loop own interval', () => {
    // An hourly sweeper and a 50ms relay cannot share a fixed threshold: one
    // would flap, the other would take hours to notice a dead loop.
    const fast = new LoopProgress(50);
    const slow = new LoopProgress(3_600_000);
    fast.begin(0);
    slow.begin(0);
    expect(fast.isFresh(151)).toBe(false);
    expect(slow.isFresh(151)).toBe(true);
  });
});
