import {
  CURRENCY_EXPONENT,
  UNLIMITED_DURATION_DAYS,
  UNLIMITED_TRAFFIC_BYTES,
  isMoneyValue,
  money,
  formatTrafficGb,
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
  TELEGRAM_CAPTION_MAX_LENGTH,
  UNTRUSTED_VALUE_MAX_LENGTH,
  formatPersianInteger,
  toPersianDigits,
} from '@nexa/contracts';
import { CATALOGUE_FA } from './catalogue.fa.js';
export {
  OPERATIONAL_EVENT_FAMILY_LABELS_FA,
  OPERATIONAL_EVENT_LABELS_FA,
  operationalEventLabelFa,
} from './operational-events.fa.js';
export {
  OPERATIONAL_EVENT_MESSAGES_FA,
  operationalEventMessageFa,
} from './operational-event-messages.fa.js';
export {
  LOOP_LABELS_FA,
  PROCESS_ROLE_LABELS_FA,
  PROCESS_ROLE_LINE_LABEL_FA,
  UNKNOWN_LOOP_LABEL_FA,
  UNKNOWN_PROCESS_ROLE_LABEL_FA,
  loopLabelFa,
  processRoleLabelFa,
} from './loop-labels.fa.js';
export { CUSTOMER_NOTIFICATION_KIND_NAMES_FA } from './customer-notification-kinds.fa.js';
export { LEDGER_REASON_LABELS_FA } from './ledger-reasons.fa.js';
export { TONPAYS_REJECT_REASONS_FA, rejectReasonFa } from './gateway-reject-reasons.fa.js';
import { clipEntities, parseCaptionMarkup, type CaptionMarkup } from './caption-markup.js';

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
  const { figure, unit } = moneyParts(value, locale);
  return `${figure} ${unit}`;
}

/** U+2066 LEFT-TO-RIGHT ISOLATE … U+2069 POP DIRECTIONAL ISOLATE. */
export const LTR_ISOLATE = '\u2066';
export const POP_DIRECTIONAL_ISOLATE = '\u2069';

/**
 * `formatMoney`, with the figure — sign, digits, group and decimal separators — wrapped in a
 * left-to-right isolate (R11 hotfix): U+2066, «104,000», U+2069, then « تومان». The same
 * figure and the same unit; only the two invisible marks are added.
 *
 * For text that carries no formatting and sits in a right-to-left line: an inline-keyboard
 * button, whose text the Bot API takes as plain text. The isolate keeps the figure one
 * left-to-right run in logical order whatever surrounds it, so its digit groups can never be
 * reordered and the unit stays after it. Everywhere else `formatMoney` is used as it is.
 */
export function formatMoneyIsolated(value: Money, locale: Locale = DEFAULT_LOCALE): string {
  const { figure, unit } = moneyParts(value, locale);
  return `${LTR_ISOLATE}${figure}${POP_DIRECTIONAL_ISOLATE} ${unit}`;
}

/** The one place a money figure and its unit are worked out, for both formatters above. */
function moneyParts(value: Money, locale: Locale): { figure: string; unit: string } {
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
  return { figure: `${negative ? '-' : ''}${amount}`, unit };
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

/**
 * The unit every traffic amount is shown in (Package C): the gigabyte, which is the
 * binary 1 GiB this codebase has always shown and `BYTES_PER_GB` names.
 */
const GB_WORD: Record<Locale, string> = { fa: 'گیگابایت' };

/**
 * The word an unlimited allowance is shown as — the Web Admin's own word. One word for
 * traffic and for duration, because a customer reads «نامحدود» as one concept and two
 * spellings of it would look like two different offers.
 */
const UNLIMITED_WORD: Record<Locale, string> = { fa: 'نامحدود' };

/** The unit a duration is shown in. Days are the only unit a plan is sold in. */
const DAY_WORD: Record<Locale, string> = { fa: 'روز' };

/**
 * A traffic QUANTITY in GB (Package C, `docs/package-c-gb-normalization-audit.md`):
 * `formatTrafficGb`'s figure — at most two decimals, the nearest hundredth, trailing zeros
 * dropped — grouped in thousands, then the unit. `10737418240` is «10 گیگابایت»,
 * `11274289152` «10.5 گیگابایت», `11005853696` «10.25 گیگابایت», zero «0 گیگابایت».
 *
 * Every traffic amount a person is shown goes through here or the Web Admin's
 * `formatTrafficGbText`, which returns the same figure: one rule for the bot and the
 * admin. Never a JavaScript float, and never a raw byte count.
 */
export function formatBytes(bytes: bigint, locale: Locale = DEFAULT_LOCALE): string {
  return `${groupTrafficFigure(formatTrafficGb(bytes))} ${GB_WORD[locale]}`;
}

/** `1024.5` as `1,024.5`: thousands in the whole part only, the sign kept. */
export function groupTrafficFigure(figure: string): string {
  const [whole = '', fraction] = figure.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
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

/** The time of day alone, `23:22`, in the tenant's zone (owner spec §3: the account screen). */
export function formatTimeOnly(date: Date, presentation: TemplatePresentation): string {
  const p = dateParts(date, presentation, true);
  return `${p.hour}:${p.minute}`;
}

function isWholeNumber(value: TemplateValue): value is number | bigint {
  return typeof value === 'bigint' || (typeof value === 'number' && Number.isSafeInteger(value));
}

/**
 * A byte quantity as the operations log group reads it (Round 4 PR-D): zero is «0 بایت»,
 * never «0 گیگابایت» and never «NaN»; below a gibibyte the unit steps down so a 200 MB
 * trial is «200 مگابایت» and not «0.19 گیگابایت». Latin digits here; the caller converts.
 */
export function formatBytesForLog(bytes: bigint): string {
  if (bytes <= 0n) return '0 بایت';
  const KIB = 1024n;
  const MIB = KIB * 1024n;
  const GIB = MIB * 1024n;
  if (bytes < KIB) return `${bytes.toString()} بایت`;
  if (bytes < MIB) return `${((bytes * 10n + KIB / 2n) / KIB / 10n).toString()} کیلوبایت`;
  if (bytes < GIB) {
    const tenths = (bytes * 10n + MIB / 2n) / MIB;
    const whole = tenths / 10n;
    const fraction = tenths % 10n;
    return `${fraction === 0n ? whole.toString() : `${whole.toString()}.${fraction.toString()}`} مگابایت`;
  }
  return formatBytes(bytes);
}

function renderValue(
  value: TemplateValue,
  locale: Locale,
  type: PlaceholderType,
  presentation: TemplatePresentation | undefined,
  persian = false,
): string {
  if (!persian) return renderValuePlain(value, locale, type, presentation);
  /*
   * The operations log group's numerals (Round 4 PR-D). A STRING is never converted: it may
   * be an id, a username, a service name or a tracking code, and an operator copies those.
   * Everything the renderer itself formats — money, instants, quantities, counts — is.
   */
  if (typeof value === 'string') return value;
  if (isMoneyValue(value) || value instanceof Date) {
    return toPersianDigits(renderValuePlain(value, locale, type, presentation));
  }
  if (isWholeNumber(value)) {
    if (type === 'BYTES') return toPersianDigits(formatBytesForLog(BigInt(value)));
    if (type === 'TRAFFIC_LIMIT') {
      return BigInt(value) === UNLIMITED_TRAFFIC_BYTES
        ? UNLIMITED_WORD[locale]
        : toPersianDigits(formatBytesForLog(BigInt(value)));
    }
    if (type === 'DURATION_DAYS') return toPersianDigits(formatDurationDays(value, locale));
    return formatPersianInteger(value);
  }
  return toPersianDigits(String(value));
}

function renderValuePlain(
  value: TemplateValue,
  locale: Locale,
  type: PlaceholderType,
  presentation: TemplatePresentation | undefined,
): string {
  if (isMoneyValue(value)) return formatMoney(value, locale);
  // ISO when no presentation was resolved: the caller has no tenant to ask, and an
  // unambiguous instant beats a guessed calendar.
  if (value instanceof Date) {
    if (presentation === undefined) return value.toISOString();
    if (type === 'DATE') return formatDateOnly(value, presentation);
    if (type === 'TIME') return formatTimeOnly(value, presentation);
    return formatDateTime(value, presentation);
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

/** R6 item 3: the word after a negative balance shown as a debt («۱۲۰۰۰ تومان بدهی»). */
const DEBT_WORD: Record<Locale, string> = { fa: 'بدهی' };

const PLACEHOLDER_EXPRESSION = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/*
 * R6 item 3: what the one renderer does to a value that comes from a THIRD PARTY (a Telegram
 * display name). Control characters, the bidi controls (LRE..RLO, LRI..PDI, LRM, RLM, ALM),
 * zero-width space/joiner, the soft hyphen, the BOM, line and paragraph separators and the
 * private-use marks the instant renderer reserves are removed. U+200C (ZWNJ) is KEPT: it is
 * part of correct Persian spelling.
 */
const UNTRUSTED_STRIP =
  // eslint-disable-next-line no-control-regex -- stripping control characters is the purpose
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B\u200D-\u200F\u2028-\u202E\u2060-\u206F\uFEFF\uE000-\uE002]/gu;

/**
 * A third party's text made safe to put inside a message, whatever its format: control and
 * bidi characters removed, whitespace collapsed to single spaces, markup brackets removed,
 * `@` and `://` made inert (a name must not mention anybody or become a link), and the length
 * capped at `UNTRUSTED_VALUE_MAX_LENGTH` characters (never inside a surrogate pair). The
 * result may be empty, and an empty result is an ABSENT value to the renderer.
 *
 * HTML escaping is NOT done here: the renderer applies the key's own escape afterwards, so a
 * `TELEGRAM_HTML` key escapes what is left and a `PLAIN_TEXT` key has nothing to escape.
 */
export function sanitizeUntrustedText(raw: string): string {
  const cleaned = raw
    // eslint-disable-next-line no-control-regex -- line breaks become spaces
    .replace(/[\t\n\r\u000B\u000C\u0085\u2028\u2029]+/gu, ' ')
    .replace(UNTRUSTED_STRIP, '')
    .replace(/[<>]/gu, '')
    .replace(/@/gu, '\uFF20')
    .replace(/:\/\//gu, '\uFF1A//')
    .replace(/\s+/gu, ' ')
    .trim();
  const characters = Array.from(cleaned);
  return characters.length <= UNTRUSTED_VALUE_MAX_LENGTH
    ? cleaned
    : characters.slice(0, UNTRUSTED_VALUE_MAX_LENGTH).join('').trim();
}

/**
 * R6 item 3: closes the gap an absent value leaves in a line that keeps its other words — a
 * run of spaces becomes one, a space before «، ؛ , ; : . ! ؟ ? )» or after «( «» goes, doubled
 * commas become one, and punctuation or space at the start of the line is dropped — so
 * «سلام  عزیز» and «سلام ، خوش» can never be sent. Applied only to a line an absent
 * `COLLAPSE` value touched; every other line is byte for byte as written.
 */
export function closeGaps(line: string): string {
  return line
    .replace(/[ \u00A0]{2,}/gu, ' ')
    .replace(/ +([،؛,;:.!؟?)»])/gu, '$1')
    .replace(/([(«]) +/gu, '$1')
    .replace(/([،,])(?:\s*[،,])+/gu, '$1')
    .replace(/^[\s،؛,;:.\-–—!؟?]+/u, '')
    .trim();
}

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
  options: RenderOptions = {},
): string {
  const mark = options.markInstants === true && instantMarksAreFree(body, values);
  const declared = new Map<string, PlaceholderDefinition>(
    definition.placeholders.map((p) => [p.token, p]),
  );
  const escape = definition.format === 'TELEGRAM_HTML' ? escapeTelegramHtml : (s: string) => s;
  const persian = definition.digits === 'PERSIAN';

  /** The value as the renderer will use it: an untrusted one sanitised (R6 item 3). */
  const valueOf = (token: string): TemplateValue | undefined => {
    const value = values[token];
    if (value === undefined) return undefined;
    const placeholder = declared.get(token);
    return placeholder?.untrusted === true && typeof value === 'string'
      ? sanitizeUntrustedText(value)
      : value;
  };
  /** Absent: not supplied, or an untrusted value with nothing left once sanitised. */
  const isAbsent = (token: string): boolean => {
    const value = valueOf(token);
    return value === undefined || (declared.get(token)?.untrusted === true && value === '');
  };
  const absentOptional = (token: string): boolean => {
    const placeholder = declared.get(token);
    return placeholder !== undefined && !placeholder.required && isAbsent(token);
  };
  const collapses = (token: string): boolean => declared.get(token)?.whenEmpty === 'COLLAPSE';

  const rendered: string[] = [];
  let dropped = false;
  for (const line of body.split('\n')) {
    const tokens = [...line.matchAll(PLACEHOLDER_EXPRESSION)].map((m) => m[1] as string);
    // A line whose placeholders are ALL absent is dropped — unless one of them COLLAPSEs,
    // which keeps the line's own words (a greeting without a name is still a greeting).
    if (tokens.length > 0 && tokens.every(absentOptional) && !tokens.some(collapses)) {
      dropped = true;
      continue;
    }

    const text = line.replace(PLACEHOLDER_EXPRESSION, (match, token: string) => {
      const placeholder = declared.get(token);
      if (placeholder === undefined) return match;
      const value = valueOf(token);
      if (value === undefined || isAbsent(token)) return placeholder.required ? match : '';
      const shown = escape(
        placeholder.debtWhenNegative === true && isMoneyValue(value) && value.amountMinor < 0n
          ? `${renderValue(
              money(-BigInt(value.amountMinor), value.currency),
              locale,
              placeholder.type,
              presentation,
              persian,
            )} ${DEBT_WORD[locale]}`
          : renderValue(value, locale, placeholder.type, presentation, persian),
      );
      return mark &&
        value instanceof Date &&
        (placeholder.type === 'DATETIME' || placeholder.type === 'DATE')
        ? markInstant(value, shown)
        : shown;
    });
    if (tokens.some((token) => collapses(token) && absentOptional(token))) {
      const closed = closeGaps(text);
      if (closed === '') {
        dropped = true;
        continue;
      }
      rendered.push(closed);
      continue;
    }
    rendered.push(text);
  }
  /*
   * A paragraph that consisted only of dropped lines leaves its two separators behind
   * as a triple newline. Collapsed to one blank line — but ONLY when something was
   * dropped, so a body nothing was removed from renders byte for byte as written. A
   * dropped LAST paragraph (B14: «کد پیگیری پرداخت» two blank lines below the sentence)
   * leaves its separators at the end instead; they go too.
   */
  const joined = rendered.join('\n');
  return dropped ? joined.replace(/\n{3,}/g, '\n\n').replace(/\n+$/u, '') : joined;
}

/**
 * R4 PR-F (F6): how `renderTemplateBody` may be asked to render.
 *
 * `markInstants` wraps the rendering of every `DATETIME` and `DATE` value in three
 * private-use characters — `U+E000`, the value's Unix time in decimal, `U+E001`, the text
 * exactly as it renders without the option, `U+E002` — so the rich-message builder can put
 * Telegram's `date_time` rich text over exactly the date the customer reads. Nothing else
 * changes: without the marks the output is byte for byte the unmarked render (pinned by a
 * test). A body or a value that already contains one of the three characters is rendered
 * WITHOUT marks, so a tenant's text can never forge one.
 */
export interface RenderOptions {
  readonly markInstants?: boolean;
}

export const INSTANT_MARK_OPEN = '\uE000';
export const INSTANT_MARK_TEXT = '\uE001';
export const INSTANT_MARK_CLOSE = '\uE002';
const INSTANT_MARK_CHARS = /[\uE000-\uE002]/u;

function instantMarksAreFree(body: string, values: TemplateValues): boolean {
  if (INSTANT_MARK_CHARS.test(body)) return false;
  return Object.values(values).every(
    (value) => typeof value !== 'string' || !INSTANT_MARK_CHARS.test(value),
  );
}

function markInstant(value: Date, shown: string): string {
  const unix = Math.floor(value.getTime() / 1000);
  return `${INSTANT_MARK_OPEN}${String(unix)}${INSTANT_MARK_TEXT}${shown}${INSTANT_MARK_CLOSE}`;
}

/**
 * Track 3 §2: one connection-file caption, from a RAW template body — the panel's own
 * (`panel.connection_files.caption_template`) or the default key's resolved body — to the
 * text and Telegram entities that are sent. The ONE renderer: the bot's send and the Web
 * Admin's preview both call it, so the preview cannot show a caption the bot would not send.
 *
 * 1. `renderTemplateBody` under `bot.service.connection_files_caption`'s declaration — the
 *    twelve optional variables, an absent fact's line dropped, and (TELEGRAM_HTML) every
 *    value HTML-ESCAPED, so a username or a link carrying `<` is text, never markup.
 * 2. `parseCaptionMarkup` — the closed grammar: the operator's `<b>`/`<code>`/… become
 *    entities, anything else stays text. Telegram's HTML parser never sees the caption, so
 *    no template and no value can make a send fail to parse.
 * 3. Telegram's 1024-unit caption bound: a longer render is TRUNCATED, never refused — cut
 *    to 1023 units with a visible `…` (never inside a surrogate pair), every entity clipped
 *    to what is left. Truncation rather than a fallback, because the operator's own words,
 *    cut, still say more than a caption they did not write.
 *
 * An empty result means "no caption", and the caller sends the file bare.
 */
export function renderConnectionFileCaption(
  body: string,
  values: TemplateValues,
  presentation?: TemplatePresentation,
): CaptionMarkup {
  const rendered = renderTemplateBody(
    templateDefinition('bot.service.connection_files_caption'),
    body,
    values,
    DEFAULT_LOCALE,
    presentation,
  );
  return boundCaptionMarkup(parseCaptionMarkup(rendered));
}

/** A caption within Telegram's bound: cut with an ellipsis, its entities clipped to the cut. */
export function boundCaptionMarkup(markup: CaptionMarkup): CaptionMarkup {
  if (markup.text.length <= TELEGRAM_CAPTION_MAX_LENGTH) return markup;
  let cut = TELEGRAM_CAPTION_MAX_LENGTH - 1;
  const last = markup.text.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return {
    text: `${markup.text.slice(0, cut)}…`,
    entities: clipEntities(markup.entities, 0, cut),
  };
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
export {
  CAPTION_ENTITY_TYPES,
  clipEntities,
  parseCaptionMarkup,
  type CaptionEntity,
  type CaptionEntityType,
  type CaptionMarkup,
} from './caption-markup.js';
export {
  REPORT_EXPORT_HEADERS_FA,
  REPORT_EXPORT_SHEETS_FA,
  type ReportExportHeaderKey,
} from './reports.fa.js';
export { AUDIT_EXPORT_HEADERS_FA, type AuditExportHeaderKey } from './audit-log.fa.js';
export { PAYMENT_METHOD_NAMES_FA } from './payment-methods.fa.js';
export { OPS_LOG_BODIES_FA, OPS_LOG_BUTTON_LABELS_FA, OPS_LOG_WORDS_FA } from './ops-log.fa.js';
