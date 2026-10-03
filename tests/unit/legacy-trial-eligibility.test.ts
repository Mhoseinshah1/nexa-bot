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
