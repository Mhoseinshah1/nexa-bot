import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';
import type {
  ScopeContext,
  SupportAiDecision,
  SupportAiImageOutcome,
  SupportAiImageSkipReason,
  SupportAiJobKind,
  SupportAiJobState,
  SupportAiProvider,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  supportAiImageOutcomes,
  supportAiJobs,
} from '../../../../infrastructure/persistence/schema.js';
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
  readonly requestHash: string | null;
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
  readonly imagesSeen: number;
  readonly imagesUnseen: number;
  readonly unseenImageHandoff: SupportAiImageSkipReason | null;
  readonly createdAt: Date;
}

/** TB6: one image's outcome in one draft's request. No byte, file id or URL. */
export interface SupportAiImageOutcomeRow {
  readonly messageId: string;
  readonly outcome: SupportAiImageOutcome;
  readonly reason: SupportAiImageSkipReason | null;
  readonly mediaType: string | null;
  readonly byteSize: number | null;
}

function toRecord(row: Row): SupportAiJobRecord {
  return {
    id: row.id,
    kind: row.kind as SupportAiJobKind,
    conversationId: row.conversationId,
    requestedByAdminId: row.requestedByAdminId,
    idempotencyKey: row.idempotencyKey,
    requestHash: row.requestHash,
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
    imagesSeen: row.imagesSeen,
    imagesUnseen: row.imagesUnseen,
    unseenImageHandoff: row.unseenImageHandoff as SupportAiImageSkipReason | null,
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
      readonly requestHash: string;
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
        requestHash: row.requestHash,
        createdAt: row.now,
        updatedAt: row.now,
      })
      .returning();
    if (inserted === undefined) throw new Error('support_ai_jobs: insert returned nothing.');
    return toRecord(inserted);
  }

  async findById(
    scope: ScopeContext,
    id: string,
    tx?: unknown,
  ): Promise<SupportAiJobRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await exec(this.db, tx)
      .select()
      .from(supportAiJobs)
      .where(and(eq(supportAiJobs.tenantId, tenantId), eq(supportAiJobs.id, id)))
      .limit(1);
    return row ? toRecord(row) : null;
  }

  async findByIdempotencyKey(
    scope: ScopeContext,
    key: string,
    tx?: unknown,
  ): Promise<SupportAiJobRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await exec(this.db, tx)
      .select()
      .from(supportAiJobs)
      .where(and(eq(supportAiJobs.tenantId, tenantId), eq(supportAiJobs.idempotencyKey, key)))
      .limit(1);
    return row ? toRecord(row) : null;
  }

  async recentForConversation(
    scope: ScopeContext,
    conversationId: string,
    limit: number,
  ): Promise<readonly SupportAiJobRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.db
      .select()
      .from(supportAiJobs)
      .where(
        and(eq(supportAiJobs.tenantId, tenantId), eq(supportAiJobs.conversationId, conversationId)),
      )
      .orderBy(desc(supportAiJobs.createdAt), desc(supportAiJobs.id))
      .limit(limit);
    return rows.map(toRecord);
  }

  /** Newer draft requested: every older QUEUED or READY draft of the conversation is discarded. */
  async discardOpen(
    scope: ScopeContext,
    conversationId: string,
    now: Date,
    tx: unknown,
  ): Promise<number> {
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

  /**
   * Leases ONE due QUEUED job (unclaimed, or whose lease ran out), oldest first (TB5 review,
   * finding 4). One at a time because jobs are produced one at a time: a batch leased up front
   * would wait out its lease behind its siblings and be re-claimed by a second replica while
   * still being produced. `SKIP LOCKED` lets two replicas claim different jobs in parallel; the
   * conditional UPDATE is the decision either way.
   */
  async claimNext(
    scope: ScopeContext,
    now: Date,
    leaseUntil: Date,
    tx: unknown,
  ): Promise<SupportAiJobRecord | null> {
    const tenantId = requireTenantId(scope);
    const db = exec(this.db, tx);
    const free = or(isNull(supportAiJobs.claimedUntil), lte(supportAiJobs.claimedUntil, now));
    const next = db
      .select({ id: supportAiJobs.id })
      .from(supportAiJobs)
      .where(and(eq(supportAiJobs.tenantId, tenantId), eq(supportAiJobs.state, 'QUEUED'), free))
      .orderBy(asc(supportAiJobs.createdAt), asc(supportAiJobs.id))
      .limit(1)
      .for('update', { skipLocked: true });
    const [row] = await db
      .update(supportAiJobs)
      .set({
        claimedUntil: leaseUntil,
        attempts: sql`${supportAiJobs.attempts} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(supportAiJobs.tenantId, tenantId),
          // A scalar subquery, evaluated ONCE (an InitPlan). `IN (… LIMIT 1 FOR UPDATE SKIP
          // LOCKED)` may be re-run per candidate row and, skipping the row this statement has
          // just locked, return the next one — leasing the whole queue in one claim.
          eq(supportAiJobs.id, sql`(${next})`),
          eq(supportAiJobs.state, 'QUEUED'),
          free,
        ),
      )
      .returning();
    return row ? toRecord(row) : null;
  }

  /**
   * Fails every QUEUED job that has had no live lease for `cutoff` and longer (TB5 review,
   * finding 6): never claimed since it was requested, or abandoned by a claim whose lease ran
   * out. A job being produced holds a lease in the future and is never touched. Scoped to one
   * conversation (the request and the listing), or to the whole tenant when `null`.
   */
  async failUnclaimed(
    scope: ScopeContext,
    conversationId: string | null,
    cutoff: Date,
    now: Date,
    tx: unknown,
  ): Promise<number> {
    const tenantId = requireTenantId(scope);
    const rows = await exec(this.db, tx)
      .update(supportAiJobs)
      .set({ state: 'FAILED', failureCode: 'job.unclaimed', claimedUntil: null, updatedAt: now })
      .where(
        and(
          eq(supportAiJobs.tenantId, tenantId),
          conversationId === null ? undefined : eq(supportAiJobs.conversationId, conversationId),
          eq(supportAiJobs.state, 'QUEUED'),
          lte(sql`coalesce(${supportAiJobs.claimedUntil}, ${supportAiJobs.createdAt})`, cutoff),
        ),
      )
      .returning({ id: supportAiJobs.id });
    return rows.length;
  }

  async markReady(
    scope: ScopeContext,
    id: string,
    result: {
      readonly decision: SupportAiDecision;
      readonly factLabels: readonly string[];
      readonly provider: SupportAiProvider;
      readonly model: string;
      /** TB6: images the answering model was given, and images it did not see. */
      readonly imagesSeen: number;
      readonly imagesUnseen: number;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await exec(this.db, tx)
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
        imagesSeen: result.imagesSeen,
        imagesUnseen: result.imagesUnseen,
        updatedAt: result.now,
      })
      .where(
        and(
          eq(supportAiJobs.tenantId, tenantId),
          eq(supportAiJobs.id, id),
          eq(supportAiJobs.state, 'QUEUED'),
        ),
      )
      .returning({ id: supportAiJobs.id });
    return rows.length > 0;
  }

  /**
   * TB6 — the fail-closed draft: the customer's latest message is an image nothing could
   * process, so NO model was asked and the draft is a HANDOFF that says why. Never a reply, a
   * provider or a seen image (the table's CHECK holds the same shape).
   */
  async markUnseenImageHandoff(
    scope: ScopeContext,
    id: string,
    input: {
      readonly reason: SupportAiImageSkipReason;
      readonly imagesUnseen: number;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await exec(this.db, tx)
      .update(supportAiJobs)
      .set({
        state: 'READY',
        readyAt: input.now,
        claimedUntil: null,
        decision: 'HANDOFF',
        topic: 'OTHER',
        confidence: 'LOW',
        ticketAction: 'NONE',
        summary: null,
        intent: null,
        suggestedReply: '',
        factRefs: [],
        factLabels: [],
        provider: null,
        model: null,
        imagesSeen: 0,
        imagesUnseen: input.imagesUnseen,
        unseenImageHandoff: input.reason,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(supportAiJobs.tenantId, tenantId),
          eq(supportAiJobs.id, id),
          eq(supportAiJobs.state, 'QUEUED'),
        ),
      )
      .returning({ id: supportAiJobs.id });
    return rows.length > 0;
  }

  /** TB6 — the per-image telemetry of one draft's request. */
  async recordImageOutcomes(
    scope: ScopeContext,
    jobId: string,
    rows: readonly (SupportAiImageOutcomeRow & { readonly id: string })[],
    now: Date,
    tx: unknown,
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    if (rows.length === 0) return;
    await exec(this.db, tx)
      .insert(supportAiImageOutcomes)
      .values(
        rows.map((row) => ({
          id: row.id,
          tenantId,
          jobId,
          messageId: row.messageId,
          outcome: row.outcome,
          reason: row.reason,
          mediaType: row.mediaType,
          byteSize: row.byteSize,
          createdAt: now,
        })),
      );
  }

  async imageOutcomes(
    scope: ScopeContext,
    jobId: string,
  ): Promise<readonly SupportAiImageOutcomeRow[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.db
      .select()
      .from(supportAiImageOutcomes)
      .where(
        and(eq(supportAiImageOutcomes.tenantId, tenantId), eq(supportAiImageOutcomes.jobId, jobId)),
      )
      .orderBy(asc(supportAiImageOutcomes.createdAt), asc(supportAiImageOutcomes.id));
    return rows.map((row) => ({
      messageId: row.messageId,
      outcome: row.outcome as SupportAiImageOutcome,
      reason: row.reason as SupportAiImageSkipReason | null,
      mediaType: row.mediaType,
      byteSize: row.byteSize,
    }));
  }

  async markFailed(
    scope: ScopeContext,
    id: string,
    failureCode: string,
    now: Date,
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await exec(this.db, tx)
      .update(supportAiJobs)
      .set({
        state: 'FAILED',
        failureCode: failureCode.slice(0, 200),
        claimedUntil: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(supportAiJobs.tenantId, tenantId),
          eq(supportAiJobs.id, id),
          eq(supportAiJobs.state, 'QUEUED'),
        ),
      )
      .returning({ id: supportAiJobs.id });
    return rows.length > 0;
  }

  async markSent(
    scope: ScopeContext,
    id: string,
    outboundId: string,
    now: Date,
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await exec(this.db, tx)
      .update(supportAiJobs)
      .set({ state: 'SENT', sentOutboundId: outboundId, updatedAt: now })
      .where(
        and(
          eq(supportAiJobs.tenantId, tenantId),
          eq(supportAiJobs.id, id),
          eq(supportAiJobs.state, 'READY'),
        ),
      )
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
  async purgeText(
    scope: ScopeContext,
    cutoff: Date,
    now: Date,
    limit: number,
    tx: unknown,
  ): Promise<number> {
    const tenantId = requireTenantId(scope);
    const db = exec(this.db, tx);
    const due = db
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
    const rows = await db
      .update(supportAiJobs)
      .set({
        summary: null,
        intent: null,
        suggestedReply: null,
        factLabels: [],
        textPurgedAt: now,
        updatedAt: now,
      })
      .where(and(eq(supportAiJobs.tenantId, tenantId), inArray(supportAiJobs.id, due)))
      .returning({ id: supportAiJobs.id });
    return rows.length;
  }
}
