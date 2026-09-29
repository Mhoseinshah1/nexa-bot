import {
  money,
  systemJobActor,
  type ActorContext,
  type BulkSkipReason,
  type Clock,
  type CorrelationId,
  type CurrencyCode,
  type IdGenerator,
  type TenantContext,
  type UnitOfWork,
  type UserId,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { OutboxWriter } from '../../../platform/eventing/infrastructure/outbox-writer.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { CustomerNotifier } from '../../messaging/application/customer-notifier.js';
import type { WalletRepository } from '../../wallet/application/ports.js';
import type { BulkOperationRepository, LockedItem } from './ports.js';

/** How many items one pass processes at most, each in its own transaction. */
export const BULK_PASS_LIMIT = 200;

export interface BulkPassReport {
  readonly credited: number;
  readonly planned: number;
  readonly skipped: number;
  readonly settled: number;
  readonly completed: number;
  readonly errored: number;
}

/** The narrow slice of `ProvisioningService` a grant needs: plan one free operation. */
export interface GrantPlanner {
  planGrant(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly serviceId: string;
      readonly customerId: UserId;
      readonly kind: 'ADD_TRAFFIC' | 'ADD_TIME';
      readonly trafficBytes: bigint;
      readonly durationDays: number;
      readonly grantKey: string;
    },
    now: Date,
    tx: TransactionScope,
  ): Promise<
    | { readonly outcome: 'PLANNED'; readonly operation: { readonly id: string } }
    | { readonly outcome: 'UNFULFILLABLE'; readonly reason: string }
  >;
}

export interface BulkOperationProcessorDeps {
  readonly repository: BulkOperationRepository;
  readonly wallet: Pick<WalletRepository, 'append'>;
  readonly grants: GrantPlanner;
  readonly notifier: Pick<CustomerNotifier, 'notify'>;
  readonly outbox: OutboxWriter;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly scopeActivity: ScopeActivityReader;
  readonly sellingCurrency: (scope: TenantContext, tx: TransactionScope) => Promise<CurrencyCode>;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: {
    info: (context: Record<string, unknown>, message: string) => void;
    error: (context: Record<string, unknown>, message: string) => void;
  };
}

/** A planner's refusal, in the item's vocabulary. */
export function skipReasonFor(reason: string): BulkSkipReason {
  switch (reason) {
    case 'SERVICE_NOT_OWNED':
    case 'TERMINATION_PENDING':
    case 'REFUND_REQUESTED':
    case 'UNLIMITED':
    case 'LIMIT_EXCEEDED':
      return reason;
    case 'ACTION_IN_PROGRESS':
    case 'ROTATION_IN_PROGRESS':
      return 'ACTION_IN_PROGRESS';
    default:
      return reason.startsWith('SERVICE_') ? 'SERVICE_NOT_ELIGIBLE' : 'PANEL_NOT_OPERABLE';
  }
}

/**
 * The mass-operation processor (round N, B2): one item, one transaction.
 *
 * Exactly once, by construction: the item is locked `FOR UPDATE SKIP LOCKED` and moved out of
 * PENDING by a conditional UPDATE in the SAME transaction that writes its effect. A crash
 * anywhere before the commit rolls back both, and the item is taken again; a commit makes
 * both true at once. A wallet entry's reference is `bulk:<operation>:<customer>`, unique per
 * tenant, so even a second transaction for the same item could not credit twice — it would
 * find the first entry and write nothing. A grant's operation id derives from the operation
 * and the service, so a replay plans the same operation.
 *
 * Live facts re-read here, because a frozen list decides WHO and only the present can decide
 * whether money or a provider write is still safe: the scope still accepting work, a customer
 * an operator has since blocked (when the audience asked for active customers), the selling
 * currency, and — inside the planner — the service's state, owner, panel operability and any
 * action already open on it.
 *
 * A planned grant's outcome is the provisioning operation's own, read back and never copied
 * early: UNKNOWN stays UNKNOWN until the provisioner's reconciliation READ decides it, and the
 * customer is told only of a grant that SUCCEEDED.
 */
export class BulkOperationProcessor {
  constructor(private readonly deps: BulkOperationProcessorDeps) {}

  private actor(): ActorContext {
    return systemJobActor('bulk-operations', this.deps.ids.uuid() as CorrelationId);
  }

  async pass(scope: TenantContext, limit = BULK_PASS_LIMIT): Promise<BulkPassReport> {
    const report = { credited: 0, planned: 0, skipped: 0, settled: 0, completed: 0, errored: 0 };
    const actor = this.actor();
    const failed: string[] = [];
    for (let index = 0; index < limit; index += 1) {
      const outcome = await this.processOne(scope, actor, failed);
      if (outcome === 'none' || outcome === 'stopped') break;
      report[outcome] += 1;
    }

    const now = this.deps.clock.now();
    report.settled = await this.deps.uow.run(scope, async (tx) => {
      const settled = await this.deps.repository.settlePlanned(scope, now, limit, tx);
      for (const item of settled) {
        if (item.to !== 'SUCCEEDED' || !item.notify) continue;
        const queued = await this.deps.notifier.notify(
          scope,
          item.customerId as UserId,
          'SERVICE_GIFT_APPLIED',
          item.itemId,
          now,
          tx,
        );
        if (queued) await this.deps.repository.markNotified(scope, item.itemId, now, tx);
      }
      return settled.length;
    });

    report.completed = await this.deps.uow.run(scope, async (tx) => {
      const finished = await this.deps.repository.completeFinished(scope, now, tx);
      for (const operation of finished) {
        await this.deps.outbox.write(tx, actor, {
          eventType: 'BulkOperationStateChanged',
          aggregateType: 'BulkOperation',
          aggregateId: operation.id,
          payload: {
            operationId: operation.id,
            kind: operation.kind,
            from: 'RUNNING',
            to: 'COMPLETED',
            items: operation.items,
          },
        });
      }
      return finished.length;
    });
    return report;
  }

  private async processOne(
    scope: TenantContext,
    actor: ActorContext,
    failed: string[],
  ): Promise<'none' | 'stopped' | 'credited' | 'planned' | 'skipped' | 'errored'> {
    const now = this.deps.clock.now();
    let locked: string | null = null;
    try {
      return await this.deps.uow.run(scope, async (tx) => {
        // A stopped tenant takes no new money or provider work, checked inside the write.
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) return 'stopped';
        const item = await this.deps.repository.lockNextPending(scope, now, failed, tx);
        if (item === null) return 'none';
        locked = item.id;
        if (item.requiresActiveCustomer) {
          const status = await this.deps.repository.customerStatus(scope, item.customerId, tx);
          if (status !== 'ACTIVE') {
            await this.deps.repository.markSkipped(scope, item.id, 'CUSTOMER_BLOCKED', now, tx);
            return 'skipped';
          }
        }
        return item.kind === 'WALLET_CREDIT'
          ? this.credit(scope, actor, item, now, tx)
          : this.grant(scope, actor, item, now, tx);
      });
    } catch (error: unknown) {
      /*
       * The transaction rolled back: nothing of this item happened. It is left out of the rest
       * of this pass, so one bad item cannot hold every other one behind it, and is taken
       * again by the next pass.
       */
      this.deps.logger.error(
        { err: error instanceof Error ? error.message : 'unknown', itemId: locked },
        'bulk item failed',
      );
      if (locked !== null) failed.push(locked);
      return 'errored';
    }
  }

  private async credit(
    scope: TenantContext,
    actor: ActorContext,
    item: LockedItem,
    now: Date,
    tx: TransactionScope,
  ): Promise<'credited' | 'skipped'> {
    if (item.amountMinor === null || item.currency === null) {
      throw new Error(`wallet credit ${item.operationId} carries no amount`);
    }
    if ((await this.deps.sellingCurrency(scope, tx)) !== item.currency) {
      await this.deps.repository.markSkipped(scope, item.id, 'CURRENCY_CHANGED', now, tx);
      return 'skipped';
    }
    const { entry, inserted } = await this.deps.wallet.append(
      scope,
      {
        id: this.deps.ids.uuid(),
        customerId: item.customerId as UserId,
        direction: 'CREDIT',
        reason: 'MASS_CREDIT',
        amount: money(item.amountMinor, item.currency),
        // The idempotency identity: this operation, this customer. Unique per tenant.
        reference: `bulk:${item.operationId}:${item.customerId}`,
        actorAdminId: item.createdByAdminId,
        note: item.note,
        now,
      },
      tx,
    );
    await this.deps.repository.markCredited(scope, item.id, entry.id, now, tx);
    if (inserted) {
      await this.deps.outbox.write(tx, actor, {
        eventType: 'WalletEntryRecorded',
        aggregateType: 'Wallet',
        aggregateId: entry.customerId,
        payload: {
          customerId: entry.customerId,
          entryId: entry.id,
          direction: entry.direction,
          reason: entry.reason,
          amountMinor: entry.amount.amountMinor.toString(),
          currency: entry.amount.currency,
        },
      });
    }
    if (item.notify) {
      // Enqueued in the transaction that wrote the credit: a credit that did not happen is
      // never announced, and one that did is announced once (the lane's subject key).
      const queued = await this.deps.notifier.notify(
        scope,
        item.customerId as UserId,
        'WALLET_MASS_CREDITED',
        item.id,
        now,
        tx,
      );
      if (queued) await this.deps.repository.markNotified(scope, item.id, now, tx);
    }
    return 'credited';
  }

  private async grant(
    scope: TenantContext,
    actor: ActorContext,
    item: LockedItem,
    now: Date,
    tx: TransactionScope,
  ): Promise<'planned' | 'skipped'> {
    if (item.serviceId === null) throw new Error(`grant item ${item.id} names no service`);
    const planned = await this.deps.grants.planGrant(
      scope,
      actor,
      {
        serviceId: item.serviceId,
        customerId: item.customerId as UserId,
        kind: item.kind === 'SERVICE_TRAFFIC' ? 'ADD_TRAFFIC' : 'ADD_TIME',
        trafficBytes: item.trafficBytes ?? 0n,
        durationDays: item.durationDays ?? 0,
        grantKey: item.operationId,
      },
      now,
      tx,
    );
    if (planned.outcome === 'UNFULFILLABLE') {
      await this.deps.repository.markSkipped(
        scope,
        item.id,
        skipReasonFor(planned.reason),
        now,
        tx,
      );
      return 'skipped';
    }
    await this.deps.repository.markPlanned(scope, item.id, planned.operation.id, now, tx);
    return 'planned';
  }
}
