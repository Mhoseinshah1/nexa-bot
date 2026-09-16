import {
  telegramGetMe,
  telegramSetWebhook,
  telegramSetMyCommands,
} from '../../../../infrastructure/telegram/send-message.js';
import { BOT_COMMANDS } from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';
import type {
  BotBootstrapTelegram,
  BotIdentityProbe,
  WebhookRegistration,
} from '../application/ports.js';

/**
 * The bootstrap's two Telegram calls, over the SHARED call core.
 *
 * Not a second HTTP client. Everything that makes a Telegram call safe here —
 * the abort timeout, `redirect: 'error'` because the token is in the request
 * path, never throwing, and `assertOutsideTransaction` — is decided once in
 * `infrastructure/telegram/send-message.ts` and inherited. `CLAUDE.md` records
 * what the alternative costs: "There is one probe implementation. Never copy it;
 * the copy that would silently keep the old behaviour is the unattended one."
 *
 * What this adapter DOES own is the translation. The transport answers in its
 * own vocabulary — retryable, permanent, 429, an unreadable 2xx — and the
 * application layer asks a question about a bot. Collapsing one into the other
 * is this file's whole job, and doing it here rather than in the service is what
 * keeps the service from having to know that a 429 and a 502 are the same
 * instruction to an operator.
 */
export class TelegramBotBootstrapGateway implements BotBootstrapTelegram {
  constructor(
    private readonly apiBaseUrl: string,
    private readonly timeoutMs: number,
  ) {}

  async identify(token: string): Promise<BotIdentityProbe> {
    const outcome = await telegramGetMe({
      token,
      apiBaseUrl: this.apiBaseUrl,
      timeoutMs: this.timeoutMs,
    });

    switch (outcome.outcome) {
      case 'SUCCEEDED':
        return {
          outcome: 'IDENTIFIED',
          botId: outcome.identity.botId,
          username: outcome.identity.username,
        };
      /*
       * PERMANENT is REJECTED: Telegram read the token and said no.
       *
       * The 401 that a revoked token produces arrives here, and so does a 2xx
       * that did not describe a bot — which means the configured API base is not
       * Telegram. Both are fixed by changing configuration rather than by
       * waiting, which is the distinction the two codes exist to draw.
       */
      case 'FAILED_PERMANENT':
        return { outcome: 'REJECTED', detail: outcome.errorMessage };
      /*
       * Everything else is UNREACHABLE, 429 included.
       *
       * A rate limit is not a rejected token: the credential is fine and the
       * remedy is to rerun. Filing it as REJECTED would tell an operator to go
       * and mint a new token, which is the wrong afternoon.
       */
      default:
        return { outcome: 'UNREACHABLE', detail: outcome.errorMessage };
    }
  }

  async registerWebhook(input: {
    readonly token: string;
    readonly url: string;
    readonly secretToken: string;
    readonly dropPendingUpdates: boolean;
  }): Promise<WebhookRegistration> {
    const outcome = await telegramSetWebhook({
      token: input.token,
      apiBaseUrl: this.apiBaseUrl,
      timeoutMs: this.timeoutMs,
      url: input.url,
      secretToken: input.secretToken,
      dropPendingUpdates: input.dropPendingUpdates,
    });

    switch (outcome.outcome) {
      case 'SUCCEEDED':
        return { outcome: 'REGISTERED' };
      // Telegram looked at the URL and refused it — not https, a port it does
      // not accept, a name it cannot resolve. Rerunning changes nothing until
      // the URL does.
      case 'FAILED_PERMANENT':
        return { outcome: 'REFUSED', detail: outcome.errorMessage };
      default:
        return { outcome: 'UNREACHABLE', detail: outcome.errorMessage };
    }
  }

  /**
   * Registers the command menu. Answers whether it landed; never throws.
   *
   * Separate from `registerWebhook` and deliberately weaker: a failed webhook means
   * updates do not arrive and the install is INCOMPLETE, while a failed command menu
   * means a customer types `/help` instead of tapping it. Reporting the second as
   * gravely as the first would send an operator to look for a problem they do not have.
   */
  async registerCommands(input: { readonly token: string }): Promise<boolean> {
    /*
     * Rendered HERE, from the frozen list and the shared catalogue.
     *
     * The application layer decides whether to register and this decides what the text
     * says, which is the split `check:boundaries` enforces: a domain or application file
     * importing `@nexa/i18n` is refused by name. The defaults are the right source —
     * this runs while the tenant is being created, so there is no override to read.
     */
    const outcome = await telegramSetMyCommands({
      token: input.token,
      apiBaseUrl: this.apiBaseUrl,
      timeoutMs: this.timeoutMs,
      commands: BOT_COMMANDS.map((entry) => ({
        command: entry.command,
        description: CATALOGUE_FA[entry.description],
      })),
    });
    return outcome.outcome === 'SUCCEEDED';
  }
}
