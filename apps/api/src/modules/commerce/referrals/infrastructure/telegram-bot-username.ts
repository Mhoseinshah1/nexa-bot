import type { BotInstanceId, ScopeContext } from '@nexa/contracts';
import { telegramGetMe } from '../../../../infrastructure/telegram/send-message.js';

/** The one thing this adapter needs from the bot rows: the token of an ACTIVE bot. */
export interface BotTokenSource {
  tokenForBotInstance(scope: ScopeContext, botInstanceId: BotInstanceId): Promise<string | null>;
}

/**
 * A bot's username, as Telegram's `getMe` answers it now.
 *
 * The stored `bot_instances.username` is what the bootstrap recorded and goes stale when
 * the bot is renamed in BotFather; a referral link is the one place a customer is handed
 * that name to pass on, so it is asked of Telegram rather than read from the row. Any
 * answer other than a well-formed identity — no usable token, a rejection, a timeout —
 * is null, and the caller offers no link. The token never leaves this function.
 */
export class TelegramBotUsernames {
  constructor(
    private readonly deps: {
      readonly bots: BotTokenSource;
      readonly apiBaseUrl: string;
      readonly timeoutMs: number;
    },
  ) {}

  async liveUsername(scope: ScopeContext, botInstanceId: BotInstanceId): Promise<string | null> {
    const token = await this.deps.bots.tokenForBotInstance(scope, botInstanceId);
    if (token === null) return null;
    const outcome = await telegramGetMe({
      token,
      apiBaseUrl: this.deps.apiBaseUrl,
      timeoutMs: this.deps.timeoutMs,
    });
    return outcome.outcome === 'SUCCEEDED' ? outcome.identity.username : null;
  }
}
