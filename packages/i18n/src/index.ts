import {
  CURRENCY_EXPONENT,
  UNLIMITED_DURATION_DAYS,
  UNLIMITED_TRAFFIC_BYTES,
  isMoneyValue,
  splitByteCount,
  type ByteUnit,
  type Calendar,
  placeholderTokensIn,
  templateDefinition,
  TEMPLATE_KEYS,
  type Money,
  type PlaceholderDefinition,
  type PlaceholderType,
  type TemplateDefinition,
  type TemplateKey,
  type TemplateValue,
  type TemplateValues,
  type Translator,
} from '@nexa/contracts';
import { CATALOGUE_FA } from './catalogue.fa.js';

/**
 * @nexa/i18n — the shared message catalogue.
 *
 * One catalogue, used by BOTH the server/Telegram side and the web admin. This
 * is deliberate: the legacy system kept 36 editable texts in one surface and 608
 * in the other, for the same bot, and they diverged. A shared package makes that
 * divergence impossible for anything customer-facing.
 *
 * Presentation-only chrome that only one surface can ever show — nav labels,
 * table headers — stays in that surface under its own namespace and is checked
 * by the same missing-key script.
 */

export const LOCALES = ['fa'] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'fa';

const CATALOGUES: Readonly<Record<Locale, Readonly<Record<TemplateKey, string>>>> = {
  fa: CATALOGUE_FA,
};

export class MissingTranslationError extends Error {
  constructor(key: string, locale: string) {
    super(`No ${locale} translation for template key "${key}".`);
    this.name = 'MissingTranslationError';
  }
}

/**
 * Renders money through the single formatter, so a currency unit can never be
 * typed by hand into a template. The legacy system has two card-to-card
 * templates whose copy says تومان and ریال for the same `{price}` token.
 */
export function formatMoney(value: Money, locale: Locale = DEFAULT_LOCALE): string {
  const exponent = CURRENCY_EXPONENT[value.currency];
  const negative = value.amountMinor < 0n;
  const digits = (negative ? -value.amountMinor : value.amountMinor).toString();

  let major = digits;
  let minor = '';
  if (exponent > 0) {
    const padded = digits.padStart(exponent + 1, '0');
    major = padded.slice(0, padded.length - exponent);
    minor = padded.slice(padded.length - exponent);
  }

  const grouped = major.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const amount = minor ? `${grouped}.${minor}` : grouped;
  const unit = CURRENCY_UNIT[locale][value.currency] ?? value.currency;
  return `${negative ? '-' : ''}${amount} ${unit}`;
}

const CURRENCY_UNIT: Record<Locale, Partial<Record<Money['currency'], string>>> = {
  fa: { IRT: 'تومان', IRR: 'ریال', USD: 'دلار', EUR: 'یورو', USDT: 'تتر' },
};

/**
 * Escapes the five characters Telegram's HTML parser treats as markup.
 *
 * Applied to INTERPOLATED VALUES, never to the template body. The body's markup
 * was written by an administrator and is the point of choosing that format; a
 * value comes from an event message, a code or a display name and has no
 * business closing a tag. Without this, an operational event whose message
 * contains `<` breaks the parse and the notification fails to send — silently,
 * on the one channel that exists to tell somebody things are failing.
 */
export function escapeTelegramHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const BYTE_UNIT_WORD: Record<Locale, Readonly<Record<ByteUnit, string>>> = {
  fa: { PIB: 'پتابایت', TIB: 'ترابایت', GIB: 'گیگابایت', MIB: 'مگابایت', BYTE: 'بایت' },
};

/**
 * The word an unlimited allowance is shown as — the Web Admin's own word. One word for
 * traffic and for duration, because a customer reads «نامحدود» as one concept and two
 * spellings of it would look like two different offers.
 */
const UNLIMITED_WORD: Record<Locale, string> = { fa: 'نامحدود' };

/** The unit a duration is shown in. Days are the only unit a plan is sold in. */
const DAY_WORD: Record<Locale, string> = { fa: 'روز' };

/** A byte QUANTITY, human-readable: `53687091200` is «50 گیگابایت». Zero is «0 بایت». */
export function formatBytes(bytes: bigint, locale: Locale = DEFAULT_LOCALE): string {
  const { whole, tenths, unit } = splitByteCount(bytes);
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const amount = tenths === 0n ? grouped : `${grouped}.${tenths.toString()}`;
  return `${amount} ${BYTE_UNIT_WORD[locale][unit]}`;
}

/** A traffic ALLOWANCE: `UNLIMITED_TRAFFIC_BYTES` is the word for unlimited, never «0». */
export function formatTrafficLimit(bytes: bigint, locale: Locale = DEFAULT_LOCALE): string {
  return bytes === UNLIMITED_TRAFFIC_BYTES ? UNLIMITED_WORD[locale] : formatBytes(bytes, locale);
}

/**
 * A validity DURATION in days: `30` is «30 روز», and `UNLIMITED_DURATION_DAYS` (zero) is
 * the word for unlimited, never «0». Before this a `DURATION_DAYS` value fell through to
 * `String`, so the customer read «مدت: 30» with no unit and «مدت: 0» for a plan with no
 * time limit (`docs/prerelease-hardening-audit.md` §4). Latin digits, like `formatMoney`.
 */
export function formatDurationDays(days: number | bigint, locale: Locale = DEFAULT_LOCALE): string {
  const count = BigInt(days);
  if (count === BigInt(UNLIMITED_DURATION_DAYS)) return UNLIMITED_WORD[locale];
  return `${count.toString()} ${DAY_WORD[locale]}`;
}

/**
 * How a tenant wants an instant shown: in which zone, and on which calendar.
 *
 * Storage is UTC `timestamptz` everywhere; this is the presentation the Time rule in
 * `docs/conventions.md` says lives on the tenant. It is a value, not a lookup — the
 * application layer resolves it once per render and hands it down, so the renderer
 * stays pure.
 */
export interface TemplatePresentation {
  /** An IANA zone name, `Asia/Tehran` by default. */
  readonly timezone: string;
  readonly calendar: Calendar;
}

/**
 * What a render with no tenant behind it uses — a `SystemContext`, or a caller that
 * has not resolved a tenant. Declared ONCE, here, so the fallback cannot drift between
 * the reader that answers for a system scope and a test that expects it.
 */
export const DEFAULT_TEMPLATE_PRESENTATION: TemplatePresentation = Object.freeze({
  timezone: 'Asia/Tehran',
  calendar: 'jalali',
});

/**
 * The Unicode calendar identifier for each calendar this product presents, with Latin
 * digits pinned: `formatMoney` renders `145,000`, and a date beside it in Persian digits
 * would be two numbering systems in one message.
 */
const PRESENTATION_LOCALE: Readonly<Record<Calendar, string>> = {
  jalali: 'fa-IR-u-ca-persian-nu-latn',
  gregorian: 'fa-IR-u-ca-gregory-nu-latn',
};

const DATE_PARTS = ['year', 'month', 'day', 'hour', 'minute'] as const;
type DatePart = (typeof DATE_PARTS)[number];

function isDatePart(type: string): type is DatePart {
  return (DATE_PARTS as readonly string[]).includes(type);
}

/**
 * Formats through `Intl.DateTimeFormat`, but assembles the string from its PARTS.
 *
 * `format()` would also emit the locale's separators, and those are CLDR data: the
 * text between the date and the time for `fa-IR` has changed between ICU releases, and
 * Node bumps ICU within a release line. The calendar arithmetic is what Intl is for;
 * the layout is ours, so a Node upgrade cannot silently reword every customer message.
 * `hourCycle: 'h23'` rather than `hour12: false`, because the latter has rendered
 * midnight as `24:00` in some ICU versions.
 */
function dateParts(
  date: Date,
  presentation: TemplatePresentation,
  withTime: boolean,
): Record<DatePart, string> {
  const formatter = new Intl.DateTimeFormat(PRESENTATION_LOCALE[presentation.calendar], {
    timeZone: presentation.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(withTime ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } : {}),
  });
  const parts: Record<DatePart, string> = { year: '', month: '', day: '', hour: '', minute: '' };
  for (const part of formatter.formatToParts(date)) {
    if (isDatePart(part.type)) parts[part.type] = part.value;
  }
  return parts;
}

/** An instant as a tenant reads it: `1405/07/02 22:00` for `2026-09-24T18:30:00Z` in Tehran, Jalali. */
export function formatDateTime(date: Date, presentation: TemplatePresentation): string {
  const p = dateParts(date, presentation, true);
  return `${p.year}/${p.month}/${p.day} ${p.hour}:${p.minute}`;
}

/** The calendar date alone — for an expiry, where the time of day is noise. */
export function formatDateOnly(date: Date, presentation: TemplatePresentation): string {
  const p = dateParts(date, presentation, false);
  return `${p.year}/${p.month}/${p.day}`;
}

function isWholeNumber(value: TemplateValue): value is number | bigint {
  return typeof value === 'bigint' || (typeof value === 'number' && Number.isSafeInteger(value));
}

function renderValue(
  value: TemplateValue,
  locale: Locale,
  type: PlaceholderType,
  presentation: TemplatePresentation | undefined,
): string {
  if (isMoneyValue(value)) return formatMoney(value, locale);
  // ISO when no presentation was resolved: the caller has no tenant to ask, and an
  // unambiguous instant beats a guessed calendar.
  if (value instanceof Date) {
    return presentation === undefined ? value.toISOString() : formatDateTime(value, presentation);
  }
  /*
   * A figure's unit is the renderer's, as the placeholder declarations have always said:
   * before this, `BYTES` and `DURATION_DAYS` fell through to `String` and the customer
   * read the stored integer. A whole number only; anything else is shown as given rather
   * than guessed at.
   */
  if (isWholeNumber(value)) {
    if (type === 'TRAFFIC_LIMIT') return formatTrafficLimit(BigInt(value), locale);
    if (type === 'BYTES') return formatBytes(BigInt(value), locale);
    if (type === 'DURATION_DAYS') return formatDurationDays(value, locale);
  }
  return String(value);
}

const PLACEHOLDER_EXPRESSION = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Renders one body against one key's declaration.
 *
 * The single renderer. The built-in catalogue and a tenant's override go
 * through this same function, so a message cannot render differently depending
 * on whether somebody has customised it.
 *
 * Only DECLARED tokens are substituted. An undeclared token is left exactly as
 * written — which is what lets `اشتراک رایگان {تست}` survive, and what makes an
 * undeclared token in the built-in catalogue a CI failure rather than the string
 * "undefined" reaching a customer. A declared REQUIRED token with no value is
 * also left as written: `validateTemplateValues` refuses such a send before it
 * gets here, and a preview of a half-filled form is expected to show the token.
 *
 * A declared OPTIONAL token with no value renders as the empty string, and a
 * line whose placeholders are ALL such tokens is dropped — the line, its label
 * text and ONE newline (the one after it, or the one before it for the last
 * line), so two paragraphs a dropped line separated stay one blank line apart.
 * Before this, a customer whose service had no expiry read `{expiresAt}`, one
 * never synced read `{syncedAt}`, and a summary with no reserved name read
 * `{username}`. A line where at least one placeholder still has a value is
 * kept, with its absent optional tokens empty: dropping it would take a fact
 * the customer was owed with it. The decision is per line, so a body's
 * paragraphs are not consulted: a paragraph made only of dropped lines leaves
 * the blank line that separated it from its neighbour.
 *
 * With a `presentation`, a `DATETIME` value is shown in the tenant's zone and
 * calendar; without one it is ISO-8601 UTC, the unambiguous form for a caller
 * that has no tenant to ask.
 */
export function renderTemplateBody(
  definition: TemplateDefinition,
  body: string,
  values: TemplateValues,
  locale: Locale = DEFAULT_LOCALE,
  presentation?: TemplatePresentation,
): string {
  const declared = new Map<string, PlaceholderDefinition>(
    definition.placeholders.map((p) => [p.token, p]),
  );
  const escape = definition.format === 'TELEGRAM_HTML' ? escapeTelegramHtml : (s: string) => s;

  const absentOptional = (token: string): boolean => {
    const placeholder = declared.get(token);
    return placeholder !== undefined && !placeholder.required && values[token] === undefined;
  };

  const rendered: string[] = [];
  for (const line of body.split('\n')) {
    const tokens = [...line.matchAll(PLACEHOLDER_EXPRESSION)].map((m) => m[1] as string);
    if (tokens.length > 0 && tokens.every(absentOptional)) continue;

    rendered.push(
      line.replace(PLACEHOLDER_EXPRESSION, (match, token: string) => {
        const placeholder = declared.get(token);
        if (placeholder === undefined) return match;
        const value = values[token];
        if (value === undefined) return placeholder.required ? match : '';
        return escape(renderValue(value, locale, placeholder.type, presentation));
      }),
    );
  }
  return rendered.join('\n');
}

export class CatalogueTranslator implements Translator {
  constructor(readonly locale: Locale = DEFAULT_LOCALE) {}

  has(key: TemplateKey): boolean {
    return key in CATALOGUES[this.locale];
  }

  translate(key: TemplateKey, values: TemplateValues = {}): string {
    const template = CATALOGUES[this.locale][key];
    if (template === undefined) throw new MissingTranslationError(key, this.locale);
    return renderTemplateBody(templateDefinition(key), template, values, this.locale);
  }
}

export function createTranslator(locale: Locale = DEFAULT_LOCALE): Translator {
  return new CatalogueTranslator(locale);
}

/** Used by the CI missing-key check and by tests. */
export function auditCatalogue(locale: Locale): {
  missing: string[];
  undeclaredTokens: { key: string; token: string }[];
} {
  const catalogue = CATALOGUES[locale];
  const missing: string[] = [];
  const undeclaredTokens: { key: string; token: string }[] = [];

  for (const key of TEMPLATE_KEYS) {
    const text = catalogue[key];
    if (text === undefined) {
      missing.push(key);
      continue;
    }
    const declared = new Set(templateDefinition(key).placeholders.map((p) => p.token));
    for (const token of placeholderTokensIn(text)) {
      if (!declared.has(token)) undeclaredTokens.push({ key, token });
    }
  }

  return { missing, undeclaredTokens };
}

export { CATALOGUE_FA };
