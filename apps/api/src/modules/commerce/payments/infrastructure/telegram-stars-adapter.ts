import { randomBytes } from 'node:crypto';
import {
  GATEWAY_ERROR_CODE_MAX_LENGTH,
  TELEGRAM_STARS_ATTEMPT_LIFETIME_MINUTES,
  TELEGRAM_STARS_CALL_BUDGET_PER_MINUTE,
  TELEGRAM_STARS_CURRENCY,
  TELEGRAM_STARS_PAYLOAD_HEX_LENGTH,
  telegramStarsFor,
  type Money,
} from '@nexa/contracts';
import {
  telegramSendInvoice,
  type TelegramSendOutcome,
} from '../../../../infrastructure/telegram/send-message.js';
import type {
  ExternalGatewayAdapter,
  GatewayCreateOutcome,
  GatewayCreateRequest,
  GatewayInquiryOutcome,
  GatewayWebhookHint,
} from '../application/gateway-invoice-ports.js';

/**
 * What a `sendInvoice` answer means for the attempt (Package A, audit §2.4).
 *
 * - A message id is `CREATED`, and the invoice's id is `message:<id>` — there is no other
 *   provider invoice id, and the message id is what an operator can find in the chat.
 * - 429 is `RATE_LIMITED`: Telegram said in so many words it did not process the call.
 * - A readable 400 or 403 is `REFUSED` on the CUSTOMER's side (a chat that no longer
 *   exists, a bot the customer blocked); a readable 401 or 404 is `REFUSED` on the
 *   installation's (a revoked or wrong token), which is an operator's condition.
 * - Everything else — a timeout, a network error, a 5xx, an unreadable 2xx, a 2xx with no
 *   message id — is `UNKNOWN`: the invoice MAY be in the chat, so the create is never sent
 *   again. A customer holding it can still pay, because pre-checkout validates the
 *   attempt, not the create.
 *
 * Pure and exported, so the mapping is a rule with a test rather than a switch in a call.
 */
export function starsCreateOutcome(
  sent: TelegramSendOutcome,
  orderId: string,
  stars: bigint,
): GatewayCreateOutcome {
  if (sent.outcome === 'SUCCEEDED') {
    if (sent.messageId === null) return { kind: 'UNKNOWN', code: 'telegram.no_message_id' };
    return {
      kind: 'CREATED',
      invoiceId: `message:${sent.messageId}`,
      orderId,
      invoiceUrl: null,
      webInvoiceUrl: null,
      status: null,
      requestAmount: stars,
      finalAmount: null,
    };
  }
  const code = sent.errorCode.slice(0, GATEWAY_ERROR_CODE_MAX_LENGTH);
  if (sent.outcome === 'FAILED_RETRYABLE') {
    return sent.errorCode === 'telegram.rate_limited'
      ? { kind: 'RATE_LIMITED', code }
      : { kind: 'UNKNOWN', code };
  }
  if (/^telegram\.rejected\.(400|403)$/u.test(sent.errorCode)) {
    return { kind: 'REFUSED', code, configuration: false };
  }
  if (/^telegram\.rejected\.(401|404)$/u.test(sent.errorCode)) {
    return { kind: 'REFUSED', code, configuration: true };
  }
  // Any other readable 4xx, and a Star amount refused before the call: not processed, and
  // nothing a retry would change.
  return { kind: 'REFUSED', code, configuration: false };
}

/**
 * Telegram Stars, `XTR` (Package A, `docs/package-a-telegram-stars-audit.md`).
 *
 * The invoice is a MESSAGE the bot sends with its own token, and the only thing that
 * approves it is Telegram's `successful_payment` on the bot's authenticated webhook,
 * recorded before anything settles (`approval: 'RECORDED_PAYMENT'`). So this adapter
 * creates and never asks: `inquire` is never reached for this provider, and says so if it
 * ever is, and there is no provider webhook to parse — Stars arrive as bot updates.
 */
export class TelegramStarsAdapter implements ExternalGatewayAdapter {
  readonly provider = 'TELEGRAM_STARS' as const;
  readonly unit = TELEGRAM_STARS_CURRENCY;
  readonly attemptLifetimeMs = TELEGRAM_STARS_ATTEMPT_LIFETIME_MINUTES * 60_000;
  readonly callBudgetPerMinute = TELEGRAM_STARS_CALL_BUDGET_PER_MINUTE;
  // No inquiry is ever made; the lane never takes inquiry budget for this provider.
  readonly inquiryBudgetPerMinute = 0;

  constructor(
    private readonly options: {
      readonly apiBaseUrl: string;
      readonly timeoutMs: number;
      readonly send?: typeof telegramSendInvoice;
      readonly random?: (size: number) => Uint8Array;
    },
  ) {}

  /** `ceil(payable / rate)`, in `bigint`. No rate, or no positive payable, is no amount. */
  providerAmountOf(amount: Money, rateMinor: bigint | null): bigint | null {
    if (rateMinor === null) return null;
    return telegramStarsFor(amount.amountMinor, rateMinor);
  }

  /** 32 hex characters of randomness: opaque, and well inside Telegram's 1–128 bytes. */
  newOrderId(): string {
    const random = this.options.random ?? ((size: number) => randomBytes(size));
    return Buffer.from(random(TELEGRAM_STARS_PAYLOAD_HEX_LENGTH / 2)).toString('hex');
  }

  async createInvoice(
    botToken: string,
    request: GatewayCreateRequest,
  ): Promise<GatewayCreateOutcome> {
    // The invoice goes to the customer's own chat with this bot; without it there is no
    // one to send it to. Refused before any call.
    if (request.buyerChatId === null) {
      return { kind: 'REFUSED', code: 'nexa.chat_unknown', configuration: false };
    }
    if (request.presentation === null) {
      return { kind: 'REFUSED', code: 'nexa.presentation_missing', configuration: true };
    }
    const send = this.options.send ?? telegramSendInvoice;
    const sent = await send({
      token: botToken,
      apiBaseUrl: this.options.apiBaseUrl,
      timeoutMs: this.options.timeoutMs,
      chatId: request.buyerChatId,
      title: request.presentation.title,
      description: request.presentation.description,
      priceLabel: request.presentation.priceLabel,
      payload: request.orderId,
      stars: request.amount,
    });
    return starsCreateOutcome(sent, request.orderId, request.amount);
  }

  inquire(): Promise<GatewayInquiryOutcome> {
    return Promise.resolve({ kind: 'FAILED', code: 'nexa.not_inquirable' });
  }

  parseWebhook(): GatewayWebhookHint | null {
    return null;
  }
}
