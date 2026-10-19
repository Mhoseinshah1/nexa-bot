import type { Clock, TenantContext } from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import { publish } from './publish.js';
import { serviceChanged, type ServiceChange } from './presenters.js';
import type { OpsLogFacts, OpsLogLane, OpsLogWords } from './ports.js';

/** What the outcome announcer calls once an operation has terminally succeeded. */
export interface OperationLogHook {
  operationSucceeded(
    scope: TenantContext,
    operationId: string,
    tx: TransactionScope,
  ): Promise<void>;
}

const CHANGES: Readonly<Record<string, ServiceChange>> = {
  RENEW: 'RENEW',
  ADD_TRAFFIC: 'ADD_TRAFFIC',
  ADD_TIME: 'ADD_TIME',
};

/**
 * The log of a service the customer RENEWED or gave more traffic or time (Round 4 PR-D, L12,
 * L13, L14).
 *
 * Called by the outcome announcer — the one place every terminal operation passes exactly
 * once, which is why it is not a consumer of an event (a renewal emits none). It runs in the
 * announcer's transaction, in a savepoint of its own, so a log that cannot be written never
 * costs the customer their answer.
 *
 * Every figure is a fact read now: the operation's absolute target is the AFTER; the BEFORE
 * is the audit row the provisioner wrote in the same transaction as the change. When that
 * row is missing the message omits the "before" lines — it never prints the same date twice,
 * which is the previous bot's bug this exists not to repeat.
 */
export class OperationLog implements OperationLogHook {
  constructor(
    private readonly deps: {
      readonly lane: OpsLogLane;
      readonly facts: OpsLogFacts;
      readonly words: OpsLogWords;
      readonly clock: Clock;
    },
  ) {}

  async operationSucceeded(
    scope: TenantContext,
    operationId: string,
    tx: TransactionScope,
  ): Promise<void> {
    const operation = await this.deps.facts.operation(scope, operationId, tx);
    if (operation === null || operation.state !== 'SUCCEEDED' || operation.orderId === null) return;
    const kind = CHANGES[operation.type];
    if (kind === undefined) return;

    const order = await this.deps.facts.order(scope, operation.orderId, tx);
    if (order === null || order.origin !== 'STANDARD' || order.source !== 'NEXA') return;
    const service = await this.deps.facts.service(scope, operation.serviceId, tx);
    if (service === null || service.source !== 'NEXA') return;
    const customer = await this.deps.facts.customer(scope, order.customerId, tx);
    if (customer === null || customer.source !== 'NEXA') return;
    const payment = await this.deps.facts.paymentOfOrder(scope, order.id, tx);
    const before = await this.deps.facts.serviceBefore(
      scope,
      service.id,
      `service.${operation.type.toLowerCase()}`,
      order.id,
      tx,
    );
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
    const built = serviceChanged({
      kind,
      order,
      service,
      operation,
      before,
      customer,
      payment,
      walletBalance,
      at: operation.completedAt ?? this.deps.clock.now(),
      words: this.deps.words,
    });
    await publish(this.deps.lane, scope, tx, built, { dedupeKey: `oplog:op:${operationId}` });
  }
}
