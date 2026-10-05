import {
  SUPPORT_KNOWLEDGE_ERROR_CODES,
  SUPPORT_LEARNING_CONVERSATION_WINDOW_HOURS,
  SUPPORT_LEARNING_EXTRACTION_JSON_SCHEMA,
  SUPPORT_LEARNING_MAX_JOBS_PER_HOUR,
  SUPPORT_LEARNING_TEXT_RETENTION_DAYS,
  errors,
  supportLearningExtractionSchema,
  supportLearningProposeRequestSchema,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdGenerator,
  type OperationalEventRecorder,
  type PermissionKey,
  type ScopeContext,
  type SupportLearningJobOutcome,
  type SupportLearningJobTrigger,
  type UnitOfWork,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import {
  recordMutationDenial,
  runAuthorizedMutation,
} from '../../../platform/access/application/authorized-mutation.js';
import type { SessionRepository } from '../../../platform/identity/application/ports.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type {
  BusinessConversationRecord,
  BusinessConversationRepository,
  BusinessMessageRepository,
  BusinessOutboundRecord,
  BusinessOutboundRepository,
  HandbackLearningTrigger,
} from '../../../commerce/business-chats/application/ports.js';
import type { SupportAiChain } from '../../support-ai/application/support-ai-chain.js';
import type { DrizzleSupportAiConfigRepository } from '../../support-ai/infrastructure/drizzle-support-ai.repository.js';
import { findDuplicate, normalizeTitle } from '../domain/dedupe.js';
import { learningSystemPrompt, learningUserMessage } from '../domain/learning-prompt.js';
import { scrubSensitive } from '../domain/scrubber.js';
import type {
  DrizzleSupportKnowledgeRepository,
  LearningJobRecord,
  LearningSourceRef,
} from '../infrastructure/drizzle-support-knowledge.repository.js';

export const SUPPORT_KNOWLEDGE_PROPOSE_PERMISSION =
  'support_knowledge.propose' satisfies PermissionKey;

/** How many recent candidates the near-duplicate check compares a proposal with. */
export const SUPPORT_LEARNING_DEDUPE_WINDOW = 200;
/** A job claimed this many times without a result is failed, never retried for ever. */
export const SUPPORT_LEARNING_MAX_ATTEMPTS = 3;

export interface SupportLearningServiceDeps {
  readonly repository: DrizzleSupportKnowledgeRepository;
  readonly configs: Pick<DrizzleSupportAiConfigRepository, 'get'>;
  readonly chain: Pick<SupportAiChain, 'generate'>;
  readonly conversations: Pick<BusinessConversationRepository, 'findById'>;
  readonly messages: Pick<BusinessMessageRepository, 'recent'>;
  readonly outbound: Pick<BusinessOutboundRepository, 'findById' | 'recent'>;
  readonly guard: PermissionGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly scopeActivity: ScopeActivityReader;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** The reply a lesson may be learned from: a person's, delivered, with its text still held. */
export function isEligibleReply(row: BusinessOutboundRecord, conversationId: string): boolean {
  return (
    row.conversationId === conversationId &&
    (row.origin === 'OPERATOR' || row.origin === 'ASSIST') &&
    row.state === 'DELIVERED' &&
    row.body !== null &&
    row.body.trim().length > 0
  );
}

/** One learning job per reply, whatever triggered it: a handback and a proposal coincide. */
export function learningJobKey(outboundId: string): string {
  return `learning:outbound:${outboundId}`;
}

/** Thrown inside a transaction to roll it back when the job was resolved by someone else. */
class JobGone extends Error {}

/**
 * TB8 — controlled learning (program §29, ADR-0035 §2–§3). Never blind self-training:
 *
 *   human support reply → learning job → `LEARNING_EXTRACT` → candidate → a reviewer.
 *
 * - A job is enqueued when an operator hands a conversation back to the AI (the latest of
 *   their delivered replies in it), or when an operator explicitly proposes one of their
 *   delivered replies. With the support AI `OFF`, nothing is enqueued and nothing is extracted.
 * - Bounded: one job per reply (its key), one per conversation per 24 hours, and at most
 *   `SUPPORT_LEARNING_MAX_JOBS_PER_HOUR` per tenant — counted in the enqueuing transaction.
 * - The `assistant` role produces it OUTSIDE any transaction: the conversation is SCRUBBED
 *   before the provider sees it, the output is parsed by the strict schema and SCRUBBED again.
 *   A proposal that still matches is stored REJECTED (`SENSITIVE_CONTENT`), redacted, never
 *   queued for review.
 * - A proposal whose normalised title equals (or nearly equals) an existing candidate's — of
 *   any state — is merged into it as an extra source, never duplicated.
 * - Nothing here publishes knowledge. Only `SupportKnowledgeService.approveCandidate` does.
 */
export class SupportLearningService implements HandbackLearningTrigger {
  constructor(private readonly deps: SupportLearningServiceDeps) {}

  /** Inside the resume's transaction. Never throws for a business reason. */
  async onHandBack(
    scope: ScopeContext,
    input: { readonly conversation: BusinessConversationRecord; readonly now: Date },
    tx: unknown,
  ): Promise<void> {
    const { config } = await this.deps.configs.get(scope);
    if (config.mode === 'OFF') return;
    const replies = await this.deps.outbound.recent(scope, input.conversation.id, 50);
    const latest = [...replies]
      .filter((row) => isEligibleReply(row, input.conversation.id))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))[0];
    if (latest === undefined) return;
    await this.enqueue(
      scope,
      { reply: latest, trigger: 'HANDBACK', adminId: null, now: input.now },
      tx,
    );
  }

  /** «پیشنهاد به‌عنوان دانش»: an operator proposes one of the delivered replies. */
  async propose(
    scope: ScopeContext,
    actor: ActorContext,
    conversationId: string,
    body: unknown,
  ): Promise<LearningJobRecord> {
    const command = supportLearningProposeRequestSchema.parse(body);
    const denial = {
      action: 'support_knowledge.propose',
      entityType: 'BusinessConversation',
      entityId: conversationId,
    };
    try {
      await this.deps.guard.check(scope, actor, SUPPORT_KNOWLEDGE_PROPOSE_PERMISSION);
    } catch (error) {
      await recordMutationDenial(
        this.mutationDeps(),
        scope,
        actor,
        SUPPORT_KNOWLEDGE_PROPOSE_PERMISSION,
        denial,
        error,
      );
      throw error;
    }
    if (actor.id === null) {
      throw errors.permissionDenied(
        'platform.permission_denied',
        'Only an administrator proposes.',
      );
    }
    const adminId = actor.id;
    const key = learningJobKey(command.outboundId);
    // A replay — and a second proposal of a reply a handback already queued — is that job.
    const existing = await this.deps.repository.findJobByKey(scope, key);
    if (existing !== null && existing.conversationId === conversationId) return existing;
    const { config } = await this.deps.configs.get(scope);
    if (config.mode === 'OFF') {
      throw errors.conflict(
        SUPPORT_KNOWLEDGE_ERROR_CODES.AI_OFF,
        'The support AI is off for this installation, so nothing is learned.',
      );
    }
    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      SUPPORT_KNOWLEDGE_PROPOSE_PERMISSION,
      denial,
      async (tx) => {
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
          throw errors.conflict(
            SUPPORT_KNOWLEDGE_ERROR_CODES.SCOPE_STOPPED,
            'This installation has stopped accepting work.',
          );
        }
        const reply = await this.deps.outbound.findById(scope, command.outboundId, tx);
        if (reply === null || !isEligibleReply(reply, conversationId)) {
          throw errors.conflict(
            SUPPORT_KNOWLEDGE_ERROR_CODES.SOURCE_NOT_ELIGIBLE,
            'Only a delivered reply an operator wrote in this conversation can be proposed.',
          );
        }
        const now = this.deps.clock.now();
        const decision = await this.enqueue(
          scope,
          { reply, trigger: 'OPERATOR_PROPOSAL', adminId, now },
          tx,
        );
        if (decision !== 'QUEUED' && decision !== 'EXISTS') {
          throw errors.conflict(
            SUPPORT_KNOWLEDGE_ERROR_CODES.RATE_LIMITED,
            'A lesson was already proposed from this conversation recently, or too many were proposed in the last hour.',
            { window: decision },
          );
        }
        const job = await this.deps.repository.findJobByKey(scope, key, tx);
        if (job === null) throw errors.internal('support_knowledge.job_missing', 'Job vanished.');
        if (decision === 'QUEUED') {
          await this.deps.audit.record(
            scope,
            actor,
            {
              action: 'support_knowledge.propose',
              entityType: 'BusinessConversation',
              entityId: conversationId,
              before: null,
              after: { jobId: job.id, outboundId: reply.id },
              result: 'SUCCESS',
            },
            tx,
          );
        }
        return job;
      },
    );
  }

  /**
   * Enqueues the job for `reply` unless a bound refuses it. `EXISTS`: the reply already has a
   * job. `CONVERSATION` / `TENANT`: a window is full. Counted inside the caller's transaction
   * (a bound, not a lock: two operators racing may both pass, which costs one extra candidate).
   */
  private async enqueue(
    scope: ScopeContext,
    input: {
      readonly reply: BusinessOutboundRecord;
      readonly trigger: SupportLearningJobTrigger;
      readonly adminId: string | null;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<'QUEUED' | 'EXISTS' | 'CONVERSATION' | 'TENANT'> {
    const key = learningJobKey(input.reply.id);
    if ((await this.deps.repository.findJobByKey(scope, key, tx)) !== null) return 'EXISTS';
    const windowStart = new Date(
      input.now.getTime() - SUPPORT_LEARNING_CONVERSATION_WINDOW_HOURS * 3_600_000,
    );
    if (
      (await this.deps.repository.countJobsSince(
        scope,
        windowStart,
        input.reply.conversationId,
        tx,
      )) > 0
    ) {
      return 'CONVERSATION';
    }
    const hourStart = new Date(input.now.getTime() - 3_600_000);
    if (
      (await this.deps.repository.countJobsSince(scope, hourStart, null, tx)) >=
      SUPPORT_LEARNING_MAX_JOBS_PER_HOUR
    ) {
      return 'TENANT';
    }
    const inserted = await this.deps.repository.insertJob(
      scope,
      {
        id: this.deps.ids.uuid(),
        conversationId: input.reply.conversationId,
        sourceOutboundId: input.reply.id,
        trigger: input.trigger,
        requestedByAdminId: input.adminId,
        idempotencyKey: key,
        now: input.now,
      },
      tx,
    );
    return inserted ? 'QUEUED' : 'EXISTS';
  }

  // --- the assistant role ----------------------------------------------------------

  /** One pass over due learning jobs. Called by the `assistant` role's loop. */
  async runDue(
    scope: ScopeContext,
    input: { readonly now: Date; readonly leaseUntil: Date; readonly limit: number },
  ): Promise<Record<string, number>> {
    const claimed = await this.deps.repository.claimDue(
      scope,
      input.now,
      input.leaseUntil,
      input.limit,
    );
    const counts: Record<string, number> = {};
    for (const job of claimed) {
      const outcome =
        job.attempts > SUPPORT_LEARNING_MAX_ATTEMPTS
          ? await this.finish(scope, job.id, 'FAILED', 'attempts_exhausted')
          : await this.produce(scope, job);
      const label = `learning_${outcome}`;
      counts[label] = (counts[label] ?? 0) + 1;
    }
    return counts;
  }

  /** Purges the text of candidates never approved, after the retention. */
  async purge(scope: ScopeContext, now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - SUPPORT_LEARNING_TEXT_RETENTION_DAYS * 86_400_000);
    return this.deps.repository.purgeCandidateText(scope, cutoff, now, 500);
  }

  /**
   * Produces one job, OUTSIDE any transaction (the provider call can take a minute). Returns
   * the outcome recorded, or `gone` when the job was resolved elsewhere meanwhile.
   */
  async produce(
    scope: ScopeContext,
    job: LearningJobRecord,
  ): Promise<SupportLearningJobOutcome | 'gone'> {
    const { config } = await this.deps.configs.get(scope);
    if (config.mode === 'OFF') return this.finish(scope, job.id, 'DONE', 'dropped_mode');

    const reply = await this.deps.outbound.findById(scope, job.sourceOutboundId);
    if (reply === null || !isEligibleReply(reply, job.conversationId) || reply.body === null) {
      return this.finish(scope, job.id, 'DONE', 'dropped_source');
    }
    const transcript = await this.deps.messages.recent(scope, job.conversationId, 40);
    const message = learningUserMessage({
      transcript: transcript.map((line) => ({
        side: line.origin === 'INBOUND' ? 'customer' : 'support',
        text: line.text,
      })),
      reply: reply.body,
    });
    const result = await this.deps.chain.generate(scope, {
      operation: 'LEARNING_EXTRACT',
      conversationId: job.conversationId,
      request: {
        system: learningSystemPrompt(),
        messages: [{ role: 'user', text: message.text }],
        jsonSchema: SUPPORT_LEARNING_EXTRACTION_JSON_SCHEMA,
        schemaName: 'support_learning_candidate',
        maxOutputTokens: 3_000,
      },
    });
    if (result.outcome.outcome !== 'OK' || result.step === null) {
      const invalid =
        result.outcome.outcome === 'INVALID_OUTPUT' ||
        result.outcome.outcome === 'REFUSED_BY_PROVIDER';
      return this.finish(scope, job.id, 'FAILED', invalid ? 'output_invalid' : 'ai_unavailable');
    }
    const parsed = supportLearningExtractionSchema.safeParse(result.outcome.output);
    if (!parsed.success) return this.finish(scope, job.id, 'FAILED', 'output_invalid');
    const proposal = parsed.data;
    if (proposal.proposal === 'NONE') return this.finish(scope, job.id, 'DONE', 'declined');

    // The second scrub: over everything the model wrote, the rationale included.
    const title = scrubSensitive(proposal.title.trim());
    const bodyText = scrubSensitive(proposal.body.trim());
    const rationale = scrubSensitive(proposal.rationale.trim());
    const tags = proposal.tags.map((tag) => scrubSensitive(tag.trim()));
    const kinds = [
      ...new Set([
        ...title.kinds,
        ...bodyText.kinds,
        ...rationale.kinds,
        ...tags.flatMap((tag) => tag.kinds),
      ]),
    ];
    const normalizedTitle = normalizeTitle(title.text);
    if (normalizedTitle.length === 0) return this.finish(scope, job.id, 'FAILED', 'output_invalid');

    const source: LearningSourceRef = {
      conversationId: job.conversationId,
      outboundId: reply.id,
      at: this.deps.clock.now().toISOString(),
    };
    const recent = await this.deps.repository.recentTitles(scope, SUPPORT_LEARNING_DEDUPE_WINDOW);
    const duplicate = findDuplicate(normalizedTitle, recent);
    try {
      return await this.deps.uow.run(scope, async (tx) => {
        const now = this.deps.clock.now();
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
          return this.finishIn(scope, job.id, 'DONE', 'dropped_scope', null, now, tx);
        }
        if (duplicate !== null) {
          await this.deps.repository.mergeSource(scope, duplicate.id, source, now, tx);
          return this.finishIn(scope, job.id, 'DONE', 'merged', duplicate.id, now, tx);
        }
        const rejected = kinds.length > 0;
        const inserted = await this.deps.repository.insertCandidate(
          scope,
          {
            id: this.deps.ids.uuid(),
            state: rejected ? 'REJECTED' : 'PENDING',
            title: title.text.slice(0, 200),
            normalizedTitle,
            body: bodyText.text.slice(0, 4000),
            category: proposal.category,
            tags: tags.map((tag) => tag.text.slice(0, 32)).filter((tag) => tag.length > 0),
            rationale: rationale.text.slice(0, 600),
            confidence: proposal.confidence,
            rejectReason: rejected ? 'SENSITIVE_CONTENT' : null,
            sensitiveKinds: kinds,
            source,
            jobId: job.id,
            provider: result.step?.provider ?? null,
            model: result.outcome.outcome === 'OK' ? result.outcome.model : null,
            now,
          },
          tx,
        );
        if (inserted === null) {
          // The exact title was taken between the read and the write: merge into that one.
          const existing = await this.deps.repository.findByNormalizedTitle(
            scope,
            normalizedTitle,
            tx,
          );
          if (existing === null) throw new Error('A candidate title conflicted with no row.');
          await this.deps.repository.mergeSource(scope, existing.id, source, now, tx);
          return this.finishIn(scope, job.id, 'DONE', 'merged', existing.id, now, tx);
        }
        return this.finishIn(
          scope,
          job.id,
          'DONE',
          rejected ? 'auto_rejected' : 'candidate_created',
          inserted.id,
          now,
          tx,
        );
      });
    } catch (error) {
      if (error instanceof JobGone) return 'gone';
      throw error;
    }
  }

  private async finishIn(
    scope: ScopeContext,
    jobId: string,
    state: 'DONE' | 'FAILED',
    outcome: SupportLearningJobOutcome,
    candidateId: string | null,
    now: Date,
    tx: TransactionScope,
  ): Promise<SupportLearningJobOutcome> {
    const ok = await this.deps.repository.finishJob(
      scope,
      jobId,
      { state, outcome, candidateId, now },
      tx,
    );
    // Someone else resolved it: roll back whatever this transaction wrote.
    if (!ok) throw new JobGone();
    return outcome;
  }

  private async finish(
    scope: ScopeContext,
    jobId: string,
    state: 'DONE' | 'FAILED',
    outcome: SupportLearningJobOutcome,
  ): Promise<SupportLearningJobOutcome | 'gone'> {
    const ok = await this.deps.repository.finishJob(scope, jobId, {
      state,
      outcome,
      now: this.deps.clock.now(),
    });
    return ok ? outcome : 'gone';
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
