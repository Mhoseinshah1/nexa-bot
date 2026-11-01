import { and, asc, desc, eq, gte, isNull, lte, or, sql } from 'drizzle-orm';
import {
  type BusinessHandoffKind,
  type BusinessHandoffReason,
  type ScopeContext,
  type SupportAiActionKind,
  type SupportAiAutoOutcome,
  type SupportAiDecision,
  type SupportAiFailureClass,
  type SupportAiProvider,
  type SupportAiTicketHoldState,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  supportAiTicketHolds,
  supportAiTicketJobs,
  ticketMessages,
  tickets,
} from '../../../../infrastructure/persistence/schema.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';

/**
 * Phase 4 PR-4 — the support AI's storage for TICKETS. Every query carries the tenant, and every
 * query names a ticket (or the tenant's queue); none reads or writes a `business_*` table. That
 * is the isolation: a ticket job has no conversation to send into, and the Business repositories
 * never see these tables.
 */

export interface SupportAiTicketJobRecord {
  readonly id: string;
  readonly ticketId: string;
  readonly triggerMessageId: string;
  readonly epoch: number;
  readonly attempts: number;
  readonly dueAt: Date;
  readonly createdAt: Date;
}

export interface SupportAiTicketHoldRecord {
  readonly ticketId: string;
  readonly state: SupportAiTicketHoldState;
  readonly epoch: number;
  readonly handoffKind: BusinessHandoffKind | null;
  readonly handoffReason: BusinessHandoffReason | null;
  readonly heldAt: Date;
}

/** The ticket as the AI reads it: who it belongs to, and whether it still takes answers. */
export interface SupportAiTicketFacts {
  readonly id: string;
  readonly customerId: string;
  readonly botInstanceId: string;
  readonly status: string;
  readonly origin: string;
  readonly number: bigint;
}

/** One message of a ticket's transcript, oldest first. */
export interface SupportAiTicketLine {
  readonly id: string;
  readonly senderType: 'CUSTOMER' | 'ADMIN' | 'SYSTEM' | 'AI';
  readonly body: string | null;
  readonly hasAttachment: boolean;
  readonly createdAt: Date;
}

/** What a finished job records. */
export interface SupportAiTicketJobResult {
  readonly outcome: SupportAiAutoOutcome;
  readonly decision?: SupportAiDecision | null;
  readonly provider?: SupportAiProvider | null;
  readonly model?: string | null;
  readonly handoffReason?: BusinessHandoffReason | null;
  readonly failureClass?: SupportAiFailureClass | null;
  readonly toolAction?: Exclude<SupportAiActionKind, 'NONE'> | null;
  readonly replyMessageId?: string | null;
  readonly now: Date;
}

type JobRow = typeof supportAiTicketJobs.$inferSelect;

function toJob(row: JobRow): SupportAiTicketJobRecord {
  return {
    id: row.id,
    ticketId: row.ticketId,
    triggerMessageId: row.triggerMessageId,
    epoch: row.epoch,
    attempts: row.attempts,
    dueAt: row.dueAt,
    createdAt: row.createdAt,
  };
}

export class DrizzleSupportAiTicketRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  /** The ticket, optionally under its row lock (the same lock a person's reply takes). */
  async ticket(
    scope: ScopeContext,
    ticketId: string,
    tx?: unknown,
    lock = false,
  ): Promise<SupportAiTicketFacts | null> {
    const tenantId = requireTenantId(scope);
    const query = this.exec(tx)
      .select({
        id: tickets.id,
        customerId: tickets.customerId,
        botInstanceId: tickets.botInstanceId,
        status: tickets.status,
        origin: tickets.origin,
        number: tickets.number,
      })
      .from(tickets)
      .where(and(eq(tickets.tenantId, tenantId), eq(tickets.id, ticketId)))
      .limit(1);
    const [row] = await (lock ? query.for('update') : query);
    return row ?? null;
  }

  async hold(
    scope: ScopeContext,
    ticketId: string,
    tx?: unknown,
  ): Promise<SupportAiTicketHoldRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.exec(tx)
      .select()
      .from(supportAiTicketHolds)
      .where(
        and(
          eq(supportAiTicketHolds.tenantId, tenantId),
          eq(supportAiTicketHolds.ticketId, ticketId),
        ),
      );
    return row === undefined
      ? null
      : {
          ticketId: row.ticketId,
          state: row.state as SupportAiTicketHoldState,
          epoch: row.epoch,
          handoffKind: row.handoffKind as BusinessHandoffKind | null,
          handoffReason: row.handoffReason as BusinessHandoffReason | null,
          heldAt: row.heldAt,
        };
  }

  async writeHold(
    scope: ScopeContext,
    hold: Omit<SupportAiTicketHoldRecord, 'ticketId'> & { readonly ticketId: string },
    now: Date,
    tx: unknown,
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    await this.exec(tx)
      .insert(supportAiTicketHolds)
      .values({
        tenantId,
        ticketId: hold.ticketId,
        state: hold.state,
        epoch: hold.epoch,
        handoffKind: hold.handoffKind,
        handoffReason: hold.handoffReason,
        heldAt: hold.heldAt,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [supportAiTicketHolds.tenantId, supportAiTicketHolds.ticketId],
        set: {
          state: hold.state,
          epoch: hold.epoch,
          handoffKind: hold.handoffKind,
          handoffReason: hold.handoffReason,
          heldAt: hold.heldAt,
          updatedAt: now,
        },
      });
  }

  /**
   * What the gate and the final checks need: the newest message of the ticket, the last
   * administrator's reply, and the time of the message before the newest.
   */
  async activity(
    scope: ScopeContext,
    ticketId: string,
    tx?: unknown,
  ): Promise<{
    readonly newest: { readonly id: string; readonly senderType: string } | null;
    readonly lastAdminAt: Date | null;
    readonly previousMessageAt: Date | null;
  }> {
    const tenantId = requireTenantId(scope);
    const db = this.exec(tx);
    const recent = await db
      .select({
        id: ticketMessages.id,
        senderType: ticketMessages.senderType,
        createdAt: ticketMessages.createdAt,
      })
      .from(ticketMessages)
      .where(and(eq(ticketMessages.tenantId, tenantId), eq(ticketMessages.ticketId, ticketId)))
      .orderBy(desc(ticketMessages.seq))
      .limit(2);
    const [admin] = await db
      .select({ at: sql<Date | null>`max(${ticketMessages.createdAt})` })
      .from(ticketMessages)
      .where(
        and(
          eq(ticketMessages.tenantId, tenantId),
          eq(ticketMessages.ticketId, ticketId),
          eq(ticketMessages.senderType, 'ADMIN'),
        ),
      );
    const newest = recent[0];
    return {
      newest: newest === undefined ? null : { id: newest.id, senderType: newest.senderType },
      lastAdminAt: admin?.at == null ? null : new Date(admin.at),
      previousMessageAt: recent[1]?.createdAt ?? null,
    };
  }

  /** The ticket's messages, oldest first, at most `limit` of the newest. */
  async transcript(
    scope: ScopeContext,
    ticketId: string,
    limit: number,
    tx?: unknown,
  ): Promise<readonly SupportAiTicketLine[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select({
        id: ticketMessages.id,
        senderType: ticketMessages.senderType,
        body: ticketMessages.body,
        attachmentKind: ticketMessages.attachmentKind,
        createdAt: ticketMessages.createdAt,
      })
      .from(ticketMessages)
      .where(and(eq(ticketMessages.tenantId, tenantId), eq(ticketMessages.ticketId, ticketId)))
      .orderBy(desc(ticketMessages.seq))
      .limit(limit);
    return rows.reverse().map((row) => ({
      id: row.id,
      senderType: row.senderType as SupportAiTicketLine['senderType'],
      body: row.body,
      hasAttachment: row.attachmentKind !== null,
      createdAt: row.createdAt,
    }));
  }

  // --- jobs ------------------------------------------------------------------------------

  /** The ticket's pending job, if one waits (claimed or not). */
  async queued(
    scope: ScopeContext,
    ticketId: string,
    tx?: unknown,
  ): Promise<SupportAiTicketJobRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.exec(tx)
      .select()
      .from(supportAiTicketJobs)
      .where(
        and(
          eq(supportAiTicketJobs.tenantId, tenantId),
          eq(supportAiTicketJobs.ticketId, ticketId),
          eq(supportAiTicketJobs.state, 'QUEUED'),
        ),
      );
    return row === undefined ? null : toJob(row);
  }

  /** Inserts a job; false when this message already has one (a redelivery enqueues nothing). */
  async insert(
    scope: ScopeContext,
    job: {
      readonly id: string;
      readonly ticketId: string;
      readonly triggerMessageId: string;
      readonly epoch: number;
      readonly dueAt: Date;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .insert(supportAiTicketJobs)
      .values({
        id: job.id,
        tenantId,
        ticketId: job.ticketId,
        triggerMessageId: job.triggerMessageId,
        epoch: job.epoch,
        idempotencyKey: `ticket-ai:${job.ticketId}:${job.triggerMessageId}`,
        dueAt: job.dueAt,
        createdAt: job.now,
        updatedAt: job.now,
      })
      .onConflictDoNothing()
      .returning({ id: supportAiTicketJobs.id });
    return rows.length > 0;
  }

  async claimNext(
    scope: ScopeContext,
    now: Date,
    leaseUntil: Date,
    tx: unknown,
  ): Promise<SupportAiTicketJobRecord | null> {
    const tenantId = requireTenantId(scope);
    const db = this.exec(tx);
    const free = and(
      or(isNull(supportAiTicketJobs.claimedUntil), lte(supportAiTicketJobs.claimedUntil, now)),
      lte(supportAiTicketJobs.dueAt, now),
    );
    const next = db
      .select({ id: supportAiTicketJobs.id })
      .from(supportAiTicketJobs)
      .where(
        and(
          eq(supportAiTicketJobs.tenantId, tenantId),
          eq(supportAiTicketJobs.state, 'QUEUED'),
          free,
        ),
      )
      .orderBy(asc(supportAiTicketJobs.createdAt), asc(supportAiTicketJobs.id))
      .limit(1)
      .for('update', { skipLocked: true });
    const [row] = await db
      .update(supportAiTicketJobs)
      .set({
        claimedUntil: leaseUntil,
        attempts: sql`${supportAiTicketJobs.attempts} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(supportAiTicketJobs.tenantId, tenantId),
          // A scalar subquery, evaluated once: the same shape the Business claim uses.
          eq(supportAiTicketJobs.id, sql`(${next})`),
          eq(supportAiTicketJobs.state, 'QUEUED'),
          free,
        ),
      )
      .returning();
    return row === undefined ? null : toJob(row);
  }

  async releaseLease(
    scope: ScopeContext,
    id: string,
    retryAt: Date,
    now: Date,
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(supportAiTicketJobs)
      .set({ claimedUntil: retryAt, updatedAt: now })
      .where(
        and(
          eq(supportAiTicketJobs.tenantId, tenantId),
          eq(supportAiTicketJobs.id, id),
          eq(supportAiTicketJobs.state, 'QUEUED'),
        ),
      )
      .returning({ id: supportAiTicketJobs.id });
    return rows.length > 0;
  }

  /** The job's one transition out of QUEUED; false when it already left (replaced, finished). */
  async finish(
    scope: ScopeContext,
    id: string,
    result: SupportAiTicketJobResult,
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const decision = result.decision ?? null;
    const rows = await this.exec(tx)
      .update(supportAiTicketJobs)
      .set({
        state: 'DONE',
        outcome: result.outcome,
        decision: decision?.decision ?? null,
        topic: decision?.topic ?? null,
        confidence: decision?.confidence ?? null,
        provider: result.provider ?? null,
        model: result.model ?? null,
        handoffReason: result.handoffReason ?? null,
        failureClass: result.failureClass ?? null,
        toolAction: result.toolAction ?? null,
        replyMessageId: result.replyMessageId ?? null,
        updatedAt: result.now,
      })
      .where(
        and(
          eq(supportAiTicketJobs.tenantId, tenantId),
          eq(supportAiTicketJobs.id, id),
          eq(supportAiTicketJobs.state, 'QUEUED'),
        ),
      )
      .returning({ id: supportAiTicketJobs.id });
    return rows.length > 0;
  }

  // --- the epoch's counts: read by NEXA from its own rows, never from the model ---------

  /** This epoch's finished jobs, newest first. */
  async epochJobs(
    scope: ScopeContext,
    input: { readonly ticketId: string; readonly epoch: number },
    tx?: unknown,
  ): Promise<
    readonly {
      readonly outcome: string;
      readonly decision: string | null;
      readonly topic: string | null;
      readonly toolAction: string | null;
      readonly createdAt: Date;
    }[]
  > {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select({
        outcome: supportAiTicketJobs.outcome,
        decision: supportAiTicketJobs.decision,
        topic: supportAiTicketJobs.topic,
        toolAction: supportAiTicketJobs.toolAction,
        createdAt: supportAiTicketJobs.createdAt,
      })
      .from(supportAiTicketJobs)
      .where(
        and(
          eq(supportAiTicketJobs.tenantId, tenantId),
          eq(supportAiTicketJobs.ticketId, input.ticketId),
          eq(supportAiTicketJobs.epoch, input.epoch),
          eq(supportAiTicketJobs.state, 'DONE'),
        ),
      )
      .orderBy(desc(supportAiTicketJobs.createdAt), desc(supportAiTicketJobs.id));
    return rows.map((row) => ({ ...row, outcome: row.outcome ?? '' }));
  }

  /** The time of the trigger message of the epoch's first job: where the AI's part began. */
  async epochStartedAt(
    scope: ScopeContext,
    input: { readonly ticketId: string; readonly epoch: number },
    tx?: unknown,
  ): Promise<Date | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.exec(tx)
      .select({ at: sql<Date | null>`min(${ticketMessages.createdAt})` })
      .from(supportAiTicketJobs)
      .innerJoin(
        ticketMessages,
        and(
          eq(ticketMessages.tenantId, supportAiTicketJobs.tenantId),
          eq(ticketMessages.id, supportAiTicketJobs.triggerMessageId),
        ),
      )
      .where(
        and(
          eq(supportAiTicketJobs.tenantId, tenantId),
          eq(supportAiTicketJobs.ticketId, input.ticketId),
          eq(supportAiTicketJobs.epoch, input.epoch),
        ),
      );
    return row?.at == null ? null : new Date(row.at);
  }

  /** Automatic replies this ticket got since `since` (the loop guard's hourly window). */
  async repliesSince(
    scope: ScopeContext,
    ticketId: string,
    since: Date,
    tx?: unknown,
  ): Promise<number> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.exec(tx)
      .select({ n: sql<number>`count(*)::int` })
      .from(supportAiTicketJobs)
      .where(
        and(
          eq(supportAiTicketJobs.tenantId, tenantId),
          eq(supportAiTicketJobs.ticketId, ticketId),
          eq(supportAiTicketJobs.state, 'DONE'),
          sql`${supportAiTicketJobs.replyMessageId} IS NOT NULL`,
          gte(supportAiTicketJobs.updatedAt, since),
        ),
      );
    return row?.n ?? 0;
  }
}
