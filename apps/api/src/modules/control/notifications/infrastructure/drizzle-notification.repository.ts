import { and, asc, desc, eq, gte, lt, lte, inArray, sql } from 'drizzle-orm';
import type {
  DeliveryOutcome,
  NotificationDestination,
  NotificationKind,
  NotificationStatus,
  NotificationTransportKind,
  ScopeContext,
  TemplateKey,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  notificationDeliveryAttempts,
  notifications,
} from '../../../../infrastructure/persistence/schema.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import { redactSecretText } from '../../../../infrastructure/redaction.js';
import type {
  DeliveryAttemptRecord,
  NotificationIntent,
  NotificationRepository,
} from '../application/ports.js';

type Row = typeof notifications.$inferSelect;
type AttemptRow = typeof notificationDeliveryAttempts.$inferSelect;

function toIntent(row: Row): NotificationIntent {
  return {
    id: row.id,
    tenantId: row.tenantId,
    kind: row.kind as NotificationKind,
    dedupeKey: row.dedupeKey,
    // Cast here, VALIDATED at the point of use.
    //
    // Parsing in this mapper was the obvious move and was worse than the cast
    // it replaced. `claimDue` maps inside its own transaction, so one row whose
    // destination did not parse threw out of the transaction, rolled the claim
    // back, and left that row first in the queue — every subsequent tick
    // selected it, threw, and rolled back. The whole installation's dispatcher
    // would have stopped delivering, for every tenant, permanently, with no
    // attempt row and nothing visible in the admin UI. It also made one bad row
    // able to 500 `list()` for the tenant, so an operator could not even see
    // the queue that had stopped.
    //
    // The dispatcher validates a destination per intent, inside the per-intent
    // error handling that already exists, so a bad one fails that notification
    // and nothing else.
    destination: row.destination as NotificationDestination,
    payload: row.payload as Record<string, unknown>,
    templateKey: row.templateKey as TemplateKey,
    status: row.status as NotificationStatus,
    attemptCount: row.attemptCount,
    maxAttempts: row.maxAttempts,
    correlationId: row.correlationId,
    createdAt: row.createdAt,
    lastAttemptAt: row.lastAttemptAt,
    nextAttemptAt: row.nextAttemptAt,
    completedAt: row.completedAt,
  };
}

function toAttempt(row: AttemptRow): DeliveryAttemptRecord {
  return {
    id: row.id,
    notificationId: row.notificationId,
    attemptNumber: row.attemptNumber,
    transport: row.transport as NotificationTransportKind,
    outcome: row.outcome as DeliveryOutcome,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    retryAfterMs: row.retryAfterMs,
  };
}

/**
 * A transport's error text, redacted and bounded.
 *
 * The first version wrapped the message in `{ message }` and passed it to
 * `redactRecord`, under a comment saying it therefore shared the one
 * implementation of the rules. It did not: `redactRecord` decides by KEY, the
 * key was `message`, `message` matches no sensitive fragment, and the value was
 * returned exactly as it arrived. The function truncated and nothing else,
 * while its own comment said it redacted.
 *
 * A sentence needs a rule about its CONTENT, which `redactSecretText` is — and
 * this is the one sink where that matters, because Telegram's API errors quote
 * the request URL and the bot token is a segment of it.
 */
function redactErrorMessage(message: string | null): string | null {
  return message === null ? null : redactSecretText(message.slice(0, 2000));
}

function executorOf(db: Database, tx?: unknown): Executor {
  return (tx as TransactionScope | undefined)?.tx ?? db;
}

export class DrizzleNotificationRepository implements NotificationRepository {
  constructor(private readonly db: Database) {}

  async create(
    scope: ScopeContext,
    input: {
      readonly id: string;
      readonly kind: NotificationKind;
      readonly dedupeKey: string;
      readonly destination: NotificationDestination;
      readonly payload: Record<string, unknown>;
      readonly templateKey: TemplateKey;
      readonly maxAttempts: number;
      readonly correlationId: string | null;
      readonly now: Date;
    },
    tx?: unknown,
  ): Promise<{ intent: NotificationIntent; created: boolean }> {
    const tenantId = requireTenantId(scope);
    const executor = executorOf(this.db, tx);

    const inserted = await executor
      .insert(notifications)
      .values({
        id: input.id,
        tenantId,
        kind: input.kind,
        dedupeKey: input.dedupeKey,
        destination: input.destination,
        payload: input.payload,
        templateKey: input.templateKey,
        status: 'PENDING',
        attemptCount: 0,
        maxAttempts: input.maxAttempts,
        correlationId: input.correlationId,
        createdAt: input.now,
        nextAttemptAt: input.now,
      })
      // The dedupe key is the intent's identity. A second report of the same
      // condition is not an error and must not become a second message.
      .onConflictDoNothing({ target: [notifications.tenantId, notifications.dedupeKey] })
      .returning();

    if (inserted[0]) return { intent: toIntent(inserted[0]), created: true };

    const [existing] = await executor
      .select()
      .from(notifications)
      .where(
        and(eq(notifications.tenantId, tenantId), eq(notifications.dedupeKey, input.dedupeKey)),
      )
      .limit(1);
    if (!existing) {
      throw new Error('notifications insert conflicted but the conflicting row is not visible.');
    }
    return { intent: toIntent(existing), created: false };
  }

  async findById(
    scope: ScopeContext,
    id: string,
    tx?: unknown,
  ): Promise<NotificationIntent | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await executorOf(this.db, tx)
      .select()
      .from(notifications)
      .where(and(eq(notifications.tenantId, tenantId), eq(notifications.id, id)))
      .limit(1);
    return row ? toIntent(row) : null;
  }

  async list(
    scope: ScopeContext,
    options: { limit: number; before?: Date; status?: NotificationStatus },
    tx?: unknown,
  ): Promise<NotificationIntent[]> {
    const tenantId = requireTenantId(scope);
    const filters = [eq(notifications.tenantId, tenantId)];
    if (options.before) filters.push(lt(notifications.createdAt, options.before));
    if (options.status) filters.push(eq(notifications.status, options.status));

    const rows = await executorOf(this.db, tx)
      .select()
      .from(notifications)
      .where(and(...filters))
      .orderBy(desc(notifications.createdAt))
      .limit(options.limit);
    return rows.map(toIntent);
  }

  async attempts(
    scope: ScopeContext,
    notificationId: string,
    tx?: unknown,
  ): Promise<DeliveryAttemptRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await executorOf(this.db, tx)
      .select()
      .from(notificationDeliveryAttempts)
      .where(
        and(
          eq(notificationDeliveryAttempts.tenantId, tenantId),
          eq(notificationDeliveryAttempts.notificationId, notificationId),
        ),
      )
      .orderBy(asc(notificationDeliveryAttempts.attemptNumber));
    return rows.map(toAttempt);
  }

  /**
   * Claims due intents for the dispatcher.
   *
   * Cross-tenant by necessity and by design: this is installation housekeeping,
   * the same family as `RetentionSweeper`, with no actor to authorize and no one
   * tenant to scope to. It is reachable only from the worker process — a
   * boundary check asserts no surface imports the dispatcher.
   *
   * The claim increments the attempt counter and pushes `next_attempt_at` out by
   * a lease BEFORE the send. If the process dies with the socket open, the row
   * becomes due again when the lease expires instead of being held by a
   * dispatcher that no longer exists, and the attempt counter already reflects
   * the try that vanished.
   */
  async claimDue(now: Date, limit: number, leaseMs: number): Promise<NotificationIntent[]> {
    return this.db.transaction(async (tx) => {
      const due = await tx
        .select({ id: notifications.id })
        .from(notifications)
        .where(
          and(
            eq(notifications.status, 'PENDING'),
            lte(notifications.nextAttemptAt, now),
            // The backstop. Abandonment normally happens in `recordAttempt`,
            // which is exactly the code that does not run when a dispatch
            // throws before it — so an intent that has already spent its
            // attempts is refused here rather than being claimed forever.
            lt(notifications.attemptCount, notifications.maxAttempts),
          ),
        )
        .orderBy(asc(notifications.nextAttemptAt))
        .limit(limit)
        .for('update', { skipLocked: true });

      if (due.length === 0) return [];

      const claimed = await tx
        .update(notifications)
        .set({
          attemptCount: sql`${notifications.attemptCount} + 1`,
          lastAttemptAt: now,
          nextAttemptAt: new Date(now.getTime() + leaseMs),
        })
        .where(
          inArray(
            notifications.id,
            due.map((row) => row.id),
          ),
        )
        .returning();
      return claimed.map(toIntent);
    });
  }

  /**
   * Fails intents that have spent every attempt and are still PENDING.
   *
   * `claimDue` refuses such a row — it would otherwise be claimed forever — and
   * `recordAttempt` is the code that normally moves it to FAILED, which is
   * exactly the code that did not run when a dispatch threw before it. Between
   * the two, a row could sit PENDING with `attempt_count = max_attempts` and
   * never be claimed, never be failed, and never appear in any list of things
   * that went wrong. Silence is the one outcome this subsystem may not produce.
   *
   * `next_attempt_at <= now` is the lease check. A row a dispatcher is holding
   * right now has its lease in the future, so this cannot steal a send that is
   * still in flight and report it as failed.
   */
  async failExhausted(now: Date, limit: number): Promise<number> {
    const exhausted = await this.db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.status, 'PENDING'),
          lte(notifications.nextAttemptAt, now),
          gte(notifications.attemptCount, notifications.maxAttempts),
        ),
      )
      .limit(limit);
    if (exhausted.length === 0) return 0;

    const failed = await this.db
      .update(notifications)
      .set({ status: 'FAILED', completedAt: now, nextAttemptAt: now })
      .where(
        and(
          eq(notifications.status, 'PENDING'),
          inArray(
            notifications.id,
            exhausted.map((row) => row.id),
          ),
        ),
      )
      .returning({ id: notifications.id });
    return failed.length;
  }

  async recordAttempt(input: {
    readonly attemptId: string;
    readonly tenantId: string;
    readonly notificationId: string;
    readonly attemptNumber: number;
    readonly transport: NotificationTransportKind;
    readonly outcome: DeliveryOutcome;
    readonly startedAt: Date;
    readonly finishedAt: Date;
    readonly errorCode: string | null;
    readonly errorMessage: string | null;
    readonly retryAfterMs: number | null;
    readonly nextStatus: NotificationStatus;
    readonly nextAttemptAt: Date;
  }): Promise<{ readonly moved: boolean }> {
    return this.db.transaction(async (tx) => {
      await tx.insert(notificationDeliveryAttempts).values({
        id: input.attemptId,
        tenantId: input.tenantId,
        notificationId: input.notificationId,
        attemptNumber: input.attemptNumber,
        transport: input.transport,
        outcome: input.outcome,
        startedAt: input.startedAt,
        finishedAt: input.finishedAt,
        errorCode: input.errorCode,
        // Through the one redactor, like the audit log and the operational log.
        // This table is a fourth sink for third-party text, it is append-only —
        // so an accidental secret could never be removed — and it is returned
        // over HTTP. The rule is stated as universal; this path was outside it.
        errorMessage: redactErrorMessage(input.errorMessage),
        retryAfterMs: input.retryAfterMs,
      });

      // Only a PENDING intent moves, and — except on success — only at the
      // hands of the attempt that currently owns the claim.
      //
      // A dispatcher whose send outlives its lease is not impossible: the lease
      // exists precisely so a stalled sender's work becomes available again.
      // PENDING alone was not enough to make that safe. Attempt 1 could return
      // RETRYABLE after attempt 2 had claimed the row, replace attempt 2's
      // lease with a short back-off, and let attempt 3 start alongside it —
      // after which attempt 3 could mark the intent FAILED while attempt 2's
      // send was actually succeeding, and attempt 2's own update would then be
      // the one rejected. A delivered message, recorded as permanently failed,
      // by two writers each behaving correctly on its own.
      //
      // `attempt_count` is the claim's identity: it is incremented by the claim
      // and names the attempt in flight. Matching it means a stale writer's
      // status update is a no-op.
      //
      // SUCCESS is the exception, deliberately. Delivery is terminal truth
      // whoever observed it, and letting a late success end the intent stops
      // the NEXT attempt sending the same message again. It costs nothing: an
      // intent that has been delivered has nothing left to do.
      const ownership =
        input.outcome === 'SUCCEEDED'
          ? undefined
          : eq(notifications.attemptCount, input.attemptNumber);

      // The attempt row above is written either way, because it happened.
      const moved = await tx
        .update(notifications)
        .set({
          status: input.nextStatus,
          nextAttemptAt: input.nextAttemptAt,
          // The CHECK constraint insists a terminal status carries a completion
          // time and a pending one does not, so the two can never disagree.
          completedAt: input.nextStatus === 'PENDING' ? null : input.finishedAt,
        })
        .where(
          and(
            eq(notifications.tenantId, input.tenantId),
            eq(notifications.id, input.notificationId),
            eq(notifications.status, 'PENDING'),
            ...(ownership ? [ownership] : []),
          ),
        )
        .returning({ id: notifications.id });

      return { moved: moved.length > 0 };
    });
  }
}
