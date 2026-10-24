import { parseDecimalRate, type FxRate } from '@nexa/contracts';
import type { ProviderFailureKind, ProviderHttpResult } from '@nexa/contracts';
import type { FxSourceOutcome } from '../application/ports.js';

/**
 * What the two source adapters share (package FX): reading a provider's body without a
 * float anywhere, and mapping the HTTP client's failures to the source outcomes.
 *
 * ## No float
 *
 * `JSON.parse` turns every number into a double, and a price arriving as a JSON number
 * would lose its exact text on the way in. Node 22 (`engines` pins it) hands a reviver
 * the number's SOURCE TEXT, so a numeric price is read exactly as the provider wrote it
 * and parsed by the contract's decimal parser into a mantissa and a scale. A runtime
 * that did not supply the source text would make every numeric price unreadable — and
 * that is the answer, rather than `String(value)` of a double: a figure that cannot be
 * read exactly is not read.
 */

/** A JSON value with every number replaced by its exact source text. */
export type ExactJson =
  string | boolean | null | ExactJson[] | { readonly [key: string]: ExactJson };

/** Parses a body keeping numbers as their exact text. Null for anything that is not JSON. */
export function parseExactJson(text: string): ExactJson | null | undefined {
  try {
    // Node's `JSON.parse` calls the reviver with a third `context` argument carrying the
    // primitive's source text. Typed loosely here because the DOM lib's signature is
    // two-argument; the runtime contract is Node 22's.
    const reviver = (_key: string, value: unknown, context?: { readonly source?: string }) => {
      if (typeof value === 'number') {
        return context?.source === undefined ? Symbol.for('nexa.fx.unreadable') : context.source;
      }
      return value;
    };
    return JSON.parse(
      text,
      reviver as unknown as (key: string, value: unknown) => unknown,
    ) as ExactJson;
  } catch {
    return undefined;
  }
}

export function isExactObject(
  value: ExactJson | null | undefined,
): value is { readonly [key: string]: ExactJson } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A price field as a rate, whatever shape the provider chose (a decimal string or a JSON number). */
export function priceOf(value: ExactJson | undefined): FxRate | null {
  if (typeof value !== 'string') return null;
  return parseDecimalRate(value);
}

/** The highest of a list of bid prices, or null when none parses. */
export function bestBid(prices: readonly (FxRate | null)[]): FxRate | null {
  let best: FxRate | null = null;
  for (const price of prices) {
    if (price === null) continue;
    if (best === null || higher(price, best)) best = price;
  }
  return best;
}

function higher(a: FxRate, b: FxRate): boolean {
  return a.mantissa * 10n ** BigInt(b.scale) > b.mantissa * 10n ** BigInt(a.scale);
}

/**
 * The arithmetic mean of positive prices, divided by `unitDivisor`, as WHOLE TOMAN, rounded
 * half up — the one place a Round 8 adapter converts a unit and rounds. Exact on integers:
 * every price is brought to a common scale, summed, and divided once, so no float is ever
 * involved. `unitDivisor` is 1 for a source that quotes Toman and 10 for one that quotes
 * Rial (one Toman is ten Rial). Null when there is nothing to average or the figure is not
 * at least one whole Toman: a zero is never a rate.
 */
export function wholeTomanMean(prices: readonly FxRate[], unitDivisor: 1n | 10n): FxRate | null {
  if (prices.length === 0) return null;
  const scale = prices.reduce((widest, price) => Math.max(widest, price.scale), 0);
  let sum = 0n;
  for (const price of prices) {
    if (price.mantissa <= 0n) return null;
    sum += price.mantissa * 10n ** BigInt(scale - price.scale);
  }
  const denominator = BigInt(prices.length) * unitDivisor * 10n ** BigInt(scale);
  const whole = (2n * sum + denominator) / (2n * denominator);
  return whole > 0n ? { mantissa: whole, scale: 0 } : null;
}

/** A transport failure, in the source vocabulary. A 429 is the one answer that says "later". */
export function transportOutcome(
  result: ProviderHttpResult,
  prefix: string,
): FxSourceOutcome | null {
  if (!result.ok) {
    return { kind: 'UNAVAILABLE', code: `${prefix}.${failureCode(result.failure)}` };
  }
  if (result.status === 429) return { kind: 'RATE_LIMITED', code: `${prefix}.rate_limited` };
  if (result.status < 200 || result.status >= 300) {
    return { kind: 'UNAVAILABLE', code: `${prefix}.http_${String(result.status)}` };
  }
  return null;
}

function failureCode(kind: ProviderFailureKind): string {
  return kind.toLowerCase();
}

/**
 * The bounds every source read runs under, through `SafeHttpClient`: one deadline over
 * DNS, connect, TLS and body, and a body cap far above the documented order books.
 * Five seconds, not the panel client's ten: a quote is refreshed on a timer and a slow
 * source is simply not this pass's source, while the operator's manual refresh waits
 * on both sources back to back.
 */
export const FX_SOURCE_TIMEOUT_MS = 5_000;
export const FX_SOURCE_MAX_RESPONSE_BYTES = 256 * 1024;
/**
 * Bitpin's market list is about 275 KB DECOMPRESSED (owner's curl, 2026-10-24), which the
 * 256 KiB cap above refuses. It gets its own client at 320 KiB, so the raise covers that one
 * source and no other; the cap still applies to the decompressed bytes.
 */
export const FX_BITPIN_MAX_RESPONSE_BYTES = 320 * 1024;
