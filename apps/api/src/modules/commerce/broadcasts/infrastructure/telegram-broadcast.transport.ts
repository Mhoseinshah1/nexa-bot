import {
  BROADCAST_BODY_DEFINITION,
  isSourcedBroadcastKind,
  type BroadcastButton,
  type BroadcastContentKind,
  type TemplateValues,
  type TenantContext,
} from '@nexa/contracts';
import { renderTemplateBody } from '@nexa/i18n';
import {
  telegramButtonMarkup,
  telegramSend,
  textMessageBody,
  type TelegramRequest,
  type TelegramSendOutcome,
} from '../../../../infrastructure/telegram/send-message.js';
import {
  TELEGRAM_CAPTION_MAX,
  TELEGRAM_MESSAGE_MAX,
} from '../../messaging/application/message-split.js';
import type {
  BotInstanceTokenSource,
  CustomerTemplateRenderer,
} from '../../messaging/infrastructure/telegram-customer-messenger.js';
import type {
  BroadcastDeliverRequest,
  BroadcastPinResult,
  BroadcastRenderRequest,
  BroadcastRenderResult,
  BroadcastSendResult,
  BroadcastTransport,
} from '../application/ports.js';

/** The kinds sent from bytes this installation holds. */
type MediaKind = Exclude<BroadcastContentKind, 'TEXT' | 'FORWARD' | 'COPY'>;
const METHOD: Readonly<Record<MediaKind, 'sendPhoto' | 'sendVideo' | 'sendDocument'>> = {
  PHOTO: 'sendPhoto',
  VIDEO: 'sendVideo',
  DOCUMENT: 'sendDocument',
};
const FIELD: Readonly<Record<MediaKind, 'photo' | 'video' | 'document'>> = {
  PHOTO: 'photo',
  VIDEO: 'video',
  DOCUMENT: 'document',
};

/**
 * Telegram's answers that mean the CHAT cannot be reached — the customer blocked the bot,
 * deleted their account, or never opened a chat — as opposed to a message refused on its
 * merits. Matched on Telegram's description, which is read here and never stored: the
 * recipient row keeps only the transport code.
 */
const UNREACHABLE_DESCRIPTIONS =
  /chat not found|user is deactivated|bot was blocked|bot can't initiate|peer_id_invalid|user not found/i;

/** A URL button's link, parsed for real: the contract's pattern has no URL parser to call. */
function openable(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'tg:';
  } catch {
    return false;
  }
}

function keyboard(buttons: readonly BroadcastButton[]): Record<string, unknown>[][] {
  return telegramButtonMarkup(buttons.map((button) => ({ text: button.label, url: button.url })));
}

/**
 * The broadcast lane's Telegram transport (round N, B1).
 *
 * Its own class rather than `TelegramCustomerMessenger.send`, because a broadcast's text is
 * the OPERATOR's, not a template key: it is rendered here against the explicit placeholder
 * catalogue (`BROADCAST_BODY_DEFINITION`) by the one renderer (`renderTemplateBody`) and then
 * wrapped in the tenant's `bot.broadcast.message` template. Everything about the HTTP call is
 * still `telegramSend`'s — the timeout, `redirect: 'error'`, the retryable/permanent
 * taxonomy — and the token is the one of the bot the recipient wrote to.
 *
 * Plain text only, deliberately: an operator's HTML that Telegram cannot parse would be a 400
 * for every recipient of a fifty-thousand-chat send.
 */
export class TelegramBroadcastTransport implements BroadcastTransport {
  constructor(
    private readonly templates: CustomerTemplateRenderer,
    private readonly bots: BotInstanceTokenSource,
    private readonly apiBaseUrl: string,
    private readonly timeoutMs: number,
  ) {}

  async render(
    scope: TenantContext,
    request: BroadcastRenderRequest,
  ): Promise<BroadcastRenderResult> {
    if (isSourcedBroadcastKind(request.contentKind)) {
      /*
       * Round N close (§C): nothing is rendered. `forwardMessage` sends the message as it
       * is and takes no keyboard; `copyMessage` keeps the original caption when none is
       * given and may carry an inline keyboard (Bot API 10.3).
       */
      if (request.source === null) return { ok: false, errorCode: 'broadcast.source_required' };
      if (request.contentKind === 'FORWARD' && request.buttons.length > 0) {
        return { ok: false, errorCode: 'broadcast.source_content_invalid' };
      }
      if (!request.buttons.every((button) => openable(button.url))) {
        return { ok: false, errorCode: 'broadcast.button_invalid' };
      }
      return {
        ok: true,
        rendered: {
          contentKind: request.contentKind,
          text: '',
          buttons: request.buttons,
          source: request.source,
        },
      };
    }
    const values: Record<string, TemplateValues[string]> = {};
    if (request.facts.firstName !== null) values.firstName = request.facts.firstName;
    if (request.facts.username !== null) values.username = request.facts.username;
    if (request.facts.walletBalance !== null) values.walletBalance = request.facts.walletBalance;
    const own = renderTemplateBody(BROADCAST_BODY_DEFINITION, request.body, values);
    const text =
      request.contentKind !== 'TEXT' && own.trim().length === 0
        ? ''
        : await this.templates.render(scope, 'bot.broadcast.message', { message: own });
    if (request.contentKind === 'TEXT') {
      if (text.trim().length === 0) return { ok: false, errorCode: 'broadcast.text_empty' };
      if (text.length > TELEGRAM_MESSAGE_MAX) {
        return { ok: false, errorCode: 'broadcast.text_over_bound' };
      }
    } else if (text.length > TELEGRAM_CAPTION_MAX) {
      return { ok: false, errorCode: 'broadcast.caption_over_bound' };
    }
    if (!request.buttons.every((button) => openable(button.url))) {
      return { ok: false, errorCode: 'broadcast.button_invalid' };
    }
    return {
      ok: true,
      rendered: { contentKind: request.contentKind, text, buttons: request.buttons, source: null },
    };
  }

  async deliver(
    scope: TenantContext,
    request: BroadcastDeliverRequest,
  ): Promise<BroadcastSendResult> {
    const token = await this.bots.tokenForBotInstance(scope, request.botInstanceId as never);
    if (token === null) return { outcome: 'BOT_UNAVAILABLE', errorCode: 'broadcast.no_bot' };
    const { rendered } = request;
    const base = { token, apiBaseUrl: this.apiBaseUrl, timeoutMs: this.timeoutMs };
    const markup = rendered.buttons.length === 0 ? null : keyboard(rendered.buttons);

    let call: TelegramRequest;
    if (isSourcedBroadcastKind(rendered.contentKind)) {
      if (rendered.source === null) {
        return { outcome: 'REFUSED', errorCode: 'broadcast.source_required' };
      }
      /*
       * `forwardMessage(chat_id, from_chat_id, message_id)` returns the sent Message;
       * `copyMessage(chat_id, from_chat_id, message_id[, reply_markup])` returns a MessageId.
       * Both carry `message_id`, which `telegramSend` reads for the pin. The source chat id
       * is a number or an `@username`, passed as the string it was given: Telegram accepts
       * either form for `from_chat_id`.
       */
      call = {
        ...base,
        method: rendered.contentKind === 'FORWARD' ? 'forwardMessage' : 'copyMessage',
        body: {
          chat_id: request.chatId,
          from_chat_id: rendered.source.chatId,
          message_id: rendered.source.messageId,
          ...(markup === null || rendered.contentKind === 'FORWARD'
            ? {}
            : { reply_markup: { inline_keyboard: markup } }),
        },
      };
    } else if (rendered.contentKind === 'TEXT') {
      call = {
        ...base,
        body: textMessageBody({
          chatId: request.chatId,
          text: rendered.text,
          html: false,
          buttons: rendered.buttons.map((button) => ({ text: button.label, url: button.url })),
        }),
      };
    } else {
      const kind = rendered.contentKind;
      if (request.media === null) {
        return { outcome: 'REFUSED', errorCode: 'broadcast.media_unavailable' };
      }
      if (request.media.kind === 'FILE_ID') {
        call = {
          ...base,
          method: METHOD[kind],
          body: {
            chat_id: request.chatId,
            [FIELD[kind]]: request.media.fileId,
            ...(rendered.text.length > 0 ? { caption: rendered.text } : {}),
            ...(markup === null ? {} : { reply_markup: { inline_keyboard: markup } }),
          },
        };
      } else {
        const fields: Record<string, string> = { chat_id: request.chatId };
        if (rendered.text.length > 0) fields.caption = rendered.text;
        if (markup !== null) fields.reply_markup = JSON.stringify({ inline_keyboard: markup });
        call = {
          ...base,
          method: METHOD[kind],
          multipart: {
            fields,
            file: {
              field: FIELD[kind],
              fileName: request.media.fileName,
              mimeType: request.media.mimeType,
              bytes: request.media.bytes,
            },
          },
        };
      }
    }
    return classify(await telegramSend(call));
  }

  /**
   * ONE `pinChatMessage` (round N close, §C): "In private chats … all non-service messages
   * can be pinned" without any right (Bot API 10.3), so a bot that could send here can pin
   * here. `disable_notification` is passed although "notifications are always disabled in
   * channels and private chats", so the intent is on the wire whatever chat this is.
   */
  async pin(
    scope: TenantContext,
    request: {
      readonly chatId: string;
      readonly botInstanceId: string;
      readonly messageId: number;
    },
  ): Promise<BroadcastPinResult> {
    const token = await this.bots.tokenForBotInstance(scope, request.botInstanceId as never);
    if (token === null) return { outcome: 'FAILED', errorCode: 'broadcast.no_bot' };
    return classifyPin(
      await telegramSend({
        token,
        apiBaseUrl: this.apiBaseUrl,
        timeoutMs: this.timeoutMs,
        method: 'pinChatMessage',
        body: {
          chat_id: request.chatId,
          message_id: request.messageId,
          disable_notification: true,
        },
      }),
    );
  }
}

/**
 * A pin's answer. One attempt, so a 429 is this attempt's FAILURE (the bot is not held: the
 * pin is not the send, and a rate-limited pin must not stall thousands of sends); a timeout
 * or 5xx may have pinned and is UNKNOWN; anything readable is FAILED with its code.
 */
export function classifyPin(outcome: TelegramSendOutcome): BroadcastPinResult {
  if (outcome.outcome === 'SUCCEEDED') return { outcome: 'PINNED' };
  const code = outcome.errorCode.slice(0, 100);
  if (outcome.outcome === 'FAILED_RETRYABLE' && code !== 'telegram.rate_limited') {
    return { outcome: 'UNKNOWN', errorCode: code };
  }
  return { outcome: 'FAILED', errorCode: code };
}

/**
 * The transport's answer, in the lane's vocabulary. A 429 is recognised by its code, not by
 * the presence of `retry_after` (Telegram may omit it); every other retryable failure MAY have
 * been delivered and is UNKNOWN; a 401 is the bot, not the message.
 */
export function classify(outcome: TelegramSendOutcome): BroadcastSendResult {
  if (outcome.outcome === 'SUCCEEDED') {
    return {
      outcome: 'SENT',
      ...(outcome.file === undefined ? {} : { fileId: outcome.file.fileId }),
      ...(outcome.messageId === null ? {} : { messageId: outcome.messageId }),
    };
  }
  if (outcome.outcome === 'FAILED_RETRYABLE') {
    if (outcome.errorCode === 'telegram.rate_limited') {
      return outcome.retryAfterMs === undefined
        ? { outcome: 'RATE_LIMITED' }
        : { outcome: 'RATE_LIMITED', retryAfterMs: outcome.retryAfterMs };
    }
    return { outcome: 'UNKNOWN', errorCode: outcome.errorCode.slice(0, 100) };
  }
  const code = outcome.errorCode.slice(0, 100);
  if (code === 'telegram.rejected.401' || code === 'telegram.rejected.404') {
    return { outcome: 'BOT_UNAVAILABLE', errorCode: code };
  }
  if (code === 'telegram.rejected.403' || UNREACHABLE_DESCRIPTIONS.test(outcome.errorMessage)) {
    return { outcome: 'UNREACHABLE', errorCode: code };
  }
  return { outcome: 'REFUSED', errorCode: code };
}
