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
 * How many of a customer's services are read. Newest first; a customer past this many is
 * filtered by their newest twenty, and the only cost of the bound is an app that fitted
 * only an older service being hidden — never an app shown that fits none.
 */
export const SERVICE_FACTS_LIMIT = 20;

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
    const page = await this.deps.services.listForCustomer(scope, customerId, SERVICE_FACTS_LIMIT);
    const live = page.items.filter((service) => LIVE_STATES.includes(service.state));
    if (live.length === 0) return [];

    const panelIds = [...new Set(live.map((service) => service.panelId as string))];
    const views = await this.deps.panels.findMany(scope, panelIds);
    const panels = new Map(views.map((view) => [view.panel.id, view.panel]));

    return Promise.all(
      live.map(async (service) => {
        const panel = panels.get(service.panelId) ?? null;
        const providerType =
          panel !== null && isProviderType(panel.providerType) ? panel.providerType : null;
        const filesOffered = await this.filesOffered(scope, service);
        const deliveryKinds: ClientAppDeliveryKind[] = [];
        if (service.subscriptionUrl !== null) deliveryKinds.push('SUBSCRIPTION_LINK');
        if (filesOffered) deliveryKinds.push('CONNECTION_FILES');
        return {
          serviceId: service.id,
          providerType,
          deliveryKinds,
          protocols:
            panel === null || providerType === null
              ? null
              : protocolsOf(providerType, panel.activation),
          linkDeliverable: ProvisioningService.isDeliverable(service),
          filesOffered,
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
