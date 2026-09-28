import {
  CLIENT_APP_PLATFORMS,
  normalizeClientAppUrl,
  renderClientAppGuide,
  uuidV7Schema,
  type ClientAppPlatform,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import { isClientAppRelevant } from '../domain/relevance.js';
import type {
  ClientAppRecord,
  ClientAppRepository,
  CustomerServiceFact,
  CustomerServiceFactsSource,
} from './ports.js';

/** One app on a platform's list: its id for the callback, and the label the button shows. */
export interface ClientAppListing {
  readonly id: string;
  readonly label: string;
}

/**
 * One app's screen, as the customer's bot draws it. Every string is the operator's own data
 * or already rendered from it; the surrounding words are the surface's templates.
 */
export interface ClientAppDetail {
  readonly id: string;
  readonly platform: ClientAppPlatform;
  /** The icon, when set, and the name. */
  readonly title: string;
  readonly description: string;
  /** `renderClientAppGuide` of the stored guide: plain text, safe for any parse mode. */
  readonly guide: string;
  /**
   * Each link re-checked by `normalizeClientAppUrl` as it is read, and null when it fails:
   * the service stores only links that pass, and a row written around it must cost the
   * customer one button, not the whole reply Telegram would refuse.
   */
  readonly officialUrl: string | null;
  readonly alternativeUrl: string | null;
  readonly helpUrl: string | null;
  /** The app reads connection files AND one of the customer's services can hand them over. */
  readonly filesNote: boolean;
  /**
   * The existing per-service actions, for a customer with exactly ONE live service.
   * With several the surface points at «سرویس‌های من» instead, where each service has them.
   */
  readonly service: {
    readonly id: string;
    readonly link: boolean;
    readonly files: boolean;
  } | null;
  readonly manyServices: boolean;
}

export interface ClientAppCatalogDeps {
  readonly repository: Pick<ClientAppRepository, 'list' | 'find'>;
  readonly facts: CustomerServiceFactsSource;
}

/**
 * The customer's read of the tenant's client apps (WP-A10).
 *
 * No permission check, deliberately — `SupportScreenReader`'s rule: the caller is a
 * customer's own tap, a customer holds no permissions in this product, and what bounds
 * this instead is that it writes nothing and reads only the tenant the scope names and
 * the services of the customer the update came from.
 *
 * Only ENABLED rows are ever returned, and a platform's list keeps only the apps
 * `isClientAppRelevant` admits for this customer's live services.
 */
export class ClientAppCatalog {
  constructor(private readonly deps: ClientAppCatalogDeps) {}

  /**
   * The platforms to offer: the five with a guide of their own always — a platform with no
   * configured app still has `bot.tutorial.<platform>`, which is what this screen showed
   * before WP-A10 — and `OTHER` only while it holds an app this customer may see.
   */
  async platformsFor(
    scope: TenantContext,
    customerId: UserId,
  ): Promise<readonly ClientAppPlatform[]> {
    const others = await this.appsFor(scope, customerId, 'OTHER');
    return CLIENT_APP_PLATFORMS.filter((platform) => platform !== 'OTHER' || others.length > 0);
  }

  /** One platform's enabled, relevant apps, in the operator's order. */
  async appsFor(
    scope: TenantContext,
    customerId: UserId,
    platform: ClientAppPlatform,
  ): Promise<readonly ClientAppListing[]> {
    const rows = await this.deps.repository.list(scope, { platform, status: 'ENABLED' });
    if (rows.length === 0) return [];
    const facts = await this.deps.facts.factsFor(scope, customerId);
    return rows
      .filter((row) => isClientAppRelevant(row, facts))
      .map((row) => ({ id: row.id, label: titleOf(row) }));
  }

  /**
   * One app, or null when it is not an ENABLED entry of this tenant.
   *
   * Not re-filtered by relevance: the customer tapped it, from a list that offered it, and
   * hiding it now because a service changed state since would answer a real button with
   * "not found". A disabled or removed entry IS gone, because the operator said so.
   */
  async appFor(
    scope: TenantContext,
    customerId: UserId,
    appId: string,
  ): Promise<ClientAppDetail | null> {
    // Validated before it reaches a `uuid` column, so a crafted id is "not found", not a 500.
    if (!uuidV7Schema.safeParse(appId).success) return null;
    const row = await this.deps.repository.find(scope, appId);
    if (row === null || row.status !== 'ENABLED') return null;

    const facts = await this.deps.facts.factsFor(scope, customerId);
    const readsFiles = row.deliveryKinds.includes('CONNECTION_FILES');
    const readsLinks =
      row.deliveryKinds.length === 0 || row.deliveryKinds.includes('SUBSCRIPTION_LINK');
    const only = facts.length === 1 ? (facts[0] as CustomerServiceFact) : null;

    return {
      id: row.id,
      platform: row.platform,
      title: titleOf(row),
      description: row.description,
      guide: renderClientAppGuide(row.guide),
      officialUrl: safeLink(row.officialUrl),
      alternativeUrl: safeLink(row.alternativeUrl),
      helpUrl: safeLink(row.helpUrl),
      filesNote: readsFiles && facts.some((fact) => fact.filesOffered),
      service:
        only === null
          ? null
          : {
              id: only.serviceId,
              link: readsLinks && only.linkDeliverable,
              files: readsFiles && only.filesOffered,
            },
      manyServices: facts.length > 1,
    };
  }
}

function safeLink(url: string | null): string | null {
  return url === null ? null : normalizeClientAppUrl(url);
}

function titleOf(row: ClientAppRecord): string {
  return row.icon === null ? row.name : `${row.icon} ${row.name}`;
}
