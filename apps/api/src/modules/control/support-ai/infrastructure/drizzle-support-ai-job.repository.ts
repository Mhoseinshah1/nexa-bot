import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';
import type {
  ScopeContext,
  SupportAiDecision,
  SupportAiJobKind,
  SupportAiJobState,
  SupportAiProvider,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import { supportAiJobs } from '../../../../infrastructure/persistence/schema.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';

type Row = typeof supportAiJobs.$inferSelect;

export interface SupportAiJobRecord {
  readonly id: string;
  readonly kind: SupportAiJobKind;
  readonly conversationId: string;
  readonly requestedByAdminId: string | null;
  readonly idempotencyKey: string;
  readonly state: SupportAiJobState;
  readonly attempts: number;
  readonly readyAt: Date | null;
  readonly failureCode: string | null;
  readonly decision: SupportAiDecision['decision'] | null;
  readonly topic: SupportAiDecision['topic'] | null;
  readonly confidence: SupportAiDecision['confidence'] | null;
  readonly ticketAction: SupportAiDecision['ticketAction'] | null;
  readonly summary: string | null;
  readonly intent: string | null;
  readonly suggestedReply: string | null;
  readonly factLabels: readonly string[];
  readonly provider: SupportAiProvider | null;
  readonly model: string | null;
  readonly sentOutboundId: string | null;
  readonly createdAt: Date;
}

function toRecord(row: Row): SupportAiJobRecord {
  return {
    id: row.id,
    kind: row.kind as SupportAiJobKind,
    conversationId: row.conversationId,
    requestedByAdminId: row.requestedByAdminId,
    idempotencyKey: row.idempotencyKey,
    state: row.state as SupportAiJobState,
    attempts: row.attempts,
    readyAt: row.readyAt,
    failureCode: row.failureCode,
    decision: row.decision as SupportAiJobRecord['decision'],
    topic: row.topic as SupportAiJobRecord['topic'],
    confidence: row.confidence as SupportAiJobRecord['confidence'],
    ticketAction: row.ticketAction as SupportAiJobRecord['ticketAction'],
    summary: row.summary,
    intent: row.intent,
    suggestedReply: row.suggestedReply,
    factLabels: row.factLabels ?? [],
    provider: row.provider as SupportAiProvider | null,
    model: row.model,
    sentOutboundId: row.sentOutboundId,
    createdAt: row.createdAt,
  };
}

function exec(db: Database, tx?: unknown): Executor {
  return (tx as TransactionScope | undefined)?.tx ?? db;
}

/**
 * TB5 — support-AI jobs and their drafts. Every transition is a conditional UPDATE naming the
 * state it leaves: a job the operator discarded while the `assistant` role was producing it is
 * never resurrected by the result arriving late.
 */
export class DrizzleSupportAiJobRepository {
  constructor(private readonly db: Database) {}

  async insert(
    scope: ScopeContext,
    row: {
      readonly id: string;
      readonly kind: SupportAiJobKind;
      readonly conversationId: string;
      readonly requestedByAdminId: string | null;
      readonly idempotencyKey: string;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<SupportAiJobRecord> {
    const tenantId = requireTenantId(scope);
    const [inserted] = await exec(this.db, tx)
      .insert(supportAiJobs)
      .values({
        id: row.id,
        tenantId,
        kind: row.kind,
        conversationId: row.conversationId,
        requestedByAdminId: row.requestedByAdminId,
        idempotencyKey: row.idempotencyKey,
        createdAt: row.now,
        updatedAt: row.now,
      })
      .returning();
    if (inserted === undefined) throw new Error('support_ai_jobs: insert returned nothing.');
    return toRecord(inserted);
  }

  async findById(scope: ScopeContext, id: string, tx?: unknown): Promise<SupportAiJobRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await exec(this.db, tx)
      .select()
      .from(supportAiJobs)
      .where(and(eq(supportAiJobs.tenantId, tenantId), eq(supportAiJobs.id, id)))
      .limit(1);
    return row ? toRecord(row) : null;
  }

  async findByIdempotencyKey(scope: ScopeContext, key: string, tx?: unknown): Promise<SupportAiJobRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await exec(this.db, tx)
      .select()
      .from(supportAiJobs)
      .where(and(eq(supportAiJobs.tenantId, tenantId), eq(supportAiJobs.idempotencyKey, key)))
      .limit(1);
    return row ? toRecord(row) : null;
  }

  async recentForConversation(scope: ScopeContext, conversationId: string, limit: number): Promise<readonly SupportAiJobRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.db
      .select()
      .from(supportAiJobs)
      .where(and(eq(supportAiJobs.tenantId, tenantId), eq(supportAiJobs.conversationId, conversationId)))
      .orderBy(desc(supportAiJobs.createdAt), desc(supportAiJobs.id))
      .limit(limit);
    return rows.map(toRecord);
  }

  /** Newer draft requested: every older QUEUED or READY draft of the conversation is discarded. */
  async discardOpen(scope: ScopeContext, conversationId: string, now: Date, tx: unknown): Promise<number> {
    const tenantId = requireTenantId(scope);
    const rows = await exec(this.db, tx)
      .update(supportAiJobs)
      .set({ state: 'DISCARDED', claimedUntil: null, updatedAt: now })
      .where(
        and(
          eq(supportAiJobs.tenantId, tenantId),
          eq(supportAiJobs.conversationId, conversationId),
          inArray(supportAiJobs.state, ['QUEUED', 'READY']),
        ),
      )
      .returning({ id: supportAiJobs.id });
    return rows.length;
  }

  /** Leases the due QUEUED jobs (unclaimed, or whose lease ran out), oldest first. */
  async claimDue(scope: ScopeContext, now: Date, leaseUntil: Date, limit: number): Promise<readonly SupportAiJobRecord[]> {
    const tenantId = requireTenantId(scope);
    const free = or(isNull(supportAiJobs.claimedUntil), lte(supportAiJobs.claimedUntil, now));
    const selected = await this.db
      .select({ id: supportAiJobs.id })
      .from(supportAiJobs)
      .where(and(eq(supportAiJobs.tenantId, tenantId), eq(supportAiJobs.state, 'QUEUED'), free))
      .orderBy(asc(supportAiJobs.createdAt), asc(supportAiJobs.id))
      .limit(limit);
    if (selected.length === 0) return [];
    const rows = await this.db
      .update(supportAiJobs)
      .set({ claimedUntil: leaseUntil, attempts: sql`${supportAiJobs.attempts} + 1`, updatedAt: now })
      .where(
        and(
          eq(supportAiJobs.tenantId, tenantId),
          inArray(
            supportAiJobs.id,
            selected.map((row) => row.id),
          ),
          eq(supportAiJobs.state, 'QUEUED'),
          free,
        ),
      )
      .returning();
    return rows.map(toRecord);
  }

  async markReady(
    scope: ScopeContext,
    id: string,
    result: {
      readonly decision: SupportAiDecision;
      readonly factLabels: readonly string[];
      readonly provider: SupportAiProvider;
      readonly model: string;
      readonly now: Date;
    },
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.db
      .update(supportAiJobs)
      .set({
        state: 'READY',
        readyAt: result.now,
        claimedUntil: null,
        decision: result.decision.decision,
        topic: result.decision.topic,
        confidence: result.decision.confidence,
        ticketAction: result.decision.ticketAction,
        summary: result.decision.summary,
        intent: result.decision.intent,
        suggestedReply: result.decision.replyText,
        factRefs: [...result.decision.factRefs],
        factLabels: [...result.factLabels],
        provider: result.provider,
        model: result.model.slice(0, 128),
        updatedAt: result.now,
      })
      .where(and(eq(supportAiJobs.tenantId, tenantId), eq(supportAiJobs.id, id), eq(supportAiJobs.state, 'QUEUED')))
      .returning({ id: supportAiJobs.id });
    return rows.length > 0;
  }

  async markFailed(scope: ScopeContext, id: string, failureCode: string, now: Date): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.db
      .update(supportAiJobs)
      .set({ state: 'FAILED', failureCode: failureCode.slice(0, 200), claimedUntil: null, updatedAt: now })
      .where(and(eq(supportAiJobs.tenantId, tenantId), eq(supportAiJobs.id, id), eq(supportAiJobs.state, 'QUEUED')))
      .returning({ id: supportAiJobs.id });
    return rows.length > 0;
  }

  async markSent(scope: ScopeContext, id: string, outboundId: string, now: Date, tx: unknown): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await exec(this.db, tx)
      .update(supportAiJobs)
      .set({ state: 'SENT', sentOutboundId: outboundId, updatedAt: now })
      .where(and(eq(supportAiJobs.tenantId, tenantId), eq(supportAiJobs.id, id), eq(supportAiJobs.state, 'READY')))
      .returning({ id: supportAiJobs.id });
    return rows.length > 0;
  }

  async discard(scope: ScopeContext, id: string, now: Date, tx: unknown): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await exec(this.db, tx)
      .update(supportAiJobs)
      .set({ state: 'DISCARDED', claimedUntil: null, updatedAt: now })
      .where(
        and(
          eq(supportAiJobs.tenantId, tenantId),
          eq(supportAiJobs.id, id),
          inArray(supportAiJobs.state, ['QUEUED', 'READY']),
        ),
      )
      .returning({ id: supportAiJobs.id });
    return rows.length > 0;
  }

  /** Purges the AI text of jobs older than `cutoff` (the transcript's retention). */
  async purgeText(scope: ScopeContext, cutoff: Date, now: Date, limit: number): Promise<number> {
    const tenantId = requireTenantId(scope);
    const due = this.db
      .select({ id: supportAiJobs.id })
      .from(supportAiJobs)
      .where(
        and(
          eq(supportAiJobs.tenantId, tenantId),
          lt(supportAiJobs.createdAt, cutoff),
          isNull(supportAiJobs.textPurgedAt),
          or(isNotNull(supportAiJobs.summary), isNotNull(supportAiJobs.suggestedReply)),
        ),
      )
      .limit(limit);
    const rows = await this.db
      .update(supportAiJobs)
      .set({ summary: null, intent: null, suggestedReply: null, factLabels: [], textPurgedAt: now, updatedAt: now })
      .where(and(eq(supportAiJobs.tenantId, tenantId), inArray(supportAiJobs.id, due)))
      .returning({ id: supportAiJobs.id });
    return rows.length;
  }
}
