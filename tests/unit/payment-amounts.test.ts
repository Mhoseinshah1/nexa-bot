import { describe, expect, it } from 'vitest';
import {
  PAYMENT_METHODS,
  PAYMENT_STATES,
  gatewayCustomerFeeMinor,
  paymentAmountsOf,
  type PaymentAmountsInput,
} from '@nexa/contracts';

/**
 * Roadmap E4 — one payment's money as ONE breakdown (`payment-amounts.ts`).
 *
 * What this file defends: the gateway fee (the customer surcharge) is never credited,
 * never refundable and never part of the principal; what the customer paid is principal
 * plus fee and nothing else; money counts as received only when confirmed and from outside;
 * a partial or late payment (never confirmed) has received nothing and can refund nothing;
 * and merchant net is never invented.
 */

const fee = (principal: bigint, bps: number) => {
  const feeMinor = gatewayCustomerFeeMinor(principal, bps);
  return { basisPoints: bps, feeMinor, payableMinor: principal + feeMinor };
};

const base: PaymentAmountsInput = {
  state: 'CONFIRMED',
  method: 'GATEWAY',
  topup: false,
  principalMinor: 250_000n,
  customerFee: fee(250_000n, 250),
  receiptCreditMinor: null,
};

describe('the payment money breakdown', () => {
  it('keeps the gateway fee beside the principal: paid by the customer, never refundable', () => {
    const amounts = paymentAmountsOf(base);
    expect(amounts.customerFeeMinor).toBe(6_250n);
    expect(amounts.customerFeeBasisPoints).toBe(250);
    expect(amounts.customerPaidMinor).toBe(256_250n);
    expect(amounts.receivedMinor).toBe(256_250n);
    expect(amounts.refundCeilingMinor).toBe(250_000n);
    expect(amounts.walletCreditMinor).toBe(0n);
  });

  it('credits a gateway top-up with the principal only, never the fee', () => {
    const amounts = paymentAmountsOf({ ...base, topup: true });
    expect(amounts.walletCreditMinor).toBe(250_000n);
    expect(amounts.customerPaidMinor).toBe(256_250n);
  });

  it('reads a payment with no fee snapshot as fee zero and paid equal to the principal', () => {
    const amounts = paymentAmountsOf({ ...base, method: 'MANUAL_TRANSFER', customerFee: null });
    expect(amounts.customerFeeMinor).toBe(0n);
    expect(amounts.customerFeeBasisPoints).toBeNull();
    expect(amounts.customerPaidMinor).toBe(250_000n);
    expect(amounts.receivedMinor).toBe(250_000n);
  });

  it('treats a wallet settlement as a wallet debit, not money received from outside', () => {
    const amounts = paymentAmountsOf({ ...base, method: 'WALLET', customerFee: null });
    expect(amounts.receivedMinor).toBe(0n);
    expect(amounts.walletDebitMinor).toBe(250_000n);
    expect(amounts.refundCeilingMinor).toBe(250_000n);
  });

  it('counts nothing received and nothing refundable for a partial or late payment that never confirmed', () => {
    for (const state of ['UNKNOWN', 'FAILED', 'EXPIRED'] as const) {
      const amounts = paymentAmountsOf({ ...base, state });
      expect(amounts.receivedMinor, state).toBe(0n);
      expect(amounts.refundCeilingMinor, state).toBe(0n);
      expect(amounts.walletCreditMinor, state).toBe(0n);
      // What the customer was ASKED to pay is still shown, as it was frozen.
      expect(amounts.customerPaidMinor, state).toBe(256_250n);
    }
  });

  it('shows a reviewer’s receipt credit as the wallet credit of a FAILED transfer', () => {
    const amounts = paymentAmountsOf({
      ...base,
      state: 'FAILED',
      method: 'MANUAL_TRANSFER',
      customerFee: null,
      receiptCreditMinor: 120_000n,
    });
    expect(amounts.walletCreditMinor).toBe(120_000n);
    expect(amounts.receivedMinor).toBe(0n);
    expect(amounts.refundCeilingMinor).toBe(0n);
  });

  it('never invents merchant net', () => {
    const amounts = paymentAmountsOf(base);
    expect(amounts.merchantNetMinor).toBeNull();
    expect(amounts.merchantNetReason).toBe('NOT_RECORDED');
  });

  it('holds its invariants over every state, method, fee rate and kind', () => {
    for (const state of PAYMENT_STATES) {
      for (const method of PAYMENT_METHODS) {
        for (const bps of [null, 0, 1, 250, 9_999, 10_000]) {
          for (const topup of [false, true]) {
            for (const principal of [1n, 999n, 250_000n, 1_000_000_007n]) {
              const a = paymentAmountsOf({
                state,
                method,
                topup,
                principalMinor: principal,
                customerFee: bps === null ? null : fee(principal, bps),
                receiptCreditMinor: null,
              });
              expect(a.customerPaidMinor).toBe(a.principalMinor + a.customerFeeMinor);
              expect([0n, a.customerPaidMinor]).toContain(a.receivedMinor);
              expect(a.refundCeilingMinor <= a.principalMinor).toBe(true);
              expect(a.walletCreditMinor <= a.principalMinor).toBe(true);
              if (state !== 'CONFIRMED') {
                expect(a.receivedMinor + a.refundCeilingMinor + a.walletDebitMinor).toBe(0n);
              }
            }
          }
        }
      }
    }
  });
});
