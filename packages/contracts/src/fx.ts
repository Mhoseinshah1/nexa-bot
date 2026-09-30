import { z } from 'zod';
import { MAX_MONEY_AMOUNT_MINOR, type SalesCurrencyCode } from './money.js';

/**
 * Central exchange rates (round P, package FX; `docs/fx-audit.md`).
 *
 * One layer converts a foreign provider unit into the sales currency, and every route
 * that needs a rate asks it. A gateway adapter never fetches a rate of its own.
 *
 * Everything financial here is `bigint`. A rate is a decimal read off a provider as
 * TEXT and kept as a mantissa and a scale; the conversion into provider units is one
 * integer division with a ceiling. There is no `number` anywhere a figure is decided.
 */

/**
 * The assets a rate is quoted FOR. `USDT` is the one this release converts: a Telegram
 * Star is pegged to it by an operator's ratio (package FX-STARS), and a future USDT
 * gateway would bill in it directly. A member arrives with a source that quotes it.
 */
export const FX_BASE_ASSETS = ['USDT'] as const;
export type FxBaseAsset = (typeof FX_BASE_ASSETS)[number];
export const fxBaseAssetSchema = z.enum(FX_BASE_ASSETS);

/**
 * The public sources this installation can read, as code rather than rows (the rule
 * `ADR-0023` states for panel providers). Both are verified against the provider's own
 * published documentation in `docs/fx-audit.md` §2; a member here has a parser behind
 * it and nothing else may be named as a source.
 */
export const FX_SOURCES = ['NOBITEX', 'WALLEX'] as const;
export type FxSource = (typeof FX_SOURCES)[number];
export const fxSourceSchema = z.enum(FX_SOURCES);

/** A fallback may be none. `NONE` is the operator saying "primary only". */
export const FX_FALLBACK_SOURCES = [...FX_SOURCES, 'NONE'] as const;
export type FxFallbackSource = (typeof FX_FALLBACK_SOURCES)[number];
export const fxFallbackSourceSchema = z.enum(FX_FALLBACK_SOURCES);

/**
 * The ONE quote side this domain exposes (brief, "Quote-side rule").
 *
 * The merchant RECEIVES the base asset from the customer and must sell it for fiat. On
 * an order book the merchant's sale fills against the BIDS, so the price the merchant
 * can actually realise is the best bid — the highest price a buyer is paying for the
 * asset right now. Quoting the ask instead would state a fiat value per unit the
 * merchant cannot obtain, and the customer would be asked for FEWER units than the
 * payable is worth: a systematic undercharge. So every source reads its best bid, and
 * the side is decided here, once, never inside a gateway adapter.
 */
export const FX_QUOTE_SIDE = 'SELL_USDT_TO_RECEIVE_FIAT' as const;
export type FxQuoteSide = typeof FX_QUOTE_SIDE;

/**
 * A quote's state at the moment it is read, decided from its age against two operator
 * settings:
 *
 * - `FRESH` — younger than `fx.fresh_ttl_seconds`;
 * - `STALE_ALLOWED` — older than the TTL and younger than `fx.max_stale_seconds`: the
 *   last-known-good may still price a NEW invoice, and doing so is recorded;
 * - `UNAVAILABLE` — older than the stale limit, never fetched, or the feature is off.
 *   A new foreign-denominated invoice is refused. An invoice already issued is never
 *   touched: it carries its own snapshot.
 */
export const FX_QUOTE_STATES = ['FRESH', 'STALE_ALLOWED', 'UNAVAILABLE'] as const;
export type FxQuoteState = (typeof FX_QUOTE_STATES)[number];
export const fxQuoteStateSchema = z.enum(FX_QUOTE_STATES);

/** The states a snapshot may record: a quote that priced something was one of these two. */
export const FX_USABLE_QUOTE_STATES = ['FRESH', 'STALE_ALLOWED'] as const;

/**
 * The version of the conversion policy a snapshot was taken under. Bumped when the
 * side, the rounding or the arithmetic changes, so an old invoice can be explained by
 * the rule that produced it rather than by today's.
 */
export const FX_POLICY_VERSION = 1;

// --- The rate ---------------------------------------------------------------------------

/**
 * A rate as a fixed-precision decimal: `mantissa / 10^scale`, in the QUOTE currency's
 * MINOR units per ONE unit of the base asset. Toman has no minor unit, so for IRT the
 * value is Toman per USDT; for IRR it is Rial per USDT.
 *
 * Never a float. The mantissa is a `bigint` and the scale is the number of fractional
 * digits the provider's text carried, capped by `FX_RATE_MAX_SCALE`.
 */
export interface FxRate {
  readonly mantissa: bigint;
  readonly scale: number;
}

/** Fractional digits kept from a provider's text. Enough for any fiat quote. */
export const FX_RATE_MAX_SCALE = 8;

const DECIMAL_TEXT = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/u;

/**
 * A provider's decimal TEXT as a rate, or null for anything that is not a plain
 * non-negative decimal: a sign, an exponent, a bare separator, a comma, whitespace.
 *
 * Trailing fractional zeros are dropped so the same value always has one spelling —
 * the quote id is built from it and must be deterministic. Digits past the cap are
 * TRUNCATED (never rounded) so a rate can only ever be read slightly lower, which is
 * the conservative direction for the side this domain quotes.
 */
export function parseDecimalRate(text: string): FxRate | null {
  const match = DECIMAL_TEXT.exec(text);
  if (match === null) return null;
  const whole = match[1] ?? '0';
  const fraction = (match[2] ?? '').slice(0, FX_RATE_MAX_SCALE).replace(/0+$/u, '');
  const digits = `${whole}${fraction}`.replace(/^0+(?=\d)/u, '');
  if (digits.length > 30) return null;
  return { mantissa: BigInt(digits), scale: fraction.length };
}

/** The rate's decimal text, the inverse of `parseDecimalRate`. */
export function rateToDecimalText(rate: FxRate): string {
  if (rate.scale === 0) return rate.mantissa.toString();
  const digits = rate.mantissa.toString().padStart(rate.scale + 1, '0');
  const whole = digits.slice(0, digits.length - rate.scale);
  const fraction = digits.slice(digits.length - rate.scale).replace(/0+$/u, '');
  return fraction === '' ? whole : `${whole}.${fraction}`;
}

/**
 * A provider quotes in ONE of the two sales currencies and an installation sells in
 * one of them. Nobitex quotes Rial (`rls`); Wallex quotes Toman (`TMN`). One Toman is
 * ten Rial, exactly, so the conversion is a shift of the scale or of the mantissa and
 * never a division that could round.
 */
export function convertQuoteCurrency(
  rate: FxRate,
  from: SalesCurrencyCode,
  to: SalesCurrencyCode,
): FxRate {
  if (from === to) return rate;
  // IRR → IRT: divide by ten, exactly, by carrying one more fractional digit.
  if (from === 'IRR' && to === 'IRT')
    return normaliseRate({ mantissa: rate.mantissa, scale: rate.scale + 1 });
  // IRT → IRR: multiply by ten.
  return normaliseRate({ mantissa: rate.mantissa * 10n, scale: rate.scale });
}

/** The one spelling of a rate: no trailing fractional zeros. */
export function normaliseRate(rate: FxRate): FxRate {
  let { mantissa, scale } = rate;
  while (scale > 0 && mantissa % 10n === 0n) {
    mantissa /= 10n;
    scale -= 1;
  }
  return { mantissa, scale };
}

/**
 * How far `candidate` sits from `reference`, in basis points of the reference, on
 * `bigint` only. Both are brought to a common scale by cross-multiplying, so no
 * division happens before the final one. Null when the reference is not positive.
 */
export function rateDeviationBps(candidate: FxRate, reference: FxRate): bigint | null {
  if (reference.mantissa <= 0n) return null;
  const a = candidate.mantissa * 10n ** BigInt(reference.scale);
  const b = reference.mantissa * 10n ** BigInt(candidate.scale);
  const diff = a > b ? a - b : b - a;
  return (diff * 10_000n) / b;
}

/**
 * A new quote further than this from the last-known-good is an OUTLIER: refused, and
 * the other source is asked. Fifteen percent. A real market move of that size inside
 * one stale window is rare; a unit mistake (Rial read as Toman) is a factor of ten and
 * is what this catches. Two sources that AGREE within `FX_SOURCE_AGREEMENT_BPS` of each
 * other override it — that is a market that moved, not a source that broke.
 */
export const FX_OUTLIER_MAX_DEVIATION_BPS = 1_500n;
export const FX_SOURCE_AGREEMENT_BPS = 300n;

/**
 * Sanity rails per pair, in the quote currency's minor units per base unit: a rate
 * outside them is not a market, it is a parse or a unit error, and is refused before
 * any comparison. Wide on purpose — they refuse the absurd, not the unlikely.
 */
export const FX_RATE_SANITY_RAILS: Readonly<
  Record<
    FxBaseAsset,
    Readonly<Record<SalesCurrencyCode, { readonly min: bigint; readonly max: bigint }>>
  >
> = {
  USDT: {
    IRT: { min: 1_000n, max: 1_000_000_000n },
    IRR: { min: 10_000n, max: 10_000_000_000n },
  },
};

/** Whether a rate is positive and inside the pair's rails. */
export function rateWithinRails(
  rate: FxRate,
  baseAsset: FxBaseAsset,
  quoteCurrency: SalesCurrencyCode,
): boolean {
  if (rate.mantissa <= 0n) return false;
  const rails = FX_RATE_SANITY_RAILS[baseAsset][quoteCurrency];
  const scaled = 10n ** BigInt(rate.scale);
  return rate.mantissa >= rails.min * scaled && rate.mantissa <= rails.max * scaled;
}

// --- The unit ratio (provider units per base unit) -------------------------------------

/**
 * How many provider units one base unit buys: for Telegram Stars, `Stars per USDT`,
 * set by the operator because Telegram publishes no canonical Star↔USDT merchant feed
 * (`docs/open-questions.md`, OQ-FX-01). A positive decimal with at most four fractional
 * digits, kept exact as a mantissa and a scale.
 */
export interface FxUnitRatio {
  readonly mantissa: bigint;
  readonly scale: number;
}

export const FX_UNIT_RATIO_MAX_SCALE = 4;

/**
 * The setting's text: `100`, `77.5`, or empty / `0` for "not set" (the spelling the
 * operations chat id uses for its unconfigured state). Latin digits only — the Web
 * Admin normalises what an operator types before it reaches the registry. Bounded so a
 * mistyped figure cannot make one Star worth a fraction of a Toman or a fortune.
 */
export const STARS_PER_USDT_TEXT = /^$|^(0|[1-9][0-9]{0,5})(?:\.[0-9]{1,4})?$/u;
export const starsPerUsdtSchema = z.string().regex(STARS_PER_USDT_TEXT, {
  message:
    'Stars per USDT is a decimal with at most six whole and four fractional digits, or empty.',
});

/** The ratio text as a ratio, or null when it is empty, zero or not well-formed. */
export function parseUnitRatio(text: string): FxUnitRatio | null {
  if (text === '' || !STARS_PER_USDT_TEXT.test(text)) return null;
  const parsed = parseDecimalRate(text);
  if (parsed === null || parsed.mantissa <= 0n) return null;
  return parsed;
}

/**
 * The provider units for a payable under the central rate and a unit ratio, by the
 * owner's rule `units = ceil(payable / effective_fiat_per_unit)` where
 * `effective_fiat_per_unit = rate / ratio`. Substituting:
 *
 *     units = ceil(payable × ratio.m × 10^rate.s  /  (rate.m × 10^ratio.s))
 *
 * One integer division with a ceiling. Every operand is a `bigint`. A positive payable
 * is at least one unit. Null for a non-positive payable, rate or ratio.
 */
export function providerUnitsByCentralFx(
  payableMinor: bigint,
  rate: FxRate,
  ratio: FxUnitRatio,
): bigint | null {
  if (payableMinor <= 0n || rate.mantissa <= 0n || ratio.mantissa <= 0n) return null;
  const numerator = payableMinor * ratio.mantissa * 10n ** BigInt(rate.scale);
  const denominator = rate.mantissa * 10n ** BigInt(ratio.scale);
  return (numerator + denominator - 1n) / denominator;
}

/**
 * The effective sales-currency minor units per ONE provider unit, as an exact reduced
 * fraction `numerator / denominator`. Snapshotted beside the rate and the ratio so a
 * later reader can explain a Star figure without re-deriving it. Null when either is
 * not positive.
 */
export function effectiveMinorPerUnit(
  rate: FxRate,
  ratio: FxUnitRatio,
): { readonly numerator: bigint; readonly denominator: bigint } | null {
  if (rate.mantissa <= 0n || ratio.mantissa <= 0n) return null;
  const numerator = rate.mantissa * 10n ** BigInt(ratio.scale);
  const denominator = ratio.mantissa * 10n ** BigInt(rate.scale);
  const divisor = gcd(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x === 0n ? 1n : x;
}

/**
 * A fraction as decimal text with `digits` fractional places, TRUNCATED, for a screen
 * or a log line. Never an input to arithmetic: the fraction itself is what is stored.
 */
export function fractionToDecimalText(numerator: bigint, denominator: bigint, digits = 4): string {
  if (denominator === 0n) return '0';
  const scaled = (numerator * 10n ** BigInt(digits)) / denominator;
  return rateToDecimalText(normaliseRate({ mantissa: scaled, scale: digits }));
}

/**
 * A deterministic identifier for one quote: what was read, from where, when. Two reads
 * of the same figure at the same instants are the same quote; anything else is another.
 */
export function fxQuoteId(input: {
  readonly source: FxSource;
  readonly baseAsset: FxBaseAsset;
  readonly quoteCurrency: SalesCurrencyCode;
  readonly rate: FxRate;
  readonly sourceAt: Date | null;
  readonly fetchedAt: Date;
  readonly policyVersion: number;
}): string {
  const normalised = normaliseRate(input.rate);
  return [
    `v${String(input.policyVersion)}`,
    input.source,
    `${input.baseAsset}-${input.quoteCurrency}`,
    `${normalised.mantissa.toString()}e-${String(normalised.scale)}`,
    input.sourceAt === null ? '-' : String(input.sourceAt.getTime()),
    String(input.fetchedAt.getTime()),
  ].join(':');
}

export const FX_QUOTE_ID_MAX_LENGTH = 96;

// --- The quote, as the domain hands it to a caller --------------------------------------

/** One quote with its provenance and its state at the moment it was read. */
export interface FxQuote {
  readonly baseAsset: FxBaseAsset;
  readonly quoteCurrency: SalesCurrencyCode;
  readonly side: FxQuoteSide;
  readonly rate: FxRate;
  readonly source: FxSource;
  /** The provider's own timestamp for the figure, when it supplies one. */
  readonly sourceAt: Date | null;
  readonly fetchedAt: Date;
  /** `now − fetchedAt`, whole seconds, never negative. */
  readonly ageSeconds: number;
  readonly state: FxQuoteState;
  readonly quoteId: string;
  readonly policyVersion: number;
}

// --- Freshness settings -----------------------------------------------------------------

/** `fx.fresh_ttl_seconds`: how long a fetched quote is FRESH. Default inside the brief's 30–60 s. */
export const FX_FRESH_TTL_SECONDS_MIN = 15;
export const FX_FRESH_TTL_SECONDS_MAX = 300;
export const FX_FRESH_TTL_SECONDS_DEFAULT = 45;

/** `fx.max_stale_seconds`: how long past the TTL the last-known-good may still price a NEW invoice. */
export const FX_MAX_STALE_SECONDS_MIN = 60;
export const FX_MAX_STALE_SECONDS_MAX = 86_400;
export const FX_MAX_STALE_SECONDS_DEFAULT = 900;

/**
 * The state of a quote of this age. The stale limit is floored at the TTL so a
 * configuration where "stale" ends before "fresh" does cannot refuse a fresh quote.
 */
export function fxQuoteStateFor(
  ageSeconds: number,
  freshTtlSeconds: number,
  maxStaleSeconds: number,
): FxQuoteState {
  if (ageSeconds <= freshTtlSeconds) return 'FRESH';
  if (ageSeconds <= Math.max(freshTtlSeconds, maxStaleSeconds)) return 'STALE_ALLOWED';
  return 'UNAVAILABLE';
}

// --- The provider-neutral conversion contract -------------------------------------------

/**
 * How a payable in the sales currency becomes a provider's amount (brief, "Generic
 * gateway conversion"). The payment core consults the route's spec and never a
 * provider's name:
 *
 * - `SAME_UNIT` — the provider bills in the sales currency (or an exact multiple of
 *   it); the adapter decides exactness and nothing is converted.
 * - `FIXED_RATE` — an operator-set rate on the route, `providerUnitRateMinor`,
 *   snapshotted on every attempt. No feed is consulted.
 * - `CENTRAL_FX` — the central quote for the route's base asset, combined with the
 *   route's configured unit ratio, both snapshotted on the attempt.
 *
 * A provider that converts on ITS side and tells Nexa the figure ("provider-derived")
 * is deliberately not a member: no adapter does it, and a policy with nothing behind
 * it is the switch that turns nothing on. It arrives with the adapter that needs it.
 */
export const GATEWAY_CONVERSION_POLICIES = ['SAME_UNIT', 'FIXED_RATE', 'CENTRAL_FX'] as const;
export type GatewayConversionPolicy = (typeof GATEWAY_CONVERSION_POLICIES)[number];
export const gatewayConversionPolicySchema = z.enum(GATEWAY_CONVERSION_POLICIES);

/**
 * What a route's descriptor declares about conversion.
 *
 * `policies` is what the route CAN do; which one an attempt USES is decided by the
 * route's mode setting when it has more than one. The setting keys are named HERE, in
 * the descriptor, so the core reads them generically and no gateway's name appears in
 * the payment core (brief: "Do not special-case future USDT gateway names").
 */
export interface GatewayConversionSpec {
  readonly policies: readonly GatewayConversionPolicy[];
  /** The asset a `CENTRAL_FX` route's unit is pegged to. Null unless the route may use it. */
  readonly fxBaseAsset: FxBaseAsset | null;
  /** The setting that picks the policy, when there is more than one. */
  readonly modeSetting: string | null;
  /** The setting holding provider units per base unit, for `CENTRAL_FX`. */
  readonly unitRatioSetting: string | null;
}

/** Whether a route may be priced by an operator-set rate (and so takes one). */
export function takesFixedRate(spec: GatewayConversionSpec): boolean {
  return spec.policies.includes('FIXED_RATE');
}

/**
 * The Stars route's pricing mode (`stars.pricing_mode`). `FIXED_RATE` is the default
 * and what every existing installation keeps after the upgrade; an operator switches
 * to `CENTRAL_FX_RATIO` explicitly, and nothing switches it for them.
 */
export const STARS_PRICING_MODES = ['FIXED_RATE', 'CENTRAL_FX_RATIO'] as const;
export type StarsPricingMode = (typeof STARS_PRICING_MODES)[number];
export const starsPricingModeSchema = z.enum(STARS_PRICING_MODES);

/**
 * The policy a route uses for one attempt, from its spec and its mode setting's value.
 *
 * A single-policy route ignores the mode. A route that may use the central rate uses it
 * only when the mode says so; any other value — including a stored value that no longer
 * parses — falls to `FIXED_RATE`, the conservative, operator-set figure, never to the feed.
 */
export function conversionPolicyFor(
  spec: GatewayConversionSpec,
  mode: unknown,
): GatewayConversionPolicy {
  const first = spec.policies[0];
  if (first === undefined) throw new Error('a conversion spec declares at least one policy');
  if (spec.policies.length === 1) return first;
  if (mode === 'CENTRAL_FX_RATIO' && spec.policies.includes('CENTRAL_FX')) return 'CENTRAL_FX';
  if (spec.policies.includes('FIXED_RATE')) return 'FIXED_RATE';
  return first;
}

/**
 * The conversion an attempt was resolved to, handed to the adapter and snapshotted.
 * Everything a later reader needs to explain the provider figure is in here.
 */
export type ResolvedConversion =
  | { readonly policy: 'SAME_UNIT' }
  | { readonly policy: 'FIXED_RATE'; readonly rateMinor: bigint }
  | {
      readonly policy: 'CENTRAL_FX';
      readonly quote: FxQuote;
      readonly unitRatio: FxUnitRatio;
    };

/** The bound a snapshot column holds; a rate mantissa past it is refused at the boundary. */
export const FX_MANTISSA_MAX = MAX_MONEY_AMOUNT_MINOR;
