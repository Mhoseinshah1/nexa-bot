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

/**
 * The operations whose ABANDONMENT is a delay the customer is waiting on.
 *
 * Neither is customer-initiated, which is why they are a separate list rather than
 * members of the one above: the customer did not ask for either, but they ARE waiting
 * on what both produce — a subscription link they have paid for.
 *
 * `SYNC_USAGE` is deliberately absent. It reads a number back from a panel and a
 * customer waiting on nothing is not delayed; announcing it would be a message about
 * this installation's housekeeping.
 */
export const DELAY_ANNOUNCED_OPERATIONS: readonly OperationType[] = ['PROVISION', 'RECONCILE'];

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

      /*
       * The one thing a customer is told about an operation they did NOT start.
       *
       * `docs/phase4h-audit.md` §5: a customer who had paid saw `bot.order.settled`,
       * then `bot.service.provisioning`, and then nothing at all if provisioning did
       * not finish — for as long as it took, with no way to ask.
       *
       * ABANDONED only. A held-off operation is still being retried and a FAILED one
       * with attempts left goes back to PLANNED, so saying "this is taking longer than
       * expected" then would be a statement the next attempt contradicts — and
       * `bot.service.provision_delayed` deliberately does NOT invite a retry, because a
       * retry after an unknown outcome is how a duplicate paid-for account is made.
       * `OPERATION_MACHINE` reaches ABANDONED when nothing else can resolve it, which
       * is the moment the sentence becomes true.
       *
       * `RECONCILE` counts as well as `PROVISION`: a reconcile is this installation
       * asking a panel what it did, and one that is abandoned leaves the service
       * `UNRECONCILED` — a customer waiting on a link nobody can produce.
       *
       * The subject is the SERVICE, not the operation, and it is the one place in this
       * class where that is right: `CUSTOMER_NOTIFICATION_PRECONDITIONS` marks this
       * kind as needing a re-check, and the check reads `services.state`. Keying on the
       * operation would leave `stillHolds` looking up a service id that is an operation
       * id, and a lookup that finds nothing answers `false` — so every delay
       * notification would be SUPERSEDED instead of sent.
       */
      if (outcome === 'ABANDONED' && DELAY_ANNOUNCED_OPERATIONS.includes(subject.type)) {
        await this.deps.notifier.notify(
          scope,
          subject.customerId,
          'SERVICE_PROVISION_DELAYED',
          serviceId,
          this.deps.clock.now(),
          tx,
        );
        return;
      }

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
