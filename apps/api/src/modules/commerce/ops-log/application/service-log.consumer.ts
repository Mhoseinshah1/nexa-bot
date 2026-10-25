import {
  EVENT_PAYLOAD_SCHEMAS,
  type DomainEvent,
  type EventType,
  type TenantContext,
} from '@nexa/contracts';
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
 *
 * Hotfix v0.8.2-e: the customer's and the service's own provenance is NOT a reason for
 * silence. Both events are written only by this installation's provisioner, after a create
 * or a rotation it performed — never by the import — and the purchase's provenance is its
 * ORDER (STANDARD and NEXA, checked in `provisioned`). Refusing a `MIRZA` customer silenced
 * every purchase, trial and link change of every customer an installation migrated from the
 * previous bot (the one-click `.nxpkg` import marks them all), while the payment log, which
 * reads the payment's own provenance, still arrived. R8 A4 made the same correction for an
 * administrator's wallet adjustment (`LedgerLogConsumer`).
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
    if (service === null) return;
    const customer = await this.deps.facts.customer(scope, service.customerId, tx);
    if (customer === null) return;
    const at = new Date(event.occurredAt);

    let built: Built | null;
    if (event.eventType === 'ServiceProvisioned') {
      built = await this.provisioned(scope, service.orderId, service, customer, at, tx);
    } else {
      const last = await this.linkOperation(scope, event, service.id, at, tx);
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

  /**
   * Who changed THIS link (Codex review of #301): the operation the event names, read by id.
   * An event from before it named one falls back to the last link operation completed by the
   * event's own time — never the latest by the time the consumer runs, which would credit a
   * later rotation's requester with this one.
   */
  private async linkOperation(
    scope: TenantContext,
    event: DomainEvent,
    serviceId: string,
    at: Date,
    tx: TransactionScope,
  ): Promise<{ readonly type: string; readonly requestedByCustomerId: string | null } | null> {
    const payload = EVENT_PAYLOAD_SCHEMAS.ServiceSubscriptionRotated.parse(event.payload);
    if (payload.operationId !== undefined) {
      const named = await this.deps.facts.operation(scope, payload.operationId, tx);
      if (named !== null && named.serviceId === serviceId) return named;
    }
    return this.deps.facts.latestLinkOperation(scope, serviceId, at, tx);
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
      // R9 C2: the source line reads where the order was created from.
      origin: await this.deps.facts.orderOrigin(scope, order.id, tx),
      at,
      words: this.deps.words,
    });
  }
}
