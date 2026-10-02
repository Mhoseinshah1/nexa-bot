import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  GATEWAY_CARD_NAME_MAX_LENGTH,
  GATEWAY_CARD_NUMBER_MAX_LENGTH,
  GATEWAY_PROVIDER_STATUS_MAX_LENGTH,
  TONPAYS_AMOUNT_UNIT,
  TONPAYS_ATTEMPT_LIFETIME_MINUTES,
  TONPAYS_TELEGRAM_BASE_URL,
  TONPAYS_TELEGRAM_CALL_BUDGET_PER_MINUTE,
  TONPAYS_TELEGRAM_CHANGE_CARD_SUFFIX,
  TONPAYS_TELEGRAM_CHECK_PATH_PREFIX,
  TONPAYS_TELEGRAM_CREATE_PATH,
  TONPAYS_TELEGRAM_INQUIRY_BUDGET_PER_MINUTE,
  TONPAYS_TELEGRAM_INVOICE_PATH_PREFIX,
  TONPAYS_TELEGRAM_ORDER_ID_PREFIX,
  TONPAYS_TELEGRAM_RECEIPT_FIELD,
  TONPAYS_TELEGRAM_RECEIPT_MAX_BYTES,
  TONPAYS_TELEGRAM_RECEIPT_SUFFIX,
  type Money,
  type ResolvedConversion,
} from '@nexa/contracts';
import { assertOutsideTransaction } from '../../../../infrastructure/transaction-boundary.js';
import { encodeMultipart } from '../../../../infrastructure/telegram/multipart.js';
import type {
  CardTransferGatewayAdapter,
  GatewayCardChangeOutcome,
  GatewayCardChangePolicy,
  GatewayCardInstructions,
  GatewayCreateOutcome,
  GatewayCreateRequest,
  GatewayInquiryOutcome,
  GatewayReceiptFile,
  GatewayReceiptOutcome,
  GatewayWebhookHint,
} from '../application/gateway-invoice-ports.js';
import {
  TONPAYS_ORDER_ID_RANDOM_BYTES,
  tomanAmountOf,
  tonpaysOrderId,
  tonpaysVerdict,
} from '../domain/tonpays.js';
import { classifyTonPaysTelegramError, isSafeInvoiceId } from '../domain/tonpays-telegram.js';
import {
  TonPaysAdapter,
  boundedCode,
  bounded,
  firstIssuePath,
  metadataAmount,
  metadataStatus,
  providerId,
  tonpaysRequest,
  tonpaysWriteAnswer,
  unreadableCode,
  errorBodySchema,
  type FetchLike,
  type Raw,
} from './tonpays-adapter.js';

/**
 * TonPays' Custom Telegram gateway over HTTP (`docs/tonpays-telegram-gateway-audit.md` §5.4).
 *
 * Everything is read off the owner's transcription of the documentation and nothing is
 * added; what it does not say is an `OQ-TPTG-*` and is not invented. The request itself —
 * the key in `X-API-Key` and nowhere else, `redirect: 'error'`, the timeout, the bounded
 * streaming read, the transport classifier — and the rule that a 5xx (or a 4xx with no
 * readable code) on a request that may have done work is UNKNOWN before any code is read,
 * are the WEBSITE adapter's, imported, never copied: two copies of either disagree the
 * first time one is fixed (TP-14, TP-15).
 *
 * What is new here:
 * - a GET inquiry with the invoice id IN THE PATH. A provider-supplied id is refused
 *   unless it matches the allow-list, and is `encodeURIComponent`-ed anyway (§9.2); the
 *   same holds for change-card and receipt;
 * - `buyer_chat_id` is REQUIRED: a create without a safe-integer one is refused locally,
 *   never sent with the field dropped;
 * - the create answer carries a payee card, not a link;
 * - change-card and a multipart receipt upload, each classified in the create's five-way
 *   vocabulary. `paid` and `receipt_received` in an upload answer are carried raw as
 *   METADATA; whether they acknowledge anything is `receiptAcknowledged`'s question.
 *
 * Never throws for anything the network or the provider does. Refuses to run inside a
 * database transaction. Webhook parsing is the website adapter's: the same documented body.
 * No real provider has accepted any of this yet (`OQ-WP10-01`).
 */

/** The request fields this adapter sends: the only names a validation answer may echo. */
const REQUEST_FIELDS: ReadonlySet<string> = new Set([
  'amount',
  'order_id',
  'buyer_chat_id',
  'callback_url',
  'file',
]);

/** The response fields the schemas below declare. */
const RESPONSE_FIELDS: ReadonlySet<string> = new Set([
  'invoice_id',
  'order_id',
  'request_amount',
  'final_amount',
  'status',
  'paid',
  'card_number',
  'card_name',
  'show_change_card',
  'change_card_cooldown_seconds',
  'change_card_exhausted',
  'receipt_received',
]);

const createResponseSchema = z.object({
  invoice_id: providerId,
  order_id: providerId,
  request_amount: z.unknown().optional(),
  final_amount: z.unknown().optional(),
  status: z.unknown().optional(),
  card_number: z.unknown().optional(),
  card_name: z.unknown().optional(),
  show_change_card: z.unknown().optional(),
  change_card_cooldown_seconds: z.unknown().optional(),
  change_card_exhausted: z.unknown().optional(),
});

const inquiryResponseSchema = z.object({
  invoice_id: providerId,
  order_id: providerId,
  request_amount: z.unknown().optional(),
  final_amount: z.unknown().optional(),
  // The inquiry's status DECIDES (with `paid`), so it stays strict.
  status: bounded(GATEWAY_PROVIDER_STATUS_MAX_LENGTH),
  // Judged by `tonpaysVerdict`, which accepts only the boolean `true`.
  paid: z.unknown().optional(),
});

/** Any JSON object: the change-card and receipt answers are read field by field. */
const objectSchema = z.record(z.string(), z.unknown());

/**
 * A payee card as the provider sent it, or null: a non-empty string within the column's
 * bound. The format is undocumented (`OQ-TPTG-06`) and is not validated beyond length — a
 * card is shown exactly as sent, never reformatted into something the provider did not say.
 */
function cardOf(number: unknown, name: unknown): GatewayCardInstructions | null {
  if (
    typeof number !== 'string' ||
    number.trim().length === 0 ||
    number.length > GATEWAY_CARD_NUMBER_MAX_LENGTH
  ) {
    return null;
  }
  const cardName =
    typeof name === 'string' &&
    name.trim().length > 0 &&
    name.length <= GATEWAY_CARD_NAME_MAX_LENGTH
      ? name
      : null;
  return { cardNumber: number, cardName };
}

/** The provider's word on changing the card: each field its JSON type, or not said. */
function policyOf(body: Record<string, unknown>): GatewayCardChangePolicy {
  const cooldown = body['change_card_cooldown_seconds'];
  return {
    showChangeCard: typeof body['show_change_card'] === 'boolean' ? body['show_change_card'] : null,
    cooldownSeconds:
      typeof cooldown === 'number' &&
      Number.isSafeInteger(cooldown) &&
      cooldown >= 0 &&
      cooldown <= 86_400
        ? cooldown
        : null,
    exhausted:
      typeof body['change_card_exhausted'] === 'boolean' ? body['change_card_exhausted'] : null,
  };
}

export class TonPaysTelegramAdapter implements CardTransferGatewayAdapter {
  readonly provider = 'TONPAYS_TELEGRAM' as const;
  readonly unit = TONPAYS_AMOUNT_UNIT;
  /** The customer's window: the same seventy minutes as the website route (audit §3.3). */
  readonly attemptLifetimeMs = TONPAYS_ATTEMPT_LIFETIME_MINUTES * 60_000;
  readonly callBudgetPerMinute = TONPAYS_TELEGRAM_CALL_BUDGET_PER_MINUTE;
  readonly inquiryBudgetPerMinute = TONPAYS_TELEGRAM_INQUIRY_BUDGET_PER_MINUTE;
  readonly receiptMaxBytes = TONPAYS_TELEGRAM_RECEIPT_MAX_BYTES;
  /** The website adapter, for the one shared parse: the documented webhook body. */
  private readonly website: TonPaysAdapter;

  constructor(
    private readonly options: {
      readonly fetch?: FetchLike;
      readonly timeoutMs?: number;
      readonly random?: (size: number) => Uint8Array;
    } = {},
  ) {
    this.website = new TonPaysAdapter(options);
  }

  /** TonPays bills in Toman: the same unit, or no amount. */
  providerAmountOf(amount: Money, conversion: ResolvedConversion): bigint | null {
    if (conversion.policy !== 'SAME_UNIT') return null;
    return tomanAmountOf(amount);
  }

  newOrderId(): string {
    const random = this.options.random ?? ((size: number) => randomBytes(size));
    return tonpaysOrderId(random(TONPAYS_ORDER_ID_RANDOM_BYTES), TONPAYS_TELEGRAM_ORDER_ID_PREFIX);
  }

  async createInvoice(
    apiKey: string,
    request: GatewayCreateRequest,
  ): Promise<GatewayCreateOutcome> {
    assertOutsideTransaction('A TonPays Telegram call');
    const amount = Number(request.amount);
    if (!Number.isSafeInteger(amount)) {
      return { kind: 'REFUSED', code: 'nexa.amount_out_of_range', configuration: false };
    }
    /*
     * `buyer_chat_id` is REQUIRED here (website: optional). The attempt is refused before any
     * row is written when it would be missing (`requiresBuyerChatId`), so this is the second
     * line: never send the create with the field dropped, which is a guaranteed refusal.
     */
    const buyer = request.buyerChatId === null ? Number.NaN : Number(request.buyerChatId);
    if (
      request.buyerChatId === null ||
      !/^-?\d{1,16}$/u.test(request.buyerChatId) ||
      !Number.isSafeInteger(buyer)
    ) {
      return { kind: 'REFUSED', code: 'nexa.buyer_chat_id_missing', configuration: false };
    }
    const raw = await this.call('POST', TONPAYS_TELEGRAM_CREATE_PATH, apiKey, {
      kind: 'JSON',
      value: {
        amount,
        order_id: request.orderId,
        buyer_chat_id: buyer,
        ...(request.callbackUrl === null ? {} : { callback_url: request.callbackUrl }),
      },
    });
    const answer = this.writeOutcome(raw);
    if (answer.kind !== 'BODY') {
      const outcome = answer.outcome;
      // An invoice that does not exist yet cannot be "not found": a readable refusal.
      return outcome.kind === 'NOT_FOUND'
        ? { kind: 'REFUSED', code: outcome.code, configuration: false }
        : outcome;
    }
    const parsed = createResponseSchema.safeParse(answer.body);
    if (!parsed.success) {
      return {
        kind: 'UNKNOWN',
        code: boundedCode(
          `http.${String(answer.status)}.unexpected_body:${firstIssuePath(parsed.error, RESPONSE_FIELDS)}`,
        ),
      };
    }
    // An answer for another order is not an answer to this request: UNKNOWN, never adopted.
    if (parsed.data.order_id !== request.orderId) {
      return { kind: 'UNKNOWN', code: 'nexa.order_id_mismatch' };
    }
    const body = answer.body as Record<string, unknown>;
    return {
      kind: 'CREATED',
      invoiceId: parsed.data.invoice_id,
      orderId: parsed.data.order_id,
      // Not a web-invoice flow: there is no link, and none is fabricated.
      invoiceUrl: null,
      webInvoiceUrl: null,
      status: metadataStatus(parsed.data.status),
      requestAmount: metadataAmount(parsed.data.request_amount),
      finalAmount: metadataAmount(parsed.data.final_amount),
      instructions: cardOf(parsed.data.card_number, parsed.data.card_name),
      cardChange: policyOf(body),
    };
  }

  async inquire(apiKey: string, invoiceId: string): Promise<GatewayInquiryOutcome> {
    assertOutsideTransaction('A TonPays Telegram call');
    if (!isSafeInvoiceId(invoiceId)) return { kind: 'FAILED', code: 'nexa.invoice_id_unsafe' };
    const raw = await this.call(
      'GET',
      `${TONPAYS_TELEGRAM_CHECK_PATH_PREFIX}${encodeURIComponent(invoiceId)}`,
      apiKey,
      { kind: 'NONE' },
    );
    if (raw.kind === 'NO_RESPONSE') return { kind: 'FAILED', code: `http.${raw.reason}` };
    if (raw.kind === 'UNREADABLE')
      return { kind: 'FAILED', code: boundedCode(unreadableCode(raw)) };
    if (raw.status >= 200 && raw.status < 300) {
      const parsed = inquiryResponseSchema.safeParse(raw.body);
      if (!parsed.success) {
        return {
          kind: 'FAILED',
          code: boundedCode(
            `http.${String(raw.status)}.unexpected_body:${firstIssuePath(parsed.error, RESPONSE_FIELDS)}`,
          ),
        };
      }
      return {
        kind: 'OBSERVED',
        invoiceId: parsed.data.invoice_id,
        orderId: parsed.data.order_id,
        status: parsed.data.status,
        paid: typeof parsed.data.paid === 'boolean' ? parsed.data.paid : null,
        verdict: tonpaysVerdict(parsed.data.status, parsed.data.paid),
        requestAmount: metadataAmount(parsed.data.request_amount),
        finalAmount: metadataAmount(parsed.data.final_amount),
      };
    }
    // An inquiry did no work: a 5xx or an unreadable code is transient, never an answer.
    const code = errorBodySchema.safeParse(raw.body);
    if (!code.success) {
      return raw.status === 429
        ? { kind: 'RATE_LIMITED', code: 'http.429' }
        : { kind: 'FAILED', code: `http.${String(raw.status)}` };
    }
    const value = boundedCode(code.data.detail.code);
    switch (classifyTonPaysTelegramError(code.data.detail.code)) {
      case 'CONFIGURATION':
        return { kind: 'CONFIGURATION', code: value };
      case 'RATE_LIMITED':
        return raw.status < 500
          ? { kind: 'RATE_LIMITED', code: value }
          : { kind: 'FAILED', code: value };
      case 'NOT_FOUND':
        return { kind: 'NOT_FOUND', code: value };
      case 'AMBIGUOUS':
      case 'RECEIPT_REFUSED':
      case 'REFUSED':
        return { kind: 'FAILED', code: value };
    }
  }

  async changeCard(apiKey: string, invoiceId: string): Promise<GatewayCardChangeOutcome> {
    assertOutsideTransaction('A TonPays Telegram call');
    if (!isSafeInvoiceId(invoiceId)) {
      return { kind: 'REFUSED', code: 'nexa.invoice_id_unsafe', configuration: false };
    }
    const raw = await this.call(
      'POST',
      `${TONPAYS_TELEGRAM_INVOICE_PATH_PREFIX}${encodeURIComponent(invoiceId)}${TONPAYS_TELEGRAM_CHANGE_CARD_SUFFIX}`,
      apiKey,
      { kind: 'NONE' },
    );
    const answer = this.writeOutcome(raw);
    if (answer.kind !== 'BODY') {
      const outcome = answer.outcome;
      return outcome.kind === 'AMBIGUOUS' ? { kind: 'UNKNOWN', code: outcome.code } : outcome;
    }
    const parsed = objectSchema.safeParse(answer.body);
    if (!parsed.success) {
      return { kind: 'UNKNOWN', code: `http.${String(answer.status)}.unexpected_body:root` };
    }
    /*
     * The answer's card field names are undocumented beyond "new card info" (`OQ-TPTG-06`);
     * the create's names are read. A readable 2xx WITHOUT a card may have changed it: the
     * card is no longer known, so UNKNOWN — the current one is hidden, never kept.
     */
    const card = cardOf(parsed.data['card_number'], parsed.data['card_name']);
    if (card === null) {
      return {
        kind: 'UNKNOWN',
        code: `http.${String(answer.status)}.unexpected_body:card_number`,
      };
    }
    return { kind: 'CHANGED', instructions: card, policy: policyOf(parsed.data) };
  }

  async uploadReceipt(
    apiKey: string,
    invoiceId: string,
    file: GatewayReceiptFile,
  ): Promise<GatewayReceiptOutcome> {
    assertOutsideTransaction('A TonPays Telegram call');
    if (!isSafeInvoiceId(invoiceId)) {
      return {
        kind: 'REFUSED',
        code: 'nexa.invoice_id_unsafe',
        configuration: false,
        receiptRefused: false,
      };
    }
    // Never sent over the documented bound: the provider would refuse it after the upload.
    if (file.bytes.byteLength === 0 || file.bytes.byteLength > this.receiptMaxBytes) {
      return {
        kind: 'REFUSED',
        code: 'nexa.receipt_too_large',
        configuration: false,
        receiptRefused: true,
      };
    }
    const multipart = encodeMultipart(
      {},
      {
        field: TONPAYS_TELEGRAM_RECEIPT_FIELD,
        fileName: file.fileName,
        mimeType: file.mimeType,
        bytes: file.bytes,
      },
    );
    const raw = await this.call(
      'POST',
      `${TONPAYS_TELEGRAM_INVOICE_PATH_PREFIX}${encodeURIComponent(invoiceId)}${TONPAYS_TELEGRAM_RECEIPT_SUFFIX}`,
      apiKey,
      { kind: 'MULTIPART', contentType: multipart.contentType, bytes: multipart.body },
    );
    const answer = this.writeOutcome(raw);
    if (answer.kind !== 'BODY') {
      const outcome = answer.outcome;
      switch (outcome.kind) {
        case 'AMBIGUOUS':
          return { kind: 'UNKNOWN', code: outcome.code };
        case 'REFUSED':
          return {
            ...outcome,
            receiptRefused: classifyTonPaysTelegramError(outcome.code) === 'RECEIPT_REFUSED',
          };
        default:
          return outcome;
      }
    }
    const parsed = objectSchema.safeParse(answer.body);
    if (!parsed.success) {
      return { kind: 'UNKNOWN', code: `http.${String(answer.status)}.unexpected_body:root` };
    }
    return {
      kind: 'ACCEPTED',
      status: metadataStatus(parsed.data['status']),
      // Raw JSON values: metadata, judged only by `receiptAcknowledged` (never settlement).
      paid: parsed.data['paid'],
      receiptReceived: parsed.data['receipt_received'],
    };
  }

  /** The website's documented webhook body; a hint, and nothing secret is read. */
  parseWebhook(body: unknown, deliveryIdHeader: string | undefined): GatewayWebhookHint | null {
    return this.website.parseWebhook(body, deliveryIdHeader);
  }

  /**
   * A request that may have done work (create, change card, receipt): a 2xx body, or the
   * outcome every non-2xx means — through the website adapter's ONE rule
   * (`tonpaysWriteAnswer`): a 5xx and a 4xx with no readable code are UNKNOWN; only a 4xx
   * carrying a documented code is taken at its word.
   */
  private writeOutcome(raw: Raw):
    | { readonly kind: 'BODY'; readonly status: number; readonly body: unknown }
    | {
        readonly kind: 'OUTCOME';
        readonly outcome:
          | { readonly kind: 'REFUSED'; readonly code: string; readonly configuration: boolean }
          | { readonly kind: 'RATE_LIMITED'; readonly code: string }
          | { readonly kind: 'AMBIGUOUS'; readonly code: string }
          | { readonly kind: 'NOT_FOUND'; readonly code: string }
          | { readonly kind: 'UNKNOWN'; readonly code: string };
      } {
    if (raw.kind === 'NO_RESPONSE') {
      return { kind: 'OUTCOME', outcome: { kind: 'UNKNOWN', code: `http.${raw.reason}` } };
    }
    if (raw.kind === 'UNREADABLE') {
      return {
        kind: 'OUTCOME',
        outcome: { kind: 'UNKNOWN', code: boundedCode(unreadableCode(raw)) },
      };
    }
    if (raw.status >= 200 && raw.status < 300) {
      return { kind: 'BODY', status: raw.status, body: raw.body };
    }
    const answered = tonpaysWriteAnswer(raw, REQUEST_FIELDS);
    if (answered.kind === 'UNKNOWN') return { kind: 'OUTCOME', outcome: answered };
    const code = boundedCode(answered.code);
    switch (classifyTonPaysTelegramError(answered.code)) {
      case 'CONFIGURATION':
        return { kind: 'OUTCOME', outcome: { kind: 'REFUSED', code, configuration: true } };
      case 'RATE_LIMITED':
        return { kind: 'OUTCOME', outcome: { kind: 'RATE_LIMITED', code } };
      case 'AMBIGUOUS':
        return { kind: 'OUTCOME', outcome: { kind: 'AMBIGUOUS', code } };
      case 'NOT_FOUND':
        return { kind: 'OUTCOME', outcome: { kind: 'NOT_FOUND', code } };
      case 'RECEIPT_REFUSED':
      case 'REFUSED':
        return { kind: 'OUTCOME', outcome: { kind: 'REFUSED', code, configuration: false } };
    }
  }

  private call(
    method: 'GET' | 'POST',
    path: string,
    apiKey: string,
    body:
      | { readonly kind: 'JSON'; readonly value: Record<string, unknown> }
      | { readonly kind: 'MULTIPART'; readonly contentType: string; readonly bytes: Uint8Array }
      | { readonly kind: 'NONE' },
  ): Promise<Raw> {
    return tonpaysRequest(this.options, {
      method,
      url: `${TONPAYS_TELEGRAM_BASE_URL}${path}`,
      apiKey,
      body,
    });
  }
}
