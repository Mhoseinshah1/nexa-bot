import { describe, expect, it } from 'vitest';
import { executeTrialResetRequestSchema, trialResetPreviewResponseSchema } from '@nexa/contracts';

/**
 * The global trial reset's confirmation binds to a SET, not a count (Codex, PR #65).
 *
 * A count alone let a preview authorise a different reset: one previewed grant released
 * and another customer's claimed leaves the number unchanged. The preview carries the
 * set's fingerprint and the confirmation must carry it back; these pin that neither
 * half can be dropped at the boundary.
 */
describe('the trial reset confirmation', () => {
  const fingerprint = '0123456789abcdef0123456789abcdef';

  it('refuses a confirmation that carries only the count', () => {
    expect(
      executeTrialResetRequestSchema.safeParse({
        idempotencyKey: 'reset-key-1',
        expectedGrants: 2,
        reason: 'new season',
      }).success,
    ).toBe(false);
    expect(
      executeTrialResetRequestSchema.safeParse({
        idempotencyKey: 'reset-key-1',
        expectedGrants: 2,
        expectedFingerprint: fingerprint,
        reason: 'new season',
      }).success,
    ).toBe(true);
  });

  it('accepts only a 32-character lowercase hex fingerprint', () => {
    for (const bad of ['', 'ABCDEF0123456789ABCDEF0123456789', `${fingerprint}0`, 'x'.repeat(32)]) {
      expect(
        executeTrialResetRequestSchema.safeParse({
          idempotencyKey: 'reset-key-1',
          expectedGrants: 2,
          expectedFingerprint: bad,
          reason: 'new season',
        }).success,
        bad,
      ).toBe(false);
    }
  });

  it('requires the preview to state the fingerprint it describes', () => {
    expect(
      trialResetPreviewResponseSchema.safeParse({
        preview: { affectedGrants: 0, affectedCustomers: 0, sample: [] },
      }).success,
    ).toBe(false);
  });
});
