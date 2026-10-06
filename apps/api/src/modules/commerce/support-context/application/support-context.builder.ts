import {
  neutralizeClientAppBareLinks,
  normalizeClientAppUrl,
  renderClientAppGuide,
  SUPPORT_CONTEXT_LIMITS,
  SUPPORT_KNOWLEDGE_LIMITS,
  supportContextPayloadSchema,
  type Clock,
  type PaymentGatewayProvider,
  type SupportContextClientApp,
  type SupportContextKnowledge,
  type SupportContextPayload,
  type SupportContextService,
  type TemplateKey,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import type { CustomerRecord, CustomerRepository } from '../../customers/application/ports.js';
import type { ServiceRecord } from '../../provisioning/application/ports.js';
import { ProvisioningService } from '../../provisioning/application/provisioning.service.js';
import { serviceDisplayStatus } from '../../provisioning/domain/service-display-status.js';
import { ROUTE_NAME_KEYS } from '../../messaging/application/customer-screens.js';
import type {
  ClientAppRecord,
  ClientAppRepository,
  CustomerServiceFact,
} from '../../../control/client-apps/application/ports.js';
import { isClientAppRelevant } from '../../../control/client-apps/domain/relevance.js';
import type { ProvisionedServiceFacts } from '../../../control/client-apps/application/customer-service-facts.js';
import type { SupportFaqRepository } from '../../../control/support/application/ports.js';
import type { SettingsResolver } from '../../../control/settings/application/settings-resolver.js';
import {
  aliasFor,
  clip,
  clipGuide,
  fitPayload,
  moneyOf,
  remainingTrafficBytes,
} from '../domain/support-context-payload.js';
import { selectRelevantKnowledge } from '../domain/knowledge-relevance.js';
import type {
  SupportContextReader,
  SupportKnowledgeReader,
  SupportOrderFact,
  SupportPaymentFact,
  SupportServiceCardFact,
} from './ports.js';

export interface SupportContextBuilderDeps {
  readonly customers: Pick<CustomerRepository, 'findById'>;
  readonly services: Pick<ProvisioningService, 'supportServicesForCustomer'>;
  readonly reader: SupportContextReader;
  readonly clientApps: Pick<ClientAppRepository, 'list'>;
  readonly serviceFacts: Pick<ProvisionedServiceFacts, 'factsOf'>;
  readonly faqs: Pick<SupportFaqRepository, 'list'>;
  /** TB8: approved, enabled support knowledge (ADR-0035 §1). */
  readonly knowledge: SupportKnowledgeReader;
  readonly settings: Pick<SettingsResolver, 'valueOf'>;
  readonly clock: Clock;
}

/**
 * What one build produces: the payload a model may read, and — kept on the SERVER — what
 * each alias in it names. A later server-side tool resolves `S2` through `references`,
 * never through anything the model wrote, so a model cannot name a row it was not shown.
 */
export interface SupportContextBuild {
  readonly payload: SupportContextPayload;
  /**
   * D2 telemetry: how many knowledge entries (approved articles and live FAQ entries, a built
   * FAQ counted once) this tenant had to choose from. `payload.knowledge.length` is how many
   * were sent.
   */
  readonly knowledgeAvailable: number;
  readonly references: {
    readonly services: ReadonlyMap<string, string>;
    readonly orders: ReadonlyMap<string, string>;
    readonly payments: ReadonlyMap<string, string>;
  };
}

/**
 * TB3 — the support context for one conversation (ADR-0034 §4, ADR-0035).
 *
 * READ-ONLY and deterministic: it writes nothing (in particular it never calls
 * `SupportScreenReader.screenFor`, whose first read SEEDS the FAQ), and its answer depends
 * only on the rows and the clock. It takes the tenant from `scope` and the customer from
 * the caller — the conversation row's resolved `customer_id`, never anything a model or a
 * message supplied.
 *
 * `customerId` null, or a customer this tenant does not have: PUBLIC support only —
 * client apps (unfiltered), knowledge (approved articles, then the FAQ) and the support accounts. No account fact, and
 * no incident (incidents reach a customer through their services).
 *
 * A BLOCKED customer still gets their context, flagged `customerBlocked`: whether to answer
 * is the AI policy's decision (TB5), not this reader's.
 *
 * Every account fact comes from a customer-scoped reader that puts the tenant and the
 * customer in its WHERE: `supportServicesForCustomer` (the `pageForCustomer` predicate,
 * which hides a service refunded away at the customer's request, with non-terminated
 * services first) and `SupportContextReader`. No operator service is used — the agent
 * acts as `SYSTEM_JOB`, which holds no operator permission, and borrowing one would be the
 * actor-type bypass this codebase refuses.
 *
 * The result is parsed by the contract's strict schema before it is returned, so a fact
 * outside the allowlist fails the build rather than reaching a model.
 */
export class SupportContextBuilder {
  constructor(private readonly deps: SupportContextBuilderDeps) {}

  async build(
    scope: TenantContext,
    customerId: string | null,
    /** D2: the customer's latest words, which the knowledge is chosen by. */
    options: { readonly query?: string | null } = {},
  ): Promise<SupportContextBuild> {
    const now = this.deps.clock.now();
    const [articles, faqRows, accounts, appRows, customer] = await Promise.all([
      // Every approved article is a candidate (bounded by the per-tenant article limit): the
      // relevant one is not necessarily among the most recently edited.
      this.deps.knowledge.activeForContext(scope, SUPPORT_KNOWLEDGE_LIMITS.articles),
      this.deps.faqs.list(scope, { status: 'ACTIVE' }),
      this.deps.settings.valueOf<readonly string[]>(scope, 'support.accounts'),
      this.deps.clientApps.list(scope, { status: 'ENABLED' }),
      customerId === null ? null : this.deps.customers.findById(scope, customerId as UserId),
    ]);
    const selected = selectKnowledge(articles, faqRows, options.query ?? '');
    const knowledge = selected.entries;
    const supportAccounts = accounts.slice(0, 10).map((handle) => clip(handle, 64));

    if (customer === null) {
      return this.finish(
        {
          generatedAt: now.toISOString(),
          customer: null,
          services: [],
          orders: [],
          payments: [],
          clientApps: clientAppsFor(appRows, [], selected.builtAppIds),
          incidents: [],
          knowledge,
          supportAccounts,
          flags: {
            hasUnderReviewPayment: false,
            hasUnreconciledService: false,
            identityLinked: false,
            customerBlocked: false,
          },
        },
        { services: [], orders: [], payments: [] },
        selected.available,
      );
    }

    const [services, orders, payments, incidents] = await Promise.all([
      this.deps.services.supportServicesForCustomer(
        scope,
        customer.id,
        SUPPORT_CONTEXT_LIMITS.services,
      ),
      this.deps.reader.recentOrders(scope, customer.id, SUPPORT_CONTEXT_LIMITS.orders),
      this.deps.reader.recentPayments(scope, customer.id, SUPPORT_CONTEXT_LIMITS.payments),
      this.deps.reader.activeIncidentNotices(scope, customer.id, SUPPORT_CONTEXT_LIMITS.incidents),
    ]);
    const [cards, appFacts] = await Promise.all([
      services.length === 0
        ? Promise.resolve([] as readonly SupportServiceCardFact[])
        : this.deps.reader.serviceCardFacts(
            scope,
            customer.id,
            services.map((service) => ({
              orderId: service.orderId,
              productId: service.productId,
            })),
          ),
      this.deps.serviceFacts.factsOf(scope, services),
    ]);

    const serviceEntries = services.map((service, index) =>
      serviceEntry(service, cards[index] ?? null, index, now),
    );
    const orderFacts = orders.slice(0, SUPPORT_CONTEXT_LIMITS.orders);
    const paymentFacts = payments.items.slice(0, SUPPORT_CONTEXT_LIMITS.payments);
    return this.finish(
      {
        generatedAt: now.toISOString(),
        customer: customerEntry(customer),
        services: serviceEntries,
        orders: orderFacts.map(orderEntry),
        payments: paymentFacts.map(paymentEntry),
        clientApps: clientAppsFor(appRows, appFacts, selected.builtAppIds),
        incidents: incidents.slice(0, SUPPORT_CONTEXT_LIMITS.incidents).map((incident) => ({
          customerMessage: clip(incident.customerMessage, 2000),
          startedAt: incident.startedAt.toISOString(),
          scheduledEndAt: incident.scheduledEndAt?.toISOString() ?? null,
        })),
        knowledge,
        supportAccounts,
        flags: {
          hasUnderReviewPayment: payments.anyUnderReview,
          hasUnreconciledService: serviceEntries.some((entry) => entry.unreconciled),
          identityLinked: true,
          customerBlocked: customer.status === 'BLOCKED',
        },
      },
      {
        services: services.map((service) => service.id),
        orders: orderFacts.map((order) => order.id),
        payments: paymentFacts.map((payment) => payment.id),
      },
      selected.available,
    );
  }

  private finish(
    payload: SupportContextPayload,
    ids: {
      readonly services: readonly string[];
      readonly orders: readonly string[];
      readonly payments: readonly string[];
    },
    knowledgeAvailable: number,
  ): SupportContextBuild {
    // Strict: a key outside the allowlist, or a value outside its bound, fails HERE.
    const parsed = supportContextPayloadSchema.parse(fitPayload(payload));
    /*
     * Only the aliases that SURVIVED the byte budget are resolvable: an alias the model was
     * never shown must not name a row a later tool could act on.
     */
    return {
      payload: parsed,
      knowledgeAvailable,
      references: {
        services: survivingReferences('S', ids.services, parsed.services),
        orders: survivingReferences('O', ids.orders, parsed.orders),
        payments: survivingReferences('P', ids.payments, parsed.payments),
      },
    };
  }
}

function survivingReferences(
  prefix: 'S' | 'O' | 'P',
  ids: readonly string[],
  shown: readonly { readonly alias: string }[],
): ReadonlyMap<string, string> {
  const aliases = new Set(shown.map((entry) => entry.alias));
  return new Map(
    ids
      .map((id, index) => [aliasFor(prefix, index), id] as const)
      .filter(([alias]) => aliases.has(alias)),
  );
}

/** The candidates `selectKnowledge` reads: approved articles as the reader returns them. */
type KnowledgeArticleFact = Awaited<ReturnType<SupportKnowledgeReader['activeForContext']>>[number];

/**
 * D2 — the knowledge a request carries: every approved article and every live FAQ entry (an FAQ
 * entry the build brought into knowledge is read as that reviewed article, once — TB9), ranked
 * by relevance to `query`, the most relevant `SUPPORT_CONTEXT_LIMITS.knowledge`. Ties keep the
 * reader's order: reviewed articles newest first, then the FAQ.
 *
 * `builtAppIds`: the client apps whose guide a SELECTED article already carries (a NEXA_BUILD
 * `CLIENT_APP` article), so the app's own entry goes without its guide and the same text is not
 * sent twice. Selection only — aliases, if any, are assigned to the result afterwards.
 */
export function selectKnowledge(
  articles: readonly KnowledgeArticleFact[],
  faqRows: readonly { readonly id: string; readonly question: string; readonly answer: string }[],
  query: string,
): {
  readonly entries: SupportContextKnowledge[];
  readonly builtAppIds: ReadonlySet<string>;
  readonly available: number;
} {
  const candidates = [
    ...articles.map((row) => ({
      title: row.title,
      body: row.body,
      tags: row.tags,
      entry: {
        source: 'KNOWLEDGE',
        question: clip(row.title, 512),
        answer: clip(row.body, 4096),
      } satisfies SupportContextKnowledge,
      appId: row.sourceType === 'CLIENT_APP' ? row.sourceKey : null,
    })),
    ...faqRows
      .filter(
        (row) =>
          !articles.some((article) => article.sourceType === 'FAQ' && article.sourceKey === row.id),
      )
      .map((row) => ({
        title: row.question,
        body: row.answer,
        tags: [] as readonly string[],
        entry: {
          source: 'FAQ',
          question: clip(row.question, 512),
          answer: clip(row.answer, 4096),
        } satisfies SupportContextKnowledge,
        appId: null,
      })),
  ];
  const chosen = selectRelevantKnowledge(candidates, query, SUPPORT_CONTEXT_LIMITS.knowledge);
  return {
    entries: chosen.map((candidate) => candidate.entry),
    builtAppIds: new Set(
      chosen.flatMap((candidate) => (candidate.appId === null ? [] : [candidate.appId])),
    ),
    available: candidates.length,
  };
}

/** The customer, minus everything the allowlist leaves out (phone, Telegram id, block reason). */
function customerEntry(customer: CustomerRecord): SupportContextPayload['customer'] {
  return {
    status: customer.status,
    username: customer.username === null ? null : clip(customer.username, 64),
    firstName: customer.firstName === null ? null : clip(customer.firstName, 256),
    languageCode: customer.languageCode === null ? null : clip(customer.languageCode, 16),
    lastSeenAt: customer.lastSeenAt.toISOString(),
  };
}

/**
 * One service as its owner's card shows it (`bot-runtime.ts` `serviceCardScreen`): the order
 * line's title, the service's own location label or else the product's, the status derived
 * by `serviceDisplayStatus`. Never the subscription URL — only whether it can be re-sent
 * (`ProvisioningService.isDeliverable`) — and never the panel, the provider ids or the note.
 */
function serviceEntry(
  service: ServiceRecord,
  card: SupportServiceCardFact | null,
  index: number,
  now: Date,
): SupportContextService {
  return {
    alias: aliasFor('S', index),
    label: clip(service.providerUsername, 128),
    productTitle: card === null || card.title === null ? null : clip(card.title, 256),
    // WP-A6: where the service has moved to, when it has; the product's label otherwise.
    locationLabel: clipOrNull(service.locationLabel ?? card?.productLocationLabel ?? null, 256),
    state: service.state,
    displayStatus: serviceDisplayStatus({
      state: service.state,
      expiresAt: service.expiresAt,
      trafficLimitBytes: service.trafficLimitBytes,
      trafficUsedBytes: service.trafficUsedBytes,
      usageSyncedAt: service.usageSyncedAt,
      now,
    }),
    isTrial: service.isTrial,
    expiresAt: service.expiresAt?.toISOString() ?? null,
    trafficLimitBytes: service.trafficLimitBytes.toString(),
    trafficUsedBytes: service.trafficUsedBytes.toString(),
    remainingTrafficBytes: remainingTrafficBytes(service),
    usageSyncedAt: service.usageSyncedAt?.toISOString() ?? null,
    deviceLimit: service.deviceLimit,
    hasSubscriptionLink: ProvisioningService.isDeliverable(service),
    unreconciled: service.state === 'UNRECONCILED',
  };
}

function clipOrNull(value: string | null, max: number): string | null {
  return value === null ? null : clip(value, max);
}

function orderEntry(order: SupportOrderFact, index: number): SupportContextPayload['orders'][0] {
  return {
    alias: aliasFor('O', index),
    state: order.state,
    purpose: order.purpose,
    title: clip(order.title, 256),
    total: moneyOf(order.totalMinor, order.currency),
    createdAt: order.createdAt.toISOString(),
    settledAt: order.settledAt?.toISOString() ?? null,
    expiresAt: order.expiresAt?.toISOString() ?? null,
  };
}

function paymentEntry(
  payment: SupportPaymentFact,
  index: number,
): SupportContextPayload['payments'][0] {
  return {
    alias: aliasFor('P', index),
    amount: moneyOf(payment.amountMinor, payment.currency),
    method: payment.method,
    routeLabelKey: routeLabelKeyOf(payment),
    state: payment.state,
    underReview: payment.underReview,
    createdAt: payment.createdAt.toISOString(),
    confirmedAt: payment.confirmedAt?.toISOString() ?? null,
  };
}

/** The route's name as the customer's checkout named it (`ROUTE_NAME_KEYS`); none for a wallet. */
function routeLabelKeyOf(payment: SupportPaymentFact): TemplateKey | null {
  const route: PaymentGatewayProvider | null =
    payment.gatewayProvider ?? (payment.method === 'MANUAL_TRANSFER' ? 'MANUAL_TRANSFER' : null);
  return route === null ? null : ROUTE_NAME_KEYS[route];
}

/**
 * The enabled apps `isClientAppRelevant` admits for these service facts — the customer
 * screen's own rule (WP-A10), so an unlinked peer (no facts) sees every enabled app — in
 * the operator's order, rendered the way the customer's detail screen renders them.
 */
function clientAppsFor(
  rows: readonly ClientAppRecord[],
  facts: readonly CustomerServiceFact[],
  /** D2: apps whose guide a selected knowledge article already carries: sent without it. */
  builtAppIds: ReadonlySet<string> = new Set(),
): SupportContextClientApp[] {
  return rows
    .filter((row) => row.status === 'ENABLED' && isClientAppRelevant(row, facts))
    .slice(0, SUPPORT_CONTEXT_LIMITS.clientApps)
    .map((row) => ({
      platform: row.platform,
      name: clip(neutralizeClientAppBareLinks(row.name), 128),
      description: clip(neutralizeClientAppBareLinks(row.description), 512),
      guide: builtAppIds.has(row.id) ? '' : clipGuide(renderClientAppGuide(row.guide)),
      helpUrl: row.helpUrl === null ? null : normalizeClientAppUrl(row.helpUrl),
      officialUrl: normalizeClientAppUrl(row.officialUrl),
    }));
}
