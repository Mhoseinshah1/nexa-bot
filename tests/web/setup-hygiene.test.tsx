import { describe, expect, it, vi } from 'vitest';

/**
 * The shared `afterEach` in `setup.ts`, tested rather than assumed.
 *
 * Every test that installs fake timers restores them as its LAST statement,
 * which a failing assertion skips — so the test after a failure ran on a clock
 * nothing was advancing. That matters most exactly where it is hardest to see:
 * a mutation run, where the first failure is EXPECTED and every test after it
 * is the evidence that the mutation killed nothing else.
 *
 * `restoreMocks` covers spies and `unstubAllGlobals` covers globals; neither
 * covers timers. This pair is the only thing holding that third line in place,
 * and it works by leaving the damage behind on purpose: the first test installs
 * fake timers and does NOT restore them, exactly as a failing test would.
 *
 * Vitest runs the tests of one file in order, so the second observes what the
 * first left — which is the whole point.
 */
describe('the web test setup', () => {
  it('leaves fake timers installed, as a failing test would', () => {
    vi.useFakeTimers();
    expect(vi.isFakeTimers()).toBe(true);
  });

  it('starts the next test on real timers anyway', () => {
    expect(vi.isFakeTimers()).toBe(false);
  });
});
