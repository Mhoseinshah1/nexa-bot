import { TELEGRAM_CAPTION_MAX } from '../../modules/commerce/messaging/application/message-split.js';
import { assertOutsideTransaction } from '../transaction-boundary.js';
import { encodeMultipart, encodeMultipartFiles, type MultipartFilePart } from './multipart.js';

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
  | {
      readonly outcome: 'SUCCEEDED';
      readonly messageId: number | null;
      /**
       * HF-A7: the file a `sendPhoto` or `sendDocument` delivered, as Telegram now holds it
       * — the largest size of a photo, or the document. Absent for a text message, and for
       * an answer that did not name one in the expected shape.
       */
      readonly file?: { readonly fileId: string; readonly fileUniqueId: string };
      /**
       * TB10 review (PR #205, S1): the message's `date` as TELEGRAM stamped it — whole seconds,
       * on the same clock as every message Telegram delivers to us. Absent when the answer did
       * not carry a positive integer `date`.
       */
      readonly sentAt?: Date;
    }
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
  /**
   * Round N: `sendVideo` for a broadcast's video (B1), and (F2) `sendMediaGroup`, an album of
   * uploaded files.
   */
  readonly method: 'sendPhoto' | 'sendDocument' | 'sendVideo' | 'sendMediaGroup';
  readonly multipart: TelegramMultipartBody | TelegramAlbumBody;
}

/**
 * Round N (F2): an album's upload — its `media` list (a field, JSON text) naming each file
 * by `attach://<field>`, and the files themselves, in order.
 */
export interface TelegramAlbumBody {
  readonly fields: Readonly<Record<string, string>>;
  readonly files: readonly MultipartFilePart[];
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
  // What a send reads out of a result: the message id, Telegram's own date for it, and a
  // media send's file. `telegramCall` returns the whole `result`; this narrows it, which is
  // why the bootstrap needed its own callers rather than a wider return type here.
  const result = call.result as { message_id?: number; date?: unknown } | null;
  const file = sentFileOf(call.result);
  const date = result?.date;
  return {
    outcome: 'SUCCEEDED',
    messageId: result?.message_id ?? null,
    ...(file === null ? {} : { file }),
    ...(typeof date === 'number' && Number.isSafeInteger(date) && date > 0
      ? { sentAt: new Date(date * 1000) }
      : {}),
  };
}

/**
 * The delivered file's handle from a media send's `Message`: `document`, or the LAST entry of
 * `photo` (Telegram lists a photo's sizes smallest first). `null` unless both ids are
 * non-empty strings — an answer this code does not recognise is not guessed at.
 */
export function sentFileOf(
  result: unknown,
): { readonly fileId: string; readonly fileUniqueId: string } | null {
  if (typeof result !== 'object' || result === null) return null;
  const message = result as { document?: unknown; photo?: unknown; video?: unknown };
  // Round N: a broadcast's video is answered with `video`, and its handle is what lets every
  // later recipient of the same broadcast be sent it without a second upload.
  const candidate = Array.isArray(message.photo)
    ? message.photo.at(-1)
    : (message.document ?? message.video);
  if (typeof candidate !== 'object' || candidate === null) return null;
  const { file_id: fileId, file_unique_id: fileUniqueId } = candidate as {
    file_id?: unknown;
    file_unique_id?: unknown;
  };
  return typeof fileId === 'string' &&
    fileId !== '' &&
    typeof fileUniqueId === 'string' &&
    fileUniqueId !== ''
    ? { fileId, fileUniqueId }
    : null;
}

/**
 * D1 (roadmap, Telegram robustness): the longest wait a 429 is honoured for, 24 hours.
 *
 * A ceiling rather than a rejection: a `retry_after` above it is still a definite "not
 * now", and asking again at 24 hours is safe — Telegram declines a rate-limited request, it
 * does not deliver it, so the worst an early ask costs is a second 429. Without a ceiling a
 * garbled or hostile number parks a message for years, or overflows the `integer` columns
 * the lanes store the wait in (`retry_after_ms`, at most ~24.8 days in milliseconds).
 */
export const TELEGRAM_RETRY_AFTER_MAX_MS = 24 * 60 * 60 * 1000;

/**
 * Telegram's `parameters.retry_after`, in whole milliseconds — or `undefined` when the
 * timing is not DEFINITE.
 *
 * The Bot API documents an Integer of seconds. Anything that is not a finite, non-negative
 * number is not a wait: before, `retry_after * 1000` turned a string into `NaN` (and `null`
 * into 0), `Math.max(NaN, floor)` is `NaN`, and the lane's `new Date(NaN)` failed the very
 * write that was meant to defer the message. An indefinite 429 is still a 429 — the caller
 * waits its own floor or default. A fraction is rounded UP, so the wait is never shorter
 * than Telegram asked; a wait over `TELEGRAM_RETRY_AFTER_MAX_MS` is held to it.
 *
 * Exported so every reader of a 429 uses one parse, and for the unit tests.
 */
export function telegramRetryAfterMs(retryAfter: unknown): number | undefined {
  if (typeof retryAfter !== 'number' || !Number.isFinite(retryAfter) || retryAfter < 0) {
    return undefined;
  }
  return Math.min(Math.ceil(retryAfter * 1000), TELEGRAM_RETRY_AFTER_MAX_MS);
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
 * NOT exported for general use: every caller is a named function in this file
 * (`telegramSend`, `telegramGetMe`, `telegramSetWebhook`, the Stars pair below, ...), and
 * the next should be one too rather than an arbitrary method string passed in from a
 * surface.
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
        ? 'files' in request.multipart
          ? encodeMultipartFiles(request.multipart.fields, request.multipart.files)
          : encodeMultipart(request.multipart.fields, request.multipart.file)
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
      ok?: unknown;
      // `unknown`, because this function serves every method. Each caller narrows it.
      result?: unknown;
      description?: string;
      error_code?: number;
      // `unknown`: read only through `telegramRetryAfterMs`, which decides whether it is a wait.
      parameters?: { retry_after?: unknown };
    } | null;
    try {
      payload = (await response.json()) as typeof payload;
    } catch {
      payload = null;
    }

    if (response.ok && payload?.ok === true) {
      return { outcome: 'SUCCEEDED', result: payload.result ?? null };
    }

    /*
     * D1 (roadmap, Telegram robustness): a 2xx is a refusal ONLY when its body says so —
     * `ok: false`, which Telegram does send under a 200 for some failures. A 2xx whose body
     * did not parse, or parsed into something that is not a Bot API answer at all (no `ok`
     * field, a bare value, `null`), is the UNKNOWN outcome: Telegram accepted the request and
     * very likely processed it. Before, a parsed body without `ok` fell through to
     * `telegram.rejected.200` — a DEFINITE refusal — and the one caller that retries a
     * definite refusal (the messenger's icon-less retry, `deliverDecorated`) sent the same
     * message a second time.
     */
    if (response.ok && payload?.ok !== false) {
      return {
        outcome: 'FAILED_RETRYABLE',
        errorCode: 'telegram.unreadable_response',
        errorMessage:
          payload === null
            ? `HTTP ${response.status} with a body that could not be parsed.`
            : `HTTP ${response.status} with a body that is not a Bot API answer.`,
      };
    }

    const description = payload?.description ?? `HTTP ${response.status}`;

    if (response.status === 429) {
      // D1: the wait is carried only when it is DEFINITE (`telegramRetryAfterMs`); a 429
      // without a usable number is still a 429 — declined, nothing sent — just untimed.
      const retryAfterMs = telegramRetryAfterMs(payload?.parameters?.retry_after);
      return {
        outcome: 'FAILED_RETRYABLE',
        errorCode: 'telegram.rate_limited',
        errorMessage: description,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
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
export type TelegramButton = {
  readonly text: string;
  readonly row?: number;
  /**
   * Owner spec §6: `InlineKeyboardButton.style` — the same closed set as the reply keyboard
   * (`TELEGRAM_KEYBOARD_BUTTON_STYLES`, Bot API 9.4). Absent is the client default; a value
   * outside the set is never put on the wire. Presentation only: it changes no route.
   */
  readonly style?: TelegramKeyboardButtonStyle;
  /**
   * Phase 2 Item 3: `InlineKeyboardButton.icon_custom_emoji_id` — ONE custom emoji Telegram
   * shows BEFORE the text. Set only by a caller that resolved it for the SENDING bot's
   * proven eligibility (the messenger's `labelButtons`); an empty string is never sent. The
   * text is never altered for it (a button's text carries no entities), and it touches no
   * route: `callback_data`, `url` and `copy_text` are written exactly as without it. A caller
   * that sends an iconed keyboard owns the one icon-less retry (`withoutButtonIcons`).
   */
  readonly iconCustomEmojiId?: string;
} & (
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
    const cell: Record<string, unknown> =
      button.url !== undefined
        ? { text: button.text, url: button.url }
        : button.copyText !== undefined
          ? { text: button.text, copy_text: { text: button.copyText } }
          : { text: button.text, callback_data: button.data };
    if (
      button.style !== undefined &&
      (TELEGRAM_KEYBOARD_BUTTON_STYLES as readonly string[]).includes(button.style)
    ) {
      cell.style = button.style;
    }
    if (button.iconCustomEmojiId !== undefined && button.iconCustomEmojiId !== '') {
      cell.icon_custom_emoji_id = button.iconCustomEmojiId;
    }
    const existing = rows.get(key);
    if (existing === undefined) rows.set(key, [cell]);
    else existing.push(cell);
  });
  return [...rows.values()];
}

/** Whether any button carries an icon — what makes a keyboard owe the one icon-less retry. */
export function buttonsHaveIcons(buttons: readonly TelegramButton[]): boolean {
  return buttons.some(
    (button) => button.iconCustomEmojiId !== undefined && button.iconCustomEmojiId !== '',
  );
}

/**
 * The same buttons with every icon removed and everything else — text, row, style and the
 * route — kept: the keyboard of the one retry a refused iconed message is allowed.
 */
export function withoutButtonIcons(buttons: readonly TelegramButton[]): TelegramButton[] {
  return buttons.map((button) => {
    if (button.iconCustomEmojiId === undefined) return button;
    const { iconCustomEmojiId: _dropped, ...rest } = button;
    return rest as TelegramButton;
  });
}

/**
 * The body of a customer-facing text message.
 *
 * `link_preview_options` rather than the deprecated `disable_web_page_preview`, for the
 * reason the notification transport gives: a deprecated parameter is one release away
 * from being ignored, and the failure would be a preview card appearing with no code
 * change to explain it.
 */
/**
 * One Telegram `MessageEntity` on its way to the wire, in UTF-16 code units.
 *
 * `custom_emoji_id` is the one attribute this installation sends (Premium UI): "For
 * "custom_emoji" only, unique identifier of the custom emoji". The provider-caption
 * entities (`caption-markup.ts`) carry no attribute and satisfy this shape as they are.
 *
 * Entities are sent "instead of parse_mode" (Bot API, `entities` / `caption_entities`):
 * every builder below drops them for an HTML body, whose custom emoji travel as
 * `<tg-emoji>` tags inside the text (`appearance-render.ts`).
 */
export interface TelegramMessageEntity {
  readonly type: string;
  readonly offset: number;
  readonly length: number;
  readonly custom_emoji_id?: string;
}

/** The entities that lie inside a text, for a builder that may have bounded it. */
function entitiesInside(
  entities: readonly TelegramMessageEntity[] | undefined,
  text: string,
): TelegramMessageEntity[] {
  return (entities ?? []).filter(
    (entity) => entity.length > 0 && entity.offset + entity.length <= text.length,
  );
}

/**
 * Round T (T2): the closed set of `KeyboardButton.style` values Telegram accepts — exactly
 * these three (Bot API 9.4, confirmed by the owner, `OQ-T-API-01`). An absent style is the
 * client's default; the builder's `default` is therefore never sent, and no other string is.
 */
export const TELEGRAM_KEYBOARD_BUTTON_STYLES = ['primary', 'success', 'danger'] as const;
export type TelegramKeyboardButtonStyle = (typeof TELEGRAM_KEYBOARD_BUTTON_STYLES)[number];

/**
 * Round T (T2): ONE reply-keyboard button on its way to the wire — the one structured
 * descriptor every reply keyboard is built from (`docs/round-t-button-builder-audit.md` §12).
 *
 * - `text` is sent EXACTLY as given. A tap on a button with no special field other than
 *   `text`, `style` and `icon_custom_emoji_id` sends `text` back (`OQ-T-API-04`), and the
 *   runtime routes by it, so nothing here may prefix, trim or decorate it — an icon is a
 *   separate field, never an emoji glued onto the label.
 * - `style` is omitted for the client default; a value outside
 *   `TELEGRAM_KEYBOARD_BUTTON_STYLES` is never put on the wire.
 * - `iconCustomEmojiId` is `icon_custom_emoji_id`, set only by a caller that resolved it
 *   for the SENDING bot's proven eligibility. An empty string is never sent.
 */
export interface TelegramReplyKeyboardButton {
  readonly text: string;
  readonly style?: TelegramKeyboardButtonStyle;
  readonly iconCustomEmojiId?: string;
}

/**
 * One reply-keyboard cell as Telegram reads it. A bare string — the admin row, every caller
 * before round T — is `{ text }` and nothing else, so a keyboard of strings, or of
 * descriptors carrying neither a style nor an icon, is byte for byte what was sent before.
 *
 * Exported for the unit tests: the omission of `default` and of an unproven icon is a rule.
 */
export function replyKeyboardButtonMarkup(
  button: string | TelegramReplyKeyboardButton,
): Record<string, unknown> {
  if (typeof button === 'string') return { text: button };
  const cell: Record<string, unknown> = { text: button.text };
  if (
    button.style !== undefined &&
    (TELEGRAM_KEYBOARD_BUTTON_STYLES as readonly string[]).includes(button.style)
  ) {
    cell.style = button.style;
  }
  if (button.iconCustomEmojiId !== undefined && button.iconCustomEmojiId !== '') {
    cell.icon_custom_emoji_id = button.iconCustomEmojiId;
  }
  return cell;
}

export function textMessageBody(input: {
  readonly chatId: string;
  readonly text: string;
  readonly html: boolean;
  /**
   * Premium UI: the custom emoji entities of a PLAIN body, from the appearance renderer.
   * Ignored for HTML, where they cannot be sent beside `parse_mode`.
   */
  readonly entities?: readonly TelegramMessageEntity[];
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
   * A persistent keyboard under the chat, as rows of labels — a bare string, or (round T)
   * a `TelegramReplyKeyboardButton` carrying a style and an icon beside the label.
   *
   * `ReplyKeyboardMarkup`, not an inline keyboard: no `callback_data`, so a tap arrives
   * as an ordinary text message whose body is the label. `is_persistent` keeps it shown
   * on clients that support it; `resize_keyboard` stops Telegram reserving a full-height
   * keyboard for two rows; `one_time_keyboard` is FALSE because this is the customer's
   * navigation and hiding it after one tap is what made the bot feel command-driven.
   *
   * Supplied instead of `buttons`, never beside it — `reply_markup` holds one markup.
   */
  readonly keyboard?: readonly (readonly (string | TelegramReplyKeyboardButton)[])[];
  /**
   * Round N (F1): a reply to this message of the same chat. `allow_sending_without_reply`,
   * so a message deleted in the meantime costs the reply's link, never the message.
   */
  readonly replyToMessageId?: number;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    chat_id: input.chatId,
    text: input.text,
    link_preview_options: { is_disabled: true },
  };
  if (input.html) body.parse_mode = 'HTML';
  else {
    const entities = entitiesInside(input.entities, input.text);
    if (entities.length > 0) body.entities = entities;
  }
  if (input.replyToMessageId !== undefined) {
    body.reply_parameters = {
      message_id: input.replyToMessageId,
      allow_sending_without_reply: true,
    };
  }
  if (input.buttons !== undefined && input.buttons.length > 0) {
    body.reply_markup = { inline_keyboard: telegramButtonMarkup(input.buttons) };
  } else if (input.keyboard !== undefined && input.keyboard.length > 0) {
    body.reply_markup = {
      keyboard: input.keyboard.map((row) => row.map(replyKeyboardButtonMarkup)),
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
  readonly kind: 'PHOTO' | 'DOCUMENT' | 'VIDEO';
  readonly fileId: string;
  readonly caption?: string;
  readonly html?: boolean;
  readonly buttons?: readonly TelegramButton[];
}): Record<string, unknown> {
  return {
    chat_id: input.chatId,
    ...(input.kind === 'PHOTO'
      ? { photo: input.fileId }
      : input.kind === 'VIDEO'
        ? { video: input.fileId }
        : { document: input.fileId }),
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
  /** Round N (F2): a PLAIN caption's formatting, as entities; ignored for HTML. */
  readonly captionEntities?: readonly TelegramMessageEntity[];
}): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (input.caption !== undefined && input.caption.length > 0) {
    const caption = input.html === true ? input.caption : boundCaption(input.caption);
    fields.caption = caption;
    if (input.html === true) fields.parse_mode = 'HTML';
    const entities = input.html === true ? [] : entitiesInside(input.captionEntities, caption);
    if (entities.length > 0) fields.caption_entities = entities;
  }
  if (input.buttons !== undefined && input.buttons.length > 0) {
    fields.reply_markup = { inline_keyboard: telegramButtonMarkup(input.buttons) };
  }
  return fields;
}

/**
 * R2 (v0.3.5 real-test items 3–5), beside R3's `editMessageBody` and on its rules: the
 * other three ways this bot changes a message it ALREADY SENT. `editMessageCaption` for a
 * file whose caption carries the text (a reviewer's receipt), `editMessageReplyMarkup` to
 * take a keyboard off a message whose text stays, and `deleteMessage`.
 *
 * The keyboard is always sent, even empty, for the reason `editMessageBody` gives: a
 * message edited into a result must keep no button that could ask for the decision again.
 */
export function editCaptionBody(input: {
  readonly chatId: string;
  readonly messageId: number;
  readonly caption: string;
  readonly html: boolean;
  readonly buttons: readonly TelegramButton[];
  /** Premium UI: a PLAIN caption's custom emoji entities; ignored for HTML. */
  readonly captionEntities?: readonly TelegramMessageEntity[];
}): Record<string, unknown> {
  const caption = input.html ? input.caption : boundCaption(input.caption);
  const body: Record<string, unknown> = {
    chat_id: input.chatId,
    message_id: input.messageId,
    caption,
    reply_markup: { inline_keyboard: telegramButtonMarkup(input.buttons) },
  };
  if (input.html) body.parse_mode = 'HTML';
  else {
    const entities = entitiesInside(input.captionEntities, caption);
    if (entities.length > 0) body.caption_entities = entities;
  }
  return body;
}

/** `editMessageReplyMarkup` with an EMPTY keyboard: the text stays, every button goes. */
export function clearKeyboardBody(input: {
  readonly chatId: string;
  readonly messageId: number;
}): Record<string, unknown> {
  return {
    chat_id: input.chatId,
    message_id: input.messageId,
    reply_markup: { inline_keyboard: [] },
  };
}

/** `deleteMessage`. */
export function deleteMessageBody(input: {
  readonly chatId: string;
  readonly messageId: number;
}): Record<string, unknown> {
  return { chat_id: input.chatId, message_id: input.messageId };
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
  readonly kind: 'PHOTO' | 'DOCUMENT' | 'VIDEO';
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly mimeType: string;
  readonly caption?: string;
  readonly html?: boolean;
  readonly buttons?: readonly TelegramButton[];
  readonly captionEntities?: readonly TelegramMessageEntity[];
}): TelegramMultipartBody {
  const fields: Record<string, string> = { chat_id: input.chatId };
  for (const [name, value] of Object.entries(captionAndKeyboardFields(input))) {
    fields[name] = typeof value === 'string' ? value : JSON.stringify(value);
  }
  return {
    fields,
    file: {
      field: input.kind === 'PHOTO' ? 'photo' : input.kind === 'VIDEO' ? 'video' : 'document',
      fileName: input.fileName,
      mimeType: input.mimeType,
      bytes: input.bytes,
    },
  };
}

/**
 * Round N (F2): one item of an album — a file this installation holds as bytes, and its
 * caption as PLAIN text with optional `caption_entities`. Never `parse_mode`: the caption of
 * a connection file is a provider's text, and entities are the one way to show its
 * formatting that no string from that provider can break (`caption-markup.ts`).
 */
export interface TelegramAlbumItem {
  readonly kind: 'PHOTO' | 'DOCUMENT';
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly mimeType: string;
  readonly caption?: string;
  readonly captionEntities?: readonly TelegramMessageEntity[];
}

/**
 * The upload of a `sendMediaGroup` (Round N, F2): 2–10 items, each attached as its own part
 * (`file0`, `file1`, …) and named in `media` by `attach://`. The caller has already bounded
 * each caption and its entities (`placeCaptionEntities`); a plain caption is still bounded
 * here by `boundCaption`, exactly as a single file's is, and entities past it are dropped.
 */
export function mediaGroupUploadBody(input: {
  readonly chatId: string;
  readonly items: readonly TelegramAlbumItem[];
}): TelegramAlbumBody {
  const media = input.items.map((item, index) => {
    const entry: Record<string, unknown> = {
      type: item.kind === 'PHOTO' ? 'photo' : 'document',
      media: `attach://file${String(index)}`,
    };
    if (item.caption !== undefined && item.caption.length > 0) {
      const caption = boundCaption(item.caption);
      entry.caption = caption;
      const entities = entitiesInside(item.captionEntities, caption);
      if (entities.length > 0) entry.caption_entities = entities;
    }
    return entry;
  });
  return {
    fields: { chat_id: input.chatId, media: JSON.stringify(media) },
    files: input.items.map((item, index) => ({
      field: `file${String(index)}`,
      fileName: item.fileName,
      mimeType: item.mimeType,
      bytes: item.bytes,
    })),
  };
}

/**
 * The body of an `answerCallbackQuery` call.
 *
 * `text` is shown by Telegram as a short notice over the chat (R3: the refresh button's
 * failure). It is only ever a RENDERED TEMPLATE — the messenger renders the key before it
 * reaches here — so a toast is never a customer-facing string without a key and a tenant
 * override. Telegram caps it at 200 characters; a longer rendering is cut with a visible
 * ellipsis rather than refused, because the notice is advisory and the call's first job
 * is still to stop the button spinning.
 */
export const TELEGRAM_CALLBACK_TEXT_MAX = 200;

export function callbackAnswerBody(input: {
  readonly callbackQueryId: string;
  readonly text?: string;
}): Record<string, unknown> {
  if (input.text === undefined || input.text.length === 0) {
    return { callback_query_id: input.callbackQueryId };
  }
  const text =
    input.text.length <= TELEGRAM_CALLBACK_TEXT_MAX
      ? input.text
      : `${input.text.slice(0, TELEGRAM_CALLBACK_TEXT_MAX - 1)}\u2026`;
  return { callback_query_id: input.callbackQueryId, text };
}

/**
 * The body of an `editMessageText` call (R3): the SAME message a customer tapped, given a
 * new text and keyboard — the service card after a refresh, a disable or an enable.
 *
 * Same shape rules as `textMessageBody`: the text is the rendered template, HTML only when
 * the key's format says so, and link previews off. The inline keyboard is always sent,
 * even empty, because leaving `reply_markup` out keeps the OLD buttons, and an old
 * «disable» under a card that now reads «inactive» is the lie the edit exists to remove.
 */
export function editMessageBody(input: {
  readonly chatId: string;
  readonly messageId: number;
  readonly text: string;
  readonly html: boolean;
  readonly buttons: readonly TelegramButton[];
  /** Premium UI: the same entities `textMessageBody` takes, by the same rule. */
  readonly entities?: readonly TelegramMessageEntity[];
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    chat_id: input.chatId,
    message_id: input.messageId,
    text: input.text,
    link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: telegramButtonMarkup(input.buttons) },
  };
  if (input.html) body.parse_mode = 'HTML';
  else {
    const entities = entitiesInside(input.entities, input.text);
    if (entities.length > 0) body.entities = entities;
  }
  return body;
}

/**
 * Whether Telegram refused an edit only because the message already says exactly this.
 *
 * `400 Bad Request: message is not modified`. The desired state IS the current state, so
 * for an idempotent re-edit — a repeated tap, a card already refreshed — it is success.
 */
export function isMessageNotModified(outcome: TelegramSendOutcome): boolean {
  return (
    outcome.outcome === 'FAILED_PERMANENT' && /message is not modified/iu.test(outcome.errorMessage)
  );
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
  /**
   * `User.is_bot` as Telegram answered it, or null when the field was absent. The Bot API
   * always sends it for `getMe`; it is carried rather than required here because several
   * callers only want the username, and a stand-in that omits it must not cost them the
   * name. A caller that has to KNOW it is a bot — the token replacement — requires `true`.
   */
  readonly isBot: boolean | null;
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

  const result = call.result as { id?: unknown; username?: unknown; is_bot?: unknown } | null;
  const id = result?.id;
  const username = result?.username;
  const isBot = typeof result?.is_bot === 'boolean' ? result.is_bot : null;

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

  return { outcome: 'SUCCEEDED', identity: { botId: String(id), username, isBot } };
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
    /**
     * R4 — `allowed_updates`, sent only when given. The Bot API KEEPS the previous list
     * when the field is omitted, so a registration somebody else narrowed (to `message`
     * alone, say) survives an ordinary re-registration and the bot silently stops seeing
     * button presses. An EMPTY list is Telegram's documented reset to its default set,
     * which is not a narrowing: it is the set this installation has always relied on.
     */
    readonly allowedUpdates?: readonly string[];
  },
): Promise<TelegramSendOutcome> {
  assertOutsideTransaction('A Telegram setWebhook');

  const { url, secretToken, dropPendingUpdates, allowedUpdates, ...rest } = request;
  const call = await telegramCall({
    ...rest,
    method: 'setWebhook',
    body: {
      url,
      secret_token: secretToken,
      drop_pending_updates: dropPendingUpdates,
      ...(allowedUpdates === undefined ? {} : { allowed_updates: allowedUpdates }),
    },
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

/** One command as Telegram reports it (`BotCommand`): the two documented fields. */
export interface TelegramBotCommand {
  readonly command: string;
  readonly description: string;
}

export type TelegramCommandsOutcome =
  | { readonly outcome: 'SUCCEEDED'; readonly commands: readonly TelegramBotCommand[] }
  | Exclude<TelegramSendOutcome, { outcome: 'SUCCEEDED' }>;

/**
 * Read the command list Telegram holds for this bot (`getMyCommands`, default scope and
 * language — the same scope `telegramSetMyCommands` writes, since it sends neither).
 *
 * A READ, which is why the Web Admin's «بررسی وضعیت» may call it (round P): it changes
 * nothing at Telegram. The Bot API answers an array of `BotCommand`; an entry that is not
 * `{ command: string, description: string }` is dropped rather than failing the read, and
 * a `result` that is not an array at all is refused as not Telegram answering — the rule
 * `telegramGetWebhookInfo` applies to its object.
 */
export async function telegramGetMyCommands(
  request: Omit<TelegramSendRequest, 'body' | 'method'>,
): Promise<TelegramCommandsOutcome> {
  assertOutsideTransaction('A Telegram getMyCommands');

  const call = await telegramCall({ ...request, method: 'getMyCommands', body: {} });
  if (call.outcome !== 'SUCCEEDED') return call;
  if (!Array.isArray(call.result)) {
    return {
      outcome: 'FAILED_PERMANENT',
      errorCode: 'telegram.rejected.commands_shape',
      errorMessage: 'getMyCommands answered without an array of BotCommand.',
    };
  }
  const commands = (call.result as unknown[]).flatMap((entry) => {
    if (entry === null || typeof entry !== 'object') return [];
    const { command, description } = entry as Record<string, unknown>;
    return typeof command === 'string' && typeof description === 'string'
      ? [{ command, description }]
      : [];
  });
  return { outcome: 'SUCCEEDED', commands };
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
  /**
   * R4 — `allowed_updates`, when Telegram reports one. Null when absent, which the Bot API
   * uses for its default set; strings only, anything else dropped.
   */
  readonly allowedUpdates: readonly string[] | null;
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
      allowedUpdates: Array.isArray(info.allowed_updates)
        ? info.allowed_updates.filter((entry): entry is string => typeof entry === 'string')
        : null,
    },
  };
}

/**
 * Remove the webhook (`deleteWebhook`). R4's compensation, and nothing else calls it.
 *
 * Telegram then HOLDS the bot's updates (for up to 24 hours) rather than delivering them,
 * which is the point: a replacement that could not store its token puts a bot that had no
 * webhook back into having none, so nothing is delivered to an installation whose stored
 * token cannot answer it. `drop_pending_updates` is the caller's decision, for the reason
 * `telegramSetWebhook` gives, and the only caller passes false.
 */
export async function telegramDeleteWebhook(
  request: Omit<TelegramSendRequest, 'body' | 'method'> & {
    readonly dropPendingUpdates: boolean;
  },
): Promise<TelegramSendOutcome> {
  assertOutsideTransaction('A Telegram deleteWebhook');

  const { dropPendingUpdates, ...rest } = request;
  const call = await telegramCall({
    ...rest,
    method: 'deleteWebhook',
    body: { drop_pending_updates: dropPendingUpdates },
  });
  if (call.outcome !== 'SUCCEEDED') return call;
  // Answers `result: true`, whether or not a webhook was set. No id to carry.
  return { outcome: 'SUCCEEDED', messageId: null };
}

// ---------------------------------------------------------------------------
// Channel membership (Package B, `docs/package-b-channel-membership-audit.md`)
// ---------------------------------------------------------------------------

/** What `getChatMember` said about one user in one chat, as Telegram put it. */
export interface TelegramChatMember {
  readonly status: string;
  /** Present only for `restricted`: whether the user is still in the chat. */
  readonly isMember: boolean | null;
  /**
   * WP-A4: an administrator's "manage topics" right; null where Telegram does not state
   * it (every status but `administrator`, and a creator, who holds every right).
   */
  readonly canManageTopics: boolean | null;
  /** A `restricted` member's send right; null where Telegram does not state it. */
  readonly canSendMessages: boolean | null;
}

export type TelegramChatMemberOutcome =
  | { readonly outcome: 'SUCCEEDED'; readonly member: TelegramChatMember }
  | Exclude<TelegramSendOutcome, { outcome: 'SUCCEEDED' }>;

/**
 * Ask Telegram whether one user is in one chat (`getChatMember`). A READ: it changes
 * nothing, so a customer's turn may call it.
 *
 * `chatId` is the numeric id or the public `@handle`. The outcome is the shared taxonomy;
 * the CALLER decides what a failure means — for membership, never "not a member" (audit
 * §2.2). A 2xx whose `result` carries no string `status` is refused like `getMe`'s.
 */
export async function telegramGetChatMember(
  request: Omit<TelegramSendRequest, 'body' | 'method'> & {
    readonly chatId: string;
    readonly userId: string;
  },
): Promise<TelegramChatMemberOutcome> {
  assertOutsideTransaction('A Telegram getChatMember');

  const { chatId, userId, ...rest } = request;
  const call = await telegramCall({
    ...rest,
    method: 'getChatMember',
    body: { chat_id: chatId, user_id: Number(userId) },
  });
  if (call.outcome !== 'SUCCEEDED') return call;

  const result = call.result;
  const status =
    result !== null && typeof result === 'object' && !Array.isArray(result)
      ? (result as Record<string, unknown>).status
      : undefined;
  if (typeof status !== 'string') {
    return {
      outcome: 'FAILED_PERMANENT',
      errorCode: 'telegram.rejected.chat_member_shape',
      errorMessage: 'getChatMember answered without a ChatMember status.',
    };
  }
  const fields = result as Record<string, unknown>;
  const flag = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);
  return {
    outcome: 'SUCCEEDED',
    member: {
      status,
      isMember: flag(fields.is_member),
      canManageTopics: flag(fields.can_manage_topics),
      canSendMessages: flag(fields.can_send_messages),
    },
  };
}

// ---------------------------------------------------------------------------
// The operations log group (WP-A4)
// ---------------------------------------------------------------------------

/** What `getChat` says about the operations group: enough to decide it is usable. */
export interface TelegramChatDescription {
  readonly type: string;
  readonly title: string | null;
  /** True only for a supergroup with topics switched on. */
  readonly isForum: boolean;
}

export type TelegramChatDescriptionOutcome =
  | { readonly outcome: 'SUCCEEDED'; readonly chat: TelegramChatDescription }
  | Exclude<TelegramSendOutcome, { outcome: 'SUCCEEDED' }>;

/**
 * Describe one chat (`getChat`). A READ: the operations group panel asks it before the
 * group is declared healthy, because a group whose topics were switched off cannot hold
 * the topics Nexa owns.
 */
export async function telegramGetChat(
  request: Omit<TelegramSendRequest, 'body' | 'method'> & { readonly chatId: string },
): Promise<TelegramChatDescriptionOutcome> {
  assertOutsideTransaction('A Telegram getChat');

  const { chatId, ...rest } = request;
  const call = await telegramCall({ ...rest, method: 'getChat', body: { chat_id: chatId } });
  if (call.outcome !== 'SUCCEEDED') return call;

  const result = call.result;
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    return {
      outcome: 'FAILED_PERMANENT',
      errorCode: 'telegram.rejected.chat_shape',
      errorMessage: 'getChat answered without a Chat object.',
    };
  }
  const fields = result as Record<string, unknown>;
  if (typeof fields.type !== 'string') {
    return {
      outcome: 'FAILED_PERMANENT',
      errorCode: 'telegram.rejected.chat_shape',
      errorMessage: 'getChat answered without a chat type.',
    };
  }
  return {
    outcome: 'SUCCEEDED',
    chat: {
      type: fields.type,
      title: typeof fields.title === 'string' ? fields.title : null,
      isForum: fields.is_forum === true,
    },
  };
}

export type TelegramForumTopicOutcome =
  | { readonly outcome: 'SUCCEEDED'; readonly messageThreadId: number }
  | Exclude<TelegramSendOutcome, { outcome: 'SUCCEEDED' }>;

/**
 * Create one forum topic (`createForumTopic`) and return its `message_thread_id`.
 *
 * NOT idempotent at Telegram: two calls make two topics. The caller holds a claim on the
 * topic's registry row before calling, which is what makes a repeated setup create one.
 * A 2xx without a usable thread id is refused, like `getMe`'s, rather than stored as a
 * topic nobody can post to.
 */
export async function telegramCreateForumTopic(
  request: Omit<TelegramSendRequest, 'body' | 'method'> & {
    readonly chatId: string;
    readonly name: string;
  },
): Promise<TelegramForumTopicOutcome> {
  assertOutsideTransaction('A Telegram createForumTopic');

  const { chatId, name, ...rest } = request;
  const call = await telegramCall({
    ...rest,
    method: 'createForumTopic',
    // Telegram bounds a topic name at 128 characters.
    body: { chat_id: chatId, name: name.slice(0, 128) },
  });
  if (call.outcome !== 'SUCCEEDED') return call;

  const result = call.result;
  const threadId =
    result !== null && typeof result === 'object' && !Array.isArray(result)
      ? (result as Record<string, unknown>).message_thread_id
      : undefined;
  if (typeof threadId !== 'number' || !Number.isSafeInteger(threadId) || threadId <= 0) {
    return {
      outcome: 'FAILED_PERMANENT',
      errorCode: 'telegram.rejected.forum_topic_shape',
      errorMessage: 'createForumTopic answered without a message_thread_id.',
    };
  }
  return { outcome: 'SUCCEEDED', messageThreadId: threadId };
}

/**
 * Whether a refusal says the forum topic it was addressed to no longer exists.
 *
 * Telegram answers a post into a deleted topic with a 400 whose description is
 * "message thread not found" (older servers: `TOPIC_DELETED`, `TOPIC_ID_INVALID`). It is
 * the one signal a deleted topic gives — there is no service message for a deletion — so
 * it is matched here, in one place, rather than by every caller.
 */
export function isMissingForumTopicError(errorMessage: string): boolean {
  return /message thread not found|TOPIC_DELETED|TOPIC_ID_INVALID/i.test(errorMessage);
}

/**
 * Whether a refusal says the bot cannot use the CHAT at all — removed, banned, not a
 * member, or without the right to post — as opposed to one message being wrong.
 */
export function chatAccessProblemOf(
  errorMessage: string,
): 'BOT_REMOVED' | 'CHAT_UNREACHABLE' | 'CANNOT_SEND' | null {
  if (
    /bot was kicked|bot is not a member|user is deactivated|bot was blocked/i.test(errorMessage)
  ) {
    return 'BOT_REMOVED';
  }
  if (/chat not found|group chat was upgraded|chat was deleted/i.test(errorMessage)) {
    return 'CHAT_UNREACHABLE';
  }
  if (
    /not enough rights|have no rights|CHAT_WRITE_FORBIDDEN|need administrator rights/i.test(
      errorMessage,
    )
  ) {
    return 'CANNOT_SEND';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Telegram Stars (Package A, `docs/package-a-telegram-stars-audit.md`)
// ---------------------------------------------------------------------------

/**
 * Send a Telegram Stars invoice (`sendInvoice`) to one chat.
 *
 * The body is fixed here, not by a caller, because every field is a rule of the brief
 * (A2) rather than a choice: `currency` is `XTR`, `provider_token` is the EMPTY string
 * (Stars take none), there is exactly ONE price, and there are no tips, no shipping, no
 * flexible price and no subscription period — Telegram charges what the one price says,
 * and nothing a customer can adjust.
 *
 * `payload` is the attempt's opaque provider order id: it names no customer, order,
 * secret or token, and it is what `pre_checkout_query` and `successful_payment` hand back.
 *
 * The outcome is the shared taxonomy, and the CALLER decides what it means for an
 * invoice. A readable refusal is a refusal; a timeout, a network error, a 5xx and an
 * unreadable 2xx all leave it unknown whether the invoice reached the chat.
 */
export async function telegramSendInvoice(
  request: Omit<TelegramSendRequest, 'body' | 'method'> & {
    readonly chatId: string;
    readonly title: string;
    readonly description: string;
    readonly payload: string;
    readonly priceLabel: string;
    readonly stars: bigint;
  },
): Promise<TelegramSendOutcome> {
  assertOutsideTransaction('A Telegram sendInvoice');

  const { chatId, title, description, payload, priceLabel, stars, ...rest } = request;
  const amount = Number(stars);
  if (!Number.isSafeInteger(amount) || amount < 1) {
    return {
      outcome: 'FAILED_PERMANENT',
      errorCode: 'telegram.rejected.stars_amount',
      errorMessage: 'A Stars invoice needs a positive whole number of Stars.',
    };
  }
  return telegramSend({
    ...rest,
    method: 'sendInvoice',
    body: {
      chat_id: chatId,
      title,
      description,
      payload,
      provider_token: '',
      currency: 'XTR',
      prices: [{ label: priceLabel, amount }],
    },
  });
}

/**
 * Answer a `pre_checkout_query` (`answerPreCheckoutQuery`).
 *
 * Telegram waits ten seconds for this and then cancels the payment, so the caller
 * answers inside the webhook request. `errorMessage` is shown to the customer, and is
 * required by Telegram when `ok` is false: it is the rendered template sentence, never a
 * reason (the reason would tell a stranger which payloads exist).
 */
export async function telegramAnswerPreCheckoutQuery(
  request: Omit<TelegramSendRequest, 'body' | 'method'> & {
    readonly preCheckoutQueryId: string;
    readonly ok: boolean;
    readonly errorMessage: string | null;
  },
): Promise<TelegramSendOutcome> {
  assertOutsideTransaction('A Telegram answerPreCheckoutQuery');

  const { preCheckoutQueryId, ok, errorMessage, ...rest } = request;
  const call = await telegramCall({
    ...rest,
    method: 'answerPreCheckoutQuery',
    body: {
      pre_checkout_query_id: preCheckoutQueryId,
      ok,
      ...(ok || errorMessage === null ? {} : { error_message: errorMessage }),
    },
  });
  if (call.outcome !== 'SUCCEEDED') return call;
  // Answers `result: true`. No id to carry.
  return { outcome: 'SUCCEEDED', messageId: null };
}

// ---------------------------------------------------------------------------
// Telegram Business (TB1, ADR-0033)
// ---------------------------------------------------------------------------

export type TelegramBusinessConnectionOutcome =
  | { readonly outcome: 'SUCCEEDED'; readonly connection: unknown }
  | Exclude<TelegramSendOutcome, { outcome: 'SUCCEEDED' }>;

/**
 * Read one Business connection (`getBusinessConnection`). A READ: it changes nothing.
 *
 * The result is returned RAW, for the business module's strict parser
 * (`parseBusinessConnection`) — the one place a `BusinessConnection` is read, so the
 * webhook and this call can never disagree about what a connection says.
 */
export async function telegramGetBusinessConnection(
  request: Omit<TelegramSendRequest, 'body' | 'method'> & { readonly businessConnectionId: string },
): Promise<TelegramBusinessConnectionOutcome> {
  assertOutsideTransaction('A Telegram getBusinessConnection');

  const { businessConnectionId, ...rest } = request;
  const call = await telegramCall({
    ...rest,
    method: 'getBusinessConnection',
    body: { business_connection_id: businessConnectionId },
  });
  if (call.outcome !== 'SUCCEEDED') return call;
  return { outcome: 'SUCCEEDED', connection: call.result };
}

/**
 * A plain-text `sendMessage` ON BEHALF OF a connected Business account.
 *
 * Plain text, never `parse_mode`: the text is an operator's or a validated AI reply, and
 * markup in it would be a way to make the business account say something it did not
 * appear to. `reply_parameters` carries no `chat_id` — "Not supported for messages sent on
 * behalf of a business account" — and `allow_sending_without_reply`, which Telegram forces
 * to true for these anyway.
 */
export function businessTextMessageBody(input: {
  readonly businessConnectionId: string;
  readonly chatId: string;
  readonly text: string;
  readonly replyToMessageId?: number;
}): Record<string, unknown> {
  return {
    business_connection_id: input.businessConnectionId,
    chat_id: input.chatId,
    text: input.text,
    link_preview_options: { is_disabled: true },
    ...(input.replyToMessageId === undefined
      ? {}
      : {
          reply_parameters: {
            message_id: input.replyToMessageId,
            allow_sending_without_reply: true,
          },
        }),
  };
}
