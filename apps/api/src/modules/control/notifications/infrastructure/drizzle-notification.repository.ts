import { and, asc, desc, eq, gte, lt, lte, inArray, ne, sql } from 'drizzle-orm';
import type {
  DeliveryOutcome,
  IdGenerator,
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
  // REDACT, then truncate. The other order cut a bot token in half at offset
  // 2000, which took the surviving fragment below the pattern's length
  // threshold — so the slice defeated the redaction and stored the first half
  // of a credential.
  return message === null ? null : redactSecretText(message).slice(0, 2000);
}

function executorOf(db: Database, tx?: unknown): Executor {
  return (tx as TransactionScope | undefined)?.tx ?? db;
}

export class DrizzleNotificationRepository implements NotificationRepository {
  constructor(
    private readonly db: Database,
    private readonly ids: IdGenerator,
  ) {}

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
   * Cross-tenant by necessity and by design, on exactly `claimDue`'s argument:
   * this is installation housekeeping with no actor to authorize and no one
   * tenant to scope to. It is reachable only from the worker process — the
   * boundary check names both the dispatcher and this method, so a controller
   * that reached for either fails the build.
   *
   * It exists because two correct rules leave a gap between them. `claimDue`
   * refuses a row that has spent its attempts, or it would be claimed for ever;
   * `recordAttempt` is what normally moves such a row to FAILED, and that is
   * exactly the code that does not run when a dispatch throws before it. In
   * between, a row could sit PENDING for ever: never claimed, never failed, and
   * never appearing in any list of things that went wrong. Silence is the one
   * outcome this subsystem may not produce.
   *
   * `next_attempt_at <= now - leaseMs` is the safety margin, and the margin is
   * the whole correctness argument. `<= now` alone is only proof the lease
   * EXPIRED, which is the state a slow send is in — a five-second lease and an
   * eight-second Telegram call put a live, about-to-succeed send squarely in
   * range, so the sweep would have marked a delivered message permanently
   * failed. A full extra lease of quiet is not a proof either, but it means the
   * sender has been gone for longer than the window the system already treats
   * as "long enough to assume it died", and a late success can still correct
   * the record (`recordAttempt` lets a SUCCEEDED outcome move a FAILED row).
   *
   * One statement, not a select and then an update. The two-statement version
   * re-checked less on the write than it had selected on the read, so anything
   * changing `attempt_count` or `next_attempt_at` in between was invisible to
   * it — and its `LIMIT` had no `ORDER BY`, so which rows a bounded sweep took
   * was arbitrary.
   *
   * A synthetic attempt row is written for each. Without it the intent ends
   * FAILED with a gap where the deciding attempt should be, and the verdict is
   * invented somewhere the history does not show — which is the same "a state
   * nothing recorded" failure this module exists to make hard.
   */
  async failExhausted(
    now: Date,
    limit: number,
    options: { readonly leaseMs: number; readonly transport: NotificationTransportKind },
  ): Promise<number> {
    const deadline = new Date(now.getTime() - options.leaseMs);

    return this.db.transaction(async (tx) => {
      const swept = await tx
        .update(notifications)
        .set({ status: 'FAILED', completedAt: now, nextAttemptAt: now })
        .where(
          inArray(
            notifications.id,
            tx
              .select({ id: notifications.id })
              .from(notifications)
              .where(
                and(
                  eq(notifications.status, 'PENDING'),
                  lte(notifications.nextAttemptAt, deadline),
                  gte(notifications.attemptCount, notifications.maxAttempts),
                ),
              )
              .orderBy(asc(notifications.nextAttemptAt))
              .limit(limit)
              .for('update', { skipLocked: true }),
          ),
        )
        .returning({
          id: notifications.id,
          tenantId: notifications.tenantId,
          attemptCount: notifications.attemptCount,
        });

      if (swept.length === 0) return 0;

      // `onConflictDoNothing`, because the alternative failure is catastrophic
      // and the insurance is one clause.
      //
      // `(tenant_id, notification_id, attempt_number)` is unique. I could not
      // construct a state where a row already exists at the swept intent's
      // current attempt number — every path that writes one also moves the
      // intent out of PENDING, which is what this sweep selects on. But if one
      // ever did, the violation would abort this transaction, `tick()` would
      // throw before claiming anything, and the installation would stop
      // delivering notifications entirely, for every tenant, on every tick,
      // until somebody deleted a row by hand. A sweep whose job is to stop
      // silence must not be able to cause it.
      await tx
        .insert(notificationDeliveryAttempts)
        .values(
          swept.map((row) => ({
            id: this.ids.uuid(),
            tenantId: row.tenantId,
            notificationId: row.id,
            // The attempt this row accounts for is the one whose outcome was
            // never written down: the claim incremented the counter and nothing
            // recorded what happened next.
            attemptNumber: row.attemptCount,
            transport: options.transport,
            outcome: 'FAILED_PERMANENT' as const,
            startedAt: now,
            finishedAt: now,
            errorCode: 'notification.attempts_exhausted',
            errorMessage:
              'The last attempt was claimed and its outcome was never recorded; ' +
              'the lease expired with no attempts left.',
            retryAfterMs: null,
          })),
        )
        .onConflictDoNothing();

      return swept.length;
    });
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
        // Through a redactor, but NOT the same one as the audit log and the
        // operational log — and this comment said it was, which was the second
        // half of the same mistake as the function it calls.
        //
        // Those two carry structured records and are redacted by KEY. This
        // column carries a sentence from a third party, so the rule has to be
        // about CONTENT. Two rules, two coverage sets, one sink each.
        errorMessage: redactErrorMessage(input.errorMessage),
        retryAfterMs: input.retryAfterMs,
      });

      // Which rows this outcome is allowed to move.
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
      // SUCCESS is the exception, deliberately, and it is a WIDER predicate
      // rather than merely a looser one.
      //
      // Delivery is terminal truth whoever observed it. A late success ends the
      // intent, which stops the next attempt sending the same message again;
      // and it may end an intent `failExhausted` has already written off, which
      // is the correction that makes the sweep's safety margin an acceptable
      // guess rather than a verdict. The only status it may not overwrite is
      // SENT, which already says the same thing.
      //
      // Everything else requires OWNERSHIP of the claim. `attempt_count` is the
      // claim's identity: it is incremented by the claim and names the attempt
      // in flight, so a writer whose send outlived its lease finds it changed
      // and its update matches nothing.
      const predicate =
        input.outcome === 'SUCCEEDED'
          ? [ne(notifications.status, 'SENT')]
          : [
              eq(notifications.status, 'PENDING'),
              eq(notifications.attemptCount, input.attemptNumber),
            ];

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
            ...predicate,
          ),
        )
        .returning({ id: notifications.id });

      return { moved: moved.length > 0 };
    });
  }
}
