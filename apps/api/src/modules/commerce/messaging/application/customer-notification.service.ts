import {
  CUSTOMER_NOTIFICATION_BACKOFF_MS,
  CUSTOMER_NOTIFICATION_MAX_ATTEMPTS,
  CUSTOMER_NOTIFICATION_PRECONDITIONS,
  CUSTOMER_NOTIFICATION_TEMPLATES,
  type Clock,
  type CustomerNotificationKind,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type {
  CustomerMessenger,
  CustomerNotificationRecord,
  CustomerNotificationRepository,
} from './ports.js';

/**
 * Whether a kind's fact is still true, asked of the subject itself.
 *
 * A NARROW port, for the reason `CustomerContactReader` gives: handing the dispatcher a
 * service repository would also hand a background loop everything else on it. This can
 * answer one question and take no action.
 *
 * Only the kinds with `CUSTOMER_NOTIFICATION_PRECONDITIONS[kind] === true` are ever
 * asked. A kind marked `false` is a terminal fact and asking would be a read that can
 * only agree.
 */
export interface NotificationSubjectReader {
  stillHolds(
    scope: TenantContext,
    kind: CustomerNotificationKind,
    subjectId: string,
  ): Promise<boolean>;
}

/** How long a claimed row is held before another pass may take it. */
export const NOTIFICATION_LEASE_MS =
  CUSTOMER_NOTIFICATION_BACKOFF_MS * CUSTOMER_NOTIFICATION_MAX_ATTEMPTS;

/** What one pass did. Counted rather than returned, so nothing downstream re-sends. */
export interface NotificationSweepReport {
  readonly claimed: number;
  readonly delivered: number;
  /** Refused, attempts not yet spent. Still queued. */
  readonly pending: number;
  /** Refused for the last time. Needs a person. */
  readonly failed: number;
  /** Telegram may have it. Never retried automatically. */
  readonly unconfirmed: number;
  /** The precondition said the fact had stopped being true. Nothing was sent. */
  readonly superseded: number;
  /** Telegram asked us to slow down. No attempt spent, back on the queue. */
  readonly rateLimited: number;
  /** Claimed, then found to belong to a customer with no reachable chat. */
  readonly unreachable: number;
  /** The send threw. The lease stands and the row comes back later. */
  readonly errored: number;
  /**
   * Sent, and the outcome could not be recorded because the row had moved.
   *
   * Its own count rather than part of `delivered`, because the two are different facts
   * and only this one can produce a second message to the same customer.
   */
  readonly lost: number;
}

export interface CustomerNotificationDeps {
  readonly notifications: CustomerNotificationRepository;
  readonly contacts: {
    contactFor(
      scope: TenantContext,
      customerId: CustomerNotificationRecord['customerId'],
      tx?: unknown,
    ): Promise<
      | { readonly kind: 'CONTACT'; readonly contact: { readonly chatId: string } }
      | { readonly kind: 'BLOCKED' }
      | { readonly kind: 'NONE' }
    >;
  };
  readonly subjects: NotificationSubjectReader;
  readonly messenger: CustomerMessenger;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly clock: Clock;
  readonly scopeIsActive: (scope: TenantContext) => Promise<boolean>;
  readonly logger: {
    info: (context: Record<string, unknown>, message: string) => void;
    error: (context: Record<string, unknown>, message: string) => void;
  };
}

/**
 * The dispatcher: claims what is due, sends it, records what happened.
 *
 * NOTHING here holds a transaction while it sends. The three durable writes — the
 * stamp, the outcome, the rate-limit hold — are each their own `uow.run`, and the send
 * sits between them. That is the repository's non-negotiable "no network call inside a
 * database transaction" seen from the side that would be tempted to break it.
 *
 * The executor still cannot call a messenger. Producers enqueue a row inside the
 * transaction that produced their fact and never touch this class, which keeps
 * `ProvisionerLoop`'s structural guarantee — a failed Telegram send cannot reach a
 * business transaction — true for every kind rather than only for the subscription link.
 */
export class CustomerNotificationService {
  constructor(private readonly deps: CustomerNotificationDeps) {}

  /**
   * One pass.
   *
   * A stopped tenant is a healthy pass that did nothing, NOT a throw. That distinction
   * is not cosmetic: 4G shipped the opposite for a week of branch life and the
   * self-review caught it — a loop that records no progress for a pass that threw makes
   * the worker unhealthy in three minutes, and `botctl update` then rolls the release
   * back AFTER its migration has run, naming the release rather than the operator's own
   * stop.
   */
  async deliverDue(scope: TenantContext, limit: number): Promise<NotificationSweepReport> {
    const empty: NotificationSweepReport = {
      claimed: 0,
      delivered: 0,
      pending: 0,
      failed: 0,
      unconfirmed: 0,
      superseded: 0,
      rateLimited: 0,
      unreachable: 0,
      errored: 0,
      lost: 0,
    };
    if (!(await this.deps.scopeIsActive(scope))) return empty;

    const now = this.deps.clock.now();

    /*
     * Stranded sends first, and in their own transaction.
     *
     * A row stamped by a process that died is not due — `claimDue` excludes it — so
     * without this it would sit `PENDING` behind a lease for ever. Resolving it to
     * `UNCONFIRMED` before claiming is what keeps the lane from silently shrinking.
     */
    await this.deps.uow.run(scope, async (tx) =>
      this.deps.notifications.reapStranded(scope, now, limit, tx),
    );

    const leaseUntil = new Date(now.getTime() + NOTIFICATION_LEASE_MS);
    const claimed = await this.deps.notifications.claimDue(scope, now, leaseUntil, limit);

    const report = { ...empty, claimed: claimed.length };
    const counts: Record<string, number> = {};
    for (const row of claimed) {
      const outcome = await this.deliverOne(scope, row);
      counts[outcome] = (counts[outcome] ?? 0) + 1;
    }
    return {
      ...report,
      delivered: counts.delivered ?? 0,
      pending: counts.pending ?? 0,
      failed: counts.failed ?? 0,
      unconfirmed: counts.unconfirmed ?? 0,
      superseded: counts.superseded ?? 0,
      rateLimited: counts.rateLimited ?? 0,
      unreachable: counts.unreachable ?? 0,
      errored: counts.errored ?? 0,
      lost: counts.lost ?? 0,
    };
  }

  private async deliverOne(scope: TenantContext, row: CustomerNotificationRecord): Promise<string> {
    try {
      /*
       * The precondition, re-checked AFTER the claim and before the send.
       *
       * ADR 0030 §3: staleness is per-kind, not a TTL column. Five of the six kinds are
       * terminal facts and are never asked; the sixth — "your service is taking longer
       * than expected" — is false the moment the service is ACTIVE, and arriving a
       * second after the subscription link would be worse than not arriving.
       *
       * `SUPERSEDED` rather than `DELIVERED` or `FAILED`, because it is neither: nothing
       * was sent and nothing went wrong.
       */
      if (CUSTOMER_NOTIFICATION_PRECONDITIONS[row.kind]) {
        const holds = await this.deps.subjects.stillHolds(scope, row.kind, row.subjectId);
        if (!holds) {
          const at = this.deps.clock.now();
          await this.deps.uow.run(scope, async (tx) =>
            this.deps.notifications.record(
              scope,
              row.id,
              'SUPERSEDED',
              { resolvedAt: at, nextAttemptAt: null },
              at,
              tx,
            ),
          );
          return 'superseded';
        }
      }

      const lookup = await this.deps.contacts.contactFor(scope, row.customerId);
      if (lookup.kind !== 'CONTACT') {
        /*
         * No reachable chat. Terminal, and it spends the row rather than looping.
         *
         * `BLOCKED` cannot normally reach here — `claimDue` excludes a blocked customer
         * at the query — so this is the race where a block committed between the claim
         * and now. Either way there is nobody to send to and re-claiming the row on
         * every tick would crowd out messages that could be delivered.
         */
        const at = this.deps.clock.now();
        await this.deps.uow.run(scope, async (tx) =>
          this.deps.notifications.record(
            scope,
            row.id,
            'FAILED',
            { resolvedAt: at, nextAttemptAt: null },
            at,
            tx,
          ),
        );
        return 'unreachable';
      }

      /*
       * The stamp, committed BEFORE the send and in a transaction holding nothing else.
       *
       * A crash must not roll it back: the crash is the case it records. `false` means
       * another pass moved the row first, and this caller must send nothing.
       */
      const started = await this.deps.uow.run(scope, async (tx) =>
        this.deps.notifications.markSendStarted(scope, row.id, this.deps.clock.now(), tx),
      );
      if (!started) return 'lost';

      const result = await this.deps.messenger.send(scope, {
        chatId: lookup.contact.chatId,
        botInstanceId: row.botInstanceId,
        templateKey: CUSTOMER_NOTIFICATION_TEMPLATES[row.kind],
        values: {},
      });

      const at = this.deps.clock.now();

      /*
       * A rate limit: back on the queue, at Telegram's own time, with NO attempt spent.
       *
       * ADR 0030 §2. The attempt ceiling bounds definite refusals OF THIS MESSAGE, and
       * three bursts would otherwise fail a message Telegram never rejected on its
       * merits — in exactly the conditions that produce bursts.
       */
      if (result.outcome === 'RATE_LIMITED') {
        const retryAt = new Date(
          at.getTime() + (result.retryAfterMs ?? CUSTOMER_NOTIFICATION_BACKOFF_MS),
        );
        await this.deps.uow.run(scope, async (tx) =>
          this.deps.notifications.rateLimited(scope, row.id, retryAt, at, tx),
        );
        return 'rateLimited';
      }

      const attemptsAfter = row.attempts + 1;
      const to =
        result.outcome === 'DELIVERED'
          ? 'DELIVERED'
          : result.outcome === 'UNKNOWN'
            ? 'UNCONFIRMED'
            : attemptsAfter >= CUSTOMER_NOTIFICATION_MAX_ATTEMPTS
              ? 'FAILED'
              : 'PENDING';

      const recorded = await this.deps.uow.run(scope, async (tx) =>
        this.deps.notifications.record(
          scope,
          row.id,
          to,
          {
            resolvedAt: to === 'PENDING' ? null : at,
            nextAttemptAt:
              to === 'PENDING' ? new Date(at.getTime() + CUSTOMER_NOTIFICATION_BACKOFF_MS) : null,
          },
          at,
          tx,
        ),
      );
      if (!recorded) return 'lost';

      return to === 'DELIVERED'
        ? 'delivered'
        : to === 'UNCONFIRMED'
          ? 'unconfirmed'
          : to === 'FAILED'
            ? 'failed'
            : 'pending';
    } catch (error: unknown) {
      /*
       * The lease stands and the row comes back later.
       *
       * Deliberately NOT recorded as an attempt: nothing was observed about the message.
       * One bad row must not take the pass down either, which is why this is per-row.
       */
      this.deps.logger.error(
        { err: error, notificationId: row.id, kind: row.kind },
        'customer notification send failed',
      );
      return 'errored';
    }
  }
}
