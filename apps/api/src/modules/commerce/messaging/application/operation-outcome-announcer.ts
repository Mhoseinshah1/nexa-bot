import type { OperationState, OperationType, TenantContext, UserId } from '@nexa/contracts';
import type { UnitOfWork, Clock } from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { CustomerNotifier } from './customer-notifier.js';

/**
 * Which operations a CUSTOMER asked for, and therefore is owed an answer about.
 *
 * `PROVISION` and `RECONCILE` are not here, and the omission is deliberate rather than
 * an oversight. A successful provision already produces the subscription link through
 * `DeliveryService`, which is a better message than "your request was applied"; and a
 * reconcile is this installation asking a panel a question, which the customer never
 * asked for and would be confused to hear about. `SYNC_USAGE` is a background read.
 *
 * So the list is exactly the six a customer initiates from My Services: the three 4E
 * added and the three 4F did. Three of those six are ones they have PAID for, which is
 * why being told nothing was the sharpest gap `docs/phase4h-audit.md` §6 measured.
 */
export const CUSTOMER_INITIATED_OPERATIONS: readonly OperationType[] = [
  'SUSPEND',
  'RESUME',
  'TERMINATE',
  'RENEW',
  'ADD_TRAFFIC',
  'ADD_TIME',
];

/** What the announcer needs to look up. Narrow, so a loop cannot mutate either row. */
export interface OperationOutcomeReader {
  /** The operation's type and the service's customer, or null if either is gone. */
  subjectFor(
    scope: TenantContext,
    operationId: string,
    serviceId: string,
    tx: TransactionScope,
  ): Promise<{ readonly type: OperationType; readonly customerId: UserId } | null>;
}

/**
 * Tells a customer how the thing they asked for turned out.
 *
 * Driven by `ProvisionerLoop` rather than by the executor, and that placement is the
 * rule the pair already exists to hold: the executor does not have a messenger, which is
 * a stronger guarantee than a comment saying it must not use one. This class does not
 * have one either — it writes a ROW, and the lane's own dispatcher sends it later, in
 * the worker, outside any transaction.
 *
 * Between `bot.service.action_requested` ("we have asked") and this, the customer used
 * to hear nothing at all. For a renewal they have paid for, that was the gap.
 */
export class OperationOutcomeAnnouncer {
  constructor(
    private readonly deps: {
      readonly reader: OperationOutcomeReader;
      readonly notifier: CustomerNotifier;
      readonly uow: UnitOfWork<TransactionScope>;
      readonly clock: Clock;
    },
  ) {}

  /**
   * Queues the outcome of one attempted operation, if a customer asked for it.
   *
   * Only TERMINAL outcomes are announced. A `FAILED` with attempts left goes back to
   * PLANNED and will be tried again, and telling a customer their renewal failed while
   * the provisioner is still retrying it would be false — the rule `persistFailure`
   * already encodes, read from the other side.
   *
   * `UNKNOWN` says nothing either: the request may have taken effect, and this
   * repository's standing answer to "we do not know" is never to claim we do.
   */
  async announce(
    scope: TenantContext,
    operationId: string,
    serviceId: string,
    outcome: OperationState,
  ): Promise<void> {
    if (outcome !== 'SUCCEEDED' && outcome !== 'ABANDONED') return;

    await this.deps.uow.run(scope, async (tx) => {
      const subject = await this.deps.reader.subjectFor(scope, operationId, serviceId, tx);
      if (subject === null) return;
      if (!CUSTOMER_INITIATED_OPERATIONS.includes(subject.type)) return;

      /*
       * The SUBJECT is the operation, not the service.
       *
       * `customer_notifications_subject_key` is (tenant, kind, subject), so keying on
       * the service would tell a customer about their first renewal and silently drop
       * the second. Each operation is its own fact and is owed its own sentence.
       */
      await this.deps.notifier.notify(
        scope,
        subject.customerId,
        outcome === 'SUCCEEDED' ? 'SERVICE_ACTION_SUCCEEDED' : 'SERVICE_ACTION_FAILED',
        operationId,
        this.deps.clock.now(),
        tx,
      );
    });
  }
}
