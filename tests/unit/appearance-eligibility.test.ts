import { describe, expect, it } from 'vitest';
import { APPEARANCE_TEST_OUTCOMES } from '@nexa/contracts';
import { isCustomEmojiEligible } from '../../apps/api/src/modules/control/appearance/application/eligibility';

/**
 * Round T, F-4 (`docs/round-t-final-review.md`): the builder's "eligible" and the runtime's
 * decoration are one predicate. Only a recorded `SENT` makes a bot eligible; an untested
 * bot, an unknown bot and every other recorded outcome do not.
 */
describe('custom emoji eligibility', () => {
  it('is true for a recorded SENT and for nothing else', () => {
    const testedAt = new Date('2026-10-02T00:00:00Z');
    for (const outcome of APPEARANCE_TEST_OUTCOMES) {
      expect({
        outcome,
        eligible: isCustomEmojiEligible({ test: { testedAt, outcome, errorCode: null } }),
      }).toEqual({ outcome, eligible: outcome === 'SENT' });
    }
    expect(isCustomEmojiEligible({ test: null })).toBe(false);
    expect(isCustomEmojiEligible(undefined)).toBe(false);
  });
});
