import { describe, expect, it } from 'vitest';
import { PROVIDER_FAILURE_KINDS, PROVIDER_FAILURE_RETRYABLE } from '@nexa/contracts';
import { monitorBudgetReserveFor } from '../../apps/api/src/container';

/**
 * Three rules that were stated in comments and enforced by expressions no test
 * named — the shape CLAUDE.md warns about, where a suite cannot tell three
 * successive versions of a function apart.
 */

describe('the monitor budget reserve (F7)', () => {
  it('never rounds a non-zero percentage down to nothing', () => {
    // The case the comment cites: forty percent of two floors to zero, and a
    // zero reserve is the invariant switched off exactly where it matters most.
    expect(monitorBudgetReserveFor(2, 40)).toBe(1);
    expect(monitorBudgetReserveFor(3, 10)).toBe(1);
    expect(monitorBudgetReserveFor(100, 1)).toBe(1);
  });

  it('rounds up rather than down', () => {
    // 25% of 10 is 2.5. Down is 2 and would leave the operator less than the
    // configured share; the rule is that the reserve is at least the share.
    expect(monitorBudgetReserveFor(10, 25)).toBe(3);
    expect(monitorBudgetReserveFor(60, 40)).toBe(24);
  });

  it('is at least one for every capacity the configuration permits', () => {
    // `Math.max(1, ...)` in the expression is a floor for a capacity of zero
    // and nothing else — `ceil` of any positive fraction already clears one —
    // so this asserts the PROPERTY rather than pretending the guard is what
    // produces it. Removing the guard fails no test, and that is recorded at
    // the site instead of being covered by a test that cannot fail.
    for (let capacity = 1; capacity <= 200; capacity += 1) {
      expect(monitorBudgetReserveFor(capacity, 40)).toBeGreaterThanOrEqual(1);
      expect(monitorBudgetReserveFor(capacity, 1)).toBeGreaterThanOrEqual(1);
    }
  });

  it('gives the operator the only token at capacity 1', () => {
    // Deliberate and the right way round: the monitor is refused every time and
    // the single token belongs to the operator. Monitoring is a convenience;
    // being locked out of your own panel is not.
    expect(monitorBudgetReserveFor(1, 40)).toBe(1);
  });

  it('reserves nothing only when the operator asked for nothing', () => {
    // Zero percent means zero, and ONLY zero percent does. An operator turning
    // the reserve off is not the same event as a rounding accident producing
    // none, and collapsing the two is how the floor above gets lost.
    expect(monitorBudgetReserveFor(60, 0)).toBe(0);
    expect(monitorBudgetReserveFor(1, 0)).toBe(0);
  });
});

describe('retryability has exactly one definition (P4)', () => {
  it('is stated for every failure kind the contract has', () => {
    // The property the safe-http client now depends on by reading this map
    // instead of keeping its own set: a kind added to the contract is covered
    // the moment it is added. A restatement cannot have that property, and the
    // one this replaced already disagreed about RATE_LIMITED and
    // PROVIDER_ERROR while nothing failed.
    for (const kind of PROVIDER_FAILURE_KINDS) {
      expect(typeof PROVIDER_FAILURE_RETRYABLE[kind]).toBe('boolean');
    }
    expect(Object.keys(PROVIDER_FAILURE_RETRYABLE).sort()).toEqual(
      [...PROVIDER_FAILURE_KINDS].sort(),
    );
  });

  it('names the kinds a retry could plausibly change, and no others', () => {
    // Pinned so the map cannot drift silently: a deterministic rejection
    // retried on a schedule is a credential-stuffing loop pointed at the
    // operator's own panel.
    const retryable = PROVIDER_FAILURE_KINDS.filter((k) => PROVIDER_FAILURE_RETRYABLE[k]).sort();
    expect(retryable).toEqual(['PROVIDER_ERROR', 'RATE_LIMITED', 'TIMEOUT', 'UNREACHABLE']);
  });

  it('does not retry anything that is about a credential', () => {
    expect(PROVIDER_FAILURE_RETRYABLE.AUTHENTICATION_FAILED).toBe(false);
    expect(PROVIDER_FAILURE_RETRYABLE.AUTHENTICATION_REQUIRES_INTERACTION).toBe(false);
  });
});

/**
 * The safe-http client must not carry a second answer to the same question.
 * Read from the SOURCE, because the divergence this replaced was invisible at
 * runtime: `maxRetries` ships as 0, so the loop that consults it never reaches
 * a second attempt and no behavioural test could have seen the difference.
 */
describe('the safe-http client does not restate retryability (P4)', () => {
  it('reads the contract map rather than a local set', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(
      new URL('../../apps/api/src/infrastructure/net/safe-http.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain('PROVIDER_FAILURE_RETRYABLE');
    // The exact shape that was there, and the shape any future restatement
    // would take: a hand-written set of kinds.
    expect(source).not.toMatch(/new Set<ProviderFailureKind>\(\[/);
  });
});
