import {
  templateDefinition,
  type ScopeContext,
  type TemplateKey,
  type TemplateValues,
} from '@nexa/contracts';
import type { FeatureFlagResolver } from '../../features/application/feature-flags.service.js';
import type { TemplateCatalogue, TemplateRepository } from './ports.js';

/** The one locale this product ships. A second is a catalogue, not a refactor. */
export type Locale = string;

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
  readonly locale: string;
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
    const resolved = await this.resolve(scope, key, locale, tx);
    return this.catalogue.render(templateDefinition(key), resolved.body, values, locale);
  }
}
