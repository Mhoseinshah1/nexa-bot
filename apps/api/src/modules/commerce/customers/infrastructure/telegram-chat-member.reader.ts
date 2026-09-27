import type { BotInstanceId, ScopeContext, TenantContext } from '@nexa/contracts';
import { telegramGetChatMember } from '../../../../infrastructure/telegram/send-message.js';
import {
  membershipOf,
  type ChannelMembershipAnswer,
  type ChatMemberReader,
} from '../application/channel-membership.service.js';

/** The one thing this adapter needs from the bot rows: the token of an ACTIVE bot. */
export interface BotTokenSource {
  tokenForBotInstance(scope: ScopeContext, botInstanceId: BotInstanceId): Promise<string | null>;
}

/**
 * `getChatMember` through the RECEIVING bot's own token (Package B, audit §2.2).
 *
 * Every failure is UNKNOWN, carrying Telegram's error code for the operator: a bot that is
 * not an administrator of the channel (403), a chat that does not exist (400), a timeout, a
 * 5xx or a 429. None of them is Telegram saying the customer left, so none of them may stop
 * a customer. The token never leaves this function and is never logged.
 */
export class TelegramChatMemberReader implements ChatMemberReader {
  constructor(
    private readonly deps: {
      readonly bots: BotTokenSource;
      readonly apiBaseUrl: string;
      readonly timeoutMs: number;
      readonly call?: typeof telegramGetChatMember;
    },
  ) {}

  async read(
    scope: TenantContext,
    input: {
      readonly botInstanceId: string;
      readonly chatId: string;
      readonly telegramUserId: string;
    },
  ): Promise<ChannelMembershipAnswer> {
    const token = await this.deps.bots.tokenForBotInstance(
      scope,
      input.botInstanceId as BotInstanceId,
    );
    if (token === null) return { kind: 'UNKNOWN', code: 'nexa.bot_token_unavailable' };
    const call = this.deps.call ?? telegramGetChatMember;
    const outcome = await call({
      token,
      apiBaseUrl: this.deps.apiBaseUrl,
      timeoutMs: this.deps.timeoutMs,
      chatId: input.chatId,
      userId: input.telegramUserId,
    });
    if (outcome.outcome !== 'SUCCEEDED') return { kind: 'UNKNOWN', code: outcome.errorCode };
    return membershipOf(outcome.member);
  }
}
