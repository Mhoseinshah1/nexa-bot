import { describe, expect, it } from 'vitest';
import {
  RIALIT_AMOUNT_MAX_TOMAN,
  RIALIT_AMOUNT_MIN_TOMAN,
  RIALIT_ORDER_ID_PATTERN,
  money,
} from '@nexa/contracts';
import {
  parseTomanAmount,
  rialitAmountOf,
  rialitAmountRefusal,
  rialitJudgement,
  rialitLinkDeadline,
  rialitOrderId,
  rialitPayPageUrl,
  rialitPayerCheck,
} from '../../apps/api/src/modules/commerce/payments/domain/rialit';

/**
 * The Rialit rules that decide anything (`docs/rialit-gateway-audit.md`), pure. Figures are
 * the owner-provided Rialit API document's own examples (amount 250000, order-1042).
 *
 * MUTATION (each reverted alone, the named test failed, restored with git checkout):
 *  - `rialitJudgement` returning UNSUCCESSFUL for `expired`/`cancelled` -> 'expired and
 *    cancelled are OPEN, never a failure' (and the adapter's 'pending, expired and cancelled…');
 *  - the both-charge guard (`nexaFeeCharged && payerFee > 0n`) removed -> 'both sides charging';
 *  - the `payer_amount = amount + payer_fee` check removed -> 'figures that do not add up'
 *    (and the adapter's 'payer figures that do not add up…');
 *  - the adapter's local range check removed -> 'refuses out of range BEFORE any call'.
 */

const ORDER = 'order-1042';
const expected = { orderId: ORDER, sentAmount: 250_000n };
const paid = {
  status: 'paid',
  orderId: ORDER,
  amount: 250_000,
  payerAmount: 250_000,
  payerFee: 0,
};

describe('Toman, the one unit', () => {
  it('takes IRT as is and IRR only when it is a whole Toman', () => {
    expect(rialitAmountOf(money(250_000n, 'IRT'))).toBe(250_000n);
    expect(rialitAmountOf(money(2_500_000n, 'IRR'))).toBe(250_000n);
    expect(rialitAmountOf(money(2_500_005n, 'IRR'))).toBeNull();
    expect(rialitAmountOf(money(0n, 'IRT'))).toBeNull();
  });

  it('refuses a payable outside 50,000-10,000,000 Toman, with the bounds, and passes the edges', () => {
    expect(rialitAmountRefusal(RIALIT_AMOUNT_MIN_TOMAN)).toBeNull();
    expect(rialitAmountRefusal(RIALIT_AMOUNT_MAX_TOMAN)).toBeNull();
    expect(rialitAmountRefusal(49_999n)).toBe('rialit.AMOUNT_OUT_OF_RANGE:50000:10000000');
    expect(rialitAmountRefusal(10_000_001n)).toBe('rialit.AMOUNT_OUT_OF_RANGE:50000:10000000');
  });

  it('reads only exact non-negative integers', () => {
    expect(parseTomanAmount(250000)).toBe(250_000n);
    expect(parseTomanAmount('250000')).toBe(250_000n);
    for (const bad of [250000.5, -1, '2.5e5', '250,000', '', null, undefined, '-1', '0250']) {
      expect(parseTomanAmount(bad)).toBeNull();
    }
  });
});

describe('the fee: only ONE side charges, never both (owner rule)', () => {
  const answer = (payerFee: unknown, payerAmount: unknown, amount: unknown = 250_000) => ({
    amount,
    payerAmount,
    payerFee,
  });

  it('neither side charging: normal', () => {
    expect(rialitPayerCheck(answer(0, 250_000), 250_000n, false)).toEqual({
      kind: 'OK',
      payerFee: 0n,
      payerAmount: 250_000n,
    });
  });

  it('Nexa charging, Rialit not: normal', () => {
    expect(rialitPayerCheck(answer(0, 250_000), 250_000n, true).kind).toBe('OK');
  });

  it('Rialit charging, Nexa not: allowed, and the payer amount is what the customer is shown', () => {
    expect(rialitPayerCheck(answer(2_500, 252_500), 250_000n, false)).toEqual({
      kind: 'OK',
      payerFee: 2_500n,
      payerAmount: 252_500n,
    });
  });

  it('both sides charging: refused (the link is never shown)', () => {
    expect(rialitPayerCheck(answer(2_500, 252_500), 250_000n, true).kind).toBe('DOUBLE_FEE');
  });

  it('figures that do not add up are refused, whoever charges', () => {
    for (const nexa of [true, false]) {
      expect(rialitPayerCheck(answer(2_500, 250_000), 250_000n, nexa).kind).toBe('MISMATCH');
      expect(rialitPayerCheck(answer(0, 260_000), 250_000n, nexa).kind).toBe('MISMATCH');
      // An answer for another amount than Nexa sent.
      expect(rialitPayerCheck(answer(0, 240_000, 240_000), 250_000n, nexa).kind).toBe('MISMATCH');
    }
  });

  it('unreadable payer figures are refused', () => {
    expect(rialitPayerCheck(answer(undefined, 250_000), 250_000n, false).kind).toBe('UNREADABLE');
    expect(rialitPayerCheck(answer(0, 'x'), 250_000n, false).kind).toBe('UNREADABLE');
    expect(rialitPayerCheck(answer(-1, 249_999), 250_000n, false).kind).toBe('UNREADABLE');
  });
});

describe('the verdict: only the status read decides', () => {
  it('approves paid for this order id, exactly the amount, and consistent payer figures', () => {
    expect(rialitJudgement(paid, expected)).toEqual({ verdict: 'APPROVED', mismatchReason: null });
    // A fee Rialit alone charged: still this payment, and the principal is what settles.
    expect(
      rialitJudgement({ ...paid, payerFee: 2_500, payerAmount: 252_500 }, expected).verdict,
    ).toBe('APPROVED');
  });

  it('expired and cancelled are OPEN, never a failure (Rialit may still mark them paid)', () => {
    for (const status of ['expired', 'cancelled', 'pending', 'something-new']) {
      expect(rialitJudgement({ ...paid, status }, expected)).toEqual({
        verdict: 'OPEN',
        mismatchReason: null,
      });
    }
  });

  it('holds a paid answer for another amount, another order or inconsistent payer figures', () => {
    expect(rialitJudgement({ ...paid, amount: 249_999, payerAmount: 249_999 }, expected)).toEqual({
      verdict: 'MISMATCH',
      mismatchReason: 'PROVIDER_AMOUNT_MISMATCH',
    });
    expect(rialitJudgement({ ...paid, orderId: 'order-9' }, expected).mismatchReason).toBe(
      'PROVIDER_ORDER_ID_MISMATCH',
    );
    expect(rialitJudgement({ ...paid, orderId: 42 }, expected).mismatchReason).toBe(
      'PROVIDER_ORDER_ID_MISSING',
    );
    expect(rialitJudgement({ ...paid, amount: '2.5e5' }, expected).mismatchReason).toBe(
      'PROVIDER_AMOUNT_UNREADABLE',
    );
    expect(rialitJudgement({ ...paid, payerFee: 1_000 }, expected).mismatchReason).toBe(
      'PROVIDER_PAYER_AMOUNT_MISMATCH',
    );
    expect(rialitJudgement({ ...paid, payerAmount: null }, expected).mismatchReason).toBe(
      'PROVIDER_PAYER_AMOUNT_UNREADABLE',
    );
  });
});

describe('identifiers and the link', () => {
  it('builds a fresh order id from the payment code and forty random bits, in the documented shape', () => {
    const id = rialitOrderId('AB12-cd34', new Uint8Array([1, 2, 3, 4, 5]));
    expect(id).toMatch(/^AB12cd34-[0-9A-Z]{8}$/u);
    expect(RIALIT_ORDER_ID_PATTERN.test(id)).toBe(true);
    expect(rialitOrderId(null, new Uint8Array([255, 255, 255, 255, 255]))).toMatch(/^RL-Z{8}$/u);
    expect(rialitOrderId('X', new Uint8Array([0, 0, 0, 0, 1]))).not.toBe(
      rialitOrderId('X', new Uint8Array([0, 0, 0, 0, 2])),
    );
    expect(() => rialitOrderId('X', new Uint8Array([1]))).toThrow();
  });

  it('builds the documented pay page only from a safe token', () => {
    expect(rialitPayPageUrl('hT4xQm9ZkR2vB7nLc8WpY3dJf6GsA1Eu')).toBe(
      'https://pay.rialit.io/v1/hT4xQm9ZkR2vB7nLc8WpY3dJf6GsA1Eu',
    );
    expect(rialitPayPageUrl('../x')).toBeNull();
    expect(rialitPayPageUrl('a'.repeat(65))).toBeNull();
  });

  it('shows the link deadline: thirty minutes, never past the attempt', () => {
    const created = new Date('2026-10-25T10:00:00.000Z');
    expect(rialitLinkDeadline(created, new Date('2026-10-25T11:10:00.000Z')).toISOString()).toBe(
      '2026-10-25T10:30:00.000Z',
    );
    expect(rialitLinkDeadline(created, new Date('2026-10-25T10:20:00.000Z')).toISOString()).toBe(
      '2026-10-25T10:20:00.000Z',
    );
  });
});
