import type { NotificationTransportKind, ScopeContext, TenantId } from '@nexa/contracts';
import { asId } from '@nexa/contracts';
import type {
  NotificationTransport,
  OutboundMessage,
  TransportResult,
} from '../application/ports.js';
import { telegramSend, textMessageBody } from '../../../../infrastructure/telegram/send-message.js';

/**
 * Where the sending credential comes from.
 *
 * Narrow on purpose: this transport needs one token and must not acquire the
 * ability to read anything else about a bot instance.
 */
export interface BotTokenSource {
  activeTokenForTenant(scope: ScopeContext): Promise<string | null>;
}

/**
 * Sends an operational message through the tenant's Telegram bot.
 *
 * A real sender. Operational notifications go to the people running the
 * installation, over a bot this installation already owns, so nothing here needs
 * any of the customer-facing Telegram functionality that later phases will
 * build. What it deliberately does NOT do is anything else: no keyboards, no
 * conversations, no customer messaging.
 *
 * Rate limits are treated as real even though no phase of the investigation
 * found any handling of them in the legacy system — every phase was UI-only, so
 * that is NOT_EXPOSED rather than proven absent, and a 429 is not a reason to
 * find out the hard way. A `retry_after` from Telegram is honoured verbatim in
 * preference to any back-off we would have computed.
 */
export class TelegramNotificationTransport implements NotificationTransport {
  readonly kind: NotificationTransportKind = 'TELEGRAM';

  constructor(
    private readonly bots: BotTokenSource,
    private readonly apiBaseUrl: string,
    private readonly timeoutMs: number,
  ) {}

  async send(message: OutboundMessage): Promise<TransportResult> {
    // The dispatcher commits its claim before calling this, on purpose, and
    // `telegramSend` asserts it — see `transaction-boundary.ts`: a send inside the
    // claim transaction could be rolled back after Telegram had already delivered.
    if (message.destination.transport !== 'TELEGRAM') {
      return {
        outcome: 'FAILED_PERMANENT',
        errorCode: 'transport.mismatch',
        errorMessage: `A Telegram transport was handed a ${message.destination.transport} destination.`,
      };
    }

    const scope: ScopeContext = {
      tenantId: asId<'TenantId'>(message.tenantId) as TenantId,
      botInstanceId: null,
    };

    let token: string;
    try {
      const bot = await this.bots.activeTokenForTenant(scope);
      if (bot === null) {
        // No bot is configured for this tenant. Permanent: retrying cannot
        // conjure one, and the operator needs to be told rather than have the
        // queue quietly grow.
        return {
          outcome: 'FAILED_PERMANENT',
          errorCode: 'telegram.no_bot_configured',
          errorMessage: 'This tenant has no active bot instance to send from.',
        };
      }
      token = bot;
    } catch (error) {
      return {
        outcome: 'FAILED_RETRYABLE',
        errorCode: 'telegram.token_unavailable',
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }

    // Built by the shared helper, so the customer-facing sender and this one cannot
    // disagree about `link_preview_options` or `parse_mode`. The template's declared
    // format decides the HTML flag, per key: UNK-TXT-002 records that the legacy
    // renderer's HTML contract is unstated and contradictory, and we do not have one
    // global answer either.
    const body = textMessageBody({
      chatId: message.destination.chatId,
      text: message.text,
      html: message.html,
    });
    if (message.destination.topicId !== null) {
      body.message_thread_id = message.destination.topicId;
    }

    const result = await telegramSend({
      token,
      apiBaseUrl: this.apiBaseUrl,
      timeoutMs: this.timeoutMs,
      body,
    });
    // The transport's own result shape carries no message id, so it is dropped here
    // rather than widened: a notification's identity is its row, and an operations
    // message nobody replies to has no use for Telegram's id.
    return result.outcome === 'SUCCEEDED' ? { outcome: 'SUCCEEDED' } : result;
  }
}
