import { describe, expect, it } from 'vitest';
import { money } from '@nexa/contracts';
import { routeOfferabilityBlockers } from '../../apps/api/src/modules/commerce/payments/domain/gateway-selection';
import {
  RIAL_PER_TOMAN,
  nextTehranMidnight,
  parseRialAmount,
  paymentIdOfTetrapayStart,
  rialOfToman,
  rialWireString,
  tetrapayAmountOf,
  tetrapayCallbackUrl,
  tetrapayJudgement,
  tetrapayOrderId,
  tetrapayStartParam,
  tomanOfRial,
} from '../../apps/api/src/modules/commerce/payments/domain/tetrapay';

/**
 * TetraPay's pure rules (`docs/tetrapay-gateway-audit.md`). The rial/Toman helper is the one
 * place a money factor lives, so each of its branches is pinned and mutation-checked.
 */

describe('the one rial <-> Toman helper', () => {
  it('sends 10,000 Toman as "100000" rial', () => {
    expect(rialOfToman(10_000n)).toBe(100_000n);
    expect(rialWireString(rialOfToman(10_000n) as bigint)).toBe('100000');
    expect(tetrapayAmountOf(money(10_000n, 'IRT'))).toBe(100_000n);
    expect(RIAL_PER_TOMAN).toBe(10n);
  });

  it('reads rial back as Toman exactly: 100000 rial is 10,000 Toman', () => {
    expect(tomanOfRial(100_000n)).toBe(10_000n);
    expect(tomanOfRial(10n)).toBe(1n);
  });

  it('refuses a rial figure that is not a multiple of ten, and a figure that is not positive', () => {
    for (const bad of [1n, 9n, 11n, 100_005n]) expect(tomanOfRial(bad)).toBeNull();
    expect(tomanOfRial(0n)).toBeNull();
    expect(tomanOfRial(-10n)).toBeNull();
    expect(rialOfToman(0n)).toBeNull();
    expect(rialOfToman(-1n)).toBeNull();
  });

  it('prices a payable in the sales currency: Toman x10, Rial as is only when a whole Toman', () => {
    expect(tetrapayAmountOf(money(12_500n, 'IRT'))).toBe(125_000n);
    expect(tetrapayAmountOf(money(125_000n, 'IRR'))).toBe(125_000n);
    expect(tetrapayAmountOf(money(125_005n, 'IRR'))).toBeNull();
    expect(tetrapayAmountOf(money(5n, 'USD'))).toBeNull();
  });

  it('reads a provider amount only as an exact numeric string or integer', () => {
    expect(parseRialAmount('12500000')).toBe(12_500_000n);
    expect(parseRialAmount(12_500_000)).toBe(12_500_000n);
    expect(parseRialAmount('12500000.00')).toBe(12_500_000n);
    for (const bad of ['12500000.5', '-1', '1e6', ' 5', '', null, undefined, 1.5, {}, '01']) {
      expect(parseRialAmount(bad)).toBeNull();
    }
  });
});

describe('what a verify answer means', () => {
  const expected = { orderId: 'AB12CD34-X7K9QM', sentAmount: 12_500_000n };
  const paid = {
    status: 'paid',
    orderId: 'AB12CD34-X7K9QM',
    amount: '12500000',
    payableAmount: '12562500',
    receivedAmount: '12562500',
  };

  it('approves ONLY paid for this order id and exactly the rial amount asked, with the money received', () => {
    expect(tetrapayJudgement(paid, expected)).toEqual({
      verdict: 'APPROVED',
      mismatchReason: null,
    });
  });

  it('holds a paid answer for another amount, another order id, or an unreadable field - never credits it', () => {
    expect(tetrapayJudgement({ ...paid, amount: '12500010' }, expected)).toEqual({
      verdict: 'MISMATCH',
      mismatchReason: 'PROVIDER_AMOUNT_MISMATCH',
    });
    expect(tetrapayJudgement({ ...paid, orderId: 'OTHER' }, expected).verdict).toBe('MISMATCH');
    expect(tetrapayJudgement({ ...paid, orderId: undefined }, expected).verdict).toBe('MISMATCH');
    expect(tetrapayJudgement({ ...paid, amount: 'a lot' }, expected).verdict).toBe('MISMATCH');
    expect(tetrapayJudgement({ ...paid, amount: undefined }, expected).verdict).toBe('MISMATCH');
  });

  it('holds a paid answer whose money did not all arrive (a partial payment)', () => {
    expect(tetrapayJudgement({ ...paid, receivedAmount: '12500000' }, expected)).toEqual({
      verdict: 'MISMATCH',
      mismatchReason: 'PROVIDER_RECEIVED_SHORT',
    });
    expect(tetrapayJudgement({ ...paid, receivedAmount: null }, expected).verdict).toBe('MISMATCH');
  });

  it('holds a paid answer whose payable_amount is absent or unreadable instead of lowering the receipt bar to the principal', () => {
    const lowered = { ...paid, payableAmount: '101000.5', receivedAmount: '12500000' };
    expect(tetrapayJudgement(lowered, expected)).toEqual({
      verdict: 'MISMATCH',
      mismatchReason: 'PROVIDER_PAYABLE_UNREADABLE',
    });
    for (const payableAmount of [undefined, null, 'lots']) {
      expect(tetrapayJudgement({ ...paid, payableAmount }, expected).mismatchReason).toBe(
        'PROVIDER_PAYABLE_UNREADABLE',
      );
    }
  });

  it('keeps created and pending open, expired unsuccessful, and an unknown status open', () => {
    for (const status of ['created', 'pending', 'processing', 7, undefined]) {
      expect(tetrapayJudgement({ ...paid, status }, expected).verdict).toBe('OPEN');
    }
    expect(tetrapayJudgement({ ...paid, status: 'expired' }, expected).verdict).toBe(
      'UNSUCCESSFUL',
    );
    // Case matters: only the documented lowercase `paid` approves.
    expect(tetrapayJudgement({ ...paid, status: 'PAID' }, expected).verdict).toBe('OPEN');
  });
});

describe('identifiers', () => {
  const random = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

  it('builds an order id from the payment code and a random suffix, in the documented alphabet', () => {
    const id = tetrapayOrderId('AB12CD34', random);
    expect(id).toMatch(/^AB12CD34-[0-9A-Z]{6}$/u);
    expect(id.length).toBeLessThanOrEqual(64);
    expect(tetrapayOrderId('AB12CD34', random)).toBe(id);
    expect(tetrapayOrderId('AB12CD34', new Uint8Array([9, 9, 9, 9, 9, 9]))).not.toBe(id);
    expect(tetrapayOrderId(null, random)).toMatch(/^TP-[0-9A-Z]{6}$/u);
    expect(tetrapayOrderId('a b/c', random)).toMatch(/^abc-/u);
  });

  it('round-trips the start parameter and reads nothing else from it', () => {
    const id = '0190f2a4-7c3e-7d11-9a55-1f2e3d4c5b6a';
    expect(tetrapayStartParam(id)).toBe(`tp-${id}`);
    expect(tetrapayStartParam(id).length).toBeLessThanOrEqual(64);
    expect(paymentIdOfTetrapayStart(`tp-${id}`)).toBe(id);
    for (const bad of ['', 'tp-', `tp-${id}&status=paid`, `ref-${id}`, `tp-${id}x`, 'tp-123']) {
      expect(paymentIdOfTetrapayStart(bad)).toBeNull();
    }
    expect(tetrapayCallbackUrl('https://t.me/nexa_bot', id)).toBe(
      `https://t.me/nexa_bot?start=tp-${id}`,
    );
    expect(tetrapayCallbackUrl(null, id)).toBeNull();
  });
});

describe('the daily limit hides the route until 00:00 Tehran', () => {
  it('is the next Tehran midnight: 2026-10-23 12:00 UTC is 15:30 there, so 20:30 UTC', () => {
    expect(nextTehranMidnight(new Date('2026-10-23T12:00:00.000Z')).toISOString()).toBe(
      '2026-10-23T20:30:00.000Z',
    );
  });

  it('is strictly after now, also at the boundary and across a UTC day', () => {
    expect(nextTehranMidnight(new Date('2026-10-23T20:30:00.000Z')).toISOString()).toBe(
      '2026-10-24T20:30:00.000Z',
    );
    expect(nextTehranMidnight(new Date('2026-10-23T20:29:59.000Z')).toISOString()).toBe(
      '2026-10-23T20:30:00.000Z',
    );
    expect(nextTehranMidnight(new Date('2026-10-23T23:59:00.000Z')).toISOString()).toBe(
      '2026-10-24T20:30:00.000Z',
    );
  });

  it('keeps a route out of the offered list while hidden, and brings it back by itself', () => {
    const route = { status: 'ACTIVE' as const, allowServicePurchase: true, allowWalletTopup: true };
    const facts = { settlesVia: 'GATEWAY' as const, hasReceivingAccount: true, priceable: true };
    expect(
      routeOfferabilityBlockers(route, 'WALLET_TOPUP', { ...facts, temporarilyHidden: true }),
    ).toEqual(['TEMPORARILY_UNAVAILABLE']);
    expect(
      routeOfferabilityBlockers(route, 'WALLET_TOPUP', { ...facts, temporarilyHidden: false }),
    ).toEqual([]);
  });
});
