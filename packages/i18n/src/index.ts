import {
  CURRENCY_EXPONENT,
  templateDefinition,
  TEMPLATE_KEYS,
  type Money,
  type TemplateKey,
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

function renderValue(value: string | number | bigint | Date): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export class CatalogueTranslator implements Translator {
  constructor(readonly locale: Locale = DEFAULT_LOCALE) {}

  has(key: TemplateKey): boolean {
    return key in CATALOGUES[this.locale];
  }

  translate(key: TemplateKey, values: TemplateValues = {}): string {
    const template = CATALOGUES[this.locale][key];
    if (template === undefined) throw new MissingTranslationError(key, this.locale);

    // Only declared placeholders are substituted. An undeclared token in the
    // template is left alone and reported by the missing-key check, rather than
    // being silently replaced with "undefined".
    const declared = new Set(templateDefinition(key).placeholders.map((p) => p.token));
    return template.replace(/\{(\w+)\}/g, (match, token: string) => {
      if (!declared.has(token)) return match;
      const value = values[token];
      return value === undefined ? match : renderValue(value);
    });
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
    for (const match of text.matchAll(/\{(\w+)\}/g)) {
      const token = match[1] as string;
      if (!declared.has(token)) undeclaredTokens.push({ key, token });
    }
  }

  return { missing, undeclaredTokens };
}

export { CATALOGUE_FA };
