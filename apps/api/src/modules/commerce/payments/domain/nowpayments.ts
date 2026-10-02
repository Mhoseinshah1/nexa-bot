import {
  NOWPAYMENTS_ORDER_ID_PREFIX,
  NOWPAYMENTS_PRICE_CURRENCY,
  type GatewayApprovalVerdict,
} from '@nexa/contracts';
import { TONPAYS_ORDER_ID_RANDOM_BYTES, tonpaysOrderId } from './tonpays.js';

/**
 * The NOWPayments rules that decide anything, as pure functions
 * (`docs/nowpayments-gateway-audit.md` §5). `tests/unit/nowpayments-rules.test.ts` pins each.
 */

/** Random bytes a NOWPayments order id needs: the TonPays shape, `NP` + 18 characters. */
export const NOWPAYMENTS_ORDER_ID_RANDOM_BYTES = TONPAYS_ORDER_ID_RANDOM_BYTES;

/** A fresh provider order id: `NP` and ninety random bits, exactly twenty characters. */
export function nowpaymentsOrderId(random: Uint8Array): string {
  return tonpaysOrderId(random, NOWPAYMENTS_ORDER_ID_PREFIX);
}

/**
 * US cents as the decimal the provider's `price_amount` carries: `1234n` → `12.34`,
 * `1200n` → `12`, `5n` → `0.05`. A JSON NUMBER, built from the decimal text so the value
 * a reader sees is exactly the cents Nexa computed. Null for a non-positive amount, or one
 * past the range a JSON number holds every cent of exactly.
 */
export function priceAmountOfCents(cents: bigint): number | null {
  if (cents <= 0n || cents > 900_719_925_474_099n) return null;
  const whole = cents / 100n;
  const fraction = cents % 100n;
  const text =
    fraction === 0n
      ? whole.toString()
      : `${whole.toString()}.${fraction.toString().padStart(2, '0').replace(/0$/u, '')}`;
  return Number(text);
}

/**
 * A provider `price_amount` back into cents, EXACTLY, or null: a JSON number or a decimal
 * string with at most two fractional digits. `12.3` is `1230n`; `12.345`, `1e-7`, a sign,
 * a non-finite value or anything else is not a price Nexa sent, and is null — which is
 * never read as a match.
 */
export function centsOfPriceAmount(value: unknown): bigint | null {
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return null;
    text = String(value);
  } else if (typeof value === 'string') {
    text = value;
  } else {
    return null;
  }
  const match = /^(0|[1-9][0-9]{0,14})(?:\.([0-9]{1,2}))?$/u.exec(text);
  if (match === null) return null;
  const whole = BigInt(match[1] ?? '0');
  const fraction = BigInt((match[2] ?? '').padEnd(2, '0') || '0');
  return whole * 100n + fraction;
}

/** What one NOWPayments payment record says, reduced to what a verdict reads. */
export interface NowPaymentsObservation {
  readonly status: string;
  /** The record's `price_amount`, raw; judged only through `centsOfPriceAmount`. */
  readonly priceAmount: unknown;
  /** The record's `price_currency`, raw. */
  readonly priceCurrency: unknown;
}

/** A verdict, and whether the customer's coins are on their way (the review trigger). */
export interface NowPaymentsJudgement {
  readonly verdict: GatewayApprovalVerdict;
  readonly fundsDetected: boolean;
}

/**
 * What one payment record MEANS for Nexa (`docs/nowpayments-gateway-audit.md` §5.5).
 *
 * - `finished` is the ONE success, and only for exactly the price Nexa asked —
 *   `price_amount` equal to `expectedCents` and `price_currency` the dollar. A `finished`
 *   for any other figure, or whose figure cannot be read, is `MISMATCH`: money arrived
 *   that is not what this attempt invoiced, and a person decides.
 * - `partially_paid` is `MISMATCH`: less than the price arrived. It never fulfils.
 * - `confirming`, `confirmed`, `sending` are OPEN with the coins detected — the chain is
 *   confirming them, or NOWPayments is forwarding them. Not yet money; the review window
 *   may open so the chain can finish.
 * - `waiting` is OPEN.
 * - `failed`, `expired`, `refunded` are OPEN too, deliberately: they describe ONE payment,
 *   and the hosted invoice lets the customer start another (a different coin) under the
 *   same invoice. Nexa's own deadline closes the attempt; failing it here would turn a
 *   second, successful payment into a late completion nobody settles.
 * - Anything else is a status the documentation does not name: recorded, OPEN.
 */
export function nowpaymentsVerdict(
  observation: NowPaymentsObservation,
  expectedCents: bigint,
): NowPaymentsJudgement {
  switch (observation.status) {
    case 'finished': {
      const cents = centsOfPriceAmount(observation.priceAmount);
      const currency =
        typeof observation.priceCurrency === 'string'
          ? observation.priceCurrency.toLowerCase()
          : null;
      const exact =
        cents !== null && cents === expectedCents && currency === NOWPAYMENTS_PRICE_CURRENCY;
      return { verdict: exact ? 'APPROVED' : 'MISMATCH', fundsDetected: true };
    }
    case 'partially_paid':
      return { verdict: 'MISMATCH', fundsDetected: true };
    case 'confirming':
    case 'confirmed':
    case 'sending':
      return { verdict: 'OPEN', fundsDetected: true };
    default:
      return { verdict: 'OPEN', fundsDetected: false };
  }
}

/**
 * The strongest of several payment records under one invoice — what an inquiry by invoice
 * reports. An approval outranks a mismatch, a mismatch outranks coins on their way, and
 * those outrank a payment that is merely waiting or ended. Ties keep the first.
 */
export function strongestJudgement<T extends NowPaymentsJudgement>(judged: readonly T[]): T | null {
  const rank = (one: NowPaymentsJudgement): number =>
    one.verdict === 'APPROVED'
      ? 4
      : one.verdict === 'MISMATCH'
        ? 3
        : one.fundsDetected
          ? 2
          : one.verdict === 'OPEN'
            ? 1
            : 0;
  let best: T | null = null;
  for (const one of judged) {
    if (best === null || rank(one) > rank(best)) best = one;
  }
  return best;
}
