import { and, asc, desc, eq, lt, lte, inArray, sql } from 'drizzle-orm';
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
        .where(and(eq(notifications.status, 'PENDING'), lte(notifications.nextAttemptAt, now)))
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
  }): Promise<void> {
    await this.db.transaction(async (tx) => {
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
        errorMessage: input.errorMessage?.slice(0, 2000) ?? null,
        retryAfterMs: input.retryAfterMs,
      });

      await tx
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
          ),
        );
    });
  }
}
