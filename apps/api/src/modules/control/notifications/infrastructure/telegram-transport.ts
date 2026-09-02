import type { NotificationTransportKind, ScopeContext, TenantId } from '@nexa/contracts';
import { asId } from '@nexa/contracts';
import type {
  NotificationTransport,
  OutboundMessage,
  TransportResult,
} from '../application/ports.js';

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

    const body: Record<string, unknown> = {
      chat_id: message.destination.chatId,
      text: message.text,
      // Telegram's current field. `disable_web_page_preview` is deprecated in
      // favour of the structured `link_preview_options`, and a deprecated
      // parameter is one release away from being ignored — at which point an
      // operational alert quoting a URL would start rendering a preview card
      // in the administrators' group with no code change to explain it.
      link_preview_options: { is_disabled: true },
    };
    if (message.destination.topicId !== null) {
      body.message_thread_id = message.destination.topicId;
    }
    // The template's declared format decides this, per key. UNK-TXT-002 records
    // that the legacy renderer's HTML contract is unstated and contradictory;
    // we do not have one global answer either.
    if (message.html) body.parse_mode = 'HTML';

    return this.post(token, body);
  }

  private async post(token: string, body: Record<string, unknown>): Promise<TransportResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.apiBaseUrl}/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
        // Never follow a redirect. The bot token is in the request PATH, so a
        // 30x from the configured base to an http:// or third-party location
        // would hand the credential straight over — and the production https
        // rule in the config schema binds only the FIRST hop. Telegram's API
        // does not redirect; anything that does is not Telegram.
        redirect: 'error',
      });

      // A body that will not parse is kept DISTINCT from a body that parsed
      // and said no. Collapsing them to `{}` lost the difference, and the
      // difference decides an outcome: a 2xx whose body was truncated fell
      // through to the permanent-rejection branch as `telegram.rejected.200`,
      // so a message Telegram had accepted — and very likely delivered — was
      // recorded as permanently failed after one attempt, which is the exact
      // shape of failure this module keeps being corrected for.
      let payload: {
        ok?: boolean;
        description?: string;
        error_code?: number;
        parameters?: { retry_after?: number };
      } | null;
      try {
        payload = (await response.json()) as typeof payload;
      } catch {
        payload = null;
      }

      if (response.ok && payload?.ok === true) return { outcome: 'SUCCEEDED' };

      if (payload === null && response.ok) {
        // Accepted, and we cannot read what it said. RETRYABLE, because the
        // send may well have landed: the dedupe key and the attempt ceiling
        // bound the cost of trying again, and nothing bounds the cost of
        // filing a delivered message as permanently failed.
        return {
          outcome: 'FAILED_RETRYABLE',
          errorCode: 'telegram.unreadable_response',
          errorMessage: `HTTP ${response.status} with a body that could not be parsed.`,
        };
      }

      const description = payload?.description ?? `HTTP ${response.status}`;
      const retryAfter = payload?.parameters?.retry_after;

      // 429 is the one Telegram tells us how to handle. Honour what it asked
      // for; a back-off we invented would either be rude or too slow.
      if (response.status === 429) {
        return {
          outcome: 'FAILED_RETRYABLE',
          errorCode: 'telegram.rate_limited',
          errorMessage: description,
          ...(retryAfter !== undefined ? { retryAfterMs: retryAfter * 1000 } : {}),
        };
      }

      // 5xx is Telegram's problem and usually passes. 4xx is ours — a bad chat
      // id, a bot that is not a member, a malformed parse mode — and retrying it
      // forever produces the legacy log group's repeated-identical-error pattern
      // with a scheduler in front of it.
      if (response.status >= 500) {
        return {
          outcome: 'FAILED_RETRYABLE',
          errorCode: `telegram.server_error.${response.status}`,
          errorMessage: description,
        };
      }

      return {
        outcome: 'FAILED_PERMANENT',
        errorCode: `telegram.rejected.${payload?.error_code ?? response.status}`,
        errorMessage: description,
      };
    } catch (error) {
      // A timeout or a socket failure. The message may or may not have arrived,
      // which is exactly why the intent carries a dedupe key and the attempt is
      // recorded either way.
      return {
        outcome: 'FAILED_RETRYABLE',
        errorCode: 'telegram.unreachable',
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
