import {
  SUPPORT_AI_AUTO_WINDOW,
  SUPPORT_AI_DECISION_JSON_SCHEMA,
  supportAiDecisionSchema,
  type BusinessHandoffReason,
  type Clock,
  type IdGenerator,
  type Logger,
  type ScopeContext,
  type SupportAiAutoOutcome,
  type SupportAiDecision,
  type SupportAiImageSkipReason,
  type SupportAiProvider,
  type UnitOfWork,
} from '@nexa/contracts';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { BusinessConversationService } from '../../../commerce/business-chats/application/business-conversation.service.js';
import type {
  AutoReplyModeReader,
  BusinessConversationRecord,
  BusinessConversationRepository,
  BusinessMessageRepository,
  BusinessOutboundRepository,
  InboundAutoTrigger,
} from '../../../commerce/business-chats/application/ports.js';
import {
  autoDecisionGuards,
  autoImageGuard,
  autoPreflight,
  type AutoVerdict,
} from '../domain/auto-reply-guards.js';
import { planVision } from '../domain/vision.js';
import {
  supportSystemPrompt,
  transcriptMessages,
  type TranscriptImage,
  type TranscriptLine,
} from '../domain/prompt.js';
import type { DrizzleSupportAiConfigRepository } from '../infrastructure/drizzle-support-ai.repository.js';
import type {
  DrizzleSupportAiJobRepository,
  SupportAiJobRecord,
} from '../infrastructure/drizzle-support-ai-job.repository.js';
import type { SupportContextSource } from './support-assist.service.js';
import type { SupportAiChain } from './support-ai-chain.js';
import type { SupportImageSource } from './ports.js';

/** The key that makes an automatic job idempotent on its message (and content version). */
export function autoJobKey(conversationId: string, telegramMessageId: number, version: number) {
  return `auto:${conversationId}:${telegramMessageId}:v${version}`;
}

export interface SupportAutoEnqueuerDeps {
  readonly configs: Pick<DrizzleSupportAiConfigRepository, 'get'>;
  readonly jobs: Pick<
    DrizzleSupportAiJobRepository,
    'insertAuto' | 'queuedAuto' | 'finishAuto' | 'findByIdempotencyKey'
  >;
  readonly ids: IdGenerator;
}

/**
 * TB7 — the producer side of automatic replies, called by business-chats INSIDE the
 * transaction that recorded an INBOUND message, under the conversation's lock.
 *
 * - Nothing is enqueued unless the mode is `AUTO_REPLY_SAFE` and the conversation `AI_ACTIVE`.
 * - **Coalescing.** A newer inbound message replaces the pending job (it is DISCARDED as
 *   `dropped_coalesced` and a new one is due a full settle delay after this message), so a
 *   customer who writes three lines gets one answer, and never two pending jobs exist for one
 *   conversation (a partial unique index is the backstop).
 * - **Idempotent on the message.** The job's key names the message and its content version; a
 *   redelivered message enqueues nothing.
 * - An edit re-enqueues ONLY while the conversation still has a pending job (the edit changes
 *   what is about to be answered); an edit of an already-answered message starts nothing.
 * - The settle delay (TB4 config, 3–30 s, default 6 s) is MITIGATION ONLY. The authority is
 *   the captured epoch, checked again before the provider call, when the lane row is enqueued,
 *   and at TB2's final send check.
 */
export class SupportAutoEnqueuer implements InboundAutoTrigger, AutoReplyModeReader {
  constructor(private readonly deps: SupportAutoEnqueuerDeps) {}

  async autoReplyEnabled(scope: ScopeContext, tx: unknown): Promise<boolean> {
    const { config } = await this.deps.configs.get(scope, tx);
    return config.mode === 'AUTO_REPLY_SAFE';
  }

  async onInbound(
    scope: ScopeContext,
    input: {
      readonly conversation: BusinessConversationRecord;
      readonly telegramMessageId: number;
      readonly contentVersion: number;
      readonly edited: boolean;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<void> {
    const conversation = input.conversation;
    if (conversation.state !== 'AI_ACTIVE') return;
    const { config } = await this.deps.configs.get(scope, tx);
    if (config.mode !== 'AUTO_REPLY_SAFE') return;
    const key = autoJobKey(conversation.id, input.telegramMessageId, input.contentVersion);
    if ((await this.deps.jobs.findByIdempotencyKey(scope, key, tx)) !== null) return;
    const pending = await this.deps.jobs.queuedAuto(scope, conversation.id, tx);
    if (input.edited && pending === null) return;
    if (pending !== null) {
      await this.deps.jobs.finishAuto(
        scope,
        pending.id,
        { state: 'DISCARDED', outcome: 'dropped_coalesced', now: input.now },
        tx,
      );
    }
    const settle = input.now.getTime() + config.settleDelaySeconds * 1000;
    const cooled =
      conversation.lastAiAt === null
        ? 0
        : conversation.lastAiAt.getTime() + config.cooldownSeconds * 1000;
    await this.deps.jobs.insertAuto(
      scope,
      {
        id: this.deps.ids.uuid(),
        conversationId: conversation.id,
        idempotencyKey: key,
        triggerTelegramMessageId: input.telegramMessageId,
        triggerContentVersion: input.contentVersion,
        controlEpoch: conversation.controlEpoch,
        dueAt: new Date(Math.max(settle, cooled)),
        now: input.now,
      },
      tx,
    );
  }
}

export interface SupportAutoReplyServiceDeps {
  readonly jobs: Pick<DrizzleSupportAiJobRepository, 'finishAuto' | 'recordImageOutcomes'>;
  readonly configs: Pick<DrizzleSupportAiConfigRepository, 'get'>;
  readonly chain: Pick<SupportAiChain, 'generate' | 'visionStepConfigured'>;
  /** TB6: the one way a customer's image is read (tenant-scoped, bounded, sniffed). */
  readonly images: SupportImageSource;
  readonly ids: IdGenerator;
  readonly context: SupportContextSource;
  readonly conversations: Pick<BusinessConversationRepository, 'findById' | 'lockById'>;
  readonly messages: Pick<BusinessMessageRepository, 'recent' | 'findByTelegramId'>;
  readonly outbound: Pick<BusinessOutboundRepository, 'countAuto'>;
  readonly control: Pick<BusinessConversationService, 'handOff' | 'enqueueAutoSend'>;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly scopeActivity: ScopeActivityReader;
  readonly clock: Clock;
  readonly logger?: Pick<Logger, 'info'>;
}

/** What one job came to; `GONE` when a newer message replaced it meanwhile. */
export type AutoJobResult = SupportAiAutoOutcome | 'GONE';

class JobGone extends Error {}

/**
 * TB7 — `AUTO_REPLY_SAFE`, the producer's side (program §25–§27). The `assistant` role calls
 * `produce` on a claimed, due AUTO job, OUTSIDE any transaction.
 *
 *   1. Re-check mode, epoch and state: a person who spoke during the settle delay, or a mode
 *      switched off, drops the job and nothing is spent.
 *   2. Preflight guards (content, blocked customer, loop guard) before any provider cost.
 *   3. The TB4 chain → the strict decision schema → the deterministic guards. Every guard must
 *      pass. Anything else — the model's own HANDOFF, a hard topic, invalid output, a chain
 *      failure, a guard failure — HANDS OFF (TB2 `handOff`, which records the escalation,
 *      opens or links the ticket and signals an operator) and sends nothing.
 *   4. A passing reply is enqueued on the lane as an `AUTO` row under the CAPTURED epoch, in a
 *      transaction that re-checks mode, epoch, state and the job's own state. TB2's final
 *      check at the send stamp supersedes it if a person intervenes after that.
 *
 * The AI never acts on money, services or ownership: its only output is a reply, or nothing.
 */
export class SupportAutoReplyService {
  constructor(private readonly deps: SupportAutoReplyServiceDeps) {}

  async produce(scope: ScopeContext, job: SupportAiJobRecord): Promise<AutoJobResult> {
    const epoch = job.controlEpoch ?? -1;
    const triggerId = job.triggerTelegramMessageId ?? -1;
    const [conversation, { config }] = await Promise.all([
      this.deps.conversations.findById(scope, job.conversationId),
      this.deps.configs.get(scope),
    ]);
    // 1. Has the world moved since the job was enqueued?
    if (config.mode !== 'AUTO_REPLY_SAFE') return this.drop(scope, job, 'dropped_mode');
    if (conversation === null || conversation.controlEpoch !== epoch) {
      return this.drop(scope, job, 'dropped_epoch');
    }
    if (conversation.state !== 'AI_ACTIVE') return this.drop(scope, job, 'dropped_state');

    // 2. Preflight: nothing here needs the model.
    const now = this.deps.clock.now();
    const [trigger, counts, context] = await Promise.all([
      this.deps.messages.findByTelegramId(scope, conversation.id, triggerId),
      this.deps.outbound.countAuto(scope, {
        conversationId: conversation.id,
        epoch,
        since: new Date(now.getTime() - SUPPORT_AI_AUTO_WINDOW.windowSeconds * 1000),
      }),
      this.deps.context.build(scope, conversation.customerId),
    ]);
    const preflight = autoPreflight({
      trigger:
        trigger === null
          ? null
          : {
              origin: trigger.origin,
              kind: trigger.kind,
              text: trigger.text,
              deleted: trigger.deletedAt !== null,
            },
      customerBlocked: context.flags.customerBlocked,
      autoAtEpoch: counts.atEpoch,
      autoInWindow: counts.inWindow,
      maxConsecutiveReplies: config.maxConsecutiveReplies,
      maxPerWindow: SUPPORT_AI_AUTO_WINDOW.maxPerWindow,
    });
    if (!preflight.pass) return this.handOff(scope, job, preflight, null, null);

    // 3. Never for a stopped tenant: the decision to send a customer's
    // transcript to a provider is business work and checks scope activity in a transaction
    // first (TB5 review, docs/conventions.md). The job ends `dropped_scope`, as at the result.
    const active = await this.deps.uow.run(scope, (tx) =>
      this.deps.scopeActivity.scopeIsActive(scope, tx),
    );
    if (!active) return this.drop(scope, job, 'dropped_scope');
    // 4. TB6 — vision: the customer images the request may carry, fetched OUTSIDE any
    // transaction through the tenant-scoped source.
    const transcript = await this.deps.messages.recent(scope, conversation.id, 40);
    const plan = planVision(transcript, {
      visionEnabled: config.visionEnabled,
      visionStepConfigured: this.deps.chain.visionStepConfigured(config),
    });
    const skipped = new Map<string, SupportAiImageSkipReason>(plan.skipped);
    const loaded = new Map<string, { image: TranscriptImage; byteSize: number }>();
    for (const messageId of plan.fetch) {
      const load = await this.deps.images.load(scope, {
        conversationId: conversation.id,
        messageId,
      });
      if (load.outcome === 'LOADED')
        loaded.set(messageId, { image: load.image, byteSize: load.byteSize });
      else skipped.set(messageId, load.reason);
    }
    // The image the reply would be about must be SEEN, or nobody answers it automatically.
    const required = [
      ...(trigger !== null && trigger.kind === 'PHOTO' ? [trigger.id] : []),
      ...(plan.latestInboundImageId === null ? [] : [plan.latestInboundImageId]),
    ];
    const unseen = autoImageGuard({ required, loaded: new Set(loaded.keys()) });
    if (!unseen.pass) {
      await this.recordImages(scope, job.id, skipped, loaded, 'NOT_ANSWERED');
      return this.handOff(scope, job, unseen, null, null);
    }
    const lines: TranscriptLine[] = transcript.map((m) => ({
      origin: m.origin,
      text: m.text,
      kind: m.kind,
      image: loaded.get(m.id)?.image ?? null,
    }));

    // 4. The model proposes.
    const turns = transcriptMessages(lines, { attachImages: false });
    if (turns.length === 0) {
      const unreadable = {
        pass: false,
        guard: 'content',
        outcome: 'guard_content',
        reason: 'UNSUPPORTED_CONTENT',
      } as const;
      return this.handOff(scope, job, unreadable, null, null);
    }
    const result = await this.deps.chain.generate(scope, {
      operation: 'AUTO_DECISION',
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
        maxOutputTokens: Math.min(4_000, config.maxOutputChars * 3 + 600),
      },
      ...(loaded.size === 0
        ? {}
        : {
            vision: {
              messages: transcriptMessages(lines, { attachImages: true }),
              required: required.length > 0,
            },
          }),
    });
    const answered = result.outcome.outcome === 'OK' && result.step !== null;
    const seen = answered && result.imagesSent > 0;
    await this.recordImages(
      scope,
      job.id,
      skipped,
      loaded,
      seen ? null : answered ? 'NO_VISION_CAPABILITY' : 'NOT_ANSWERED',
    );
    // No configured step could look at a required image: an unseen image hands off.
    if (result.exhausted === 'NO_VISION_STEP' || (required.length > 0 && answered && !seen)) {
      return this.handOff(scope, job, fail('content', 'UNSUPPORTED_CONTENT'), null, null);
    }
    if (result.outcome.outcome !== 'OK' || result.step === null) {
      // A provider that refused or produced something unparseable is not "unavailable".
      const invalid =
        result.outcome.outcome === 'INVALID_OUTPUT' ||
        result.outcome.outcome === 'REFUSED_BY_PROVIDER';
      return this.handOff(
        scope,
        job,
        invalid
          ? verdict('handoff_output_invalid', 'AI_OUTPUT_INVALID')
          : verdict('handoff_ai_unavailable', 'AI_UNAVAILABLE'),
        null,
        null,
      );
    }
    const parsed = supportAiDecisionSchema.safeParse(result.outcome.output);
    const produced = { provider: result.step.provider, model: result.outcome.model };
    if (!parsed.success) {
      return this.handOff(
        scope,
        job,
        verdict('handoff_output_invalid', 'AI_OUTPUT_INVALID'),
        null,
        produced,
      );
    }

    // 4. NEXA decides.
    const guards = autoDecisionGuards({
      decision: parsed.data,
      config,
      flags: context.flags,
      knownAliases: new Set(context.aliases.keys()),
    });
    if (!guards.pass) return this.handOff(scope, job, guards, parsed.data, produced);
    return this.enqueue(scope, job, parsed.data, produced);
  }

  /** TB6 telemetry: one row per customer image considered; never a byte, file id or URL. */
  private async recordImages(
    scope: ScopeContext,
    jobId: string,
    skipped: ReadonlyMap<string, SupportAiImageSkipReason>,
    loaded: ReadonlyMap<string, { image: TranscriptImage; byteSize: number }>,
    loadedReason: SupportAiImageSkipReason | null,
  ): Promise<void> {
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
    // Its own transaction, under the activity check every write takes (TB5 review): a tenant
    // stopped during the fetch or the call records no telemetry.
    await this.deps.uow.run(scope, async (tx) => {
      if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) return;
      await this.deps.jobs.recordImageOutcomes(scope, jobId, rows, this.deps.clock.now(), tx);
    });
  }

  /** A job claimed too many times without a result: repeated failure hands off. */
  async giveUp(scope: ScopeContext, job: SupportAiJobRecord): Promise<AutoJobResult> {
    return this.handOff(
      scope,
      job,
      verdict('handoff_ai_unavailable', 'AI_UNAVAILABLE'),
      null,
      null,
    );
  }

  private async enqueue(
    scope: ScopeContext,
    job: SupportAiJobRecord,
    decision: SupportAiDecision,
    produced: { readonly provider: SupportAiProvider; readonly model: string },
  ): Promise<AutoJobResult> {
    return this.inJobTransaction(scope, job, async (tx, now) => {
      const { config } = await this.deps.configs.get(scope, tx);
      if (config.mode !== 'AUTO_REPLY_SAFE')
        return this.finish(scope, job, 'dropped_mode', now, tx);
      const queued = await this.deps.control.enqueueAutoSend(
        scope,
        {
          conversationId: job.conversationId,
          controlEpoch: job.controlEpoch ?? -1,
          text: decision.replyText.trim(),
          idempotencyKey: `support-ai:auto:${job.id}`,
          now,
        },
        tx,
      );
      if ('refused' in queued) {
        return this.finish(scope, job, `dropped_${queued.refused}`, now, tx, {
          decision,
          produced,
        });
      }
      const ok = await this.deps.jobs.finishAuto(
        scope,
        job.id,
        {
          state: 'SENT',
          outcome: 'sent',
          decision,
          provider: produced.provider,
          model: produced.model,
          sentOutboundId: queued.row.id,
          now,
        },
        tx,
      );
      if (!ok) throw new JobGone();
      return 'sent';
    });
  }

  /**
   * Hands the conversation to a person — but only the conversation this job was about: if a
   * person already intervened (the epoch moved) the job is dropped, because the person holds it.
   */
  private async handOff(
    scope: ScopeContext,
    job: SupportAiJobRecord,
    failed: Extract<AutoVerdict, { pass: false }>,
    decision: SupportAiDecision | null,
    produced: { readonly provider: SupportAiProvider; readonly model: string } | null,
  ): Promise<AutoJobResult> {
    return this.inJobTransaction(scope, job, async (tx, now) => {
      const conversation = await this.deps.conversations.lockById(scope, job.conversationId, tx);
      if (conversation === null || conversation.controlEpoch !== job.controlEpoch) {
        return this.finish(scope, job, 'dropped_epoch', now, tx, { decision, produced });
      }
      if (conversation.state !== 'AI_ACTIVE') {
        return this.finish(scope, job, 'dropped_state', now, tx, { decision, produced });
      }
      await this.deps.control.handOff(scope, conversation.id, failed.reason, now, tx, {
        summary: decision?.summary.trim() === '' ? null : (decision?.summary ?? null),
        jobId: job.id,
      });
      const ok = await this.deps.jobs.finishAuto(
        scope,
        job.id,
        {
          state: 'FAILED',
          outcome: failed.outcome,
          handoffReason: failed.reason,
          decision,
          provider: produced?.provider ?? null,
          model: produced?.model ?? null,
          now,
        },
        tx,
      );
      // Replaced by a newer message meanwhile: roll the handoff back with it.
      if (!ok) throw new JobGone();
      return failed.outcome;
    });
  }

  private async drop(
    scope: ScopeContext,
    job: SupportAiJobRecord,
    outcome: SupportAiAutoOutcome,
  ): Promise<AutoJobResult> {
    // Every write checks scope activity in its own transaction (TB5 review): a drop for a
    // stopped tenant is recorded as `dropped_scope`, the same as a result that lands after a stop.
    return this.inJobTransaction(scope, job, (tx, now) =>
      this.finish(scope, job, outcome, now, tx),
    );
  }

  private async finish(
    scope: ScopeContext,
    job: SupportAiJobRecord,
    outcome: SupportAiAutoOutcome,
    now: Date,
    tx: unknown,
    result?: {
      readonly decision: SupportAiDecision | null;
      readonly produced: { readonly provider: SupportAiProvider; readonly model: string } | null;
    },
  ): Promise<AutoJobResult> {
    const ok = await this.deps.jobs.finishAuto(
      scope,
      job.id,
      {
        state: 'DISCARDED',
        outcome,
        decision: result?.decision ?? null,
        provider: result?.produced?.provider ?? null,
        model: result?.produced?.model ?? null,
        now,
      },
      tx,
    );
    if (!ok) throw new JobGone();
    return outcome;
  }

  /** One transaction that reads scope activity first; a replaced job rolls everything back. */
  private async inJobTransaction(
    scope: ScopeContext,
    job: SupportAiJobRecord,
    work: (tx: TransactionScope, now: Date) => Promise<AutoJobResult>,
  ): Promise<AutoJobResult> {
    try {
      return await this.deps.uow.run(scope, async (tx) => {
        const now = this.deps.clock.now();
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
          return this.finish(scope, job, 'dropped_scope', now, tx);
        }
        return work(tx, now);
      });
    } catch (error) {
      if (error instanceof JobGone) return 'GONE';
      throw error;
    }
  }
}

function fail(
  guard: 'content',
  reason: BusinessHandoffReason,
): Extract<AutoVerdict, { pass: false }> {
  return { pass: false, guard, outcome: `guard_${guard}`, reason };
}

function verdict(
  outcome: SupportAiAutoOutcome,
  reason: BusinessHandoffReason,
): Extract<AutoVerdict, { pass: false }> {
  return { pass: false, guard: null, outcome, reason };
}
