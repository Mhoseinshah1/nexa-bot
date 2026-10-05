import { and, asc, count, desc, eq, gte, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import {
  SUPPORT_LEARNING_MAX_SOURCES,
  type ScopeContext,
  type SupportAiConfidence,
  type SupportAiProvider,
  type SupportKnowledgeArticleState,
  type SupportKnowledgeCategory,
  type SupportKnowledgeContent,
  type SupportKnowledgeRevisionOrigin,
  type SupportKnowledgeSource,
  type SupportLearningCandidateState,
  type SupportLearningJobOutcome,
  type SupportLearningJobState,
  type SupportLearningJobTrigger,
  type SupportLearningRejectReason,
  type SupportLearningSensitiveKind,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  supportKnowledgeArticles,
  supportKnowledgeRevisions,
  supportLearningCandidates,
  supportLearningJobs,
} from '../../../../infrastructure/persistence/schema.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';

// --- records -------------------------------------------------------------------

export interface KnowledgeArticleRecord {
  readonly id: string;
  readonly source: SupportKnowledgeSource;
  readonly state: SupportKnowledgeArticleState;
  readonly enabled: boolean;
  readonly title: string;
  readonly body: string;
  readonly category: SupportKnowledgeCategory;
  readonly tags: readonly string[];
  readonly revision: number;
  readonly version: number;
  readonly candidateId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface KnowledgeRevisionRecord {
  readonly articleId: string;
  readonly revision: number;
  readonly origin: SupportKnowledgeRevisionOrigin;
  readonly title: string;
  readonly body: string;
  readonly category: SupportKnowledgeCategory;
  readonly tags: readonly string[];
  readonly reviewerAdminId: string | null;
  readonly createdAt: Date;
}

export interface LearningSourceRef {
  readonly conversationId: string;
  readonly outboundId: string;
  readonly at: string;
}

export interface LearningCandidateRecord {
  readonly id: string;
  readonly state: SupportLearningCandidateState;
  readonly title: string;
  readonly normalizedTitle: string;
  readonly body: string | null;
  readonly category: SupportKnowledgeCategory;
  readonly tags: readonly string[];
  readonly rationale: string | null;
  readonly confidence: SupportAiConfidence;
  readonly rejectReason: SupportLearningRejectReason | null;
  readonly sensitiveKinds: readonly SupportLearningSensitiveKind[];
  readonly conversationId: string;
  readonly sourceOutboundId: string;
  readonly sourceRefs: readonly LearningSourceRef[];
  readonly sourceCount: number;
  readonly jobId: string;
  readonly provider: SupportAiProvider | null;
  readonly model: string | null;
  readonly articleId: string | null;
  readonly reviewedByAdminId: string | null;
  readonly reviewedAt: Date | null;
  readonly version: number;
  readonly createdAt: Date;
}

export interface LearningJobRecord {
  readonly id: string;
  readonly conversationId: string;
  readonly sourceOutboundId: string;
  readonly trigger: SupportLearningJobTrigger;
  readonly requestedByAdminId: string | null;
  readonly idempotencyKey: string;
  readonly state: SupportLearningJobState;
  readonly outcome: SupportLearningJobOutcome | null;
  readonly attempts: number;
  readonly candidateId: string | null;
  readonly createdAt: Date;
}

type ArticleRow = typeof supportKnowledgeArticles.$inferSelect;
type CandidateRow = typeof supportLearningCandidates.$inferSelect;
type JobRow = typeof supportLearningJobs.$inferSelect;

/*
 * Casts rather than re-validation: every enum column below is pinned by a CHECK built from its
 * contract enum, and the database is the boundary that guarantees it.
 */
function article(row: ArticleRow): KnowledgeArticleRecord {
  return {
    id: row.id,
    source: row.source as SupportKnowledgeSource,
    state: row.state as SupportKnowledgeArticleState,
    enabled: row.enabled,
    title: row.title,
    body: row.body,
    category: row.category as SupportKnowledgeCategory,
    tags: row.tags,
    revision: row.revision,
    version: row.version,
    candidateId: row.candidateId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function candidate(row: CandidateRow): LearningCandidateRecord {
  return {
    id: row.id,
    state: row.state as SupportLearningCandidateState,
    title: row.title,
    normalizedTitle: row.normalizedTitle,
    body: row.body,
    category: row.category as SupportKnowledgeCategory,
    tags: row.tags,
    rationale: row.rationale,
    confidence: row.confidence as SupportAiConfidence,
    rejectReason: row.rejectReason as SupportLearningRejectReason | null,
    sensitiveKinds: row.sensitiveKinds as SupportLearningSensitiveKind[],
    conversationId: row.conversationId,
    sourceOutboundId: row.sourceOutboundId,
    sourceRefs: Array.isArray(row.sourceRefs) ? (row.sourceRefs as LearningSourceRef[]) : [],
    sourceCount: row.sourceCount,
    jobId: row.jobId,
    provider: row.provider as SupportAiProvider | null,
    model: row.model,
    articleId: row.articleId,
    reviewedByAdminId: row.reviewedByAdminId,
    reviewedAt: row.reviewedAt,
    version: row.version,
    createdAt: row.createdAt,
  };
}

function job(row: JobRow): LearningJobRecord {
  return {
    id: row.id,
    conversationId: row.conversationId,
    sourceOutboundId: row.sourceOutboundId,
    trigger: row.trigger as SupportLearningJobTrigger,
    requestedByAdminId: row.requestedByAdminId,
    idempotencyKey: row.idempotencyKey,
    state: row.state as SupportLearningJobState,
    outcome: row.outcome as SupportLearningJobOutcome | null,
    attempts: row.attempts,
    candidateId: row.candidateId,
    createdAt: row.createdAt,
  };
}

function exec(db: Database, tx?: unknown): Executor {
  return (tx as TransactionScope | undefined)?.tx ?? db;
}

/**
 * TB8 — support knowledge, its revisions, learning candidates and learning jobs, in PostgreSQL.
 *
 * Every query carries the tenant, id lookups included. Every state change is a conditional
 * UPDATE naming the states it may leave and, where an operator edits, the version they read:
 * zero rows is the answer "it moved", never a silent overwrite. There is no `setState`.
 */
export class DrizzleSupportKnowledgeRepository {
  constructor(private readonly db: Database) {}

  // --- articles ----------------------------------------------------------------

  /**
   * THE retrieval the support agent grounds on (ADR-0035 §1): APPROVED and enabled, in SQL.
   * A draft, a retired article and a candidate are unreachable from here by construction.
   */
  async activeForContext(
    scope: ScopeContext,
    limit: number,
  ): Promise<readonly KnowledgeArticleRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.db
      .select()
      .from(supportKnowledgeArticles)
      .where(
        and(
          eq(supportKnowledgeArticles.tenantId, tenantId),
          eq(supportKnowledgeArticles.state, 'APPROVED'),
          eq(supportKnowledgeArticles.enabled, true),
        ),
      )
      .orderBy(desc(supportKnowledgeArticles.updatedAt), asc(supportKnowledgeArticles.id))
      .limit(limit);
    return rows.map(article);
  }

  async listArticles(
    scope: ScopeContext,
    filter: {
      readonly source?: SupportKnowledgeSource | undefined;
      readonly state?: SupportKnowledgeArticleState | undefined;
    },
    limit: number,
  ): Promise<readonly KnowledgeArticleRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.db
      .select()
      .from(supportKnowledgeArticles)
      .where(
        and(
          eq(supportKnowledgeArticles.tenantId, tenantId),
          filter.source === undefined
            ? undefined
            : eq(supportKnowledgeArticles.source, filter.source),
          filter.state === undefined ? undefined : eq(supportKnowledgeArticles.state, filter.state),
        ),
      )
      .orderBy(desc(supportKnowledgeArticles.updatedAt), asc(supportKnowledgeArticles.id))
      .limit(limit);
    return rows.map(article);
  }

  async findArticle(
    scope: ScopeContext,
    id: string,
    tx?: unknown,
  ): Promise<KnowledgeArticleRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await exec(this.db, tx)
      .select()
      .from(supportKnowledgeArticles)
      .where(
        and(eq(supportKnowledgeArticles.tenantId, tenantId), eq(supportKnowledgeArticles.id, id)),
      )
      .limit(1);
    return row === undefined ? null : article(row);
  }

  async countArticles(scope: ScopeContext, tx: unknown): Promise<number> {
    const tenantId = requireTenantId(scope);
    const [row] = await exec(this.db, tx)
      .select({ n: count() })
      .from(supportKnowledgeArticles)
      .where(eq(supportKnowledgeArticles.tenantId, tenantId));
    return Number(row?.n ?? 0);
  }

  async insertArticle(
    scope: ScopeContext,
    row: {
      readonly id: string;
      readonly source: SupportKnowledgeSource;
      readonly state: SupportKnowledgeArticleState;
      readonly content: SupportKnowledgeContent;
      readonly revision: number;
      readonly candidateId: string | null;
      readonly createdByAdminId: string | null;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<KnowledgeArticleRecord> {
    const tenantId = requireTenantId(scope);
    const [inserted] = await exec(this.db, tx)
      .insert(supportKnowledgeArticles)
      .values({
        id: row.id,
        tenantId,
        source: row.source,
        state: row.state,
        enabled: true,
        title: row.content.title,
        body: row.content.body,
        category: row.content.category,
        tags: [...row.content.tags],
        revision: row.revision,
        version: 1,
        candidateId: row.candidateId,
        createdByAdminId: row.createdByAdminId,
        createdAt: row.now,
        updatedAt: row.now,
      })
      .returning();
    if (inserted === undefined)
      throw new Error('support_knowledge_articles: insert returned nothing.');
    return article(inserted);
  }

  /**
   * Replaces an article's content, conditional on the version AND on a state in `from`.
   * `publish` advances `revision` by one (an approved article's edit is a new revision; a
   * draft's is not) and, with `to`, moves the state in the same statement.
   */
  async rewrite(
    scope: ScopeContext,
    id: string,
    input: {
      readonly expectedVersion: number;
      readonly from: readonly SupportKnowledgeArticleState[];
      readonly to?: SupportKnowledgeArticleState;
      readonly content?: SupportKnowledgeContent;
      readonly publish: boolean;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<KnowledgeArticleRecord | null> {
    const tenantId = requireTenantId(scope);
    const content = input.content;
    const [row] = await exec(this.db, tx)
      .update(supportKnowledgeArticles)
      .set({
        ...(content === undefined
          ? {}
          : {
              title: content.title,
              body: content.body,
              category: content.category,
              tags: [...content.tags],
            }),
        ...(input.to === undefined ? {} : { state: input.to }),
        revision: input.publish
          ? sql`${supportKnowledgeArticles.revision} + 1`
          : sql`${supportKnowledgeArticles.revision}`,
        version: sql`${supportKnowledgeArticles.version} + 1`,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(supportKnowledgeArticles.tenantId, tenantId),
          eq(supportKnowledgeArticles.id, id),
          eq(supportKnowledgeArticles.version, input.expectedVersion),
          inArray(supportKnowledgeArticles.state, [...input.from]),
        ),
      )
      .returning();
    return row === undefined ? null : article(row);
  }

  async setEnabled(
    scope: ScopeContext,
    id: string,
    input: { readonly enabled: boolean; readonly expectedVersion: number; readonly now: Date },
    tx: unknown,
  ): Promise<KnowledgeArticleRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await exec(this.db, tx)
      .update(supportKnowledgeArticles)
      .set({
        enabled: input.enabled,
        version: sql`${supportKnowledgeArticles.version} + 1`,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(supportKnowledgeArticles.tenantId, tenantId),
          eq(supportKnowledgeArticles.id, id),
          eq(supportKnowledgeArticles.version, input.expectedVersion),
          eq(supportKnowledgeArticles.enabled, !input.enabled),
        ),
      )
      .returning();
    return row === undefined ? null : article(row);
  }

  /** Append-only: the table's trigger refuses UPDATE and DELETE. */
  async insertRevision(
    scope: ScopeContext,
    row: {
      readonly id: string;
      readonly article: KnowledgeArticleRecord;
      readonly origin: SupportKnowledgeRevisionOrigin;
      readonly reviewerAdminId: string | null;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    await exec(this.db, tx)
      .insert(supportKnowledgeRevisions)
      .values({
        id: row.id,
        tenantId,
        articleId: row.article.id,
        revision: row.article.revision,
        origin: row.origin,
        title: row.article.title,
        body: row.article.body,
        category: row.article.category,
        tags: [...row.article.tags],
        reviewerAdminId: row.reviewerAdminId,
        createdAt: row.now,
      });
  }

  async revisions(
    scope: ScopeContext,
    articleId: string,
  ): Promise<readonly KnowledgeRevisionRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.db
      .select()
      .from(supportKnowledgeRevisions)
      .where(
        and(
          eq(supportKnowledgeRevisions.tenantId, tenantId),
          eq(supportKnowledgeRevisions.articleId, articleId),
        ),
      )
      .orderBy(desc(supportKnowledgeRevisions.revision));
    return rows.map((row) => ({
      articleId: row.articleId,
      revision: row.revision,
      origin: row.origin as SupportKnowledgeRevisionOrigin,
      title: row.title,
      body: row.body,
      category: row.category as SupportKnowledgeCategory,
      tags: row.tags,
      reviewerAdminId: row.reviewerAdminId,
      createdAt: row.createdAt,
    }));
  }

  // --- candidates ----------------------------------------------------------------

  async listCandidates(
    scope: ScopeContext,
    filter: { readonly state?: SupportLearningCandidateState | undefined },
    limit: number,
  ): Promise<readonly LearningCandidateRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.db
      .select()
      .from(supportLearningCandidates)
      .where(
        and(
          eq(supportLearningCandidates.tenantId, tenantId),
          filter.state === undefined
            ? undefined
            : eq(supportLearningCandidates.state, filter.state),
        ),
      )
      .orderBy(desc(supportLearningCandidates.createdAt), asc(supportLearningCandidates.id))
      .limit(limit);
    return rows.map(candidate);
  }

  async findCandidate(
    scope: ScopeContext,
    id: string,
    tx?: unknown,
  ): Promise<LearningCandidateRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await exec(this.db, tx)
      .select()
      .from(supportLearningCandidates)
      .where(
        and(eq(supportLearningCandidates.tenantId, tenantId), eq(supportLearningCandidates.id, id)),
      )
      .limit(1);
    return row === undefined ? null : candidate(row);
  }

  /** The most recent candidates' normalised titles, for the near-duplicate check. */
  async recentTitles(
    scope: ScopeContext,
    limit: number,
  ): Promise<readonly { readonly id: string; readonly normalizedTitle: string }[]> {
    const tenantId = requireTenantId(scope);
    return this.db
      .select({
        id: supportLearningCandidates.id,
        normalizedTitle: supportLearningCandidates.normalizedTitle,
      })
      .from(supportLearningCandidates)
      .where(eq(supportLearningCandidates.tenantId, tenantId))
      .orderBy(desc(supportLearningCandidates.createdAt))
      .limit(limit);
  }

  /**
   * Inserts a candidate, or — when its normalised title is already taken, by a row of ANY
   * state — writes nothing and returns null. The unique index decides, so two replicas
   * proposing the same lesson produce one candidate.
   */
  async insertCandidate(
    scope: ScopeContext,
    row: {
      readonly id: string;
      readonly state: 'PENDING' | 'REJECTED';
      readonly title: string;
      readonly normalizedTitle: string;
      readonly body: string;
      readonly category: SupportKnowledgeCategory;
      readonly tags: readonly string[];
      readonly rationale: string;
      readonly confidence: SupportAiConfidence;
      readonly rejectReason: SupportLearningRejectReason | null;
      readonly sensitiveKinds: readonly SupportLearningSensitiveKind[];
      readonly source: LearningSourceRef;
      readonly jobId: string;
      readonly provider: SupportAiProvider | null;
      readonly model: string | null;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<LearningCandidateRecord | null> {
    const tenantId = requireTenantId(scope);
    const [inserted] = await exec(this.db, tx)
      .insert(supportLearningCandidates)
      .values({
        id: row.id,
        tenantId,
        state: row.state,
        title: row.title,
        normalizedTitle: row.normalizedTitle,
        body: row.body,
        category: row.category,
        tags: [...row.tags],
        rationale: row.rationale,
        confidence: row.confidence,
        rejectReason: row.rejectReason,
        sensitiveKinds: [...row.sensitiveKinds],
        conversationId: row.source.conversationId,
        sourceOutboundId: row.source.outboundId,
        sourceRefs: [row.source],
        sourceCount: 1,
        jobId: row.jobId,
        provider: row.provider,
        model: row.model?.slice(0, 128) ?? null,
        reviewedAt: row.state === 'REJECTED' ? row.now : null,
        createdAt: row.now,
        updatedAt: row.now,
      })
      .onConflictDoNothing({
        target: [supportLearningCandidates.tenantId, supportLearningCandidates.normalizedTitle],
      })
      .returning();
    return inserted === undefined ? null : candidate(inserted);
  }

  async findByNormalizedTitle(
    scope: ScopeContext,
    normalizedTitle: string,
    tx?: unknown,
  ): Promise<LearningCandidateRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await exec(this.db, tx)
      .select()
      .from(supportLearningCandidates)
      .where(
        and(
          eq(supportLearningCandidates.tenantId, tenantId),
          eq(supportLearningCandidates.normalizedTitle, normalizedTitle),
        ),
      )
      .limit(1);
    return row === undefined ? null : candidate(row);
  }

  /**
   * Records one more source of an existing lesson. The version is NOT advanced: a merge
   * changes nothing a reviewer decides on, and must not turn their approval into a conflict.
   * The reference list is bounded; the count is not.
   */
  async mergeSource(
    scope: ScopeContext,
    id: string,
    source: LearningSourceRef,
    now: Date,
    tx: unknown,
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    await exec(this.db, tx)
      .update(supportLearningCandidates)
      .set({
        sourceRefs: sql`CASE WHEN jsonb_array_length(${supportLearningCandidates.sourceRefs}) < ${SUPPORT_LEARNING_MAX_SOURCES}
          THEN ${supportLearningCandidates.sourceRefs} || ${JSON.stringify([source])}::jsonb
          ELSE ${supportLearningCandidates.sourceRefs} END`,
        sourceCount: sql`${supportLearningCandidates.sourceCount} + 1`,
        updatedAt: now,
      })
      .where(
        and(eq(supportLearningCandidates.tenantId, tenantId), eq(supportLearningCandidates.id, id)),
      );
  }

  /** PENDING → APPROVED, naming the version the reviewer read and the article it published. */
  async approveCandidate(
    scope: ScopeContext,
    id: string,
    input: {
      readonly expectedVersion: number;
      readonly articleId: string;
      readonly reviewerAdminId: string;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<LearningCandidateRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await exec(this.db, tx)
      .update(supportLearningCandidates)
      .set({
        state: 'APPROVED',
        articleId: input.articleId,
        reviewedByAdminId: input.reviewerAdminId,
        reviewedAt: input.now,
        version: sql`${supportLearningCandidates.version} + 1`,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(supportLearningCandidates.tenantId, tenantId),
          eq(supportLearningCandidates.id, id),
          eq(supportLearningCandidates.state, 'PENDING'),
          eq(supportLearningCandidates.version, input.expectedVersion),
        ),
      )
      .returning();
    return row === undefined ? null : candidate(row);
  }

  /** PENDING → REJECTED by a reviewer. Terminal. */
  async rejectCandidate(
    scope: ScopeContext,
    id: string,
    input: {
      readonly expectedVersion: number;
      readonly reviewerAdminId: string;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<LearningCandidateRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await exec(this.db, tx)
      .update(supportLearningCandidates)
      .set({
        state: 'REJECTED',
        rejectReason: 'REVIEWER',
        reviewedByAdminId: input.reviewerAdminId,
        reviewedAt: input.now,
        version: sql`${supportLearningCandidates.version} + 1`,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(supportLearningCandidates.tenantId, tenantId),
          eq(supportLearningCandidates.id, id),
          eq(supportLearningCandidates.state, 'PENDING'),
          eq(supportLearningCandidates.version, input.expectedVersion),
        ),
      )
      .returning();
    return row === undefined ? null : candidate(row);
  }

  /**
   * ADR-0035 consequences: the text of a candidate never approved is purged after the
   * retention; the normalised title stays, because the duplicate check matches it.
   */
  async purgeCandidateText(
    scope: ScopeContext,
    cutoff: Date,
    now: Date,
    limit: number,
  ): Promise<number> {
    const tenantId = requireTenantId(scope);
    const due = this.db
      .select({ id: supportLearningCandidates.id })
      .from(supportLearningCandidates)
      .where(
        and(
          eq(supportLearningCandidates.tenantId, tenantId),
          inArray(supportLearningCandidates.state, ['PENDING', 'REJECTED']),
          lt(supportLearningCandidates.createdAt, cutoff),
          isNull(supportLearningCandidates.textPurgedAt),
        ),
      )
      .limit(limit);
    const rows = await this.db
      .update(supportLearningCandidates)
      .set({ body: null, rationale: null, textPurgedAt: now, updatedAt: now })
      .where(
        and(
          eq(supportLearningCandidates.tenantId, tenantId),
          inArray(supportLearningCandidates.id, due),
          inArray(supportLearningCandidates.state, ['PENDING', 'REJECTED']),
        ),
      )
      .returning({ id: supportLearningCandidates.id });
    return rows.length;
  }

  // --- learning jobs -----------------------------------------------------------------

  /** False when the key already has a job (of any state): idempotent on the reply. */
  async insertJob(
    scope: ScopeContext,
    row: {
      readonly id: string;
      readonly conversationId: string;
      readonly sourceOutboundId: string;
      readonly trigger: SupportLearningJobTrigger;
      readonly requestedByAdminId: string | null;
      readonly idempotencyKey: string;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const inserted = await exec(this.db, tx)
      .insert(supportLearningJobs)
      .values({
        id: row.id,
        tenantId,
        conversationId: row.conversationId,
        sourceOutboundId: row.sourceOutboundId,
        trigger: row.trigger,
        requestedByAdminId: row.requestedByAdminId,
        idempotencyKey: row.idempotencyKey,
        createdAt: row.now,
        updatedAt: row.now,
      })
      .onConflictDoNothing({
        target: [supportLearningJobs.tenantId, supportLearningJobs.idempotencyKey],
      })
      .returning({ id: supportLearningJobs.id });
    return inserted.length > 0;
  }

  async findJobByKey(
    scope: ScopeContext,
    key: string,
    tx?: unknown,
  ): Promise<LearningJobRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await exec(this.db, tx)
      .select()
      .from(supportLearningJobs)
      .where(
        and(
          eq(supportLearningJobs.tenantId, tenantId),
          eq(supportLearningJobs.idempotencyKey, key),
        ),
      )
      .limit(1);
    return row === undefined ? null : job(row);
  }

  async findJob(scope: ScopeContext, id: string): Promise<LearningJobRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.db
      .select()
      .from(supportLearningJobs)
      .where(and(eq(supportLearningJobs.tenantId, tenantId), eq(supportLearningJobs.id, id)))
      .limit(1);
    return row === undefined ? null : job(row);
  }

  /** Jobs since `since`: of one conversation when it is named, else of the whole tenant. */
  async countJobsSince(
    scope: ScopeContext,
    since: Date,
    conversationId: string | null,
    tx: unknown,
  ): Promise<number> {
    const tenantId = requireTenantId(scope);
    const [row] = await exec(this.db, tx)
      .select({ n: count() })
      .from(supportLearningJobs)
      .where(
        and(
          eq(supportLearningJobs.tenantId, tenantId),
          gte(supportLearningJobs.createdAt, since),
          conversationId === null
            ? undefined
            : eq(supportLearningJobs.conversationId, conversationId),
        ),
      );
    return Number(row?.n ?? 0);
  }

  /** Leases due QUEUED jobs (unclaimed, or whose lease ran out), oldest first. */
  async claimDue(
    scope: ScopeContext,
    now: Date,
    leaseUntil: Date,
    limit: number,
  ): Promise<readonly LearningJobRecord[]> {
    const tenantId = requireTenantId(scope);
    const free = or(
      isNull(supportLearningJobs.claimedUntil),
      lte(supportLearningJobs.claimedUntil, now),
    );
    const selected = await this.db
      .select({ id: supportLearningJobs.id })
      .from(supportLearningJobs)
      .where(
        and(
          eq(supportLearningJobs.tenantId, tenantId),
          eq(supportLearningJobs.state, 'QUEUED'),
          free,
        ),
      )
      .orderBy(asc(supportLearningJobs.createdAt), asc(supportLearningJobs.id))
      .limit(limit);
    if (selected.length === 0) return [];
    const rows = await this.db
      .update(supportLearningJobs)
      .set({
        claimedUntil: leaseUntil,
        attempts: sql`${supportLearningJobs.attempts} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(supportLearningJobs.tenantId, tenantId),
          inArray(
            supportLearningJobs.id,
            selected.map((row) => row.id),
          ),
          eq(supportLearningJobs.state, 'QUEUED'),
          free,
        ),
      )
      .returning();
    return rows.map(job);
  }

  /** Resolves a job, ONLY from QUEUED: a late second result writes nothing. */
  async finishJob(
    scope: ScopeContext,
    id: string,
    result: {
      readonly state: 'DONE' | 'FAILED';
      readonly outcome: SupportLearningJobOutcome;
      readonly candidateId?: string | null;
      readonly now: Date;
    },
    tx?: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await exec(this.db, tx)
      .update(supportLearningJobs)
      .set({
        state: result.state,
        outcome: result.outcome,
        candidateId: result.candidateId ?? null,
        claimedUntil: null,
        updatedAt: result.now,
      })
      .where(
        and(
          eq(supportLearningJobs.tenantId, tenantId),
          eq(supportLearningJobs.id, id),
          eq(supportLearningJobs.state, 'QUEUED'),
        ),
      )
      .returning({ id: supportLearningJobs.id });
    return rows.length > 0;
  }
}
