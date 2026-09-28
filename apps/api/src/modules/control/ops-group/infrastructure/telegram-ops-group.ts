import type { BotInstanceId, OpsLogGroupProblem, ScopeContext } from '@nexa/contracts';
import {
  chatAccessProblemOf,
  isMissingForumTopicError,
  telegramCreateForumTopic,
  telegramGetChat,
  telegramGetChatMember,
  telegramGetMe,
  telegramSend,
  textMessageBody,
  type TelegramSendOutcome,
} from '../../../../infrastructure/telegram/send-message.js';
import type { BotInstanceRepository } from '../../../platform/tenancy/application/ports.js';
import type { OpsGroupBots, OpsGroupTelegram, OpsTelegramFailure } from '../application/ports.js';

/** A shared-taxonomy failure, as the ops group reads it: retryable, or an answer. */
function failure(
  outcome: Exclude<TelegramSendOutcome, { outcome: 'SUCCEEDED' }>,
): OpsTelegramFailure {
  return {
    outcome: 'FAILED',
    retryable: outcome.outcome === 'FAILED_RETRYABLE',
    errorCode: outcome.errorCode,
    errorMessage: outcome.errorMessage,
  };
}

/**
 * The ops group's Telegram calls, over the ONE call core in `send-message.ts` — so the
 * abort timeout, `redirect: 'error'` (the token is in the path) and the
 * retryable/permanent taxonomy are inherited rather than copied.
 */
export class TelegramOpsGroup implements OpsGroupTelegram {
  constructor(
    private readonly apiBaseUrl: string,
    private readonly timeoutMs: number,
  ) {}

  private base(token: string) {
    return { token, apiBaseUrl: this.apiBaseUrl, timeoutMs: this.timeoutMs };
  }

  async botIdentity(token: string) {
    const result = await telegramGetMe(this.base(token));
    return result.outcome === 'SUCCEEDED'
      ? { outcome: 'OK' as const, botId: result.identity.botId }
      : failure(result);
  }

  async describeChat(token: string, chatId: string) {
    const result = await telegramGetChat({ ...this.base(token), chatId });
    return result.outcome === 'SUCCEEDED'
      ? { outcome: 'OK' as const, ...result.chat }
      : failure(result);
  }

  async botMembership(token: string, chatId: string, botUserId: string) {
    const result = await telegramGetChatMember({ ...this.base(token), chatId, userId: botUserId });
    return result.outcome === 'SUCCEEDED'
      ? {
          outcome: 'OK' as const,
          status: result.member.status,
          canManageTopics: result.member.canManageTopics,
          canSendMessages: result.member.canSendMessages,
        }
      : failure(result);
  }

  async createTopic(token: string, chatId: string, name: string) {
    const result = await telegramCreateForumTopic({ ...this.base(token), chatId, name });
    return result.outcome === 'SUCCEEDED'
      ? { outcome: 'OK' as const, threadId: result.messageThreadId }
      : failure(result);
  }

  async send(token: string, chatId: string, threadId: number | null, text: string) {
    const body = textMessageBody({ chatId, text, html: false });
    if (threadId !== null) body.message_thread_id = threadId;
    const result = await telegramSend({ ...this.base(token), body });
    if (result.outcome === 'SUCCEEDED') return { outcome: 'OK' as const };
    const chatProblem: OpsLogGroupProblem | null = chatAccessProblemOf(result.errorMessage);
    return {
      ...failure(result),
      topicMissing: threadId !== null && isMissingForumTopicError(result.errorMessage),
      chatProblem,
    };
  }
}

/** The tenant's bots, as the ops group needs them. Tokens never leave the process. */
export class OpsGroupBotSource implements OpsGroupBots {
  constructor(
    private readonly bots: Pick<BotInstanceRepository, 'listForTenant'> & {
      tokenForBotInstance(scope: ScopeContext, id: BotInstanceId): Promise<string | null>;
    },
  ) {}

  async activeBots(scope: ScopeContext) {
    const all = await this.bots.listForTenant(scope);
    return all
      .filter((bot) => bot.status === 'ACTIVE')
      .map((bot) => ({ id: String(bot.id), username: bot.username }));
  }

  tokenFor(scope: ScopeContext, botInstanceId: string): Promise<string | null> {
    return this.bots.tokenForBotInstance(scope, botInstanceId as BotInstanceId);
  }

  async usernameOf(scope: ScopeContext, botInstanceId: string): Promise<string | null> {
    const all = await this.bots.listForTenant(scope);
    return all.find((bot) => String(bot.id) === botInstanceId)?.username ?? null;
  }
}
