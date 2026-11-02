import {
  BUSINESS_ESCALATION_SUMMARY_MAX,
  SUPPORT_AI_TEMPLATE_KEYS,
  parseSupportAiCallbackData,
  type Clock,
  type ScopeContext,
  type TemplateKey,
  type UnitOfWork,
} from '@nexa/contracts';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { BusinessConversationService } from '../../../commerce/business-chats/application/business-conversation.service.js';
import type {
  BusinessConnectionRepository,
  BusinessConversationRepository,
  BusinessOutboundRepository,
} from '../../../commerce/business-chats/application/ports.js';
import type { ParsedBusinessCallback } from '../../../commerce/business-chats/domain/telegram-business.js';
import type { DrizzleSupportAiJobRepository } from '../infrastructure/drizzle-support-ai-job.repository.js';

export interface SupportAiCallbackDeps {
  readonly outbound: Pick<BusinessOutboundRepository, 'findById' | 'recordFeedback'>;
  readonly conversations: Pick<BusinessConversationRepository, 'lockById'>;
  readonly connections: Pick<BusinessConnectionRepository, 'findById'>;
  readonly jobs: Pick<DrizzleSupportAiJobRepository, 'autoJobOfOutbound'>;
  readonly control: Pick<BusinessConversationService, 'handOff'>;
  /** Answers the tap (`answerCallbackQuery`) with a templated notice. */
  readonly acknowledge: (
    scope: ScopeContext,
    input: {
      readonly botInstanceId: string;
      readonly callbackQueryId: string;
      readonly toastKey: TemplateKey;
    },
  ) => Promise<void>;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly scopeActivity: ScopeActivityReader;
  readonly clock: Clock;
}

/** What one tap came to (the tests read it; the customer reads the notice). */
export type SupportAiCallbackResult =
  'REFUSED' | 'FEEDBACK_UP' | 'FEEDBACK_DOWN' | 'HUMAN' | 'ALREADY_WITH_PERSON' | 'INACTIVE';

/**
 * Phase 4 PR-3 — the support AI's own buttons under an automatic Business message:
 * «👤 پشتیبان انسانی» (a HARD handoff), and «مشکل حل شد؟» 👍 / 👎 (👎: a SOFT handoff, recorded with
 * the answer's topic and intent — the knowledge-gap entry; under check-before-handoff's
 * delivered link: HARD, as the owner's rule says).
 *
 * The callback data names a lane row (`sai:<a>:<row id>`) and is NOT an authority: a client can
 * send any data with a tap. A tap is accepted only when ALL of these are true of the row it names:
 * an automatic row, delivered, whose Telegram message IS the tapped message, in the tapped chat,
 * on the tapped business connection, of this bot, tapped by that chat's own customer. Data forged
 * for another chat's row — or a row of this chat on another message — is refused with a notice,
 * and nothing is written. Every write is a conditional one in a transaction that reads scope
 * activity first; a stopped tenant writes nothing.
 */
export class SupportAiCallbackService {
  constructor(private readonly deps: SupportAiCallbackDeps) {}

  async handle(
    scope: ScopeContext,
    input: { readonly botInstanceId: string; readonly callback: ParsedBusinessCallback },
  ): Promise<SupportAiCallbackResult> {
    const { callback } = input;
    const parsed = parseSupportAiCallbackData(callback.data);
    const keys = SUPPORT_AI_TEMPLATE_KEYS;
    const answer = async (result: SupportAiCallbackResult, key: string) => {
      await this.deps
        .acknowledge(scope, {
          botInstanceId: input.botInstanceId,
          callbackQueryId: callback.callbackQueryId,
          toastKey: key as TemplateKey,
        })
        .catch(() => undefined);
      return result;
    };
    if (parsed === null) return answer('REFUSED', keys.callbackStale);

    const result = await this.deps.uow.run(scope, async (tx): Promise<SupportAiCallbackResult> => {
      if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) return 'INACTIVE';
      const now = this.deps.clock.now();
      const row = await this.deps.outbound.findById(scope, parsed.rowId, tx);
      if (row === null || row.origin !== 'AUTO' || row.state !== 'DELIVERED') return 'REFUSED';
      if (row.telegramMessageId === null || row.telegramMessageId !== callback.messageId) {
        return 'REFUSED';
      }
      const conversation = await this.deps.conversations.lockById(scope, row.conversationId, tx);
      if (
        conversation === null ||
        conversation.botInstanceId !== input.botInstanceId ||
        conversation.chatId !== callback.chatId ||
        conversation.peerTelegramUserId !== callback.fromUserId
      ) {
        return 'REFUSED';
      }
      const connection = await this.deps.connections.findById(
        scope,
        conversation.connectionRowId,
        tx,
      );
      if (connection === null || connection.connectionId !== callback.connectionId) {
        return 'REFUSED';
      }

      if (parsed.action === 'yes') {
        await this.deps.outbound.recordFeedback(scope, row.id, 'UP', now, tx);
        return 'FEEDBACK_UP';
      }
      if (parsed.action === 'no') {
        const first = await this.deps.outbound.recordFeedback(scope, row.id, 'DOWN', now, tx);
        // A repeated 👎, or one under a message of an earlier epoch: recorded once, no handoff.
        if (
          !first ||
          conversation.state !== 'AI_ACTIVE' ||
          conversation.controlEpoch !== row.controlEpoch
        ) {
          return 'FEEDBACK_DOWN';
        }
        const job = await this.deps.jobs.autoJobOfOutbound(scope, row.id, tx);
        const delivered = job?.outcome === 'sent_payment_delivered';
        await this.deps.control.handOff(
          scope,
          conversation.id,
          delivered ? 'HANDOFF_TOPIC' : 'CUSTOMER_UNSATISFIED',
          now,
          tx,
          {
            summary:
              job?.summary === null || job?.summary === undefined || job.summary.trim() === ''
                ? null
                : job.summary.slice(0, BUSINESS_ESCALATION_SUMMARY_MAX),
            jobId: job?.id ?? null,
            topic: job?.topic ?? null,
            intent: job?.intent ?? null,
            kind: delivered ? 'HARD' : 'SOFT',
          },
        );
        return 'FEEDBACK_DOWN';
      }
      // «👤 پشتیبان انسانی»: a HARD handoff, from any message of this chat while the AI holds it.
      if (conversation.state !== 'AI_ACTIVE') return 'ALREADY_WITH_PERSON';
      await this.deps.control.handOff(scope, conversation.id, 'HUMAN_REQUESTED', now, tx, {
        summary: null,
        jobId: null,
        topic: 'HUMAN_REQUESTED',
        kind: 'HARD',
      });
      return 'HUMAN';
    });

    switch (result) {
      case 'FEEDBACK_UP':
        return answer(result, keys.feedbackThanks);
      case 'FEEDBACK_DOWN':
        return answer(result, keys.feedbackHandoff);
      case 'HUMAN':
      case 'ALREADY_WITH_PERSON':
        return answer(result, keys.humanRequested);
      default:
        return answer(result, keys.callbackStale);
    }
  }
}
