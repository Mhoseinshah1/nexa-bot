import {
  EVENT_PAYLOAD_SCHEMAS,
  type DomainEvent,
  type EventType,
  type TenantContext,
} from '@nexa/contracts';
import type { EventConsumer } from '../../../platform/eventing/application/event-consumer.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import { isAdminActor, publish, scopeOf } from './publish.js';
import { resellerChanged, userBlocked, userNew, type Built } from './presenters.js';
import type { OpsLogFacts, OpsLogLane, OpsLogWords } from './ports.js';

/**
 * The customers' log (Round 4 PR-D): a new customer (L17), a block or an unblock (L18) and
 * a reseller's change of standing (L20), all in the USERS topic.
 *
 * `CustomerImported` is deliberately not subscribed: an import produces NO group message, so a
 * migration of two hundred thousand customers posts nothing. A registration is the customer
 * ROW itself, so it is the one message that reads the customer's provenance — a row the
 * import wrote is not a new customer (the importer writes no `CustomerRegistered`; the check
 * is the hotfix's "the record is its own provenance", kept for the record the event is about).
 *
 * R10 B5 (the v0.8.2-e rule, extended): a block, an unblock and a reseller's change of
 * standing are NOT the customer row. They are written only by this installation —
 * `CustomerService` for an operator's or anti-spam's block, the reseller administration for a
 * standing change — never by the import, which writes a blocked customer's status directly
 * with no event. So a customer the import wrote who is blocked, unblocked or promoted AFTER
 * the import is logged like any other; refusing a `MIRZA` customer here silenced every one of
 * them on an installation migrated with the one-click import.
 */
export class CustomerLogConsumer implements EventConsumer {
  readonly name = 'ops-log.customers';
  readonly subscribesTo: readonly EventType[] = [
    'CustomerRegistered',
    'CustomerBlocked',
    'CustomerUnblocked',
    'ResellerStandingChanged',
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
    const customer = await this.deps.facts.customer(scope, event.aggregateId, tx);
    if (customer === null) return;
    const at = new Date(event.occurredAt);
    let built: Built;

    if (event.eventType === 'CustomerRegistered') {
      // A customer row the import wrote is history, not a new customer: nothing is said.
      if (customer.source !== 'NEXA') return;
      const referrerId = await this.deps.facts.referrerOf(scope, customer.id, tx);
      const referrer =
        referrerId === null ? null : await this.deps.facts.customer(scope, referrerId, tx);
      built = userNew({ customer, referrer, at, words: this.deps.words });
    } else if (event.eventType === 'ResellerStandingChanged') {
      const payload = EVENT_PAYLOAD_SCHEMAS.ResellerStandingChanged.parse(event.payload);
      built = resellerChanged({
        customer,
        customerId: customer.id,
        change: payload.change,
        fromTier: payload.fromTierName,
        toTier: payload.toTierName,
        suspended: payload.toStatus !== 'ACTIVE',
        admin: await this.adminOf(scope, event, tx),
        at,
        words: this.deps.words,
      });
    } else {
      const blocked = event.eventType === 'CustomerBlocked';
      const payload = (
        blocked ? EVENT_PAYLOAD_SCHEMAS.CustomerBlocked : EVENT_PAYLOAD_SCHEMAS.CustomerUnblocked
      ).parse(event.payload);
      const admin = await this.adminOf(scope, event, tx);
      built = userBlocked({
        customer,
        customerId: customer.id,
        blocked,
        // Anti-spam acts as a job and never as an administrator: the actor says which.
        automatic: !isAdminActor(event.actor.type),
        admin,
        reason: payload.reason,
        at,
        words: this.deps.words,
      });
    }
    await publish(this.deps.lane, scope, tx, built, {
      dedupeKey: `oplog:customer:${event.eventId}`,
      correlationId: event.correlationId,
    });
  }

  private async adminOf(scope: TenantContext, event: DomainEvent, tx: TransactionScope) {
    if (!isAdminActor(event.actor.type) || event.actor.id === null) return null;
    return this.deps.facts.admin(scope, event.actor.id, tx);
  }
}
