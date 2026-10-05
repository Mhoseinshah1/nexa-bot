import {
  SUPPORT_KNOWLEDGE_BUILD_ERROR_CODES,
  SUPPORT_KNOWLEDGE_BUILD_LIMITS,
  SUPPORT_KNOWLEDGE_ERROR_CODES,
  errors,
  supportKnowledgeBuildApplyRequestSchema,
  supportKnowledgeBuildResolveRequestSchema,
  supportKnowledgeBuildRunRequestSchema,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdGenerator,
  type IdempotencyStore,
  type OperationalEventRecorder,
  type ScopeContext,
  type TenantContext,
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
import { diffBuild, type BuildItem, type BuiltArticle } from '../domain/build-diff.js';
import type {
  DrizzleSupportKnowledgeRepository,
  KnowledgeBuildCounts,
  KnowledgeBuildRecord,
  KnowledgeProposalRecord,
  NewProposal,
} from '../infrastructure/drizzle-support-knowledge.repository.js';
import {
  SUPPORT_KNOWLEDGE_REVIEW_PERMISSION,
  SUPPORT_KNOWLEDGE_VIEW_PERMISSION,
} from './support-knowledge.service.js';

/**
 * The allowlisted sources, behind a port (ADR-0035 §5). The one implementation reads each
 * source's customer-facing fields and nothing else; a test pins the source list exactly.
 */
export interface KnowledgeBuildSources {
  collect(scope: TenantContext): Promise<readonly BuildItem[]>;
}

export interface SupportKnowledgeBuildServiceDeps {
  readonly repository: DrizzleSupportKnowledgeRepository;
  readonly sources: KnowledgeBuildSources;
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

export interface KnowledgeBuildDetail {
  readonly build: KnowledgeBuildRecord;
  readonly proposals: readonly KnowledgeProposalRecord[];
}

export interface KnowledgeBuildApplyResult {
  readonly applied: number;
  readonly conflicted: number;
}

/**
 * TB9 — «ساخت/به‌روزرسانی دانش پشتیبان از اطلاعات NEXA» (program §30, §39; ADR-0035 §5).
 *
 * The build PROPOSES; a reviewer applies. The rules, each a way to put something in the
 * knowledge base that nobody chose:
 *
 *   - Only allowlisted sources are read, through `KnowledgeBuildSources`, customer-facing
 *     fields only. No table is read by the build for its own sake.
 *   - A run writes a change-set (one OPEN build, its proposals) and changes no article.
 *   - A proposal is keyed by `(source type, source key)` and matched only to the NEXA_BUILD
 *     article built from it; MANUAL and LEARNED knowledge is never matched or touched.
 *   - An article a reviewer edited since the last build apply is a CONFLICT. It is never
 *     applied by «apply all», only by an explicit choice: TAKE_BUILD (a new revision with the
 *     build's text) or KEEP_CURRENT (the edit stays; the source text is acknowledged).
 *   - Every apply is conditional on the revision the build saw. An article that moved since
 *     turns its UPDATE into a CONFLICT instead of being overwritten.
 *   - Running, applying and resolving charge `support_knowledge.review`; each is idempotent,
 *     audited and reads `ScopeActivityReader` inside its transaction.
 */
export class SupportKnowledgeBuildService {
  constructor(private readonly deps: SupportKnowledgeBuildServiceDeps) {}

  /** The latest build and its proposals, or null when none was ever run. */
  async latest(scope: TenantContext, actor: ActorContext): Promise<KnowledgeBuildDetail | null> {
    await this.deps.guard.check(scope, actor, SUPPORT_KNOWLEDGE_VIEW_PERMISSION);
    const build = await this.deps.repository.latestBuild(scope);
    if (build === null) return null;
    return { build, proposals: await this.deps.repository.proposals(scope, build.id) };
  }

  /** Runs the build: reads the sources, diffs, writes ONE open change-set. Changes no article. */
  async run(
    scope: TenantContext,
    actor: ActorContext,
    body: unknown,
  ): Promise<KnowledgeBuildDetail> {
    const command = supportKnowledgeBuildRunRequestSchema.parse(body);
    const denial = {
      action: 'support_knowledge.build.run',
      entityType: 'SupportKnowledgeBuild',
      entityId: null,
    };
    await this.authorize(scope, actor, denial);
    const requestHash = hashRequest({ action: denial.action });
    const replay = await this.deps.idempotency.find<{ id: string }>(
      scope,
      actor.surface,
      command.idempotencyKey,
      requestHash,
    );
    if (replay !== null) {
      const build = await this.deps.repository.findBuild(scope, replay.result.id);
      if (build !== null) {
        return { build, proposals: await this.deps.repository.proposals(scope, build.id) };
      }
    }
    // Read OUTSIDE the transaction: a source read takes no lock and changes nothing.
    const items = (await this.deps.sources.collect(scope)).slice(
      0,
      SUPPORT_KNOWLEDGE_BUILD_LIMITS.proposals,
    );
    const id = this.deps.ids.uuid();
    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      SUPPORT_KNOWLEDGE_REVIEW_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const now = this.deps.clock.now();
        const built = (await this.deps.repository.listBuilt(scope, tx)).flatMap(
          (row): BuiltArticle[] =>
            row.sourceType === null || row.sourceKey === null
              ? []
              : [
                  {
                    id: row.id,
                    sourceType: row.sourceType,
                    sourceKey: row.sourceKey,
                    state: row.state,
                    revision: row.revision,
                    builtRevision: row.builtRevision,
                    builtHash: row.builtHash,
                    title: row.title,
                    body: row.body,
                  },
                ],
        );
        const drafts = diffBuild(items, built);
        const proposals: NewProposal[] = drafts.map((draft) => ({
          id: this.deps.ids.uuid(),
          sourceType: draft.item.sourceType,
          sourceKey: draft.item.sourceKey,
          kind: draft.kind,
          content: draft.item.content,
          hash: draft.hash,
          articleId: draft.article?.id ?? null,
          baseRevision: draft.article?.revision ?? null,
          baseTitle: draft.article?.title ?? null,
          baseBody: draft.article?.body ?? null,
        }));
        const counts: KnowledgeBuildCounts = {
          add: proposals.filter((p) => p.kind === 'ADD').length,
          update: proposals.filter((p) => p.kind === 'UPDATE').length,
          unchanged: proposals.filter((p) => p.kind === 'UNCHANGED').length,
          conflict: proposals.filter((p) => p.kind === 'CONFLICT').length,
        };
        await this.deps.repository.supersedeOpenBuild(scope, now, tx);
        await this.deps.repository.insertBuild(
          scope,
          { id, createdByAdminId: actor.id, counts, now },
          proposals,
          tx,
        );
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: denial.action,
            entityType: 'SupportKnowledgeBuild',
            entityId: id,
            before: null,
            after: { ...counts },
            result: 'SUCCESS',
          },
          tx,
        );
        await rememberOnce(
          this.deps.idempotency,
          scope,
          actor.surface,
          command.idempotencyKey,
          requestHash,
          { id },
          tx,
        );
        const build = await this.deps.repository.findBuild(scope, id, tx);
        if (build === null)
          throw errors.internal('support_knowledge.build_missing', 'Build vanished.');
        return { build, proposals: await this.deps.repository.proposals(scope, id, tx) };
      },
    );
  }

  /**
   * Applies the named PENDING proposals, or every non-conflicting one (`proposalIds` null).
   * ADD and UPDATE only; a CONFLICT is never applied here, whatever is named.
   */
  async apply(
    scope: TenantContext,
    actor: ActorContext,
    buildId: string,
    body: unknown,
  ): Promise<KnowledgeBuildApplyResult> {
    const command = supportKnowledgeBuildApplyRequestSchema.parse(body);
    const denial = {
      action: 'support_knowledge.build.apply',
      entityType: 'SupportKnowledgeBuild',
      entityId: buildId,
    };
    await this.authorize(scope, actor, denial);
    const requestHash = hashRequest({
      action: denial.action,
      buildId,
      proposalIds: command.proposalIds,
    });
    const replay = await this.deps.idempotency.find<KnowledgeBuildApplyResult>(
      scope,
      actor.surface,
      command.idempotencyKey,
      requestHash,
    );
    if (replay !== null) return replay.result;
    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      SUPPORT_KNOWLEDGE_REVIEW_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const now = this.deps.clock.now();
        await this.requireOpenBuild(scope, buildId, tx);
        const wanted = command.proposalIds === null ? null : new Set(command.proposalIds);
        const targets = (await this.deps.repository.proposals(scope, buildId, tx)).filter(
          (p) =>
            p.state === 'PENDING' &&
            (p.kind === 'ADD' || p.kind === 'UPDATE') &&
            (wanted === null || wanted.has(p.id)),
        );
        const applied: string[] = [];
        const conflicted: string[] = [];
        for (const target of targets) {
          const outcome =
            target.kind === 'ADD'
              ? await this.applyAdd(scope, actor, target, now, tx)
              : await this.applyUpdate(scope, actor, target, now, tx);
          if (outcome === 'APPLIED') applied.push(target.id);
          if (outcome === 'CONFLICT') conflicted.push(target.id);
        }
        const result: KnowledgeBuildApplyResult = {
          applied: applied.length,
          conflicted: conflicted.length,
        };
        if (applied.length > 0 || conflicted.length > 0) {
          await this.deps.audit.record(
            scope,
            actor,
            {
              action: denial.action,
              entityType: 'SupportKnowledgeBuild',
              entityId: buildId,
              before: null,
              after: { applied, conflicted },
              result: 'SUCCESS',
            },
            tx,
          );
        }
        await rememberOnce(
          this.deps.idempotency,
          scope,
          actor.surface,
          command.idempotencyKey,
          requestHash,
          result,
          tx,
        );
        return result;
      },
    );
  }

  /** The reviewer's explicit choice on one CONFLICT. */
  async resolve(
    scope: TenantContext,
    actor: ActorContext,
    proposalId: string,
    body: unknown,
  ): Promise<KnowledgeProposalRecord> {
    const command = supportKnowledgeBuildResolveRequestSchema.parse(body);
    const denial = {
      action: 'support_knowledge.build.resolve',
      entityType: 'SupportKnowledgeProposal',
      entityId: proposalId,
    };
    await this.authorize(scope, actor, denial);
    const requestHash = hashRequest({ action: denial.action, proposalId, choice: command.choice });
    const replay = await this.deps.idempotency.find<{ id: string }>(
      scope,
      actor.surface,
      command.idempotencyKey,
      requestHash,
    );
    if (replay !== null) {
      const found = await this.deps.repository.findProposal(scope, replay.result.id);
      if (found !== null) return found;
    }
    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      SUPPORT_KNOWLEDGE_REVIEW_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const now = this.deps.clock.now();
        const proposal = await this.deps.repository.findProposal(scope, proposalId, tx);
        if (proposal === null) {
          throw errors.notFound(
            SUPPORT_KNOWLEDGE_BUILD_ERROR_CODES.PROPOSAL_NOT_FOUND,
            'No such proposal.',
          );
        }
        await this.requireOpenBuild(scope, proposal.buildId, tx);
        if (proposal.kind !== 'CONFLICT' || proposal.state !== 'PENDING') {
          throw errors.conflict(
            SUPPORT_KNOWLEDGE_BUILD_ERROR_CODES.NOT_A_CONFLICT,
            'Only a pending conflict takes a choice.',
            { kind: proposal.kind, state: proposal.state },
          );
        }
        const articleId = proposal.articleId;
        const baseRevision = proposal.baseRevision;
        if (articleId === null || baseRevision === null) {
          throw errors.internal('support_knowledge.conflict_shape', 'A conflict names no article.');
        }
        if (command.choice === 'TAKE_BUILD') {
          const after = await this.deps.repository.rewriteBuilt(
            scope,
            articleId,
            { baseRevision, unedited: false, content: proposal.content, hash: proposal.hash, now },
            tx,
          );
          if (after === null) throw baseMoved();
          await this.deps.repository.insertRevision(
            scope,
            {
              id: this.deps.ids.uuid(),
              article: after,
              origin: 'BUILD',
              reviewerAdminId: actor.id,
              now,
            },
            tx,
          );
        } else if (
          !(await this.deps.repository.acknowledgeBuilt(
            scope,
            articleId,
            { baseRevision, hash: proposal.hash, now },
            tx,
          ))
        ) {
          throw baseMoved();
        }
        const decided = await this.deps.repository.decideProposal(
          scope,
          proposalId,
          {
            kind: 'CONFLICT',
            to: command.choice === 'TAKE_BUILD' ? 'APPLIED' : 'SKIPPED',
            resolution: command.choice,
            adminId: actor.id,
            now,
          },
          tx,
        );
        if (!decided) throw baseMoved();
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: denial.action,
            entityType: 'SupportKnowledgeProposal',
            entityId: proposalId,
            before: { kind: 'CONFLICT', state: 'PENDING', baseRevision },
            after: { choice: command.choice, articleId },
            result: 'SUCCESS',
          },
          tx,
        );
        await rememberOnce(
          this.deps.idempotency,
          scope,
          actor.surface,
          command.idempotencyKey,
          requestHash,
          { id: proposalId },
          tx,
        );
        const found = await this.deps.repository.findProposal(scope, proposalId, tx);
        if (found === null) throw errors.internal('support_knowledge.proposal_missing', 'Gone.');
        return found;
      },
    );
  }

  // -------------------------------------------------------------------------------

  /** Claims the proposal first: a concurrent apply of the same proposal adds nothing. */
  private async applyAdd(
    scope: ScopeContext,
    actor: ActorContext,
    target: KnowledgeProposalRecord,
    now: Date,
    tx: TransactionScope,
  ): Promise<'APPLIED' | 'SKIPPED'> {
    const existing = (await this.deps.repository.listBuilt(scope, tx)).find(
      (row) => row.sourceType === target.sourceType && row.sourceKey === target.sourceKey,
    );
    // An article for this source appeared since the build: never a second one.
    if (existing !== undefined) return 'SKIPPED';
    const articleId = this.deps.ids.uuid();
    const claimed = await this.deps.repository.decideProposal(
      scope,
      target.id,
      { kind: 'ADD', to: 'APPLIED', resolution: null, adminId: actor.id, now },
      tx,
    );
    if (!claimed) return 'SKIPPED';
    const article = await this.deps.repository.insertArticle(
      scope,
      {
        id: articleId,
        source: 'NEXA_BUILD',
        state: 'APPROVED',
        content: target.content,
        revision: 1,
        candidateId: null,
        createdByAdminId: actor.id,
        built: { sourceType: target.sourceType, sourceKey: target.sourceKey, hash: target.hash },
        now,
      },
      tx,
    );
    await this.deps.repository.insertRevision(
      scope,
      { id: this.deps.ids.uuid(), article, origin: 'BUILD', reviewerAdminId: actor.id, now },
      tx,
    );
    return 'APPLIED';
  }

  /** Rewrites first, conditional on the base: an article that moved becomes a CONFLICT. */
  private async applyUpdate(
    scope: ScopeContext,
    actor: ActorContext,
    target: KnowledgeProposalRecord,
    now: Date,
    tx: TransactionScope,
  ): Promise<'APPLIED' | 'CONFLICT' | 'SKIPPED'> {
    if (target.articleId === null || target.baseRevision === null) return 'SKIPPED';
    const after = await this.deps.repository.rewriteBuilt(
      scope,
      target.articleId,
      {
        baseRevision: target.baseRevision,
        unedited: true,
        content: target.content,
        hash: target.hash,
        now,
      },
      tx,
    );
    if (after === null) {
      return (await this.deps.repository.markConflict(scope, target.id, now, tx))
        ? 'CONFLICT'
        : 'SKIPPED';
    }
    const decided = await this.deps.repository.decideProposal(
      scope,
      target.id,
      { kind: 'UPDATE', to: 'APPLIED', resolution: null, adminId: actor.id, now },
      tx,
    );
    if (!decided) throw baseMoved();
    await this.deps.repository.insertRevision(
      scope,
      { id: this.deps.ids.uuid(), article: after, origin: 'BUILD', reviewerAdminId: actor.id, now },
      tx,
    );
    return 'APPLIED';
  }

  /** Locks the build; a superseded one applies nothing. */
  private async requireOpenBuild(
    scope: ScopeContext,
    buildId: string,
    tx: TransactionScope,
  ): Promise<KnowledgeBuildRecord> {
    const build = await this.deps.repository.lockBuild(scope, buildId, tx);
    if (build === null) {
      throw errors.notFound(SUPPORT_KNOWLEDGE_BUILD_ERROR_CODES.BUILD_NOT_FOUND, 'No such build.');
    }
    if (build.state !== 'OPEN') {
      throw errors.conflict(
        SUPPORT_KNOWLEDGE_BUILD_ERROR_CODES.BUILD_SUPERSEDED,
        'A newer build replaced this one. Review the newest build instead.',
      );
    }
    return build;
  }

  private async authorize(
    scope: ScopeContext,
    actor: ActorContext,
    denial: { action: string; entityType: string; entityId: string | null },
  ): Promise<void> {
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
  }

  private async assertScopeActive(scope: ScopeContext, tx: TransactionScope): Promise<void> {
    if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
      throw errors.conflict(
        SUPPORT_KNOWLEDGE_ERROR_CODES.SCOPE_STOPPED,
        'This installation has stopped accepting work.',
      );
    }
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

function baseMoved() {
  return errors.conflict(
    SUPPORT_KNOWLEDGE_BUILD_ERROR_CODES.BASE_MOVED,
    'The article changed since this build ran. Run the build again.',
  );
}
