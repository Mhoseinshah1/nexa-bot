import { assertOutsideTransaction } from '../transaction-boundary.js';

/**
 * The ONE `sendMessage` call this installation makes.
 *
 * Extracted from `TelegramNotificationTransport`, which had the only correct version
 * of it, because Phase 4 needs a second caller — customer-facing replies — and
 * `CLAUDE.md` already records what happens when a path like this is copied instead of
 * shared: "There is one probe implementation. Never copy it; the copy that would
 * silently keep the old behaviour is the unattended one."
 *
 * Everything subtle here was learned by that module and is preserved verbatim:
 *
 * - `redirect: 'error'`. The bot token is in the request PATH, so a 30x from the
 *   configured base to an `http://` or third-party location would hand the credential
 *   over, and the production-https rule in the config schema binds only the FIRST hop.
 *   Telegram does not redirect; anything that does is not Telegram.
 * - A body that will not parse is kept DISTINCT from a body that parsed and said no.
 *   Collapsing them lost a difference that decides an outcome: a 2xx with a truncated
 *   body is a message Telegram very likely delivered, and filing it as permanently
 *   failed is the shape of failure that module kept being corrected for.
 * - 429 is honoured with Telegram's own `retry_after`. A back-off we invented would be
 *   either rude or too slow.
 * - 5xx is retryable and 4xx is not. Retrying a bad chat id for ever reproduces the
 *   legacy log group's repeated-identical-error pattern with a scheduler in front.
 */
export type TelegramSendOutcome =
  | { readonly outcome: 'SUCCEEDED'; readonly messageId: number | null }
  | {
      readonly outcome: 'FAILED_RETRYABLE';
      readonly errorCode: string;
      readonly errorMessage: string;
      readonly retryAfterMs?: number;
    }
  | {
      readonly outcome: 'FAILED_PERMANENT';
      readonly errorCode: string;
      readonly errorMessage: string;
    };

export interface TelegramSendRequest {
  readonly token: string;
  readonly apiBaseUrl: string;
  readonly timeoutMs: number;
  readonly body: Record<string, unknown>;
  /**
   * Which Telegram method. `sendMessage` for everything in this release; named rather
   * than hard-coded so a later caller does not fork the whole function to send a
   * document.
   */
  readonly method?: string;
}

export async function telegramSend(request: TelegramSendRequest): Promise<TelegramSendOutcome> {
  // The caller commits before calling, always. A send inside a transaction could be
  // rolled back after Telegram had already delivered — and the customer would have a
  // message about a purchase that does not exist.
  assertOutsideTransaction('A Telegram send');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);
  try {
    const response = await fetch(
      `${request.apiBaseUrl}/bot${request.token}/${request.method ?? 'sendMessage'}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request.body),
        signal: controller.signal,
        redirect: 'error',
      },
    );

    let payload: {
      ok?: boolean;
      result?: { message_id?: number };
      description?: string;
      error_code?: number;
      parameters?: { retry_after?: number };
    } | null;
    try {
      payload = (await response.json()) as typeof payload;
    } catch {
      payload = null;
    }

    if (response.ok && payload?.ok === true) {
      return { outcome: 'SUCCEEDED', messageId: payload.result?.message_id ?? null };
    }

    if (payload === null && response.ok) {
      return {
        outcome: 'FAILED_RETRYABLE',
        errorCode: 'telegram.unreadable_response',
        errorMessage: `HTTP ${response.status} with a body that could not be parsed.`,
      };
    }

    const description = payload?.description ?? `HTTP ${response.status}`;
    const retryAfter = payload?.parameters?.retry_after;

    if (response.status === 429) {
      return {
        outcome: 'FAILED_RETRYABLE',
        errorCode: 'telegram.rate_limited',
        errorMessage: description,
        ...(retryAfter !== undefined ? { retryAfterMs: retryAfter * 1000 } : {}),
      };
    }

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
    return {
      outcome: 'FAILED_RETRYABLE',
      errorCode: 'telegram.unreachable',
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The body of a customer-facing text message.
 *
 * `link_preview_options` rather than the deprecated `disable_web_page_preview`, for the
 * reason the notification transport gives: a deprecated parameter is one release away
 * from being ignored, and the failure would be a preview card appearing with no code
 * change to explain it.
 */
export function textMessageBody(input: {
  readonly chatId: string;
  readonly text: string;
  readonly html: boolean;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    chat_id: input.chatId,
    text: input.text,
    link_preview_options: { is_disabled: true },
  };
  if (input.html) body.parse_mode = 'HTML';
  return body;
}
