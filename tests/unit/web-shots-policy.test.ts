import { describe, expect, it } from 'vitest';
import { needsTypeStripping, shotProblems } from '../../scripts/web-shots/policy.mjs';

describe('pnpm web:shots on the minimum supported Node', () => {
  it('re-runs with type stripping where it is off (22.11–22.17), and not where it is on', () => {
    // What 22.11–22.17 report without the flag.
    expect(needsTypeStripping({ typescript: false })).toBe(true);
    // Older shapes that carry no such feature at all.
    expect(needsTypeStripping({})).toBe(true);
    expect(needsTypeStripping(undefined)).toBe(true);
    // 22.18+ by default, or any version with the flag.
    expect(needsTypeStripping({ typescript: 'strip' })).toBe(false);
    expect(needsTypeStripping({ typescript: 'transform' })).toBe(false);
  });
});

describe('what a capture reports', () => {
  const clean = {
    unfixtured: [],
    settled: true,
    stillLoading: false,
    errorStates: 0,
    horizontalOverflow: 0,
    errors: [],
  };

  it('certifies a settled, clean capture', () => {
    expect(shotProblems(clean)).toEqual([]);
  });

  it('warns about a capture whose requests never went quiet, even with nothing on screen', () => {
    const problems = shotProblems({ ...clean, settled: false, timeoutMs: 15000 });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('never settled within 15000ms');
  });

  it('names every other problem too', () => {
    const problems = shotProblems({
      unfixtured: ['GET /api/x'],
      settled: true,
      stillLoading: true,
      errorStates: 2,
      horizontalOverflow: 12,
      errors: ['boom'],
    });
    expect(problems).toHaveLength(5);
  });
});
