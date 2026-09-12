import type {
  BotInstanceId,
  OperationalEventRecorder,
  ScopeContext,
  TemplateKey,
  TemplateValues,
  TenantContext,
} from '@nexa/contracts';
import { templateDefinition } from '@nexa/contracts';
import { telegramSend, textMessageBody } from '../../../../infrastructure/telegram/send-message.js';
import type {
  CustomerMessage,
  CustomerMessenger,
  CustomerSendOutcome,
} from '../application/ports.js';

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
    private readonly apiBaseUrl: string,
    private readonly timeoutMs: number,
  ) {}

  async send(scope: TenantContext, message: CustomerMessage): Promise<CustomerSendOutcome> {
    const token = await this.bots.tokenForBotInstance(scope, message.botInstanceId);
    if (token === null) {
      // Not an exception: a bot an operator disabled between the update arriving and
      // the reply being sent is an ordinary race, and the customer's arrival is already
      // committed. Recorded so the operator can see that replies are going nowhere.
      await this.opsLog.record(scope, {
        code: 'telegram.customer_send_no_bot',
        severity: 'WARN',
        message: 'A customer reply could not be sent: the bot instance has no usable token.',
        dedupeKey: `telegram.customer_send_no_bot:${message.botInstanceId}`,
        context: { botInstanceId: message.botInstanceId, templateKey: message.templateKey },
      });
      return 'REFUSED';
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
    const result = await telegramSend({
      token,
      apiBaseUrl: this.apiBaseUrl,
      timeoutMs: this.timeoutMs,
      body: textMessageBody({ chatId: message.chatId, text, html }),
    });

    if (result.outcome === 'SUCCEEDED') return 'DELIVERED';

    /*
     * A retryable failure is UNKNOWN, not REFUSED.
     *
     * `telegramSend` calls a timeout, a 5xx, a 429 and an unreadable 2xx retryable,
     * and every one of those means Telegram may have delivered the message. For a
     * queue that is a reason to try again; for a customer reply it is a reason NOT to,
     * because the customer would see it twice. So the distinction is preserved and the
     * decision is "tell an operator", which is what the event is.
     *
     * The message is NOT the Telegram description verbatim in the dedupe key: a 4xx
     * description can quote the chat id, and a dedupe key is a durable column.
     */
    const unknown = result.outcome === 'FAILED_RETRYABLE';
    await this.opsLog.record(scope, {
      code: unknown ? 'telegram.customer_send_unknown' : 'telegram.customer_send_refused',
      severity: unknown ? 'WARN' : 'ERROR',
      message: unknown
        ? 'A customer reply may or may not have been delivered; it was not retried.'
        : 'Telegram refused a customer reply.',
      dedupeKey: `${result.errorCode}:${message.botInstanceId}`,
      context: {
        botInstanceId: message.botInstanceId,
        templateKey: message.templateKey,
        errorCode: result.errorCode,
      },
    });
    return unknown ? 'UNKNOWN' : 'REFUSED';
  }
}
