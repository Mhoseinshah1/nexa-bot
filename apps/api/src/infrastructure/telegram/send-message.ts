import { TELEGRAM_CAPTION_MAX } from '../../modules/commerce/messaging/application/message-split.js';
import { assertOutsideTransaction } from '../transaction-boundary.js';
import { encodeMultipart, type MultipartFilePart } from './multipart.js';

/*
 * The caption bound is DECLARED beside the message bound in the messaging application
 * layer, where the splitter that honours the other one lives, and re-exported here for
 * the transport's own `boundCaption`. One declaration; see `message-split.ts` for why.
 */
export { TELEGRAM_CAPTION_MAX };

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

/**
 * A request that carries a FILE, as `multipart/form-data`, rather than a JSON body.
 *
 * Its own type rather than a second optional field on `TelegramSendRequest`: every
 * existing caller spreads `Omit<TelegramSendRequest, 'body' | 'method'>` and adds a
 * body, and a union member with `body?: undefined` would have made that spread
 * un-typeable. `'multipart' in request` is the discriminator, and the JSON request
 * never has the key.
 *
 * `method` is one of the two media methods and nothing else. The bootstrap's calls
 * and `sendMessage` have no file to carry, and a type that let them would be a type
 * that let a surface pass an arbitrary method with bytes attached.
 */
export interface TelegramUploadRequest {
  readonly token: string;
  readonly apiBaseUrl: string;
  readonly timeoutMs: number;
  readonly method: 'sendPhoto' | 'sendDocument';
  readonly multipart: TelegramMultipartBody;
}

/** The text fields and the one file of an upload, before encoding. */
export interface TelegramMultipartBody {
  /**
   * Already strings. Telegram reads a multipart field as text, so an object such as
   * `reply_markup` is JSON-serialised by the body builder, not by the transport — the
   * transport must not know which fields are objects.
   */
  readonly fields: Readonly<Record<string, string>>;
  readonly file: MultipartFilePart;
}

export type TelegramRequest = TelegramSendRequest | TelegramUploadRequest;

export async function telegramSend(request: TelegramRequest): Promise<TelegramSendOutcome> {
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

async function telegramCall(request: TelegramRequest): Promise<TelegramCallOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);
  try {
    /*
     * The body is decided here and nowhere else, so the JSON path is exactly what it
     * was before uploads existed — same header, same serialisation — and the upload
     * path inherits everything below it: the abort timer, `redirect: 'error'`, the
     * retryable/permanent taxonomy and the never-throw contract. NOTHING about the
     * body is logged or quoted in an error on either path: a caption is a customer's
     * text and the bytes are their subscription code.
     */
    const wire =
      'multipart' in request
        ? encodeMultipart(request.multipart.fields, request.multipart.file)
        : { contentType: 'application/json', body: JSON.stringify(request.body) };
    const response = await fetch(
      `${request.apiBaseUrl}/bot${request.token}/${request.method ?? 'sendMessage'}`,
      {
        method: 'POST',
        headers: { 'content-type': wire.contentType },
        body: wire.body,
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
 * One labelled inline-keyboard button, on its way to the wire.
 *
 * `data`, `copyText` and `url` are mutually exclusive and one of them is required.
 * Expressed as a union rather than as three optional fields, so a caller cannot
 * construct a button that is none of them — which Telegram renders as a rectangle that
 * does nothing when tapped, and which no test asserting "the button is there" would
 * catch.
 *
 * `url` is Telegram's own URL button: the client opens it and no update reaches this
 * installation. The scheme is validated by the messenger, which is where the URL is
 * chosen; the transport carries what it is given.
 */
export type TelegramButton = { readonly text: string; readonly row?: number } & (
  | { readonly data: string; readonly copyText?: undefined; readonly url?: undefined }
  | { readonly copyText: string; readonly data?: undefined; readonly url?: undefined }
  | { readonly url: string; readonly data?: undefined; readonly copyText?: undefined }
);

/** Telegram caps a `CopyTextButton`'s payload at 256 characters. */
export const TELEGRAM_COPY_TEXT_MAX = 256;

/**
 * Buttons grouped into the rows Telegram draws.
 *
 * Grouping is by `row`, and a button without one is given a key nothing else can share,
 * so the default stays exactly what it was: one button per row, in the order supplied.
 * Rows come out in the order their FIRST button appeared, which is the only ordering a
 * caller can reason about without also passing an index.
 *
 * Exported for the unit tests, because the grouping is a rule and a rule with no test is
 * a rule that gets silently reverted.
 */
export function telegramButtonMarkup(
  buttons: readonly TelegramButton[],
): Record<string, unknown>[][] {
  const rows = new Map<string, Record<string, unknown>[]>();
  buttons.forEach((button, index) => {
    if (button.copyText !== undefined && button.copyText.length > TELEGRAM_COPY_TEXT_MAX) {
      throw new Error(
        `A copy button may carry at most ${TELEGRAM_COPY_TEXT_MAX} characters; got ${button.copyText.length}.`,
      );
    }
    const key = button.row === undefined ? `self:${index}` : `row:${button.row}`;
    const cell =
      button.url !== undefined
        ? { text: button.text, url: button.url }
        : button.copyText !== undefined
          ? { text: button.text, copy_text: { text: button.copyText } }
          : { text: button.text, callback_data: button.data };
    const existing = rows.get(key);
    if (existing === undefined) rows.set(key, [cell]);
    else existing.push(cell);
  });
  return [...rows.values()];
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
   * The inline-keyboard buttons, already labelled.
   *
   * Omitted entirely when there are none. An EMPTY `inline_keyboard` is not the same
   * thing: Telegram accepts it and renders a message carrying a blank attachment, which
   * is a visible artefact for every reply that happens to have no buttons.
   *
   * Each button carries EITHER a `data` (Telegram `callback_data`, a route this
   * installation handles) or a `copyText` (a `CopyTextButton`, handled entirely by the
   * client). Never both, and never neither — `telegramButtonMarkup` throws rather than
   * emit a button Telegram would reject or, worse, render as an inert rectangle.
   *
   * `row` groups them. Buttons sharing a number sit side by side in the order given; one
   * without a number gets its own row, which is what every caller did before the
   * manual-transfer invoice needed two copy controls above one action.
   */
  readonly buttons?: readonly TelegramButton[];
  /**
   * A persistent keyboard under the chat, as rows of plain labels.
   *
   * `ReplyKeyboardMarkup`, not an inline keyboard: no `callback_data`, so a tap arrives
   * as an ordinary text message whose body is the label. `is_persistent` keeps it shown
   * on clients that support it; `resize_keyboard` stops Telegram reserving a full-height
   * keyboard for two rows; `one_time_keyboard` is FALSE because this is the customer's
   * navigation and hiding it after one tap is what made the bot feel command-driven.
   *
   * Supplied instead of `buttons`, never beside it — `reply_markup` holds one markup.
   */
  readonly keyboard?: readonly (readonly string[])[];
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    chat_id: input.chatId,
    text: input.text,
    link_preview_options: { is_disabled: true },
  };
  if (input.html) body.parse_mode = 'HTML';
  if (input.buttons !== undefined && input.buttons.length > 0) {
    body.reply_markup = { inline_keyboard: telegramButtonMarkup(input.buttons) };
  } else if (input.keyboard !== undefined && input.keyboard.length > 0) {
    body.reply_markup = {
      keyboard: input.keyboard.map((row) => row.map((text) => ({ text }))),
      resize_keyboard: true,
      is_persistent: true,
      one_time_keyboard: false,
      selective: false,
    };
  }
  return body;
}

/**
 * A plain-text caption cut to `TELEGRAM_CAPTION_MAX`, ending in an ellipsis when cut.
 *
 * Measured in UTF-16 code units, which is never fewer than the characters Telegram
 * counts, so a caption this returns is always inside the bound. A surrogate pair is never
 * split: half an emoji is a malformed string, and Telegram refuses those too.
 *
 * PLAIN TEXT ONLY. Cutting an HTML caption could split a tag or an entity, and the parse
 * error that produces is the refusal this exists to avoid; `fileMessageBody` does not call
 * it for HTML.
 */
export function boundCaption(caption: string): string {
  if (caption.length <= TELEGRAM_CAPTION_MAX) return caption;
  let cut = TELEGRAM_CAPTION_MAX - 1;
  const last = caption.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return `${caption.slice(0, cut)}\u2026`;
}

/**
 * The body of a `sendPhoto` or `sendDocument` by `file_id`, with an optional caption and
 * an optional inline keyboard (Payment File 02 §10: the receipt, its context and its
 * decisions as ONE message).
 *
 * The same keyboard rules as `textMessageBody`: absent when there are no buttons, never an
 * empty `inline_keyboard`, and grouped by `telegramButtonMarkup`. A plain-text caption is
 * bounded by `boundCaption`; an HTML one is sent as rendered.
 */
export function fileMessageBody(input: {
  readonly chatId: string;
  readonly kind: 'PHOTO' | 'DOCUMENT';
  readonly fileId: string;
  readonly caption?: string;
  readonly html?: boolean;
  readonly buttons?: readonly TelegramButton[];
}): Record<string, unknown> {
  return {
    chat_id: input.chatId,
    ...(input.kind === 'PHOTO' ? { photo: input.fileId } : { document: input.fileId }),
    ...captionAndKeyboardFields(input),
  };
}

/**
 * The caption and keyboard of a media message, shared by the `file_id` body and the
 * upload body so the two cannot bound a caption or group a keyboard differently.
 */
function captionAndKeyboardFields(input: {
  readonly caption?: string;
  readonly html?: boolean;
  readonly buttons?: readonly TelegramButton[];
}): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (input.caption !== undefined && input.caption.length > 0) {
    fields.caption = input.html === true ? input.caption : boundCaption(input.caption);
    if (input.html === true) fields.parse_mode = 'HTML';
  }
  if (input.buttons !== undefined && input.buttons.length > 0) {
    fields.reply_markup = { inline_keyboard: telegramButtonMarkup(input.buttons) };
  }
  return fields;
}

/**
 * The upload of a `sendPhoto` or `sendDocument` from BYTES this installation holds — a
 * subscription QR code it has just rendered — with the same caption and keyboard rules
 * as `fileMessageBody`.
 *
 * Every field but the file is a string here, because that is how a multipart part
 * travels: Telegram parses `reply_markup` from JSON text in a form field exactly as it
 * does from a JSON body. The serialisation happens in this builder and not in the
 * transport, which must not know which fields are objects.
 */
export function fileUploadBody(input: {
  readonly chatId: string;
  readonly kind: 'PHOTO' | 'DOCUMENT';
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly mimeType: string;
  readonly caption?: string;
  readonly html?: boolean;
  readonly buttons?: readonly TelegramButton[];
}): TelegramMultipartBody {
  const fields: Record<string, string> = { chat_id: input.chatId };
  for (const [name, value] of Object.entries(captionAndKeyboardFields(input))) {
    fields[name] = typeof value === 'string' ? value : JSON.stringify(value);
  }
  return {
    fields,
    file: {
      field: input.kind === 'PHOTO' ? 'photo' : 'document',
      fileName: input.fileName,
      mimeType: input.mimeType,
      bytes: input.bytes,
    },
  };
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
 * `drop_pending_updates` is the CALLER'S decision, and it is not a detail.
 *
 * On a first registration it is true: a fresh install has no customers and no
 * conversations, so whatever is queued at Telegram predates this installation entirely
 * and belongs to whatever the token was used for before — replaying it would deliver
 * somebody else's messages into a brand-new database as if they had just arrived.
 *
 * On a RE-registration it is false. A domain change and a crash recovery both
 * re-register against a RUNNING installation, and discarding the queue there throws away
 * real customers' messages with no count, no confirmation and no record. Defaulting it
 * true here would make that the silent behaviour of every later caller.
 *
 * `allowed_updates` is NOT narrowed here. The runtime decides what it handles, and a
 * list set at registration time is a second place that has to be edited when a handler
 * is added — the kind of duplicated decision that goes stale silently.
 */
export async function telegramSetWebhook(
  request: Omit<TelegramSendRequest, 'body' | 'method'> & {
    readonly url: string;
    readonly secretToken: string;
    readonly dropPendingUpdates: boolean;
  },
): Promise<TelegramSendOutcome> {
  assertOutsideTransaction('A Telegram setWebhook');

  const { url, secretToken, dropPendingUpdates, ...rest } = request;
  const call = await telegramCall({
    ...rest,
    method: 'setWebhook',
    body: { url, secret_token: secretToken, drop_pending_updates: dropPendingUpdates },
  });
  if (call.outcome !== 'SUCCEEDED') return call;
  // `setWebhook` answers `result: true`. There is no id to carry, and reporting one
  // would be inventing a fact.
  return { outcome: 'SUCCEEDED', messageId: null };
}

/**
 * Registers this bot's command list with Telegram, so the client draws its own menu.
 *
 * `docs/phase4h-audit.md` §9 measured the absence: the bot answered four commands,
 * registered none of them, and the greeting named only one — so two were reachable only
 * by a customer who guessed. Telegram's command menu is the affordance that exists for
 * exactly this, and not using it was the whole defect.
 *
 * Best-effort at the CALLER, never here. A `setMyCommands` that fails leaves a bot that
 * works and a menu that is stale, which must not fail an install the way a missing
 * webhook does — the webhook is how updates ARRIVE, and this is a convenience.
 */
export async function telegramSetMyCommands(
  request: Omit<TelegramSendRequest, 'body' | 'method'> & {
    readonly commands: readonly { readonly command: string; readonly description: string }[];
  },
): Promise<TelegramSendOutcome> {
  assertOutsideTransaction('A Telegram setMyCommands');

  const { commands, ...rest } = request;
  const call = await telegramCall({
    ...rest,
    method: 'setMyCommands',
    body: { commands },
  });
  if (call.outcome !== 'SUCCEEDED') return call;
  // Answers `result: true`. No id to carry, and reporting one would invent a fact.
  return { outcome: 'SUCCEEDED', messageId: null };
}

/**
 * What Telegram holds as this bot's webhook registration, as Telegram reports it.
 *
 * The fields of the Bot API's `WebhookInfo` that answer an operator's question — is
 * Telegram pointed where this installation thinks, is it failing, is anything queued —
 * and nothing else. `url` is the empty string when no webhook is set, and is carried as
 * null so "no registration" is not a URL. `last_error_date` is Unix seconds.
 */
export interface TelegramWebhookInfo {
  readonly url: string | null;
  readonly pendingUpdateCount: number | null;
  readonly lastErrorAt: Date | null;
  readonly lastErrorMessage: string | null;
  readonly maxConnections: number | null;
}

export type TelegramWebhookInfoOutcome =
  | { readonly outcome: 'SUCCEEDED'; readonly info: TelegramWebhookInfo }
  | Exclude<TelegramSendOutcome, { outcome: 'SUCCEEDED' }>;

/**
 * Read the webhook registration (`getWebhookInfo`). A READ: it changes nothing at
 * Telegram, which is why a Web Admin diagnostic may call it (WP13 D5) where it may not
 * call `setWebhook`.
 *
 * Every field is validated by type and dropped to null when it is not what the Bot API
 * documents, rather than failing the whole read: a diagnostic that refuses to show the
 * pending count because the error date was malformed would hide the fact the operator
 * came for. A 2xx whose `result` is not an object at all IS refused, as `getMe` refuses
 * one — it is not Telegram answering.
 */
export async function telegramGetWebhookInfo(
  request: Omit<TelegramSendRequest, 'body' | 'method'>,
): Promise<TelegramWebhookInfoOutcome> {
  assertOutsideTransaction('A Telegram getWebhookInfo');

  const call = await telegramCall({ ...request, method: 'getWebhookInfo', body: {} });
  if (call.outcome !== 'SUCCEEDED') return call;

  const result = call.result;
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    return {
      outcome: 'FAILED_PERMANENT',
      errorCode: 'telegram.rejected.webhook_info_shape',
      errorMessage: 'getWebhookInfo answered without a WebhookInfo object.',
    };
  }
  const info = result as Record<string, unknown>;
  const count = (value: unknown): number | null =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
  const url = typeof info.url === 'string' && info.url !== '' ? info.url : null;
  const errorSeconds = count(info.last_error_date);
  return {
    outcome: 'SUCCEEDED',
    info: {
      url,
      pendingUpdateCount: count(info.pending_update_count),
      lastErrorAt:
        errorSeconds === null || errorSeconds === 0 ? null : new Date(errorSeconds * 1000),
      lastErrorMessage:
        typeof info.last_error_message === 'string' && info.last_error_message !== ''
          ? info.last_error_message
          : null,
      maxConnections: count(info.max_connections),
    },
  };
}
