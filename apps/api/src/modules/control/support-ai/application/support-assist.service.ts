import {
  SUPPORT_AI_DECISION_JSON_SCHEMA,
  errors,
  PLATFORM_ERROR_CODES,
  supportAiDecisionSchema,
  supportAiDraftSendRequestSchema,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdGenerator,
  type OperationalEventRecorder,
  type PermissionKey,
  type ScopeContext,
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
import type { BusinessConversationService } from '../../../commerce/business-chats/application/business-conversation.service.js';
import type {
  BusinessConversationRepository,
  BusinessMessageRepository,
} from '../../../commerce/business-chats/application/ports.js';
import { supportSystemPrompt, transcriptMessages } from '../domain/prompt.js';
import type { DrizzleSupportAiConfigRepository } from '../infrastructure/drizzle-support-ai.repository.js';
import type {
  DrizzleSupportAiJobRepository,
  SupportAiJobRecord,
} from '../infrastructure/drizzle-support-ai-job.repository.js';
import type { SupportAiChain } from './support-ai-chain.js';

export const SUPPORT_AI_ASSIST_PERMISSION = 'support_ai.assist' satisfies PermissionKey;
export const SUPPORT_AI_ASSIST_SEND_PERMISSION = 'business_chats.reply' satisfies PermissionKey;

export const SUPPORT_ASSIST_ERROR_CODES = {
  OFF: 'support_ai.off',
  NOT_FOUND: 'support_ai.draft_not_found',
  NOT_READY: 'support_ai.draft_not_ready',
} as const;

/**
 * The NEXA facts a draft is grounded on (TB3), behind a port. `aliases` maps the payload's
 * aliases (`S1`, `P2`, …) to the short label an operator reads; a decision citing an alias the
 * payload did not contain has its citation dropped and recorded, never trusted.
 */
export interface SupportContextSource {
  build(
    scope: ScopeContext,
    customerId: string | null,
  ): Promise<{ readonly json: string; readonly aliases: ReadonlyMap<string, string>; readonly linked: boolean }>;
}

export interface SupportAssistServiceDeps {
  readonly jobs: DrizzleSupportAiJobRepository;
  readonly configs: Pick<DrizzleSupportAiConfigRepository, 'get'>;
  readonly chain: Pick<SupportAiChain, 'generate'>;
  readonly context: SupportContextSource;
  readonly conversations: Pick<BusinessConversationRepository, 'findById'>;
  readonly messages: Pick<BusinessMessageRepository, 'recent'>;
  readonly sender: Pick<BusinessConversationService, 'enqueueHumanSend'>;
  readonly guard: PermissionGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly scopeActivity: ScopeActivityReader;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/**
 * TB5 — Assist Mode (program §16, §35): the AI drafts, a person decides.
 *
 * - An operator with `support_ai.assist` requests a draft for a conversation. A newer request
 *   discards the older open draft.
 * - The `assistant` role produces it: transcript (bounded) + NEXA facts (TB3, allowlisted) +
 *   the fixed policy → the provider chain (TB4) → a decision validated by zod. An invalid one
 *   is a FAILED draft, never shown as advice.
 * - Nothing is sent by the AI. Sending is the operator's act (`business_chats.reply`), through
 *   the ordinary outbound lane as an `ASSIST` row — which is itself a human signal, so the
 *   conversation is the operator's from that moment (TB0 review F7).
 */
export class SupportAssistService {
  constructor(private readonly deps: SupportAssistServiceDeps) {}

  async request(
    scope: ScopeContext,
    actor: ActorContext,
    input: { readonly conversationId: string; readonly idempotencyKey: string },
  ): Promise<SupportAiJobRecord> {
    const adminId = this.adminIdOf(actor);
    const denial = { action: 'support_ai.draft.request', entityType: 'BusinessConversation', entityId: input.conversationId };
    await this.authorize(scope, actor, SUPPORT_AI_ASSIST_PERMISSION, denial);
    const key = `${actor.surface}:${adminId}:${input.idempotencyKey}`;
    const existing = await this.deps.jobs.findByIdempotencyKey(scope, key);
    if (existing !== null) return existing;
    const { config } = await this.deps.configs.get(scope);
    if (config.mode === 'OFF') {
      throw errors.conflict(SUPPORT_ASSIST_ERROR_CODES.OFF, 'The support AI is off for this installation.');
    }
    return runAuthorizedMutation(this.mutationDeps(), scope, actor, SUPPORT_AI_ASSIST_PERMISSION, denial, async (tx) => {
      await this.assertScopeActive(scope, tx);
      const raced = await this.deps.jobs.findByIdempotencyKey(scope, key, tx);
      if (raced !== null) return raced;
      const conversation = await this.deps.conversations.findById(scope, input.conversationId, tx);
      if (conversation === null) throw errors.notFound('business_chats.not_found', 'No such business conversation.');
      const now = this.deps.clock.now();
      await this.deps.jobs.discardOpen(scope, conversation.id, now, tx);
      const job = await this.deps.jobs.insert(
        scope,
        {
          id: this.deps.ids.uuid(),
          kind: 'ASSIST_DRAFT',
          conversationId: conversation.id,
          requestedByAdminId: adminId,
          idempotencyKey: key,
          now,
        },
        tx,
      );
      await this.deps.audit.record(
        scope,
        actor,
        {
          action: 'support_ai.draft.request',
          entityType: 'BusinessConversation',
          entityId: conversation.id,
          before: null,
          after: { jobId: job.id },
          result: 'SUCCESS',
        },
        tx,
      );
      return job;
    });
  }

  async drafts(scope: ScopeContext, actor: ActorContext, conversationId: string): Promise<readonly SupportAiJobRecord[]> {
    await this.deps.guard.check(scope, actor, SUPPORT_AI_ASSIST_PERMISSION);
    return this.deps.jobs.recentForConversation(scope, conversationId, 5);
  }

  /**
   * Produces one draft. Called by the `assistant` role on a claimed job, OUTSIDE any
   * transaction (the provider call can take a minute). Returns the job's new state.
   */
  async produce(scope: ScopeContext, job: SupportAiJobRecord): Promise<'READY' | 'FAILED' | 'GONE'> {
    const conversation = await this.deps.conversations.findById(scope, job.conversationId);
    if (conversation === null) {
      return (await this.deps.jobs.markFailed(scope, job.id, 'conversation.missing', this.deps.clock.now())) ? 'FAILED' : 'GONE';
    }
    const [{ config }, transcript, context] = await Promise.all([
      this.deps.configs.get(scope),
      this.deps.messages.recent(scope, conversation.id, 40),
      this.deps.context.build(scope, conversation.customerId),
    ]);
    const turns = transcriptMessages(transcript.map((m) => ({ origin: m.origin, text: m.text, kind: m.kind })));
    if (turns.length === 0) {
      return (await this.deps.jobs.markFailed(scope, job.id, 'transcript.empty', this.deps.clock.now())) ? 'FAILED' : 'GONE';
    }
    const result = await this.deps.chain.generate(scope, {
      operation: 'ASSIST_DRAFT',
      conversationId: conversation.id,
      request: {
        system: supportSystemPrompt({
          businessToneInstructions: config.toneInstructions,
          maxReplyChars: config.maxOutputChars,
          contextJson: context.json,
          identityLinked: context.linked,
        }),
        messages: turns,
        jsonSchema: SUPPORT_AI_DECISION_JSON_SCHEMA,
        schemaName: 'support_decision',
        // Persian is token-dense; a generous bound, and the reply's own limit is checked below.
        maxOutputTokens: Math.min(4_000, config.maxOutputChars * 3 + 600),
      },
    });
    const now = this.deps.clock.now();
    if (result.outcome.outcome !== 'OK' || result.step === null) {
      const code = result.exhausted ?? ('code' in result.outcome ? result.outcome.code : result.outcome.outcome);
      return (await this.deps.jobs.markFailed(scope, job.id, `chain.${code}`, now)) ? 'FAILED' : 'GONE';
    }
    const parsed = supportAiDecisionSchema.safeParse(result.outcome.output);
    if (!parsed.success || parsed.data.replyText.length > config.maxOutputChars) {
      return (await this.deps.jobs.markFailed(scope, job.id, 'decision.invalid', now)) ? 'FAILED' : 'GONE';
    }
    // A citation the payload did not contain is dropped: it is not evidence of anything.
    const factLabels = parsed.data.factRefs.flatMap((ref) => {
      const label = context.aliases.get(ref);
      return label === undefined ? [] : [label];
    });
    const ok = await this.deps.jobs.markReady(scope, job.id, {
      decision: parsed.data,
      factLabels,
      provider: result.step.provider,
      model: result.outcome.model,
      now,
    });
    return ok ? 'READY' : 'GONE';
  }

  /** The operator sends the draft — edited or not — as the business account. */
  async send(scope: ScopeContext, actor: ActorContext, draftId: string, body: unknown): Promise<{ readonly outboundId: string }> {
    const command = supportAiDraftSendRequestSchema.parse(body);
    await this.authorize(scope, actor, SUPPORT_AI_ASSIST_PERMISSION, {
      action: 'support_ai.draft.send',
      entityType: 'SupportAiJob',
      entityId: draftId,
    });
    const draft = await this.deps.jobs.findById(scope, draftId);
    if (draft === null) throw this.notFound();
    if (draft.state === 'SENT' && draft.sentOutboundId !== null) return { outboundId: draft.sentOutboundId };
    if (draft.state !== 'READY') {
      throw errors.conflict(SUPPORT_ASSIST_ERROR_CODES.NOT_READY, 'This draft cannot be sent (it is not ready, or was replaced).');
    }
    // The ordinary operator send: `business_chats.reply`, the connection check, the human
    // signal and the lane. Idempotent on the operator's key, so a retry sends once.
    const row = await this.deps.sender.enqueueHumanSend(scope, actor, {
      conversationId: draft.conversationId,
      idempotencyKey: command.idempotencyKey,
      text: command.text,
      origin: 'ASSIST',
    });
    await this.deps.uow.run(scope, async (tx) => {
      await this.deps.jobs.markSent(scope, draft.id, row.id, this.deps.clock.now(), tx);
      await this.deps.audit.record(
        scope,
        actor,
        {
          action: 'support_ai.draft.send',
          entityType: 'SupportAiJob',
          entityId: draft.id,
          before: { state: draft.state },
          after: { state: 'SENT', outboundId: row.id, edited: command.text !== draft.suggestedReply },
          result: 'SUCCESS',
        },
        tx,
      );
    });
    return { outboundId: row.id };
  }

  async discard(scope: ScopeContext, actor: ActorContext, draftId: string): Promise<{ readonly discarded: boolean }> {
    const denial = { action: 'support_ai.draft.discard', entityType: 'SupportAiJob', entityId: draftId };
    await this.authorize(scope, actor, SUPPORT_AI_ASSIST_PERMISSION, denial);
    return runAuthorizedMutation(this.mutationDeps(), scope, actor, SUPPORT_AI_ASSIST_PERMISSION, denial, async (tx) => {
      await this.assertScopeActive(scope, tx);
      const discarded = await this.deps.jobs.discard(scope, draftId, this.deps.clock.now(), tx);
      return { discarded };
    });
  }

  private notFound() {
    return errors.notFound(SUPPORT_ASSIST_ERROR_CODES.NOT_FOUND, 'No such draft.');
  }

  private adminIdOf(actor: ActorContext): string {
    if (actor.id === null) {
      throw errors.permissionDenied(PLATFORM_ERROR_CODES.PERMISSION_DENIED, 'Only an administrator asks for a draft.');
    }
    return actor.id;
  }

  private async authorize(
    scope: ScopeContext,
    actor: ActorContext,
    permission: PermissionKey,
    denial: { action: string; entityType: string; entityId: string | null },
  ): Promise<void> {
    try {
      await this.deps.guard.check(scope, actor, permission);
    } catch (error) {
      await recordMutationDenial(this.mutationDeps(), scope, actor, permission, denial, error);
      throw error;
    }
  }

  private async assertScopeActive(scope: ScopeContext, tx: TransactionScope): Promise<void> {
    if (await this.deps.scopeActivity.scopeIsActive(scope, tx)) return;
    throw errors.notFound(PLATFORM_ERROR_CODES.TENANT_NOT_FOUND, 'This scope is not accepting work.');
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
