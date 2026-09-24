import type {
  BotInstanceId,
  OperationalEventRecorder,
  ScopeContext,
  TemplateKey,
  TemplateValues,
  TenantContext,
} from '@nexa/contracts';
import { ADMIN_MENU_BUTTON, MAIN_MENU_ROWS, errors, templateDefinition } from '@nexa/contracts';
import { CATALOGUE_FA, formatMoney } from '@nexa/i18n';
import {
  callbackAnswerBody,
  fileMessageBody,
  fileUploadBody,
  telegramSend,
  textMessageBody,
  type TelegramButton,
  type TelegramRequest,
  type TelegramSendOutcome,
} from '../../../../infrastructure/telegram/send-message.js';
import {
  splitMessageBody,
  TELEGRAM_CAPTION_MAX,
  TELEGRAM_MESSAGE_MAX,
  worstOutcome,
} from '../application/message-split.js';
import type {
  CustomerButton,
  CustomerButtonLabel,
  CustomerButtonRow,
  CustomerFileMessage,
  CustomerMessage,
  CustomerMessenger,
  CustomerSendConditionReader,
  CustomerSendResult,
} from '../application/ports.js';

/**
 * ONE condition per bot instance: "this bot is not replying to customers".
 *
 * It used to be three codes — `telegram.customer_send_no_bot`,
 * `_unknown` and `_refused` — and all three were deduplicated conditions that
 * nothing ever resolved. An unresolved condition is worse than no condition at
 * all: `operational-event-projector.ts` suppresses an occurrence that is neither
 * new nor reopened, so the FIRST transient Telegram failure opened the row and
 * every later failure through that bot — including a real outage weeks later —
 * was silently folded onto it and announced to nobody.
 *
 * Three codes could not be fixed by adding a recovery, because `recoversCode` is
 * singular and their dedupe key was `${errorCode}:${botInstanceId}` — an
 * unbounded set of keys a recovery cannot enumerate, and one that did not carry
 * its own code, so two codes could collide on one key and the loser would
 * increment a row belonging to the winner.
 *
 * So the operator-facing question is asked once — "are customers getting replies
 * from this bot?" — and the three answers become `reason` in the context, which
 * the recorder rewrites on every occurrence. Severity is fixed at ERROR because
 * a deduplicated row keeps the severity it was first recorded with; of the three
 * it replaces, ERROR is the one that cannot cause a condition to fall under an
 * installation's notification threshold unseen.
 *
 * Reshaping an operational-event code strands every row still open under the old
 * one, which is why CLAUDE.md permits it only in the release that introduced the
 * code. This is that release: all three codes are introduced by this unmerged
 * branch and no installation has a row under any of them.
 */
export const CUSTOMER_SEND_FAILED_CODE = 'telegram.customer_send_failed';

/**
 * The recovery, and deliberately NOT deduplicated.
 *
 * Its whole job is to close the failure row, and a row of its own would need
 * closing in turn — by the next failure, whose one `recoversCode` is already
 * spent. `panel.health.restored` is the same shape for the same reason. It is
 * bounded because it is only written when the condition is actually open, so
 * there is one of these per failure-to-recovery transition and not one per
 * message: a recovery on every successful send would make this table a send log
 * and, deduplicated, would serialise every reply through one locked row.
 */
export const CUSTOMER_SEND_OK_CODE = 'telegram.customer_send_ok';

/**
 * The dedupe key for one bot's failure condition.
 *
 * One function, because the format IS the identity: a recovery that computed it
 * differently from the condition it names would resolve nothing, silently, and
 * leave an open ERROR for a bot that is fine. `panelConditionKey` exists for
 * exactly this reason and records the same lesson.
 */
export function customerSendConditionKey(botInstanceId: BotInstanceId): string {
  return `${CUSTOMER_SEND_FAILED_CODE}:${botInstanceId}`;
}

/** A button's row, as a spreadable fragment, so `exactOptionalPropertyTypes` stays satisfied. */
function rowOf(button: { readonly row?: CustomerButtonRow }): { row?: number } {
  return button.row === undefined ? {} : { row: button.row };
}

/** Why a reply did not certainly reach the customer. Context, never a code. */
type SendFailureReason = 'NO_BOT' | 'UNCERTAIN' | 'REFUSED';

/** What the customer is told about a send, and what the operator's log is told. */
interface ClassifiedOutcome {
  readonly sent: CustomerSendResult;
  readonly errorCode: string | null;
}

/**
 * A URL button's link: `https://` or `tg://`, and the ORIGINAL string, unchanged.
 *
 * Refused rather than sent: an `http://` link to a subscription is the credential over
 * plaintext, and a scheme Telegram does not open is a button that does nothing when
 * tapped — which no test asserting "the button is there" would catch. The string is
 * returned as given rather than as `URL.href`, because the parser normalises — a
 * trailing slash, percent-encoding, case in the host — and a subscription URL that
 * arrives at the client one byte different from the one in the message is two
 * subscriptions.
 */
function validatedButtonUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw errors.validation('messaging.button_url_invalid', 'A URL button needs a valid URL.');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'tg:') {
    throw errors.validation(
      'messaging.button_url_scheme',
      'A URL button opens https:// or tg:// and nothing else.',
      { scheme: parsed.protocol },
    );
  }
  return url;
}

/**
 * What this needs in order to turn a template key into bytes on the wire.
 *
 * Two narrow ports rather than the template service and the tenant repository, so this
 * cannot acquire the ability to read anything else. The renderer is the tenant's — an
 * override matters most in exactly the messages a customer reads.
 */
export interface CustomerTemplateRenderer {
  /**
   * The tenant's rendered text, raw values in and a string out.
   *
   * The signature is the existing `TemplateResolver.render`, deliberately unchanged: it
   * validates the values against the key's declaration on the way out, so a missing
   * required token throws here rather than sending a customer a literal `{token}`. That
   * check is the one the legacy system does not have.
   */
  render(scope: ScopeContext, key: TemplateKey, values: TemplateValues): Promise<string>;
}

export interface BotInstanceTokenSource {
  /** The decrypted token for ONE bot instance, or null when it is gone or disabled. */
  tokenForBotInstance(scope: ScopeContext, botInstanceId: BotInstanceId): Promise<string | null>;
}

/**
 * Customer-facing Telegram, for real.
 *
 * Everything about the HTTP call comes from `telegramSend`, the one implementation, so
 * this file holds only what is specific to talking to a customer:
 *
 * - the token is the one belonging to the bot the customer WROTE to, never "the
 *   tenant's active bot";
 * - the text comes from the tenant's rendered template, never a literal;
 * - a failure is returned rather than thrown, and an UNKNOWN outcome is recorded as an
 *   operational event so somebody can see it — without retrying, because a retried
 *   customer message is either noise or a contradiction.
 */
export class TelegramCustomerMessenger implements CustomerMessenger {
  constructor(
    private readonly templates: CustomerTemplateRenderer,
    private readonly bots: BotInstanceTokenSource,
    private readonly opsLog: OperationalEventRecorder,
    private readonly conditions: CustomerSendConditionReader,
    private readonly apiBaseUrl: string,
    private readonly timeoutMs: number,
  ) {}

  async send(scope: TenantContext, message: CustomerMessage): Promise<CustomerSendResult> {
    const token = await this.bots.tokenForBotInstance(scope, message.botInstanceId);
    if (token === null) {
      // Not an exception: a bot an operator disabled between the update arriving and
      // the reply being sent is an ordinary race, and the customer's arrival is already
      // committed. Recorded so the operator can see that replies are going nowhere.
      await this.recordFailure(scope, message, 'NO_BOT', null);
      return { outcome: 'REFUSED' };
    }

    const text = await this.templates.render(scope, message.templateKey, message.values);
    /*
     * The FORMAT is a property of the key, read from the frozen catalogue.
     *
     * Not a flag the caller passes. `templates.ts` declares the format per key precisely
     * so that values interpolated into a `TELEGRAM_HTML` template are escaped and those
     * in a `PLAIN_TEXT` one are not — and a caller-supplied flag would let one call site
     * send a subscription URL as plain text, or a Persian greeting as unescaped HTML.
     */
    const html = templateDefinition(message.templateKey).format === 'TELEGRAM_HTML';
    /*
     * Button labels are rendered HERE, through the same resolver as the message.
     *
     * A `TEMPLATE` label is the tenant's catalogue text; a `TEXT` label is the tenant's
     * own data — a product title — and its price is formatted with the SHARED
     * `formatMoney`, so an amount on a button and the same amount in the message it
     * belongs to cannot be written two different ways.
     */
    const buttons = await this.labelButtons(scope, message.buttons ?? []);
    /*
     * The main menu's labels come from the SHARED catalogue, not this tenant's.
     *
     * Every other string this messenger sends is the tenant's, and this is the one
     * departure. The four labels are ROUTES: `intentOf` matches a tap against exactly
     * these strings, so the constant that draws the keyboard has to be the constant
     * that matches it. A per-tenant label would let a tenant rename a button into a
     * string nothing routes, and the customer would press it and be told the bot did
     * not understand — with nothing anywhere recording why.
     */
    const customerRows =
      message.keyboard === undefined
        ? undefined
        : MAIN_MENU_ROWS.map((row) => row.map((button) => CATALOGUE_FA[button.label]));
    /*
     * The admin row is APPENDED to the customer rows rather than replacing them.
     *
     * An administrator is also a customer of this bot — the Mirza research confirms the
     * two concepts are independent, and the same person buys a service and reviews a
     * receipt — so taking the catalogue away from them to make room for a panel would
     * be a worse keyboard, not a more secure one.
     */
    const keyboard =
      customerRows === undefined
        ? undefined
        : message.keyboard === 'MAIN_MENU_ADMIN'
          ? [...customerRows, [CATALOGUE_FA[ADMIN_MENU_BUTTON.label]]]
          : customerRows;
    /*
     * A body over Telegram's bound goes as SEVERAL messages, in order, cut by
     * `splitMessageBody` — between paragraphs, then lines, then characters. Telegram
     * refuses a long message outright rather than cutting it, so before this a long
     * list of services was a 400 and a customer with no answer at all.
     *
     * The buttons and the keyboard ride on the LAST part only. A keyboard under the
     * first of three parts is a keyboard under a message the customer has not finished
     * reading, and the same keyboard under every part is three ways to tap one thing.
     *
     * The sequence STOPS at the first part that did not certainly arrive, and the
     * answer is the WORST outcome seen (`worstOutcome`). Sending part three after part
     * two is UNKNOWN gives a customer the end of a message whose middle may be missing,
     * and sending anything after a 429 is a request Telegram has just said it would
     * refuse. A body within the bound — including an empty one, which Telegram refuses
     * and which is reported as it always was — is one part and takes the same path.
     */
    const parts =
      text.length <= TELEGRAM_MESSAGE_MAX ? [text] : splitMessageBody(text, TELEGRAM_MESSAGE_MAX);
    const sequence = parts.length === 0 ? [text] : parts;
    let worst: ClassifiedOutcome = { sent: { outcome: 'DELIVERED' }, errorCode: null };
    for (const [index, part] of sequence.entries()) {
      const last = index === sequence.length - 1;
      const answer = this.classify(
        await telegramSend({
          token,
          apiBaseUrl: this.apiBaseUrl,
          timeoutMs: this.timeoutMs,
          body: textMessageBody({
            chatId: message.chatId,
            text: part,
            html,
            ...(last ? { buttons, ...(keyboard === undefined ? {} : { keyboard }) } : {}),
          }),
        }),
      );
      if (worstOutcome(worst.sent.outcome, answer.sent.outcome) !== worst.sent.outcome) {
        worst = answer;
      }
      if (answer.sent.outcome !== 'DELIVERED') break;
    }

    if (worst.sent.outcome === 'DELIVERED') {
      await this.recordRecovery(scope, message.botInstanceId);
      return worst.sent;
    }
    /*
     * A rate limit is NOT recorded as a failure condition. It is this installation
     * being asked to slow down, not a bot whose replies are going nowhere, and opening
     * the operator condition for it would cry wolf on every busy minute. `classify`
     * carries the rest of the argument.
     */
    if (worst.sent.outcome === 'RATE_LIMITED') return worst.sent;
    await this.recordFailure(
      scope,
      message,
      worst.sent.outcome === 'UNKNOWN' ? 'UNCERTAIN' : 'REFUSED',
      worst.errorCode,
    );
    return worst.sent;
  }

  /**
   * ONE reading of the transport's answer, for `send` and `sendFile` alike.
   *
   * A RATE LIMIT is its own answer, and separating it is the fix ADR 0030 §2 decides.
   * `telegramSend` groups a 429 with a timeout and a 5xx as `FAILED_RETRYABLE`, and this
   * file used to collapse all three into `UNKNOWN`. For a timeout and a 5xx that is
   * right: Telegram may have processed the request. For a 429 it is not — the request
   * was DECLINED, nothing was sent, and the response says when to return. The
   * consequence of the old grouping is measured in `docs/phase4h-audit.md` §6b: `UNKNOWN`
   * becomes `UNCONFIRMED`, which the delivery sweep never re-claims, so one rate limit
   * withheld a paid customer's subscription link until a person noticed.
   *
   * The 429 is recognised by its CODE, not by the presence of `retry_after`. Telegram may
   * omit that number, and `sendFile` used to read its absence as UNKNOWN — a declined
   * upload filed as one that may have arrived. The container promises the receipt push
   * "one 429 classification"; this is it.
   *
   * A retryable failure that is not a 429 is UNCERTAIN, not REFUSED. Every one of those
   * means Telegram may have delivered the message: for a queue that is a reason to try
   * again, for a customer reply it is a reason NOT to, because the customer would see it
   * twice. The distinction is preserved in the outcome and in the event's context.
   */
  private classify(result: TelegramSendOutcome): ClassifiedOutcome {
    if (result.outcome === 'SUCCEEDED') return { sent: { outcome: 'DELIVERED' }, errorCode: null };
    if (result.outcome === 'FAILED_RETRYABLE' && result.errorCode === 'telegram.rate_limited') {
      return {
        sent: {
          outcome: 'RATE_LIMITED',
          ...(result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs }),
        },
        errorCode: result.errorCode,
      };
    }
    return {
      sent: { outcome: result.outcome === 'FAILED_RETRYABLE' ? 'UNKNOWN' : 'REFUSED' },
      errorCode: result.errorCode,
    };
  }

  /**
   * Opens or re-opens the one condition for this bot.
   *
   * The reason and the Telegram error code go in the CONTEXT, which the recorder
   * rewrites on every occurrence, so an operator reading the open row sees why it
   * failed most recently. They are deliberately not in the dedupe key: a dedupe
   * key is a durable column and a 4xx description can quote a chat id, and a key
   * that varies per error is a key a recovery cannot name.
   */
  /**
   * Re-sends a file this installation already holds, by `file_id` (Phase 5T).
   *
   * No bytes and no URL. A `file_id` is Telegram's own handle, scoped to the bot that
   * received the upload, so the media reaches a reviewer without this process
   * downloading it and without the token appearing anywhere but the request itself —
   * which is why `botInstanceId` is required rather than resolved to "the tenant's
   * active bot": the wrong token answers "file not found" for a receipt that exists.
   *
   * `sendPhoto` and `sendDocument` are the two methods, matching the two kinds
   * `PAYMENT_RECEIPT_KINDS` admits. The method is NAMED rather than hard-coded in
   * `telegramSend`, exactly as its own docblock anticipated.
   *
   * A CAPTION and BUTTONS when the caller supplies them (Payment File 02 §10): the first
   * receipt of a review carries the facts and the decisions, so the reviewer reads one
   * message rather than an image and a separate text that can scroll apart. The caption is
   * rendered from its template here, with the key's own format — exactly as `send` does —
   * and the labels through the same `labelButtons`.
   */
  async sendFile(scope: TenantContext, message: CustomerFileMessage): Promise<CustomerSendResult> {
    const token = await this.bots.tokenForBotInstance(scope, message.botInstanceId);
    if (token === null) return { outcome: 'REFUSED' };

    const caption =
      message.caption === undefined
        ? undefined
        : await this.templates.render(scope, message.caption.templateKey, message.caption.values);
    const html =
      message.caption !== undefined &&
      templateDefinition(message.caption.templateKey).format === 'TELEGRAM_HTML';
    /*
     * An HTML caption over Telegram's bound is refused HERE, with a reason, before a
     * request is spent. It cannot be cut: a cut can split a tag or an entity, and the
     * parse error that produces is the same 400 as the length. A plain-text caption is
     * still cut with a visible ellipsis by `boundCaption` in the body builders, which
     * the receipt review's note was sized around. The caller decides the arrangement —
     * typically the file bare and the text as its own message, which `send` will split.
     */
    if (caption !== undefined && html && caption.length > TELEGRAM_CAPTION_MAX) {
      return { outcome: 'REFUSED', reason: 'CAPTION_OVER_BOUND' };
    }
    const buttons = await this.labelButtons(scope, message.buttons ?? []);

    const method = message.kind === 'PHOTO' ? 'sendPhoto' : 'sendDocument';
    const content = {
      chatId: message.chatId,
      kind: message.kind,
      ...(caption === undefined ? {} : { caption, html }),
      buttons,
    };
    /*
     * The two sources are two request shapes and ONE transport call. A `file_id` is a
     * JSON body exactly as before; bytes go up as multipart, and `telegramSend` gives
     * both the same timeout, the same redirect refusal and the same outcome taxonomy.
     */
    const request: TelegramRequest =
      message.source.kind === 'FILE_ID'
        ? {
            token,
            apiBaseUrl: this.apiBaseUrl,
            timeoutMs: this.timeoutMs,
            method,
            body: fileMessageBody({ ...content, fileId: message.source.fileId }),
          }
        : {
            token,
            apiBaseUrl: this.apiBaseUrl,
            timeoutMs: this.timeoutMs,
            method,
            multipart: fileUploadBody({
              ...content,
              bytes: message.source.bytes,
              fileName: message.source.fileName,
              mimeType: message.source.mimeType,
            }),
          };

    /*
     * The outcomes are read by the same `classify` as `send`, and NOTHING here opens
     * the send-failure condition: this is evidence beside a message that already
     * arrived, and a failed re-send must not make an operator's "the bot is not
     * replying" alarm fire for a bot that is replying.
     */
    return this.classify(await telegramSend(request)).sent;
  }

  private async recordFailure(
    scope: TenantContext,
    message: CustomerMessage,
    reason: SendFailureReason,
    errorCode: string | null,
  ): Promise<void> {
    await this.opsLog.record(scope, {
      code: CUSTOMER_SEND_FAILED_CODE,
      severity: 'ERROR',
      message: MESSAGE_FOR[reason],
      dedupeKey: customerSendConditionKey(message.botInstanceId),
      context: {
        botInstanceId: message.botInstanceId,
        templateKey: message.templateKey,
        reason,
        ...(errorCode === null ? {} : { errorCode }),
      },
    });
  }

  /**
   * Stops the spinner on a tapped button, and reports nothing.
   *
   * Deliberately silent on failure, including a missing token. The durable work is
   * already committed and the customer's real answer is a separate message with its own
   * recorded outcome; a failed cosmetic call that opened the send-failure condition
   * would make an operator's "this bot is not replying" alarm fire for a bot that is
   * replying. Telegram also expires a callback query after about a minute, so a
   * redelivered update legitimately fails here and must not be news.
   */
  async acknowledge(
    scope: TenantContext,
    input: { readonly callbackQueryId: string; readonly botInstanceId: BotInstanceId },
  ): Promise<void> {
    const token = await this.bots.tokenForBotInstance(scope, input.botInstanceId);
    if (token === null) return;
    await telegramSend({
      token,
      apiBaseUrl: this.apiBaseUrl,
      timeoutMs: this.timeoutMs,
      method: 'answerCallbackQuery',
      body: callbackAnswerBody({ callbackQueryId: input.callbackQueryId }),
    });
  }

  /**
   * One button's text. The ONE place money on a button is formatted.
   *
   * `formatMoney` is the same function the message body uses, so an amount on a button
   * and the same amount in the text it sits under cannot be written two different ways.
   */
  private async labelText(scope: ScopeContext, label: CustomerButtonLabel): Promise<string> {
    if (label.kind === 'TEMPLATE') return this.templates.render(scope, label.key, {});
    if (label.kind === 'AMOUNT') return formatMoney(label.amount);
    return label.amount === undefined ? label.text : `${label.text} — ${formatMoney(label.amount)}`;
  }

  /** A label is either a catalogue key or tenant data. One place that knows which. */
  private async labelButtons(
    scope: TenantContext,
    buttons: readonly CustomerButton[],
  ): Promise<TelegramButton[]> {
    const labelled: TelegramButton[] = [];
    for (const button of buttons) {
      const text = await this.labelText(scope, button.label);
      /*
       * The union is discriminated by the field that IS the difference, not by a `kind`
       * tag beside it. A URL button carries a link the client opens; a copy button
       * carries a string for the clipboard; a callback button carries a route. Each has
       * exactly one of the three, and a tag would be a fourth thing to keep in step
       * with the three that decide it.
       */
      if ('url' in button) {
        labelled.push({ text, url: validatedButtonUrl(button.url), ...rowOf(button) });
      } else if ('copyText' in button) {
        labelled.push({ text, copyText: button.copyText, ...rowOf(button) });
      } else {
        labelled.push({ text, data: button.data, ...rowOf(button) });
      }
    }
    return labelled;
  }

  /**
   * Closes it, and only when there is something to close.
   *
   * The open set is read from the rows rather than from this process, so whichever
   * replica sees a send succeed resolves the condition — including one that started
   * after the failure was recorded. A write on every success instead of a read would
   * either append a row per message or, deduplicated, funnel every reply for a bot
   * through one `FOR UPDATE`-locked row.
   *
   * Two concurrent successes can both read "open" and both record a recovery. That is
   * two one-shot INFO rows where one would do, the second resolving nothing; it is
   * bounded by the number of failure-to-recovery transitions and visible in the log,
   * and the alternative — taking a transaction around a send — is the rule in
   * `docs/conventions.md` that forbids network calls inside one.
   */
  private async recordRecovery(scope: TenantContext, botInstanceId: BotInstanceId): Promise<void> {
    const dedupeKey = customerSendConditionKey(botInstanceId);
    if (!(await this.conditions.conditionIsOpen(scope, dedupeKey))) return;

    await this.opsLog.record(scope, {
      code: CUSTOMER_SEND_OK_CODE,
      severity: 'INFO',
      message: 'Customer replies through this bot are reaching Telegram again.',
      context: { botInstanceId },
      recoversCode: CUSTOMER_SEND_FAILED_CODE,
      // Named, so recovering ONE bot does not mark every other bot's open
      // complaint resolved. The broad form is right only for a condition there
      // can be one of, and a tenant can run several bots.
      recoversDedupeKey: dedupeKey,
    });
  }
}

/**
 * What the operator reads. One sentence per reason, all under one code.
 *
 * Separate from the context so the row's `message` stays a sentence about the
 * condition rather than a Telegram description verbatim — which can quote a chat
 * id, and this table is projected out of the database into an operations channel.
 */
const MESSAGE_FOR: Readonly<Record<SendFailureReason, string>> = {
  NO_BOT: 'A customer reply could not be sent: the bot instance has no usable token.',
  UNCERTAIN: 'A customer reply may or may not have been delivered; it was not retried.',
  REFUSED: 'Telegram refused a customer reply.',
};
