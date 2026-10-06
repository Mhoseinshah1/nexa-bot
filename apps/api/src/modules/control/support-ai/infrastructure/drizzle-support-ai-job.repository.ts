import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';
import {
  SUPPORT_AI_LIMITS,
  type BusinessHandoffReason,
  type ScopeContext,
  type SupportAiAutoOutcome,
  type SupportAiDecision,
  type SupportAiFailureClass,
  type SupportAiImageOutcome,
  type SupportAiImageSkipReason,
  type SupportAiJobKind,
  type SupportAiJobState,
  type SupportAiProvider,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  businessOutboundMessages,
  supportAiImageOutcomes,
  supportAiJobs,
  supportLearningJobs,
} from '../../../../infrastructure/persistence/schema.js';
import { clarifyingStreakOf } from '../domain/auto-reply-guards.js';
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
  /** Why the AI produced nothing usable (`SUPPORT_AI_FAILURE_CLASSES`); null otherwise. */
  readonly failureClass: SupportAiFailureClass | null;
  readonly decision: SupportAiDecision['decision'] | null;
  readonly topic: SupportAiDecision['topic'] | null;
  readonly confidence: SupportAiDecision['confidence'] | null;
  readonly ticketAction: SupportAiDecision['ticketAction'] | null;
  readonly summary: string | null;
  readonly intent: string | null;
  readonly suggestedReply: string | null;
  readonly factLabels: readonly string[];
  /** D3: the knowledge entries the draft cited, by title; empty for none. */
  readonly knowledgeLabels: readonly string[];
  readonly provider: SupportAiProvider | null;
  readonly model: string | null;
  readonly sentOutboundId: string | null;
  readonly imagesSeen: number;
  readonly imagesUnseen: number;
  /** D2: knowledge entries the request carried, and the candidates; null when none was asked. */
  readonly knowledgeSent: number | null;
  readonly knowledgeAvailable: number | null;
  readonly unseenImageHandoff: SupportAiImageSkipReason | null;
  /** TB7 (AUTO_DECISION only). */
  readonly triggerTelegramMessageId: number | null;
  readonly triggerContentVersion: number | null;
  readonly controlEpoch: number | null;
  readonly dueAt: Date | null;
  readonly outcome: SupportAiAutoOutcome | null;
  readonly handoffReason: BusinessHandoffReason | null;
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
    failureClass: row.failureClass as SupportAiFailureClass | null,
    decision: row.decision as SupportAiJobRecord['decision'],
    topic: row.topic as SupportAiJobRecord['topic'],
    confidence: row.confidence as SupportAiJobRecord['confidence'],
    ticketAction: row.ticketAction as SupportAiJobRecord['ticketAction'],
    summary: row.summary,
    intent: row.intent,
    suggestedReply: row.suggestedReply,
    factLabels: row.factLabels ?? [],
    knowledgeLabels: row.knowledgeLabels ?? [],
    provider: row.provider as SupportAiProvider | null,
    model: row.model,
    sentOutboundId: row.sentOutboundId,
    imagesSeen: row.imagesSeen,
    imagesUnseen: row.imagesUnseen,
    knowledgeSent: row.knowledgeSent,
    knowledgeAvailable: row.knowledgeAvailable,
    unseenImageHandoff: row.unseenImageHandoff as SupportAiImageSkipReason | null,
    triggerTelegramMessageId: row.triggerTelegramMessageId,
    triggerContentVersion: row.triggerContentVersion,
    controlEpoch: row.controlEpoch,
    dueAt: row.dueAt,
    outcome: row.outcome as SupportAiAutoOutcome | null,
    handoffReason: row.handoffReason as BusinessHandoffReason | null,
    createdAt: row.createdAt,
  };
}

/** L1: the mark of a draft a newer request replaced — a DISCARDED job no person discarded. */
export const SUPPORT_AI_DRAFT_SUPERSEDED_CODE = 'job.superseded';

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
        and(
          eq(supportAiJobs.tenantId, tenantId),
          eq(supportAiJobs.conversationId, conversationId),
          eq(supportAiJobs.kind, 'ASSIST_DRAFT'),
        ),
      )
      .orderBy(desc(supportAiJobs.createdAt), desc(supportAiJobs.id))
      .limit(limit);
    return rows.map(toRecord);
  }

  /**
   * Newer draft requested: every older QUEUED or READY draft of the conversation is discarded,
   * marked `job.superseded` (L1) so the analytics tell it from an operator's discard.
   */
  async discardOpen(
    scope: ScopeContext,
    conversationId: string,
    now: Date,
    tx: unknown,
  ): Promise<number> {
    const tenantId = requireTenantId(scope);
    const rows = await exec(this.db, tx)
      .update(supportAiJobs)
      .set({
        state: 'DISCARDED',
        failureCode: SUPPORT_AI_DRAFT_SUPERSEDED_CODE,
        claimedUntil: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(supportAiJobs.tenantId, tenantId),
          eq(supportAiJobs.conversationId, conversationId),
          eq(supportAiJobs.kind, 'ASSIST_DRAFT'),
          inArray(supportAiJobs.state, ['QUEUED', 'READY']),
        ),
      )
      .returning({ id: supportAiJobs.id });
    return rows.length;
  }

  /**
   * TB7 — enqueues an automatic job. False when this message (at this content version) already
   * has one, of any state: the key makes it idempotent on the message.
   */
  async insertAuto(
    scope: ScopeContext,
    row: {
      readonly id: string;
      readonly conversationId: string;
      readonly idempotencyKey: string;
      readonly triggerTelegramMessageId: number;
      readonly triggerContentVersion: number;
      readonly controlEpoch: number;
      readonly dueAt: Date;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const inserted = await exec(this.db, tx)
      .insert(supportAiJobs)
      .values({
        id: row.id,
        tenantId,
        kind: 'AUTO_DECISION',
        conversationId: row.conversationId,
        requestedByAdminId: null,
        idempotencyKey: row.idempotencyKey,
        triggerTelegramMessageId: row.triggerTelegramMessageId,
        triggerContentVersion: row.triggerContentVersion,
        controlEpoch: row.controlEpoch,
        dueAt: row.dueAt,
        createdAt: row.now,
        updatedAt: row.now,
      })
      .onConflictDoNothing()
      .returning({ id: supportAiJobs.id });
    return inserted.length > 0;
  }

  /** TB7 — the conversation's pending automatic job, if any (at most one, by index). */
  async queuedAuto(
    scope: ScopeContext,
    conversationId: string,
    tx: unknown,
  ): Promise<SupportAiJobRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await exec(this.db, tx)
      .select()
      .from(supportAiJobs)
      .where(
        and(
          eq(supportAiJobs.tenantId, tenantId),
          eq(supportAiJobs.conversationId, conversationId),
          eq(supportAiJobs.kind, 'AUTO_DECISION'),
          eq(supportAiJobs.state, 'QUEUED'),
        ),
      )
      .limit(1);
    return row ? toRecord(row) : null;
  }

  /**
   * Hotfix (2026-10-06) — the conversation's clarifying streak at `epoch`: walking back over the
   * automatic replies the AI actually produced, the `ASK_CLARIFYING_QUESTION`s before the
   * newest `REPLY` (`clarifyingStreakOf`). A reply is an AUTO lane row joined to the SENT job
   * that enqueued it (`sent_outbound_id`), whose recorded `decision` says what it was.
   *
   * What counts is the lane row's state: PENDING (on its way; counting it is fail closed, and
   * it stops counting the moment it is superseded), DELIVERED, and UNCONFIRMED (Telegram may
   * have shown it, and it is never resent). FAILED — Telegram refused it — and SUPERSEDED never
   * reached the customer and count neither as a question nor as the REPLY that resets. A job
   * DISCARDED or FAILED has no lane row at all, and one job has at most one row (its key), so a
   * redelivered message or a retried send is one row, once. Another epoch is another streak.
   */
  async clarifyingStreak(
    scope: ScopeContext,
    input: { readonly conversationId: string; readonly epoch: number },
    tx?: unknown,
  ): Promise<number> {
    const tenantId = requireTenantId(scope);
    const rows = await exec(this.db, tx)
      .select({ decision: supportAiJobs.decision })
      .from(businessOutboundMessages)
      .innerJoin(
        supportAiJobs,
        and(
          eq(supportAiJobs.tenantId, businessOutboundMessages.tenantId),
          eq(supportAiJobs.sentOutboundId, businessOutboundMessages.id),
          eq(supportAiJobs.kind, 'AUTO_DECISION'),
          eq(supportAiJobs.state, 'SENT'),
        ),
      )
      .where(
        and(
          eq(businessOutboundMessages.tenantId, tenantId),
          eq(businessOutboundMessages.conversationId, input.conversationId),
          eq(businessOutboundMessages.origin, 'AUTO'),
          eq(businessOutboundMessages.controlEpoch, input.epoch),
          inArray(businessOutboundMessages.state, ['PENDING', 'DELIVERED', 'UNCONFIRMED']),
        ),
      )
      .orderBy(desc(businessOutboundMessages.createdAt), desc(businessOutboundMessages.id))
      // Past the highest limit there is nothing more to know.
      .limit(SUPPORT_AI_LIMITS.maxConsecutiveClarifyingQuestions.max + 1);
    return clarifyingStreakOf(rows);
  }

  /**
   * TB7 — resolves an automatic job, ONLY from QUEUED: a job a newer message replaced while the
   * `assistant` role was producing it stays replaced, and its late result writes nothing.
   */
  async finishAuto(
    scope: ScopeContext,
    id: string,
    result: {
      readonly state: 'SENT' | 'DISCARDED' | 'FAILED';
      readonly outcome: SupportAiAutoOutcome;
      readonly handoffReason?: BusinessHandoffReason | null;
      readonly decision?: SupportAiDecision | null;
      readonly provider?: SupportAiProvider | null;
      readonly model?: string | null;
      readonly sentOutboundId?: string | null;
      /** A handoff because the AI failed: why (`AI_OUTPUT_INVALID` / `AI_UNAVAILABLE`). */
      readonly failureClass?: SupportAiFailureClass | null;
      readonly now: Date;
    },
    tx?: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const decision = result.decision ?? null;
    const rows = await exec(this.db, tx)
      .update(supportAiJobs)
      .set({
        state: result.state,
        outcome: result.outcome,
        handoffReason: result.handoffReason ?? null,
        claimedUntil: null,
        readyAt: decision === null ? null : result.now,
        ...(decision === null
          ? {}
          : {
              decision: decision.decision,
              topic: decision.topic,
              confidence: decision.confidence,
              ticketAction: decision.ticketAction,
              summary: decision.summary,
              intent: decision.intent,
              suggestedReply: decision.replyText,
              factRefs: [...decision.factRefs],
            }),
        provider: result.provider ?? null,
        model: result.model?.slice(0, 128) ?? null,
        sentOutboundId: result.sentOutboundId ?? null,
        failureCode: result.state === 'SENT' ? null : result.outcome,
        failureClass: result.state === 'SENT' ? null : (result.failureClass ?? null),
        updatedAt: result.now,
      })
      .where(
        and(
          eq(supportAiJobs.tenantId, tenantId),
          eq(supportAiJobs.id, id),
          eq(supportAiJobs.kind, 'AUTO_DECISION'),
          eq(supportAiJobs.state, 'QUEUED'),
        ),
      )
      .returning({ id: supportAiJobs.id });
    return rows.length > 0;
  }

  /**
   * Leases ONE due QUEUED job (unclaimed, or whose lease ran out), oldest first (TB5 review,
   * finding 4). One at a time because jobs are produced one at a time: a batch leased up front
   * would wait out its lease behind its siblings and be re-claimed by a second replica while
   * still being produced. `SKIP LOCKED` lets two replicas claim different jobs in parallel; the
   * conditional UPDATE is the decision either way.
   *
   * TB7: only the `kinds` the caller can produce are claimed, and an automatic job is not due
   * before its settle delay (`due_at`) has passed.
   */
  async claimNext(
    scope: ScopeContext,
    now: Date,
    leaseUntil: Date,
    kinds: readonly SupportAiJobKind[],
    tx: unknown,
  ): Promise<SupportAiJobRecord | null> {
    const tenantId = requireTenantId(scope);
    const db = exec(this.db, tx);
    const free = and(
      or(isNull(supportAiJobs.claimedUntil), lte(supportAiJobs.claimedUntil, now)),
      or(isNull(supportAiJobs.dueAt), lte(supportAiJobs.dueAt, now)),
    );
    const next = db
      .select({ id: supportAiJobs.id })
      .from(supportAiJobs)
      .where(
        and(
          eq(supportAiJobs.tenantId, tenantId),
          eq(supportAiJobs.state, 'QUEUED'),
          inArray(supportAiJobs.kind, [...kinds]),
          free,
        ),
      )
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
   *
   * ASSIST drafts only (TB7): an AUTO_DECISION job is not a draft an operator waits on. It is
   * QUEUED until its `due_at`, is coalesced or dropped by its own producer, and a repeatedly
   * failing one hands off through `giveUp` — failing it here as `job.unclaimed` would silence a
   * customer's message without the handoff and ticket TB7 owes them.
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
          eq(supportAiJobs.kind, 'ASSIST_DRAFT'),
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
      /** D3: resolved knowledge citations; omitted is none. */
      readonly knowledgeLabels?: readonly string[];
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
        knowledgeLabels: [...(result.knowledgeLabels ?? [])],
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
        knowledgeLabels: [],
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

  /**
   * D5 — what the worker's watch reads to tell a stalled assistant from a busy one: the Assist
   * drafts and automatic jobs QUEUED and due since `dueBefore` with no live lease (nobody is
   * producing them), and how many QUEUED jobs — learning jobs included — hold a live lease
   * (somebody is). One statement.
   */
  async assistantBacklog(
    scope: ScopeContext,
    now: Date,
    dueBefore: Date,
    tx?: unknown,
  ): Promise<{
    readonly overdue: number;
    readonly oldestDueAt: Date | null;
    readonly leased: number;
  }> {
    const tenantId = requireTenantId(scope);
    const at = sql`${now.toISOString()}::timestamptz`;
    const before = sql`${dueBefore.toISOString()}::timestamptz`;
    const due = sql`coalesce(${supportAiJobs.dueAt}, ${supportAiJobs.createdAt})`;
    const unleased = sql`(${supportAiJobs.claimedUntil} IS NULL OR ${supportAiJobs.claimedUntil} <= ${at})`;
    const [row] = await exec(this.db, tx)
      .select({
        overdue: sql<number>`count(*) FILTER (WHERE ${due} <= ${before} AND ${unleased})::int`,
        oldestDueAt: sql<
          string | Date | null
        >`min(${due}) FILTER (WHERE ${due} <= ${before} AND ${unleased})`,
        // Review item 5: a learning job the assistant is extracting holds a lease too — a busy
        // assistant, not a dead one.
        leased: sql<number>`(count(*) FILTER (WHERE ${supportAiJobs.claimedUntil} > ${at})
          + (SELECT count(*) FROM ${supportLearningJobs}
              WHERE ${supportLearningJobs.tenantId} = ${tenantId}
                AND ${supportLearningJobs.state} = 'QUEUED'
                AND ${supportLearningJobs.claimedUntil} > ${at}))::int`,
      })
      .from(supportAiJobs)
      .where(
        and(
          eq(supportAiJobs.tenantId, tenantId),
          eq(supportAiJobs.state, 'QUEUED'),
          inArray(supportAiJobs.kind, ['ASSIST_DRAFT', 'AUTO_DECISION']),
        ),
      );
    const oldest = row?.oldestDueAt ?? null;
    return {
      overdue: Number(row?.overdue ?? 0),
      oldestDueAt: oldest === null ? null : new Date(oldest),
      leased: Number(row?.leased ?? 0),
    };
  }

  /**
   * D2 telemetry — how many knowledge entries the job's request carried, and how many there
   * were to choose from. Written in the job's result transaction (`withKnowledgeCounts`).
   */
  async recordKnowledgeCounts(
    scope: ScopeContext,
    jobId: string,
    counts: { readonly sent: number; readonly available: number },
    now: Date,
    tx: unknown,
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    await exec(this.db, tx)
      .update(supportAiJobs)
      .set({ knowledgeSent: counts.sent, knowledgeAvailable: counts.available, updatedAt: now })
      .where(and(eq(supportAiJobs.tenantId, tenantId), eq(supportAiJobs.id, jobId)));
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

  /** The failure class of each named job that has one (the AI was why it failed). */
  async failureClasses(
    scope: ScopeContext,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, SupportAiFailureClass>> {
    const tenantId = requireTenantId(scope);
    if (ids.length === 0) return new Map();
    const rows = await this.db
      .select({ id: supportAiJobs.id, failureClass: supportAiJobs.failureClass })
      .from(supportAiJobs)
      .where(
        and(
          eq(supportAiJobs.tenantId, tenantId),
          inArray(supportAiJobs.id, [...ids]),
          isNotNull(supportAiJobs.failureClass),
        ),
      );
    return new Map(rows.map((row) => [row.id, row.failureClass as SupportAiFailureClass]));
  }

  async markFailed(
    scope: ScopeContext,
    id: string,
    failureCode: string,
    now: Date,
    tx: unknown,
    /** Why, when the AI was the reason (`SUPPORT_AI_FAILURE_CLASSES`). */
    failureClass: SupportAiFailureClass | null = null,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await exec(this.db, tx)
      .update(supportAiJobs)
      .set({
        state: 'FAILED',
        failureCode: failureCode.slice(0, 200),
        failureClass,
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
          eq(supportAiJobs.kind, 'ASSIST_DRAFT'),
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
        knowledgeLabels: [],
        textPurgedAt: now,
        updatedAt: now,
      })
      .where(and(eq(supportAiJobs.tenantId, tenantId), inArray(supportAiJobs.id, due)))
      .returning({ id: supportAiJobs.id });
    return rows.length;
  }
}
