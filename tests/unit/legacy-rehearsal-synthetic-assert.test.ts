import { describe, expect, it } from 'vitest';
import {
  EXPECTED_PENDING,
  assertSynthetic,
} from '../../scripts/legacy-rehearsal-synthetic-assert.mjs';

/**
 * WP-D6 — the synthetic rehearsal's gate: 0 FAIL and EXACTLY the fixture's PENDING checks.
 */
type Check = { cycle: number; check: string; result: string; expected: string; actual: string };

function summary(over: Partial<Record<string, unknown>> = {}, extra: Check[] = []) {
  const checks: Check[] = [];
  for (const cycle of [1, 2]) {
    checks.push({ cycle, check: 'customer_closure', result: 'PASS', expected: '10', actual: '10' });
    for (const check of EXPECTED_PENDING) {
      checks.push({ cycle, check, result: 'PENDING', expected: '0', actual: '1' });
    }
  }
  checks.push(...extra);
  return {
    evidenceClass: 'synthetic',
    notEvidence: true,
    cycles: 2,
    checksFailed: 0,
    checksPending: checks.filter((c) => c.result === 'PENDING').length,
    checks,
    pendingDecisions: checks
      .filter((c) => c.result === 'PENDING')
      .map((c) => ({ cycle: c.cycle, check: c.check, decision: null })),
    ...over,
  };
}

describe('assertSynthetic', () => {
  it('accepts 0 FAIL with exactly the known PENDING in every cycle', () => {
    expect(assertSynthetic(summary())).toEqual([]);
  });

  it('refuses a failed check, naming it', () => {
    const s = summary({ checksFailed: 1 }, [
      { cycle: 2, check: 'no_duplicate_openings', result: 'FAIL', expected: '0', actual: '6' },
    ]);
    expect(assertSynthetic(s)).toEqual([
      'checksFailed 1: c2 no_duplicate_openings (expected 0, got 6)',
    ]);
  });

  it('refuses ONE MORE pending check: a new undecided population is a regression too', () => {
    const s = summary({}, [
      { cycle: 1, check: 'adoption_pending_p6', result: 'PENDING', expected: '0', actual: '4' },
    ]);
    expect(assertSynthetic(s)).toContain('unexpected PENDING: 1:adoption_pending_p6');
  });

  it('refuses one FEWER: a known case that stopped being detected', () => {
    const s = summary();
    s.checks = s.checks.map((c) =>
      c.cycle === 2 && c.check === 'report_equation_C3' ? { ...c, result: 'PASS' } : c,
    );
    expect(assertSynthetic(s)).toContain('expected PENDING not recorded: 2:report_equation_C3');
  });

  it('refuses a staging summary, and a decision the harness recorded by itself', () => {
    expect(assertSynthetic(summary({ evidenceClass: 'staging', notEvidence: false }))[0]).toMatch(
      /^not a synthetic summary/u,
    );
    const s = summary();
    s.pendingDecisions = s.pendingDecisions.map((d) => ({ ...d, decision: 'ACCEPTED' as never }));
    expect(assertSynthetic(s)).toContain(
      'a synthetic pendingDecisions entry carries a decision; only the owner records one',
    );
  });
});
