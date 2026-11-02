import {
  CURRENCY_EXPONENT,
  formatTrafficGb,
  splitByteCount,
  type ByteUnit,
  type CurrencyCode,
  type MoneyWire,
} from '@nexa/contracts';
import { groupTrafficFigure } from '@nexa/i18n';
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

/**
 * An ISO timestamp as a Jalali date and time in the viewer's own zone, in the approved
 * demo's numeric shape — `1405/07/14 19:30` (`formatTimestampNumeric`). The demo draws every
 * date-time this way on every page (measured on 35 routes: no month name anywhere), so this
 * is the ONE place the shape is decided; a page never picks its own.
 *
 * An unparseable string is returned unchanged rather than rendered as an
 * "Invalid Date". If the server ever sends something unexpected, showing it is
 * more useful than hiding it behind a word that says nothing about what
 * arrived.
 */
export function formatTimestamp(iso: string): string {
  return formatTimestampNumeric(iso);
}

/**
 * «5 روز پیش»: how long before `nowMs` an ISO timestamp was, in Latin digits — the demo's
 * relative cells. Past a month, or for a time in the future or an unparseable string, the
 * absolute `formatTimestamp` is returned instead; callers keep that as the cell's title.
 * `nowMs` is the clock the caller already reads (`Date.now()`, frozen in the shots).
 */
export function formatRelative(iso: string, nowMs: number = Date.now()): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at) || at > nowMs) return formatTimestamp(iso);
  const minutes = Math.floor((nowMs - at) / 60_000);
  if (minutes < 1) return t('web.rel_now');
  if (minutes < 60) return `${formatNumber(minutes)} ${t('web.rel_minutes_ago')}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${formatNumber(hours)} ${t('web.rel_hours_ago')}`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${formatNumber(days)} ${t('web.rel_days_ago')}`;
  return formatTimestamp(iso);
}

const DATE_TIME_NUMERIC = new Intl.DateTimeFormat('fa-IR-u-nu-latn', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/**
 * An ISO timestamp as the approved demo's list cells draw one — `1405/07/14 19:30`: the Jalali
 * date in numbers, then the 24-hour time, in Latin digits (the owner's R11 decision, matching
 * the approved demo). `formatTimestamp` is this shape too; the name stays for the callers that
 * ask for the numeric form explicitly.
 */
export function formatTimestampNumeric(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const parts = new Map(
    DATE_TIME_NUMERIC.formatToParts(at).map((one) => [one.type, one.value] as const),
  );
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.get(type) ?? '';
  // Isolated left to right (U+2066 … U+2069), so the date reads before the time as the demo
  // draws it, whatever the direction of the cell around it.
  return `\u2066${part('year')}/${part('month')}/${part('day')} ${part('hour')}:${part('minute')}\u2069`;
}

const DATE_ONLY_NUMERIC = new Intl.DateTimeFormat('fa-IR-u-nu-latn', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * An ISO timestamp as a Jalali DATE alone, in the viewer's own zone and the demo's numeric
 * shape (`1405/06/28`) — for a fact that is a day rather than an instant, such as the
 * original purchase of an imported service. The same unparseable-string rule as
 * `formatTimestamp`.
 */
export function formatDate(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const parts = new Map(
    DATE_ONLY_NUMERIC.formatToParts(at).map((one) => [one.type, one.value] as const),
  );
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.get(type) ?? '';
  return `\u2066${part('year')}/${part('month')}/${part('day')}\u2069`;
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
 * nobody does. Dates use the Jalali calendar (`fa-IR-u-nu-latn`): the calendar is what an
 * operator reads, the digits are Latin everywhere (owner decision, R11 — it reverses the
 * earlier "dates in Persian digits" choice, so one screen never mixes the two).
 */
const GROUPED = new Intl.NumberFormat('en-US', { useGrouping: true });

/** An integer with thousands separators. Never abbreviated. */
export function formatNumber(value: number): string {
  return GROUPED.format(value);
}

/**
 * A decimal STRING (a rate the server rendered exactly, e.g. `103500.0000`) grouped like
 * every other figure, its fraction kept as written minus trailing zeros. Never through a
 * `number`: the integer part is a `bigint`, so nothing is rounded on the way to the screen.
 * Anything that is not a plain decimal is shown as given.
 */
export function formatDecimalText(text: string): string {
  const match = /^(\d+)(?:\.(\d+))?$/u.exec(text);
  if (match === null) return text;
  const whole = GROUPED.format(BigInt(match[1] as string));
  const fraction = (match[2] ?? '').replace(/0+$/u, '');
  return fraction === '' ? whole : `${whole}.${fraction}`;
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

/** The catalogue word for each unit of the shared rule (`splitByteCount`, binary). */
const BYTE_UNIT_KEYS: Readonly<Record<ByteUnit, WebKey>> = {
  PIB: 'web.unit_pib',
  TIB: 'web.unit_tib',
  GIB: 'web.unit_gib',
  MIB: 'web.unit_mib',
  BYTE: 'web.unit_bytes',
};

/**
 * A traffic AMOUNT as the figure the Web Admin shows in GB (Package C): at most two
 * decimals, the nearest hundredth, trailing zeros dropped, thousands grouped — `10`,
 * `10.5`, `10.25`, `1,024`. The same figure the bot shows (`formatBytes` in
 * `@nexa/i18n`), because both are `formatTrafficGb` grouped by one function. The unit is
 * `web.unit_gib`, from the catalogue.
 *
 * Every traffic amount goes through here. `splitBytes` below is for file sizes only.
 */
export function formatTrafficGbText(bytes: bigint): string {
  return groupTrafficFigure(formatTrafficGb(bytes));
}

/**
 * A byte count — a file's size — as a figure and a unit. Traffic amounts are shown in GB by
 * `formatTrafficGbText`, not here (Package C).
 *
 * `bigint` in, because the value crosses the wire as a decimal STRING for a reason: a
 * byte count passes 2^53 at eight petabytes and `Number` would round it. The division is
 * `splitByteCount`'s, in `@nexa/contracts` — the same rule the bot's renderer uses, so
 * one figure cannot read as 50 GiB here and as something else in Telegram.
 *
 * Returns the pieces rather than a sentence, so the Persian unit comes from the
 * catalogue like every other visible string. `UNLIMITED_TRAFFIC_BYTES` — zero — is NOT
 * handled here: zero means "no limit" in `catalog.ts` and the caller renders that as a
 * word, because a formatter that returned "0 MiB" for it would be stating the opposite.
 */
export function splitBytes(bytes: bigint): { value: string; unit: WebKey } {
  const { whole, tenths, unit } = splitByteCount(bytes);
  // A value that divides exactly shows no decimal at all, which is the common case for a plan.
  const value =
    tenths === 0n
      ? formatNumber(Number(whole))
      : `${formatNumber(Number(whole))}.${tenths.toString()}`;
  return { value, unit: BYTE_UNIT_KEYS[unit] };
}
