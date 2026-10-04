import { describe, expect, it } from 'vitest';
import {
  decideLegacyTrial,
  legacyTrialInputHash,
  normaliseLegacyLimit,
} from '../../apps/api/src/modules/commerce/trials/application/legacy-trial-eligibility';

/**
 * Program Item 15: the legacy trial decision table
 * (`docs/legacy-migration/trial-eligibility.md` §2), pinned row by row. Q2 of
 * `docs/legacy-migration/sql-evidence.md` is the population each row will meet.
 */
describe('decideLegacyTrial', () => {
  it('limit 0 means no trials, whether or not one was had', () => {
    for (const hadTrial of [false, true]) {
      expect(decideLegacyTrial({ limitUsertest: 0, hadTrial }, null)).toEqual({
        decision: 'LEGACY_NO_TRIALS',
        legacyLimit: 0,
        overrideAfter: 0,
      });
    }
    expect(decideLegacyTrial({ limitUsertest: '-3', hadTrial: false }, null).overrideAfter).toBe(0);
  });

  it('allowed and already used is consumed — limit 1 is not evidence of an unused trial', () => {
    for (const limit of [1, '1', 9]) {
      expect(decideLegacyTrial({ limitUsertest: limit, hadTrial: true }, null)).toMatchObject({
        decision: 'LEGACY_TRIAL_CONSUMED',
        overrideAfter: 0,
      });
    }
  });

  it('allowed with no evidence of use writes no override and defers to NEXA policy', () => {
    for (const limit of [1, 9]) {
      expect(decideLegacyTrial({ limitUsertest: limit, hadTrial: false }, null)).toEqual({
        decision: 'INHERIT_NEXA_POLICY',
        legacyLimit: limit,
        overrideAfter: null,
      });
    }
  });

  it('an unreadable limit is no trials, never a fresh one', () => {
    for (const raw of [null, '', 'one', '1.5', 1.5, '99999999999']) {
      expect(decideLegacyTrial({ limitUsertest: raw, hadTrial: false }, null)).toEqual({
        decision: 'LEGACY_LIMIT_UNREADABLE',
        legacyLimit: null,
        overrideAfter: 0,
      });
    }
  });

  it('keeps an existing NEXA override exactly, in either direction — never loosened, never rewritten', () => {
    expect(decideLegacyTrial({ limitUsertest: 0, hadTrial: true }, 3)).toMatchObject({
      decision: 'KEPT_EXISTING_OVERRIDE',
      overrideAfter: 3,
    });
    expect(decideLegacyTrial({ limitUsertest: 1, hadTrial: false }, 0)).toMatchObject({
      decision: 'KEPT_EXISTING_OVERRIDE',
      overrideAfter: 0,
    });
  });

  it('never yields an override above zero of its own making', () => {
    for (const limit of [null, -1, 0, 1, 2, 9, 'x']) {
      for (const hadTrial of [false, true]) {
        const after = decideLegacyTrial({ limitUsertest: limit, hadTrial }, null).overrideAfter;
        expect(after === null || after === 0).toBe(true);
      }
    }
  });
});

describe('decideLegacyTrial — the whole table, as literal rows', () => {
  /*
   * The table of `docs/legacy-migration/trial-eligibility.md` §2 written out by hand, so
   * the rule is pinned by an oracle that is not the code. Columns: the existing NEXA
   * override, `limit_usertest`, whether an `is_test = 1` invoice existed, then the
   * decision and the override it leaves. Row 5 (limit ≥ 1, no test invoice) is the
   * current OQ-I15-01 default: no override, NEXA policy.
   */
  const rows: readonly [number | null, string | number | null, boolean, string, number | null][] = [
    // 1. an existing NEXA override wins over every legacy fact, in either direction
    [3, 0, true, 'KEPT_EXISTING_OVERRIDE', 3],
    [3, null, false, 'KEPT_EXISTING_OVERRIDE', 3],
    [0, 1, false, 'KEPT_EXISTING_OVERRIDE', 0],
    [1, 1, true, 'KEPT_EXISTING_OVERRIDE', 1],
    // 2. unreadable limit: no trials
    [null, null, false, 'LEGACY_LIMIT_UNREADABLE', 0],
    [null, 'x', true, 'LEGACY_LIMIT_UNREADABLE', 0],
    [null, '1.0', false, 'LEGACY_LIMIT_UNREADABLE', 0],
    // 3. limit_usertest = 0 (or below): no trials, whatever the history
    [null, 0, false, 'LEGACY_NO_TRIALS', 0],
    [null, '0', true, 'LEGACY_NO_TRIALS', 0],
    [null, -1, false, 'LEGACY_NO_TRIALS', 0],
    // 4. allowed, and is_test = 1 history: consumed
    [null, 1, true, 'LEGACY_TRIAL_CONSUMED', 0],
    [null, ' 1 ', true, 'LEGACY_TRIAL_CONSUMED', 0],
    [null, 9, true, 'LEGACY_TRIAL_CONSUMED', 0],
    // 5. limit_usertest = 1 alone is not proof of an unused trial — it only defers to
    //    NEXA's own policy (which counts any NEXA grant), never pins a fresh allowance
    [null, 1, false, 'INHERIT_NEXA_POLICY', null],
    [null, 2, false, 'INHERIT_NEXA_POLICY', null],
    [null, 9, false, 'INHERIT_NEXA_POLICY', null],
  ];

  it.each(rows)(
    'override %o, limit_usertest %o, had trial %o → %s (override after %o)',
    (existing, limit, hadTrial, decision, overrideAfter) => {
      expect(decideLegacyTrial({ limitUsertest: limit, hadTrial }, existing)).toMatchObject({
        decision,
        overrideAfter,
      });
    },
  );

  it('no row of the rule grants a per-customer allowance above zero', () => {
    for (const [existing, limit, hadTrial] of rows) {
      if (existing !== null) continue;
      const after = decideLegacyTrial({ limitUsertest: limit, hadTrial }, null).overrideAfter;
      expect(after === null || after === 0).toBe(true);
    }
  });
});

describe('normaliseLegacyLimit and the input hash', () => {
  it('reads whole numbers only', () => {
    expect(normaliseLegacyLimit(' 9 ')).toBe(9);
    expect(normaliseLegacyLimit(-2)).toBe(-2);
    expect(normaliseLegacyLimit('1e1')).toBeNull();
  });

  it('hashes the facts, so equal facts in other spellings are one input', () => {
    expect(legacyTrialInputHash({ limitUsertest: '1', hadTrial: true })).toBe(
      legacyTrialInputHash({ limitUsertest: 1, hadTrial: true }),
    );
    expect(legacyTrialInputHash({ limitUsertest: 1, hadTrial: true })).not.toBe(
      legacyTrialInputHash({ limitUsertest: 1, hadTrial: false }),
    );
    expect(legacyTrialInputHash({ limitUsertest: 1, hadTrial: true })).toMatch(/^[0-9a-f]{64}$/u);
  });
});
