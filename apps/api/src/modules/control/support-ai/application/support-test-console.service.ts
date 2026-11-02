import {
  SUPPORT_AI_DECISION_JSON_SCHEMA,
  businessHandoffKindOf,
  errors,
  supportTestConsoleRequestSchema,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdempotencyStore,
  type OperationalEventRecorder,
  type PermissionKey,
  type ScopeContext,
  type SupportAiProvider,
  type SupportTestConsoleResponse,
  type UnitOfWork,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import { recordMutationDenial } from '../../../platform/access/application/authorized-mutation.js';
import { hashRequest } from '../../../platform/idempotency/infrastructure/drizzle-idempotency-store.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  autoDecisionGuards,
  autoMoneyGuard,
  autoNoActionAllowed,
  customerTextsSinceReply,
  moneyGuardWindow,
  type AutoContextFlags,
  type AutoVerdict,
} from '../domain/auto-reply-guards.js';
import { decisionOutputTokens, parseSupportDecision } from '../domain/decision.js';
import { checkOutputPolicy, outputPolicyAllowanceFromContext } from '../domain/output-policy.js';
import { supportSystemPrompt, transcriptMessages } from '../domain/prompt.js';
import type { SupportTranscriptLine } from '../domain/transcript.js';
import type { DrizzleSupportAiConfigRepository } from '../infrastructure/drizzle-support-ai.repository.js';
import { chainFailureClass, type SupportAiChain } from './support-ai-chain.js';
import { resolveKnowledgeLabels, type SupportContextSource } from './support-assist.service.js';
import {
  SUPPORT_AI_CONFIGURE_PERMISSION,
  SUPPORT_AI_ERROR_CODES,
} from './support-ai-config.service.js';

const USERS_VIEW_PERMISSION = 'users.view' satisfies PermissionKey;

export interface SupportTestConsoleDeps {
  readonly configs: Pick<DrizzleSupportAiConfigRepository, 'get'>;
  readonly chain: Pick<SupportAiChain, 'generate'>;
  readonly context: SupportContextSource;
  readonly guard: PermissionGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly idempotency: IdempotencyStore;
  readonly scopeActivity: ScopeActivityReader;
  readonly clock: Clock;
}

/**
 * Phase 4 PR-5 — «امتحان یک سؤال». The owner types a question as if a customer had sent it and
 * sees what the REAL stored configuration would do with it: the same context, prompt, chain,
 * strict decision parse, money guard, decision guards and output validator the automatic reply
 * runs (`SupportAutoReplyService.produce`, in the same order), up to — and never including —
 * the step that enqueues anything.
 *
 * It sends NOTHING, structurally: this service holds no outbound repository, no conversation
 * service, no job repository and no ticket port, so there is nothing here that could write a
 * customer-visible message, change a conversation, hand one off or open a ticket. The only
 * writes are the ones a paid provider call always leaves — its `support_ai_runs` telemetry row
 * (operation TEST_CONSOLE), the audit entry and the idempotency marker. The tests snapshot
 * every customer-facing table around a run.
 *
 * What is NOT run, because it needs a conversation: the loop, flood, no-progress and repeated
 * advice guards, the cooldown, the one regeneration after an output-policy refusal (reported
 * as `outputPolicyRefused` instead), vision.
 *
 * Charged `support_ai.configure`, like every read and write of the support AI's settings; a
 * run on a real customer's facts also charges `users.view`. Refused while the mode is OFF
 * ("no AI work of any kind"). The audit entry names the verdict and topic, never the question.
 */
export class SupportTestConsoleService {
  constructor(private readonly deps: SupportTestConsoleDeps) {}

  async run(
    scope: ScopeContext,
    actor: ActorContext,
    body: unknown,
  ): Promise<SupportTestConsoleResponse> {
    const command = supportTestConsoleRequestSchema.parse(body);
    const denial = {
      action: 'support_ai.test_console.run',
      entityType: 'SupportAi',
      entityId: null,
    };
    await this.authorize(scope, actor, SUPPORT_AI_CONFIGURE_PERMISSION, denial);
    if (command.customerId !== null) {
      await this.authorize(scope, actor, USERS_VIEW_PERMISSION, denial);
    }
    const requestHash = hashRequest({
      command: 'support_ai.test_console.run',
      question: command.question,
      customerId: command.customerId,
    });
    // A replay is a double click: the first run already paid, and its answer is not stored.
    const replay = await this.deps.idempotency.find<{ ran: true }>(
      scope,
      actor.surface,
      command.idempotencyKey,
      requestHash,
    );
    if (replay !== null) {
      throw errors.conflict(
        SUPPORT_AI_ERROR_CODES.TEST_CONSOLE_REPLAY,
        'This test already ran; run it again.',
      );
    }
    if (!(await this.deps.scopeActivity.scopeIsActive(scope))) {
      throw errors.notFound('platform.tenant_not_found', 'This scope is not accepting work.');
    }
    const { config } = await this.deps.configs.get(scope);
    if (config.mode === 'OFF') {
      throw errors.conflict(
        SUPPORT_AI_ERROR_CODES.TEST_CONSOLE_OFF,
        'The support AI is off; turn on assist or automatic mode to test it.',
      );
    }
    const mode = config.mode;

    const now = this.deps.clock.now();
    const transcript: readonly SupportTranscriptLine[] = [
      {
        id: 'console',
        origin: 'INBOUND',
        author: 'CUSTOMER',
        kind: 'TEXT',
        text: command.question,
        sentAt: now,
      },
    ];
    const context = await this.deps.context.build(scope, command.customerId, { transcript });
    if (command.customerId !== null && !context.linked) {
      throw errors.notFound('users.not_found', 'No such customer.');
    }

    // Claimed BEFORE the paid call, atomically (the store's insert is the arbiter): of two
    // overlapping requests with one key exactly one reaches the provider.
    const claimed = await this.deps.uow.run(scope, (tx) =>
      this.deps.idempotency.remember(
        scope,
        actor.surface,
        command.idempotencyKey,
        requestHash,
        { ran: true as const },
        tx,
      ),
    );
    if (!claimed) {
      throw errors.conflict(
        SUPPORT_AI_ERROR_CODES.TEST_CONSOLE_REPLAY,
        'This test already ran; run it again.',
      );
    }

    const result = await this.decide(scope, command.question, transcript, config, context, mode);

    await this.deps.uow.run(scope, async (tx) => {
      await this.deps.audit.record(
        scope,
        actor,
        {
          action: 'support_ai.test_console.run',
          entityType: 'SupportAi',
          entityId: null,
          before: null,
          after: {
            verdict: result.verdict,
            topic: result.topic,
            customerLinked: result.customerLinked,
            questionChars: command.question.length,
          },
          result: 'SUCCESS',
        },
        tx,
      );
    });
    return result;
  }

  private async decide(
    scope: ScopeContext,
    question: string,
    transcript: readonly SupportTranscriptLine[],
    config: Awaited<ReturnType<DrizzleSupportAiConfigRepository['get']>>['config'],
    context: Awaited<ReturnType<SupportContextSource['build']>>,
    mode: 'ASSIST_ONLY' | 'AUTO_REPLY_SAFE',
  ): Promise<SupportTestConsoleResponse> {
    const base = {
      mode,
      answer: null,
      decision: null,
      topic: null,
      confidence: null,
      knowledgeUsed: [] as string[],
      factsUsed: [] as string[],
      knowledgeSent: context.knowledge?.sent ?? null,
      knowledgeAvailable: context.knowledge?.available ?? null,
      guard: null,
      outputPolicyRefused: false,
      failureClass: null,
      provider: null,
      model: null,
      customerLinked: context.linked,
      inputTokens: null,
      outputTokens: null,
    } satisfies Omit<SupportTestConsoleResponse, 'verdict'>;
    const blocked = (
      verdict: Extract<AutoVerdict, { pass: false }>,
      topic: SupportTestConsoleResponse['topic'],
    ) => ({
      outcome: verdict.outcome,
      reason: verdict.reason,
      kind: businessHandoffKindOf(verdict.reason, topic),
    });

    // Before any provider cost: a blocked customer, then money in what the customer wrote.
    if (context.flags.customerBlocked) {
      const verdict: Extract<AutoVerdict, { pass: false }> = {
        pass: false,
        guard: 'customer_blocked',
        outcome: 'guard_customer_blocked',
        reason: 'CUSTOMER_BLOCKED',
      };
      return { ...base, verdict: 'NOT_ASKED', guard: blocked(verdict, null) };
    }
    const money = autoMoneyGuard(moneyGuardWindow(transcript, question));
    if (!money.pass) return { ...base, verdict: 'NOT_ASKED', guard: blocked(money, null) };

    // The model proposes (one attempt; the run is the real chain, recorded as TEST_CONSOLE).
    const parse = (output: unknown) =>
      parseSupportDecision(output, { maxReplyChars: null, mode: 'STRICT' });
    const result = await this.deps.chain.generate(scope, {
      operation: 'TEST_CONSOLE',
      conversationId: null,
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
          regenerateNote: null,
        }),
        messages: transcriptMessages(
          transcript.map((line) => ({
            origin: line.origin,
            author: line.author,
            text: line.text,
            kind: line.kind,
            image: null,
          })),
        ),
        jsonSchema: SUPPORT_AI_DECISION_JSON_SCHEMA,
        schemaName: 'support_decision',
        maxOutputTokens: decisionOutputTokens(config.maxOutputChars),
      },
    });
    const usage =
      'usage' in result.outcome && result.outcome.usage !== undefined ? result.outcome.usage : null;
    const tokens = {
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
    };
    if (result.outcome.outcome !== 'OK' || result.step === null) {
      return {
        ...base,
        ...tokens,
        verdict: 'NO_ANSWER',
        failureClass: chainFailureClass(result),
        provider: result.step?.provider ?? null,
      };
    }
    const produced = {
      provider: result.step.provider as SupportAiProvider,
      model: result.outcome.model,
    };
    const parsed = parse(result.outcome.output);
    if (!parsed.ok) {
      return {
        ...base,
        ...tokens,
        ...produced,
        verdict: 'NO_ANSWER',
        failureClass: parsed.failure.failureClass,
      };
    }
    const decision = parsed.decision;
    const shown = {
      ...base,
      ...tokens,
      ...produced,
      answer: decision.replyText === '' ? null : decision.replyText,
      decision: decision.decision,
      topic: decision.topic,
      confidence: decision.confidence,
      knowledgeUsed: resolveKnowledgeLabels(decision.knowledgeRefs, context.knowledgeAliases),
      factsUsed: decision.factRefs.flatMap((ref) => {
        const label = context.aliases.get(ref);
        return label === undefined ? [] : [label];
      }),
    };

    // «مرسی»: a closing line ends silently.
    const customerTexts = customerTextsSinceReply(transcript, question);
    if (autoNoActionAllowed({ decision, config, flags: context.flags, customerTexts })) {
      return { ...shown, verdict: 'WOULD_CLOSE_SILENTLY' };
    }

    // NEXA decides: the same guards, the clarifying and OTHER streaks starting from zero.
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
      knownAliases: new Set(context.aliases.keys()),
      knownKnowledgeAliases: new Set(context.knowledgeAliases?.keys() ?? []),
      clarifyingStreak: 0,
      otherStreak: 0,
    });
    if (!guards.pass && guards.sendLink === true) return { ...shown, verdict: 'WOULD_SEND_LINK' };
    if (!guards.pass) {
      return { ...shown, verdict: 'WOULD_HAND_OFF', guard: blocked(guards, decision.topic) };
    }
    // The output validator, with the context's own allowance.
    const policy = checkOutputPolicy(
      decision.replyText,
      outputPolicyAllowanceFromContext(context.json),
      this.deps.clock.now(),
    );
    if (!policy.ok) {
      return {
        ...shown,
        verdict: 'WOULD_HAND_OFF',
        outputPolicyRefused: true,
        guard: blocked(
          {
            pass: false,
            guard: 'output_policy',
            outcome: 'guard_output_policy',
            reason: 'OUTPUT_POLICY',
          },
          decision.topic,
        ),
      };
    }
    return { ...shown, verdict: 'WOULD_SEND' };
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
      await recordMutationDenial(
        { guard: this.deps.guard, audit: this.deps.audit, opsLog: this.deps.opsLog },
        scope,
        actor,
        permission,
        denial,
        error,
      );
      throw error;
    }
  }
}
