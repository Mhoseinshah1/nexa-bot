import {
  SUPPORT_AI_AUTO_STALE_SECONDS,
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
  BusinessMessageRecord,
  BusinessMessageRepository,
  BusinessOutboundRepository,
  InboundAutoTrigger,
} from '../../../commerce/business-chats/application/ports.js';
import {
  autoDecisionGuards,
  autoImageGuard,
  autoMoneyGuard,
  autoPreflight,
  customerTextsSinceReply,
  type AutoContextFlags,
  type AutoVerdict,
} from '../domain/auto-reply-guards.js';
import { planVision } from '../domain/vision.js';
import { latestCustomerWords } from '../domain/transcript.js';
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
import type { SupportAiChain, SupportAiVisionVariant } from './support-ai-chain.js';
import type { SupportImageSource } from './ports.js';
import { readSupportTranscript } from './support-transcript.js';
import { withKnowledgeCounts } from './knowledge-telemetry.js';

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
 * - An edit re-enqueues ONLY while the conversation still has a pending job AND the edit is of
 *   that job's own trigger (the edit changes what is about to be answered). An edit of an
 *   already-answered message starts nothing, and an edit of an OLDER message while a job is
 *   pending leaves the job on its newer trigger — re-targeting it would answer the older
 *   message (substitute review of PR #202). The pending job reads the edited transcript anyway.
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
    if (
      input.edited &&
      pending !== null &&
      pending.triggerTelegramMessageId !== input.telegramMessageId
    ) {
      return;
    }
    if (pending !== null) {
      await this.deps.jobs.finishAuto(
        scope,
        pending.id,
        { state: 'DISCARDED', outcome: 'dropped_coalesced', now: input.now },
        tx,
      );
    }
    const settle = input.now.getTime() + config.settleDelaySeconds * 1000;
    // `lastAiAt` is Telegram's date for the delivered reply (PR #205 review, S1), so the
    // cooldown runs from when Telegram stamped it: off the server's clock by the host's skew
    // and by under a second of truncation — a bound, not a new rule.
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
  readonly jobs: Pick<
    DrizzleSupportAiJobRepository,
    'finishAuto' | 'recordImageOutcomes' | 'recordKnowledgeCounts'
  >;
  readonly configs: Pick<DrizzleSupportAiConfigRepository, 'get'>;
  readonly chain: Pick<SupportAiChain, 'generate' | 'visionStepConfigured'>;
  /** TB6: the one way a customer's image is read (tenant-scoped, bounded, sniffed). */
  readonly images: SupportImageSource;
  readonly ids: IdGenerator;
  readonly context: SupportContextSource;
  readonly conversations: Pick<BusinessConversationRepository, 'findById' | 'lockById'>;
  readonly messages: Pick<BusinessMessageRepository, 'recent' | 'findByTelegramId'>;
  /** The loop guard's counts, and (D7) the delivered replies the transcript carries. */
  readonly outbound: Pick<BusinessOutboundRepository, 'countAuto' | 'recent'>;
  /**
   * The guards' account facts, read INSIDE the enqueue transaction (substitute review of
   * PR #202, finding 1): the decision guards run again on what is true at the enqueue, not on
   * the snapshot the provider was given.
   */
  readonly facts: AutoGuardFacts;
  readonly control: Pick<BusinessConversationService, 'handOff' | 'enqueueAutoSend'>;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly scopeActivity: ScopeActivityReader;
  readonly clock: Clock;
  readonly logger?: Pick<Logger, 'info'>;
}

/** The guards' account facts for one customer, read in the caller's transaction. */
export interface AutoGuardFacts {
  autoGuardFlags(
    scope: ScopeContext,
    customerId: string | null,
    tx?: unknown,
  ): Promise<AutoContextFlags>;
}

/**
 * What one job came to; `GONE` when a newer message replaced it meanwhile; `INACTIVE` when the
 * tenant is stopped — the job is left exactly as it is (no write: a stopped scope takes none,
 * ours included), and on resume it is claimed again and judged by the staleness rule.
 */
export type AutoJobResult = SupportAiAutoOutcome | 'GONE' | 'INACTIVE';

class JobGone extends Error {}
class ScopeStopped extends Error {}

/** TB6: the per-image outcome rows of one job, written inside its own transition's transaction. */
type ImageWrite = (now: Date, tx: TransactionScope) => Promise<void>;

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

    // 1b. Too late to answer automatically (the assistant was down, or the tenant was stopped
    // and resumed): a person answers instead, and no provider is asked.
    const now = this.deps.clock.now();
    if (isStale(job, now)) return this.handOff(scope, job, STALE, null, null);

    // 2. Preflight: nothing here needs the model. The transcript is read first: the customer's
    // latest words choose the knowledge the context carries (D2).
    const transcript = await readSupportTranscript(this.deps, scope, conversation.id);
    const context = await this.deps.context.build(scope, conversation.customerId, {
      query: latestCustomerWords(transcript),
    });
    const { verdict: preflight, trigger } = await this.preflight(
      scope,
      job,
      conversation.id,
      config,
      context.flags.customerBlocked,
      now,
    );
    if (!preflight.pass) return this.handOff(scope, job, preflight, null, null);

    // 3. Never for a stopped tenant: the decision to send a customer's transcript to a provider
    // is business work and checks scope activity in a transaction first (TB5 review,
    // docs/conventions.md). A stopped scope's job is left untouched — no write, ours included.
    const active = await this.deps.uow.run(scope, (tx) =>
      this.deps.scopeActivity.scopeIsActive(scope, tx),
    );
    if (!active) return 'INACTIVE';
    // 4. TB6 — vision: the customer images the request may carry, fetched OUTSIDE any
    // transaction through the tenant-scoped source.
    // D9: money in what the customer wrote is a person's, whatever topic a model would pick.
    const money = autoMoneyGuard(customerTextsSinceReply(transcript, trigger?.text ?? null));
    if (!money.pass) return this.handOff(scope, job, money, null, null);
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
      return this.handOff(
        scope,
        job,
        unseen,
        null,
        null,
        this.imageWriter(scope, job.id, skipped, loaded, () => 'NOT_ANSWERED'),
      );
    }
    const lines: TranscriptLine[] = transcript.map((m) => ({
      origin: m.origin,
      text: m.text,
      kind: m.kind,
      image: loaded.get(m.id)?.image ?? null,
    }));

    // 5. The model proposes.
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
    // Each step is given exactly the images it can see (TB6, `stepSight`): the chain picks
    // them, and `render` attaches those and marks every other one unseen. A step that cannot
    // see the latest image is never called (`requiredId`); every other required image (the
    // trigger) is checked against the answering step's `sight` below.
    const requiredId = plan.latestInboundImageId ?? required[0] ?? null;
    const vision: SupportAiVisionVariant | null =
      loaded.size === 0
        ? null
        : {
            images: transcript.flatMap((m) => {
              const image = loaded.get(m.id)?.image;
              return image === undefined ? [] : [{ id: m.id, image }];
            }),
            requiredId: requiredId !== null && loaded.has(requiredId) ? requiredId : null,
            render: (seen) =>
              transcriptMessages(
                transcript.map((m) => ({
                  origin: m.origin,
                  text: m.text,
                  kind: m.kind,
                  image: seen.has(m.id) ? (loaded.get(m.id)?.image ?? null) : null,
                })),
                { attachImages: true },
              ),
          };
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
      ...(vision === null ? {} : { vision }),
    });
    const answered = result.outcome.outcome === 'OK' && result.step !== null;
    const seenIds = new Set(answered ? result.sight.seen : []);
    // A loaded image is PROCESSED only when the step that ANSWERED was given it. The rows are
    // written only with this job's own transition, in its transaction (TB6 review, S1).
    // D2: the knowledge counts go with the job's result, in its transaction.
    const images = withKnowledgeCounts(
      this.deps.jobs,
      scope,
      job.id,
      context.knowledge,
      this.imageWriter(scope, job.id, skipped, loaded, (messageId) =>
        seenIds.has(messageId)
          ? null
          : answered
            ? (result.sight.unseen.get(messageId) ?? 'NO_VISION_CAPABILITY')
            : 'NOT_ANSWERED',
      ),
    );
    // No configured step could look at a required image: an unseen image hands off.
    if (
      result.exhausted === 'NO_VISION_STEP' ||
      (answered && !required.every((id) => seenIds.has(id)))
    ) {
      return this.handOff(scope, job, fail('content', 'UNSUPPORTED_CONTENT'), null, null, images);
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
        images,
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
        images,
      );
    }

    // 6. NEXA decides.
    const guards = autoDecisionGuards({
      decision: parsed.data,
      config,
      flags: context.flags,
      knownAliases: knownAliases(context),
    });
    if (!guards.pass) return this.handOff(scope, job, guards, parsed.data, produced, images);
    return this.enqueue(scope, job, parsed.data, produced, knownAliases(context), images);
  }

  /**
   * The content, blocked-customer and loop guards, on the trigger and the counts as they are
   * NOW (in `tx` when given). Run before the provider call (`customerBlocked` from the payload)
   * and again in the enqueue transaction (from the in-transaction facts).
   */
  private async preflight(
    scope: ScopeContext,
    job: SupportAiJobRecord,
    conversationId: string,
    config: { readonly maxConsecutiveReplies: number },
    customerBlocked: boolean,
    now: Date,
    tx?: unknown,
  ): Promise<{ readonly verdict: AutoVerdict; readonly trigger: BusinessMessageRecord | null }> {
    const epoch = job.controlEpoch ?? -1;
    const [trigger, counts] = await Promise.all([
      this.deps.messages.findByTelegramId(
        scope,
        conversationId,
        job.triggerTelegramMessageId ?? -1,
        tx,
      ),
      this.deps.outbound.countAuto(
        scope,
        {
          conversationId,
          epoch,
          since: new Date(now.getTime() - SUPPORT_AI_AUTO_WINDOW.windowSeconds * 1000),
        },
        tx,
      ),
    ]);
    const verdict = autoPreflight({
      trigger:
        trigger === null
          ? null
          : {
              origin: trigger.origin,
              kind: trigger.kind,
              text: trigger.text,
              deleted: trigger.deletedAt !== null,
            },
      customerBlocked,
      autoAtEpoch: counts.atEpoch,
      autoInWindow: counts.inWindow,
      maxConsecutiveReplies: config.maxConsecutiveReplies,
      maxPerWindow: SUPPORT_AI_AUTO_WINDOW.maxPerWindow,
    });
    return { verdict, trigger };
  }

  /**
   * TB6 telemetry: one row per customer image considered; never a byte, file id or URL.
   * Returned as a write the job's own transition runs in its transaction, AFTER that transition
   * succeeded (TB6 review, S1): a job replaced or dropped meanwhile records no rows, and a
   * stopped tenant none either.
   */
  private imageWriter(
    scope: ScopeContext,
    jobId: string,
    skipped: ReadonlyMap<string, SupportAiImageSkipReason>,
    loaded: ReadonlyMap<string, { image: TranscriptImage; byteSize: number }>,
    loadedReason: (messageId: string) => SupportAiImageSkipReason | null,
  ): ImageWrite {
    const rows = [
      ...[...loaded].map(([messageId, { image, byteSize }]) => {
        const reason = loadedReason(messageId);
        return {
          id: this.deps.ids.uuid(),
          messageId,
          outcome: reason === null ? ('PROCESSED' as const) : ('SKIPPED' as const),
          reason,
          mediaType: image.mediaType,
          byteSize,
        };
      }),
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

  /**
   * The reply onto the lane, in ONE transaction that decides again on what is true NOW
   * (substitute review of PR #202, finding 1). Under the conversation's lock: the epoch and the
   * state; then the configuration (the mode, and every guard that reads it — the allowlist, the
   * confidence, the bounds, the loop limit), the trigger (still the customer's, not deleted),
   * the loop counts, and the customer's account facts, each read in this transaction. The
   * deterministic guards run again on them; one that now fails HANDS OFF, in this transaction,
   * instead of enqueueing — the provider call can take minutes, and a guard that passed on the
   * facts of before it is not a guard.
   */
  private async enqueue(
    scope: ScopeContext,
    job: SupportAiJobRecord,
    decision: SupportAiDecision,
    produced: { readonly provider: SupportAiProvider; readonly model: string },
    aliases: ReadonlySet<string>,
    images?: ImageWrite,
  ): Promise<AutoJobResult> {
    return this.inJobTransaction(scope, job, images, async (tx, now) => {
      const { config } = await this.deps.configs.get(scope, tx);
      if (config.mode !== 'AUTO_REPLY_SAFE')
        return this.finish(scope, job, 'dropped_mode', now, tx);
      // The conversation's lock first, so the facts below are read against a conversation no
      // human signal can move until this commits (`enqueueAutoSend` re-takes the same lock).
      const conversation = await this.deps.conversations.lockById(scope, job.conversationId, tx);
      const flags = await this.deps.facts.autoGuardFlags(
        scope,
        conversation?.customerId ?? null,
        tx,
      );
      const { verdict: preflight } = await this.preflight(
        scope,
        job,
        job.conversationId,
        config,
        flags.customerBlocked,
        now,
        tx,
      );
      const recheck: AutoVerdict = !preflight.pass
        ? preflight
        : autoDecisionGuards({ decision, config, flags, knownAliases: aliases });
      if (!recheck.pass)
        return this.handOffChecked(scope, job, recheck, decision, produced, now, tx);
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
    images?: ImageWrite,
  ): Promise<AutoJobResult> {
    return this.inJobTransaction(scope, job, images, (tx, now) =>
      this.handOffChecked(scope, job, failed, decision, produced, now, tx),
    );
  }

  /**
   * The handoff in the caller's transaction, under the conversation's lock — for the
   * conversation this job was about only: an epoch that moved (a person took over, even one who
   * has since resumed the AI) or a state other than AI_ACTIVE drops the job instead.
   */
  private async handOffChecked(
    scope: ScopeContext,
    job: SupportAiJobRecord,
    failed: Extract<AutoVerdict, { pass: false }>,
    decision: SupportAiDecision | null,
    produced: { readonly provider: SupportAiProvider; readonly model: string } | null,
    now: Date,
    tx: TransactionScope,
  ): Promise<AutoJobResult> {
    const conversation = await this.deps.conversations.lockById(scope, job.conversationId, tx);
    if (conversation === null || conversation.controlEpoch !== job.controlEpoch) {
      return this.finish(scope, job, 'dropped_epoch', now, tx, { decision, produced });
    }
    if (conversation.state !== 'AI_ACTIVE') {
      return this.finish(scope, job, 'dropped_state', now, tx, { decision, produced });
    }
    {
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
    }
  }

  private async drop(
    scope: ScopeContext,
    job: SupportAiJobRecord,
    outcome: SupportAiAutoOutcome,
  ): Promise<AutoJobResult> {
    // Every write checks scope activity in its own transaction (TB5 review): a drop for a
    // stopped tenant writes nothing, and the job waits, untouched, for the tenant's resume.
    return this.inJobTransaction(scope, job, undefined, (tx, now) =>
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

  /**
   * One transaction that reads scope activity first; a replaced job rolls everything back.
   * `images` runs only after `work` returned, which it does only once the job's own conditional
   * transition out of QUEUED has succeeded (a lost one throws `JobGone`): the telemetry has
   * exactly one writer.
   *
   * A STOPPED scope writes nothing at all — not the job, not its telemetry (docs/conventions.md;
   * the Product Owner's rule, substitute review of PR #202): `INACTIVE`, the job left QUEUED
   * under its lease exactly as TB5 leaves an Assist draft. On resume it is claimed again, and a
   * job that waited past `SUPPORT_AI_AUTO_STALE_SECONDS` hands off rather than answering.
   */
  private async inJobTransaction(
    scope: ScopeContext,
    job: SupportAiJobRecord,
    images: ImageWrite | undefined,
    work: (tx: TransactionScope, now: Date) => Promise<AutoJobResult>,
  ): Promise<AutoJobResult> {
    try {
      return await this.deps.uow.run(scope, async (tx) => {
        const now = this.deps.clock.now();
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) throw new ScopeStopped();
        const result = await work(tx, now);
        if (images !== undefined) await images(now, tx);
        return result;
      });
    } catch (error) {
      if (error instanceof JobGone) return 'GONE';
      if (error instanceof ScopeStopped) return 'INACTIVE';
      throw error;
    }
  }
}

/** A job produced this long after it fell due is too late to answer automatically. */
export function isStale(job: Pick<SupportAiJobRecord, 'dueAt'>, now: Date): boolean {
  return (
    job.dueAt !== null && now.getTime() - job.dueAt.getTime() > SUPPORT_AI_AUTO_STALE_SECONDS * 1000
  );
}

const STALE: Extract<AutoVerdict, { pass: false }> = {
  pass: false,
  guard: null,
  outcome: 'handoff_stale',
  reason: 'REPLY_STALE',
};

function knownAliases(context: { readonly aliases: ReadonlyMap<string, unknown> }) {
  return new Set(context.aliases.keys());
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
