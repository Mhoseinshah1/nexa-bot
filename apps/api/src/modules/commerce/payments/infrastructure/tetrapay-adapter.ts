import { randomBytes } from 'node:crypto';
import {
  GATEWAY_PROVIDER_ID_MAX_LENGTH,
  GATEWAY_PROVIDER_STATUS_MAX_LENGTH,
  GATEWAY_PROVIDER_URL_MAX_LENGTH,
  TETRAPAY_AMOUNT_OUT_OF_RANGE_STORED,
  TETRAPAY_ATTEMPT_LIFETIME_MINUTES,
  TETRAPAY_AUTHORIZATION_SCHEME,
  TETRAPAY_BASE_URL,
  TETRAPAY_METHODS,
  TETRAPAY_CALL_BUDGET_PER_MINUTE,
  TETRAPAY_CODE_PREFIX,
  TETRAPAY_CONFIGURATION_ERRORS,
  TETRAPAY_CREATE_PATH,
  TETRAPAY_DAILY_LIMIT_STORED,
  TETRAPAY_PROVIDER_ERRORS,
  TETRAPAY_INQUIRY_BUDGET_PER_MINUTE,
  TETRAPAY_AMOUNT_UNIT,
  TETRAPAY_VERIFY_PATH_SUFFIX,
  type Money,
  type ResolvedConversion,
  type TetraPayProviderError,
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
  TETRAPAY_ORDER_ID_RANDOM_BYTES,
  parseRialAmount,
  rialWireString,
  tetrapayAmountOf,
  tetrapayJudgement,
  tetrapayOrderId,
  tomanOfRial,
} from '../domain/tetrapay.js';
import { verifyTetraPayWebhook } from './tetrapay-signature.js';
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
 * TetraPay (Tetra98) over HTTP, and the only code in the installation that speaks it
 * (`docs/tetrapay-gateway-audit.md`; every rule below is the API documentation's section noted).
 *
 * The other adapters' rules, for the same reasons:
 *
 * - the base URL is the documented constant (§1) - a configurable one would be a place to send
 *   the key somewhere else; the option exists only so a test can point at a fake server;
 * - the key travels in `Authorization: Bearer` (§2) and appears NOWHERE else: not in a URL, an
 *   outcome, an error code or a log line;
 * - `redirect: 'error'`, a timeout, a bounded streaming read, and a transport classifier that
 *   keeps a system code and never an error message;
 * - a 5xx, a timeout, a network error and an unreadable body are UNKNOWN on a create and
 *   transient on a read; an `ORDER_CONFLICT` (§9, 409: the order id exists with another amount)
 *   is AMBIGUOUS and never re-keyed.
 *
 * Specific to TetraPay:
 *
 * - every amount is RIAL as a numeric STRING (§5); the unit change from Nexa's Toman is
 *   `domain/tetrapay.ts`, the one helper;
 * - settlement authority is `POST /payments/{token}/verify` and nothing else (§3.3): `inquire`
 *   IS that call, with no body; `GET /payments/{token}` is never made by this installation;
 * - the create sends exactly `amount`, `order_id`, `callback_url` and `allow_partial: false`:
 *   never `customer_phone` / `customer_email` (card saving), and no `webhook_url` - the
 *   operator registers the webhook address in TetraPay's panel;
 * - errors are `{ "error": { "code", "message", "min", "max", "retryAfter", ... } }` (§9); the
 *   daily limit is a 429 like the rate limit and is told apart by its CODE, first;
 * - `Retry-After` (header, else `error.retryAfter`) is read from a 429 and handed on, bounded.
 *
 * Never throws for anything the network or the provider does. Refuses to run inside a
 * database transaction.
 */

export const TETRAPAY_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
/** The largest `Retry-After` honoured: a provider cannot park the lane for longer. */
const MAX_RETRY_AFTER_MS = 60 * 60_000;

/** A token safe to put in a URL path: a bounded run of unreserved characters. */
const TOKEN_TEXT = /^[A-Za-z0-9._~-]{1,128}$/u;

type JsonObject = Readonly<Record<string, unknown>>;

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

/**
 * The object a field lives in: the body itself (a success answer, §3), else its `error` object
 * (§9: `code`, `min`, `max`, `retryAfter`, `kind`, `limit`). The FIRST that carries the field
 * wins, and nothing is merged across objects.
 */
function containerOf(body: unknown, field: string): JsonObject | null {
  const top = asObject(body);
  if (top === null) return null;
  if (field in top) return top;
  const inner = asObject(top['error']);
  return inner !== null && field in inner ? inner : null;
}

function fieldOf(body: unknown, field: string): unknown {
  return containerOf(body, field)?.[field];
}

function stringField(body: unknown, field: string, max: number): string | null {
  const value = fieldOf(body, field);
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

function safeLink(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (value.length > GATEWAY_PROVIDER_URL_MAX_LENGTH) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

const CODE_TEXT = /^[A-Z][A-Z0-9_]{2,40}$/u;

/** The documented error code (§9: `{ "error": { "code" } }`) an error body names, or null. */
function errorCodeOf(body: unknown): string | null {
  const inner = asObject(asObject(body)?.['error']);
  const code = inner?.['code'];
  return typeof code === 'string' && CODE_TEXT.test(code) ? code : null;
}

function isDocumentedCode(code: string): code is TetraPayProviderError {
  return (TETRAPAY_PROVIDER_ERRORS as readonly string[]).includes(code);
}

/** The Toman figure of a rial bound the provider named, or 0 (unknown / not whole Toman). */
function tomanBound(body: unknown, names: readonly string[]): bigint {
  for (const name of names) {
    const rial = parseRialAmount(fieldOf(body, name));
    if (rial !== null) return tomanOfRial(rial) ?? 0n;
  }
  return 0n;
}

/** `Retry-After` as ms: delay-seconds or an HTTP date; bounded, and null when unreadable. */
export function retryAfterMsOf(value: string | null, now: Date): number | null {
  if (value === null) return null;
  const text = value.trim();
  let ms: number;
  if (/^[0-9]{1,7}$/u.test(text)) {
    ms = Number(text) * 1000;
  } else {
    const at = Date.parse(text);
    if (!Number.isFinite(at)) return null;
    ms = at - now.getTime();
  }
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.min(ms, MAX_RETRY_AFTER_MS);
}

function isMethod(value: unknown): boolean {
  return typeof value === 'string' && (TETRAPAY_METHODS as readonly string[]).includes(value);
}

/** `error.retryAfter` (seconds, §9) as ms, bounded, or null. Used when the header is absent. */
function retryAfterBodyMs(body: unknown): number | null {
  const value = fieldOf(body, 'retryAfter');
  const seconds = typeof value === 'string' ? Number(value) : value;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
}

/** A 401 or 403: the provider refused THIS installation's key, never the customer's payment. */
function refusesKey(status: number): boolean {
  return status === 401 || status === 403;
}

interface TetraPayResponse {
  readonly raw: Raw;
  readonly retryAfterMs: number | null;
}

export class TetraPayAdapter implements ExternalGatewayAdapter {
  readonly provider = 'TETRAPAY' as const;
  readonly unit = TETRAPAY_AMOUNT_UNIT;
  readonly attemptLifetimeMs = TETRAPAY_ATTEMPT_LIFETIME_MINUTES * 60_000;
  readonly callBudgetPerMinute = TETRAPAY_CALL_BUDGET_PER_MINUTE;
  readonly inquiryBudgetPerMinute = TETRAPAY_INQUIRY_BUDGET_PER_MINUTE;

  constructor(
    private readonly options: {
      readonly fetch?: FetchLike;
      readonly timeoutMs?: number;
      readonly random?: (size: number) => Uint8Array;
      /** Overrides the documented host. For a test's fake server only. */
      readonly baseUrl?: string;
      readonly now?: () => Date;
    } = {},
  ) {}

  /**
   * The payable in RIAL. Only the same-unit policy is accepted — the unit change is exact
   * (x10 from Toman) and no rate is involved; anything else has no rial value here.
   */
  providerAmountOf(amount: Money, conversion: ResolvedConversion): bigint | null {
    if (conversion.policy !== 'SAME_UNIT') return null;
    return tetrapayAmountOf(amount);
  }

  newOrderId(hint?: { readonly paymentCode: string | null }): string {
    const random = this.options.random ?? ((size: number) => randomBytes(size));
    return tetrapayOrderId(hint?.paymentCode ?? null, random(TETRAPAY_ORDER_ID_RANDOM_BYTES));
  }

  private baseUrl(): string {
    return (this.options.baseUrl ?? TETRAPAY_BASE_URL).replace(/\/+$/u, '');
  }

  async createInvoice(
    apiKey: string,
    request: GatewayCreateRequest,
  ): Promise<GatewayCreateOutcome> {
    const base = this.baseUrl();
    // The customer returns to the bot's start link; with none there is nowhere to send them.
    if (request.callbackUrl === null) {
      return { kind: 'REFUSED', code: 'nexa.no_return_url', configuration: true };
    }
    if (request.amount <= 0n) {
      return { kind: 'REFUSED', code: 'nexa.amount_out_of_range', configuration: false };
    }
    /*
     * Exactly the documented fields. NO `customer_phone` / `customer_email` (card saving is
     * off) and no `webhook_url`; `allow_partial` is sent as false, always: a partial payment is
     * not a payment of this order. The amount is a numeric STRING in rial.
     */
    const body = {
      amount: rialWireString(request.amount),
      order_id: request.orderId,
      callback_url: request.callbackUrl,
      allow_partial: false,
    };
    const response = await this.call('POST', `${base}${TETRAPAY_CREATE_PATH}`, apiKey, body);
    const raw = response.raw;
    if (raw.kind === 'NO_RESPONSE') return { kind: 'UNKNOWN', code: `http.${raw.reason}` };
    if (raw.kind === 'UNREADABLE')
      return { kind: 'UNKNOWN', code: boundedCode(unreadableCode(raw)) };
    if (raw.status >= 200 && raw.status < 300) {
      const token = stringField(raw.body, 'token', GATEWAY_PROVIDER_ID_MAX_LENGTH);
      if (token === null) {
        return { kind: 'UNKNOWN', code: `http.${String(raw.status)}.unexpected_body:token` };
      }
      // A token that cannot ride a URL path could never be verified: not a usable invoice.
      if (!TOKEN_TEXT.test(token)) return { kind: 'UNKNOWN', code: 'nexa.invoice_id_unsafe' };
      // The documented create answer carries no order id; one that names another is not ours.
      const echoed = fieldOf(raw.body, 'order_id');
      if (echoed !== undefined && echoed !== request.orderId) {
        return { kind: 'UNKNOWN', code: 'nexa.order_id_mismatch' };
      }
      // A link for another amount (a repeated order id answered 200) must never be paid.
      const echoedAmount = parseRialAmount(fieldOf(raw.body, 'amount'));
      if (echoedAmount !== null && echoedAmount !== request.amount) {
        return { kind: 'UNKNOWN', code: 'nexa.amount_mismatch' };
      }
      const paymentUrl = fieldOf(raw.body, 'payment_url');
      const invoiceUrl = safeLink(paymentUrl);
      return {
        kind: 'CREATED',
        invoiceId: token,
        orderId: request.orderId,
        invoiceUrl,
        webInvoiceUrl: null,
        ...(paymentUrl != null && invoiceUrl === null ? { linkRejected: true } : {}),
        status: metadataStatus(fieldOf(raw.body, 'status')) ?? 'created',
        // Metadata only, never a decision: what the provider echoed, in rial.
        requestAmount: echoedAmount,
        finalAmount: parseRialAmount(fieldOf(raw.body, 'payable_amount')),
      };
    }
    /*
     * A 5xx is UNKNOWN before any code is read: the provider may have failed after creating
     * the payment. A 429 is the provider's own refusal to process, retried with the SAME
     * order id, bounded, after its `Retry-After`. Any other 4xx is taken at its word only
     * with a readable code; without one it says nothing documented, and is UNKNOWN (a key
     * refusal excepted: a 401/403 is the installation's configuration whatever the body).
     */
    if (raw.status >= 500) return { kind: 'UNKNOWN', code: `http.${String(raw.status)}` };
    const code = errorCodeOf(raw.body);
    // The daily limit is a 429 too, and is NOT a rate limit: it is told apart by its code, first.
    if (code !== 'DAILY_LIMIT_REACHED' && (raw.status === 429 || code === 'RATE_LIMITED')) {
      const waitMs = response.retryAfterMs ?? retryAfterBodyMs(raw.body);
      return {
        kind: 'RATE_LIMITED',
        code: `${TETRAPAY_CODE_PREFIX}RATE_LIMITED`,
        httpStatus: raw.status,
        ...(waitMs === null ? {} : { retryAfterMs: waitMs }),
      };
    }
    if (code === null) {
      if (refusesKey(raw.status)) {
        return {
          kind: 'REFUSED',
          code: `${TETRAPAY_CODE_PREFIX}UNAUTHORIZED`,
          configuration: true,
          httpStatus: raw.status,
        };
      }
      return { kind: 'UNKNOWN', code: `http.${String(raw.status)}` };
    }
    const stored = boundedCode(`${TETRAPAY_CODE_PREFIX}${code}`);
    if (!isDocumentedCode(code)) {
      // A readable refusal the documentation does not list: the provider's word, stored bounded.
      return {
        kind: 'REFUSED',
        code: stored,
        configuration: refusesKey(raw.status),
        httpStatus: raw.status,
      };
    }
    switch (code) {
      case 'ORDER_CONFLICT':
        // An invoice may already exist under this order id: never retried, never re-keyed.
        return { kind: 'AMBIGUOUS', code: stored, httpStatus: raw.status };
      case 'INTERNAL':
        return { kind: 'UNKNOWN', code: stored, httpStatus: raw.status };
      case 'DAILY_LIMIT_REACHED':
        return {
          kind: 'REFUSED',
          code: TETRAPAY_DAILY_LIMIT_STORED,
          configuration: false,
          httpStatus: raw.status,
          routeEffect: 'HIDE_UNTIL_TEHRAN_MIDNIGHT',
        };
      case 'AMOUNT_OUT_OF_RANGE': {
        // The provider's own bounds, converted rial -> Toman, kept in the stored code so the
        // customer's screen and the operator read the same figures. 0: not stated / not whole.
        const min = tomanBound(raw.body, ['min', 'min_amount']);
        const max = tomanBound(raw.body, ['max', 'max_amount']);
        return {
          kind: 'REFUSED',
          code: `${TETRAPAY_AMOUNT_OUT_OF_RANGE_STORED}:${min.toString()}:${max.toString()}`,
          configuration: false,
          httpStatus: raw.status,
        };
      }
      default:
        return {
          kind: 'REFUSED',
          code: stored,
          configuration: (TETRAPAY_CONFIGURATION_ERRORS as readonly string[]).includes(code),
          httpStatus: raw.status,
        };
    }
  }

  /**
   * `POST /payments/{token}/verify` — the one question whose answer may settle money. `token`
   * is the invoice id the create returned.
   */
  async inquire(
    apiKey: string,
    invoiceId: string,
    context?: GatewayInquiryContext,
  ): Promise<GatewayInquiryOutcome> {
    if (context === undefined) return { kind: 'FAILED', code: 'nexa.no_inquiry_context' };
    const base = this.baseUrl();
    if (!TOKEN_TEXT.test(invoiceId)) return { kind: 'FAILED', code: 'nexa.invoice_id_unsafe' };
    const response = await this.call(
      'POST',
      `${base}${TETRAPAY_CREATE_PATH}/${encodeURIComponent(invoiceId)}${TETRAPAY_VERIFY_PATH_SUFFIX}`,
      apiKey,
      // No body (§3.3): the verify takes none, so it carries no content type either.
      null,
    );
    const raw = response.raw;
    if (raw.kind === 'NO_RESPONSE') return { kind: 'FAILED', code: `http.${raw.reason}` };
    if (raw.kind === 'UNREADABLE')
      return { kind: 'FAILED', code: boundedCode(unreadableCode(raw)) };
    if (raw.status >= 200 && raw.status < 300) {
      const status = stringField(raw.body, 'status', GATEWAY_PROVIDER_STATUS_MAX_LENGTH);
      // The status DECIDES, so it stays strict: a string, or no answer at all.
      if (status === null) {
        return { kind: 'FAILED', code: `http.${String(raw.status)}.unexpected_body:status` };
      }
      const orderId = fieldOf(raw.body, 'order_id');
      const returnedToken = stringField(raw.body, 'token', GATEWAY_PROVIDER_ID_MAX_LENGTH);
      const judgement = tetrapayJudgement(
        {
          status,
          orderId,
          amount: fieldOf(raw.body, 'amount'),
          payableAmount: fieldOf(raw.body, 'payable_amount'),
          receivedAmount: fieldOf(raw.body, 'received_amount'),
        },
        { orderId: context.providerOrderId, sentAmount: context.sentAmount },
      );
      return {
        kind: 'OBSERVED',
        // The ids the PROVIDER returned; the orchestrator compares them with the attempt's.
        // An order id the answer omits is bound by the token we asked about.
        invoiceId: returnedToken ?? invoiceId,
        orderId: typeof orderId === 'string' ? orderId : context.providerOrderId,
        status,
        paid: judgement.verdict === 'APPROVED',
        verdict: judgement.verdict,
        requestAmount: parseRialAmount(fieldOf(raw.body, 'amount')),
        finalAmount: parseRialAmount(fieldOf(raw.body, 'payable_amount')),
        ...(isMethod(fieldOf(raw.body, 'method'))
          ? { method: fieldOf(raw.body, 'method') as string }
          : {}),
        ...(judgement.mismatchReason === null ? {} : { mismatchReason: judgement.mismatchReason }),
      };
    }
    const code = errorCodeOf(raw.body);
    if (raw.status === 429 || code === 'RATE_LIMITED' || code === 'DAILY_LIMIT_REACHED') {
      const waitMs = response.retryAfterMs ?? retryAfterBodyMs(raw.body);
      return {
        kind: 'RATE_LIMITED',
        code: `${TETRAPAY_CODE_PREFIX}${code ?? 'RATE_LIMITED'}`,
        ...(waitMs === null ? {} : { retryAfterMs: waitMs }),
      };
    }
    if (raw.status === 404 || code === 'NOT_FOUND') {
      return { kind: 'NOT_FOUND', code: `${TETRAPAY_CODE_PREFIX}NOT_FOUND` };
    }
    // GATEWAY_SUSPENDED refuses a CREATE only; on a verify it is a failed read, never a
    // misconfiguration — the inquiry keeps working and is asked again.
    if (raw.status === 401 || code === 'UNAUTHORIZED') {
      return { kind: 'CONFIGURATION', code: `${TETRAPAY_CODE_PREFIX}UNAUTHORIZED` };
    }
    return {
      kind: 'FAILED',
      code:
        code === null
          ? `http.${String(raw.status)}`
          : boundedCode(`${TETRAPAY_CODE_PREFIX}${code}`),
    };
  }

  /**
   * Shape-checks a webhook body (§7): `event`, `event_id`, `token`, `status`, `order_id`, and the
   * amounts. Only the attempt's locators are read - the order id and the token - plus the status
   * as a hint to display; no amount in it is ever used, because the verify decides. Reads NO
   * secret header; the signature was checked (or not required) before this ran. The dedupe key
   * is `X-TetraPay-Event-Id`, else the body's `event_id` (the same value, §7).
   */
  parseWebhook(body: unknown, deliveryIdHeader: string | undefined): GatewayWebhookHint | null {
    const top = asObject(body);
    if (top === null) return null;
    const orderId = stringField(top, 'order_id', 64);
    const token = stringField(top, 'token', GATEWAY_PROVIDER_ID_MAX_LENGTH);
    if (orderId === null || token === null) return null;
    const header =
      typeof deliveryIdHeader === 'string' &&
      deliveryIdHeader.length > 0 &&
      deliveryIdHeader.length <= 128
        ? deliveryIdHeader
        : null;
    const eventId = header ?? stringField(top, 'event_id', 128);
    return {
      orderId,
      invoiceId: token,
      status: metadataStatus(top['status']),
      // Stable across the provider's retries of one event: the dedupe key.
      deliveryId: eventId,
      creditAmount: null,
    };
  }

  verifyWebhook(
    secret: string,
    _body: unknown,
    signature: string | undefined,
    context?: { readonly rawBody: Uint8Array | null; readonly now: Date },
  ): boolean {
    // Over the RAW bytes. A route that kept none (or a caller that passed none) verifies nothing.
    return verifyTetraPayWebhook(
      secret,
      context?.rawBody ?? null,
      signature,
      context?.now ?? (this.options.now ?? (() => new Date()))(),
    );
  }

  private async call(
    method: 'GET' | 'POST',
    url: string,
    apiKey: string,
    body: Record<string, unknown> | null,
  ): Promise<TetraPayResponse> {
    return tetrapayRequest(this.options, { method, url, apiKey, body });
  }
}

/**
 * ONE TetraPay HTTP request: the key in its `Authorization` header and nowhere else,
 * `redirect: 'error'`, the timeout, the bounded streaming read, the transport classifier, and
 * the response's `Retry-After`.
 */
export async function tetrapayRequest(
  options: { readonly fetch?: FetchLike; readonly timeoutMs?: number; readonly now?: () => Date },
  request: {
    readonly method: 'GET' | 'POST';
    readonly url: string;
    readonly apiKey: string;
    readonly body: Record<string, unknown> | null;
  },
): Promise<TetraPayResponse> {
  assertOutsideTransaction('A TetraPay call');
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? TETRAPAY_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await doFetch(request.url, {
        method: request.method,
        headers: {
          ...(request.body === null ? {} : { 'content-type': 'application/json' }),
          accept: 'application/json',
          authorization: `${TETRAPAY_AUTHORIZATION_SCHEME} ${request.apiKey}`,
        },
        ...(request.body === null ? {} : { body: JSON.stringify(request.body) }),
        signal: controller.signal,
        redirect: 'error',
      });
    } catch (error: unknown) {
      return {
        raw: { kind: 'NO_RESPONSE', reason: transportReason(error, controller.signal.aborted) },
        retryAfterMs: null,
      };
    }
    const retryAfterMs = retryAfterMsOf(
      response.headers.get('retry-after'),
      (options.now ?? (() => new Date()))(),
    );
    let text: string | null;
    try {
      text = await readBounded(response, MAX_RESPONSE_BYTES);
    } catch {
      return {
        raw: controller.signal.aborted
          ? { kind: 'NO_RESPONSE', reason: 'timeout' }
          : { kind: 'UNREADABLE', status: response.status, shape: 'stream' },
        retryAfterMs,
      };
    }
    if (text === null) {
      return {
        raw: { kind: 'UNREADABLE', status: response.status, shape: 'too_large' },
        retryAfterMs,
      };
    }
    try {
      return {
        raw: { kind: 'BODY', status: response.status, body: JSON.parse(text) as unknown },
        retryAfterMs,
      };
    } catch {
      const trimmed = text.trimStart();
      const contentType = response.headers.get('content-type') ?? '';
      const shape: UnreadableShape =
        trimmed === ''
          ? 'empty'
          : trimmed.startsWith('<') || /html/iu.test(contentType)
            ? 'html'
            : 'text';
      return { raw: { kind: 'UNREADABLE', status: response.status, shape }, retryAfterMs };
    }
  } finally {
    clearTimeout(timer);
  }
}
