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
 * So the list is exactly the seven a customer initiates from My Services: the three 4E
 * added, the three 4F did, and the rotation WP6-C did. Three of them are ones they have
 * PAID for, which is why being told nothing was the sharpest gap
 * `docs/phase4h-audit.md` §6 measured.
 *
 * `ROTATE_SUBSCRIPTION` is here although its success, like a provision's, also produces
 * a delivery of the new link. The difference is ABANDONMENT: a provision that never
 * finishes has `SERVICE_PROVISION_DELAYED`, and a rotation that never finishes would
 * otherwise say nothing at all to the customer who asked for it. An operator's rotation
 * is still told nothing — `requested_by_customer_id` is null — which is the rule this
 * list was never able to express on its own (`docs/wp6c-audit.md` C3).
 */
export const CUSTOMER_REQUESTABLE_OPERATIONS: readonly OperationType[] = [
  'SUSPEND',
  'RESUME',
  'TERMINATE',
  'RENEW',
  'ADD_TRAFFIC',
  'ADD_TIME',
  'ROTATE_SUBSCRIPTION',
  /*
   * Since the customer UX completion (§H1): a customer may ask for a usage read from
   * the service card, and is then owed its outcome like any other request. The
   * SCHEDULED sync still has `requested_by_customer_id` NULL and is still announced to
   * nobody — the docblock on `DELAY_ANNOUNCED_OPERATIONS` still holds for it.
   */
  'SYNC_USAGE',
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

/**
 * How long a terminal operation is left to the loop before the sweep takes it.
 *
 * A module constant and not a settings-registry entry: the registry is contract
 * surface, declared once and readable by an operator, and this is a number
 * nobody will ever tune. `DRAIN_LIMIT` in `provisioner-loop.ts` is the
 * precedent.
 *
 * Five minutes is well past any ordinary tick — the loop announces within
 * milliseconds of terminalising — so anything this sweep finds is a crash, not a
 * race with the loop.
 */
export const ANNOUNCE_GRACE_MS = 5 * 60 * 1000;

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
    /**
     * The customer who ASKED, or null when nobody did.
     *
     * Read separately from `customerId` because they answer different questions:
     * that one is whose service this is, this one is whether anybody is owed a
     * sentence about the outcome. Before Phase 6A they could be collapsed, because
     * the six types below were reachable only from the customer's own screen. They
     * cannot be now — an operator's suspend is the same type and the same service.
     */
    readonly requestedByCustomerId: UserId | null;
    /**
     * Null on a FAILED row means the failure is TERMINAL: no retry is scheduled. A
     * FAILED row with a retry pending is not an outcome yet and is announced to nobody.
     */
    readonly nextAttemptAt: Date | null;
  } | null>;

  /**
   * Terminal operations nobody has answered for, oldest first.
   *
   * The sweep's claim surface, and the reason it cannot miss a terminalising
   * site: it never looks at one. `provisioner.service.ts` writes a terminal
   * state at roughly sixteen places, and a fix that added an enqueue to each
   * would be wrong the moment somebody adds a seventeenth — silently, because a
   * missing announcement looks exactly like an operation that had nothing to
   * say. Keying on the STATE instead means a new terminalising path is swept by
   * construction.
   *
   * `before` is the grace cutoff against `completed_at`, NOT `updated_at`: any
   * bookkeeping write moves the latter, and an operation that terminalised ten
   * minutes ago should be swept whether or not something touched the row since.
   */
  dueForAnnouncement(
    scope: TenantContext,
    before: Date,
    limit: number,
    tx: TransactionScope,
  ): Promise<readonly string[]>;
}

/**
 * The one write the announcer makes to an operation.
 *
 * Its OWN port, because `OperationOutcomeReader` above promises in as many words
 * that it cannot mutate — "Narrow, so a loop cannot mutate either row" — and
 * adding `markAnnounced` to it would make that sentence false. The sentence is
 * the reason the reader is shaped the way it is, so the write goes beside it
 * rather than into it.
 */
export interface OperationAnnouncementWriter {
  markAnnounced(
    scope: TenantContext,
    operationId: string,
    now: Date,
    tx: TransactionScope,
  ): Promise<void>;
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
      readonly announcements: OperationAnnouncementWriter;
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
   *
   * ## No activity check, deliberately
   *
   * Every other write path in this codebase reads `ScopeActivityReader` inside its
   * transaction and refuses a scope that has stopped accepting work. This one does not,
   * and the omission is a DECISION rather than the oversight it looks like — which is
   * why it is written here and in `docs/conventions.md` rather than left as an absent
   * line of code.
   *
   * What this queues is the outcome of work that has ALREADY been done. A renewal that
   * reached the panel, a provision nothing could resolve: the money moved and the
   * request happened before the operator stopped the tenant. Telling the customer what
   * became of it is not new business work, and suppressing it leaves somebody who paid
   * in silence — the gap `docs/phase4h-audit.md` measured and Phase 4H existed to close.
   * An operator stopping a tenant is not asking for its existing customers to be
   * abandoned mid-provision.
   *
   * The BOUND is what makes this an exception rather than a hole: this class may
   * enqueue a message and stamp `announced_at`. It may not create an order, a payment,
   * a service or an operation, and it holds no dependency that could — `reader` is
   * read-only by construction and `announcements` writes one timestamp.
   *
   * `tests/integration/provisioning.test.ts` fails if somebody adds the check.
   */
  async announce(scope: TenantContext, operationId: string): Promise<void> {
    await this.deps.uow.run(scope, async (tx) => {
      /*
       * The stamp, and the four exits that take it.
       *
       * `announced_at` means ANSWERED, not "a message was sent". Four of the five
       * ways out of this method are answers — including the three that decide the
       * operation says nothing — because a row left NULL is a row the sweep
       * re-reads for ever. The fifth, a state that is not terminal, must NOT
       * stamp: a `FAILED` with attempts left goes back to `PLANNED`, and marking
       * it answered before it has finished is the same silence from the other
       * side.
       *
       * Every stamp is inside THIS transaction, the one that also enqueues. That
       * is what makes the pair atomic: a crash before the commit leaves NULL and
       * the sweep retries; a retry after it enqueues nothing, because
       * `customer_notifications_subject_key` plus `onConflictDoNothing` is
       * already the lane's told-once rule.
       */
      const stamp = (): Promise<void> =>
        this.deps.announcements.markAnnounced(scope, operationId, this.deps.clock.now(), tx);

      const subject = await this.deps.reader.subjectFor(scope, operationId, tx);
      /*
       * No subject: nothing will ever be owed, so this IS answered.
       *
       * Leaving it NULL would make the sweep re-read an operation whose service
       * or customer is gone on every tick, for ever.
       */
      if (subject === null) {
        await stamp();
        return;
      }
      /*
       * The one exit that does not stamp. See above.
       *
       * A terminal FAILED (no retry scheduled) IS an outcome since the customer UX
       * completion (§H1): a customer who asked for something and will never get it is
       * owed the sentence, whatever the type. A FAILED row still waiting for its retry
       * is not terminal and falls through this exit like any IN_FLIGHT one.
       */
      const terminalFailure = subject.state === 'FAILED' && subject.nextAttemptAt === null;
      if (subject.state !== 'SUCCEEDED' && subject.state !== 'ABANDONED' && !terminalFailure) {
        return;
      }
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
        await stamp();
        return;
      }

      /* Nobody is owed a message about this one, which is an answer. */
      if (
        subject.requestedByCustomerId === null ||
        !CUSTOMER_REQUESTABLE_OPERATIONS.includes(subject.type)
      ) {
        await stamp();
        return;
      }

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
      await stamp();
    });
  }

  /**
   * The operations a crash left terminal and unanswered, answered.
   *
   * ## Why this exists rather than an enqueue at each terminalising site
   *
   * `ProvisionerLoop` calls `announce` on the line AFTER `executor.runOnce`
   * returns, and those are two transactions with a process boundary between
   * them. A container restart in that gap — a rolling update, an OOM, a host
   * reboot — leaves an operation that is terminal, un-announced, and that
   * nothing will ever call `announce` for again: the loop has moved on, and
   * `grep -n "announce("` finds exactly one call site in the tree.
   *
   * The 4H Codex review asked for the enqueue to move INSIDE each terminalising
   * transaction. `docs/phase4j-audit.md` measures why that was declined:
   * `provisioner.service.ts` terminalises at roughly sixteen places, and a fix
   * that adds an enqueue to each is wrong the moment somebody adds a
   * seventeenth — silently, because a missing announcement looks exactly like an
   * operation that had nothing to say. This keys on the STATE instead and never
   * reads a call site, so a terminalising path added later is swept by
   * construction rather than by somebody remembering.
   *
   * ## Why a grace period
   *
   * `before` is `now - GRACE`, so the ordinary operation is announced by the
   * loop's own synchronous call and never reaches here. Both paths are safe —
   * `announce` is idempotent by the subject key and by the stamp — but a sweep
   * that fired for every operation would make the loop's call dead code, and
   * dead code is code nothing would notice breaking.
   *
   * ## Bounded, and one batch
   *
   * `limit` per tick, and no drain. `announce` enqueues rather than sends, so
   * this touches no network — but the rows it writes are claimed later by the
   * dispatcher against Telegram, whose limits are somebody else's, and
   * `ProvisionerLoop`'s delivery call makes the same argument for the same
   * reason.
   *
   * Two replicas sweeping at once is safe and expected: they may both hand the
   * same id to `announce`, and the second finds the row already stamped by the
   * first's committed transaction, or loses the insert to
   * `customer_notifications_subject_key`. Neither produces a second message.
   */
  async announceDue(scope: TenantContext, limit: number): Promise<number> {
    const before = new Date(this.deps.clock.now().getTime() - ANNOUNCE_GRACE_MS);
    const due = await this.deps.uow.run(scope, async (tx) =>
      this.deps.reader.dueForAnnouncement(scope, before, limit, tx),
    );
    /*
     * One transaction each, and one failure does not end the batch.
     *
     * `announce` opens its own transaction, so batching them into one would mean
     * a single failing subject rolling back every stamp beside it. The loop that
     * called them had the same defect one level up and it is the reason this
     * `try` exists: `dueForAnnouncement` orders OLDEST FIRST, so a row that
     * throws is first again on the next tick and on every tick after it —
     * head-of-line blocking that would stop the sweep for ever while the
     * docblock above claimed it could not happen.
     *
     * The first error is kept and re-thrown AFTER the rest of the batch, not
     * instead of it. Swallowing it would make a broken sweep look like an idle
     * one; `ProvisionerLoop.tick` catches and logs, and its `lastProgressAt`
     * deliberately does not advance on a tick that failed.
     */
    let failure: unknown = null;
    let swept = 0;
    for (const operationId of due) {
      try {
        await this.announce(scope, operationId);
        swept += 1;
      } catch (error: unknown) {
        if (failure === null) failure = error;
      }
    }
    if (failure !== null) throw failure;
    return swept;
  }
}
