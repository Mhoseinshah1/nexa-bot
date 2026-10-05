import {
  CONNECTION_GUIDE_PLATFORMS,
  SUPPORT_KNOWLEDGE_BUILD_LIMITS,
  SUPPORT_KNOWLEDGE_LIMITS,
  UNLIMITED_DURATION_DAYS,
  UNLIMITED_TRAFFIC_BYTES,
  neutralizeClientAppBareLinks,
  normalizeClientAppUrl,
  renderClientAppGuide,
  templateDefinition,
  type ProductId,
  type SupportKnowledgeBuildSourceType,
  type SupportKnowledgeCategory,
  type TemplateKey,
  type TenantContext,
} from '@nexa/contracts';
import { formatDurationDays, formatTrafficLimit } from '@nexa/i18n';
import type { ProductRepository } from '../../../commerce/catalog/application/ports.js';
import type { ServiceLocationRepository } from '../../../commerce/locations/application/ports.js';
import type { PaymentGatewayRepository } from '../../../commerce/payments/application/gateway-ports.js';
import type { ClientAppRepository } from '../../client-apps/application/ports.js';
import type { SettingsResolver } from '../../settings/application/settings-resolver.js';
import type { SupportFaqRepository } from '../../support/application/ports.js';
import type { TemplateResolver } from '../../templates/application/template-resolver.js';
import type { TermsRepository } from '../../terms/application/ports.js';
import type { KnowledgeBuildSources } from '../application/support-knowledge-build.service.js';
import type { BuildItem } from '../domain/build-diff.js';

/**
 * TB9 — THE source allowlist, as code (ADR-0035 §5).
 *
 * Each reader below takes one source's records and keeps ONLY their customer-facing fields;
 * everything else on the record is dropped here, before a proposal exists. What is never read:
 * a panel (name, address, credentials), a raw id in any text, an admin or CRM note, an
 * incident, reseller terms, a gateway's configuration or a payment account number, and any
 * customer row. The source key is the row's id where the source has rows: it stays on the
 * server to match an article, and is never part of an article's text.
 *
 * The labels below are scaffolding for an operator to review, never sent as they are: a
 * proposal becomes knowledge only when a reviewer applies it, and is free text from then on.
 */
export const BUILD_LABELS = {
  duration: 'مدت',
  traffic: 'حجم',
  devices: 'تعداد کاربر همزمان',
  unlimited: 'نامحدود',
  locations: 'موقعیت‌ها',
  features: 'ویژگی‌ها',
  locationsTitle: 'سرویس در چه موقعیت‌هایی ارائه می‌شود؟',
  appTitle: (name: string) => `برنامهٔ ${name}`,
  helpUrl: 'راهنما',
  officialUrl: 'دانلود',
  tutorialTitle: (platform: string) => `راهنمای اتصال در ${platform}`,
  supportTitle: 'چطور با پشتیبانی در تماس باشم؟',
  supportBody: 'حساب‌های پشتیبانی:',
  paymentTitle: (name: string) => `پرداخت با ${name}`,
} as const;

/** The tutorial templates the build reads. Each is checked to declare no placeholder. */
export const BUILD_TUTORIAL_KEYS: readonly TemplateKey[] = CONNECTION_GUIDE_PLATFORMS.map(
  (platform) => `bot.tutorial.${platform.toLowerCase()}` as TemplateKey,
);

const PLATFORM_NAMES: Readonly<Record<string, string>> = {
  ANDROID: 'Android',
  IOS: 'iOS',
  WINDOWS: 'Windows',
  MACOS: 'macOS',
  LINUX: 'Linux',
};

export interface NexaKnowledgeSourcesDeps {
  readonly products: Pick<ProductRepository, 'list'>;
  readonly locations: Pick<ServiceLocationRepository, 'list'>;
  readonly clientApps: Pick<ClientAppRepository, 'list'>;
  readonly templates: Pick<TemplateResolver, 'resolve'>;
  readonly faqs: Pick<SupportFaqRepository, 'list'>;
  readonly terms: Pick<TermsRepository, 'current'>;
  readonly settings: Pick<SettingsResolver, 'valueOf'>;
  readonly gateways: Pick<PaymentGatewayRepository, 'list'>;
}

function clip(text: string, max: number): string {
  return [...text].length <= max ? text : `${[...text].slice(0, max - 1).join('')}…`;
}

function item(
  sourceType: SupportKnowledgeBuildSourceType,
  sourceKey: string,
  category: SupportKnowledgeCategory,
  title: string,
  body: string,
): BuildItem | null {
  const t = clip(title.trim(), SUPPORT_KNOWLEDGE_LIMITS.titleChars);
  const b = clip(body.trim(), SUPPORT_KNOWLEDGE_LIMITS.bodyChars);
  if (t === '' || b === '') return null;
  return { sourceType, sourceKey, content: { title: t, body: b, category, tags: [] } };
}

/** A placeholder in a raw body means it is not text on its own: never rendered here. */
function hasPlaceholder(body: string): boolean {
  return /\{[^{}\s]{1,64}\}/u.test(body);
}

export class NexaKnowledgeSources implements KnowledgeBuildSources {
  constructor(private readonly deps: NexaKnowledgeSourcesDeps) {}

  async collect(scope: TenantContext): Promise<readonly BuildItem[]> {
    const groups = await Promise.all([
      this.products(scope),
      this.locations(scope),
      this.clientApps(scope),
      this.tutorials(scope),
      this.faqs(scope),
      this.terms(scope),
      this.supportAccounts(scope),
      this.paymentMethods(scope),
    ]);
    return groups.flatMap((group) =>
      group
        .filter((entry): entry is BuildItem => entry !== null)
        .slice(0, SUPPORT_KNOWLEDGE_BUILD_LIMITS.perSource),
    );
  }

  /** ACTIVE, offered to EVERYONE: title, description, features, locations and the spec. */
  private async products(scope: TenantContext) {
    const page = await this.deps.products.list(
      scope,
      { status: 'ACTIVE', audience: 'EVERYONE' },
      SUPPORT_KNOWLEDGE_BUILD_LIMITS.perSource,
      null,
    );
    return page.items.map((product) => {
      const spec = product.specification;
      const lines = [
        product.description ?? '',
        `${BUILD_LABELS.duration}: ${
          spec.durationDays === UNLIMITED_DURATION_DAYS
            ? BUILD_LABELS.unlimited
            : formatDurationDays(spec.durationDays)
        }`,
        `${BUILD_LABELS.traffic}: ${
          spec.trafficBytes === UNLIMITED_TRAFFIC_BYTES
            ? BUILD_LABELS.unlimited
            : formatTrafficLimit(spec.trafficBytes)
        }`,
        spec.deviceLimit === null ? '' : `${BUILD_LABELS.devices}: ${String(spec.deviceLimit)}`,
        product.display.displayFeatures.length === 0
          ? ''
          : `${BUILD_LABELS.features}:\n${product.display.displayFeatures.join('\n')}`,
        product.display.displayLocations.length === 0
          ? ''
          : `${BUILD_LABELS.locations}: ${product.display.displayLocations.join('، ')}`,
      ].filter((line) => line.trim() !== '');
      return item('PRODUCT', product.id as ProductId, 'PLANS', product.title, lines.join('\n'));
    });
  }

  /** The labels of the enabled locations, as one article. Never a key, a panel or a price. */
  private async locations(scope: TenantContext) {
    const rows = await this.deps.locations.list(scope, 500);
    const labels = [...new Set(rows.filter((row) => row.enabled).map((row) => row.label.trim()))]
      .filter((label) => label !== '')
      .sort((a, b) => a.localeCompare(b));
    if (labels.length === 0) return [];
    return [item('LOCATIONS', 'all', 'PLANS', BUILD_LABELS.locationsTitle, labels.join('\n'))];
  }

  /** ENABLED apps: name, description, the rendered guide and the two public links. */
  private async clientApps(scope: TenantContext) {
    const rows = await this.deps.clientApps.list(scope, { status: 'ENABLED' });
    return rows.map((app) => {
      const help = app.helpUrl === null ? null : normalizeClientAppUrl(app.helpUrl);
      const body = [
        neutralizeClientAppBareLinks(app.description),
        renderClientAppGuide(app.guide),
        `${BUILD_LABELS.officialUrl}: ${normalizeClientAppUrl(app.officialUrl)}`,
        help === null ? '' : `${BUILD_LABELS.helpUrl}: ${help}`,
      ].filter((line) => line.trim() !== '');
      return item(
        'CLIENT_APP',
        app.id,
        'APPS',
        BUILD_LABELS.appTitle(neutralizeClientAppBareLinks(app.name)),
        body.join('\n\n'),
      );
    });
  }

  /** The connection guides, raw: they declare no placeholder, so nothing is rendered. */
  private async tutorials(scope: TenantContext) {
    const out: (BuildItem | null)[] = [];
    for (const key of BUILD_TUTORIAL_KEYS) {
      if (templateDefinition(key).placeholders.length > 0) continue;
      const resolved = await this.deps.templates.resolve(scope, key);
      if (hasPlaceholder(resolved.body)) continue;
      const platform = key.split('.').pop()?.toUpperCase() ?? '';
      out.push(
        item(
          'TUTORIAL',
          key,
          'CONNECTION',
          BUILD_LABELS.tutorialTitle(PLATFORM_NAMES[platform] ?? platform),
          resolved.body,
        ),
      );
    }
    return out;
  }

  private async faqs(scope: TenantContext) {
    const rows = await this.deps.faqs.list(scope, { status: 'ACTIVE' });
    return rows.map((row) => item('FAQ', row.id, 'GENERAL', row.question, row.answer));
  }

  /** The current PUBLISHED terms. A draft is not the rules yet. */
  private async terms(scope: TenantContext) {
    const current = await this.deps.terms.current(scope);
    if (current === null) return [];
    return [item('TERMS', 'current', 'POLICY', current.title, current.body)];
  }

  private async supportAccounts(scope: TenantContext) {
    const handles = await this.deps.settings.valueOf<readonly string[]>(scope, 'support.accounts');
    const list = handles.map((handle) => handle.trim()).filter((handle) => handle !== '');
    if (list.length === 0) return [];
    return [
      item(
        'SUPPORT_ACCOUNTS',
        'support.accounts',
        'ACCOUNT',
        BUILD_LABELS.supportTitle,
        `${BUILD_LABELS.supportBody}\n${list.join('\n')}`,
      ),
    ];
  }

  /**
   * ACTIVE routes with an operator-named route and instructions that declare no placeholder.
   * Only those two fields: never the bounds, the thresholds, the fee, a rate or an account.
   */
  private async paymentMethods(scope: TenantContext) {
    const rows = await this.deps.gateways.list(scope);
    return rows
      .filter(
        (route) =>
          route.status === 'ACTIVE' &&
          route.displayName !== null &&
          route.instructions !== null &&
          route.instructions.trim() !== '' &&
          !hasPlaceholder(route.instructions),
      )
      .map((route) =>
        item(
          'PAYMENT_METHOD',
          route.provider,
          'PAYMENTS',
          BUILD_LABELS.paymentTitle(route.displayName ?? ''),
          route.instructions ?? '',
        ),
      );
  }
}
