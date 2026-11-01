import { createHash } from 'node:crypto';
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
  type PermissionKey,
  type SettingKey,
  type ScopeContext,
  type SupportKnowledgeBuildSourceType,
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
import { isUniqueViolation } from '../../../../infrastructure/persistence/sqlstate.js';
import { diffBuild, sourceRef, type BuildItem, type BuiltArticle } from '../domain/build-diff.js';
import type {
  DrizzleSupportKnowledgeRepository,
  KnowledgeBuildCounts,
  KnowledgeBuildRecord,
  KnowledgeProposalRecord,
  NewProposal,
} from '../infrastructure/drizzle-support-knowledge.repository.js';
import { detectSensitive } from '../domain/scrubber.js';
import {
  SUPPORT_KNOWLEDGE_REVIEW_PERMISSION,
  SUPPORT_KNOWLEDGE_VIEW_PERMISSION,
  articleAudit,
  assertClean,
} from './support-knowledge.service.js';
import type { SettingsResolver } from '../../settings/application/settings-resolver.js';

/**
 * The allowlisted sources, behind a port (ADR-0035 §5). The one implementation reads each
 * source's customer-facing fields and nothing else; a test pins the source list exactly.
 */
export interface KnowledgeBuildSources {
  collect(scope: TenantContext): Promise<KnowledgeBuildCollection>;
}

/** What the sources yielded, and what their bounds did to it (N2). */
export interface KnowledgeBuildCollection {
  readonly items: readonly BuildItem[];
  /** Items whose title or body was clipped to the article bounds. */
  readonly truncated: number;
  /** Items a per-source bound dropped (at least: a bounded read knows only "more"). */
  readonly capped: number;
  /** Source types whose read a bound cut short: a key missing from them proves nothing. */
  readonly incomplete: readonly SupportKnowledgeBuildSourceType[];
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
  /** L3: the `support.accounts` handles, which a built article may name. */
  readonly settings: Pick<SettingsResolver, 'valueOf'>;
}

export interface KnowledgeBuildDetail {
  readonly build: KnowledgeBuildRecord;
  readonly proposals: readonly KnowledgeProposalRecord[];
}

export interface KnowledgeBuildApplyResult {
  readonly applied: number;
  readonly conflicted: number;
  readonly skipped: number;
}

type ApplyOutcome = 'APPLIED' | 'CONFLICT' | 'SKIPPED' | 'NONE';

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
    const {
      items,
      present,
      incomplete,
      capped,
      excluded,
      truncated: collectedTruncated,
    } = await this.collectItems(scope);
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
        const built = await this.builtArticles(scope, tx);
        const drafts = diffBuild(items, built, { present, incomplete });
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
          retire: proposals.filter((p) => p.kind === 'RETIRE').length,
        };
        const truncated = collectedTruncated;
        await this.deps.repository.supersedeOpenBuild(scope, now, tx);
        try {
          await this.deps.repository.insertBuild(
            scope,
            { id, createdByAdminId: adminOf(actor), counts, truncated, capped, now },
            proposals,
            tx,
          );
        } catch (error) {
          // Two runs at once (N1): each superseded the open build it could see, and the partial
          // unique index lets one OPEN build per tenant commit. The loser is told so, cleanly;
          // the newest build is the winner's.
          if (isUniqueViolation(error, 'support_knowledge_builds_open_key')) {
            throw errors.conflict(
              SUPPORT_KNOWLEDGE_BUILD_ERROR_CODES.BUILD_RUNNING,
              'Another build of this knowledge ran at the same time. Review the newest build.',
            );
          }
          throw error;
        }
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: denial.action,
            entityType: 'SupportKnowledgeBuild',
            entityId: id,
            before: null,
            after: { ...counts, excluded, truncated, capped },
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
   * Applies the named PENDING proposals, or every pending ADD and UPDATE (`proposalIds` null).
   * A CONFLICT is never applied here, whatever is named; a RETIRE only when named — a source
   * that left the allowlist is a reviewer's decision, never «apply all».
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
            (p.kind === 'ADD' || p.kind === 'UPDATE' || (p.kind === 'RETIRE' && wanted !== null)) &&
            (wanted === null || wanted.has(p.id)),
        );
        const applied: string[] = [];
        const conflicted: string[] = [];
        const skipped: string[] = [];
        for (const target of targets) {
          const outcome =
            target.kind === 'ADD'
              ? await this.applyAdd(scope, actor, target, now, tx)
              : target.kind === 'UPDATE'
                ? await this.applyUpdate(scope, actor, target, now, tx)
                : await this.applyRetire(scope, actor, target, now, tx);
          if (outcome === 'APPLIED') applied.push(target.id);
          if (outcome === 'CONFLICT') conflicted.push(target.id);
          if (outcome === 'SKIPPED') skipped.push(target.id);
        }
        const result: KnowledgeBuildApplyResult = {
          applied: applied.length,
          conflicted: conflicted.length,
          skipped: skipped.length,
        };
        if (applied.length > 0 || conflicted.length > 0 || skipped.length > 0) {
          // The counts follow the proposals' kinds (N3): a CONFLICT found here is one now.
          await this.deps.repository.recountBuild(scope, buildId, now, tx);
          await this.deps.audit.record(
            scope,
            actor,
            {
              action: denial.action,
              entityType: 'SupportKnowledgeBuild',
              entityId: buildId,
              before: null,
              after: { applied, conflicted, skipped },
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
          assertClean(proposal.content, await this.supportHandles(scope), proposal.sourceType);
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
              reviewerAdminId: adminOf(actor),
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
            adminId: adminOf(actor),
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

  /**
   * Phase 4 PR-2 — the AUTOMATIC refresh (`support.knowledge.auto_refresh`, off by default),
   * driven by the worker's `SupportKnowledgeRefreshLoop` as `SYSTEM_JOB`: two minutes after the
   * owner's content stops changing, and once a night.
   *
   * The same build as «run» — the allowlisted sources through the business allowlist, the same
   * diff — and, in the SAME transaction, the apply of every ADD, UPDATE and RETIRE: the sources
   * are all owner-owned content, so nothing here needs a reviewer. A CONFLICT (a reviewer edited
   * the article since) is never applied: it stays PENDING in the build for a person. MANUAL and
   * LEARNED knowledge is never matched, so a lesson learned from a chat still needs approval.
   * Every per-proposal guard of «apply» holds: an article that moved becomes a CONFLICT, one
   * retired since is skipped.
   *
   * Nothing is written when the diff changes nothing. Charges `maintenance.run` (what a
   * `SYSTEM_JOB` holds); idempotent by the diff's own signature (a replica that computed the same
   * change answers with the first one's result); scope activity is read inside the transaction;
   * audited as `support_knowledge.build.auto_refresh`. No customer is told anything.
   */
  async autoRefresh(
    scope: TenantContext,
    actor: ActorContext,
  ): Promise<KnowledgeAutoRefreshResult> {
    if (!(await this.deps.settings.valueOf<boolean>(scope, SUPPORT_KNOWLEDGE_AUTO_REFRESH_KEY))) {
      return { outcome: 'OFF' };
    }
    const denial = {
      action: 'support_knowledge.build.auto_refresh',
      entityType: 'SupportKnowledgeBuild',
      entityId: null,
    };
    const collected = await this.collectItems(scope);
    const preview = diffBuild(collected.items, await this.builtArticles(scope), {
      present: collected.present,
      incomplete: collected.incomplete,
    });
    const signature = buildSignature(preview);
    if (signature === null) return { outcome: 'UNCHANGED' };
    const idempotencyKey = `support_knowledge.auto_refresh:${signature}`;
    const requestHash = hashRequest({ action: denial.action, signature });
    const replay = await this.deps.idempotency.find<KnowledgeAutoRefreshResult>(
      scope,
      actor.surface,
      idempotencyKey,
      requestHash,
    );
    if (replay !== null) return replay.result;
    const id = this.deps.ids.uuid();
    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      SUPPORT_KNOWLEDGE_AUTO_REFRESH_PERMISSION,
      denial,
      async (tx) => {
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
          return { outcome: 'INACTIVE' } as const;
        }
        const now = this.deps.clock.now();
        // Re-diffed inside the transaction: the articles as they are NOW decide.
        const drafts = diffBuild(collected.items, await this.builtArticles(scope, tx), {
          present: collected.present,
          incomplete: collected.incomplete,
        });
        if (buildSignature(drafts) === null) return { outcome: 'UNCHANGED' } as const;
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
          retire: proposals.filter((p) => p.kind === 'RETIRE').length,
        };
        await this.deps.repository.supersedeOpenBuild(scope, now, tx);
        try {
          await this.deps.repository.insertBuild(
            scope,
            {
              id,
              createdByAdminId: null,
              counts,
              truncated: collected.truncated,
              capped: collected.capped,
              now,
            },
            proposals,
            tx,
          );
        } catch (error) {
          // A person's «run» (or another replica) committed an OPEN build meanwhile: theirs
          // stands; the next pass diffs again.
          if (isUniqueViolation(error, 'support_knowledge_builds_open_key')) {
            return { outcome: 'BUSY' } as const;
          }
          throw error;
        }
        const targets = (await this.deps.repository.proposals(scope, id, tx)).filter(
          (p) =>
            p.state === 'PENDING' &&
            (p.kind === 'ADD' || p.kind === 'UPDATE' || p.kind === 'RETIRE'),
        );
        let applied = 0;
        let conflicted = 0;
        let skipped = 0;
        for (const target of targets) {
          const outcome =
            target.kind === 'ADD'
              ? await this.applyAdd(scope, actor, target, now, tx)
              : target.kind === 'UPDATE'
                ? await this.applyUpdate(scope, actor, target, now, tx)
                : await this.applyRetire(scope, actor, target, now, tx);
          if (outcome === 'APPLIED') applied += 1;
          if (outcome === 'CONFLICT') conflicted += 1;
          if (outcome === 'SKIPPED') skipped += 1;
        }
        await this.deps.repository.recountBuild(scope, id, now, tx);
        const result: KnowledgeAutoRefreshResult = {
          outcome: 'REFRESHED',
          buildId: id,
          applied,
          conflicted: conflicted + counts.conflict,
          skipped,
          capped: collected.capped,
        };
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: denial.action,
            entityType: 'SupportKnowledgeBuild',
            entityId: id,
            before: null,
            after: {
              ...counts,
              applied,
              conflicted: result.conflicted,
              skipped,
              excluded: collected.excluded,
              truncated: collected.truncated,
              capped: collected.capped,
            },
            result: 'SUCCESS',
          },
          tx,
        );
        await rememberOnce(
          this.deps.idempotency,
          scope,
          actor.surface,
          idempotencyKey,
          requestHash,
          result,
          tx,
        );
        return result;
      },
    );
  }

  /**
   * Phase 4 PR-2: the signature of the change the automatic refresh WOULD apply now, or null
   * (the setting off, or nothing changes). A READ: the debounce compares it between passes.
   */
  async pendingRefreshSignature(scope: TenantContext): Promise<string | null> {
    if (!(await this.deps.settings.valueOf<boolean>(scope, SUPPORT_KNOWLEDGE_AUTO_REFRESH_KEY))) {
      return null;
    }
    const collected = await this.collectItems(scope);
    return buildSignature(
      diffBuild(collected.items, await this.builtArticles(scope), {
        present: collected.present,
        incomplete: collected.incomplete,
      }),
    );
  }

  /**
   * The allowlisted sources' items, filtered through each source's business allowlist
   * (`detectSensitive` with `business`): what «run» and the automatic refresh both diff.
   */
  private async collectItems(scope: TenantContext) {
    const collection = await this.deps.sources.collect(scope);
    const collected = collection.items.slice(0, SUPPORT_KNOWLEDGE_BUILD_LIMITS.proposals);
    // What the per-build bound drops is counted, and its types are incomplete: no RETIRE for
    // an article whose source is merely beyond the bound (N2, S2).
    const overflow = collection.items.slice(SUPPORT_KNOWLEDGE_BUILD_LIMITS.proposals);
    const capped = collection.capped + overflow.length;
    const incomplete = new Set<SupportKnowledgeBuildSourceType>([
      ...collection.incomplete,
      ...overflow.map((item) => item.sourceType),
    ]);
    // A source the allowlist still yields is present, whether or not the scrubber excludes it
    // from the change-set below: an excluded source is not a retired one.
    const present = new Set(collection.items.map((i) => sourceRef(i.sourceType, i.sourceKey)));
    // Fail closed (TB9 × TB8 review): every article passes `assertClean`, so a source item the
    // scrubber matches is EXCLUDED from the change-set rather than proposed and refused at
    // apply. Phase 4 PR-2: through the source's BUSINESS ALLOWLIST — what it publishes to its
    // customers (links, prices, a payment route's card number) stays; a subscription link, a
    // secret, a phone, an e-mail or a stranger's handle still excludes the item. Only the count
    // and the kinds are recorded, never the text (OQ-TB-66).
    const excludedKinds = new Set<string>();
    // L3: the installation's own support handles are not personal data; every other handle is.
    const allowedHandles = await this.supportHandles(scope);
    const items = collected.filter((item) => {
      const kinds = detectSensitive(
        [item.content.title, item.content.body, item.content.tags.join(' ')].join('\n'),
        { allowedHandles, business: item.sourceType },
      );
      for (const kind of kinds) excludedKinds.add(kind);
      return kinds.length === 0;
    });
    return {
      items,
      present,
      incomplete,
      capped,
      truncated: collection.truncated,
      excluded: { count: collected.length - items.length, kinds: [...excludedKinds].sort() },
    };
  }

  /** The NEXA_BUILD articles, as the diff reads them. */
  private async builtArticles(scope: ScopeContext, tx?: TransactionScope): Promise<BuiltArticle[]> {
    return (await this.deps.repository.listBuilt(scope, tx)).flatMap((row): BuiltArticle[] =>
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
              category: row.category,
              tags: row.tags,
            },
          ],
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
  ): Promise<ApplyOutcome> {
    const existing = (await this.deps.repository.listBuilt(scope, tx)).find(
      (row) => row.sourceType === target.sourceType && row.sourceKey === target.sourceKey,
    );
    // An article for this source appeared since the build: never a second one. The proposal
    // is closed as SKIPPED (S4) — left PENDING it would be offered, and refused, for ever.
    if (existing !== undefined) return this.skip(scope, actor, target, now, tx);
    const articleId = this.deps.ids.uuid();
    const claimed = await this.deps.repository.decideProposal(
      scope,
      target.id,
      { kind: 'ADD', to: 'APPLIED', resolution: null, adminId: adminOf(actor), now },
      tx,
    );
    // A concurrent apply of the same build took it: that one answers for it.
    if (!claimed) return 'NONE';
    // The backstop: no write path puts unclean text in an article, the build's included.
    assertClean(target.content, await this.supportHandles(scope), target.sourceType);
    const article = await this.deps.repository.insertArticle(
      scope,
      {
        id: articleId,
        source: 'NEXA_BUILD',
        state: 'APPROVED',
        content: target.content,
        revision: 1,
        candidateId: null,
        createdByAdminId: adminOf(actor),
        built: { sourceType: target.sourceType, sourceKey: target.sourceKey, hash: target.hash },
        now,
      },
      tx,
    );
    await this.deps.repository.insertRevision(
      scope,
      { id: this.deps.ids.uuid(), article, origin: 'BUILD', reviewerAdminId: adminOf(actor), now },
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
  ): Promise<ApplyOutcome> {
    if (target.articleId === null || target.baseRevision === null) return 'NONE';
    assertClean(target.content, await this.supportHandles(scope), target.sourceType);
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
      const current = await this.deps.repository.findArticle(scope, target.articleId, tx);
      // Retired (or gone) since the build: the build never brings it back.
      if (current === null || current.state !== 'APPROVED') {
        return this.skip(scope, actor, target, now, tx);
      }
      // Edited since the build: a CONFLICT against the article as it is NOW (S1).
      return (await this.deps.repository.markConflict(
        scope,
        target.id,
        { revision: current.revision, title: current.title, body: current.body },
        now,
        tx,
      ))
        ? 'CONFLICT'
        : 'NONE';
    }
    const decided = await this.deps.repository.decideProposal(
      scope,
      target.id,
      { kind: 'UPDATE', to: 'APPLIED', resolution: null, adminId: adminOf(actor), now },
      tx,
    );
    if (!decided) throw baseMoved();
    await this.deps.repository.insertRevision(
      scope,
      {
        id: this.deps.ids.uuid(),
        article: after,
        origin: 'BUILD',
        reviewerAdminId: adminOf(actor),
        now,
      },
      tx,
    );
    return 'APPLIED';
  }

  /**
   * RETIRE (S2): the article leaves the agent's knowledge through the normal retire write —
   * `DRAFT | APPROVED → RETIRED`, conditional on its version — and ONLY from the revision the
   * build saw. An article edited since is never retired over the edit: the proposal is closed
   * as SKIPPED and the next run proposes again against the new text.
   */
  private async applyRetire(
    scope: ScopeContext,
    actor: ActorContext,
    target: KnowledgeProposalRecord,
    now: Date,
    tx: TransactionScope,
  ): Promise<ApplyOutcome> {
    if (target.articleId === null || target.baseRevision === null) return 'NONE';
    const before = await this.deps.repository.findArticle(scope, target.articleId, tx);
    if (
      before === null ||
      before.source !== 'NEXA_BUILD' ||
      (before.state !== 'APPROVED' && before.state !== 'DRAFT') ||
      before.revision !== target.baseRevision
    ) {
      return this.skip(scope, actor, target, now, tx);
    }
    const after = await this.deps.repository.rewrite(
      scope,
      before.id,
      {
        expectedVersion: before.version,
        from: ['DRAFT', 'APPROVED'],
        to: 'RETIRED',
        publish: false,
        now,
      },
      tx,
    );
    if (after === null) return this.skip(scope, actor, target, now, tx);
    const decided = await this.deps.repository.decideProposal(
      scope,
      target.id,
      { kind: 'RETIRE', to: 'APPLIED', resolution: null, adminId: adminOf(actor), now },
      tx,
    );
    if (!decided) throw baseMoved();
    await this.deps.audit.record(
      scope,
      actor,
      {
        action: 'support_knowledge.article.retire',
        entityType: 'SupportKnowledgeArticle',
        entityId: before.id,
        before: articleAudit(before),
        after: articleAudit(after),
        result: 'SUCCESS',
      },
      tx,
    );
    return 'APPLIED';
  }

  /** PENDING → SKIPPED under the proposal's own kind; 'NONE' when something else decided it. */
  private async skip(
    scope: ScopeContext,
    actor: ActorContext,
    target: KnowledgeProposalRecord,
    now: Date,
    tx: TransactionScope,
  ): Promise<ApplyOutcome> {
    const closed = await this.deps.repository.decideProposal(
      scope,
      target.id,
      { kind: target.kind, to: 'SKIPPED', resolution: null, adminId: adminOf(actor), now },
      tx,
    );
    return closed ? 'SKIPPED' : 'NONE';
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

  /**
   * L3: the installation's own support handles (`support.accounts`): text naming one of them is
   * the business pointing customers at itself, not personal data, so the scrubber lets it be.
   */
  private async supportHandles(scope: ScopeContext): Promise<readonly string[]> {
    return this.deps.settings.valueOf<readonly string[]>(scope, 'support.accounts');
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

/** Phase 4 PR-2: the setting behind the automatic refresh (default false). */
export const SUPPORT_KNOWLEDGE_AUTO_REFRESH_KEY =
  'support.knowledge.auto_refresh' satisfies SettingKey;

/** Phase 4 PR-2: what the automatic refresh charges — what a `SYSTEM_JOB` holds. */
export const SUPPORT_KNOWLEDGE_AUTO_REFRESH_PERMISSION: PermissionKey = 'maintenance.run';

/** Phase 4 PR-2: what one automatic refresh came to. */
export type KnowledgeAutoRefreshResult =
  | { readonly outcome: 'OFF' | 'UNCHANGED' | 'INACTIVE' | 'BUSY' }
  | {
      readonly outcome: 'REFRESHED';
      readonly buildId: string;
      readonly applied: number;
      readonly conflicted: number;
      readonly skipped: number;
      readonly capped: number;
    };

/**
 * Phase 4 PR-2: a diff's identity — the source, kind, content hash and article revision of every
 * proposal that changes something (UNCHANGED left out), sorted — or null when nothing changes. Two passes over
 * the same change have the same signature: the debounce compares it, and the refresh is keyed
 * by it.
 */
export function buildSignature(
  drafts: readonly {
    readonly item: BuildItem;
    readonly kind: string;
    readonly hash: string;
    readonly article: { readonly id: string; readonly revision: number } | null;
  }[],
): string | null {
  // The article's revision is part of it: the same text proposed again after an apply (A → B →
  // A → B) is a new change, never a replay of the first one.
  const changes = drafts
    .filter((draft) => draft.kind !== 'UNCHANGED')
    .map(
      (draft) =>
        `${draft.item.sourceType}:${draft.item.sourceKey}:${draft.kind}:${draft.hash}:${
          draft.article === null ? '-' : `${draft.article.id}@${String(draft.article.revision)}`
        }`,
    )
    .sort();
  if (changes.length === 0) return null;
  return createHash('sha256').update(changes.join('\n')).digest('hex').slice(0, 32);
}

/**
 * The admin a build row names: the acting administrator, or none for the automatic refresh — a
 * `SYSTEM_JOB`'s id is a job name, never an `admins` row.
 */
function adminOf(actor: ActorContext): string | null {
  return actor.type === 'SYSTEM_JOB' ? null : actor.id;
}

function baseMoved() {
  return errors.conflict(
    SUPPORT_KNOWLEDGE_BUILD_ERROR_CODES.BASE_MOVED,
    'The article changed since this build ran. Run the build again.',
  );
}
