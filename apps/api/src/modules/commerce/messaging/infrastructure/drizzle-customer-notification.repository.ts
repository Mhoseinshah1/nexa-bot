import { and, asc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import type {
  BotInstanceId,
  CustomerNotificationKind,
  CustomerNotificationState,
  TenantContext,
  UserId,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import { customerNotifications, customers } from '../../../../infrastructure/persistence/schema.js';
import type {
  CustomerNotificationEnqueue,
  CustomerNotificationRecord,
  CustomerNotificationRepository,
} from '../application/ports.js';

type Row = typeof customerNotifications.$inferSelect;

function toRecord(row: Row): CustomerNotificationRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    customerId: row.customerId as UserId,
    botInstanceId: row.botInstanceId as BotInstanceId,
    kind: row.kind as CustomerNotificationKind,
    subjectId: row.subjectId,
    state: row.state as CustomerNotificationState,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt,
    sendStartedAt: row.sendStartedAt,
    resolvedAt: row.resolvedAt,
    createdAt: row.createdAt,
  };
}

/**
 * The lane's storage. Every write is a CONDITIONAL UPDATE naming the state it moves from.
 *
 * There is no `setState`, for the reason ADR 0028 gives about the recovery lane and that
 * applies unchanged here: that one mechanism is what makes a replay, a double-click and
 * two dispatcher replicas all safe, and a convenience setter would quietly remove it
 * from all three.
 */
export class DrizzleCustomerNotificationRepository implements CustomerNotificationRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  /**
   * Queues one, and answers whether this caller is the one that queued it.
   *
   * `ON CONFLICT DO NOTHING` against `customer_notifications_subject_key`. The returning
   * clause is what makes the answer truthful: a conflict returns no row, so `false`
   * means somebody already queued this exact fact. Told-once is the lane's contract and
   * this constraint is where it lives — not in a read-then-write in the service, which
   * two replicas would both pass.
   */
  async enqueue(
    scope: TenantContext,
    input: CustomerNotificationEnqueue,
    now: Date,
    tx: TransactionScope,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .insert(customerNotifications)
      .values({
        id: input.id,
        tenantId,
        customerId: input.customerId,
        botInstanceId: input.botInstanceId,
        kind: input.kind,
        subjectId: input.subjectId,
        state: 'PENDING',
        attempts: 0,
        nextAttemptAt: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: customerNotifications.id });
    return rows.length > 0;
  }

  /**
   * Claims the due rows for this pass, oldest first, and leases them.
   *
   * A sub-select of candidates and a conditional UPDATE re-checking the SAME predicates,
   * which is `ServiceRepository.claimDeliveryDue`'s shape and defeats two replicas
   * without `SKIP LOCKED`: the loser blocks on the row lock, re-evaluates
   * `next_attempt_at` after the winner committed, finds it in the future and updates
   * nothing.
   *
   * The lease is the only thing written. `attempts` is untouched here and advanced by
   * `record`, so an attempt always means an outcome somebody saw — a pass that died
   * holding a lease would otherwise spend one on a message never submitted.
   */
  async claimDue(
    scope: TenantContext,
    now: Date,
    leaseUntil: Date,
    limit: number,
    tx?: unknown,
  ): Promise<readonly CustomerNotificationRecord[]> {
    const tenantId = requireTenantId(scope);
    const ready = or(
      isNull(customerNotifications.nextAttemptAt),
      lte(customerNotifications.nextAttemptAt, now),
    );
    const due = this.exec(tx)
      .select({ id: customerNotifications.id })
      .from(customerNotifications)
      /*
       * Joined to the customer so a BLOCKED one is not due AT THE QUERY.
       *
       * The reasoning is `claimDeliveryDue`'s and it is worth repeating rather than
       * cross-referencing, because getting it wrong is silent: a row the pass picked up
       * and then declined would either burn an attempt against the ceiling — punishing
       * a customer for a moderation decision that may be reversed — or be skipped
       * without one, which returns the same row on every tick for ever and crowds out
       * notifications that could be delivered.
       */
      .innerJoin(
        customers,
        and(
          eq(customers.tenantId, customerNotifications.tenantId),
          eq(customers.id, customerNotifications.customerId),
        ),
      )
      .where(
        and(
          eq(customerNotifications.tenantId, tenantId),
          eq(customerNotifications.state, 'PENDING'),
          eq(customers.status, 'ACTIVE'),
          /*
           * A send nobody has accounted for is NOT due, whatever its lease says.
           *
           * `reapStranded` resolves such a row to `UNCONFIRMED`, and this predicate is
           * what stops the claim racing it: without it an expired lease makes a row
           * whose message may already have reached Telegram due again, which is the
           * duplicate the stamp exists to prevent.
           */
          isNull(customerNotifications.sendStartedAt),
          ready,
        ),
      )
      .orderBy(asc(customerNotifications.createdAt), asc(customerNotifications.id))
      .limit(limit);

    const rows = await this.exec(tx)
      .update(customerNotifications)
      .set({ nextAttemptAt: leaseUntil, updatedAt: now })
      .where(
        and(
          eq(customerNotifications.tenantId, tenantId),
          sql`${customerNotifications.id} IN ${due}`,
          eq(customerNotifications.state, 'PENDING'),
          isNull(customerNotifications.sendStartedAt),
          ready,
        ),
      )
      .returning();
    return rows.map(toRecord);
  }

  /** Stamps the send as in flight. `false` means somebody else moved the row first. */
  async markSendStarted(
    scope: TenantContext,
    id: string,
    now: Date,
    tx: TransactionScope,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(customerNotifications)
      .set({ sendStartedAt: now, updatedAt: now })
      .where(
        and(
          eq(customerNotifications.tenantId, tenantId),
          eq(customerNotifications.id, id),
          eq(customerNotifications.state, 'PENDING'),
          isNull(customerNotifications.sendStartedAt),
        ),
      )
      .returning({ id: customerNotifications.id });
    return rows.length > 0;
  }

  /**
   * Records an observed outcome and spends one attempt.
   *
   * Moves only from `PENDING`, which is what makes a replay and a second replica safe:
   * whichever records first wins, and the other updates nothing. `send_started_at` is
   * cleared by the SAME statement, so the two can never disagree — a row with a stamp is
   * a send nobody has accounted for, and that is the only thing `reapStranded` may act
   * on.
   */
  async record(
    scope: TenantContext,
    id: string,
    to: CustomerNotificationState,
    stamps: { readonly resolvedAt: Date | null; readonly nextAttemptAt: Date | null },
    now: Date,
    tx: TransactionScope,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(customerNotifications)
      .set({
        state: to,
        attempts: sql`${customerNotifications.attempts} + 1`,
        resolvedAt: stamps.resolvedAt,
        nextAttemptAt: stamps.nextAttemptAt,
        sendStartedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(customerNotifications.tenantId, tenantId),
          eq(customerNotifications.id, id),
          eq(customerNotifications.state, 'PENDING'),
        ),
      )
      .returning({ id: customerNotifications.id });
    return rows.length > 0;
  }

  /**
   * Puts a claimed row back on the queue at `retryAt`: still `PENDING`, NO attempt spent.
   *
   * The whole method exists so that the attempt counter cannot move here. ADR 0030 §2
   * and audit §6b carry the argument for the rate-limit case; the consequence of the
   * alternative is that three bursts fail a message Telegram never rejected on its
   * merits, in exactly the conditions that produce bursts.
   *
   * `send_started_at` is cleared, because the send definitely did not happen. That is
   * the one place this differs from every other unresolved outcome, and it is why the
   * row becomes claimable again rather than waiting for `reapStranded`.
   *
   * Named for what it DOES rather than for the first caller that needed it. The Codex
   * review of PR #30 found the second: a customer blocked between the claim and the
   * contact lookup was recorded terminally `FAILED`, while the very same customer
   * blocked one moment earlier was simply not claimed — `claimDue` excludes them at the
   * query, and its comment argues at length that burning an attempt would punish a
   * customer for a moderation decision that may be reversed. Two halves of one rule
   * disagreeing, decided by a race. Both now defer.
   */
  async deferUntil(
    scope: TenantContext,
    id: string,
    retryAt: Date,
    now: Date,
    tx: TransactionScope,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(customerNotifications)
      .set({ nextAttemptAt: retryAt, sendStartedAt: null, updatedAt: now })
      .where(
        and(
          eq(customerNotifications.tenantId, tenantId),
          eq(customerNotifications.id, id),
          eq(customerNotifications.state, 'PENDING'),
        ),
      )
      .returning({ id: customerNotifications.id });
    return rows.length > 0;
  }

  /**
   * Resolves stranded sends to `UNCONFIRMED`, spending no attempt.
   *
   * A stamped row whose lease has run out was held by a process that died somewhere
   * between the stamp and the outcome, so the message MAY have arrived — and the rule
   * this lane inherits is that an unknown send is never retried automatically. Without
   * this the row would sit `PENDING` behind nothing but a lease and the next pass would
   * tell the customer again, which an ordinary container restart is enough to cause.
   */
  async reapStranded(
    scope: TenantContext,
    now: Date,
    limit: number,
    tx: TransactionScope,
  ): Promise<number> {
    const tenantId = requireTenantId(scope);
    const stranded = this.exec(tx)
      .select({ id: customerNotifications.id })
      .from(customerNotifications)
      .where(
        and(
          eq(customerNotifications.tenantId, tenantId),
          eq(customerNotifications.state, 'PENDING'),
          sql`${customerNotifications.sendStartedAt} IS NOT NULL`,
          or(
            isNull(customerNotifications.nextAttemptAt),
            lte(customerNotifications.nextAttemptAt, now),
          ),
        ),
      )
      .limit(limit);

    const rows = await this.exec(tx)
      .update(customerNotifications)
      .set({
        state: 'UNCONFIRMED',
        resolvedAt: now,
        nextAttemptAt: null,
        sendStartedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(customerNotifications.tenantId, tenantId),
          sql`${customerNotifications.id} IN ${stranded}`,
          eq(customerNotifications.state, 'PENDING'),
          sql`${customerNotifications.sendStartedAt} IS NOT NULL`,
        ),
      )
      .returning({ id: customerNotifications.id });
    return rows.length;
  }
}
