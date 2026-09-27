import type { ScopeContext, TemplateKey, TenantContext } from '@nexa/contracts';
import { telegramAnswerPreCheckoutQuery } from '../../../../infrastructure/telegram/send-message.js';
import type { StarsCheckoutAnswerer } from '../application/telegram-stars-payment.service.js';

/**
 * Answers a Stars pre-checkout query with the token of the bot that received it.
 *
 * The refusal is the tenant's rendered `bot.payment.stars_precheckout_refused` — one
 * sentence for every reason. Never throws: a query left unanswered is cancelled by
 * Telegram after ten seconds, which is the same outcome as a refusal, and the webhook
 * must still answer 2xx.
 */
export class TelegramStarsCheckoutAnswerer implements StarsCheckoutAnswerer {
  constructor(
    private readonly templates: {
      render(scope: ScopeContext, key: TemplateKey, values: Record<string, never>): Promise<string>;
    },
    private readonly bots: {
      tokenForBotInstance(scope: ScopeContext, botInstanceId: string): Promise<string | null>;
    },
    private readonly apiBaseUrl: string,
    private readonly timeoutMs: number,
    private readonly answer_ = telegramAnswerPreCheckoutQuery,
  ) {}

  async answer(
    scope: TenantContext,
    botInstanceId: string,
    queryId: string,
    ok: boolean,
  ): Promise<boolean> {
    try {
      const token = await this.bots.tokenForBotInstance(scope, botInstanceId);
      if (token === null) return false;
      const errorMessage = ok
        ? null
        : await this.templates.render(scope, 'bot.payment.stars_precheckout_refused', {});
      const sent = await this.answer_({
        token,
        apiBaseUrl: this.apiBaseUrl,
        timeoutMs: this.timeoutMs,
        preCheckoutQueryId: queryId,
        ok,
        errorMessage,
      });
      return sent.outcome === 'SUCCEEDED';
    } catch {
      return false;
    }
  }
}
