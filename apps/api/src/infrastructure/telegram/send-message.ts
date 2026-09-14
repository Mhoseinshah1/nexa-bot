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

  const call = await telegramCall(request);
  if (call.outcome !== 'SUCCEEDED') return call;
  // The ONE thing a send reads out of a result. `telegramCall` returns the whole
  // `result`; this narrows it, which is why the bootstrap needed its own callers
  // rather than a wider return type here.
  const result = call.result as { message_id?: number } | null;
  return { outcome: 'SUCCEEDED', messageId: result?.message_id ?? null };
}

/**
 * ONE Telegram API call, with the result left intact.
 *
 * Extracted from `telegramSend` rather than copied beside it, and the reason is the
 * rule `probe-core.ts` already records for panel probes: the copy that would silently
 * keep the old behaviour is the one nobody looks at again. Everything that makes this
 * call safe — the abort timeout, `redirect: 'error'` because the token is in the PATH,
 * the retryable/permanent taxonomy, never throwing — is decided here and inherited by
 * every caller.
 *
 * `telegramSend` narrows the result to a message id. The bootstrap needs
 * `result.username` and `result.id` from `getMe`, which is why the success case carries
 * the whole thing rather than a shape chosen for one method.
 *
 * NOT exported for general use: the callers are `telegramSend`, `telegramGetMe` and
 * `telegramSetWebhook`, and a fourth should be a named function here rather than an
 * arbitrary method string passed in from a surface.
 */
type TelegramCallOutcome =
  | { readonly outcome: 'SUCCEEDED'; readonly result: unknown }
  | Exclude<TelegramSendOutcome, { outcome: 'SUCCEEDED' }>;

async function telegramCall(request: TelegramSendRequest): Promise<TelegramCallOutcome> {
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
      // `unknown`, because this function serves every method. Each caller narrows it.
      result?: unknown;
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
      return { outcome: 'SUCCEEDED', result: payload.result ?? null };
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
  /**
   * One inline-keyboard button per row, already labelled.
   *
   * Omitted entirely when there are none. An EMPTY `inline_keyboard` is not the same
   * thing: Telegram accepts it and renders a message carrying a blank attachment, which
   * is a visible artefact for every reply that happens to have no buttons.
   */
  readonly buttons?: readonly { readonly text: string; readonly data: string }[];
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    chat_id: input.chatId,
    text: input.text,
    link_preview_options: { is_disabled: true },
  };
  if (input.html) body.parse_mode = 'HTML';
  if (input.buttons !== undefined && input.buttons.length > 0) {
    body.reply_markup = {
      inline_keyboard: input.buttons.map((button) => [
        { text: button.text, callback_data: button.data },
      ]),
    };
  }
  return body;
}

/**
 * The body of an `answerCallbackQuery` call.
 *
 * No `text`, deliberately. Telegram would show it as a toast, and every message this
 * installation shows a customer comes from the template catalogue — a toast written
 * here would be the one customer-facing string with no key and no tenant override.
 * Its whole job is to stop the button spinning.
 */
export function callbackAnswerBody(input: {
  readonly callbackQueryId: string;
}): Record<string, unknown> {
  return { callback_query_id: input.callbackQueryId };
}

// ---------------------------------------------------------------------------
// The fresh-install bootstrap's two calls
// ---------------------------------------------------------------------------

/**
 * What `getMe` establishes: that the token works, and WHICH bot it belongs to.
 *
 * The numeric `id` is the identity that makes a rerun decidable. A username can be
 * changed in BotFather and a token can be rotated; the id cannot, which is why
 * ADR-0029 makes it the thing `bot_instances.telegram_bot_id` stores and compares.
 */
export interface TelegramBotIdentity {
  readonly botId: string;
  readonly username: string;
}

export type TelegramIdentityOutcome =
  | { readonly outcome: 'SUCCEEDED'; readonly identity: TelegramBotIdentity }
  | Exclude<TelegramSendOutcome, { outcome: 'SUCCEEDED' }>;

/**
 * Ask Telegram who this token belongs to.
 *
 * The bootstrap's FIRST call, before anything is written, because a token Telegram
 * rejects must not reach the database: a stored credential that has never worked is
 * indistinguishable from one that stopped working, and an operator debugging the
 * second would be looking in the wrong place entirely.
 *
 * A 401 arrives here as `FAILED_PERMANENT` with `telegram.rejected.401`, which the
 * caller maps to `TELEGRAM_BOOTSTRAP_TOKEN_REJECTED` — a different remedy from
 * unreachable, and the whole reason those are two codes.
 *
 * `id` is read as a NUMBER and rendered as a decimal string. Telegram bot ids are
 * comfortably inside 2^53 today, but this value is stored and compared for the life of
 * the installation and JSON has one numeric type; a string cannot silently lose a digit.
 */
export async function telegramGetMe(
  request: Omit<TelegramSendRequest, 'body' | 'method'>,
): Promise<TelegramIdentityOutcome> {
  assertOutsideTransaction('A Telegram getMe');

  const call = await telegramCall({ ...request, method: 'getMe', body: {} });
  if (call.outcome !== 'SUCCEEDED') return call;

  const result = call.result as { id?: unknown; username?: unknown } | null;
  const id = result?.id;
  const username = result?.username;

  /*
   * A 2xx that parsed but does not describe a bot.
   *
   * PERMANENT rather than retryable: retrying cannot make a well-formed answer grow
   * the fields it did not have, and the realistic cause is an `apiBaseUrl` pointing at
   * something that is not Telegram — which waiting does not fix.
   */
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || typeof username !== 'string') {
    return {
      outcome: 'FAILED_PERMANENT',
      errorCode: 'telegram.rejected.getme_shape',
      errorMessage: 'getMe answered without a usable numeric id and username.',
    };
  }

  return { outcome: 'SUCCEEDED', identity: { botId: String(id), username } };
}

/**
 * Register the webhook, with the secret every later update is authenticated by.
 *
 * `drop_pending_updates: true`, deliberately. A fresh install has no customers and no
 * conversations; whatever is queued at Telegram predates this installation entirely and
 * belongs to whatever the token was used for before. Replaying it would deliver
 * somebody else's messages into a brand-new database as if they had just arrived.
 *
 * `allowed_updates` is NOT narrowed here. The runtime decides what it handles, and a
 * list set at registration time is a second place that has to be edited when a handler
 * is added — the kind of duplicated decision that goes stale silently.
 */
export async function telegramSetWebhook(
  request: Omit<TelegramSendRequest, 'body' | 'method'> & {
    readonly url: string;
    readonly secretToken: string;
  },
): Promise<TelegramSendOutcome> {
  assertOutsideTransaction('A Telegram setWebhook');

  const { url, secretToken, ...rest } = request;
  const call = await telegramCall({
    ...rest,
    method: 'setWebhook',
    body: { url, secret_token: secretToken, drop_pending_updates: true },
  });
  if (call.outcome !== 'SUCCEEDED') return call;
  // `setWebhook` answers `result: true`. There is no id to carry, and reporting one
  // would be inventing a fact.
  return { outcome: 'SUCCEEDED', messageId: null };
}
