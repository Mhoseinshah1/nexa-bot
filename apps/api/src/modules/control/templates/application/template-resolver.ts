import {
  CONTROL_ERROR_CODES,
  errors,
  templateDefinition,
  validateTemplateValues,
  type ScopeContext,
  type TemplateKey,
  type TemplateValues,
} from '@nexa/contracts';
import type { FeatureFlagResolver } from '../../features/application/feature-flags.service.js';
import type { TemplateCatalogue, TemplateRepository } from './ports.js';

/**
 * The locales this product ships.
 *
 * A UNION, not `string`. It was widened to `string` to make a call site
 * compile, and that turned a compile error into a runtime one: an unsupported
 * locale then flowed all the way to `templateDefinition`, which throws, and a
 * request answered 500 where the type system had been about to say no for free.
 * A second locale is a catalogue file plus one entry here.
 */
export const SUPPORTED_LOCALES = ['fa'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

/** Narrows a string from outside — a query parameter, a stored row. */
export function isLocale(value: string): value is Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/**
 * Resolves the body a message will actually be sent with.
 *
 * Unguarded, for the same reason as `SettingsResolver`: rendering a message the
 * system decided to send has no actor to authorize. Tenant scoping applies on
 * every read.
 *
 * The resolution order is: the tenant's override when one exists AND the
 * `template_overrides` feature is on, otherwise the built-in default. The flag
 * is not decoration — it is the recovery a legacy operator does not have, since
 * that surface has no reset control at all (UNK-TXT-008). Turning it off falls
 * every message back to the default without deleting an override or losing a
 * revision.
 */
export interface ResolvedTemplate {
  readonly key: TemplateKey;
  readonly locale: Locale;
  /** RAW source. This is what an edit field is populated from. */
  readonly body: string;
  readonly source: 'DEFAULT' | 'TENANT';
  /** True when an override exists but the feature flag is currently off. */
  readonly overrideSuppressed: boolean;
}

export const DEFAULT_TEMPLATE_LOCALE: Locale = 'fa';

export class TemplateResolver {
  constructor(
    private readonly templates: TemplateRepository,
    private readonly features: FeatureFlagResolver,
    private readonly catalogue: TemplateCatalogue,
  ) {}

  async resolve(
    scope: ScopeContext,
    key: TemplateKey,
    locale: Locale = DEFAULT_TEMPLATE_LOCALE,
    tx?: unknown,
  ): Promise<ResolvedTemplate> {
    const override = await this.templates.findOverride(scope, key, locale, tx);
    const overridesApplied = await this.features.isEnabled(scope, 'template_overrides', tx);

    if (override && overridesApplied) {
      return { key, locale, body: override.body, source: 'TENANT', overrideSuppressed: false };
    }
    return {
      key,
      locale,
      body: this.catalogue.defaultBody(key, locale),
      source: 'DEFAULT',
      overrideSuppressed: override !== null,
    };
  }

  /**
   * Renders a message for sending.
   *
   * The rendered string is returned to the caller and written nowhere. There is
   * no code path in this module that persists a rendered body — which is the
   * whole defence against the legacy edit screen, where the rendered form is
   * what an administrator sees and therefore what they save back.
   */
  async render(
    scope: ScopeContext,
    key: TemplateKey,
    values: TemplateValues,
    locale: Locale = DEFAULT_TEMPLATE_LOCALE,
    tx?: unknown,
  ): Promise<string> {
    const definition = templateDefinition(key);

    // The values are checked HERE, on the way to a customer, and not only when
    // an administrator previews.
    //
    // `catalogue.render` substitutes what it is given and stringifies the rest,
    // so a missing required value leaves a literal `{token}` in the message and
    // a wrong type renders as whatever `String()` makes of it. `TemplateValues`
    // is not keyed to a template at compile time and a stored payload is only
    // cast on the way out of the database, so neither the type system nor the
    // schema stops an emitter's mistake or a payload written by hand. Without
    // this, such a message is sent and recorded SENT — the system reporting
    // success for something a customer received as `{first_name}`.
    //
    // A throw is right: the caller is the dispatcher, which turns it into a
    // permanently failed attempt with the reason recorded, and a body that
    // cannot render will not render on the next attempt either.
    const problems = validateTemplateValues(definition, values);
    if (problems.length > 0) {
      throw errors.validation(
        CONTROL_ERROR_CODES.INVALID_VALUE,
        `The values supplied for ${key} do not satisfy its declaration.`,
        { key, issues: problems },
      );
    }

    const resolved = await this.resolve(scope, key, locale, tx);
    return this.catalogue.render(definition, resolved.body, values, locale);
  }
}
