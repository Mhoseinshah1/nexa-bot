import { type TemplateDefinition, type TemplateKey, type TemplateValues } from '@nexa/contracts';
import { CATALOGUE_FA, LOCALES, renderTemplateBody, type Locale } from '@nexa/i18n';
import type { TemplateCatalogue } from '../application/ports.js';

const CATALOGUES: Readonly<Record<Locale, Readonly<Record<TemplateKey, string>>>> = {
  fa: CATALOGUE_FA,
};

/**
 * The shared Persian catalogue, behind the port.
 *
 * `@nexa/i18n` is a pure package with no I/O, so binding it here buys nothing at
 * runtime. What it buys is that the application layer states what it needs
 * rather than naming who provides it — which is what makes the second-locale
 * path in ADR-0016 something a test can exercise instead of something a
 * docstring asserts.
 */
export class I18nTemplateCatalogue implements TemplateCatalogue {
  defaultBody(key: TemplateKey, locale: string): string {
    const catalogue = CATALOGUES[locale as Locale];
    if (catalogue === undefined) {
      throw new Error(`No catalogue for locale "${locale}". Known locales: ${LOCALES.join(', ')}.`);
    }
    return catalogue[key];
  }

  render(
    definition: TemplateDefinition,
    body: string,
    values: TemplateValues,
    locale: string,
  ): string {
    return renderTemplateBody(definition, body, values, locale as Locale);
  }
}
