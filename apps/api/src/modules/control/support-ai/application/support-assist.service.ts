import {
  SUPPORT_AI_DECISION_JSON_SCHEMA,
  SUPPORT_AI_DRAFT_RETENTION_DAYS,
  SUPPORT_AI_DRAFT_UNCLAIMED_SECONDS,
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
  type SupportAiImageSkipReason,
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
import { hashRequest } from '../../../platform/idempotency/infrastructure/drizzle-idempotency-store.js';
import type { BusinessConversationService } from '../../../commerce/business-chats/application/business-conversation.service.js';
import type {
  BusinessConversationRepository,
  BusinessMessageRepository,
} from '../../../commerce/business-chats/application/ports.js';
import {
  SUPPORT_AI_TRANSCRIPT_MESSAGES,
  supportSystemPrompt,
  transcriptMessages,
  type TranscriptImage,
  type TranscriptLine,
} from '../domain/prompt.js';
import { planVision } from '../domain/vision.js';
import type { DrizzleSupportAiConfigRepository } from '../infrastructure/drizzle-support-ai.repository.js';
import type {
  DrizzleSupportAiJobRepository,
  SupportAiJobRecord,
} from '../infrastructure/drizzle-support-ai-job.repository.js';
import type { SupportAiChain } from './support-ai-chain.js';
import type { SupportImageSource } from './ports.js';

/** TB6: one customer image fetched for this request, and its size (telemetry). */
interface LoadedImage {
  readonly image: TranscriptImage;
  readonly byteSize: number;
}

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
  ): Promise<{
    readonly json: string;
    readonly aliases: ReadonlyMap<string, string>;
    readonly linked: boolean;
  }>;
}

/** What `produce` did with a claimed job. `INACTIVE`: the scope stopped; nothing was written. */
export type SupportAssistProduceResult = 'READY' | 'FAILED' | 'GONE' | 'INACTIVE';

/** TB6: the per-image outcome rows of one request, written inside the result's transaction. */
type ImageWrite = (now: Date, tx: TransactionScope) => Promise<void>;

/** The instant before which a QUEUED job with no live lease counts as unclaimed. */
export function unclaimedCutoff(now: Date): Date {
  return new Date(now.getTime() - SUPPORT_AI_DRAFT_UNCLAIMED_SECONDS * 1_000);
}

export interface SupportAssistServiceDeps {
  readonly jobs: DrizzleSupportAiJobRepository;
  readonly configs: Pick<DrizzleSupportAiConfigRepository, 'get'>;
  readonly chain: Pick<SupportAiChain, 'generate' | 'visionStepConfigured'>;
  /** TB6: the one way a customer's image is read (tenant-scoped, bounded, sniffed). */
  readonly images: SupportImageSource;
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
    const denial = {
      action: 'support_ai.draft.request',
      entityType: 'BusinessConversation',
      entityId: input.conversationId,
    };
    await this.authorize(scope, actor, SUPPORT_AI_ASSIST_PERMISSION, denial);
    const key = `${actor.surface}:${adminId}:${input.idempotencyKey}`;
    // The key is bound to what it asked for (PR #200 review, finding 5): the same key with a
    // different conversation is refused, never answered with the first conversation's job.
    const requestHash = hashRequest({
      command: 'support_ai.draft.request',
      conversationId: input.conversationId,
    });
    const existing = await this.deps.jobs.findByIdempotencyKey(scope, key);
    if (existing !== null) return this.replayOf(existing, requestHash);
    const { config } = await this.deps.configs.get(scope);
    if (config.mode === 'OFF') {
      throw errors.conflict(
        SUPPORT_ASSIST_ERROR_CODES.OFF,
        'The support AI is off for this installation.',
      );
    }
    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      SUPPORT_AI_ASSIST_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const raced = await this.deps.jobs.findByIdempotencyKey(scope, key, tx);
        if (raced !== null) return this.replayOf(raced, requestHash);
        const conversation = await this.deps.conversations.findById(
          scope,
          input.conversationId,
          tx,
        );
        if (conversation === null)
          throw errors.notFound('business_chats.not_found', 'No such business conversation.');
        const now = this.deps.clock.now();
        // An older draft nothing claimed is FAILED as such, not merely replaced.
        await this.deps.jobs.failUnclaimed(scope, conversation.id, unclaimedCutoff(now), now, tx);
        await this.deps.jobs.discardOpen(scope, conversation.id, now, tx);
        const job = await this.deps.jobs.insert(
          scope,
          {
            id: this.deps.ids.uuid(),
            kind: 'ASSIST_DRAFT',
            conversationId: conversation.id,
            requestedByAdminId: adminId,
            idempotencyKey: key,
            requestHash,
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
      },
    );
  }

  async drafts(
    scope: ScopeContext,
    actor: ActorContext,
    conversationId: string,
  ): Promise<readonly SupportAiJobRecord[]> {
    await this.deps.guard.check(scope, actor, SUPPORT_AI_ASSIST_PERMISSION);
    // The server decides when a draft has waited too long (PR #200 review, finding 6): with the
    // `assistant` role down nothing ever claims it, and the screen polls a QUEUED draft and
    // keeps re-request disabled. Bookkeeping on the job's own row, under the activity check: a
    // stopped scope's drafts are read, never written.
    await this.deps.uow.run(scope, async (tx) => {
      if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) return;
      const now = this.deps.clock.now();
      await this.deps.jobs.failUnclaimed(scope, conversationId, unclaimedCutoff(now), now, tx);
    });
    return this.deps.jobs.recentForConversation(scope, conversationId, 5);
  }

  /**
   * Produces one draft. Called by the `assistant` role on a claimed job, OUTSIDE any
   * transaction (the provider call can take a minute). Returns what became of the job.
   *
   * The decision to CALL the provider is business work and checks scope activity in a
   * transaction first (docs/conventions.md, the third exception's last sentence): a stopped
   * tenant's transcript is never sent to a provider. The result is recorded in a transaction
   * that checks again, so a stop that lands during the call writes nothing. Either way an
   * inactive scope's job is left exactly as it is — QUEUED, under its lease — rather than
   * FAILED: a stopped scope takes no writes, ours included, and once it is started again the
   * job is claimed again or, if it waited too long, failed as unclaimed by the ordinary rule.
   */
  async produce(scope: ScopeContext, job: SupportAiJobRecord): Promise<SupportAssistProduceResult> {
    const active = await this.deps.uow.run(scope, (tx) =>
      this.deps.scopeActivity.scopeIsActive(scope, tx),
    );
    if (!active) return 'INACTIVE';
    const conversation = await this.deps.conversations.findById(scope, job.conversationId);
    if (conversation === null) return this.fail(scope, job, 'conversation.missing');
    const [{ config }, transcript, context] = await Promise.all([
      this.deps.configs.get(scope),
      this.deps.messages.recent(scope, conversation.id, 40),
      this.deps.context.build(scope, conversation.customerId),
    ]);

    /*
     * TB6 — vision. Which customer images may go with this request, fetched OUTSIDE any
     * transaction through the tenant-scoped source. Every image considered ends with exactly
     * one outcome row: PROCESSED only when the step that ANSWERED was given it.
     */
    const plan = planVision(transcript, {
      visionEnabled: config.visionEnabled,
      visionStepConfigured: this.deps.chain.visionStepConfigured(config),
    });
    const skipped = new Map<string, SupportAiImageSkipReason>(plan.skipped);
    const loaded = new Map<string, LoadedImage>();
    for (const messageId of plan.fetch) {
      const load = await this.deps.images.load(scope, {
        conversationId: conversation.id,
        messageId,
      });
      if (load.outcome === 'LOADED') {
        loaded.set(messageId, { image: load.image, byteSize: load.byteSize });
      } else {
        skipped.set(messageId, load.reason);
      }
    }
    const lines: TranscriptLine[] = transcript.map((m) => ({
      origin: m.origin,
      text: m.text,
      kind: m.kind,
      image: loaded.get(m.id)?.image ?? null,
    }));
    const turns = transcriptMessages(lines, { attachImages: false });
    if (turns.length === 0) return this.fail(scope, job, 'transcript.empty');
    const imagesInWindow = transcript
      .slice(-SUPPORT_AI_TRANSCRIPT_MESSAGES)
      .filter((m) => m.kind === 'PHOTO').length;

    /*
     * FAIL CLOSED (program §28): the customer's latest message is an image nobody could
     * process. No model is asked — one that cannot see the image would answer its caption, or
     * nothing, as though it had looked — and the draft is a HANDOFF that says why.
     */
    const latestImage = plan.latestInboundImageId;
    if (latestImage !== null && !loaded.has(latestImage)) {
      return this.unseenImageHandoff(
        scope,
        job.id,
        skipped.get(latestImage) ?? 'DOWNLOAD_FAILED',
        imagesInWindow,
        skipped,
        loaded,
      );
    }

    const visionTurns =
      loaded.size === 0 ? null : transcriptMessages(lines, { attachImages: true });
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
      ...(visionTurns === null
        ? {}
        : { vision: { messages: visionTurns, required: latestImage !== null } }),
    });
    if (result.exhausted === 'NO_VISION_STEP') {
      return this.unseenImageHandoff(
        scope,
        job.id,
        'NO_VISION_CAPABILITY',
        imagesInWindow,
        skipped,
        loaded,
      );
    }
    const answered = result.outcome.outcome === 'OK' && result.step !== null;
    const seen = answered && result.imagesSent > 0 ? result.imagesSent : 0;
    // The per-image telemetry is written in the SAME transaction as the job's result, under
    // the same activity check: a scope stopped during the call records neither.
    const images = this.imageWriter(
      scope,
      job.id,
      skipped,
      loaded,
      seen > 0 ? null : answered ? 'NO_VISION_CAPABILITY' : 'NOT_ANSWERED',
    );
    if (result.outcome.outcome !== 'OK' || result.step === null) {
      const code =
        result.exhausted ??
        ('code' in result.outcome ? result.outcome.code : result.outcome.outcome);
      return this.fail(scope, job, `chain.${code}`, images);
    }
    const parsed = supportAiDecisionSchema.safeParse(result.outcome.output);
    if (!parsed.success || parsed.data.replyText.length > config.maxOutputChars) {
      return this.fail(scope, job, 'decision.invalid', images);
    }
    // A citation the payload did not contain is dropped: it is not evidence of anything.
    const factLabels = parsed.data.factRefs.flatMap((ref) => {
      const label = context.aliases.get(ref);
      return label === undefined ? [] : [label];
    });
    const step = result.step;
    const model = result.outcome.model;
    return this.record(
      scope,
      'READY',
      (now, tx) =>
        this.deps.jobs.markReady(
          scope,
          job.id,
          {
            decision: parsed.data,
            factLabels,
            provider: step.provider,
            model,
            imagesSeen: seen,
            imagesUnseen: Math.max(0, imagesInWindow - seen),
            now,
          },
          tx,
        ),
      images,
    );
  }

  /**
   * The `assistant` role's claim of the next due job, in a transaction that checks the scope
   * is accepting work: a stopped tenant's jobs are not leased, counted or produced.
   */
  async claimNext(
    scope: ScopeContext,
    now: Date,
    leaseUntil: Date,
  ): Promise<SupportAiJobRecord | null> {
    return this.deps.uow.run(scope, async (tx) => {
      if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) return null;
      return this.deps.jobs.claimNext(scope, now, leaseUntil, tx);
    });
  }

  /** A job claimed too many times without a result is failed rather than retried for ever. */
  abandon(scope: ScopeContext, job: SupportAiJobRecord): Promise<SupportAssistProduceResult> {
    return this.fail(scope, job, 'job.attempts_exhausted');
  }

  /** The draft text's retention: purged with the transcript, 30 days after the request. */
  async purgeExpired(scope: ScopeContext, now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - SUPPORT_AI_DRAFT_RETENTION_DAYS * 86_400_000);
    return this.deps.uow.run(scope, async (tx) => {
      // A stopped tenant is a pass that did nothing (the TB2 lane's rule, retention included).
      if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) return 0;
      return this.deps.jobs.purgeText(scope, cutoff, now, 500, tx);
    });
  }

  private fail(
    scope: ScopeContext,
    job: SupportAiJobRecord,
    code: string,
    images?: ImageWrite,
  ): Promise<SupportAssistProduceResult> {
    return this.record(
      scope,
      'FAILED',
      (now, tx) => this.deps.jobs.markFailed(scope, job.id, code, now, tx),
      images,
    );
  }

  /** One result write, in a transaction that checks the scope is still accepting work. */
  private async record(
    scope: ScopeContext,
    to: 'READY' | 'FAILED',
    write: (now: Date, tx: TransactionScope) => Promise<boolean>,
    images?: ImageWrite,
  ): Promise<SupportAssistProduceResult> {
    return this.deps.uow.run(scope, async (tx) => {
      if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) return 'INACTIVE';
      const now = this.deps.clock.now();
      if (images !== undefined) await images(now, tx);
      return (await write(now, tx)) ? to : 'GONE';
    });
  }

  /** TB6: the fail-closed HANDOFF draft, and its telemetry, in one transaction. No model was asked. */
  private unseenImageHandoff(
    scope: ScopeContext,
    jobId: string,
    reason: SupportAiImageSkipReason,
    imagesInWindow: number,
    skipped: ReadonlyMap<string, SupportAiImageSkipReason>,
    loaded: ReadonlyMap<string, LoadedImage>,
  ): Promise<SupportAssistProduceResult> {
    return this.record(
      scope,
      'READY',
      (now, tx) =>
        this.deps.jobs.markUnseenImageHandoff(
          scope,
          jobId,
          { reason, imagesUnseen: imagesInWindow, now },
          tx,
        ),
      this.imageWriter(scope, jobId, skipped, loaded, 'NOT_ANSWERED'),
    );
  }

  /**
   * TB6 telemetry: one row per customer image considered. A loaded image is PROCESSED only
   * when `loadedReason` is null (the answering step was given it); otherwise it is SKIPPED with
   * that reason. Never a byte, a file id or a URL. Returned as a write for `record`, so the
   * rows commit with the job's result or not at all.
   */
  private imageWriter(
    scope: ScopeContext,
    jobId: string,
    skipped: ReadonlyMap<string, SupportAiImageSkipReason>,
    loaded: ReadonlyMap<string, LoadedImage>,
    loadedReason: SupportAiImageSkipReason | null,
  ): ImageWrite {
    const rows = [
      ...[...loaded].map(([messageId, { image, byteSize }]) => ({
        id: this.deps.ids.uuid(),
        messageId,
        outcome: loadedReason === null ? ('PROCESSED' as const) : ('SKIPPED' as const),
        reason: loadedReason,
        mediaType: image.mediaType,
        byteSize,
      })),
      ...[...skipped].map(([messageId, reason]) => ({
        id: this.deps.ids.uuid(),
        messageId,
        outcome: 'SKIPPED' as const,
        reason,
        mediaType: null,
        byteSize: null,
      })),
    ];
    return (now, tx) => this.deps.jobs.recordImageOutcomes(scope, jobId, rows, now, tx);
  }

  /** The operator sends the draft — edited or not — as the business account. */
  async send(
    scope: ScopeContext,
    actor: ActorContext,
    draftId: string,
    body: unknown,
  ): Promise<{ readonly outboundId: string }> {
    const command = supportAiDraftSendRequestSchema.parse(body);
    await this.authorize(scope, actor, SUPPORT_AI_ASSIST_PERMISSION, {
      action: 'support_ai.draft.send',
      entityType: 'SupportAiJob',
      entityId: draftId,
    });
    const draft = await this.deps.jobs.findById(scope, draftId);
    if (draft === null) throw this.notFound();
    // A courtesy, unlocked: a draft that plainly cannot be sent is refused before the lane is
    // asked. SENT passes, so a replay of the operator's key reaches the lane's own replay. The
    // DECISION is the conditional write inside the lane's transaction, below.
    if (draft.state !== 'READY' && draft.state !== 'SENT') throw this.notReady();
    // The ordinary operator send: `business_chats.reply`, the connection check, the human
    // signal and the lane. The draft moves READY→SENT in the SAME transaction as the outbound
    // row (PR #200 review, finding 2): two sends under different keys, or a send racing a
    // discard, commit at most one row, and the loser's whole transaction rolls back.
    let inserted = false;
    const row = await this.deps.sender.enqueueHumanSend(
      scope,
      actor,
      {
        conversationId: draft.conversationId,
        idempotencyKey: command.idempotencyKey,
        text: command.text,
        origin: 'ASSIST',
      },
      async (outbound, tx) => {
        const now = this.deps.clock.now();
        if (!(await this.deps.jobs.markSent(scope, draft.id, outbound.id, now, tx))) {
          throw this.notReady();
        }
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'support_ai.draft.send',
            entityType: 'SupportAiJob',
            entityId: draft.id,
            before: { state: 'READY' },
            after: {
              state: 'SENT',
              outboundId: outbound.id,
              edited: command.text !== draft.suggestedReply,
            },
            result: 'SUCCESS',
          },
          tx,
        );
        inserted = true;
      },
    );
    if (!inserted) {
      // The lane replayed the operator's key. It answers for THIS draft only if this draft was
      // sent as that row; the same key used on another draft is a different request.
      const current = await this.deps.jobs.findById(scope, draft.id);
      if (current?.state !== 'SENT' || current.sentOutboundId !== row.id) {
        throw errors.conflict(
          PLATFORM_ERROR_CODES.IDEMPOTENCY_PAYLOAD_MISMATCH,
          'This idempotency key was already used to send a different draft.',
        );
      }
    }
    return { outboundId: row.id };
  }

  async discard(
    scope: ScopeContext,
    actor: ActorContext,
    draftId: string,
  ): Promise<{ readonly discarded: boolean }> {
    const denial = {
      action: 'support_ai.draft.discard',
      entityType: 'SupportAiJob',
      entityId: draftId,
    };
    await this.authorize(scope, actor, SUPPORT_AI_ASSIST_PERMISSION, denial);
    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      SUPPORT_AI_ASSIST_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const discarded = await this.deps.jobs.discard(scope, draftId, this.deps.clock.now(), tx);
        return { discarded };
      },
    );
  }

  private notReady() {
    return errors.conflict(
      SUPPORT_ASSIST_ERROR_CODES.NOT_READY,
      'This draft cannot be sent (it is not ready, or was replaced).',
    );
  }

  private replayOf(existing: SupportAiJobRecord, requestHash: string): SupportAiJobRecord {
    if (existing.requestHash !== requestHash) {
      throw errors.conflict(
        PLATFORM_ERROR_CODES.IDEMPOTENCY_PAYLOAD_MISMATCH,
        'This idempotency key was already used to ask for a draft of a different conversation.',
      );
    }
    return existing;
  }

  private notFound() {
    return errors.notFound(SUPPORT_ASSIST_ERROR_CODES.NOT_FOUND, 'No such draft.');
  }

  private adminIdOf(actor: ActorContext): string {
    if (actor.id === null) {
      throw errors.permissionDenied(
        PLATFORM_ERROR_CODES.PERMISSION_DENIED,
        'Only an administrator asks for a draft.',
      );
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
    throw errors.notFound(
      PLATFORM_ERROR_CODES.TENANT_NOT_FOUND,
      'This scope is not accepting work.',
    );
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
