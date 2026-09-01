import { describe, expect, it } from 'vitest';
import {
  add,
  compare,
  equals,
  fromWire,
  isNegative,
  money,
  MoneyError,
  multiply,
  negate,
  subtract,
  sum,
  toWire,
  zero,
} from '@nexa/contracts';

describe('Money', () => {
  it('rejects a fractional amount instead of rounding it', () => {
    // Silently rounding a fractional minor unit is how ledgers drift.
    expect(() => money(1.5, 'IRT')).toThrow(MoneyError);
    expect(() => money(0.1, 'USD')).toThrow(MoneyError);
  });

  it('rejects a number beyond the safe integer range', () => {
    expect(() => money(Number.MAX_SAFE_INTEGER + 2, 'IRT')).toThrow(MoneyError);
  });

  it('refuses arithmetic across currencies', () => {
    const toman = money(1000n, 'IRT');
    const dollars = money(1000n, 'USD');
    expect(() => add(toman, dollars)).toThrow(MoneyError);
    expect(() => subtract(toman, dollars)).toThrow(MoneyError);
    expect(() => compare(toman, dollars)).toThrow(MoneyError);
  });

  it('carries values larger than Number.MAX_SAFE_INTEGER exactly', () => {
    const big = money(9007199254740993n, 'IRT');
    expect(big.amountMinor).toBe(9007199254740993n);
    expect(toWire(big).amountMinor).toBe('9007199254740993');
    expect(fromWire(toWire(big)).amountMinor).toBe(9007199254740993n);
  });

  it('adds, subtracts, multiplies and negates within one currency', () => {
    const a = money(1500n, 'IRT');
    const b = money(500n, 'IRT');
    expect(add(a, b).amountMinor).toBe(2000n);
    expect(subtract(a, b).amountMinor).toBe(1000n);
    expect(multiply(b, 3n).amountMinor).toBe(1500n);
    expect(isNegative(negate(a))).toBe(true);
  });

  it('sums an empty list to zero of the stated currency', () => {
    expect(equals(sum([], 'USD'), zero('USD'))).toBe(true);
  });

  it('compares and equates by currency as well as amount', () => {
    expect(equals(money(1n, 'IRT'), money(1n, 'IRR'))).toBe(false);
    expect(compare(money(1n, 'IRT'), money(2n, 'IRT'))).toBe(-1);
    expect(compare(money(2n, 'IRT'), money(2n, 'IRT'))).toBe(0);
  });

  it('round-trips through the wire form without precision loss', () => {
    const original = money(-123456789012345678n, 'USDT');
    expect(equals(fromWire(toWire(original)), original)).toBe(true);
  });
});
