import {
  isSystemContext,
  opsLogTopicForCode,
  type Logger,
  type UnitOfWork,
  type OperationalEventInput,
  type OperationalEventRecorder,
  type RecordedOperationalEvent,
  type ScopeContext,
  type TenantContext,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { NotificationService } from './notification.service.js';
import {
  OPERATIONAL_ID_MAX,
  OPERATIONAL_MESSAGE_BUDGET,
  boundedForTelegram,
  contextBotInstanceId,
  operationalEventDetails,
} from './event-details.js';

/**
 * Projects operational events into notifications.
 *
 * A decorator over the real recorder, so the projection cannot be forgotten at a
 * call site: everything that records an operational event goes through here.
 *
 * Three rules decide whether anything is sent, and each answers a documented
 * legacy failure:
 *
 *   - **Once per condition, not once per occurrence.** Only a NEW row, or one
 *     reopened after having been resolved, produces a notification. The legacy
 *     log group posted the same expired-TLS error 36 + 15 + 8 + 1 times in one
 *     day (BUG-LGR-028); dedupe made that one row here, and this makes it one
 *     message.
 *   - **Explicit routing, not a severity cutoff (WP-A4).** Every meaningful
 *     event is eligible; `opsLogTopicForCode` decides which of the group's
 *     topics it goes to. The operator-set minimum severity this replaced
 *     silently suppressed events nobody had decided to hide, and
 *     `ops.notifications.min_severity` is no longer read. Severity stays on the
 *     event and in the message.
 *   - **A recovery is worth saying.** An event that reopens a resolved
 *     condition is news even though its row is not new — the legacy log never
 *     follows an error with a resolution at all (BUG-LGR-029).
 *
 * The event and the intent commit TOGETHER. That matters more here than it
 * looks: without it, a process that dies between the two loses the alert
 * permanently, because the condition's next occurrence is a repeat rather than
 * a new one and nothing would announce it until it resolved and came back.
 *
 * Where the two cannot be committed together, the projection is what is lost
 * and the write stands — the event is the authoritative record and Telegram is
 * a projection of it, never the other way round.
 */
export class NotifyingOperationalEventRecorder implements OperationalEventRecorder {
  /**
   * @param inner the real recorder
   * @param notifications the queue this projects into
   * @param logger where a failed projection goes
   *
   * The queue reads settings and the feature flag, and `SettingsResolver`
   * records an operational event when a stored value no longer parses — so the
   * composition root gives `NotificationService` a resolver wired to the RAW
   * recorder, never to this decorator, which removes the cycle rather than
   * detecting it. (This class read the severity threshold itself until WP-A4,
   * and carried that resolver for it.)
   *
   * The first version of this class used a re-entrancy flag instead. It was
   * wrong under concurrency: two events arriving together would find the flag
   * set and the second would be recorded but never announced, silently, which is
   * the failure mode this whole subsystem exists to prevent.
   */
  constructor(
    private readonly inner: OperationalEventRecorder,
    private readonly notifications: NotificationService,
    private readonly uow: UnitOfWork<TransactionScope>,
    private readonly logger: Logger,
  ) {}

  async record(
    scope: ScopeContext,
    event: OperationalEventInput,
    tx?: unknown,
  ): Promise<RecordedOperationalEvent> {
    // Platform-scoped events belong to no tenant, so there is no tenant whose
    // destination or threshold would apply. They are still recorded; they are
    // simply not projected anywhere yet, and there is nothing to be atomic with.
    if (isSystemContext(scope)) return this.inner.record(scope, event, tx);

    // Already inside somebody's transaction: join it rather than opening a
    // second one, and let their commit carry both.
    if (tx !== undefined) return this.recordAndProject(scope, event, tx as TransactionScope);

    try {
      return await this.uow.run(scope, (opened) => this.recordAndProject(scope, event, opened));
    } catch (error) {
      // Once more TOGETHER before the projection is given up (HF-A4: an event routed to the
      // operations log is never dropped). A transient failure of the combined write — a
      // lost connection, a serialisation failure — is the ordinary case, and a second
      // attempt keeps both halves. It announces nothing twice for a deduped event: if the
      // first attempt had in fact committed, its intent committed with it, and this one
      // collapses onto that row with `isNew` and `reopened` false, so it queues nothing. An
      // event with no dedupe key can gain a second row and a second message, which is the
      // same bounded, visible cost as the fallback below, and a duplicate is not a loss.
      const retried = await this.uow
        .run(scope, (opened) => this.recordAndProject(scope, event, opened))
        .then(
          (recorded) => recorded,
          () => null,
        );
      if (retried !== null) return retried;

      // The WRITE must stand. The event is the authoritative record and the
      // notification is a projection of it, so if the two cannot be committed
      // together the right thing to lose is the projection.
      //
      // This retry can double-count, and saying otherwise was wrong. A rejected
      // transaction does not prove that nothing committed: Postgres can commit
      // and then lose the connection before the client hears about it, and
      // `uow.run` rejects identically either way. So:
      //
      //   - An event WITH a dedupe key — which is nearly all of them, and every
      //     one this projector notifies on — collapses onto the row the first
      //     attempt wrote, so the cost is `occurrence_count` reading 2 for one
      //     occurrence. `isNew` is then false, so no second message is sent.
      //   - An event with no dedupe key inserts unconditionally, so the cost is
      //     a second row for one occurrence.
      //
      // Both are bounded and visible. Losing the event is neither: the
      // condition's next occurrence would be a repeat rather than a new one,
      // so nothing would announce it until it resolved and came back. An
      // over-counted condition is a worse number; an unrecorded one is a
      // silence, and silence is the failure this whole subsystem exists to
      // prevent. The trade is recorded in docs/open-questions.md.
      this.logger.error(
        {
          err: error instanceof Error ? error.message : String(error),
          code: event.code,
          deduped: event.dedupeKey !== undefined,
        },
        'Could not record an operational event and its notification together; recording the event alone, which may double-count if the failed commit had in fact landed',
      );
      return this.inner.record(scope, event);
    }
  }

  private async recordAndProject(
    scope: TenantContext,
    event: OperationalEventInput,
    tx: TransactionScope,
  ): Promise<RecordedOperationalEvent> {
    const recorded = await this.inner.record(scope, event, tx);
    if (!recorded.isNew && !recorded.reopened) return recorded;

    try {
      // Inside a SAVEPOINT, so a failure here rolls back the projection and
      // nothing else.
      //
      // The first version simply caught the error, which keeps nothing: in
      // Postgres the failed statement has already aborted the transaction, so
      // every later statement fails with `current transaction is aborted` and
      // the caller's own write is lost — while this catch block reports that it
      // kept it. That is the failure mode this whole subsystem exists to make
      // hard, written into its own error handling.
      await this.uow.runNested(scope, tx, async (nested) => {
        // No severity threshold (WP-A4): routing decides WHERE, never whether.
        const details = operationalEventDetails(event.context);
        const botInstanceId = scope.botInstanceId ?? contextBotInstanceId(event.context);
        await this.notifications.queue(
          scope,
          {
            kind: 'OPERATIONAL_EVENT',
            // The occurrence count is part of the identity so that a condition
            // which resolves and recurs is announced again, while the same open
            // condition firing repeatedly is not.
            dedupeKey: `opslog:${recorded.id}:${recorded.occurrenceCount}`,
            templateKey: 'ops.notification.operational_event',
            values: {
              severity: recorded.severity,
              code: recorded.code,
              // Bounded, like the detail, so the whole message fits Telegram's 4096.
              message: boundedForTelegram(recorded.message, OPERATIONAL_MESSAGE_BUDGET),
              occurrences: recorded.occurrenceCount,
              firstSeenAt: recorded.firstSeenAt,
              lastSeenAt: recorded.lastSeenAt,
              tenantId: String(scope.tenantId),
              ...(botInstanceId ? { botInstanceId: String(botInstanceId) } : {}),
              ...(details ? { details } : {}),
              ...(event.correlationId
                ? {
                    correlationId: boundedForTelegram(
                      String(event.correlationId),
                      OPERATIONAL_ID_MAX,
                    ),
                  }
                : {}),
            },
            ...(event.correlationId ? { correlationId: event.correlationId } : {}),
            opsTopic: opsLogTopicForCode(recorded.code),
          },
          nested,
        );
      });
    } catch (error) {
      // Not rethrown, and not silent.
      //
      // Rethrowing would roll back the event write along with the projection,
      // and the event is the half worth keeping. Swallowing without saying so
      // would leave a condition unannounced with nothing anywhere recording
      // that it should have been.
      this.logger.error(
        {
          err: error instanceof Error ? error.message : String(error),
          code: recorded.code,
          eventId: recorded.id,
        },
        'Recorded an operational event but could not queue its notification',
      );
    }

    return recorded;
  }
}
