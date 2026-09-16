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
  /**
   * Everything the announcement depends on, from the operation id alone.
   *
   * The STATE is read here rather than passed in, and the service id is derived rather
   * than supplied, because both used to come from the caller: `ProvisionerLoop` passed
   * `result.outcome`, which only an `ATTEMPTED` result carries — so the three `REFUSED`
   * paths that terminalise an operation to `ABANDONED` announced nothing at all. A
   * reader that answers from the row cannot be handed the wrong outcome, and makes the
   * call safe to make for any operation at any time. Found by the Codex review of
   * PR #30.
   */
  subjectFor(
    scope: TenantContext,
    operationId: string,
    tx: TransactionScope,
  ): Promise<{
    readonly type: OperationType;
    readonly state: OperationState;
    readonly serviceId: string;
    readonly customerId: UserId;
  } | null>;
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
   * Queues the outcome of one operation, if a customer asked for it.
   *
   * Takes an operation ID and NOTHING ELSE, and decides from the row. The outcome used
   * to be a parameter, supplied by `ProvisionerLoop` from `result.outcome` — a field
   * only an `ATTEMPTED` result has. Three `REFUSED` paths terminalise an operation to
   * `ABANDONED` (a missing service, an unsupported capability, a service in the wrong
   * state) and the loop broke on `REFUSED` before announcing, so a customer whose
   * renewal was refused because this release cannot renew on their panel was told
   * nothing, every time. Not a race: a deterministic silence.
   *
   * Reading the state here also makes the call IDEMPOTENT and safe from anywhere:
   * `customer_notifications_subject_key` plus `onConflictDoNothing` mean a second call
   * about the same operation queues nothing.
   *
   * Only TERMINAL states are announced. A `FAILED` with attempts left goes back to
   * PLANNED and will be tried again, and telling a customer their renewal failed while
   * the provisioner is still retrying it would be false — the rule `persistFailure`
   * already encodes, read from the other side.
   *
   * `UNKNOWN` says nothing either: the request may have taken effect, and this
   * repository's standing answer to "we do not know" is never to claim we do.
   */
  async announce(scope: TenantContext, operationId: string): Promise<void> {
    await this.deps.uow.run(scope, async (tx) => {
      const subject = await this.deps.reader.subjectFor(scope, operationId, tx);
      if (subject === null) return;
      if (subject.state !== 'SUCCEEDED' && subject.state !== 'ABANDONED') return;
      const { serviceId } = subject;
      const outcome = subject.state;

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
