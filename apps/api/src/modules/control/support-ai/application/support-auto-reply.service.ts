import {
  SUPPORT_AI_AUTO_STALE_SECONDS,
  SUPPORT_AI_AUTO_WINDOW,
  SUPPORT_AI_DECISION_JSON_SCHEMA,
  SUPPORT_AI_JOB_EXCEPTION_CODE,
  SUPPORT_AI_JOB_RETRY_DELAY_MS,
  SUPPORT_AI_LINK_ACCOUNT_TEMPLATE_KEY,
  SUPPORT_AI_LINK_SENT_CODE,
  SUPPORT_AI_PAYMENT_CHECK_WINDOW_DAYS,
  SUPPORT_AI_REFUSAL_LIMIT,
  SUPPORT_AI_SESSION_INACTIVITY_SECONDS,
  SUPPORT_AI_SUSPICIOUS_PROBING_CODE,
  SUPPORT_AI_TEMPLATE_KEYS,
  SUPPORT_AI_UNDER_REVIEW_WINDOW_DAYS,
  BUSINESS_ESCALATION_SUMMARY_MAX,
  supportAiCallbackData,
  type BusinessHandoffReason,
  type BusinessOutboundButton,
  type BusinessOutboundButtons,
  type SupportAiActionKind,
  type OperationalEventRecorder,
  type SupportAiAutoGuard,
  type Clock,
  type IdGenerator,
  type Logger,
  type ScopeContext,
  type SupportAiAutoOutcome,
  type SupportAiDecision,
  type SupportAiFailureClass,
  type SupportAiImageSkipReason,
  type SupportAiProvider,
  type UnitOfWork,
} from '@nexa/contracts';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { TemplateResolver } from '../../templates/application/template-resolver.js';
import { appearanceFallbackText } from '../../../commerce/messaging/application/appearance-render.js';
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
  autoInboundFloodGuard,
  autoMoneyGuard,
  autoNoActionVerdict,
  autoNoProgressGuard,
  autoPreflight,
  autoRepeatedAdviceGuard,
  customerTextsSinceReply,
  isClosingAcknowledgement,
  moneyGuardWindow,
  moneyMatterOf,
  type AutoContextFlags,
  type AutoVerdict,
} from '../domain/auto-reply-guards.js';
import { planVision } from '../domain/vision.js';
import {
  OUTPUT_POLICY_REGENERATE_NOTE,
  REPEATED_ADVICE_REGENERATE_NOTE,
  checkOutputPolicy,
  outputPolicyAllowanceFromContext,
} from '../domain/output-policy.js';
import { decisionOutputTokens, parseSupportDecision } from '../domain/decision.js';
import {
  PAYMENT_CHECK_SUMMARY_WORDS,
  composeAiMessage,
  composeButtons,
  deepLinkUrl,
  paymentCheckBranch,
  paymentCheckSummary,
  planAction,
  toolCallLimitReached,
  type ActionPlan,
  type PaymentCheckFact,
} from '../domain/actions.js';
import {
  SUPPORT_AI_TOOLS_OFF,
  type SupportAiToolReader,
  type SupportAiToolSettings,
} from './support-ai-tools.js';
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
import {
  resolveKnowledgeLabels,
  unclaimedCutoff,
  type SupportContextSource,
} from './support-assist.service.js';
import { hashRequest } from '../../../platform/idempotency/infrastructure/drizzle-idempotency-store.js';
import {
  chainFailureClass,
  type SupportAiChain,
  type SupportAiVisionVariant,
} from './support-ai-chain.js';
import type { SupportImageSource } from './ports.js';
import { SUPPORT_TRANSCRIPT_READ_LINES, readSupportTranscript } from './support-transcript.js';
import { withKnowledgeCounts } from './knowledge-telemetry.js';

/** The key that makes an automatic job idempotent on its message (and content version). */
export function autoJobKey(conversationId: string, telegramMessageId: number, version: number) {
  return `auto:${conversationId}:${telegramMessageId}:v${version}`;
}

/** Phase 4 PR-5: the key of the draft ASSIST_ONLY prepares for one inbound message. */
export function autoDraftKey(conversationId: string, telegramMessageId: number, version: number) {
  return `assist-auto:${conversationId}:${telegramMessageId}:v${version}`;
}

export interface SupportAutoEnqueuerDeps {
  readonly configs: Pick<DrizzleSupportAiConfigRepository, 'get'>;
  readonly jobs: Pick<
    DrizzleSupportAiJobRepository,
    | 'insertAuto'
    | 'queuedAuto'
    | 'finishAuto'
    | 'findByIdempotencyKey'
    | 'insertAutoDraft'
    | 'discardOpen'
    | 'failUnclaimed'
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
    const { config } = await this.deps.configs.get(scope, tx);
    // Phase 4 PR-5: ASSIST_ONLY prepares a DRAFT for every inbound message, whoever holds the
    // conversation (a person answering it is who the draft is for). Never a send.
    if (config.mode === 'ASSIST_ONLY') return this.draftFor(scope, input, tx);
    if (conversation.state !== 'AI_ACTIVE') return;
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

  /**
   * ASSIST_ONLY's draft for one inbound message. Idempotent on the message and its version
   * (a redelivery enqueues nothing); an edit of an older message starts nothing; a newer message
   * replaces the open draft, exactly as an operator's re-request does (`discardOpen`). The draft
   * is produced by the `assistant` role as any requested one is, sits in the conversation for a
   * person to read, edit and send, and is purged with the transcript. NOTHING is sent here.
   */
  private async draftFor(
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
    if (input.edited) return;
    const conversation = input.conversation;
    const key = autoDraftKey(conversation.id, input.telegramMessageId, input.contentVersion);
    if ((await this.deps.jobs.findByIdempotencyKey(scope, key, tx)) !== null) return;
    await this.deps.jobs.failUnclaimed(
      scope,
      conversation.id,
      unclaimedCutoff(input.now),
      input.now,
      tx,
    );
    await this.deps.jobs.discardOpen(scope, conversation.id, input.now, tx);
    await this.deps.jobs.insertAutoDraft(
      scope,
      {
        id: this.deps.ids.uuid(),
        conversationId: conversation.id,
        idempotencyKey: key,
        requestHash: hashRequest({ command: 'support_ai.draft.auto', key }),
        now: input.now,
      },
      tx,
    );
  }
}

export interface SupportAutoReplyServiceDeps {
  readonly jobs: Pick<
    DrizzleSupportAiJobRepository,
    | 'finishAuto'
    | 'recordImageOutcomes'
    | 'recordKnowledgeCounts'
    | 'clarifyingStreak'
    | 'sessionReplyCount'
    | 'epochStartedAt'
    | 'otherStreak'
    | 'refusalCount'
    | 'releaseLease'
  >;
  readonly configs: Pick<DrizzleSupportAiConfigRepository, 'get'>;
  readonly chain: Pick<SupportAiChain, 'generate' | 'visionStepConfigured'>;
  /** TB6: the one way a customer's image is read (tenant-scoped, bounded, sniffed). */
  readonly images: SupportImageSource;
  readonly ids: IdGenerator;
  readonly context: SupportContextSource;
  readonly conversations: Pick<BusinessConversationRepository, 'findById' | 'lockById' | 'touch'>;
  readonly messages: Pick<BusinessMessageRepository, 'recent' | 'findByTelegramId'>;
  /** The loop guard's counts, and (D7) the delivered replies the transcript carries. */
  readonly outbound: Pick<
    BusinessOutboundRepository,
    'countAuto' | 'deliveredSince' | 'undeliveredAuto'
  >;
  /**
   * The guards' account facts, read INSIDE the enqueue transaction (substitute review of
   * PR #202, finding 1): the decision guards run again on what is true at the enqueue, not on
   * the snapshot the provider was given.
   */
  readonly facts: AutoGuardFacts;
  readonly control: Pick<
    BusinessConversationService,
    'handOff' | 'enqueueAutoSend' | 'autoSendPossible'
  >;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly scopeActivity: ScopeActivityReader;
  readonly clock: Clock;
  readonly logger?: Pick<Logger, 'info'>;
  /** Phase 4 PR-1: the operations log (the repeated-refusal signal). */
  readonly opsLog?: OperationalEventRecorder;
  /** Phase 4 PR-1 item 5: renders the start-link message for an unlinked customer. */
  readonly templates?: Pick<TemplateResolver, 'render'>;
  /** Phase 4 PR-1 item 5: the bot's username, for its start link. */
  readonly bots?: {
    usernameOf(scope: ScopeContext, botInstanceId: string): Promise<string | null>;
  };
  /**
   * Phase 4 PR-3: the read-only tools, the deep links and check-before-handoff. Absent (or
   * `support.ai.actions_enabled` off): replies are text only, exactly as before PR-3.
   */
  readonly tools?: {
    readonly reader: SupportAiToolReader;
    readonly settings: SupportAiToolSettings;
    readonly jobs: Pick<DrizzleSupportAiJobRepository, 'toolCallCount' | 'pendingPaymentCheck'>;
  };
}

/** Phase 4 PR-3: what a tool adds to one reply, prepared before the enqueue. */
interface PreparedTool {
  readonly toolAction: Exclude<SupportAiActionKind, 'NONE'>;
  /** Server text placed under the model's reply (a link, payment lines); never the model's. */
  readonly extra: string | null;
  /** Whether `extra` goes through the output validator with the reply (a subscription link). */
  readonly validated: boolean;
  /** The links the validator may let through for THIS reply: the customer's own link only. */
  readonly allowLinks: readonly string[];
  readonly button: BusinessOutboundButton | null;
  /** A subscription link or files button sent: re-read in the enqueue, and logged. */
  readonly linkSent: {
    readonly serviceId: string;
    readonly username: string;
    readonly link: string | null;
  } | null;
}

/** Phase 4 PR-3: what a handoff carries beyond the verdict. */
interface HandoffExtra {
  readonly toolAction?: Exclude<SupportAiActionKind, 'NONE'>;
  /** Check-before-handoff's Persian summary for the person (replaces the model's). */
  readonly summary?: string;
  readonly kind?: 'HARD' | 'SOFT';
  /** Check-before-handoff's facts message, sent as this handoff's one notice. */
  readonly notice?: { readonly body: string; readonly buttons: BusinessOutboundButtons | null };
}

/** Phase 4 PR-3: one composed automatic message. */
interface ComposedMessage {
  readonly rowId: string;
  readonly text: string;
  readonly buttons: BusinessOutboundButtons | null;
}

/** Phase 4 PR-3: what the regenerated request is told when a tool's target was refused. */
export const TOOL_SCOPE_REGENERATE_NOTE =
  'Your previous answer was refused and NOT sent: its "action" named a target that is not one of this customer\'s services or plans in the NEXA facts, or a tool this customer cannot use. Write the reply again; use only an alias exactly as the NEXA facts list it, or kind NONE.';

/** The guards' account facts for one customer, read in the caller's transaction. */
export interface AutoGuardFacts {
  autoGuardFlags(
    scope: ScopeContext,
    customerId: string | null,
    tx?: unknown,
    /** Phase 4 PR-1: the review window and the services the reply cites (their labels). */
    scoping?: { readonly since: Date; readonly serviceLabels: readonly string[] },
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
 *      pass. A `REPLY` is sent; so is an `ASK_CLARIFYING_QUESTION` (its question is the reply
 *      text) while the conversation's clarifying streak is below the tenant's limit — decided
 *      AFTER the provider, because only the decision says whether this is a question at all
 *      (a REPLY at the limit is welcome, and ends the streak). Anything else — the model's own
 *      HANDOFF, a hard topic, invalid output, a chain failure, a guard failure — HANDS OFF
 *      (TB2 `handOff`, which records the escalation, opens or links the ticket and signals an
 *      operator) and sends nothing.
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
      conversationId: conversation.id,
      transcript,
    });
    // Phase 4 PR-3: the owner's switches (tools off unless `support.ai.actions_enabled`).
    const tools = await this.toolSettings(scope);
    const { verdict: preflight, trigger } = await this.preflight(
      scope,
      job,
      conversation.id,
      { ...config, otherIsAnswerable: tools.actions },
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
    // 3b. A reply that could never be sent is never paid for: a connection that is not ACTIVE
    // (disabled, or without the `can_reply` right) drops the job BEFORE the transcript goes to a
    // provider — the same `dropped_connection` the enqueue would reach after the call. The
    // enqueue still checks again, under the conversation's lock.
    if (!(await this.deps.control.autoSendPossible(scope, conversation.id))) {
      return this.drop(scope, job, 'dropped_connection');
    }
    const botLink = await this.botLinkOf(scope, conversation.botInstanceId);
    // 3c. D9: money in what the customer wrote is a person's, whatever topic a model would pick.
    const customerTexts = customerTextsSinceReply(transcript, trigger?.text ?? null);
    // Phase 4 PR-1: the trigger and the customer's previous two lines only.
    const moneyWindow = moneyGuardWindow(transcript, trigger?.text ?? null);
    const money = autoMoneyGuard(moneyWindow);
    if (tools.actions && this.deps.tools !== undefined) {
      // Phase 4 PR-3 — a check-before-handoff waiting on this customer: the ONE question was
      // asked (any answer goes to a person, with it), or the delivered service's link was sent
      // (a thanks or a 👍 closes the matter; anything else goes to a person). Hard either way.
      const pending = context.linked
        ? await this.deps.tools.jobs.pendingPaymentCheck(scope, {
            conversationId: conversation.id,
            epoch,
            since: new Date(now.getTime() - SUPPORT_AI_SESSION_INACTIVITY_SECONDS * 1000),
          })
        : null;
      if (
        pending !== null &&
        !(pending.outcome === 'sent_payment_delivered' && pending.feedback === 'UP')
      ) {
        if (
          pending.outcome === 'sent_payment_delivered' &&
          pending.feedback === null &&
          money.pass &&
          customerTexts.length > 0 &&
          customerTexts.every(isClosingAcknowledgement)
        ) {
          return this.closeAcknowledged(scope, job);
        }
        // Review of PR #369: decided BEFORE the unsupported-content reply — a receipt sent as a
        // PDF, a voice note or a file in answer to the ONE question goes to a person with the
        // payment summary, never «please type», and the pending check is not lost.
        return this.paymentCheckFollowUp(scope, job, conversation, pending.outcome);
      }
      // 3b'. A voice message, sticker or non-image file gets ONE templated request to type the
      // question; the conversation stays with the AI (no handoff, no provider call).
      if (trigger !== null && trigger.kind === 'OTHER') {
        return this.answerUnsupported(scope, job, tools);
      }
      // «Paid but not received»: still a HARD handoff — but the AI looks first.
      if (!money.pass && moneyMatterOf(moneyWindow) === 'PAID_NOT_RECEIVED') {
        return this.paymentCheck(scope, job, conversation, context.linked, botLink, tools);
      }
    }
    if (!money.pass) return this.handOff(scope, job, money, null, null);
    // 3d. Roadmap A3 — the progress guards, deterministic and before any provider cost, on the
    // transcript since the AI's part in this epoch began: three «نشد» in a row after its advice,
    // or a customer repeating one message or flooding the chat, go to a person.
    const since = await this.deps.jobs.epochStartedAt(scope, {
      conversationId: conversation.id,
      epoch,
    });
    const progress = autoNoProgressGuard(transcript, since);
    if (!progress.pass) return this.handOff(scope, job, progress, null, null);
    const flood = autoInboundFloodGuard(transcript, since);
    if (!flood.pass) return this.handOff(scope, job, flood, null, null);
    // 4. TB6 — vision: the customer images the request may carry, fetched OUTSIDE any
    // transaction through the tenant-scoped source.
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
      author: m.author,
      text: m.text,
      kind: m.kind,
      image: loaded.get(m.id)?.image ?? null,
    }));

    // 5. The model proposes — at most twice (Phase 4 PR-1): a reply the output validator refuses,
    // or one that repeats advice already given, is asked for ONCE more with a note saying why;
    // a second refusal hands off. Nothing refused is ever sent.
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
                  author: m.author,
                  text: m.text,
                  kind: m.kind,
                  image: seen.has(m.id) ? (loaded.get(m.id)?.image ?? null) : null,
                })),
                { attachImages: true },
              ),
          };
    // The automatic reply's parse is STRICT (ADR-0034 §1): an operator note over its bound or
    // any malformed citation is invalid output, and hands off. The reply's length is the
    // `reply_bounds` guard's, not the parser's.
    const parse = (output: unknown) =>
      parseSupportDecision(output, { maxReplyChars: null, mode: 'STRICT' });
    /*
     * Phase 4 PR-3: the validator's links are the context's, the bot's start link and — only for
     * a reply that SENDS one through `SEND_SUBSCRIPTION_LINK` to this linked customer — that
     * service's own subscription link (`PreparedTool.allowLinks`). Never every service's link.
     */
    const allowanceWith = (links: readonly string[]) =>
      outputPolicyAllowanceFromContext(context.json, {
        links: [...(botLink === null ? [] : [botLink]), ...links],
        // Phase 4 PR-2: the live price family — a quoted price passes, an invented one does not.
        ...(context.priceFamily === undefined ? {} : { priceFamily: context.priceFamily }),
      });
    const botUsername = botUsernameOf(botLink);
    let regenerateNote: string | null = null;
    for (let attempt = 0; ; attempt += 1) {
      const result = await this.deps.chain.generate(scope, {
        operation: 'AUTO_DECISION',
        conversationId: conversation.id,
        jobId: job.id,
        validate: (output) => {
          const parsed = parse(output);
          return parsed.ok ? null : parsed.failure;
        },
        request: {
          system: supportSystemPrompt({
            businessToneInstructions: config.toneInstructions,
            maxReplyChars: config.maxOutputChars,
            contextJson: context.json,
            identityLinked: context.linked,
            regenerateNote,
            actionsEnabled: tools.actions,
          }),
          messages: turns,
          jsonSchema: SUPPORT_AI_DECISION_JSON_SCHEMA,
          schemaName: 'support_decision',
          maxOutputTokens: decisionOutputTokens(config.maxOutputChars),
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
        // The customer-facing outcome stays coarse (the handoff reason); the CLASS is the
        // operator's diagnosis, recorded on the job beside it.
        return this.handOff(
          scope,
          job,
          invalid
            ? verdict('handoff_output_invalid', 'AI_OUTPUT_INVALID')
            : verdict('handoff_ai_unavailable', 'AI_UNAVAILABLE'),
          null,
          null,
          images,
          chainFailureClass(result),
        );
      }
      const parsed = parse(result.outcome.output);
      const produced = { provider: result.step.provider, model: result.outcome.model };
      if (!parsed.ok) {
        return this.handOff(
          scope,
          job,
          verdict('handoff_output_invalid', 'AI_OUTPUT_INVALID'),
          null,
          produced,
          images,
          parsed.failure.failureClass,
        );
      }
      const decision = parsed.decision;

      // 5b. Roadmap A6 — «مرسی», «حل شد»: a NO_ACTION on an allowlisted, non-sensitive topic, when
      // every customer line it would answer only thanks or says it is solved, ends the job
      // silently. No reply, no handoff, no ticket; the conversation stays with the AI.
      // Review of PR #365: the cited-service flag is supplied here too, as on the reply path.
      const silenceFlags: AutoContextFlags = {
        ...context.flags,
        unreconciledCited: decision.factRefs.some(
          (ref) => context.unreconciledAliases?.has(ref) === true,
        ),
      };
      const silence = autoNoActionVerdict({ decision, config, flags: silenceFlags, customerTexts });
      // A NO_ACTION that may not close hands off with the most specific reason (an account under
      // review, a blocked customer…), as the in-transaction recheck of a silent close does.
      if (decision.decision === 'NO_ACTION' && !silence.pass) {
        return this.handOff(scope, job, silence, decision, produced, images);
      }
      if (silence.pass) {
        return this.closeSilently(
          scope,
          job,
          decision,
          produced,
          customerTexts,
          citedServiceLabels(decision, context.aliases),
          images,
        );
      }

      // 6. NEXA decides. The clarifying streak is read from the rows, never from the model.
      const grounding = {
        knownAliases: knownAliases(context),
        knownKnowledgeAliases: new Set(context.knowledgeAliases?.keys() ?? []),
      };
      const flags: AutoContextFlags = {
        ...context.flags,
        unreconciledCited: decision.factRefs.some(
          (ref) => context.unreconciledAliases?.has(ref) === true,
        ),
      };
      const guards = autoDecisionGuards({
        decision,
        config,
        flags,
        actionsEnabled: tools.actions,
        ...grounding,
        clarifyingStreak: await this.deps.jobs.clarifyingStreak(scope, {
          conversationId: conversation.id,
          epoch,
        }),
        otherStreak: await this.deps.jobs.otherStreak(scope, {
          conversationId: conversation.id,
          epoch,
        }),
      });
      const citedLabels = citedServiceLabels(decision, context.aliases);
      // Phase 4 PR-1 item 5: an unlinked customer's account question gets the bot's start link.
      if (!guards.pass && guards.sendLink === true && botLink !== null) {
        return this.enqueue(scope, job, decision, produced, grounding, since, images, [], {
          link: botLink,
          citedLabels,
        });
      }
      if (!guards.pass) {
        // No start link to send (the bot's username is unknown): the identity handoff as before.
        const failed =
          guards.sendLink === true ? failVerdict('identity', 'IDENTITY_UNVERIFIED') : guards;
        return this.handOff(scope, job, failed, decision, produced, images);
      }
      // 6a. Cross-cutting item 7: the third polite refusal in an epoch is somebody probing.
      if (
        decision.topic === 'POLICY_REFUSAL' &&
        (await this.deps.jobs.refusalCount(scope, { conversationId: conversation.id, epoch })) +
          1 >=
          SUPPORT_AI_REFUSAL_LIMIT
      ) {
        return this.handOff(
          scope,
          job,
          failVerdict('refusal_abuse', 'SUSPICIOUS_PROBING'),
          decision,
          produced,
          this.withProbingSignal(scope, conversation, epoch, images),
        );
      }
      // 6a'. Phase 4 PR-3 — the decision's tool, resolved ONLY through this payload's alias map.
      // Over the epoch's tool-call limit: tools stop, a soft handoff, the probing signal. A
      // target that is not this customer's is asked for once more, then hands off.
      let tool: PreparedTool | null = null;
      if (tools.actions && this.deps.tools !== undefined) {
        const plan = planAction(decision.action, {
          linked: context.linked,
          services: context.references?.services ?? new Map(),
          catalogue: context.references?.catalogue ?? new Map(),
          botUsername,
        });
        if (plan.kind !== 'none') {
          const toolAction = plan.kind === 'refused' ? plan.action : toolActionOf(plan);
          const used = await this.deps.tools.jobs.toolCallCount(scope, {
            conversationId: conversation.id,
            epoch,
          });
          if (toolCallLimitReached(used)) {
            return this.handOff(
              scope,
              job,
              failVerdict('tool_rate_limit', 'SUSPICIOUS_PROBING'),
              decision,
              produced,
              this.withProbingSignal(scope, conversation, epoch, images),
              null,
              { toolAction },
            );
          }
          tool =
            plan.kind === 'refused'
              ? null
              : await this.prepareTool(scope, conversation.customerId, plan, botUsername);
          if (tool === null) {
            if (attempt === 0) {
              regenerateNote = TOOL_SCOPE_REGENERATE_NOTE;
              continue;
            }
            return this.handOff(
              scope,
              job,
              failVerdict('tool_scope', 'INSUFFICIENT_GROUNDING'),
              decision,
              produced,
              images,
              null,
              { toolAction },
            );
          }
        }
      }
      // 6b. Cross-cutting item 3 — the output validator; Roadmap A3 — advice the customer already
      // received in this epoch is not sent again. Either is asked for once more, then hands off.
      // Phase 4 PR-3: a subscription link is validated WITH the reply, against an allowance that
      // holds that one link only because this reply sends it.
      const policy = checkOutputPolicy(
        tool?.validated === true && tool.extra !== null
          ? `${decision.replyText}\n\n${tool.extra}`
          : decision.replyText,
        allowanceWith(tool?.allowLinks ?? []),
        this.deps.clock.now(),
      );
      const repeated = autoRepeatedAdviceGuard(decision, transcript, since);
      const refused = !policy.ok ? failVerdict('output_policy', 'OUTPUT_POLICY') : repeated;
      if (!refused.pass) {
        if (attempt === 0) {
          regenerateNote = policy.ok
            ? REPEATED_ADVICE_REGENERATE_NOTE
            : OUTPUT_POLICY_REGENERATE_NOTE;
          continue;
        }
        return this.handOff(scope, job, refused, decision, produced, images);
      }
      // A8 review N2: the titles it cited, so the next request's knowledge query can read them.
      const knowledgeLabels = resolveKnowledgeLabels(
        decision.knowledgeRefs,
        context.knowledgeAliases,
      );
      // Phase 4 PR-3: the label, the tool's text and buttons, «مشکل حل شد؟», «👤 پشتیبان انسانی».
      const message = await this.composeMessage(scope, tools, {
        reply: decision.replyText,
        extra: tool?.extra ?? null,
        actionButton: tool?.button ?? null,
        feedback: tools.actions && tools.feedback && decision.decision === 'REPLY',
      });
      if (message === 'TOO_LONG') {
        return this.handOff(
          scope,
          job,
          failVerdict('reply_bounds', 'REPLY_OUT_OF_BOUNDS'),
          decision,
          produced,
          images,
        );
      }
      return this.enqueue(
        scope,
        job,
        decision,
        produced,
        grounding,
        since,
        images,
        knowledgeLabels,
        {
          link: null,
          citedLabels,
          ...(message === null ? {} : { message }),
          ...(tool === null ? {} : { tool }),
        },
      );
    }
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
    config: {
      readonly sessionReplyBudget: number;
      readonly maxAutoRepliesPerHour: number;
      /** Phase 4 PR-3: a voice / sticker / file is answered (tools on), not handed off. */
      readonly otherIsAnswerable?: boolean;
    },
    customerBlocked: boolean,
    now: Date,
    tx?: unknown,
  ): Promise<{ readonly verdict: AutoVerdict; readonly trigger: BusinessMessageRecord | null }> {
    const epoch = job.controlEpoch ?? -1;
    const [trigger, counts, sessionReplies] = await Promise.all([
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
      this.deps.jobs.sessionReplyCount(scope, { conversationId, epoch, now }, tx),
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
      sessionReplies,
      autoInWindow: counts.inWindow,
      sessionReplyBudget: config.sessionReplyBudget,
      maxPerWindow: config.maxAutoRepliesPerHour,
      otherIsAnswerable: config.otherIsAnswerable === true,
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
   * Phase 4 PR-1 item 8 — a job whose `produce` THREW (a context builder, a reader, a bug). The
   * first time, its lease is moved to `SUPPORT_AI_JOB_RETRY_DELAY_MS` from now so it is claimed
   * once more, and the operations log is told (the job and conversation ids only). A job that
   * throws again hands off (`giveUp`), so the customer is never left with neither a reply nor a
   * person — the loop meanwhile goes on to the next job instead of holding the lease for minutes.
   */
  async recoverFromException(
    scope: ScopeContext,
    job: SupportAiJobRecord,
  ): Promise<AutoJobResult | 'RETRY'> {
    if (job.attempts >= 2) return this.giveUp(scope, job);
    return this.deps.uow.run(scope, async (tx) => {
      if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) return 'INACTIVE' as const;
      const now = this.deps.clock.now();
      await this.deps.jobs.releaseLease(
        scope,
        job.id,
        new Date(now.getTime() + SUPPORT_AI_JOB_RETRY_DELAY_MS),
        now,
        tx,
      );
      await this.deps.opsLog?.record(
        scope,
        {
          code: SUPPORT_AI_JOB_EXCEPTION_CODE,
          severity: 'ERROR',
          message:
            'An automatic support-AI job failed with an error; it is retried once, then handed to a person.',
          dedupeKey: `${SUPPORT_AI_JOB_EXCEPTION_CODE}:${job.id}`,
          context: { operationId: job.id, conversationId: job.conversationId },
        },
        tx,
      );
      return 'RETRY' as const;
    });
  }

  /**
   * The reply onto the lane, in ONE transaction that decides again on what is true NOW
   * (substitute review of PR #202, finding 1). Under the conversation's lock: the epoch and the
   * state; then the configuration (the mode, and every guard that reads it — the allowlist, the
   * confidence, the bounds, the loop limit, the clarifying limit), the trigger (still the
   * customer's, not deleted), the loop counts, the clarifying streak, and the customer's account
   * facts, each read in this transaction. The deterministic guards run again on them; one that now fails HANDS OFF, in this transaction,
   * instead of enqueueing — the provider call can take minutes, and a guard that passed on the
   * facts of before it is not a guard.
   */
  private async enqueue(
    scope: ScopeContext,
    job: SupportAiJobRecord,
    decision: SupportAiDecision,
    produced: { readonly provider: SupportAiProvider; readonly model: string },
    grounding: {
      readonly knownAliases: ReadonlySet<string>;
      readonly knownKnowledgeAliases: ReadonlySet<string>;
    },
    /** Where this epoch's AI part began (`epochStartedAt`): the repeated-advice window. */
    since: Date | null,
    images?: ImageWrite,
    knowledgeLabels: readonly string[] = [],
    /**
     * Phase 4 PR-1: `link` set — the decision guards sent an unlinked customer's account question
     * to the bot's start link, and this enqueues the templated message instead of the model's
     * words. `citedLabels`: the panel usernames of the services the decision cites.
     */
    extra: {
      readonly link: string | null;
      readonly citedLabels: readonly string[];
      /** Phase 4 PR-3: the composed message (label, tool text, buttons) in place of the reply. */
      readonly message?: ComposedMessage;
      readonly tool?: PreparedTool;
    } = {
      link: null,
      citedLabels: [],
    },
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
        {
          since: new Date(now.getTime() - SUPPORT_AI_UNDER_REVIEW_WINDOW_DAYS * 86_400_000),
          serviceLabels: extra.citedLabels,
        },
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
        : autoDecisionGuards({
            decision,
            config,
            flags,
            // Phase 4 PR-3: the switch as it is NOW, read in this transaction.
            actionsEnabled: (await this.toolSettings(scope, tx)).actions,
            ...grounding,
            clarifyingStreak: await this.deps.jobs.clarifyingStreak(
              scope,
              { conversationId: job.conversationId, epoch: job.controlEpoch ?? -1 },
              tx,
            ),
            otherStreak: await this.deps.jobs.otherStreak(
              scope,
              { conversationId: job.conversationId, epoch: job.controlEpoch ?? -1 },
              tx,
            ),
          });
      // The link path is decided again too. Chosen before the call, it stays the link (a
      // template, never the model's words — the model answered an unlinked context) unless a
      // guard other than identity now fails.
      const linkStill =
        extra.link !== null && (recheck.pass || (!recheck.pass && recheck.sendLink === true));
      if (!recheck.pass && !linkStill) {
        const failed =
          recheck.sendLink === true ? failVerdict('identity', 'IDENTITY_UNVERIFIED') : recheck;
        return this.handOffChecked(scope, job, failed, decision, produced, now, tx);
      }
      if (linkStill && extra.link !== null) {
        return this.enqueueLink(scope, job, decision, produced, extra.link, now, tx);
      }
      /*
       * Review of PR #248, CX5 — repeated advice, decided again on what is DELIVERED now. The
       * check before the provider call read the transcript as it was then; an earlier automatic
       * reply can reach DELIVERED while the provider is thinking, and this reply would repeat
       * it. Read again here, under the conversation's lock taken above, with the same predicate;
       * a repeat hands off exactly as the earlier check does (or drops, if the conversation
       * moved on).
       */
      const deliveredNow = await readSupportTranscript(
        this.deps,
        scope,
        job.conversationId,
        SUPPORT_TRANSCRIPT_READ_LINES,
        tx,
      );
      /*
       * The CX5 follow-up: an earlier automatic reply of this epoch still PENDING (or
       * UNCONFIRMED — it may have reached the customer) is advice given too. Delivered or not,
       * it is on its way; this reply would repeat it beside it.
       */
      const onItsWay = (
        await this.deps.outbound.undeliveredAuto(
          scope,
          { conversationId: job.conversationId, epoch: job.controlEpoch ?? -1 },
          tx,
        )
      ).map((row) => ({
        origin: 'OWN_ECHO' as const,
        author: 'AI_AUTO' as const,
        text: row.body,
        sentAt: row.createdAt,
      }));
      const repeated = autoRepeatedAdviceGuard(decision, [...deliveredNow, ...onItsWay], since);
      if (!repeated.pass)
        return this.handOffChecked(scope, job, repeated, decision, produced, now, tx);
      // Phase 4 PR-3: the service a link is sent for is read again in THIS transaction — still
      // this customer's, still the same link (a transfer or a rotation during the provider call
      // must not send the old owner, or the old link).
      const linkSent = extra.tool?.linkSent ?? null;
      if (linkSent !== null && !(await this.linkStillTrue(scope, conversation, linkSent, tx))) {
        return this.handOffChecked(
          scope,
          job,
          failVerdict('tool_scope', 'INSUFFICIENT_GROUNDING'),
          decision,
          produced,
          now,
          tx,
          null,
          extra.tool === undefined ? {} : { toolAction: extra.tool.toolAction },
        );
      }
      const queued = await this.deps.control.enqueueAutoSend(
        scope,
        {
          conversationId: job.conversationId,
          controlEpoch: job.controlEpoch ?? -1,
          text: extra.message?.text ?? decision.replyText.trim(),
          idempotencyKey: `support-ai:auto:${job.id}`,
          now,
          ...(extra.message === undefined
            ? {}
            : { id: extra.message.rowId, buttons: extra.message.buttons }),
        },
        tx,
      );
      if ('refused' in queued) {
        return this.finish(scope, job, `dropped_${queued.refused}`, now, tx, {
          decision,
          produced,
        });
      }
      const outcome = decision.decision === 'ASK_CLARIFYING_QUESTION' ? 'sent_clarifying' : 'sent';
      const ok = await this.deps.jobs.finishAuto(
        scope,
        job.id,
        {
          state: 'SENT',
          outcome,
          decision,
          provider: produced.provider,
          model: produced.model,
          sentOutboundId: queued.row.id,
          knowledgeLabels,
          toolAction: extra.tool?.toolAction ?? null,
          now,
        },
        tx,
      );
      if (!ok) throw new JobGone();
      if (linkSent !== null && conversation !== null) {
        await this.recordLinkSent(scope, job, conversation, linkSent.username, tx);
      }
      return outcome;
    });
  }

  /**
   * Phase 4 PR-1 item 5 — the bot's start link to an unlinked customer, in the enqueue's
   * transaction: the template rendered now (never the model's words), enqueued under the
   * captured epoch like any automatic reply. A template that cannot render hands off instead.
   */
  private async enqueueLink(
    scope: ScopeContext,
    job: SupportAiJobRecord,
    decision: SupportAiDecision,
    produced: { readonly provider: SupportAiProvider; readonly model: string },
    link: string,
    now: Date,
    tx: TransactionScope,
  ): Promise<AutoJobResult> {
    let text: string;
    try {
      text =
        (await this.deps.templates?.render(
          scope,
          SUPPORT_AI_LINK_ACCOUNT_TEMPLATE_KEY as Parameters<TemplateResolver['render']>[1],
          { botLink: link },
          undefined,
          tx,
        )) ?? '';
    } catch {
      text = '';
    }
    if (text.trim() === '') {
      return this.handOffChecked(
        scope,
        job,
        failVerdict('identity', 'IDENTITY_UNVERIFIED'),
        decision,
        produced,
        now,
        tx,
      );
    }
    // Review of PR #369: composed like every other automatic reply — the AI label when it is on,
    // and «👤 پشتیبان انسانی» (plus the bot's open button) when the tools are on.
    const tools = await this.toolSettings(scope, tx);
    const open =
      tools.actions && botUsernameOf(link) !== null
        ? await this.button(scope, SUPPORT_AI_TEMPLATE_KEYS.buttonOpenBot, { url: link })
        : null;
    const message = await this.composeMessage(scope, tools, {
      reply: text,
      extra: null,
      actionButton: open,
      feedback: false,
    });
    if (message === 'TOO_LONG') {
      return this.handOffChecked(
        scope,
        job,
        failVerdict('identity', 'IDENTITY_UNVERIFIED'),
        decision,
        produced,
        now,
        tx,
      );
    }
    const queued = await this.deps.control.enqueueAutoSend(
      scope,
      {
        conversationId: job.conversationId,
        controlEpoch: job.controlEpoch ?? -1,
        text: message?.text ?? text.trim(),
        idempotencyKey: `support-ai:auto:${job.id}`,
        now,
        ...(message === null ? {} : { id: message.rowId, buttons: message.buttons }),
      },
      tx,
    );
    if ('refused' in queued) {
      return this.finish(scope, job, `dropped_${queued.refused}`, now, tx, { decision, produced });
    }
    const ok = await this.deps.jobs.finishAuto(
      scope,
      job.id,
      {
        state: 'SENT',
        outcome: 'sent_link',
        decision,
        provider: produced.provider,
        model: produced.model,
        sentOutboundId: queued.row.id,
        knowledgeLabels: [],
        now,
      },
      tx,
    );
    if (!ok) throw new JobGone();
    return 'sent_link';
  }

  // -------------------------------------------------------------------------------------------
  // Phase 4 PR-3 — tools, deep links, check-before-handoff, the unsupported-content reply.
  // -------------------------------------------------------------------------------------------

  /** The owner's three switches; everything off without the PR-3 wiring. */
  private async toolSettings(
    scope: ScopeContext,
    tx?: unknown,
  ): Promise<{ readonly actions: boolean; readonly label: boolean; readonly feedback: boolean }> {
    if (this.deps.tools === undefined) {
      // The label is the one switch that does not need the tools; without the wiring, none.
      return SUPPORT_AI_TOOLS_OFF;
    }
    return this.deps.tools.settings.read(scope, tx);
  }

  /** A template rendered for the customer, or null when it cannot render (or is empty). */
  private async render(
    scope: ScopeContext,
    key: string,
    values: Readonly<Record<string, string>> = {},
    tx?: TransactionScope,
  ): Promise<string | null> {
    try {
      const text = await this.deps.templates?.render(
        scope,
        key as Parameters<TemplateResolver['render']>[1],
        values,
        undefined,
        tx,
      );
      if (text === undefined) return null;
      // A Business message is plain text: every Appearance marker ({icon:…}) as its emoji.
      const plain = appearanceFallbackText(text).trim();
      return plain === '' ? null : plain;
    } catch {
      return null;
    }
  }

  /** A button whose label is a template; null when the label cannot render. */
  private async button(
    scope: ScopeContext,
    labelKey: string,
    target: { readonly url: string } | { readonly callbackData: string },
  ): Promise<BusinessOutboundButton | null> {
    const label = await this.render(scope, labelKey);
    if (label === null) return null;
    return {
      label: label.slice(0, 64),
      url: 'url' in target ? target.url : null,
      callbackData: 'callbackData' in target ? target.callbackData : null,
    };
  }

  /**
   * What one planned tool adds to the reply, read now — or null when it cannot be given (the
   * service has no link, the customer is not eligible for a trial, a label cannot render): the
   * caller treats that as a refused target (`tool_scope`).
   */
  private async prepareTool(
    scope: ScopeContext,
    customerId: string | null,
    plan: Exclude<ActionPlan, { kind: 'none' } | { kind: 'refused' }>,
    botUsername: string | null,
  ): Promise<PreparedTool | null> {
    const reader = this.deps.tools?.reader;
    if (reader === undefined) return null;
    const keys = SUPPORT_AI_TEMPLATE_KEYS;
    switch (plan.kind) {
      case 'subscription_link': {
        if (customerId === null) return null;
        const subscription = await reader.subscriptionOf(scope, customerId, plan.serviceId);
        if (subscription === null) return null;
        if (subscription.link !== null) {
          const extra = await this.render(scope, keys.subscriptionLink, {
            service: subscription.username,
            link: subscription.link,
          });
          if (extra === null) return null;
          return {
            toolAction: 'SEND_SUBSCRIPTION_LINK',
            extra,
            validated: true,
            allowLinks: [subscription.link],
            button: null,
            linkSent: {
              serviceId: plan.serviceId,
              username: subscription.username,
              link: subscription.link,
            },
          };
        }
        // R11 A4 «فقط فایل»: never the link — the bot's service card, where «فایل‌ها» sends them.
        if (!subscription.filesOnly || botUsername === null) return null;
        const extra = await this.render(scope, keys.filesInBot, { service: subscription.username });
        const button = await this.button(scope, keys.buttonServiceInBot, {
          url: deepLinkUrl(botUsername, 'service', plan.serviceId),
        });
        if (extra === null || button === null) return null;
        return {
          toolAction: 'SEND_SUBSCRIPTION_LINK',
          extra,
          validated: false,
          allowLinks: [],
          button,
          linkSent: { serviceId: plan.serviceId, username: subscription.username, link: null },
        };
      }
      case 'payment_status': {
        if (customerId === null) return null;
        const payments = await reader.paymentsForCheck(scope, customerId, this.checkSince());
        const extra =
          payments.length === 0
            ? await this.render(scope, keys.paymentStatusNone)
            : await this.paymentLines(scope, payments);
        if (extra === null) return null;
        // Server facts (codes, amounts): never the model's words, so not the validator's.
        return {
          toolAction: 'PAYMENT_STATUS',
          extra,
          validated: false,
          allowLinks: [],
          button: null,
          linkSent: null,
        };
      }
      case 'deep_link': {
        if (botUsername === null) return null;
        let flow = plan.flow;
        let id = plan.id;
        if (plan.trialCheck === true) {
          if (customerId === null || !(await reader.trialEligible(scope, customerId))) return null;
        }
        if (plan.productId !== undefined) {
          const category = await reader.categoryOfProduct(scope, plan.productId);
          if (category !== null) {
            flow = 'category';
            id = category;
          }
        }
        const button = await this.button(scope, DEEP_LINK_LABELS[plan.action], {
          url: deepLinkUrl(botUsername, flow, id),
        });
        if (button === null) return null;
        return {
          toolAction: plan.action as Exclude<SupportAiActionKind, 'NONE'>,
          extra: null,
          validated: false,
          allowLinks: [],
          button,
          linkSent: null,
        };
      }
      case 'open_bot': {
        if (botUsername === null) return null;
        const button = await this.button(scope, SUPPORT_AI_TEMPLATE_KEYS.buttonOpenBot, {
          url: deepLinkUrl(botUsername, null, null),
        });
        if (button === null) return null;
        return {
          toolAction: plan.action as Exclude<SupportAiActionKind, 'NONE'>,
          extra: null,
          validated: false,
          allowLinks: [],
          button,
          linkSent: null,
        };
      }
    }
  }

  /** The customer's payments as status lines (`bot.support.ai_payment_status_line`). */
  private async paymentLines(
    scope: ScopeContext,
    payments: readonly PaymentCheckFact[],
  ): Promise<string | null> {
    const lines: string[] = [];
    for (const payment of payments) {
      const line = await this.render(scope, SUPPORT_AI_TEMPLATE_KEYS.paymentStatusLine, {
        code: payment.code ?? PAYMENT_CHECK_SUMMARY_WORDS.noCode,
        amount: payment.amount,
        state: payment.stateLabel,
        route: payment.route,
      });
      if (line === null) return null;
      lines.push(line);
    }
    return lines.join('\n');
  }

  /** Where the payments a check reads begin: `SUPPORT_AI_PAYMENT_CHECK_WINDOW_DAYS` back. */
  private checkSince(): Date {
    return new Date(
      this.deps.clock.now().getTime() - SUPPORT_AI_PAYMENT_CHECK_WINDOW_DAYS * 86_400_000,
    );
  }

  /**
   * The message an automatic reply becomes, with the tools or the label on: the label line, the
   * reply, the tool's text, «مشکل حل شد؟» and the keyboard — the tool's button, 👍 / 👎 and
   * «👤 پشتیبان انسانی», each callback bound to this message's own row id. Null when neither the
   * tools nor the label are on (the reply goes as it is); `TOO_LONG` when it would not fit.
   */
  private async composeMessage(
    scope: ScopeContext,
    tools: { readonly actions: boolean; readonly label: boolean; readonly feedback: boolean },
    parts: {
      readonly reply: string;
      readonly extra: string | null;
      readonly actionButton: BusinessOutboundButton | null;
      readonly feedback: boolean;
    },
  ): Promise<ComposedMessage | 'TOO_LONG' | null> {
    if (!tools.actions && !tools.label) return null;
    const keys = SUPPORT_AI_TEMPLATE_KEYS;
    const rowId = this.deps.ids.uuid();
    const label = tools.label ? await this.render(scope, keys.label) : null;
    const question = parts.feedback ? await this.render(scope, keys.feedbackQuestion) : null;
    const yes =
      question === null
        ? null
        : await this.button(scope, keys.buttonYes, {
            callbackData: supportAiCallbackData('yes', rowId),
          });
    const no =
      question === null
        ? null
        : await this.button(scope, keys.buttonNo, {
            callbackData: supportAiCallbackData('no', rowId),
          });
    const human = tools.actions
      ? await this.button(scope, keys.buttonHuman, {
          callbackData: supportAiCallbackData('human', rowId),
        })
      : null;
    const feedback = question !== null && yes !== null && no !== null;
    const text = composeAiMessage({
      label,
      reply: parts.reply,
      extra: parts.extra,
      feedbackQuestion: feedback ? question : null,
    });
    if (text === null) return 'TOO_LONG';
    return {
      rowId,
      text,
      buttons: composeButtons({
        action: parts.actionButton,
        feedback: feedback ? [yes, no] : null,
        human,
      }),
    };
  }

  /** The link about to be sent is still this customer's, unchanged (read in the enqueue's tx). */
  private async linkStillTrue(
    scope: ScopeContext,
    conversation: BusinessConversationRecord | null,
    sent: NonNullable<PreparedTool['linkSent']>,
    tx: TransactionScope,
  ): Promise<boolean> {
    if (conversation === null || conversation.customerId === null) return false;
    const now = await this.deps.tools?.reader.subscriptionOf(
      scope,
      conversation.customerId,
      sent.serviceId,
      tx,
    );
    if (now === undefined || now === null) return false;
    return sent.link === null ? now.filesOnly && now.link === null : now.link === sent.link;
  }

  /** The ops-log rule: every link (or files button) the AI sends, by the service's username. */
  private async recordLinkSent(
    scope: ScopeContext,
    job: SupportAiJobRecord,
    conversation: BusinessConversationRecord,
    username: string,
    tx: TransactionScope,
  ): Promise<void> {
    await this.deps.opsLog?.record(
      scope,
      {
        code: SUPPORT_AI_LINK_SENT_CODE,
        severity: 'INFO',
        message:
          'The support AI sent a customer the subscription link (or files button) of their own service in a Telegram Business chat.',
        dedupeKey: `${SUPPORT_AI_LINK_SENT_CODE}:${job.id}`,
        context: {
          customerId: conversation.customerId,
          conversationId: conversation.id,
          serviceUsername: username,
        },
      },
      tx,
    );
  }

  /**
   * A voice message, a sticker or a non-image file (tools on): ONE templated message asking the
   * customer to type the question, under the captured epoch like any automatic reply. The
   * blocked-customer and loop checks run again in this transaction; the conversation stays
   * with the AI. Voice is never transcribed.
   */
  private async answerUnsupported(
    scope: ScopeContext,
    job: SupportAiJobRecord,
    tools: { readonly actions: boolean; readonly label: boolean; readonly feedback: boolean },
  ): Promise<AutoJobResult> {
    const body = await this.render(scope, SUPPORT_AI_TEMPLATE_KEYS.unsupportedContent);
    const message =
      body === null
        ? null
        : await this.composeMessage(scope, tools, {
            reply: body,
            extra: null,
            actionButton: null,
            feedback: false,
          });
    return this.inJobTransaction(scope, job, undefined, async (tx, now) => {
      if (message === null || message === 'TOO_LONG') {
        return this.handOffChecked(
          scope,
          job,
          fail('content', 'UNSUPPORTED_CONTENT'),
          null,
          null,
          now,
          tx,
        );
      }
      const { config } = await this.deps.configs.get(scope, tx);
      if (config.mode !== 'AUTO_REPLY_SAFE')
        return this.finish(scope, job, 'dropped_mode', now, tx);
      const conversation = await this.deps.conversations.lockById(scope, job.conversationId, tx);
      const flags = await this.deps.facts.autoGuardFlags(
        scope,
        conversation?.customerId ?? null,
        tx,
      );
      const { verdict } = await this.preflight(
        scope,
        job,
        job.conversationId,
        { ...config, otherIsAnswerable: true },
        flags.customerBlocked,
        now,
        tx,
      );
      if (!verdict.pass) return this.handOffChecked(scope, job, verdict, null, null, now, tx);
      return this.enqueueComposed(scope, job, message, 'sent_unsupported_content', null, now, tx);
    });
  }

  /**
   * A composed message onto the lane under the captured epoch, and the job SENT with `outcome`.
   * Refused (the epoch or state moved, the connection cannot send) drops the job.
   */
  private async enqueueComposed(
    scope: ScopeContext,
    job: SupportAiJobRecord,
    message: ComposedMessage,
    outcome: Extract<
      SupportAiAutoOutcome,
      'sent_unsupported_content' | 'sent_payment_ask' | 'sent_payment_delivered'
    >,
    toolAction: Exclude<SupportAiActionKind, 'NONE'> | null,
    now: Date,
    tx: TransactionScope,
  ): Promise<AutoJobResult> {
    const queued = await this.deps.control.enqueueAutoSend(
      scope,
      {
        conversationId: job.conversationId,
        controlEpoch: job.controlEpoch ?? -1,
        text: message.text,
        idempotencyKey: `support-ai:auto:${job.id}`,
        now,
        id: message.rowId,
        buttons: message.buttons,
      },
      tx,
    );
    if ('refused' in queued) return this.finish(scope, job, `dropped_${queued.refused}`, now, tx);
    const ok = await this.deps.jobs.finishAuto(
      scope,
      job.id,
      {
        state: 'SENT',
        outcome,
        sentOutboundId: queued.row.id,
        toolAction,
        // A sent job carries the decision behind it (`support_ai_jobs_result_shape_check`):
        // here NEXA's own, deterministic one — the text it sent, never a model's.
        decision: serverDecision(outcome, message.text),
        now,
      },
      tx,
    );
    if (!ok) throw new JobGone();
    return outcome;
  }

  /**
   * Check-before-handoff — a pending link was answered with a thanks («مرسی درست شد»): the matter
   * is closed silently (A6's `no_action`), in a transaction that decides again on the epoch and
   * the state.
   */
  private async closeAcknowledged(
    scope: ScopeContext,
    job: SupportAiJobRecord,
  ): Promise<AutoJobResult> {
    return this.inJobTransaction(scope, job, undefined, async (tx, now) => {
      const conversation = await this.deps.conversations.lockById(scope, job.conversationId, tx);
      if (conversation === null || conversation.controlEpoch !== job.controlEpoch) {
        return this.finish(scope, job, 'dropped_epoch', now, tx);
      }
      if (conversation.state !== 'AI_ACTIVE')
        return this.finish(scope, job, 'dropped_state', now, tx);
      await this.deps.conversations.touch(scope, conversation.id, { lastAiAt: now, now }, tx);
      return this.finish(scope, job, 'no_action', now, tx);
    });
  }

  /**
   * Check-before-handoff — the customer answered the ONE question, or did not confirm the sent
   * link solved it: a HARD handoff with the Persian summary (the payments found, and what the AI
   * already told the customer). The customer's own words stay in the transcript, never the note.
   */
  private async paymentCheckFollowUp(
    scope: ScopeContext,
    job: SupportAiJobRecord,
    conversation: BusinessConversationRecord,
    pending: 'sent_payment_delivered' | 'sent_payment_ask',
  ): Promise<AutoJobResult> {
    const payments =
      conversation.customerId === null || this.deps.tools === undefined
        ? []
        : await this.deps.tools.reader.paymentsForCheck(
            scope,
            conversation.customerId,
            this.checkSince(),
          );
    const summary = paymentCheckSummary({
      customerId: conversation.customerId,
      payments,
      told:
        pending === 'sent_payment_ask'
          ? PAYMENT_CHECK_SUMMARY_WORDS.afterAsk
          : PAYMENT_CHECK_SUMMARY_WORDS.afterLink,
      max: BUSINESS_ESCALATION_SUMMARY_MAX,
    });
    return this.handOff(scope, job, PAYMENT_CHECKED, null, null, undefined, null, {
      summary,
      kind: 'HARD',
      toolAction: 'PAYMENT_STATUS',
    });
  }

  /**
   * Check-before-handoff («paid but not received», the owner's decision): before the HARD
   * handoff, the AI reads this customer's payments (and the service a confirmed one delivered)
   * and answers from facts in ONE message —
   *
   *  - not linked: the bot link, and a hard handoff;
   *  - a payment under review or waiting for the gateway: «ثبت شده و در حال بررسی است» with its
   *    tracking code, no outcome promised, and a hard handoff;
   *  - confirmed, but no delivered service to give: said so, and a hard handoff;
   *  - confirmed and delivered: that service's link (or files button) with «مشکل حل شد؟» — no
   *    handoff yet; a thanks or 👍 closes it, anything else hands off, hard;
   *  - nothing matching: ONE question for the receipt, the code or the amount and time; the next
   *    message hands off, hard, with it.
   *
   * The handoff note always carries the Persian summary. Never a promise that money comes back,
   * never a credit, a re-provisioning or a cancellation: the AI only reads.
   */
  private async paymentCheck(
    scope: ScopeContext,
    job: SupportAiJobRecord,
    conversation: BusinessConversationRecord,
    linked: boolean,
    botLink: string | null,
    tools: { readonly actions: boolean; readonly label: boolean; readonly feedback: boolean },
  ): Promise<AutoJobResult> {
    const keys = SUPPORT_AI_TEMPLATE_KEYS;
    const used = await this.deps.tools?.jobs.toolCallCount(scope, {
      conversationId: conversation.id,
      epoch: job.controlEpoch ?? -1,
    });
    if (used !== undefined && toolCallLimitReached(used)) {
      return this.handOff(
        scope,
        job,
        failVerdict('tool_rate_limit', 'SUSPICIOUS_PROBING'),
        null,
        null,
        this.withProbingSignal(scope, conversation, job.controlEpoch ?? -1, undefined),
        null,
        { toolAction: 'PAYMENT_STATUS' },
      );
    }
    const handOffTold = async (
      body: string | null,
      buttons: BusinessOutboundButtons | null,
      payments: readonly PaymentCheckFact[],
    ): Promise<AutoJobResult> =>
      this.handOff(scope, job, PAYMENT_CHECKED, null, null, undefined, null, {
        summary: paymentCheckSummary({
          customerId: linked ? conversation.customerId : null,
          payments,
          told: body ?? '',
          max: BUSINESS_ESCALATION_SUMMARY_MAX,
        }),
        kind: 'HARD',
        toolAction: 'PAYMENT_STATUS',
        ...(body === null ? {} : { notice: { body, buttons } }),
      });

    if (!linked || conversation.customerId === null || this.deps.tools === undefined) {
      const body =
        botLink === null ? null : await this.render(scope, keys.paymentUnlinked, { botLink });
      const open =
        botLink === null ? null : await this.button(scope, keys.buttonOpenBot, { url: botLink });
      return handOffTold(body, open === null ? null : [[open]], []);
    }
    const payments = await this.deps.tools.reader.paymentsForCheck(
      scope,
      conversation.customerId,
      this.checkSince(),
    );
    const branch = paymentCheckBranch(payments);
    switch (branch.kind) {
      case 'UNDER_REVIEW': {
        const body = await this.render(scope, keys.paymentUnderReview, {
          code: branch.payment.code ?? PAYMENT_CHECK_SUMMARY_WORDS.noCode,
          amount: branch.payment.amount,
        });
        return handOffTold(body, null, payments);
      }
      case 'SETTLED_PENDING': {
        const body = await this.render(scope, keys.paymentSettledPending, {
          code: branch.payment.code ?? PAYMENT_CHECK_SUMMARY_WORDS.noCode,
          amount: branch.payment.amount,
        });
        return handOffTold(body, null, payments);
      }
      case 'NOT_FOUND': {
        const body = await this.render(scope, keys.paymentNotFound);
        const message =
          body === null
            ? null
            : await this.composeMessage(
                scope,
                { ...tools, feedback: false },
                {
                  reply: body,
                  extra: null,
                  actionButton: null,
                  feedback: false,
                },
              );
        if (message === null || message === 'TOO_LONG') return handOffTold(null, null, payments);
        return this.inJobTransaction(scope, job, undefined, (tx, now) =>
          this.enqueuePaymentMessage(scope, job, message, 'sent_payment_ask', null, now, tx),
        );
      }
      case 'SETTLED_DELIVERED': {
        const botUsername = botUsernameOf(botLink);
        const tool = await this.prepareTool(
          scope,
          conversation.customerId,
          { kind: 'subscription_link', serviceId: branch.service.serviceId },
          botUsername,
        );
        const intro = await this.render(scope, keys.paymentDelivered, {
          code: branch.payment.code ?? PAYMENT_CHECK_SUMMARY_WORDS.noCode,
          service: branch.service.username,
        });
        if (tool === null || intro === null) {
          // The link could not be given after all: the confirmed payment is told, then a person.
          const body = await this.render(scope, keys.paymentSettledPending, {
            code: branch.payment.code ?? PAYMENT_CHECK_SUMMARY_WORDS.noCode,
            amount: branch.payment.amount,
          });
          return handOffTold(body, null, payments);
        }
        // The owner's rule: «مشکل حل شد؟» always follows the delivered link here.
        const message = await this.composeMessage(
          scope,
          { ...tools, feedback: true },
          {
            reply: intro,
            extra: tool.extra,
            actionButton: tool.button,
            feedback: true,
          },
        );
        if (message === null || message === 'TOO_LONG') {
          return handOffTold(null, null, payments);
        }
        // Every word of this message is NEXA's (templates and this customer's own facts): no
        // model text, so nothing for the output validator to judge. The link is re-read in the
        // enqueue's transaction.
        return this.inJobTransaction(scope, job, undefined, (tx, now) =>
          this.enqueuePaymentMessage(scope, job, message, 'sent_payment_delivered', tool, now, tx),
        );
      }
    }
  }

  /**
   * Check-before-handoff's message that keeps the conversation with the AI (the question, or the
   * delivered link), decided again in this transaction: the mode, the epoch and state, the link
   * still this customer's; then onto the lane and logged.
   */
  private async enqueuePaymentMessage(
    scope: ScopeContext,
    job: SupportAiJobRecord,
    message: ComposedMessage,
    outcome: 'sent_payment_ask' | 'sent_payment_delivered',
    tool: PreparedTool | null,
    now: Date,
    tx: TransactionScope,
  ): Promise<AutoJobResult> {
    const { config } = await this.deps.configs.get(scope, tx);
    if (config.mode !== 'AUTO_REPLY_SAFE') return this.finish(scope, job, 'dropped_mode', now, tx);
    const conversation = await this.deps.conversations.lockById(scope, job.conversationId, tx);
    if (conversation === null || conversation.controlEpoch !== job.controlEpoch) {
      return this.finish(scope, job, 'dropped_epoch', now, tx);
    }
    if (conversation.state !== 'AI_ACTIVE')
      return this.finish(scope, job, 'dropped_state', now, tx);
    if (
      tool?.linkSent != null &&
      !(await this.linkStillTrue(scope, conversation, tool.linkSent, tx))
    ) {
      return this.handOffChecked(scope, job, PAYMENT_CHECKED, null, null, now, tx, null, {
        kind: 'HARD',
        toolAction: 'PAYMENT_STATUS',
      });
    }
    const result = await this.enqueueComposed(
      scope,
      job,
      message,
      outcome,
      'PAYMENT_STATUS',
      now,
      tx,
    );
    if (result === outcome && tool?.linkSent != null) {
      await this.recordLinkSent(scope, job, conversation, tool.linkSent.username, tx);
    }
    return result;
  }

  /** The bot's start link for this conversation's bot; null when its username is unknown. */
  private async botLinkOf(scope: ScopeContext, botInstanceId: string): Promise<string | null> {
    const username = (await this.deps.bots?.usernameOf(scope, botInstanceId)) ?? null;
    if (username === null || !/^[A-Za-z][A-Za-z0-9_]{3,31}$/u.test(username)) return null;
    return `https://t.me/${username}?start=support`;
  }

  /**
   * Cross-cutting item 7 — the operations-log signal of repeated refusals, written with the
   * handoff in its transaction: the customer's id and the conversation only, never a word of
   * what was asked. One row per conversation and epoch.
   */
  private withProbingSignal(
    scope: ScopeContext,
    conversation: BusinessConversationRecord,
    epoch: number,
    images: ImageWrite | undefined,
  ): ImageWrite {
    return async (now, tx) => {
      if (images !== undefined) await images(now, tx);
      await this.deps.opsLog?.record(
        scope,
        {
          code: SUPPORT_AI_SUSPICIOUS_PROBING_CODE,
          severity: 'WARN',
          message:
            'A Telegram Business customer asked repeatedly for what the support AI must not give; the conversation was handed to a person.',
          dedupeKey: `${SUPPORT_AI_SUSPICIOUS_PROBING_CODE}:${conversation.id}:${String(epoch)}`,
          context: { customerId: conversation.customerId, conversationId: conversation.id },
        },
        tx,
      );
    };
  }

  /**
   * Roadmap A6 — the silent close, in ONE transaction that decides again on what is true now
   * (review of PR #246, CX2), exactly as the reply path's enqueue does: the mode, then the
   * conversation under its lock (epoch and state), then the configuration and the customer's
   * account facts read in this transaction. If silence is no longer allowed — a customer blocked
   * or put under payment review during the provider call, a topic removed from the allowlist —
   * the conversation is handed off instead, with the specific reason.
   *
   * A closed matter is an ANSWERED one (CX1): `last_ai_at` is stamped, so the inbox does not show
   * the customer's «مرسی» as a wait that keeps growing. (The next automatic reply's cooldown runs
   * from it, as from any automatic answer.)
   */
  private async closeSilently(
    scope: ScopeContext,
    job: SupportAiJobRecord,
    decision: SupportAiDecision,
    produced: { readonly provider: SupportAiProvider; readonly model: string },
    customerTexts: readonly (string | null)[],
    /** The panel usernames of the services the decision cites (the in-transaction recheck). */
    citedLabels: readonly string[],
    images?: ImageWrite,
  ): Promise<AutoJobResult> {
    return this.inJobTransaction(scope, job, images, async (tx, now) => {
      const { config } = await this.deps.configs.get(scope, tx);
      if (config.mode !== 'AUTO_REPLY_SAFE') {
        return this.finish(scope, job, 'dropped_mode', now, tx, { decision, produced });
      }
      const conversation = await this.deps.conversations.lockById(scope, job.conversationId, tx);
      if (conversation === null || conversation.controlEpoch !== job.controlEpoch) {
        return this.finish(scope, job, 'dropped_epoch', now, tx, { decision, produced });
      }
      if (conversation.state !== 'AI_ACTIVE') {
        return this.finish(scope, job, 'dropped_state', now, tx, { decision, produced });
      }
      const flags = await this.deps.facts.autoGuardFlags(scope, conversation.customerId, tx, {
        since: new Date(now.getTime() - SUPPORT_AI_UNDER_REVIEW_WINDOW_DAYS * 86_400_000),
        serviceLabels: citedLabels,
      });
      const verdict = autoNoActionVerdict({ decision, config, flags, customerTexts });
      if (!verdict.pass) {
        return this.handOffChecked(scope, job, verdict, decision, produced, now, tx);
      }
      await this.deps.conversations.touch(scope, conversation.id, { lastAiAt: now, now }, tx);
      return this.finish(scope, job, 'no_action', now, tx, { decision, produced });
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
    failureClass: SupportAiFailureClass | null = null,
    extra: HandoffExtra = {},
  ): Promise<AutoJobResult> {
    return this.inJobTransaction(scope, job, images, (tx, now) =>
      this.handOffChecked(scope, job, failed, decision, produced, now, tx, failureClass, extra),
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
    failureClass: SupportAiFailureClass | null = null,
    extra: HandoffExtra = {},
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
        // Phase 4 PR-3: check-before-handoff's Persian summary wins over the model's.
        summary:
          extra.summary ?? (decision?.summary.trim() === '' ? null : (decision?.summary ?? null)),
        jobId: job.id,
        // Roadmap A5: the deciding decision's own topic and intent; without one, the
        // escalation reads the latest the AI recorded (`SupportHandoffContext`).
        topic: decision?.topic ?? null,
        intent: decision === null || decision.intent.trim() === '' ? null : decision.intent,
        ...(extra.kind === undefined ? {} : { kind: extra.kind }),
        ...(extra.notice === undefined ? {} : { notice: extra.notice }),
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
          failureClass,
          toolAction: extra.toolAction ?? null,
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

/** Phase 4 PR-3: check-before-handoff's HARD handoff (the money guard's reason and kind). */
const PAYMENT_CHECKED: Extract<AutoVerdict, { pass: false }> = {
  pass: false,
  guard: null,
  outcome: 'handoff_payment_checked',
  reason: 'HANDOFF_TOPIC',
};

/** Phase 4 PR-3: the label of each deep link's button. */
const DEEP_LINK_LABELS: Readonly<Record<SupportAiActionKind, string>> = {
  NONE: SUPPORT_AI_TEMPLATE_KEYS.buttonOpenBot,
  SEND_SUBSCRIPTION_LINK: SUPPORT_AI_TEMPLATE_KEYS.buttonServiceInBot,
  PAYMENT_STATUS: SUPPORT_AI_TEMPLATE_KEYS.buttonOpenBot,
  BUY: SUPPORT_AI_TEMPLATE_KEYS.buttonBuy,
  RENEW: SUPPORT_AI_TEMPLATE_KEYS.buttonRenew,
  ADD_TRAFFIC: SUPPORT_AI_TEMPLATE_KEYS.buttonAddTraffic,
  ADD_TIME: SUPPORT_AI_TEMPLATE_KEYS.buttonAddTime,
  CHANGE_LOCATION: SUPPORT_AI_TEMPLATE_KEYS.buttonChangeLocation,
  TRIAL: SUPPORT_AI_TEMPLATE_KEYS.buttonTrial,
  ROTATE_LINK: SUPPORT_AI_TEMPLATE_KEYS.buttonRotate,
  WALLET_TOPUP: SUPPORT_AI_TEMPLATE_KEYS.buttonTopup,
};

/**
 * Phase 4 PR-3 — the decision recorded for a message NEXA composed without a model (the
 * unsupported-content reply, check-before-handoff's question or delivered link): what was sent,
 * its topic, and an operator note. Deterministic; it is NEXA\'s own record, never a model\'s.
 */
const SERVER_DECISION_NOTES: Readonly<
  Record<
    'sent_unsupported_content' | 'sent_payment_ask' | 'sent_payment_delivered',
    {
      readonly topic: SupportAiDecision['topic'];
      readonly summary: string;
      readonly intent: string;
    }
  >
> = {
  sent_unsupported_content: {
    topic: 'OTHER',
    summary: 'پیام صوتی، استیکر یا فایل؛ از مشتری خواسته شد سؤال را بنویسد.',
    intent: 'پیام غیرمتنی',
  },
  sent_payment_ask: {
    topic: 'PAYMENT_STATUS',
    summary: 'پرداختی پیدا نشد؛ رسید، کد پیگیری یا مبلغ و زمان پرداخت خواسته شد.',
    intent: 'پرداخت کردم ولی نرسید',
  },
  sent_payment_delivered: {
    topic: 'PAYMENT_STATUS',
    summary: 'پرداخت تأیید و سرویس تحویل شده بود؛ لینک همان سرویس فرستاده شد.',
    intent: 'پرداخت کردم ولی نرسید',
  },
};

function serverDecision(
  outcome: keyof typeof SERVER_DECISION_NOTES,
  text: string,
): SupportAiDecision {
  const note = SERVER_DECISION_NOTES[outcome];
  return {
    decision: 'REPLY',
    replyText: text.slice(0, 4000),
    topic: note.topic,
    confidence: 'HIGH',
    factRefs: [],
    knowledgeRefs: [],
    ticketAction: 'NONE',
    summary: note.summary,
    intent: note.intent,
  };
}

/** The bot's username from its start link (`botLinkOf`), or null. */
function botUsernameOf(botLink: string | null): string | null {
  if (botLink === null) return null;
  const match = /^https:\/\/t\.me\/([A-Za-z][A-Za-z0-9_]{3,31})\?/u.exec(botLink);
  return match?.[1] ?? null;
}

/** The tool a resolved plan uses (the tool-call limit counts it). */
function toolActionOf(
  plan: Exclude<ActionPlan, { kind: 'none' } | { kind: 'refused' }>,
): Exclude<SupportAiActionKind, 'NONE'> {
  switch (plan.kind) {
    case 'subscription_link':
      return 'SEND_SUBSCRIPTION_LINK';
    case 'payment_status':
      return 'PAYMENT_STATUS';
    case 'deep_link':
    case 'open_bot':
      return plan.action as Exclude<SupportAiActionKind, 'NONE'>;
  }
}

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

function failVerdict(
  guard: SupportAiAutoGuard,
  reason: BusinessHandoffReason,
): Extract<AutoVerdict, { pass: false }> {
  return { pass: false, guard, outcome: `guard_${guard}`, reason };
}

/** The labels (panel usernames) of the services a decision cites (`S…` aliases). */
function citedServiceLabels(
  decision: SupportAiDecision,
  aliases: ReadonlyMap<string, string>,
): readonly string[] {
  return decision.factRefs
    .filter((ref) => ref.startsWith('S'))
    .flatMap((ref) => {
      const label = aliases.get(ref);
      return label === undefined ? [] : [label];
    });
}
