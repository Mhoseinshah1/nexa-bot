import {
  AUTOMATIC_REFUND_REASON,
  EVENT_PAYLOAD_SCHEMAS,
  money,
  type DomainEvent,
  type Money,
  type EventType,
  type TenantContext,
} from '@nexa/contracts';
import type { EventConsumer } from '../../../platform/eventing/application/event-consumer.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import { publish, scopeOf } from './publish.js';
import { operationFailure, provisionFailure, type Built } from './presenters.js';
import type { AdminFact, OpsLogFacts, OpsLogLane, OpsLogWords } from './ports.js';

/**
 * The error reports for a paid order that could not be delivered (Round 4 PR-D): a service
 * that was not created (L23), and a renewal, extra traffic, extra time or a trial that was not
 * completed (L24). ERRORS topic, one message per failure, each carrying the customer, the
 * Persian cause, one short technical line and what happened to the customer.
 *
 * Two facts feed it, and they are the only two ways an order ends undelivered:
 *
 *  - `OrderRefunded` with the AUTOMATIC reason — the order was given back, in the transaction
 *    that discovered it could not be delivered. The money is certain, so the message says so.
 *  - `ProvisioningOutcomeUnknown` — a write whose answer was lost. NOTHING is refunded, and the
 *    message says that too, and that the panel is being asked: the owner's rule is that an
 *    unknown outcome is never given back and never called a failure.
 *
 * The two are never confused, and neither is reported twice: an unknown outcome that later
 * resolves to a refund is a different event and a different message.
 */
export class FailureLogConsumer implements EventConsumer {
  readonly name = 'ops-log.failures';
  readonly subscribesTo: readonly EventType[] = ['OrderRefunded', 'ProvisioningOutcomeUnknown'];

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
    const at = new Date(event.occurredAt);

    if (event.eventType === 'OrderRefunded') {
      const payload = EVENT_PAYLOAD_SCHEMAS.OrderRefunded.parse(event.payload);
      // An operator's refund of a delivered order is a financial fact, not an error.
      if (payload.reason !== AUTOMATIC_REFUND_REASON) return;
      await this.report(scope, event, event.aggregateId, null, false, at, tx);
      return;
    }
    const payload = EVENT_PAYLOAD_SCHEMAS.ProvisioningOutcomeUnknown.parse(event.payload);
    const service = await this.deps.facts.service(scope, payload.serviceId, tx);
    if (service === null || service.source !== 'NEXA') return;
    await this.report(scope, event, service.orderId, payload, true, at, tx);
  }

  private async report(
    scope: TenantContext,
    event: DomainEvent,
    orderId: string,
    unknownOutcome: { readonly operationType: string; readonly failureKind: string } | null,
    unknown: boolean,
    at: Date,
    tx: TransactionScope,
  ): Promise<void> {
    const order = await this.deps.facts.order(scope, orderId, tx);
    if (order === null || order.origin !== 'STANDARD' || order.source !== 'NEXA') return;
    const customer = await this.deps.facts.customer(scope, order.customerId, tx);
    if (customer === null || customer.source !== 'NEXA') return;
    const payment = await this.deps.facts.paymentOfOrder(scope, order.id, tx);
    const recorded = await this.deps.facts.failedOperationOfOrder(scope, order.id, tx);
    // The operation row when there is one; for an unknown outcome the event names the kind
    // even when the row has since moved on.
    const operation =
      recorded === null && unknownOutcome === null
        ? null
        : {
            id: recorded?.id ?? '',
            type: unknownOutcome?.operationType ?? recorded?.type ?? 'OTHER',
            state: recorded?.state ?? 'UNKNOWN',
            serviceId: recorded?.serviceId ?? '',
            orderId: order.id,
            requestedByCustomerId: recorded?.requestedByCustomerId ?? null,
            panelId: recorded?.panelId ?? order.panelId,
            failureKind: unknownOutcome?.failureKind ?? recorded?.failureKind ?? null,
            failureMessage: recorded?.failureMessage ?? null,
            targetExpiresAt: recorded?.targetExpiresAt ?? null,
            targetTrafficLimitBytes: recorded?.targetTrafficLimitBytes ?? null,
            completedAt: recorded?.completedAt ?? null,
          };
    const reason = unknown ? null : await this.deps.facts.undeliverableReason(scope, order.id, tx);
    const service =
      operation !== null && operation.serviceId !== ''
        ? await this.deps.facts.service(scope, operation.serviceId, tx)
        : null;
    // What was REALLY given back: the order's REFUND credits on the ledger, never its total
    // (money review of #301). None — an unknown outcome, a free order, a refund not yet
    // written — and the message says nothing was refunded rather than name a figure.
    const refunded = unknown ? null : await this.refundedOf(scope, order, tx);

    const createsService = order.purpose === 'NEW_SERVICE' || order.purpose === 'CUSTOM_SERVICE';
    // R9 C2: a service an administrator created from the Web Admin has a report of its own,
    // naming the administrator. The order's creating audit row says who acted.
    const createdBy = createsService ? await this.administratorOf(scope, order.id, tx) : undefined;
    const built: Built = createsService
      ? provisionFailure({
          order,
          customer,
          operation,
          reason,
          payment,
          refunded,
          unknown,
          ...(createdBy === undefined ? {} : { createdBy }),
          at,
          words: this.deps.words,
        })
      : operationFailure({
          order,
          service,
          customer,
          operation,
          reason,
          payment,
          refunded,
          unknown,
          at,
          words: this.deps.words,
        });
    const cause = String(built.values['cause'] ?? '');
    const technical = String(built.values['technical'] ?? '');
    await publish(this.deps.lane, scope, tx, built, {
      dedupeKey: `oplog:failure:${event.eventId}`,
      correlationId: event.correlationId,
      storm: {
        key: `${built.logType}:${technical}:${order.panelId}`,
        customer: customer.telegramUserId,
        rollup: {
          heading: this.deps.words.stormHeading,
          cause,
          technical,
          ...(order.panelName === '' ? {} : { panelName: order.panelName }),
        },
      },
    });
  }

  /**
   * The administrator who created the order from the Web Admin, or undefined for a customer's
   * own purchase (or an order whose creating audit row is not there).
   */
  private async administratorOf(
    scope: TenantContext,
    orderId: string,
    tx: TransactionScope,
  ): Promise<{ readonly admin: AdminFact | null; readonly label: string | null } | undefined> {
    const origin = await this.deps.facts.orderOrigin(scope, orderId, tx);
    if (origin === null || origin.actorType !== 'WEB_ADMIN') return undefined;
    const admin =
      origin.actorId === null ? null : await this.deps.facts.admin(scope, origin.actorId, tx);
    return { admin, label: origin.actorLabel };
  }

  /** The sum of the order's REFUND credits in its own currency, or null when there are none. */
  private async refundedOf(
    scope: TenantContext,
    order: { readonly id: string; readonly total: Money },
    tx: TransactionScope,
  ): Promise<Money | null> {
    const entries = await this.deps.facts.entriesOfOrder(scope, order.id, 'REFUND', tx);
    const sum = entries
      .filter(
        (entry) => entry.direction === 'CREDIT' && entry.amount.currency === order.total.currency,
      )
      .reduce((total, entry) => total + entry.amount.amountMinor, 0n);
    return sum > 0n ? money(sum, order.total.currency) : null;
  }
}
