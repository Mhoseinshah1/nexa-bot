import {
  CLIENT_APP_PROTOCOLS,
  isProviderType,
  parsePanelActivation,
  type ClientAppDeliveryKind,
  type ClientAppProtocol,
  type ServiceState,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import type { ServiceRecord } from '../../../commerce/provisioning/application/ports.js';
import { ProvisioningService } from '../../../commerce/provisioning/application/provisioning.service.js';
import type { SubscriptionFileService } from '../../../commerce/provisioning/application/subscription-file.service.js';
import type { PanelRepository } from '../../../platform/panels/application/ports.js';
import type { CustomerServiceFact, CustomerServiceFactsSource } from './ports.js';

/**
 * The services a customer may still connect with: the states in which the delivery card's
 * link is live. A service still being provisioned has nothing to connect with yet, and a
 * terminated one never will again.
 */
const LIVE_STATES: readonly ServiceState[] = ['ACTIVE', 'SUSPENDED', 'EXPIRED'];

/**
 * How many of a customer's LIVE services are read. Newest first; a customer past this
 * many is filtered by their newest twenty live ones, and the only cost of the bound is an
 * app that fitted only an older one being hidden — never an app shown that fits none.
 */
export const SERVICE_FACTS_LIMIT = 20;

/**
 * The customer's services are read a page at a time, in the list's own order, and the
 * live ones kept until `SERVICE_FACTS_LIMIT` are found or the list ends.
 *
 * Paged rather than one page of twenty filtered afterwards (Codex review #1 of PR #95,
 * C1): twenty newer TERMINATED services would have pushed an ACTIVE one out of the page,
 * and the customer would have been filtered as if they had none — a different app list,
 * and no «🔗 لینک اشتراک» on the one service they can use. The repository filters by ONE
 * state, not a set, so the three live states cannot be asked for directly.
 *
 * `SERVICE_FACTS_MAX_PAGES` is the hard bound on one tap's reads: at most 5 × 50 = 250
 * services are looked at. A customer whose live services sit behind more than 250 dead
 * ones is filtered by the live ones found so far, with the same cost as the limit above.
 */
export const SERVICE_FACTS_PAGE_SIZE = 50;
export const SERVICE_FACTS_MAX_PAGES = 5;

export interface ProvisionedServiceFactsDeps {
  readonly services: Pick<ProvisioningService, 'listForCustomer'>;
  readonly panels: Pick<PanelRepository, 'findMany'>;
  /** Package E's own check, the one that draws the files button. Absent: no service offers files. */
  readonly subscriptionFiles?: Pick<SubscriptionFileService, 'offered'>;
}

/**
 * What this installation already knows about a customer's live services, for choosing
 * which apps to show (WP-A10).
 *
 * Nothing here is decided twice. Whether the link can be re-sent is
 * `ProvisioningService.isDeliverable`; whether files can be fetched is
 * `SubscriptionFileService.offered` — the same two answers that draw «🔗 لینک اشتراک» and
 * «📁 دریافت فایل‌های اتصال» on the service card, so this screen cannot offer an action the
 * card would not.
 *
 * Protocols are read from the panel's ACTIVATION, parsed by its provider's own schema:
 * where the schema carries `proxyProtocols`, those are the protocols its accounts are
 * created with; where it does not, the protocol is unknown and filters nothing. No
 * provider is named — a provider whose activation grows the field is read the same way.
 *
 * The subscription URL is read for `!== null` and nothing else: it is never copied,
 * returned or logged from here.
 */
export class ProvisionedServiceFacts implements CustomerServiceFactsSource {
  constructor(private readonly deps: ProvisionedServiceFactsDeps) {}

  async factsFor(
    scope: TenantContext,
    customerId: UserId,
  ): Promise<readonly CustomerServiceFact[]> {
    const live: ServiceRecord[] = [];
    let cursor: Parameters<ProvisioningService['listForCustomer']>[3] = null;
    for (let pages = 0; pages < SERVICE_FACTS_MAX_PAGES; pages += 1) {
      const page = await this.deps.services.listForCustomer(
        scope,
        customerId,
        SERVICE_FACTS_PAGE_SIZE,
        cursor,
      );
      for (const service of page.items) {
        if (live.length < SERVICE_FACTS_LIMIT && LIVE_STATES.includes(service.state)) {
          live.push(service);
        }
      }
      if (live.length >= SERVICE_FACTS_LIMIT || page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    if (live.length === 0) return [];

    const panelIds = [...new Set(live.map((service) => service.panelId as string))];
    const views = await this.deps.panels.findMany(scope, panelIds);
    const panels = new Map(views.map((view) => [view.panel.id, view.panel]));
    /*
     * One `offered` per (panel, state), not per service (C4). Its answer is a function of
     * the service's state and its panel alone — the state against Package E's readable
     * states, then the panel's provider and adapter — so services sharing both share the
     * answer, and caching the PROMISE keeps concurrent callers to one panel read without
     * copying Package E's rule here.
     */
    const offers = new Map<string, Promise<boolean>>();
    const filesOffered = (service: ServiceRecord): Promise<boolean> => {
      const key = `${String(service.panelId)}|${service.state}`;
      let offer = offers.get(key);
      if (offer === undefined) {
        offer = this.filesOffered(scope, service);
        offers.set(key, offer);
      }
      return offer;
    };

    return Promise.all(
      live.map(async (service) => {
        const panel = panels.get(service.panelId) ?? null;
        const providerType =
          panel !== null && isProviderType(panel.providerType) ? panel.providerType : null;
        const files = await filesOffered(service);
        const deliveryKinds: ClientAppDeliveryKind[] = [];
        if (service.subscriptionUrl !== null) deliveryKinds.push('SUBSCRIPTION_LINK');
        if (files) deliveryKinds.push('CONNECTION_FILES');
        return {
          serviceId: service.id,
          providerType,
          deliveryKinds,
          protocols:
            panel === null || providerType === null
              ? null
              : protocolsOf(providerType, panel.activation),
          linkDeliverable: ProvisioningService.isDeliverable(service),
          filesOffered: files,
        } satisfies CustomerServiceFact;
      }),
    );
  }

  private async filesOffered(scope: TenantContext, service: ServiceRecord): Promise<boolean> {
    if (this.deps.subscriptionFiles === undefined) return false;
    return this.deps.subscriptionFiles.offered(scope, service);
  }
}

/** The protocols a panel's activation names, or null when it names none this product knows. */
export function protocolsOf(
  providerType: Parameters<typeof parsePanelActivation>[0],
  activation: unknown,
): readonly ClientAppProtocol[] | null {
  const parsed = parsePanelActivation(providerType, activation);
  if (!parsed.success) return null;
  const declared = (parsed.data as { readonly proxyProtocols?: unknown }).proxyProtocols;
  if (!Array.isArray(declared)) return null;
  const known = declared.filter((value): value is ClientAppProtocol =>
    (CLIENT_APP_PROTOCOLS as readonly unknown[]).includes(value),
  );
  return known.length === 0 ? null : known;
}
