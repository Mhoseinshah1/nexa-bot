import { z } from 'zod';
import type { Branded, RateSnapshotId } from './ids.js';

/**
 * Money.
 *
 * Amounts are `bigint` minor units with an explicit currency. Never a float,
 * never a bare number, never an amount without a currency.
 *
 * The legacy system has no currency selector on any gateway, no exchange-rate
 * field anywhere, and one card-to-card template that says تومان where its twin
 * says ریال for the same `{price}` placeholder. Making currency part of the
 * type is what stops that.
 */

export const CURRENCY_CODES = ['IRT', 'IRR', 'USD', 'EUR', 'USDT'] as const;
export type CurrencyCode = (typeof CURRENCY_CODES)[number];

/** Minor units per major unit, for rendering only. Arithmetic stays in minor units. */
export const CURRENCY_EXPONENT: Readonly<Record<CurrencyCode, number>> = {
  IRT: 0, // Toman is quoted in whole units in this product.
  IRR: 0,
  USD: 2,
  EUR: 2,
  USDT: 6,
};

export const currencyCodeSchema = z.enum(CURRENCY_CODES);

export type MoneyAmount = Branded<bigint, 'MoneyAmount'>;

export interface Money {
  readonly amountMinor: MoneyAmount;
  readonly currency: CurrencyCode;
}

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/**
 * Constructs a Money value.
 *
 * Accepts `bigint` or an integer-valued `number`. A non-integer number is
 * rejected rather than rounded — a fractional minor unit is always a bug, and
 * silently rounding it is how ledgers drift.
 */
export function money(amountMinor: bigint | number, currency: CurrencyCode): Money {
  let value: bigint;
  if (typeof amountMinor === 'number') {
    if (!Number.isInteger(amountMinor)) {
      throw new MoneyError(
        `Money must be a whole number of minor units; received ${String(amountMinor)}.`,
      );
    }
    if (!Number.isSafeInteger(amountMinor)) {
      throw new MoneyError(
        `Money amount ${String(amountMinor)} exceeds the safe integer range; pass a bigint.`,
      );
    }
    value = BigInt(amountMinor);
  } else {
    value = amountMinor;
  }
  return { amountMinor: value as MoneyAmount, currency };
}

export function zero(currency: CurrencyCode): Money {
  return money(0n, currency);
}

function assertSameCurrency(a: Money, b: Money, operation: string): void {
  if (a.currency !== b.currency) {
    throw new MoneyError(
      `Cannot ${operation} ${a.currency} and ${b.currency}. Convert through a rate snapshot first.`,
    );
  }
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b, 'add');
  return money(a.amountMinor + b.amountMinor, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b, 'subtract');
  return money(a.amountMinor - b.amountMinor, a.currency);
}

export function multiply(a: Money, factor: bigint): Money {
  return money(a.amountMinor * factor, a.currency);
}

export function negate(a: Money): Money {
  return money(-a.amountMinor, a.currency);
}

export function isZero(a: Money): boolean {
  return a.amountMinor === 0n;
}

export function isNegative(a: Money): boolean {
  return a.amountMinor < 0n;
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b, 'compare');
  if (a.amountMinor < b.amountMinor) return -1;
  if (a.amountMinor > b.amountMinor) return 1;
  return 0;
}

export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.amountMinor === b.amountMinor;
}

export function sum(values: readonly Money[], currency: CurrencyCode): Money {
  return values.reduce<Money>((acc, v) => add(acc, v), zero(currency));
}

/**
 * The wire and storage form. `amountMinor` travels as a decimal string because
 * JSON has no bigint and `9007199254740993` does not survive a round trip
 * through `number`.
 */
export const moneySchema = z.object({
  amountMinor: z.string().regex(/^-?\d+$/, 'must be an integer string'),
  currency: currencyCodeSchema,
});
export type MoneyWire = z.infer<typeof moneySchema>;

export function toWire(value: Money): MoneyWire {
  return { amountMinor: value.amountMinor.toString(), currency: value.currency };
}

export function fromWire(wire: MoneyWire): Money {
  return money(BigInt(wire.amountMinor), wire.currency);
}

/**
 * A converted amount.
 *
 * A native-currency amount is plain `Money` and carries no rate snapshot.
 * A rate snapshot is mandatory only when the amount was DERIVED through an
 * FX or crypto conversion — above all a payment or gateway quote. The snapshot
 * is immutable and retained for the life of the record, so a converted quote
 * can always show the rate it was quoted at.
 */
export interface ConvertedMoney {
  /** The amount in the target currency, as quoted. */
  readonly quoted: Money;
  /** The amount in the originating currency. */
  readonly source: Money;
  /** The immutable rate snapshot this conversion was derived from. */
  readonly rateSnapshotId: RateSnapshotId;
}

export const convertedMoneySchema = z.object({
  quoted: moneySchema,
  source: moneySchema,
  rateSnapshotId: z.string(),
});
