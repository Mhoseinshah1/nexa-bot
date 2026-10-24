import { describe, expect, it } from 'vitest';
import {
  failureStatusOf,
  paymentFailureOutcome,
} from '../../apps/api/src/modules/commerce/payments/domain/payment-failure-outcome';

/** R8 A3 — the outcome a `PaymentFailed` was, from the payment's resolution note. */
describe('paymentFailureOutcome', () => {
  const gateway = (note: string | null, cancelRequest: { byNexa: boolean } | null = null) =>
    paymentFailureOutcome({ cause: 'GATEWAY_FAILED', resolutionNote: note, cancelRequest });

  it('reads the status part of `<provider>:<status>[:…]`', () => {
    expect(failureStatusOf('tonpays:expired')).toBe('expired');
    expect(failureStatusOf('tonpays_telegram:nexa.credential_missing')).toBe(
      'nexa.credential_missing',
    );
    expect(failureStatusOf('a:b:paid:late_credited')).toBe('b');
    expect(failureStatusOf('no-colon')).toBeNull();
    expect(failureStatusOf('x:')).toBeNull();
    expect(failureStatusOf(null)).toBeNull();
  });

  it('an operator’s rejection is a rejected receipt, whatever its note says', () => {
    expect(paymentFailureOutcome({ cause: 'REJECTED', resolutionNote: 'tonpays:expired' })).toEqual(
      { kind: 'RECEIPT_REJECTED', by: 'OPERATOR' },
    );
  });

  it('cancelled: by the customer, by Nexa, or in the gateway', () => {
    expect(gateway('tonpays_telegram:canceled_by_customer')).toEqual({
      kind: 'CANCELLED',
      by: 'CUSTOMER',
    });
    expect(gateway('tonpays_telegram:canceled_by_nexa')).toEqual({ kind: 'CANCELLED', by: 'NEXA' });
    expect(gateway('tonpays:canceled')).toEqual({ kind: 'CANCELLED', by: 'PROVIDER' });
    expect(gateway('tonpays:canceled', { byNexa: false })).toEqual({
      kind: 'CANCELLED',
      by: 'CUSTOMER',
    });
    expect(gateway('tonpays:cancelled', { byNexa: true })).toEqual({
      kind: 'CANCELLED',
      by: 'NEXA',
    });
  });

  it('expired, a gateway-rejected receipt, and every other code a failure carrying it', () => {
    expect(gateway('tetrapay:expired')).toEqual({ kind: 'EXPIRED' });
    expect(gateway('tonpays:rejected')).toEqual({ kind: 'RECEIPT_REJECTED', by: 'PROVIDER' });
    expect(gateway('nowpayments:partially_paid')).toEqual({
      kind: 'FAILED',
      code: 'partially_paid',
    });
    expect(gateway(null)).toEqual({ kind: 'FAILED', code: null });
  });
});
