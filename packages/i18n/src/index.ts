import {
  CURRENCY_EXPONENT,
  isMoneyValue,
  placeholderTokensIn,
  templateDefinition,
  TEMPLATE_KEYS,
  type Money,
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

function renderValue(value: TemplateValue, locale: Locale): string {
  if (isMoneyValue(value)) return formatMoney(value, locale);
  if (value instanceof Date) return value.toISOString();
  return String(value);
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
 * "undefined" reaching a customer.
 */
export function renderTemplateBody(
  definition: TemplateDefinition,
  body: string,
  values: TemplateValues,
  locale: Locale = DEFAULT_LOCALE,
): string {
  const declared = new Set(definition.placeholders.map((p) => p.token));
  const escape = definition.format === 'TELEGRAM_HTML' ? escapeTelegramHtml : (s: string) => s;

  return body.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, token: string) => {
    if (!declared.has(token)) return match;
    const value = values[token];
    return value === undefined ? match : escape(renderValue(value, locale));
  });
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
