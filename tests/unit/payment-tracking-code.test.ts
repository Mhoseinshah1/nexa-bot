import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  operationIdFrom,
  paymentTrackingCode,
  PAYMENT_TRACKING_CODE_PATTERN,
  trackingCodeFromSearch,
} from '@nexa/contracts';

/**
 * FIX-02: the public tracking code is the operation-id half of a payment's stored
 * reference, and the derivation lives in ONE function.
 */
const sha256 = (input: string) => createHash('sha256').update(input, 'utf8').digest('hex');

/** Every role `PaymentService.referenceFor` writes a PAYMENT row under. */
const PAYMENT_ROLES = ['manual', 'topup', 'gateway', 'gateway-topup', 'wallet'] as const;

describe('paymentTrackingCode', () => {
  it('strips every role suffix a payment is written with, and only that', () => {
    for (const role of PAYMENT_ROLES) {
      expect(paymentTrackingCode(`7d433a363380f69e:${role}`)).toBe('7d433a363380f69e');
    }
  });

  it('is the operation id the reference was derived from, for a real derived key', () => {
    const operationId = operationIdFrom('payment', 'tg:42:topup:1', sha256);
    const code = paymentTrackingCode(`${operationId}:topup`);
    expect(code).toBe(operationId);
    expect(PAYMENT_TRACKING_CODE_PATTERN.test(code)).toBe(true);
  });

  it('never leaves a suffix, a colon or a role name in the code', () => {
    for (const role of PAYMENT_ROLES) {
      const code = paymentTrackingCode(`0123456789abcdef:${role}`);
      expect(code).not.toContain(':');
      expect(code).not.toContain(role);
    }
  });

  it('is stable: the same reference always gives the same code', () => {
    const reference = 'aaaaaaaaaaaaaaaa:gateway';
    expect(paymentTrackingCode(reference)).toBe(paymentTrackingCode(reference));
  });

  it('returns a reference of any other shape unchanged rather than guessing a cut', () => {
    // Backward compatibility: nothing writes these, but a row is not a promise.
    expect(paymentTrackingCode('LEGACY-123')).toBe('LEGACY-123');
    expect(paymentTrackingCode('abc:topup')).toBe('abc:topup');
    expect(paymentTrackingCode('7d433a363380f69e')).toBe('7d433a363380f69e');
    expect(paymentTrackingCode('7D433A363380F69E:topup')).toBe('7D433A363380F69E:topup');
  });
});

describe('trackingCodeFromSearch', () => {
  it('accepts a code, retyped in capitals or padded with spaces', () => {
    expect(trackingCodeFromSearch('7d433a363380f69e')).toBe('7d433a363380f69e');
    expect(trackingCodeFromSearch('  7D433A363380F69E ')).toBe('7d433a363380f69e');
  });

  it('reduces an old suffixed reference to its code', () => {
    expect(trackingCodeFromSearch('7d433a363380f69e:topup')).toBe('7d433a363380f69e');
    expect(trackingCodeFromSearch('7d433a363380f69e:gateway-topup')).toBe('7d433a363380f69e');
  });

  it('is null for anything that is not a code', () => {
    expect(trackingCodeFromSearch('7d433a363380f69')).toBeNull();
    expect(trackingCodeFromSearch('7d433a363380f69e0')).toBeNull();
    expect(trackingCodeFromSearch('zzzzzzzzzzzzzzzz')).toBeNull();
    expect(trackingCodeFromSearch('@someone')).toBeNull();
  });
});
