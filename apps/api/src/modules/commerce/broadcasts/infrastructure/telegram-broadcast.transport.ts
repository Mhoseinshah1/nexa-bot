import {
  BROADCAST_BODY_DEFINITION,
  broadcastActionCallbackData,
  isBroadcastActionButton,
  isSourcedBroadcastKind,
  type BroadcastButton,
  type BroadcastContentKind,
  type TemplateValues,
  type TenantContext,
} from '@nexa/contracts';
import { renderTemplateBody, type TemplatePresentation } from '@nexa/i18n';
import {
  plainTableText,
  richBlocksFromText,
  richButtonLayout,
  richMessageBody,
} from '../../../../infrastructure/telegram/rich-message.js';
import type { RichMessageSupport } from '../../messaging/application/rich-messages.js';
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
  RecipientFacts,
} from '../application/ports.js';

/**
 * One recipient's broadcast body, from the explicit placeholder catalogue
 * (`BROADCAST_BODY_DEFINITION`) and the facts read for THAT recipient at send time — the one
 * renderer, so a test of every placeholder is a test of what is sent. An absent fact drops its
 * line; `{phone}` with no number on the row renders empty (the owner's "empty otherwise").
 */
export function renderBroadcastBody(
  body: string,
  facts: RecipientFacts,
  presentation?: TemplatePresentation,
): string {
  const values: Record<string, TemplateValues[string]> = {};
  if (facts.firstName !== null) values.firstName = facts.firstName;
  if (facts.username !== null) values.username = facts.username;
  if (facts.walletBalance !== null) values.walletBalance = facts.walletBalance;
  // R4 A6.
  if (facts.telegramId !== undefined && facts.telegramId !== null)
    values.telegramId = facts.telegramId;
  if (facts.phone !== undefined) values.phone = facts.phone ?? '';
  if (facts.servicesTotal !== undefined) values.servicesTotal = facts.servicesTotal;
  if (facts.servicesActive !== undefined) values.servicesActive = facts.servicesActive;
  if (facts.today !== undefined) values.today = facts.today;
  return renderTemplateBody(BROADCAST_BODY_DEFINITION, body, values, undefined, presentation);
}

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

/**
 * D2-F1 (roadmap C1). On a FORWARD or COPY the request names TWO chats — the recipient
 * (`chat_id`) and the source (`from_chat_id`) — and Telegram's "chat not found" /
 * `PEER_ID_INVALID` does not say which. When it is the SOURCE (a channel the recipient's bot is
 * not in), calling it the recipient's unreachability would be final and wrong for every
 * recipient of that bot. So on a sourced send these two answers are a refusal: FAILED with the
 * transport's code, shown per bot, and re-queueable once the bot can reach the source. The
 * answers that can only be about the recipient (blocked, deactivated, never started) stay
 * UNREACHABLE.
 */
const AMBIGUOUS_ON_SOURCED_SEND = /chat not found|peer_id_invalid/i;

/**
 * A button that can be sent: an in-bot action is a closed code (R4 A6) and always can; a URL
 * button's link is parsed for real, since the contract's pattern has no URL parser to call.
 */
function openable(button: BroadcastButton): boolean {
  if (isBroadcastActionButton(button)) return true;
  try {
    const parsed = new URL(button.url);
    return parsed.protocol === 'https:' || parsed.protocol === 'tg:';
  } catch {
    return false;
  }
}

/**
 * One broadcast button as the transport sends it: a link opens its URL; an in-bot action
 * carries `bc:<ACTION>` as `callback_data`, which the Telegram surface turns into the SAME
 * command its main-menu entry is (R4 A6). Mixed freely in one keyboard, one per row.
 */
export function broadcastTelegramButton(
  button: BroadcastButton,
):
  | { readonly text: string; readonly url: string }
  | { readonly text: string; readonly data: string } {
  return isBroadcastActionButton(button)
    ? { text: button.label, data: broadcastActionCallbackData(button.action) }
    : { text: button.label, url: button.url };
}

function keyboard(buttons: readonly BroadcastButton[]): Record<string, unknown>[][] {
  return telegramButtonMarkup(buttons.map(broadcastTelegramButton));
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
    /**
     * R4 A6: the tenant's zone and calendar, so `{today}` is the Jalali date in the tenant's
     * zone. Absent (an older wiring), the renderer's own default presentation applies.
     */
    private readonly presentations?: {
      presentationFor(scope: TenantContext): Promise<TemplatePresentation>;
    },
    /**
     * R5C-2 B2/B3: «دکمه‌های داخل پیام». With it on, a TEXT broadcast is sent through the same
     * rich blocks every other inline-button screen uses — its buttons INSIDE the message and a
     * hand-written table as a table block. Absent, or off, it is the ordinary message it
     * always was, with any table as plain lines.
     */
    private readonly rich?: RichMessageSupport,
  ) {}

  /** The tenant's switch, remembered for a minute: a broadcast asks once per recipient. */
  private readonly bubbleCache = new Map<
    string,
    { readonly until: number; readonly on: boolean }
  >();

  private async buttonsInBubble(scope: TenantContext): Promise<boolean> {
    const rich = this.rich;
    if (rich === undefined) return false;
    const now = rich.now().getTime();
    const key = String(scope.tenantId);
    const cached = this.bubbleCache.get(key);
    if (cached !== undefined && cached.until > now) return cached.on;
    let on = false;
    try {
      on = (await rich.modeFor(scope)).enabled;
    } catch {
      // Unreadable is off: today's behaviour, never a failed broadcast.
      on = false;
    }
    this.bubbleCache.set(key, { until: now + 60_000, on });
    return on;
  }

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
      if (!request.buttons.every(openable)) {
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
    const own = renderBroadcastBody(
      request.body,
      request.facts,
      await this.presentations?.presentationFor(scope),
    );
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
    if (!request.buttons.every(openable)) {
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
      const ordinary: TelegramRequest = {
        ...base,
        body: textMessageBody({
          chatId: request.chatId,
          text: plainTableText(rendered.text),
          html: false,
          buttons: rendered.buttons.map(broadcastTelegramButton),
        }),
      };
      const blocks = (await this.buttonsInBubble(scope))
        ? richBlocksFromText({ text: rendered.text, html: false, customEmoji: false })
        : null;
      if (blocks === null) {
        call = ordinary;
      } else {
        const layout = richButtonLayout(rendered.buttons.map(broadcastTelegramButton));
        const first = await telegramSend({
          ...base,
          method: 'sendRichMessage',
          body: richMessageBody({
            chatId: request.chatId,
            blocks: [...blocks, ...layout.blocks],
            inlineRows: layout.inline,
          }),
        });
        /*
         * One resend the ordinary way, and only for Telegram saying the REQUEST was bad
         * (400): a blocked user (403), a dead bot (401/404), a rate limit or an ambiguous
         * outcome are answers about the recipient or the bot, and a second request would only
         * repeat them — or duplicate a message that may have arrived.
         */
        if (first.outcome === 'FAILED_PERMANENT' && first.errorCode === 'telegram.rejected.400') {
          call = ordinary;
        } else {
          return classify(first);
        }
      }
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
            ...(rendered.text.length > 0 ? { caption: plainTableText(rendered.text) } : {}),
            ...(markup === null ? {} : { reply_markup: { inline_keyboard: markup } }),
          },
        };
      } else {
        const fields: Record<string, string> = { chat_id: request.chatId };
        if (rendered.text.length > 0) fields.caption = plainTableText(rendered.text);
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
    return classify(await telegramSend(call), {
      sourced: isSourcedBroadcastKind(rendered.contentKind),
    });
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
export function classify(
  outcome: TelegramSendOutcome,
  request: { readonly sourced: boolean } = { sourced: false },
): BroadcastSendResult {
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
  // D2-F1: on a forward or copy, an answer that may name the SOURCE chat is not the
  // recipient's unreachability (see AMBIGUOUS_ON_SOURCED_SEND).
  if (request.sourced && AMBIGUOUS_ON_SOURCED_SEND.test(outcome.errorMessage)) {
    return { outcome: 'REFUSED', errorCode: code };
  }
  if (code === 'telegram.rejected.403' || UNREACHABLE_DESCRIPTIONS.test(outcome.errorMessage)) {
    return { outcome: 'UNREACHABLE', errorCode: code };
  }
  return { outcome: 'REFUSED', errorCode: code };
}
