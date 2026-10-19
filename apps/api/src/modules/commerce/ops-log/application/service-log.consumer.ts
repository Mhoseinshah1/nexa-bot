import { type DomainEvent, type EventType, type TenantContext } from '@nexa/contracts';
import type { EventConsumer } from '../../../platform/eventing/application/event-consumer.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import { publish, scopeOf } from './publish.js';
import { linkChanged, serviceCreated, trialCreated, type Built } from './presenters.js';
import type { OpsLogFacts, OpsLogLane, OpsLogWords } from './ports.js';

/**
 * The services' log (Round 4 PR-D): a service created after a purchase (L10, L11), a trial
 * (L16) and a link change (L15).
 *
 * `ServiceProvisioned` is the one fact that says a panel really holds the account, so the
 * message is posted then — not when the order was paid — and a purchase that could not be
 * delivered is the error report's (L23), never a "new purchase" line. A service the import
 * adopted (`ServiceAdopted`) is not subscribed to, and an order that is not a STANDARD one
 * is refused again here: an import produces no group message.
 */
export class ServiceLogConsumer implements EventConsumer {
  readonly name = 'ops-log.services';
  readonly subscribesTo: readonly EventType[] = [
    'ServiceProvisioned',
    'ServiceSubscriptionRotated',
  ];

  constructor(
    private readonly deps: {
      readonly lane: OpsLogLane;
      readonly facts: OpsLogFacts;
      readonly words: OpsLogWords;
    },
  ) {}

  async handle(event: DomainEvent, tx: TransactionScope): Promise<void> {
    const scope = scopeOf(event);
    if (scope === null) return;
    const service = await this.deps.facts.service(scope, event.aggregateId, tx);
    if (service === null || service.source !== 'NEXA') return;
    const customer = await this.deps.facts.customer(scope, service.customerId, tx);
    if (customer === null || customer.source !== 'NEXA') return;
    const at = new Date(event.occurredAt);

    let built: Built | null;
    if (event.eventType === 'ServiceProvisioned') {
      built = await this.provisioned(scope, service.orderId, service, customer, at, tx);
    } else {
      const last = await this.deps.facts.latestLinkOperation(scope, service.id, tx);
      built = linkChanged({
        service,
        customer,
        by: last === null ? 'SYSTEM' : last.requestedByCustomerId === null ? 'ADMIN' : 'CUSTOMER',
        rotations: await this.deps.facts.rotationsInLast30Days(scope, service.id, at, tx),
        at,
        words: this.deps.words,
      });
    }
    if (built === null) return;
    await publish(this.deps.lane, scope, tx, built, {
      dedupeKey: `oplog:service:${event.eventId}`,
      correlationId: event.correlationId,
    });
  }

  private async provisioned(
    scope: TenantContext,
    orderId: string,
    service: NonNullable<Awaited<ReturnType<OpsLogFacts['service']>>>,
    customer: NonNullable<Awaited<ReturnType<OpsLogFacts['customer']>>>,
    at: Date,
    tx: TransactionScope,
  ): Promise<Built | null> {
    const order = await this.deps.facts.order(scope, orderId, tx);
    if (order === null || order.origin !== 'STANDARD' || order.source !== 'NEXA') return null;
    if (order.purpose === 'TRIAL') {
      return trialCreated({ service, order, customer, at, words: this.deps.words });
    }
    const payment = await this.deps.facts.paymentOfOrder(scope, order.id, tx);
    // A wallet purchase: the wallet on either side of THIS order's purchase debit.
    let walletBalance = null;
    if (payment?.method === 'WALLET') {
      const entries = await this.deps.facts.entriesOfOrder(scope, order.id, 'PURCHASE', tx);
      walletBalance = await this.deps.facts.balanceAround(
        scope,
        order.customerId,
        order.total.currency,
        entries.map((entry) => entry.id),
        tx,
      );
    }
    return serviceCreated({
      order,
      service,
      customer,
      payment,
      walletBalance,
      at,
      words: this.deps.words,
    });
  }
}
