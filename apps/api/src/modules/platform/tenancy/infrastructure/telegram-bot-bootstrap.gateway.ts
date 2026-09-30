import {
  telegramDeleteWebhook,
  telegramGetMe,
  telegramGetMyCommands,
  telegramGetWebhookInfo,
  telegramSetWebhook,
  telegramSetMyCommands,
} from '../../../../infrastructure/telegram/send-message.js';
import type { BotCommandEntry } from '@nexa/contracts';
import type {
  BotBootstrapTelegram,
  BotCommandsRead,
  BotCommandsRegistration,
  BotIdentityProbe,
  WebhookRegistration,
} from '../application/ports.js';
import type {
  BotManagementTelegram,
  BotWebhookRead,
  BotWebhookRemoval,
} from '../application/bot-management-ports.js';
import type { BotCommandSyncTelegram } from '../application/bot-command-sync-ports.js';

/**
 * The bootstrap's, bot management's and the command-sync lane's Telegram calls, over the
 * SHARED call core.
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
export class TelegramBotBootstrapGateway
  implements BotBootstrapTelegram, BotManagementTelegram, BotCommandSyncTelegram
{
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
          isBot: outcome.identity.isBot,
        };
      /*
       * PERMANENT splits, and the field that splits it was already here.
       *
       * Two causes land in `FAILED_PERMANENT`: the 401 a revoked token produces,
       * and a 2xx that did not describe a bot — which means the configured API
       * base is not Telegram. This used to answer `REJECTED` for both, and the
       * service turns `REJECTED` into "Telegram rejected the bot token", so a
       * misconfigured `TELEGRAM_API_BASE_URL` sent the operator to BotFather to
       * reissue a credential that was never the problem (`OQ-TG-04` items 6 and
       * 7). `telegramGetMe` has always reported the difference; the loss was
       * here, in the translation this class exists to do.
       *
       * Keyed on the exact code, not a prefix or a substring of the message. A
       * message is written for a person and can be reworded; `getme_shape` is
       * the one value that means this and is set in one place.
       */
      case 'FAILED_PERMANENT':
        return outcome.errorCode === 'telegram.rejected.getme_shape'
          ? { outcome: 'NOT_TELEGRAM', detail: outcome.errorMessage }
          : { outcome: 'REJECTED', detail: outcome.errorMessage };
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

  /**
   * Read the webhook registration Telegram holds (WP13's live check). A read only.
   *
   * On this class, beside `identify`, so the bot-management port and the bootstrap port
   * share one adapter and one translation. PERMANENT is `REJECTED` — the token was
   * refused or the answer was not a `WebhookInfo` — and everything else, 429 included,
   * is `UNREACHABLE`, for the reason `identify` gives.
   */
  async readWebhook(token: string): Promise<BotWebhookRead> {
    const outcome = await telegramGetWebhookInfo({
      token,
      apiBaseUrl: this.apiBaseUrl,
      timeoutMs: this.timeoutMs,
    });
    switch (outcome.outcome) {
      case 'SUCCEEDED':
        return { outcome: 'READ', ...outcome.info };
      case 'FAILED_PERMANENT':
        return { outcome: 'REJECTED' };
      default:
        return { outcome: 'UNREACHABLE' };
    }
  }

  async registerWebhook(input: {
    readonly token: string;
    readonly url: string;
    readonly secretToken: string;
    readonly dropPendingUpdates: boolean;
    readonly resetAllowedUpdates?: boolean;
  }): Promise<WebhookRegistration> {
    const outcome = await telegramSetWebhook({
      token: input.token,
      apiBaseUrl: this.apiBaseUrl,
      timeoutMs: this.timeoutMs,
      url: input.url,
      secretToken: input.secretToken,
      dropPendingUpdates: input.dropPendingUpdates,
      // An empty list is the Bot API's reset to its default set (R4); omitted, Telegram
      // keeps whatever list the previous registration had.
      ...(input.resetAllowedUpdates === true ? { allowedUpdates: [] } : {}),
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
   * Remove the webhook, keeping whatever Telegram has queued (R4's compensation).
   *
   * PERMANENT is `REFUSED` and everything else `UNREACHABLE`, the split `registerWebhook`
   * makes: an unanswered `deleteWebhook` may or may not have taken effect, and the caller
   * reads the registration back rather than assuming either.
   */
  async removeWebhook(token: string): Promise<BotWebhookRemoval> {
    const outcome = await telegramDeleteWebhook({
      token,
      apiBaseUrl: this.apiBaseUrl,
      timeoutMs: this.timeoutMs,
      dropPendingUpdates: false,
    });
    switch (outcome.outcome) {
      case 'SUCCEEDED':
        return { outcome: 'REMOVED' };
      case 'FAILED_PERMANENT':
        return { outcome: 'REFUSED' };
      default:
        return { outcome: 'UNREACHABLE' };
    }
  }

  /**
   * Registers a command menu. Never throws; the caller decides what a failure weighs.
   *
   * Round P: the list is a PARAMETER, rendered by `CommandMenu` through the tenant's own
   * templates. This adapter no longer renders or digests anything — a second renderer here
   * would be a second answer to "what is the menu", and the digest stored in
   * `commands_revision` is of what was actually sent. PERMANENT is `REFUSED` (the token,
   * or a list Telegram will not take: an empty description, a bad command name) and
   * everything else `UNREACHABLE`, the split `registerWebhook` makes. The CODE is kept
   * for the lane's diagnostics; the description is not, because Telegram's errors quote
   * the request URL and the token is a segment of it.
   */
  async registerCommands(input: {
    readonly token: string;
    readonly commands: readonly BotCommandEntry[];
  }): Promise<BotCommandsRegistration> {
    const outcome = await telegramSetMyCommands({
      token: input.token,
      apiBaseUrl: this.apiBaseUrl,
      timeoutMs: this.timeoutMs,
      commands: input.commands,
    });
    switch (outcome.outcome) {
      case 'SUCCEEDED':
        return { outcome: 'REGISTERED' };
      case 'FAILED_PERMANENT':
        return { outcome: 'REFUSED', code: outcome.errorCode };
      default:
        return {
          outcome: 'UNREACHABLE',
          code: outcome.errorCode,
          // A 429's hold, in ms, when Telegram named one. The lane's back-off honours it.
          ...(outcome.retryAfterMs === undefined ? {} : { retryAfterMs: outcome.retryAfterMs }),
        };
    }
  }

  /** Reads the registered command menu (`getMyCommands`). A read; the same split as `readWebhook`. */
  async readCommands(token: string): Promise<BotCommandsRead> {
    const outcome = await telegramGetMyCommands({
      token,
      apiBaseUrl: this.apiBaseUrl,
      timeoutMs: this.timeoutMs,
    });
    switch (outcome.outcome) {
      case 'SUCCEEDED':
        return { outcome: 'READ', commands: outcome.commands };
      case 'FAILED_PERMANENT':
        return { outcome: 'REJECTED' };
      default:
        return { outcome: 'UNREACHABLE' };
    }
  }
}
