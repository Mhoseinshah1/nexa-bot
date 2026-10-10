import { describe, expect, it } from 'vitest';
import {
  GATEWAY_INQUIRY_HEALTH_DEFAULTS,
  GatewayInquiryHealth,
} from '../../apps/api/src/modules/commerce/payments/application/gateway-inquiry-health';

/**
 * FIX-03 (batch 2026-10-10): when a gateway's inquiries keep failing, and only then, the
 * failing condition is recorded; an answer resets the count and asks for the close.
 */
describe('GatewayInquiryHealth', () => {
  const options = { threshold: 3, windowMs: 1_000, recheckMs: 500 };

  it('opens only at the threshold, inside the window, and re-records at most once a window', () => {
    const health = new GatewayInquiryHealth(options);
    expect(health.failure('TONPAYS', 0)).toBe(false);
    expect(health.failure('TONPAYS', 100)).toBe(false);
    expect(health.failure('TONPAYS', 200)).toBe(true);
    // Still failing: the row's counter is the record, not a second message.
    expect(health.failure('TONPAYS', 300)).toBe(false);
    expect(health.failure('TONPAYS', 900)).toBe(false);
    expect(health.failure('TONPAYS', 1_100)).toBe(false);
    // A window after the last record, and still failing: recorded again.
    expect(health.failure('TONPAYS', 1_250)).toBe(true);
  });

  it('forgets failures older than the window, so occasional ones never add up', () => {
    const health = new GatewayInquiryHealth(options);
    expect(health.failure('TONPAYS', 0)).toBe(false);
    expect(health.failure('TONPAYS', 600)).toBe(false);
    expect(health.failure('TONPAYS', 1_200)).toBe(false);
    expect(health.failure('TONPAYS', 1_700)).toBe(false);
    expect(health.failure('TONPAYS', 1_800)).toBe(true);
  });

  it('counts each gateway on its own', () => {
    const health = new GatewayInquiryHealth(options);
    health.failure('TONPAYS', 0);
    health.failure('TONPAYS', 1);
    expect(health.failure('NOWPAYMENTS', 2)).toBe(false);
    expect(health.failure('TONPAYS', 3)).toBe(true);
  });

  it('resets on an answer, and asks for the close after failures and at most once per recheck otherwise', () => {
    const health = new GatewayInquiryHealth(options);
    health.failure('TONPAYS', 0);
    health.failure('TONPAYS', 1);
    expect(health.success('TONPAYS', 2)).toBe(true);
    // The count started again: two more failures are not three.
    expect(health.failure('TONPAYS', 3)).toBe(false);
    expect(health.failure('TONPAYS', 4)).toBe(false);
    expect(health.success('TONPAYS', 5)).toBe(true);
    // Healthy: no read of the operations log on every answer.
    expect(health.success('TONPAYS', 100)).toBe(false);
    expect(health.success('TONPAYS', 600)).toBe(true);
    health.forgetCheck('TONPAYS');
    expect(health.success('TONPAYS', 601)).toBe(true);
  });

  it('checks once on the first answer after a restart, to close what another life opened', () => {
    expect(new GatewayInquiryHealth(options).success('TONPAYS', 0)).toBe(true);
    expect(GATEWAY_INQUIRY_HEALTH_DEFAULTS.threshold).toBeGreaterThan(1);
  });
});
