import { CURRENCY_EXPONENT, type CurrencyCode, type MoneyWire } from '@nexa/contracts';
import { t, type WebKey } from './i18n/web.fa';

/**
 * Presentation-only formatting for the admin.
 *
 * Timestamps cross the HTTP seam as ISO-8601 UTC strings, which is the right
 * wire format and the wrong thing to show a person: `2026-09-02T11:04:07.113Z`
 * asks a Persian-speaking operator to do timezone arithmetic in their head. The
 * calendar is a display concern, so the conversion belongs exactly here — one
 * function, at the edge, never in a stored value.
 *
 * HALF of `docs/conventions.md`'s rule, and the half this can satisfy alone.
 * The rule is "display timezone AND calendar live on the tenant"; this renders
 * the Jalali calendar but in the VIEWER'S browser zone, because the tenant's
 * `display_timezone` is not on the wire for any of these responses. Two
 * operators in different zones therefore see different times for one event.
 * Fixing it means carrying the tenant's zone to the client, which is a change
 * to the session response rather than to this file, and it is recorded in
 * docs/open-questions.md beside the date-format decision it belongs with.
 */

const DATE_TIME = new Intl.DateTimeFormat('fa-IR', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

/**
 * An ISO timestamp as a Jalali date and time in the viewer's own zone.
 *
 * An unparseable string is returned unchanged rather than rendered as an
 * "Invalid Date". If the server ever sends something unexpected, showing it is
 * more useful than hiding it behind a word that says nothing about what
 * arrived.
 */
export function formatTimestamp(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return DATE_TIME.format(at);
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/**
 * Digits and grouping for every number this admin renders.
 *
 * `en-US` rather than `fa-IR`, and it is a decision rather than a default. The
 * owner's revision specifies the rendering twice by example — `13,125,012 ت`
 * and `20,000 تومان` — and both are Latin digits with a comma group separator.
 * `fa-IR` would produce `۱۳٬۱۲۵٬۰۱۲`, which is not what was asked for.
 *
 * ONE formatter, because the failure this prevents is two of them: the legacy
 * system renders the same figure differently on two screens, and a
 * reconciliation that has to guess which surface is lying is a reconciliation
 * nobody does. Dates stay `fa-IR` — a Jalali calendar is what an operator
 * reads — and that asymmetry is deliberate rather than an oversight.
 */
const GROUPED = new Intl.NumberFormat('en-US', { useGrouping: true });

/** An integer with thousands separators. Never abbreviated. */
export function formatNumber(value: number): string {
  return GROUPED.format(value);
}

/**
 * What each currency is CALLED.
 *
 * A lookup keyed by the contract enum, because the one thing the owner's
 * revision forbids outright is a hardcoded Toman: "Do not hardcode Toman where
 * the bot/store may use Rial." A caller that holds a `Money` cannot render the
 * wrong unit, because the unit comes from the value.
 *
 * The map holds catalogue KEYS rather than the Persian words themselves. That
 * buys both halves at once: `check:i18n` keeps every customer-visible string in
 * `web.fa.ts` where it can be found and changed, and `Record<CurrencyCode, ...>`
 * makes a currency added to `CURRENCY_CODES` without a label a compile error
 * rather than a blank unit on a screen.
 */
const CURRENCY_KEY: Readonly<Record<CurrencyCode, WebKey>> = {
  IRT: 'web.currency_irt',
  IRR: 'web.currency_irr',
  USD: 'web.currency_usd',
  EUR: 'web.currency_eur',
  USDT: 'web.currency_usdt',
};

export function currencyLabel(currency: CurrencyCode): string {
  return t(CURRENCY_KEY[currency]);
}

/**
 * The resolved labels, for the test that asserts none is blank.
 *
 * `Record<CurrencyCode, WebKey>` already makes a MISSING entry a compile error.
 * What it cannot catch is an entry pointing at an empty string, which renders
 * as an amount with no unit — the exact thing this file exists to prevent.
 */
export const CURRENCY_LABEL_FOR_TEST: Readonly<Record<CurrencyCode, string>> = Object.fromEntries(
  Object.entries(CURRENCY_KEY).map(([code, key]) => [code, t(key)]),
) as Record<CurrencyCode, string>;

export interface FormattedMoney {
  /** The full amount, grouped. Never abbreviated, never rounded. */
  readonly amount: string;
  /** What that amount is denominated in. */
  readonly unit: string;
}

/**
 * The canonical money renderer. There is no second one.
 *
 * Three rules, each from a named legacy failure or an owner revision:
 *
 *   - **Full value, always.** `13 میلیون تومان` is not a figure an operator can
 *     reconcile against a gateway statement, and rounding a total for display
 *     is how two screens come to disagree about the same money.
 *   - **The unit comes from the VALUE**, never from the call site. An amount
 *     without a currency is not money — it is a number somebody will assume is
 *     Toman.
 *   - **Minor units are exact.** `amountMinor` arrives as a decimal STRING
 *     precisely so a total above 2^53 survives the trip; parsing it into a
 *     `number` here would undo that at the last step. The scaling is done on
 *     the digits.
 */
export function formatMoney(value: MoneyWire): FormattedMoney {
  const exponent = CURRENCY_EXPONENT[value.currency];
  const negative = value.amountMinor.startsWith('-');
  const digits = negative ? value.amountMinor.slice(1) : value.amountMinor;

  const padded = digits.padStart(exponent + 1, '0');
  const whole = exponent === 0 ? padded : padded.slice(0, padded.length - exponent);
  const fraction = exponent === 0 ? '' : padded.slice(padded.length - exponent);

  const groupedWhole = groupDigits(whole);
  const amount = `${negative ? '−' : ''}${groupedWhole}${fraction ? `.${fraction}` : ''}`;

  return { amount, unit: currencyLabel(value.currency) };
}

/**
 * Thousands separators on an arbitrarily long digit string.
 *
 * `Intl.NumberFormat` is not used here because it takes a `number`, and the
 * whole reason `amountMinor` is a string is that a `number` cannot hold every
 * value this product allows. Grouping digits is the part of formatting that
 * does not need the value to be numeric at all.
 */
function groupDigits(digits: string): string {
  const out: string[] = [];
  for (let index = digits.length; index > 0; index -= 3) {
    out.unshift(digits.slice(Math.max(0, index - 3), index));
  }
  return out.join(',');
}

/** The same value as one string, for a title attribute or a copy payload. */
export function formatMoneyText(value: MoneyWire): string {
  const { amount, unit } = formatMoney(value);
  return `${amount} ${unit}`;
}

// ---------------------------------------------------------------------------
// Duration
// ---------------------------------------------------------------------------

/**
 * A millisecond interval as a coarse, readable figure.
 *
 * Used for cadences and freshness, where "every 3 minutes" is the useful fact
 * and "every 180000 ms" is not. Returns the number and a unit KEY rather than a
 * sentence, so the Persian word comes from the catalogue like every other
 * customer-visible string.
 */
export function splitDuration(ms: number): { value: number; unit: 'second' | 'minute' | 'hour' } {
  if (ms % 3_600_000 === 0 && ms >= 3_600_000) return { value: ms / 3_600_000, unit: 'hour' };
  if (ms % 60_000 === 0 && ms >= 60_000) return { value: ms / 60_000, unit: 'minute' };
  return { value: Math.round(ms / 1000), unit: 'second' };
}

// ---------------------------------------------------------------------------
// Traffic
// ---------------------------------------------------------------------------

/** Binary units, because a panel's allowance is a power of two and not of ten. */
const BYTE_UNITS: readonly { readonly factor: bigint; readonly key: WebKey }[] = [
  { factor: 1_125_899_906_842_624n, key: 'web.unit_pib' },
  { factor: 1_099_511_627_776n, key: 'web.unit_tib' },
  { factor: 1_073_741_824n, key: 'web.unit_gib' },
  { factor: 1_048_576n, key: 'web.unit_mib' },
];

/**
 * A traffic allowance as a figure and a unit.
 *
 * `bigint` in, because the value crosses the wire as a decimal STRING for a reason: a
 * byte count passes 2^53 at eight petabytes and `Number` would round it. Dividing in
 * `bigint` and taking one decimal place by hand keeps that exact all the way to the
 * screen.
 *
 * Returns the pieces rather than a sentence, so the Persian unit comes from the
 * catalogue like every other visible string. `UNLIMITED_TRAFFIC_BYTES` — zero — is NOT
 * handled here: zero means "no limit" in `catalog.ts` and the caller renders that as a
 * word, because a formatter that returned "0 MiB" for it would be stating the opposite.
 */
export function splitBytes(bytes: bigint): { value: string; unit: WebKey } {
  const chosen = BYTE_UNITS.find((candidate) => bytes >= candidate.factor) ?? {
    factor: 1n,
    key: 'web.unit_bytes' as WebKey,
  };
  const whole = bytes / chosen.factor;
  // One decimal place, computed in `bigint` so nothing rounds on the way. A value that
  // divides exactly shows no decimal at all, which is the common case for a plan.
  const tenths = ((bytes - whole * chosen.factor) * 10n) / chosen.factor;
  const value =
    tenths === 0n ? formatNumber(Number(whole)) : `${formatNumber(Number(whole))}.${tenths}`;
  return { value, unit: chosen.key };
}
