import {
  SUPPORT_AI_DECISION_JSON_SCHEMA,
  SUPPORT_AI_JOB_EXCEPTION_CODE,
  SUPPORT_AI_JOB_RETRY_DELAY_MS,
  SUPPORT_AI_LINK_SENT_CODE,
  SUPPORT_AI_REFUSAL_LIMIT,
  SUPPORT_AI_SUSPICIOUS_PROBING_CODE,
  SUPPORT_AI_UNDER_REVIEW_WINDOW_DAYS,
  SUPPORT_AI_AUTO_WINDOW,
  TICKET_MESSAGE_MAX_LENGTH,
  businessHandoffKindOf,
  systemJobActor,
  type AuditWriter,
  type Clock,
  type CorrelationId,
  type OperationalEventRecorder,
  type ScopeContext,
  type SettingKey,
  type SupportAiAutoOutcome,
  type SupportAiDecision,
  type SupportAiFailureClass,
  type SupportAiProvider,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { TemplateResolver } from '../../templates/application/template-resolver.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { TicketService } from '../../../commerce/tickets/application/ticket.service.js';
import {
  autoDecisionGuards,
  autoInboundFloodGuard,
  autoMoneyGuard,
  autoNoActionVerdict,
  autoNoProgressGuard,
  autoPreflight,
  autoRepeatedAdviceGuard,
  clarifyingStreakOf,
  customerTextsSinceReply,
  moneyGuardWindow,
  otherStreakOf,
  type AutoContextFlags,
  type AutoVerdict,
} from '../domain/auto-reply-guards.js';
import {
  OUTPUT_POLICY_REGENERATE_NOTE,
  REPEATED_ADVICE_REGENERATE_NOTE,
  checkOutputPolicy,
  outputPolicyAllowanceFromContext,
} from '../domain/output-policy.js';
import { decisionOutputTokens, parseSupportDecision } from '../domain/decision.js';
import { planAction, toolCallLimitReached, type ActionPlan } from '../domain/actions.js';
import { supportSystemPrompt, transcriptMessages } from '../domain/prompt.js';
import type { SupportTranscriptLine } from '../domain/transcript.js';
import type { DrizzleSupportAiConfigRepository } from '../infrastructure/drizzle-support-ai.repository.js';
import type {
  DrizzleSupportAiTicketRepository,
  SupportAiTicketFacts,
  SupportAiTicketJobRecord,
  SupportAiTicketLine,
} from '../infrastructure/drizzle-support-ai-ticket.repository.js';
import { chainFailureClass, type SupportAiChain } from './support-ai-chain.js';
import {
  SUPPORT_AI_TOOLS_OFF,
  type SupportAiToolReader,
  type SupportAiToolSettings,
} from './support-ai-tools.js';
import type { SupportContextSource } from './support-assist.service.js';
import {
  TOOL_SCOPE_REGENERATE_NOTE,
  botUsernameOf,
  citedServiceLabels,
  failVerdict,
  isStale,
  knownAliases,
  toolActionOf,
  verdict,
  type AutoGuardFacts,
} from './support-auto-reply.service.js';
import { SupportToolPreparer, type PreparedTool } from './support-tool-preparer.js';
import { SUPPORT_AI_TICKETS_ENABLED_KEY } from './support-ticket-ai.trigger.js';
import type { AutoResumePolicy } from '../../../commerce/business-chats/application/ports.js';

/** What one ticket job came to; `GONE` when a newer message replaced it, `INACTIVE` when stopped. */
export type TicketAiJobResult = SupportAiAutoOutcome | 'GONE' | 'INACTIVE';

class JobGone extends Error {}
class ScopeStopped extends Error {}

/** How many ticket messages one AI request reads (the Business transcript's bound). */
const TICKET_TRANSCRIPT_READ_LINES = 60;

const STALE = verdict('handoff_stale', 'REPLY_STALE');

export interface SupportTicketAiServiceDeps {
  readonly tickets: Pick<
    DrizzleSupportAiTicketRepository,
    | 'ticket'
    | 'claimNext'
    | 'hold'
    | 'writeHold'
    | 'activity'
    | 'transcript'
    | 'queued'
    | 'insert'
    | 'finish'
    | 'releaseLease'
    | 'epochJobs'
    | 'epochStartedAt'
    | 'repliesSince'
  >;
  readonly configs: Pick<DrizzleSupportAiConfigRepository, 'get'>;
  readonly chain: Pick<SupportAiChain, 'generate'>;
  readonly context: SupportContextSource;
  /** The guards' account facts, read again inside the final transaction. */
  readonly facts: AutoGuardFacts;
  /** Writes the answer into the ticket (sender AI) and queues the customer notification. */
  readonly ticketService: Pick<TicketService, 'postAiReply'>;
  readonly settings: {
    valueOf<T>(scope: ScopeContext, key: SettingKey, tx?: unknown): Promise<T>;
  };
  readonly resume: Pick<AutoResumePolicy, 'resumeAfterMinutes'>;
  readonly audit: AuditWriter;
  readonly opsLog?: OperationalEventRecorder;
  readonly templates?: Pick<TemplateResolver, 'render'>;
  readonly bots?: {
    usernameOf(scope: ScopeContext, botInstanceId: string): Promise<string | null>;
  };
  /** The same read-only tools and owner switches the Business replies use. */
  readonly tools?: {
    readonly reader: SupportAiToolReader;
    readonly settings: SupportAiToolSettings;
  };
  readonly uow: UnitOfWork<TransactionScope>;
  readonly scopeActivity: ScopeActivityReader;
  readonly clock: Clock;
}

/**
 * Phase 4 PR-4 — the support AI's first answer inside a TICKET (the bot's and the Mini App's).
 * One pipeline with the Business chats' automatic reply, not a second one: the same
 * preflight, money, progress and flood guards, the same prompt and strict decision parse, the
 * same decision guards, tool resolver (`planAction`, aliases only), tool preparer, output
 * validator, regeneration, tool-call limit and refusal signal. What differs is only where it
 * reads (a ticket's messages), where it writes (a `ticket_messages` row of sender AI and the
 * ticket's own hold) and what a handoff means (the ticket is already in the queue a person works
 * from, so the AI simply stops: no notice is sent to the customer).
 *
 * Identity comes from the TICKET row (`tickets.customer_id`), never from the conversation or the
 * model. The assistant role calls `produce` on a claimed, due job, outside any transaction.
 */
export class SupportTicketAiService {
  private readonly preparer: SupportToolPreparer;

  constructor(private readonly deps: SupportTicketAiServiceDeps) {
    this.preparer = new SupportToolPreparer({
      ...(deps.tools === undefined ? {} : { reader: deps.tools.reader }),
      ...(deps.templates === undefined ? {} : { templates: deps.templates }),
      clock: deps.clock,
    });
  }

  /**
   * The next due ticket job, leased. A stopped tenant's jobs are not leased, counted or produced
   * (the claim reads scope activity in its own transaction, like every assistant claim).
   */
  async claimNext(
    scope: ScopeContext,
    now: Date,
    leaseUntil: Date,
  ): Promise<SupportAiTicketJobRecord | null> {
    return this.deps.uow.run(scope, async (tx) => {
      if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) return null;
      return this.deps.tickets.claimNext(scope, now, leaseUntil, tx);
    });
  }

  async produce(scope: ScopeContext, job: SupportAiTicketJobRecord): Promise<TicketAiJobResult> {
    const [ticket, hold, { config }, enabled] = await Promise.all([
      this.deps.tickets.ticket(scope, job.ticketId),
      this.deps.tickets.hold(scope, job.ticketId),
      this.deps.configs.get(scope),
      this.enabled(scope),
    ]);
    // 1. Has the world moved since the job was enqueued? Nothing is spent if it has.
    if (!enabled || config.mode !== 'AUTO_REPLY_SAFE') return this.drop(scope, job, 'dropped_mode');
    if (ticket === null || ticket.origin !== 'BOT' || ticket.status === 'CLOSED') {
      return this.drop(scope, job, 'dropped_state');
    }
    if ((hold?.epoch ?? 0) !== job.epoch || hold?.state === 'HANDOFF_REQUIRED') {
      return this.drop(scope, job, 'dropped_epoch');
    }
    const now = this.deps.clock.now();
    if (isStale(job, now)) return this.handOff(scope, job, STALE, null, null);

    // 2. The transcript, and the message this job answers: it must still be the newest.
    const rows = await this.deps.tickets.transcript(scope, ticket.id, TICKET_TRANSCRIPT_READ_LINES);
    const newest = rows.at(-1);
    if (newest === undefined || newest.id !== job.triggerMessageId) {
      return this.drop(scope, job, 'dropped_state');
    }
    const transcript = linesOf(rows);
    const triggerText = newest.body;
    const context = await this.deps.context.build(scope, ticket.customerId, { transcript });
    const tools = await this.toolSettings(scope);
    // 2b. Preflight: a customer's own readable text, not blocked, the loop guard has room. A
    // file cannot be read (no vision in tickets): fail closed to a person.
    const epochJobs = await this.deps.tickets.epochJobs(scope, {
      ticketId: ticket.id,
      epoch: job.epoch,
    });
    const preflight = await this.preflight(
      scope,
      ticket,
      job,
      config,
      context.flags.customerBlocked,
      newest,
      now,
    );
    if (!preflight.pass) return this.handOff(scope, job, preflight, null, null);

    const active = await this.deps.uow.run(scope, (tx) =>
      this.deps.scopeActivity.scopeIsActive(scope, tx),
    );
    if (!active) return 'INACTIVE';
    const botLink = await this.botLinkOf(scope, ticket.botInstanceId);
    // 3. D9: money in what the customer wrote is a person's, whatever topic a model would pick.
    // (No check-before-handoff in tickets: a person already reads every ticket.)
    const customerTexts = customerTextsSinceReply(transcript, triggerText);
    const money = autoMoneyGuard(moneyGuardWindow(transcript, triggerText));
    if (!money.pass) return this.handOff(scope, job, money, null, null);
    const since = await this.deps.tickets.epochStartedAt(scope, {
      ticketId: ticket.id,
      epoch: job.epoch,
    });
    const progress = autoNoProgressGuard(transcript, since);
    if (!progress.pass) return this.handOff(scope, job, progress, null, null);
    const flood = autoInboundFloodGuard(transcript, since);
    if (!flood.pass) return this.handOff(scope, job, flood, null, null);

    const turns = transcriptMessages(
      transcript.map((line) => ({
        origin: line.origin,
        author: line.author,
        text: line.text,
        kind: line.kind,
        image: null,
      })),
      { attachImages: false },
    );
    if (turns.length === 0) {
      return this.handOff(scope, job, failVerdict('content', 'UNSUPPORTED_CONTENT'), null, null);
    }
    const parse = (output: unknown) =>
      parseSupportDecision(output, { maxReplyChars: null, mode: 'STRICT' });
    const allowanceWith = (links: readonly string[]) =>
      outputPolicyAllowanceFromContext(context.json, {
        links: [...(botLink === null ? [] : [botLink]), ...links],
        ...(context.priceFamily === undefined ? {} : { priceFamily: context.priceFamily }),
      });
    const botUsername = botUsernameOf(botLink);
    // The epoch's counts, from NEXA's own rows (never the model's).
    const sentRows = epochJobs.filter(
      (row) => row.outcome === 'sent' || row.outcome === 'sent_clarifying',
    );
    const clarifyingStreak = clarifyingStreakOf(sentRows);
    const otherStreak = otherStreakOf(sentRows);
    const refusals = sentRows.filter((row) => row.topic === 'POLICY_REFUSAL').length;
    const toolCalls = epochJobs.filter((row) => row.toolAction !== null).length;

    let regenerateNote: string | null = null;
    for (let attempt = 0; ; attempt += 1) {
      const result = await this.deps.chain.generate(scope, {
        operation: 'AUTO_DECISION',
        conversationId: null,
        jobId: null,
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
      });
      if (result.outcome.outcome !== 'OK' || result.step === null) {
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
          parsed.failure.failureClass,
        );
      }
      const decision = parsed.decision;
      const unreconciledCited = decision.factRefs.some(
        (ref) => context.unreconciledAliases?.has(ref) === true,
      );
      const flags: AutoContextFlags = { ...context.flags, unreconciledCited };

      // 4. Roadmap A6: a thanks on an allowlisted, non-sensitive topic ends the job silently.
      const silence = autoNoActionVerdict({ decision, config, flags, customerTexts });
      if (decision.decision === 'NO_ACTION' && !silence.pass) {
        return this.handOff(scope, job, silence, decision, produced);
      }
      if (silence.pass) return this.closeSilently(scope, job, decision, produced);

      // 5. NEXA decides.
      const grounding = {
        knownAliases: knownAliases(context),
        knownKnowledgeAliases: new Set(context.knowledgeAliases?.keys() ?? []),
      };
      const guards = autoDecisionGuards({
        decision,
        config,
        flags,
        ...grounding,
        clarifyingStreak,
        otherStreak,
        // As the Business producer: the read-only tool exceptions (payment status, wallet top-up)
        // exist only while the owner's tools switch is on.
        actionsEnabled: tools.actions,
      });
      if (!guards.pass) {
        // An unlinked-customer link is a Business matter; a ticket's customer is always linked.
        const failed =
          guards.sendLink === true ? failVerdict('identity', 'IDENTITY_UNVERIFIED') : guards;
        return this.handOff(scope, job, failed, decision, produced);
      }
      // 5a. Cross-cutting item 7: the third polite refusal in an epoch is somebody probing.
      if (decision.topic === 'POLICY_REFUSAL' && refusals + 1 >= SUPPORT_AI_REFUSAL_LIMIT) {
        return this.handOff(
          scope,
          job,
          failVerdict('refusal_abuse', 'SUSPICIOUS_PROBING'),
          decision,
          produced,
          null,
          {},
          true,
        );
      }
      // 5b. The decision's tool, resolved ONLY through this payload's alias map.
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
          if (toolCallLimitReached(toolCalls)) {
            return this.handOff(
              scope,
              job,
              failVerdict('tool_rate_limit', 'SUSPICIOUS_PROBING'),
              decision,
              produced,
              null,
              { toolAction },
              true,
            );
          }
          tool =
            plan.kind === 'refused'
              ? null
              : await this.prepareTool(scope, ticket.customerId, plan, botUsername);
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
              null,
              { toolAction },
            );
          }
        }
      }
      // 5c. Cross-cutting item 3: the output validator, with the tool's text; repeated advice.
      const body = bodyOf(decision.replyText, tool);
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
        return this.handOff(scope, job, refused, decision, produced);
      }
      if (Array.from(body).length > TICKET_MESSAGE_MAX_LENGTH) {
        return this.handOff(
          scope,
          job,
          failVerdict('reply_bounds', 'REPLY_OUT_OF_BOUNDS'),
          decision,
          produced,
        );
      }
      return this.reply(
        scope,
        job,
        ticket,
        decision,
        produced,
        grounding,
        since,
        body,
        tool,
        citedServiceLabels(decision, context.aliases),
      );
    }
  }

  /** A job claimed too many times without a result: repeated failure hands off. */
  async giveUp(scope: ScopeContext, job: SupportAiTicketJobRecord): Promise<TicketAiJobResult> {
    return this.handOff(
      scope,
      job,
      verdict('handoff_ai_unavailable', 'AI_UNAVAILABLE'),
      null,
      null,
    );
  }

  /** A job whose `produce` threw: retried once, then handed off (Phase 4 PR-1 item 8). */
  async recoverFromException(
    scope: ScopeContext,
    job: SupportAiTicketJobRecord,
  ): Promise<TicketAiJobResult | 'RETRY'> {
    if (job.attempts >= 2) return this.giveUp(scope, job);
    return this.deps.uow.run(scope, async (tx) => {
      if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) return 'INACTIVE' as const;
      const now = this.deps.clock.now();
      await this.deps.tickets.releaseLease(
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
            'An automatic support-AI job for a ticket failed with an error; it is retried once, then handed to a person.',
          dedupeKey: `${SUPPORT_AI_JOB_EXCEPTION_CODE}:${job.id}`,
          context: { operationId: job.id, ticketId: job.ticketId },
        },
        tx,
      );
      return 'RETRY' as const;
    });
  }

  // --- the pieces -------------------------------------------------------------------------

  private async enabled(scope: ScopeContext, tx?: unknown): Promise<boolean> {
    return this.deps.settings.valueOf<boolean>(scope, SUPPORT_AI_TICKETS_ENABLED_KEY, tx);
  }

  private async toolSettings(scope: ScopeContext, tx?: unknown) {
    if (this.deps.tools === undefined) return SUPPORT_AI_TOOLS_OFF;
    return this.deps.tools.settings.read(scope, tx);
  }

  private async botLinkOf(scope: ScopeContext, botInstanceId: string): Promise<string | null> {
    const username = (await this.deps.bots?.usernameOf(scope, botInstanceId)) ?? null;
    if (username === null || !/^[A-Za-z][A-Za-z0-9_]{3,31}$/u.test(username)) return null;
    return `https://t.me/${username}?start=support`;
  }

  /** The content, blocked-customer and loop guards on the trigger and the counts as they are now. */
  private async preflight(
    scope: ScopeContext,
    ticket: SupportAiTicketFacts,
    job: SupportAiTicketJobRecord,
    config: { readonly sessionReplyBudget: number; readonly maxAutoRepliesPerHour: number },
    customerBlocked: boolean,
    trigger: SupportAiTicketLine,
    now: Date,
    tx?: unknown,
  ): Promise<AutoVerdict> {
    const [epochJobs, inWindow] = await Promise.all([
      this.deps.tickets.epochJobs(scope, { ticketId: ticket.id, epoch: job.epoch }, tx),
      this.deps.tickets.repliesSince(
        scope,
        ticket.id,
        new Date(now.getTime() - SUPPORT_AI_AUTO_WINDOW.windowSeconds * 1000),
        tx,
      ),
    ]);
    const sessionReplies = epochJobs.filter(
      (row) =>
        (row.outcome === 'sent' || row.outcome === 'sent_clarifying') && row.topic !== 'GREETING',
    ).length;
    return autoPreflight({
      trigger: {
        origin: 'INBOUND',
        // A file in the message cannot be read here: not 'TEXT', so it fails the content guard.
        kind: trigger.hasAttachment ? 'OTHER' : 'TEXT',
        text: trigger.body,
        deleted: false,
      },
      customerBlocked,
      sessionReplies,
      autoInWindow: inWindow,
      sessionReplyBudget: config.sessionReplyBudget,
      maxPerWindow: config.maxAutoRepliesPerHour,
    });
  }

  /**
   * What one planned tool adds to the answer. A ticket reply has no buttons, so a tool whose
   * result is a button (a deep link, «open the bot», a files-only service's card)
   * becomes one more line of text carrying NEXA's own link, validated with the reply.
   */
  private async prepareTool(
    scope: ScopeContext,
    customerId: string,
    plan: Exclude<ActionPlan, { kind: 'none' } | { kind: 'refused' }>,
    botUsername: string | null,
  ): Promise<PreparedTool | null> {
    const prepared = await this.preparer.prepare(scope, customerId, plan, botUsername);
    if (prepared === null || prepared.button === null) return prepared;
    const url = prepared.button.url;
    if (url === null) return null;
    const line = await this.preparer.render(scope, 'bot.ticket.ai_open_in_bot', { link: url });
    if (line === null) return null;
    return {
      ...prepared,
      extra: prepared.extra === null ? line : `${prepared.extra}\n\n${line}`,
      validated: true,
      allowLinks: [...prepared.allowLinks, url],
      button: null,
    };
  }

  /** Nothing is sent: the job ends and the ticket stays with the AI (a closed matter). */
  private async closeSilently(
    scope: ScopeContext,
    job: SupportAiTicketJobRecord,
    decision: SupportAiDecision,
    produced: { readonly provider: SupportAiProvider; readonly model: string },
  ): Promise<TicketAiJobResult> {
    return this.inJobTransaction(scope, async (tx, now) => {
      const stillOurs = await this.stillOurs(scope, job, tx);
      if (stillOurs !== null) return this.finish(scope, job, stillOurs, now, tx);
      return this.finish(scope, job, 'no_action', now, tx, { decision, produced });
    });
  }

  /**
   * The answer, in ONE transaction that decides again on what is true now: the switch and mode,
   * the ticket under its row lock (still open, still this customer's, the hold still at this
   * epoch, the trigger still the newest message — a person's reply meanwhile drops it), the
   * guards on the facts read here, repeated advice on the transcript read here, and the service
   * a link is sent for. Then the ticket service writes the AI message and queues the notice.
   */
  private async reply(
    scope: ScopeContext,
    job: SupportAiTicketJobRecord,
    ticket: SupportAiTicketFacts,
    decision: SupportAiDecision,
    produced: { readonly provider: SupportAiProvider; readonly model: string },
    grounding: {
      readonly knownAliases: ReadonlySet<string>;
      readonly knownKnowledgeAliases: ReadonlySet<string>;
    },
    since: Date | null,
    body: string,
    tool: PreparedTool | null,
    /** The panel usernames of the services the decision cites, from THIS payload's alias map. */
    citedLabels: readonly string[],
  ): Promise<TicketAiJobResult> {
    return this.inJobTransaction(scope, async (tx, now) => {
      const { config } = await this.deps.configs.get(scope, tx);
      if (!(await this.enabled(scope, tx)) || config.mode !== 'AUTO_REPLY_SAFE') {
        return this.finish(scope, job, 'dropped_mode', now, tx);
      }
      const stillOurs = await this.stillOurs(scope, job, tx);
      if (stillOurs !== null) return this.finish(scope, job, stillOurs, now, tx);
      const flags = await this.deps.facts.autoGuardFlags(scope, ticket.customerId, tx, {
        since: new Date(now.getTime() - SUPPORT_AI_UNDER_REVIEW_WINDOW_DAYS * 86_400_000),
        serviceLabels: citedLabels,
      });
      const rows = await this.deps.tickets.transcript(
        scope,
        ticket.id,
        TICKET_TRANSCRIPT_READ_LINES,
        tx,
      );
      const trigger = rows.at(-1);
      const preflight =
        trigger === undefined
          ? failVerdict('content', 'UNSUPPORTED_CONTENT')
          : await this.preflight(
              scope,
              ticket,
              job,
              config,
              flags.customerBlocked,
              trigger,
              now,
              tx,
            );
      const epochJobs = await this.deps.tickets.epochJobs(
        scope,
        { ticketId: ticket.id, epoch: job.epoch },
        tx,
      );
      const sentRows = epochJobs.filter(
        (row) => row.outcome === 'sent' || row.outcome === 'sent_clarifying',
      );
      const recheck: AutoVerdict = !preflight.pass
        ? preflight
        : autoDecisionGuards({
            decision,
            config,
            flags,
            ...grounding,
            clarifyingStreak: clarifyingStreakOf(sentRows),
            otherStreak: otherStreakOf(sentRows),
            // The switch as it is NOW, read in this transaction.
            actionsEnabled: (await this.toolSettings(scope, tx)).actions,
          });
      if (!recheck.pass) {
        const failed =
          recheck.sendLink === true ? failVerdict('identity', 'IDENTITY_UNVERIFIED') : recheck;
        return this.handOffChecked(scope, job, failed, decision, produced, now, tx);
      }
      const repeated = autoRepeatedAdviceGuard(decision, linesOf(rows), since);
      if (!repeated.pass)
        return this.handOffChecked(scope, job, repeated, decision, produced, now, tx);
      // The service a link is sent for is read again HERE: a transfer or rotation during the
      // provider call must not send the old owner, or the old link.
      const linkSent = tool?.linkSent ?? null;
      if (
        linkSent !== null &&
        !(await this.linkStillTrue(scope, ticket.customerId, linkSent, tx))
      ) {
        return this.handOffChecked(
          scope,
          job,
          failVerdict('tool_scope', 'INSUFFICIENT_GROUNDING'),
          decision,
          produced,
          now,
          tx,
          { toolAction: tool?.toolAction ?? null },
        );
      }
      const posted = await this.deps.ticketService.postAiReply(
        scope as TenantContext,
        {
          ticketId: ticket.id,
          customerId: ticket.customerId,
          body,
          jobId: job.id,
          now,
        },
        tx,
      );
      if (posted.outcome === 'REFUSED') {
        if (posted.reason === 'SCOPE_INACTIVE') throw new ScopeStopped();
        return this.finish(
          scope,
          job,
          posted.reason === 'BLOCKED' ? 'guard_customer_blocked' : 'dropped_state',
          now,
          tx,
          { decision, produced },
        );
      }
      const outcome = decision.decision === 'ASK_CLARIFYING_QUESTION' ? 'sent_clarifying' : 'sent';
      const ok = await this.deps.tickets.finish(
        scope,
        job.id,
        {
          outcome,
          decision,
          provider: produced.provider,
          model: produced.model,
          toolAction: tool?.toolAction ?? null,
          replyMessageId: posted.message.id,
          now,
        },
        tx,
      );
      if (!ok) throw new JobGone();
      if (linkSent !== null) {
        await this.deps.opsLog?.record(
          scope,
          {
            code: SUPPORT_AI_LINK_SENT_CODE,
            severity: 'INFO',
            message:
              'The support AI sent a customer the subscription link (or files pointer) of their own service in a ticket.',
            dedupeKey: `${SUPPORT_AI_LINK_SENT_CODE}:${job.id}`,
            context: {
              customerId: ticket.customerId,
              ticketId: ticket.id,
              serviceUsername: linkSent.username,
            },
          },
          tx,
        );
      }
      return outcome;
    });
  }

  /**
   * Whether the ticket is still the AI's to answer, read under its row lock: null when it is,
   * otherwise the outcome to drop with. A person's reply or the customer's next message since
   * the trigger means this answer is stale; a hold moved since means the epoch did.
   */
  private async stillOurs(
    scope: ScopeContext,
    job: SupportAiTicketJobRecord,
    tx: TransactionScope,
  ): Promise<SupportAiAutoOutcome | null> {
    const ticket = await this.deps.tickets.ticket(scope, job.ticketId, tx, true);
    if (ticket === null || ticket.origin !== 'BOT' || ticket.status === 'CLOSED') {
      return 'dropped_state';
    }
    const hold = await this.deps.tickets.hold(scope, job.ticketId, tx);
    if ((hold?.epoch ?? 0) !== job.epoch || hold?.state === 'HANDOFF_REQUIRED') {
      return 'dropped_epoch';
    }
    const activity = await this.deps.tickets.activity(scope, job.ticketId, tx);
    if (activity.newest?.id !== job.triggerMessageId) return 'dropped_state';
    return null;
  }

  private async linkStillTrue(
    scope: ScopeContext,
    customerId: string,
    sent: NonNullable<PreparedTool['linkSent']>,
    tx: TransactionScope,
  ): Promise<boolean> {
    const now = await this.deps.tools?.reader.subscriptionOf(scope, customerId, sent.serviceId, tx);
    if (now === undefined || now === null) return false;
    return sent.link === null ? now.filesOnly && now.link === null : now.link === sent.link;
  }

  private async drop(
    scope: ScopeContext,
    job: SupportAiTicketJobRecord,
    outcome: SupportAiAutoOutcome,
  ): Promise<TicketAiJobResult> {
    return this.inJobTransaction(scope, (tx, now) => this.finish(scope, job, outcome, now, tx));
  }

  private async finish(
    scope: ScopeContext,
    job: SupportAiTicketJobRecord,
    outcome: SupportAiAutoOutcome,
    now: Date,
    tx: unknown,
    result?: {
      readonly decision: SupportAiDecision | null;
      readonly produced: { readonly provider: SupportAiProvider; readonly model: string } | null;
    },
  ): Promise<TicketAiJobResult> {
    const ok = await this.deps.tickets.finish(
      scope,
      job.id,
      {
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

  /** A handoff decided before the final transaction: it opens its own. */
  private async handOff(
    scope: ScopeContext,
    job: SupportAiTicketJobRecord,
    failed: Extract<AutoVerdict, { pass: false }>,
    decision: SupportAiDecision | null,
    produced: { readonly provider: SupportAiProvider; readonly model: string } | null,
    failureClass: SupportAiFailureClass | null = null,
    extra: { readonly toolAction?: PreparedTool['toolAction'] | null } = {},
    probing = false,
  ): Promise<TicketAiJobResult> {
    return this.inJobTransaction(scope, async (tx, now) => {
      const result = await this.handOffChecked(
        scope,
        job,
        failed,
        decision,
        produced,
        now,
        tx,
        extra,
        failureClass,
      );
      if (probing && result !== 'dropped_epoch' && result !== 'dropped_state') {
        await this.deps.opsLog?.record(
          scope,
          {
            code: SUPPORT_AI_SUSPICIOUS_PROBING_CODE,
            severity: 'WARN',
            message:
              'A customer asked repeatedly, in a ticket, for what the support AI must not give; the ticket was handed to a person.',
            dedupeKey: `${SUPPORT_AI_SUSPICIOUS_PROBING_CODE}:${job.ticketId}:${String(job.epoch)}`,
            context: { ticketId: job.ticketId },
          },
          tx,
        );
      }
      return result;
    });
  }

  /**
   * The handoff, in the caller's transaction. The ticket is already in the queue a person works
   * from, so the AI simply stops: the hold is written (HARD or SOFT by the Business chats'
   * `businessHandoffKindOf`), the epoch moves so nothing queued under the old one survives, and
   * no message goes to the customer. A ticket that closed or moved on meanwhile is dropped.
   */
  private async handOffChecked(
    scope: ScopeContext,
    job: SupportAiTicketJobRecord,
    failed: Extract<AutoVerdict, { pass: false }>,
    decision: SupportAiDecision | null,
    produced: { readonly provider: SupportAiProvider; readonly model: string } | null,
    now: Date,
    tx: TransactionScope,
    extra: { readonly toolAction?: PreparedTool['toolAction'] | null } = {},
    failureClass: SupportAiFailureClass | null = null,
  ): Promise<TicketAiJobResult> {
    // Under the ticket's row lock, as the reply path: closed, moved on (a hold at another epoch),
    // or no longer the newest message (a person replied, or the customer wrote again) means this
    // decision is stale and writes no hold — a stale HARD handoff must not silence the ticket.
    const stale = await this.stillOurs(scope, job, tx);
    if (stale !== null) return this.finish(scope, job, stale, now, tx);
    const kind = businessHandoffKindOf(failed.reason, decision?.topic ?? null);
    const ok = await this.deps.tickets.finish(
      scope,
      job.id,
      {
        outcome: failed.outcome,
        decision,
        provider: produced?.provider ?? null,
        model: produced?.model ?? null,
        handoffReason: failed.reason,
        failureClass,
        toolAction: extra.toolAction ?? null,
        now,
      },
      tx,
    );
    if (!ok) throw new JobGone();
    await this.deps.tickets.writeHold(
      scope,
      {
        ticketId: job.ticketId,
        state: 'HANDOFF_REQUIRED',
        epoch: job.epoch + 1,
        handoffKind: kind,
        handoffReason: failed.reason,
        heldAt: now,
      },
      now,
      tx,
    );
    await this.deps.audit.record(
      scope,
      systemJobActor(`support-ai-ticket:${job.id}`, job.id as CorrelationId),
      {
        action: 'support_ai.ticket_handoff',
        entityType: 'Ticket',
        entityId: job.ticketId,
        before: null,
        after: { reason: failed.reason, kind, outcome: failed.outcome, jobId: job.id },
        result: 'SUCCESS',
      },
      tx,
    );
    return failed.outcome;
  }

  /**
   * One transaction that reads scope activity first; a replaced job rolls everything back
   * (`JobGone`), a stopped scope writes nothing (`INACTIVE`) and the job is claimed again on
   * resume.
   */
  private async inJobTransaction(
    scope: ScopeContext,
    work: (tx: TransactionScope, now: Date) => Promise<TicketAiJobResult>,
  ): Promise<TicketAiJobResult> {
    try {
      return await this.deps.uow.run(scope, async (tx) => {
        const now = this.deps.clock.now();
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) throw new ScopeStopped();
        return work(tx, now);
      });
    } catch (error) {
      if (error instanceof JobGone) return 'GONE';
      if (error instanceof ScopeStopped) return 'INACTIVE';
      throw error;
    }
  }
}

/** The text stored in the ticket: the model's reply, then NEXA's own tool line. */
function bodyOf(reply: string, tool: PreparedTool | null): string {
  const text = reply.trim();
  return tool?.extra === undefined || tool.extra === null ? text : `${text}\n\n${tool.extra}`;
}

/**
 * A ticket's messages as the shared guards and the prompt read a transcript: the customer's
 * lines are INBOUND, a person's are STAFF, the assistant's own are AI_AUTO. A SYSTEM fact is
 * not a line. NEXA decides the author from the row's sender, never from the text.
 */
function linesOf(rows: readonly SupportAiTicketLine[]): SupportTranscriptLine[] {
  return rows.flatMap((row): SupportTranscriptLine[] => {
    if (row.senderType === 'SYSTEM') return [];
    const customer = row.senderType === 'CUSTOMER';
    return [
      {
        id: row.id,
        origin: customer ? 'INBOUND' : row.senderType === 'AI' ? 'OWN_ECHO' : 'HUMAN',
        author: customer ? 'CUSTOMER' : row.senderType === 'AI' ? 'AI_AUTO' : 'STAFF',
        kind: row.hasAttachment ? 'OTHER' : 'TEXT',
        text: row.body,
        sentAt: row.createdAt,
      },
    ];
  });
}
