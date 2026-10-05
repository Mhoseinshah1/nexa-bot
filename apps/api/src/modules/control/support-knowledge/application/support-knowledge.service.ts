import {
  SUPPORT_KNOWLEDGE_ERROR_CODES,
  SUPPORT_KNOWLEDGE_LIMITS,
  errors,
  supportKnowledgeControlRequestSchema,
  supportKnowledgeCreateRequestSchema,
  supportKnowledgeEnabledRequestSchema,
  supportKnowledgeUpdateRequestSchema,
  supportLearningApproveRequestSchema,
  supportLearningRejectRequestSchema,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdGenerator,
  type IdempotencyStore,
  type OperationalEventRecorder,
  type PermissionKey,
  type ScopeContext,
  type SupportKnowledgeArticleState,
  type SupportKnowledgeContent,
  type SupportKnowledgeSource,
  type SupportLearningCandidateState,
  type UnitOfWork,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import {
  recordMutationDenial,
  runAuthorizedMutation,
} from '../../../platform/access/application/authorized-mutation.js';
import { rememberOnce } from '../../../platform/idempotency/application/remember-once.js';
import { hashRequest } from '../../../platform/idempotency/infrastructure/drizzle-idempotency-store.js';
import type { SessionRepository } from '../../../platform/identity/application/ports.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import { detectSensitive, scrubSensitive } from '../domain/scrubber.js';
import type {
  DrizzleSupportKnowledgeRepository,
  KnowledgeArticleRecord,
  KnowledgeRevisionRecord,
  LearningCandidateRecord,
} from '../infrastructure/drizzle-support-knowledge.repository.js';

export const SUPPORT_KNOWLEDGE_VIEW_PERMISSION = 'support_knowledge.view' satisfies PermissionKey;
export const SUPPORT_KNOWLEDGE_REVIEW_PERMISSION =
  'support_knowledge.review' satisfies PermissionKey;

/** How many rows a list answers with. Bounded; the knowledge base is small by design. */
export const SUPPORT_KNOWLEDGE_LIST_LIMIT = 500;

export interface SupportKnowledgeServiceDeps {
  readonly repository: DrizzleSupportKnowledgeRepository;
  readonly guard: PermissionGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly idempotency: IdempotencyStore;
  readonly scopeActivity: ScopeActivityReader;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

interface Remembered {
  readonly id: string;
}

interface CommandSpec {
  readonly action: string;
  readonly entityType: 'SupportKnowledgeArticle' | 'SupportLearningCandidate';
  readonly entityId: string | null;
  readonly idempotencyKey: string;
  readonly request: Record<string, unknown>;
}

interface Applied<T> {
  readonly result: T;
  readonly id: string;
  /** Null: nothing changed, so nothing is audited (the gateway rule). */
  readonly audit: {
    readonly entityId: string;
    readonly before: Record<string, unknown> | null;
    readonly after: Record<string, unknown>;
  } | null;
}

/**
 * TB8 — the support knowledge base and the review of learning candidates (ADR-0035, §29).
 *
 * Reads charge `support_knowledge.view`; every write charges `support_knowledge.review`, which
 * is HIGH because an approved article is what the support agent repeats to every customer.
 *
 * The rules, each a way to publish something nobody approved:
 *
 *   - Only an APPROVAL publishes. A candidate is `PENDING → APPROVED | REJECTED` by one
 *     conditional UPDATE naming `PENDING` and the version the reviewer read; approve and
 *     «edit then approve» insert the article, its first revision and the transition in ONE
 *     transaction, so a lost race publishes nothing.
 *   - Whatever becomes or stays knowledge is scrubbed as it is written: an approval (edited or
 *     not), an article created or edited, and a draft published. Text the scrubber matches is
 *     refused, whoever typed it and whatever the article's source.
 *   - An edit of APPROVED knowledge is a NEW revision; the old one stays (append-only table).
 *     An edit of a DRAFT publishes nothing.
 *   - Every command takes an idempotency key (a replay answers with the row as it is now),
 *     reads `ScopeActivityReader` inside its transaction, and is audited.
 */
export class SupportKnowledgeService {
  constructor(private readonly deps: SupportKnowledgeServiceDeps) {}

  // --- reads ---------------------------------------------------------------------

  async listArticles(
    scope: ScopeContext,
    actor: ActorContext,
    filter: {
      readonly source?: SupportKnowledgeSource | undefined;
      readonly state?: SupportKnowledgeArticleState | undefined;
    },
  ): Promise<readonly KnowledgeArticleRecord[]> {
    await this.deps.guard.check(scope, actor, SUPPORT_KNOWLEDGE_VIEW_PERMISSION);
    return this.deps.repository.listArticles(scope, filter, SUPPORT_KNOWLEDGE_LIST_LIMIT);
  }

  async revisions(
    scope: ScopeContext,
    actor: ActorContext,
    articleId: string,
  ): Promise<readonly KnowledgeRevisionRecord[]> {
    await this.deps.guard.check(scope, actor, SUPPORT_KNOWLEDGE_VIEW_PERMISSION);
    if ((await this.deps.repository.findArticle(scope, articleId)) === null)
      throw articleNotFound();
    return this.deps.repository.revisions(scope, articleId);
  }

  async listCandidates(
    scope: ScopeContext,
    actor: ActorContext,
    filter: { readonly state?: SupportLearningCandidateState | undefined },
  ): Promise<readonly LearningCandidateRecord[]> {
    await this.deps.guard.check(scope, actor, SUPPORT_KNOWLEDGE_VIEW_PERMISSION);
    return this.deps.repository.listCandidates(scope, filter, SUPPORT_KNOWLEDGE_LIST_LIMIT);
  }

  // --- articles --------------------------------------------------------------------

  /** A reviewer writes an article: published at once as revision 1, or saved as a DRAFT. */
  async createArticle(
    scope: ScopeContext,
    actor: ActorContext,
    body: unknown,
  ): Promise<KnowledgeArticleRecord> {
    const command = supportKnowledgeCreateRequestSchema.parse(body);
    const id = this.deps.ids.uuid();
    return this.command(
      scope,
      actor,
      {
        action: 'support_knowledge.article.create',
        entityType: 'SupportKnowledgeArticle',
        entityId: null,
        idempotencyKey: command.idempotencyKey,
        request: { content: command.content, publish: command.publish },
      },
      (rid) => this.articleOrNull(scope, rid),
      async (tx, now) => {
        assertClean(command.content);
        if (
          (await this.deps.repository.countArticles(scope, tx)) >= SUPPORT_KNOWLEDGE_LIMITS.articles
        ) {
          throw errors.conflict(
            SUPPORT_KNOWLEDGE_ERROR_CODES.LIMIT,
            'The knowledge base is full.',
            {
              limit: SUPPORT_KNOWLEDGE_LIMITS.articles,
            },
          );
        }
        const created = await this.deps.repository.insertArticle(
          scope,
          {
            id,
            source: 'MANUAL',
            state: command.publish ? 'APPROVED' : 'DRAFT',
            content: command.content,
            revision: command.publish ? 1 : 0,
            candidateId: null,
            createdByAdminId: actor.id,
            now,
          },
          tx,
        );
        if (command.publish) await this.recordRevision(scope, actor, created, 'MANUAL', now, tx);
        return {
          result: created,
          id,
          audit: { entityId: id, before: null, after: articleAudit(created) },
        };
      },
    );
  }

  /**
   * Edits an article's content. APPROVED: a new revision, published in the same statement.
   * DRAFT: the draft changes, nothing is published. RETIRED: refused.
   */
  async updateArticle(
    scope: ScopeContext,
    actor: ActorContext,
    articleId: string,
    body: unknown,
  ): Promise<KnowledgeArticleRecord> {
    const command = supportKnowledgeUpdateRequestSchema.parse(body);
    return this.command(
      scope,
      actor,
      {
        action: 'support_knowledge.article.update',
        entityType: 'SupportKnowledgeArticle',
        entityId: articleId,
        idempotencyKey: command.idempotencyKey,
        request: { articleId, expectedVersion: command.expectedVersion, content: command.content },
      },
      (rid) => this.articleOrNull(scope, rid),
      async (tx, now) => {
        const before = await this.requireArticle(scope, articleId, tx);
        assertVersion(before.version, command.expectedVersion);
        if (before.state === 'RETIRED') throw notInState(before.state);
        // Whatever the article's source: a LEARNED article edited after its approval is
        // republished, and a MANUAL one is repeated to every customer just the same.
        assertClean(command.content);
        const publish = before.state === 'APPROVED';
        const after = await this.deps.repository.rewrite(
          scope,
          articleId,
          {
            expectedVersion: command.expectedVersion,
            from: [before.state],
            content: command.content,
            publish,
            now,
          },
          tx,
        );
        if (after === null) throw await this.articleMoved(scope, articleId, tx);
        if (publish) await this.recordRevision(scope, actor, after, 'MANUAL', now, tx);
        return {
          result: after,
          id: articleId,
          audit: { entityId: articleId, before: articleAudit(before), after: articleAudit(after) },
        };
      },
    );
  }

  /** DRAFT → APPROVED: publishes the draft as the next revision. */
  async publishArticle(
    scope: ScopeContext,
    actor: ActorContext,
    articleId: string,
    body: unknown,
  ): Promise<KnowledgeArticleRecord> {
    return this.transition(scope, actor, articleId, body, {
      action: 'support_knowledge.article.publish',
      from: ['DRAFT'],
      to: 'APPROVED',
      publish: true,
    });
  }

  /** DRAFT | APPROVED → RETIRED. The revisions stay; the agent stops reading the article. */
  async retireArticle(
    scope: ScopeContext,
    actor: ActorContext,
    articleId: string,
    body: unknown,
  ): Promise<KnowledgeArticleRecord> {
    return this.transition(scope, actor, articleId, body, {
      action: 'support_knowledge.article.retire',
      from: ['DRAFT', 'APPROVED'],
      to: 'RETIRED',
      publish: false,
    });
  }

  /** Switches an article on or off. Already so: answered unchanged, with no audit row. */
  async setEnabled(
    scope: ScopeContext,
    actor: ActorContext,
    articleId: string,
    body: unknown,
  ): Promise<KnowledgeArticleRecord> {
    const command = supportKnowledgeEnabledRequestSchema.parse(body);
    return this.command(
      scope,
      actor,
      {
        action: 'support_knowledge.article.enabled',
        entityType: 'SupportKnowledgeArticle',
        entityId: articleId,
        idempotencyKey: command.idempotencyKey,
        request: { articleId, expectedVersion: command.expectedVersion, enabled: command.enabled },
      },
      (rid) => this.articleOrNull(scope, rid),
      async (tx, now) => {
        const before = await this.requireArticle(scope, articleId, tx);
        assertVersion(before.version, command.expectedVersion);
        if (before.enabled === command.enabled)
          return { result: before, id: articleId, audit: null };
        const after = await this.deps.repository.setEnabled(
          scope,
          articleId,
          { enabled: command.enabled, expectedVersion: command.expectedVersion, now },
          tx,
        );
        if (after === null) throw await this.articleMoved(scope, articleId, tx);
        return {
          result: after,
          id: articleId,
          audit: { entityId: articleId, before: articleAudit(before), after: articleAudit(after) },
        };
      },
    );
  }

  // --- candidates ------------------------------------------------------------------

  /**
   * Approve, or «edit then approve» (`edit` non-null): ONE transaction inserts the LEARNED
   * article, its revision 1 and moves the candidate `PENDING → APPROVED`. A candidate that
   * moved meanwhile, or whose version is not the reviewer's, publishes nothing.
   */
  async approveCandidate(
    scope: ScopeContext,
    actor: ActorContext,
    candidateId: string,
    body: unknown,
  ): Promise<LearningCandidateRecord> {
    const command = supportLearningApproveRequestSchema.parse(body);
    return this.command(
      scope,
      actor,
      {
        action: 'support_knowledge.candidate.approve',
        entityType: 'SupportLearningCandidate',
        entityId: candidateId,
        idempotencyKey: command.idempotencyKey,
        request: { candidateId, expectedVersion: command.expectedVersion, edit: command.edit },
      },
      (rid) => this.candidateOrNull(scope, rid),
      async (tx, now) => {
        const before = await this.requireCandidate(scope, candidateId, tx);
        if (before.state !== 'PENDING') throw notInState(before.state);
        assertVersion(before.version, command.expectedVersion);
        const content = command.edit ?? asProposed(before);
        // The last line before knowledge: whatever is approved, edited or not, is scrubbed.
        assertClean(content);
        if (
          (await this.deps.repository.countArticles(scope, tx)) >= SUPPORT_KNOWLEDGE_LIMITS.articles
        ) {
          throw errors.conflict(
            SUPPORT_KNOWLEDGE_ERROR_CODES.LIMIT,
            'The knowledge base is full.',
            {
              limit: SUPPORT_KNOWLEDGE_LIMITS.articles,
            },
          );
        }
        const article = await this.deps.repository.insertArticle(
          scope,
          {
            id: this.deps.ids.uuid(),
            source: 'LEARNED',
            state: 'APPROVED',
            content,
            revision: 1,
            candidateId,
            createdByAdminId: actor.id,
            now,
          },
          tx,
        );
        const after = await this.deps.repository.approveCandidate(
          scope,
          candidateId,
          {
            expectedVersion: command.expectedVersion,
            articleId: article.id,
            reviewerAdminId: this.reviewerOf(actor),
            now,
          },
          tx,
        );
        // Zero rows: it moved between the read and the write. The throw rolls the article back.
        if (after === null) throw await this.candidateMoved(scope, candidateId, tx);
        await this.recordRevision(scope, actor, article, 'CANDIDATE', now, tx);
        return {
          result: after,
          id: candidateId,
          audit: {
            entityId: candidateId,
            before: { state: before.state, version: before.version },
            after: {
              state: after.state,
              version: after.version,
              articleId: article.id,
              edited: command.edit !== null,
              title: content.title,
              category: content.category,
            },
          },
        };
      },
    );
  }

  /** PENDING → REJECTED. Terminal: a rejected lesson never enters knowledge, and is kept. */
  async rejectCandidate(
    scope: ScopeContext,
    actor: ActorContext,
    candidateId: string,
    body: unknown,
  ): Promise<LearningCandidateRecord> {
    const command = supportLearningRejectRequestSchema.parse(body);
    return this.command(
      scope,
      actor,
      {
        action: 'support_knowledge.candidate.reject',
        entityType: 'SupportLearningCandidate',
        entityId: candidateId,
        idempotencyKey: command.idempotencyKey,
        request: {
          candidateId,
          expectedVersion: command.expectedVersion,
          note: command.note ?? null,
        },
      },
      (rid) => this.candidateOrNull(scope, rid),
      async (tx, now) => {
        const before = await this.requireCandidate(scope, candidateId, tx);
        if (before.state !== 'PENDING') throw notInState(before.state);
        assertVersion(before.version, command.expectedVersion);
        const after = await this.deps.repository.rejectCandidate(
          scope,
          candidateId,
          {
            expectedVersion: command.expectedVersion,
            reviewerAdminId: this.reviewerOf(actor),
            now,
          },
          tx,
        );
        if (after === null) throw await this.candidateMoved(scope, candidateId, tx);
        return {
          result: after,
          id: candidateId,
          audit: {
            entityId: candidateId,
            before: { state: before.state, version: before.version },
            // The reviewer's note is free text about a customer's lesson: scrubbed like
            // everything else that is kept (PR #203 review), so the audit log holds no value.
            after: {
              state: after.state,
              version: after.version,
              note: command.note === undefined ? null : scrubSensitive(command.note).text,
            },
          },
        };
      },
    );
  }

  // -------------------------------------------------------------------------------

  private async transition(
    scope: ScopeContext,
    actor: ActorContext,
    articleId: string,
    body: unknown,
    spec: {
      readonly action: string;
      readonly from: readonly SupportKnowledgeArticleState[];
      readonly to: SupportKnowledgeArticleState;
      readonly publish: boolean;
    },
  ): Promise<KnowledgeArticleRecord> {
    const command = supportKnowledgeControlRequestSchema.parse(body);
    return this.command(
      scope,
      actor,
      {
        action: spec.action,
        entityType: 'SupportKnowledgeArticle',
        entityId: articleId,
        idempotencyKey: command.idempotencyKey,
        request: { articleId, expectedVersion: command.expectedVersion, to: spec.to },
      },
      (rid) => this.articleOrNull(scope, rid),
      async (tx, now) => {
        const before = await this.requireArticle(scope, articleId, tx);
        if (!spec.from.includes(before.state)) throw notInState(before.state);
        assertVersion(before.version, command.expectedVersion);
        // What is published is scrubbed as it is published, whoever wrote the draft and
        // whenever: the draft may predate a scrubber rule.
        if (spec.publish) assertClean(before);
        const after = await this.deps.repository.rewrite(
          scope,
          articleId,
          {
            expectedVersion: command.expectedVersion,
            from: spec.from,
            to: spec.to,
            publish: spec.publish,
            now,
          },
          tx,
        );
        if (after === null) throw await this.articleMoved(scope, articleId, tx);
        if (spec.publish) await this.recordRevision(scope, actor, after, 'MANUAL', now, tx);
        return {
          result: after,
          id: articleId,
          audit: { entityId: articleId, before: articleAudit(before), after: articleAudit(after) },
        };
      },
    );
  }

  /**
   * The write path, once: authorize (a denial audited), replay, then ONE transaction that
   * re-checks the session and permission, reads scope activity, applies, audits and remembers.
   */
  private async command<T>(
    scope: ScopeContext,
    actor: ActorContext,
    spec: CommandSpec,
    reread: (id: string) => Promise<T | null>,
    apply: (tx: TransactionScope, now: Date) => Promise<Applied<T>>,
  ): Promise<T> {
    const denial = { action: spec.action, entityType: spec.entityType, entityId: spec.entityId };
    try {
      await this.deps.guard.check(scope, actor, SUPPORT_KNOWLEDGE_REVIEW_PERMISSION);
    } catch (error) {
      await recordMutationDenial(
        this.mutationDeps(),
        scope,
        actor,
        SUPPORT_KNOWLEDGE_REVIEW_PERMISSION,
        denial,
        error,
      );
      throw error;
    }
    const requestHash = hashRequest({ action: spec.action, ...spec.request });
    const found = await this.deps.idempotency.find<Remembered>(
      scope,
      actor.surface,
      spec.idempotencyKey,
      requestHash,
    );
    if (found !== null) {
      const replayed = await reread(found.result.id);
      if (replayed !== null) return replayed;
    }
    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      SUPPORT_KNOWLEDGE_REVIEW_PERMISSION,
      denial,
      async (tx) => {
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
          throw errors.conflict(
            SUPPORT_KNOWLEDGE_ERROR_CODES.SCOPE_STOPPED,
            'This installation has stopped accepting work.',
          );
        }
        const applied = await apply(tx, this.deps.clock.now());
        if (applied.audit !== null) {
          await this.deps.audit.record(
            scope,
            actor,
            {
              action: spec.action,
              entityType: spec.entityType,
              entityId: applied.audit.entityId,
              before: applied.audit.before,
              after: applied.audit.after,
              result: 'SUCCESS',
            },
            tx,
          );
        }
        await rememberOnce(
          this.deps.idempotency,
          scope,
          actor.surface,
          spec.idempotencyKey,
          requestHash,
          { id: applied.id } satisfies Remembered,
          tx,
        );
        return applied.result;
      },
    );
  }

  private async recordRevision(
    scope: ScopeContext,
    actor: ActorContext,
    article: KnowledgeArticleRecord,
    origin: 'MANUAL' | 'CANDIDATE',
    now: Date,
    tx: TransactionScope,
  ): Promise<void> {
    await this.deps.repository.insertRevision(
      scope,
      { id: this.deps.ids.uuid(), article, origin, reviewerAdminId: actor.id, now },
      tx,
    );
  }

  private reviewerOf(actor: ActorContext): string {
    // Unreachable for a SYSTEM_JOB (it holds no review permission), and stated anyway.
    if (actor.id === null) {
      throw errors.permissionDenied('platform.permission_denied', 'Only an administrator reviews.');
    }
    return actor.id;
  }

  private articleOrNull(scope: ScopeContext, id: string) {
    return this.deps.repository.findArticle(scope, id);
  }

  private candidateOrNull(scope: ScopeContext, id: string) {
    return this.deps.repository.findCandidate(scope, id);
  }

  private async requireArticle(
    scope: ScopeContext,
    id: string,
    tx: TransactionScope,
  ): Promise<KnowledgeArticleRecord> {
    const found = await this.deps.repository.findArticle(scope, id, tx);
    if (found === null) throw articleNotFound();
    return found;
  }

  private async requireCandidate(
    scope: ScopeContext,
    id: string,
    tx: TransactionScope,
  ): Promise<LearningCandidateRecord> {
    const found = await this.deps.repository.findCandidate(scope, id, tx);
    if (found === null) {
      throw errors.notFound(
        SUPPORT_KNOWLEDGE_ERROR_CODES.CANDIDATE_NOT_FOUND,
        'No such candidate.',
      );
    }
    return found;
  }

  private async articleMoved(scope: ScopeContext, id: string, tx: TransactionScope) {
    const now = await this.requireArticle(scope, id, tx);
    return versionConflict(now.version);
  }

  private async candidateMoved(scope: ScopeContext, id: string, tx: TransactionScope) {
    const now = await this.requireCandidate(scope, id, tx);
    return now.state === 'PENDING' ? versionConflict(now.version) : notInState(now.state);
  }

  private mutationDeps() {
    return {
      uow: this.deps.uow,
      guard: this.deps.guard,
      audit: this.deps.audit,
      opsLog: this.deps.opsLog,
      sessions: this.deps.sessions,
      clock: this.deps.clock,
    };
  }
}

/** The candidate's own proposal as article content; refused when its text was purged. */
function asProposed(candidate: LearningCandidateRecord): SupportKnowledgeContent {
  if (candidate.body === null || candidate.title === null) {
    throw errors.conflict(
      SUPPORT_KNOWLEDGE_ERROR_CODES.NOT_IN_STATE,
      'This candidate’s text was purged. Approve it with an edit, or reject it.',
      { state: candidate.state, purged: true },
    );
  }
  return {
    title: candidate.title,
    body: candidate.body,
    category: candidate.category,
    tags: [...candidate.tags],
  };
}

/**
 * Refuses content the scrubber matches, whoever wrote it and whatever the article's source
 * (PR #203 review, finding 2; OQ-TB-54). Knowledge is what the support agent repeats to every
 * customer, so a support phone or an official link belongs in a template or a setting, not
 * here. Fail closed: a false positive costs the reviewer an edit.
 */
export function assertClean(content: {
  readonly title: string;
  readonly body: string;
  readonly tags: readonly string[];
}): void {
  const kinds = detectSensitive([content.title, content.body, content.tags.join(' ')].join('\n'));
  if (kinds.length > 0) {
    throw errors.conflict(
      SUPPORT_KNOWLEDGE_ERROR_CODES.SENSITIVE_CONTENT,
      'The text still contains personal or secret data. Edit it out and approve again.',
      { kinds },
    );
  }
}

function articleAudit(row: KnowledgeArticleRecord): Record<string, unknown> {
  return {
    source: row.source,
    state: row.state,
    enabled: row.enabled,
    title: row.title,
    category: row.category,
    tags: [...row.tags],
    revision: row.revision,
    version: row.version,
  };
}

function assertVersion(current: number, expected: number): void {
  if (current !== expected) throw versionConflict(current);
}

function versionConflict(currentVersion: number) {
  return errors.conflict(
    SUPPORT_KNOWLEDGE_ERROR_CODES.VERSION_CONFLICT,
    'This item changed since it was read. Reload it and apply the change again.',
    { currentVersion },
  );
}

function notInState(state: string) {
  return errors.conflict(
    SUPPORT_KNOWLEDGE_ERROR_CODES.NOT_IN_STATE,
    'This item is not in a state that allows the change.',
    { state },
  );
}

function articleNotFound() {
  return errors.notFound(SUPPORT_KNOWLEDGE_ERROR_CODES.NOT_FOUND, 'No such knowledge article.');
}
