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

/**
 * The largest minor-unit amount this system stores: PostgreSQL `bigint`'s maximum.
 *
 * Every money column is `bigint`, so this is a property of the storage rather than a
 * product decision, and it belongs beside the type rather than inside one schema.
 * Without it a validator that merely counts digits admits values the column cannot
 * hold, and the refusal arrives as an integrity error reported as a 500 instead of a
 * named field — which is exactly what `productWriteSchema` did until the Codex review
 * of the 4B branch.
 */
export const MAX_MONEY_AMOUNT_MINOR = 9_223_372_036_854_775_807n;

export const currencyCodeSchema = z.enum(CURRENCY_CODES);

/**
 * The currencies a tenant may SELL in — a narrower set than the ones money can be in.
 *
 * `CURRENCY_CODES` is the full vocabulary because a converted payment quote will need
 * USD, EUR and USDT. What a STORE prices in is a different question, and the answer
 * today is one of the two Iranian units. Widening this is a contract change to make
 * when there is a gateway that settles in one of the others.
 *
 * It exists as its own constant so the `sales.currency` setting's schema, the server's
 * refusal and the Web Admin's currency picker are ONE statement rather than three lists
 * that agree until somebody edits one. Codex found the products form offering all five,
 * three of which the store cannot sell in.
 */
export const SALES_CURRENCY_CODES = ['IRT', 'IRR'] as const;
export type SalesCurrencyCode = (typeof SALES_CURRENCY_CODES)[number];
export const salesCurrencyCodeSchema = z.enum(SALES_CURRENCY_CODES);

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

/**
 * The amount as a bare number, for a machine rather than for a reader.
 *
 * `1500000`, not `۱٬۵۰۰٬۰۰۰ تومان`. It exists for exactly one caller — the Telegram
 * "copy the amount" button, whose string is pasted into a banking app — and the grouping
 * separators, the Persian digits and the currency word that `formatMoney` adds are all
 * things a banking app rejects.
 *
 * Deliberately NOT in `@nexa/i18n` beside `formatMoney`. This has no locale and must not
 * acquire one: the moment it renders Persian digits it stops being pasteable, which is
 * its whole purpose. It is also why a surface may call it — surfaces may import
 * contracts and may not import the catalogue.
 *
 * Negative amounts keep their sign, which no caller currently produces and which is
 * still the only truthful thing to return for one.
 */
export function plainAmount(value: Money): string {
  const exponent = CURRENCY_EXPONENT[value.currency];
  const negative = value.amountMinor < 0n;
  const digits = (negative ? -value.amountMinor : value.amountMinor).toString();
  if (exponent === 0) return `${negative ? '-' : ''}${digits}`;
  const padded = digits.padStart(exponent + 1, '0');
  const major = padded.slice(0, padded.length - exponent);
  const minor = padded.slice(padded.length - exponent);
  return `${negative ? '-' : ''}${major}.${minor}`;
}

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
