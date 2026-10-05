import {
  CONNECTION_GUIDE_PLATFORMS,
  SUPPORT_KNOWLEDGE_BUILD_LIMITS,
  SUPPORT_KNOWLEDGE_LIMITS,
  UNLIMITED_DURATION_DAYS,
  UNLIMITED_TRAFFIC_BYTES,
  neutralizeClientAppBareLinks,
  renderClientAppGuide,
  templateDefinition,
  type ProductId,
  type SupportKnowledgeBuildSourceType,
  type SupportKnowledgeCategory,
  type TemplateKey,
  type TenantContext,
} from '@nexa/contracts';
import { formatDurationDays, formatTrafficLimit } from '@nexa/i18n';
import type { ProductService } from '../../../commerce/catalog/application/product.service.js';
import type { ServiceLocationRepository } from '../../../commerce/locations/application/ports.js';
import type { PaymentGatewayRepository } from '../../../commerce/payments/application/gateway-ports.js';
import type { ClientAppRepository } from '../../client-apps/application/ports.js';
import type { SettingsResolver } from '../../settings/application/settings-resolver.js';
import type { SupportFaqRepository } from '../../support/application/ports.js';
import type { TemplateResolver } from '../../templates/application/template-resolver.js';
import type { TermsRepository } from '../../terms/application/ports.js';
import type {
  KnowledgeBuildCollection,
  KnowledgeBuildSources,
} from '../application/support-knowledge-build.service.js';
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
  /**
   * Built knowledge carries no link (TB9 × TB8 review: every article passes `assertClean`, and
   * a URL is a HOST or URL_TOKEN hit). An app's links are in the bot's app list; the article
   * says so instead of repeating them.
   */
  appLinks: 'پیوند دانلود و راهنمای این برنامه در فهرست برنامه‌های ربات آمده است.',
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
  /**
   * The PUBLIC customer catalogue (B1, substitute review of PR #204): the customer browse's own
   * predicate — product ACTIVE and for EVERYONE, priced, on a panel the sales gate says may take
   * a new account, in an ACTIVE and VISIBLE category — never the operator's product list.
   */
  readonly catalogue: Pick<ProductService, 'publicCatalogue'>;
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

/** One source item, and whether its text was clipped to the article bounds (N2). */
interface Drafted {
  readonly item: BuildItem;
  readonly truncated: boolean;
}

/** One source's read: its items, and whether a bound stopped the read before the end. */
interface SourceRead {
  readonly type: SupportKnowledgeBuildSourceType;
  readonly drafts: readonly (Drafted | null)[];
  readonly more: boolean;
}

function item(
  sourceType: SupportKnowledgeBuildSourceType,
  sourceKey: string,
  category: SupportKnowledgeCategory,
  title: string,
  body: string,
): Drafted | null {
  const rawTitle = title.trim();
  const rawBody = body.trim();
  const t = clip(rawTitle, SUPPORT_KNOWLEDGE_LIMITS.titleChars);
  const b = clip(rawBody, SUPPORT_KNOWLEDGE_LIMITS.bodyChars);
  if (t === '' || b === '') return null;
  return {
    item: { sourceType, sourceKey, content: { title: t, body: b, category, tags: [] } },
    truncated: t !== rawTitle || b !== rawBody,
  };
}

function read(
  type: SupportKnowledgeBuildSourceType,
  drafts: readonly (Drafted | null)[],
  more = false,
): SourceRead {
  return { type, drafts, more };
}

/** A placeholder in a raw body means it is not text on its own: never rendered here. */
function hasPlaceholder(body: string): boolean {
  return /\{[^{}\s]{1,64}\}/u.test(body);
}

export class NexaKnowledgeSources implements KnowledgeBuildSources {
  constructor(private readonly deps: NexaKnowledgeSourcesDeps) {}

  /**
   * Every source, each bounded at `perSource`. What a bound drops is COUNTED (`capped`, at
   * least) and its source type is reported `incomplete`: a key missing from a read that was
   * cut proves nothing, so the build proposes no RETIRE for that type.
   */
  async collect(scope: TenantContext): Promise<KnowledgeBuildCollection> {
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
    const items: BuildItem[] = [];
    const incomplete = new Set<SupportKnowledgeBuildSourceType>();
    let truncated = 0;
    let capped = 0;
    for (const group of groups) {
      const drafts = group.drafts.filter((entry): entry is Drafted => entry !== null);
      const kept = drafts.slice(0, SUPPORT_KNOWLEDGE_BUILD_LIMITS.perSource);
      const dropped = drafts.length - kept.length + (group.more ? 1 : 0);
      if (dropped > 0) {
        capped += dropped;
        incomplete.add(group.type);
      }
      for (const draft of kept) {
        items.push(draft.item);
        if (draft.truncated) truncated += 1;
      }
    }
    return { items, truncated, capped, incomplete: [...incomplete] };
  }

  /**
   * What the customer catalogue lists, and nothing else: title, description, features,
   * locations and the spec. Never the price, never the panel.
   */
  private async products(scope: TenantContext): Promise<SourceRead> {
    const page = await this.deps.catalogue.publicCatalogue(
      scope,
      SUPPORT_KNOWLEDGE_BUILD_LIMITS.perSource,
    );
    const drafts = page.items.map((product) => {
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
    return read('PRODUCT', drafts, page.hasMore);
  }

  /** The labels of the enabled locations, as one article. Never a key, a panel or a price. */
  private async locations(scope: TenantContext) {
    const rows = await this.deps.locations.list(scope, 500);
    const labels = [...new Set(rows.filter((row) => row.enabled).map((row) => row.label.trim()))]
      .filter((label) => label !== '')
      .sort((a, b) => a.localeCompare(b));
    if (labels.length === 0) return read('LOCATIONS', []);
    return read('LOCATIONS', [
      item('LOCATIONS', 'all', 'PLANS', BUILD_LABELS.locationsTitle, labels.join('\n')),
    ]);
  }

  /**
   * ENABLED apps: name, description and the rendered guide. The official and help links are
   * NOT copied into the article (knowledge carries no URL); a fixed line points to the app list.
   */
  private async clientApps(scope: TenantContext) {
    const rows = await this.deps.clientApps.list(scope, { status: 'ENABLED' });
    const drafts = rows.map((app) => {
      const body = [
        neutralizeClientAppBareLinks(app.description),
        renderClientAppGuide(app.guide),
        BUILD_LABELS.appLinks,
      ].filter((line) => line.trim() !== '');
      return item(
        'CLIENT_APP',
        app.id,
        'APPS',
        BUILD_LABELS.appTitle(neutralizeClientAppBareLinks(app.name)),
        body.join('\n\n'),
      );
    });
    return read('CLIENT_APP', drafts);
  }

  /** The connection guides, raw: they declare no placeholder, so nothing is rendered. */
  private async tutorials(scope: TenantContext) {
    const out: (Drafted | null)[] = [];
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
    return read('TUTORIAL', out);
  }

  private async faqs(scope: TenantContext) {
    const rows = await this.deps.faqs.list(scope, { status: 'ACTIVE' });
    return read(
      'FAQ',
      rows.map((row) => item('FAQ', row.id, 'GENERAL', row.question, row.answer)),
    );
  }

  /** The current PUBLISHED terms. A draft is not the rules yet. */
  private async terms(scope: TenantContext) {
    const current = await this.deps.terms.current(scope);
    if (current === null) return read('TERMS', []);
    return read('TERMS', [item('TERMS', 'current', 'POLICY', current.title, current.body)]);
  }

  private async supportAccounts(scope: TenantContext) {
    const handles = await this.deps.settings.valueOf<readonly string[]>(scope, 'support.accounts');
    const list = handles.map((handle) => handle.trim()).filter((handle) => handle !== '');
    if (list.length === 0) return read('SUPPORT_ACCOUNTS', []);
    return read('SUPPORT_ACCOUNTS', [
      item(
        'SUPPORT_ACCOUNTS',
        'support.accounts',
        'ACCOUNT',
        BUILD_LABELS.supportTitle,
        `${BUILD_LABELS.supportBody}\n${list.join('\n')}`,
      ),
    ]);
  }

  /**
   * ACTIVE routes with an operator-named route and instructions that declare no placeholder.
   * Only those two fields: never the bounds, the thresholds, the fee, a rate or an account.
   */
  private async paymentMethods(scope: TenantContext) {
    const rows = await this.deps.gateways.list(scope);
    const drafts = rows
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
    return read('PAYMENT_METHOD', drafts);
  }
}
