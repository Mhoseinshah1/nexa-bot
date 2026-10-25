import { randomBytes } from 'node:crypto';
import {
  GATEWAY_PROVIDER_ID_MAX_LENGTH,
  GATEWAY_PROVIDER_STATUS_MAX_LENGTH,
  RIALIT_AMOUNT_MAX_TOMAN,
  RIALIT_AMOUNT_MIN_TOMAN,
  RIALIT_AMOUNT_OUT_OF_RANGE_STORED,
  RIALIT_AMOUNT_UNIT,
  RIALIT_ATTEMPT_LIFETIME_MINUTES,
  RIALIT_AUTHORIZATION_SCHEME,
  RIALIT_BASE_URL,
  RIALIT_CALL_BUDGET_PER_MINUTE,
  RIALIT_CODE_PREFIX,
  RIALIT_CREATE_PATH,
  RIALIT_INQUIRY_BUDGET_PER_MINUTE,
  RIALIT_ORDER_ID_MAX_BYTES,
  RIALIT_DOUBLE_FEE_STORED,
  RIALIT_PAYER_AMOUNT_MISMATCH_STORED,
  RIALIT_PAYER_AMOUNT_UNREADABLE_STORED,
  RIALIT_RATE_LIMIT_WAIT_MS,
  RIALIT_STATUS_PATH,
  RIALIT_TEST_EVENT,
  RIALIT_TOKEN_PATTERN,
  type Money,
  type ResolvedConversion,
} from '@nexa/contracts';
import { assertOutsideTransaction } from '../../../../infrastructure/transaction-boundary.js';
import type {
  ExternalGatewayAdapter,
  GatewayCreateOutcome,
  GatewayCreateRequest,
  GatewayInquiryContext,
  GatewayInquiryOutcome,
  GatewayWebhookHint,
} from '../application/gateway-invoice-ports.js';
import {
  RIALIT_ORDER_ID_RANDOM_BYTES,
  parseTomanAmount,
  rialitAmountOf,
  rialitAmountRefusal,
  rialitJudgement,
  rialitOrderId,
  rialitPayPageUrl,
  rialitPayerCheck,
} from '../domain/rialit.js';
import {
  boundedCode,
  metadataStatus,
  readBounded,
  transportReason,
  unreadableCode,
  type FetchLike,
  type Raw,
  type UnreadableShape,
} from './tonpays-adapter.js';

/**
 * Rialit over HTTP, and the only code in the installation that speaks it
 * (`docs/rialit-gateway-audit.md`; "the document" is the owner-provided Rialit API document,
 * version 1, which is not in the repository).
 *
 * The other adapters' rules, for the same reasons:
 *
 * - the base URL is the documented constant — a configurable one would be a place to send the
 *   key somewhere else; the option exists only so a test can point at a fake server;
 * - the key travels in `Authorization: Bearer` and appears NOWHERE else: not in a URL, an
 *   outcome, an error code or a log line;
 * - `redirect: 'error'` (Rialit follows no redirect and neither does Nexa), a timeout, a
 *   bounded streaming read, and a transport classifier that keeps a system code and never an
 *   error message;
 * - a 5xx, a timeout, a network error and an unreadable body are UNKNOWN on a create and
 *   transient on a read. The document says a repeat of `POST /send` with the same body is
 *   safe; Nexa's rule stands anyway — a create whose answer was lost is never re-sent and
 *   never re-keyed (an operator reconciles it by READ), because the idempotency is the
 *   provider's claim and has not been accepted against the real provider (`OQ-RL-03`).
 *
 * Specific to Rialit:
 *
 * - every amount is TOMAN as a JSON integer; IRR → Toman happens in `domain/rialit.ts` only,
 *   and the documented range is checked on the PAYABLE before any call;
 * - `payer_id` is the customer's Telegram user id as a JSON NUMBER (a string is refused);
 * - only ONE side charges a fee (owner rule): a create answering a payer fee while Nexa's own
 *   fee is on, or payer figures that do not add up, is refused as the merchant's
 *   configuration and its link is never shown; a payer fee with Nexa's fee off is shown;
 * - settlement authority is `GET /status/{token}` and nothing else;
 * - errors are one English `error` string with no code: classified by HTTP status and, where
 *   the document gives one, the exact text — the English is never stored or shown;
 * - a 429 carries no `Retry-After`; the documented one-second wait is handed on.
 *
 * Never throws for anything the network or the provider does. Refuses to run inside a
 * database transaction.
 */

export const RIALIT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

type JsonObject = Readonly<Record<string, unknown>>;

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function stringOf(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

/** The documented `{ "error": "<english>" }` text, lower-cased for matching, or ''. */
function errorTextOf(body: unknown): string {
  const text = asObject(body)?.['error'];
  return typeof text === 'string' ? text.trim().toLowerCase().slice(0, 200) : '';
}

/** A positive Telegram user id as a safe JSON integer, or null. Never a string on the wire. */
function payerIdOf(buyerChatId: string | null): number | null {
  if (buyerChatId === null || !/^[1-9][0-9]{0,15}$/u.test(buyerChatId)) return null;
  const id = Number(buyerChatId);
  return Number.isSafeInteger(id) && id >= 1 ? id : null;
}

const code = (name: string): string => `${RIALIT_CODE_PREFIX}${name}`;

/** A 403's documented meanings, by text: both are the merchant's configuration. */
function forbiddenCode(body: unknown): string {
  const text = errorTextOf(body);
  if (text === 'ip not allowed') return code('IP_NOT_ALLOWED');
  if (text === 'merchant is not active') return code('MERCHANT_INACTIVE');
  return code('FORBIDDEN');
}

/** The out-of-range code with Rialit's documented bounds (the same one the local check stores). */
const OUT_OF_RANGE = `${RIALIT_AMOUNT_OUT_OF_RANGE_STORED}:${RIALIT_AMOUNT_MIN_TOMAN.toString()}:${RIALIT_AMOUNT_MAX_TOMAN.toString()}`;

interface RialitResponse {
  readonly raw: Raw;
}

export class RialitAdapter implements ExternalGatewayAdapter {
  readonly provider = 'RIALIT' as const;
  readonly unit = RIALIT_AMOUNT_UNIT;
  readonly attemptLifetimeMs = RIALIT_ATTEMPT_LIFETIME_MINUTES * 60_000;
  readonly callBudgetPerMinute = RIALIT_CALL_BUDGET_PER_MINUTE;
  readonly inquiryBudgetPerMinute = RIALIT_INQUIRY_BUDGET_PER_MINUTE;

  constructor(
    private readonly options: {
      readonly fetch?: FetchLike;
      readonly timeoutMs?: number;
      readonly random?: (size: number) => Uint8Array;
      /** Overrides the documented host. For a test's fake server only. */
      readonly baseUrl?: string;
    } = {},
  ) {}

  /** The payable in TOMAN. Only the same-unit policy is accepted: no rate is involved. */
  providerAmountOf(amount: Money, conversion: ResolvedConversion): bigint | null {
    if (conversion.policy !== 'SAME_UNIT') return null;
    return rialitAmountOf(amount);
  }

  newOrderId(hint?: { readonly paymentCode: string | null }): string {
    const random = this.options.random ?? ((size: number) => randomBytes(size));
    return rialitOrderId(hint?.paymentCode ?? null, random(RIALIT_ORDER_ID_RANDOM_BYTES));
  }

  private baseUrl(): string {
    return (this.options.baseUrl ?? RIALIT_BASE_URL).replace(/\/+$/u, '');
  }

  async createInvoice(
    apiKey: string,
    request: GatewayCreateRequest,
  ): Promise<GatewayCreateOutcome> {
    /*
     * Refused LOCALLY, before any call: an amount outside the documented range (on the payable,
     * which already carries Nexa's fee), an order id Rialit would refuse, and a customer with no
     * Telegram id Rialit could take. The attempt is refused upstream when the id is missing
     * (`requiresBuyerChatId`); this is the second line — never a create with a guessed field.
     */
    if (request.amount <= 0n || !Number.isSafeInteger(Number(request.amount))) {
      return { kind: 'REFUSED', code: 'nexa.amount_out_of_range', configuration: false };
    }
    const outOfRange = rialitAmountRefusal(request.amount);
    if (outOfRange !== null) {
      return { kind: 'REFUSED', code: outOfRange, configuration: false };
    }
    if (request.orderId.length > RIALIT_ORDER_ID_MAX_BYTES) {
      return { kind: 'REFUSED', code: code('INVALID_ORDER_ID'), configuration: true };
    }
    const payerId = payerIdOf(request.buyerChatId);
    if (payerId === null) {
      return { kind: 'REFUSED', code: 'nexa.buyer_chat_id_missing', configuration: false };
    }
    // Exactly the documented fields (the request schema refuses any other): numbers, not strings.
    const body = { amount: Number(request.amount), order_id: request.orderId, payer_id: payerId };
    const raw = (await this.call('POST', `${this.baseUrl()}${RIALIT_CREATE_PATH}`, apiKey, body))
      .raw;
    if (raw.kind === 'NO_RESPONSE') return { kind: 'UNKNOWN', code: `http.${raw.reason}` };
    if (raw.kind === 'UNREADABLE') {
      return { kind: 'UNKNOWN', code: boundedCode(unreadableCode(raw)) };
    }
    const answer = asObject(raw.body);
    // 201 (created) and 200 (the same body again: the first payment) read the same way.
    if (raw.status >= 200 && raw.status < 300) {
      const token = stringOf(answer?.['token'], GATEWAY_PROVIDER_ID_MAX_LENGTH);
      if (token === null) {
        return { kind: 'UNKNOWN', code: `http.${String(raw.status)}.unexpected_body:token` };
      }
      // A token that cannot ride the status path or the page URL could never be read or paid.
      const link = rialitPayPageUrl(token);
      if (link === null || !RIALIT_TOKEN_PATTERN.test(token)) {
        return { kind: 'UNKNOWN', code: 'nexa.invoice_id_unsafe' };
      }
      // A payment for another amount (a repeated order id answered 200) must never be paid.
      const echoed = parseTomanAmount(answer?.['amount']);
      if (echoed !== null && echoed !== request.amount) {
        return { kind: 'UNKNOWN', code: 'nexa.amount_mismatch' };
      }
      /*
       * Only ONE side charges the customer a fee (owner decision, Round 9). Nexa's `amount`
       * already carries its own fee when the route charges one; a payer fee from Rialit's
       * dashboard on top would be a second. That, or payer figures that do not add up, is
       * refused as the merchant's configuration: the payment Rialit made is recorded by its
       * token and simply expires there unpaid, since nobody is ever given its link. Unknown
       * whether Nexa charged (an older caller): read as charged, the refusing side.
       */
      const payer = rialitPayerCheck(
        {
          amount: answer?.['amount'],
          payerAmount: answer?.['payer_amount'],
          payerFee: answer?.['payer_fee'],
        },
        request.amount,
        request.customerFeeCharged ?? true,
      );
      if (payer.kind !== 'OK') {
        return {
          kind: 'REFUSED',
          code:
            payer.kind === 'DOUBLE_FEE'
              ? RIALIT_DOUBLE_FEE_STORED
              : payer.kind === 'MISMATCH'
                ? RIALIT_PAYER_AMOUNT_MISMATCH_STORED
                : RIALIT_PAYER_AMOUNT_UNREADABLE_STORED,
          configuration: true,
          httpStatus: raw.status,
          providerInvoiceId: token,
        };
      }
      return {
        kind: 'CREATED',
        invoiceId: token,
        orderId: request.orderId,
        invoiceUrl: link,
        webInvoiceUrl: null,
        status: metadataStatus(answer?.['status']) ?? 'pending',
        // Metadata only, never a decision: what the provider echoed, in Toman. `finalAmount`
        // is what the payer pays (`payer_amount`), shown when Rialit alone charges a fee.
        requestAmount: echoed,
        finalAmount: payer.payerAmount,
      };
    }
    /*
     * A 5xx is UNKNOWN before anything else is read: Rialit may have failed after creating the
     * payment. A 429 is its own refusal to process — the one answer that clears the send stamp,
     * retried with the SAME order id, bounded, after the documented second.
     */
    if (raw.status >= 500) return { kind: 'UNKNOWN', code: `http.${String(raw.status)}` };
    switch (raw.status) {
      case 429:
        return {
          kind: 'RATE_LIMITED',
          code: code('RATE_LIMITED'),
          httpStatus: 429,
          retryAfterMs: RIALIT_RATE_LIMIT_WAIT_MS,
        };
      case 401:
        return {
          kind: 'REFUSED',
          code: code('UNAUTHORIZED'),
          configuration: true,
          httpStatus: 401,
        };
      case 403:
        return {
          kind: 'REFUSED',
          code: forbiddenCode(raw.body),
          configuration: true,
          httpStatus: 403,
        };
      case 409:
        // A payment may already exist under this order id: never retried, never re-keyed.
        return { kind: 'AMBIGUOUS', code: code('ORDER_CONFLICT'), httpStatus: 409 };
      case 404:
        // The route does not exist (a changed API): nothing was created.
        return { kind: 'REFUSED', code: code('NOT_FOUND'), configuration: true, httpStatus: 404 };
      case 400: {
        const text = errorTextOf(raw.body);
        if (text.startsWith('amount')) {
          return { kind: 'REFUSED', code: OUT_OF_RANGE, configuration: false, httpStatus: 400 };
        }
        if (text.startsWith('order_id')) {
          return {
            kind: 'REFUSED',
            code: code('INVALID_ORDER_ID'),
            configuration: true,
            httpStatus: 400,
          };
        }
        if (text.startsWith('payer_id')) {
          return {
            kind: 'REFUSED',
            code: code('INVALID_PAYER_ID'),
            configuration: false,
            httpStatus: 400,
          };
        }
        // An invalid body is Nexa's request or a changed API: never re-sent as it is.
        return { kind: 'REFUSED', code: code('BAD_REQUEST'), configuration: true, httpStatus: 400 };
      }
      default:
        return { kind: 'UNKNOWN', code: `http.${String(raw.status)}` };
    }
  }

  /**
   * `GET /status/{token}` — the one question whose answer may settle money. `token` is the
   * invoice id the create returned.
   */
  async inquire(
    apiKey: string,
    invoiceId: string,
    context?: GatewayInquiryContext,
  ): Promise<GatewayInquiryOutcome> {
    if (context === undefined) return { kind: 'FAILED', code: 'nexa.no_inquiry_context' };
    if (!RIALIT_TOKEN_PATTERN.test(invoiceId)) {
      return { kind: 'FAILED', code: 'nexa.invoice_id_unsafe' };
    }
    const raw = (
      await this.call(
        'GET',
        `${this.baseUrl()}${RIALIT_STATUS_PATH}/${encodeURIComponent(invoiceId)}`,
        apiKey,
        null,
      )
    ).raw;
    if (raw.kind === 'NO_RESPONSE') return { kind: 'FAILED', code: `http.${raw.reason}` };
    if (raw.kind === 'UNREADABLE') {
      return { kind: 'FAILED', code: boundedCode(unreadableCode(raw)) };
    }
    if (raw.status >= 200 && raw.status < 300) {
      const answer = asObject(raw.body);
      const status = stringOf(answer?.['status'], GATEWAY_PROVIDER_STATUS_MAX_LENGTH);
      // The status DECIDES, so it stays strict: a string, or no answer at all.
      if (status === null) {
        return { kind: 'FAILED', code: `http.${String(raw.status)}.unexpected_body:status` };
      }
      const orderId = answer?.['order_id'];
      const judgement = rialitJudgement(
        {
          status,
          orderId,
          amount: answer?.['amount'],
          payerAmount: answer?.['payer_amount'],
          payerFee: answer?.['payer_fee'],
        },
        { orderId: context.providerOrderId, sentAmount: context.sentAmount },
      );
      return {
        kind: 'OBSERVED',
        // The ids the PROVIDER returned; the orchestrator compares them with the attempt's.
        invoiceId: stringOf(answer?.['token'], GATEWAY_PROVIDER_ID_MAX_LENGTH) ?? invoiceId,
        // A `paid` answer for ANOTHER order id about the token we asked is a MISMATCH to hold
        // for a person: reported under OUR order id so the lane's identity gate does not
        // swallow it (TetraPay's rule). A non-paid answer for a foreign id stays a mismatch.
        orderId:
          typeof orderId === 'string' && judgement.mismatchReason !== 'PROVIDER_ORDER_ID_MISMATCH'
            ? orderId
            : context.providerOrderId,
        status,
        paid: judgement.verdict === 'APPROVED',
        verdict: judgement.verdict,
        requestAmount: parseTomanAmount(answer?.['amount']),
        finalAmount: parseTomanAmount(answer?.['payer_amount']),
        ...(judgement.mismatchReason === null ? {} : { mismatchReason: judgement.mismatchReason }),
      };
    }
    // A read that failed is asked again later; nothing here decides anything.
    if (raw.status === 429) {
      return {
        kind: 'RATE_LIMITED',
        code: code('RATE_LIMITED'),
        retryAfterMs: RIALIT_RATE_LIMIT_WAIT_MS,
      };
    }
    if (raw.status === 404) return { kind: 'NOT_FOUND', code: code('NOT_FOUND') };
    if (raw.status === 401) return { kind: 'CONFIGURATION', code: code('UNAUTHORIZED') };
    if (raw.status === 403) return { kind: 'CONFIGURATION', code: forbiddenCode(raw.body) };
    return { kind: 'FAILED', code: `http.${String(raw.status)}` };
  }

  /** Rialit's dashboard test: `{ type: "webhook.test", data: { merchant_id } }`. Names no payment. */
  isWebhookProbe(body: unknown): boolean {
    return asObject(body)?.['type'] === RIALIT_TEST_EVENT;
  }

  /**
   * Shape-checks a webhook body: `event_id`, `type`, and `data` with the token in `data.id`,
   * the order id and the status. Only the attempt's locators are read, plus the status as a
   * hint to display; no amount in it is ever used — Rialit signs nothing, and the status read
   * decides. The dedupe key is `X-Rialit-Delivery`, else the body's `event_id` (the same value).
   */
  parseWebhook(body: unknown, deliveryIdHeader: string | undefined): GatewayWebhookHint | null {
    const top = asObject(body);
    const data = asObject(top?.['data']);
    if (top === null || data === null) return null;
    const orderId = stringOf(data['order_id'], RIALIT_ORDER_ID_MAX_BYTES);
    const token = stringOf(data['id'], GATEWAY_PROVIDER_ID_MAX_LENGTH);
    if (orderId === null || token === null || !RIALIT_TOKEN_PATTERN.test(token)) return null;
    const header = stringOf(deliveryIdHeader, 128);
    return {
      orderId,
      invoiceId: token,
      status: metadataStatus(data['status']),
      // Stable across Rialit's retries of one event: the dedupe key.
      deliveryId: header ?? stringOf(top['event_id'], 128),
      creditAmount: null,
    };
  }

  private async call(
    method: 'GET' | 'POST',
    url: string,
    apiKey: string,
    body: Record<string, unknown> | null,
  ): Promise<RialitResponse> {
    return rialitRequest(this.options, { method, url, apiKey, body });
  }
}

/**
 * ONE Rialit HTTP request: the key in its `Authorization` header and nowhere else,
 * `redirect: 'error'`, the timeout, the bounded streaming read and the transport classifier.
 */
export async function rialitRequest(
  options: { readonly fetch?: FetchLike; readonly timeoutMs?: number },
  request: {
    readonly method: 'GET' | 'POST';
    readonly url: string;
    readonly apiKey: string;
    readonly body: Record<string, unknown> | null;
  },
): Promise<RialitResponse> {
  assertOutsideTransaction('A Rialit call');
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? RIALIT_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await doFetch(request.url, {
        method: request.method,
        headers: {
          ...(request.body === null ? {} : { 'content-type': 'application/json' }),
          accept: 'application/json',
          authorization: `${RIALIT_AUTHORIZATION_SCHEME} ${request.apiKey}`,
        },
        ...(request.body === null ? {} : { body: JSON.stringify(request.body) }),
        signal: controller.signal,
        redirect: 'error',
      });
    } catch (error: unknown) {
      return {
        raw: { kind: 'NO_RESPONSE', reason: transportReason(error, controller.signal.aborted) },
      };
    }
    let text: string | null;
    try {
      text = await readBounded(response, MAX_RESPONSE_BYTES);
    } catch {
      return {
        raw: controller.signal.aborted
          ? { kind: 'NO_RESPONSE', reason: 'timeout' }
          : { kind: 'UNREADABLE', status: response.status, shape: 'stream' },
      };
    }
    if (text === null) {
      return { raw: { kind: 'UNREADABLE', status: response.status, shape: 'too_large' } };
    }
    try {
      return { raw: { kind: 'BODY', status: response.status, body: JSON.parse(text) as unknown } };
    } catch {
      const trimmed = text.trimStart();
      const contentType = response.headers.get('content-type') ?? '';
      const shape: UnreadableShape =
        trimmed === ''
          ? 'empty'
          : trimmed.startsWith('<') || /html/iu.test(contentType)
            ? 'html'
            : 'text';
      return { raw: { kind: 'UNREADABLE', status: response.status, shape } };
    }
  } finally {
    clearTimeout(timer);
  }
}
