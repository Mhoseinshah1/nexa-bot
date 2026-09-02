import {
  OPERATIONAL_SEVERITIES,
  isSystemContext,
  type Logger,
  type UnitOfWork,
  type OperationalEventInput,
  type OperationalEventRecorder,
  type OperationalSeverity,
  type RecordedOperationalEvent,
  type ScopeContext,
  type SettingKey,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { SettingsResolver } from '../../settings/application/settings-resolver.js';
import type { NotificationService } from './notification.service.js';

const SEVERITY_RANK = new Map<OperationalSeverity, number>(
  OPERATIONAL_SEVERITIES.map((severity, index) => [severity, index]),
);

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
 *   - **Severity routes.** At or above the configured threshold, per the
 *     corpus's own recommendation that severity be carried on the event "so
 *     routing is a rule, not a topic choice". The legacy log routes by forum
 *     topic and has no severity at all (LGR-BR-081).
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
   * @param settings a resolver wired to the RAW recorder, not to this one
   * @param logger where a failed projection goes
   *
   * That third parameter is load-bearing. `SettingsResolver` records an
   * operational event when a stored value no longer parses, and this projection
   * reads settings — so a resolver wired to this decorator would recurse on the
   * first bad value. The composition root gives the projection path a resolver
   * that writes straight to the underlying recorder, which removes the cycle
   * rather than detecting it.
   *
   * The first version of this class used a re-entrancy flag instead. It was
   * wrong under concurrency: two events arriving together would find the flag
   * set and the second would be recorded but never announced, silently, which is
   * the failure mode this whole subsystem exists to prevent.
   */
  constructor(
    private readonly inner: OperationalEventRecorder,
    private readonly notifications: NotificationService,
    private readonly settings: SettingsResolver,
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
    if (tx !== undefined) return this.recordAndProject(scope, event, tx);

    try {
      return await this.uow.run(scope, (opened) => this.recordAndProject(scope, event, opened));
    } catch (error) {
      // The WRITE must stand. The event is the authoritative record and the
      // notification is a projection of it, so if the two cannot be committed
      // together the right thing to lose is the projection.
      //
      // Nothing was committed — the transaction rolled back — so recording
      // again here is not a duplicate.
      this.logger.error(
        {
          err: error instanceof Error ? error.message : String(error),
          code: event.code,
        },
        'Could not record an operational event and its notification together; recording the event alone',
      );
      return this.inner.record(scope, event);
    }
  }

  private async recordAndProject(
    scope: ScopeContext,
    event: OperationalEventInput,
    tx: unknown,
  ): Promise<RecordedOperationalEvent> {
    const recorded = await this.inner.record(scope, event, tx);
    if (!recorded.isNew && !recorded.reopened) return recorded;

    try {
      const threshold = await this.settings.valueOf<OperationalSeverity>(
        scope,
        'ops.notifications.min_severity' as SettingKey,
        tx,
      );
      if (rank(recorded.severity) < rank(threshold)) return recorded;

      await this.notifications.queue(
        scope,
        {
          kind: 'OPERATIONAL_EVENT',
          // The occurrence count is part of the identity so that a condition which
          // resolves and recurs is announced again, while the same open condition
          // firing repeatedly is not.
          dedupeKey: `opslog:${recorded.id}:${recorded.occurrenceCount}`,
          templateKey: 'ops.notification.operational_event',
          values: {
            severity: recorded.severity,
            code: recorded.code,
            message: recorded.message,
            occurrences: recorded.occurrenceCount,
            firstSeenAt: recorded.firstSeenAt,
          },
          ...(event.correlationId ? { correlationId: event.correlationId } : {}),
        },
        tx,
      );
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

function rank(severity: OperationalSeverity): number {
  return SEVERITY_RANK.get(severity) ?? 0;
}
