import { randomBytes } from 'node:crypto';
import {
  CUSTOM_AMOUNT_UNIT,
  CUSTOM_ATTEMPT_LIFETIME_MINUTES,
  CUSTOM_CALL_BUDGET_PER_MINUTE,
  CUSTOM_CODE_PREFIX,
  CUSTOM_DELIVERY_ID_PATTERN,
  CUSTOM_ERROR_CODE_PATTERN,
  CUSTOM_GATEWAY_CLOCK_WARNING_SECONDS,
  CUSTOM_GATEWAY_CONFIGURATION_ERRORS,
  CUSTOM_GATEWAY_ERROR_CODES,
  CUSTOM_GATEWAY_HEADERS,
  CUSTOM_GATEWAY_PATHS,
  CUSTOM_GATEWAY_PROTOCOL,
  CUSTOM_GATEWAY_PROTOCOL_VERSION,
  CUSTOM_GATEWAY_RETRY_AFTER_MAX_MS,
  CUSTOM_GATEWAY_STATUS_EVENT,
  CUSTOM_GATEWAY_TEST_EVENT,
  CUSTOM_INQUIRY_BUDGET_PER_MINUTE,
  CUSTOM_INVOICE_ID_PATTERN,
  CUSTOM_PAYMENT_URL_MAX_LENGTH,
  GATEWAY_PROVIDER_STATUS_MAX_LENGTH,
  type CustomGatewayErrorCode,
  type Money,
  type ProviderHttpRequest,
  type ProviderHttpResult,
  type ResolvedConversion,
} from '@nexa/contracts';
import { assertOutsideTransaction } from '../../../../infrastructure/transaction-boundary.js';
import type {
  ExternalGatewayAdapter,
  GatewayCreateOutcome,
  GatewayCreateRequest,
  GatewayCredentialCheck,
  GatewayInquiryContext,
  GatewayInquiryOutcome,
  GatewayWebhookHint,
} from '../application/gateway-invoice-ports.js';
import { CENTRALPAY_INTEGER_RANDOM_BYTES, centralpayInteger } from '../domain/centralpay.js';
import {
  CUSTOM_ORDER_ID_RANDOM_BYTES,
  customAmountOf,
  customJudgement,
  customMoneyWire,
  customOrderId,
  isSafeReference,
  parseCustomMoney,
} from '../domain/custom-gateway.js';
import { signNexaRequest, verifyBridgeSignature } from './custom-gateway-signature.js';

/**
 * The custom gateway over HTTPS — the only code that speaks Nexa's bridge protocol
 * (`docs/protocols/custom-gateway.md`).
 *
 * What makes it different from every other adapter is that its HOST is the operator's: the
 * bridge's base URL is typed in the Web Admin. So it never calls `fetch`. Every request goes
 * through the installation's `SafeHttpClient` (the URL policy every panel call obeys): https
 * only — refused here before any call too — DNS resolved once and pinned, no loopback, no
 * link-local or cloud-metadata address, none of Nexa's own networks, no redirect, a 15-second
 * budget for the whole call, a 64 KiB cap read while reading, and the transaction guard.
 *
 * The rules every adapter keeps, for the same reasons:
 *
 * - the secret appears in NO request: only signatures made with it do (§4), and nothing here
 *   logs, returns or stores a body, a header, a URL or a bridge's free-text `message`;
 * - a create is a WRITE: a connection lost after sending, a timeout, a 5xx, a 3xx, an answer
 *   whose signature does not verify and an unreadable 2xx are UNKNOWN — the payment may exist —
 *   and Nexa never sends that create again (it READS by `invoice_id`, §3.1). Only
 *   `429 RATE_LIMITED` clears the stamp. A failure before any byte left (no address, a blocked
 *   target, a TLS handshake that failed) is a refusal: nothing was created;
 * - only the INQUIRY can approve, and only a SIGNED answer: TLS alone is not trusted to say
 *   `PAID` (§5). The verdict is `customJudgement`'s, a pure function;
 * - a callback is verified BEFORE any field is read, over the raw bytes, and is still only a hint.
 *
 * Never throws for anything the network or the bridge does.
 */

type JsonObject = Readonly<Record<string, unknown>>;

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

const code = (name: CustomGatewayErrorCode): string => `${CUSTOM_CODE_PREFIX}${name}`;

/** A bridge's error `code` (§8), as Nexa's own name for it; never its `message`. */
function errorCodeOf(body: unknown): CustomGatewayErrorCode | null {
  const error = asObject(asObject(body)?.['error']);
  const value = error?.['code'];
  if (typeof value !== 'string' || !CUSTOM_ERROR_CODE_PATTERN.test(value)) return null;
  return (CUSTOM_GATEWAY_ERROR_CODES as readonly string[]).includes(value)
    ? (value as CustomGatewayErrorCode)
    : 'UNKNOWN_CODE';
}

function isConfiguration(name: CustomGatewayErrorCode): boolean {
  return CUSTOM_GATEWAY_CONFIGURATION_ERRORS.includes(name);
}

/** `Retry-After` in whole seconds, bounded (§7). Absent or unreadable: undefined. */
function retryAfterMsOf(headers: Readonly<Record<string, string>>): number | undefined {
  const value = headers['retry-after'];
  if (value === undefined || !/^[0-9]{1,6}$/u.test(value.trim())) return undefined;
  return Math.min(Number(value.trim()) * 1000, CUSTOM_GATEWAY_RETRY_AFTER_MAX_MS);
}

/** A payment page link a customer may be shown: https, bounded, no userinfo, no spaces. */
function safePaymentUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > CUSTOM_PAYMENT_URL_MAX_LENGTH) return null;
  if (!/^https:\/\/[^\s/?#@\\]+(?:[/?#][^\s\\]*)?$/u.test(value)) return null;
  return value;
}

/** The transport failure's machine code: the kind, and for a lost write that it was lost. */
function failureCode(result: Extract<ProviderHttpResult, { ok: false }>): string {
  const kind = result.failure.toLowerCase();
  return result.status === null ? `http.${kind}` : `http.${String(result.status)}.${kind}`;
}

/**
 * A failure before any byte of the request can have reached the bridge: no address, a target
 * the policy refused, a TLS handshake that failed. `SafeHttpClient` reports a WRITE that lost
 * its connection after sending as `TIMEOUT`, never as one of these.
 */
function nothingSent(result: Extract<ProviderHttpResult, { ok: false }>): boolean {
  return (
    result.failure === 'BLOCKED_TARGET' ||
    result.failure === 'UNREACHABLE' ||
    result.failure === 'TLS_FAILED'
  );
}

/** The outbound client: `SafeHttpClient.send`, or a test's fake. */
export interface CustomGatewayHttp {
  send(baseUrl: string, request: ProviderHttpRequest): Promise<ProviderHttpResult>;
}

/** A signed answer, read: verified first, then parsed. */
type Signed =
  | { readonly kind: 'TRANSPORT'; readonly result: Extract<ProviderHttpResult, { ok: false }> }
  | {
      readonly kind: 'ANSWER';
      readonly status: number;
      readonly headers: Readonly<Record<string, string>>;
      /** The parsed JSON body, or undefined when it was not JSON. */
      readonly body: unknown;
      /** Whether a 2xx carried a valid response signature for THIS request. */
      readonly signed: boolean;
    };

export class CustomGatewayAdapter implements ExternalGatewayAdapter {
  readonly provider = 'CUSTOM' as const;
  readonly unit = CUSTOM_AMOUNT_UNIT;
  readonly attemptLifetimeMs = CUSTOM_ATTEMPT_LIFETIME_MINUTES * 60_000;
  readonly callBudgetPerMinute = CUSTOM_CALL_BUDGET_PER_MINUTE;
  readonly inquiryBudgetPerMinute = CUSTOM_INQUIRY_BUDGET_PER_MINUTE;

  constructor(
    private readonly options: {
      readonly http: CustomGatewayHttp;
      /** The wall clock, for the signed timestamps. A test passes its own. */
      readonly now?: () => Date;
      readonly random?: (size: number) => Uint8Array;
    },
  ) {}

  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }

  private random(size: number): Uint8Array {
    return (this.options.random ?? ((n: number) => randomBytes(n)))(size);
  }

  /** The payable in RIAL. Only the same-unit policy is accepted: no rate is involved. */
  providerAmountOf(amount: Money, conversion: ResolvedConversion): bigint | null {
    if (conversion.policy !== 'SAME_UNIT') return null;
    return customAmountOf(amount);
  }

  newOrderId(): string {
    return customOrderId(this.random(CUSTOM_ORDER_ID_RANDOM_BYTES));
  }

  /** The customer's opaque `customer_ref` (§2.3): ten random digits, drawn once and kept. */
  newCustomerNumber(): string {
    return centralpayInteger(this.random(CENTRALPAY_INTEGER_RANDOM_BYTES));
  }

  /**
   * ONE signed request (§4) and its answer, with the answer's signature (§5) checked against
   * THIS request's nonce. The path signed is the protocol path; the path sent is the same path
   * made relative, so it resolves UNDER the base URL's own prefix.
   */
  private async exchange(
    secret: string,
    baseUrl: string,
    method: 'GET' | 'POST',
    path: string,
    payload: Record<string, unknown> | null,
    effect: 'READ' | 'WRITE',
    extraHeaders: Readonly<Record<string, string>> = {},
  ): Promise<Signed> {
    assertOutsideTransaction('A custom gateway call');
    const nonce = Buffer.from(this.random(16)).toString('hex');
    const timestamp = String(Math.floor(this.now().getTime() / 1000));
    // Exactly the bytes `SafeHttpClient` sends: it serialises the SAME value with JSON.stringify.
    const body = payload === null ? '' : JSON.stringify(payload);
    const signature = signNexaRequest(secret, { method, path, timestamp, nonce, body });
    const result = await this.options.http.send(baseUrl, {
      method,
      effect,
      path: path.replace(/^\/+/u, ''),
      headers: {
        [CUSTOM_GATEWAY_HEADERS.protocol]: CUSTOM_GATEWAY_PROTOCOL_VERSION,
        [CUSTOM_GATEWAY_HEADERS.timestamp]: timestamp,
        [CUSTOM_GATEWAY_HEADERS.nonce]: nonce,
        [CUSTOM_GATEWAY_HEADERS.signature]: signature,
        ...extraHeaders,
      },
      ...(payload === null ? {} : { body: { kind: 'json', value: payload } }),
    });
    if (!result.ok) return { kind: 'TRANSPORT', result };
    let parsed: unknown;
    try {
      parsed = result.bodyText.trim() === '' ? undefined : (JSON.parse(result.bodyText) as unknown);
    } catch {
      parsed = undefined;
    }
    const success = result.status >= 200 && result.status < 300;
    const signed =
      success &&
      verifyBridgeSignature(
        secret,
        'response',
        Buffer.from(result.bodyText, 'utf8'),
        result.headers[CUSTOM_GATEWAY_HEADERS.bridgeSignature],
        this.now(),
        nonce,
      );
    return { kind: 'ANSWER', status: result.status, headers: result.headers, body: parsed, signed };
  }

  async createInvoice(
    secret: string,
    request: GatewayCreateRequest,
  ): Promise<GatewayCreateOutcome> {
    // Refused LOCALLY, before any call: nothing was sent, so nothing can exist.
    const endpoint = request.endpoint ?? null;
    if (endpoint === null || !endpoint.startsWith('https://')) {
      return { kind: 'REFUSED', code: code('ENDPOINT_MISSING'), configuration: true };
    }
    const customerRef = request.providerUserId ?? null;
    if (customerRef === null || !/^[0-9]{10}$/u.test(customerRef)) {
      return { kind: 'REFUSED', code: 'nexa.customer_number_missing', configuration: false };
    }
    if (request.amount <= 0n || request.expiresAt === undefined || request.expiresAt === null) {
      return { kind: 'REFUSED', code: 'nexa.attempt_incomplete', configuration: false };
    }
    const payload = {
      invoice_id: request.orderId,
      amount: customMoneyWire(request.amount),
      callback_url: request.callbackUrl,
      expires_at: request.expiresAt.toISOString(),
      customer_ref: customerRef,
    };
    const answer = await this.exchange(
      secret,
      endpoint,
      'POST',
      CUSTOM_GATEWAY_PATHS.create,
      payload,
      'WRITE',
      { [CUSTOM_GATEWAY_HEADERS.idempotencyKey]: request.orderId },
    );
    if (answer.kind === 'TRANSPORT') {
      if (answer.result.failure === 'BLOCKED_TARGET') {
        return { kind: 'REFUSED', code: 'nexa.endpoint_blocked', configuration: true };
      }
      if (nothingSent(answer.result)) {
        return {
          kind: 'REFUSED',
          code: failureCode(answer.result),
          configuration: answer.result.failure === 'TLS_FAILED',
        };
      }
      // A timeout, a lost connection after sending, a 3xx, an oversized answer: it may exist.
      return { kind: 'UNKNOWN', code: failureCode(answer.result) };
    }
    const status = answer.status;
    if (status >= 200 && status < 300) {
      // Unsigned (or signed for another request): the payment may exist, and this is not proof.
      if (!answer.signed) return { kind: 'UNKNOWN', code: code('UNSIGNED'), httpStatus: status };
      const body = asObject(answer.body);
      const reference = body?.['reference'];
      if (body === null || !isSafeReference(reference)) {
        return { kind: 'UNKNOWN', code: code('UNREADABLE'), httpStatus: status };
      }
      const echoedAmount = parseCustomMoney(body['amount']);
      if (body['invoice_id'] !== request.orderId || echoedAmount !== request.amount) {
        // Never shown: the customer must not pay a figure, or an invoice, Nexa did not ask for.
        return {
          kind: 'REFUSED',
          code: code('ECHO_MISMATCH'),
          configuration: true,
          httpStatus: status,
          providerInvoiceId: reference,
        };
      }
      const link = safePaymentUrl(body['payment_url']);
      if (link === null) {
        return {
          kind: 'REFUSED',
          code: code('LINK_REJECTED'),
          configuration: true,
          httpStatus: status,
          providerInvoiceId: reference,
        };
      }
      const bridgeStatus = body['status'];
      return {
        kind: 'CREATED',
        invoiceId: reference,
        orderId: request.orderId,
        invoiceUrl: link,
        webInvoiceUrl: null,
        status:
          typeof bridgeStatus === 'string' &&
          bridgeStatus.length > 0 &&
          bridgeStatus.length <= GATEWAY_PROVIDER_STATUS_MAX_LENGTH
            ? bridgeStatus
            : 'PENDING',
        // Metadata only: what the bridge echoed, in rial.
        requestAmount: echoedAmount,
        finalAmount: null,
      };
    }
    // A 5xx before anything else is read: the bridge may have failed after creating it.
    if (status >= 500) return { kind: 'UNKNOWN', code: `http.${String(status)}` };
    const errorCode = errorCodeOf(answer.body);
    // A 4xx with no readable error body is no guarantee that nothing was created (§8).
    if (errorCode === null) return { kind: 'UNKNOWN', code: `http.${String(status)}` };
    if (status === 429) {
      // Only the bridge's own RATE_LIMITED code says "not processed"; a bare 429 does not.
      if (errorCode !== 'RATE_LIMITED') {
        return { kind: 'UNKNOWN', code: `http.429`, httpStatus: 429 };
      }
      const retryAfterMs = retryAfterMsOf(answer.headers);
      return {
        kind: 'RATE_LIMITED',
        code: code('RATE_LIMITED'),
        httpStatus: 429,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      };
    }
    if (errorCode === 'INVOICE_CONFLICT') {
      // A payment may already exist under this invoice id: never retried, never re-keyed.
      return { kind: 'AMBIGUOUS', code: code('INVOICE_CONFLICT'), httpStatus: status };
    }
    // Any other readable 4xx is the bridge's guarantee that nothing was created (§8).
    return {
      kind: 'REFUSED',
      code: code(errorCode),
      configuration: isConfiguration(errorCode) || status === 401 || status === 403,
      httpStatus: status,
    };
  }

  /**
   * `POST /v1/payments/inquiry` — the one question whose answer may settle money. `invoiceId`
   * is the bridge's reference, or — `context.byOrderId`, after a lost create — Nexa's own
   * invoice id, asked with `reference: null`.
   */
  async inquire(
    secret: string,
    invoiceId: string,
    context?: GatewayInquiryContext,
  ): Promise<GatewayInquiryOutcome> {
    if (context === undefined) return { kind: 'FAILED', code: 'nexa.no_inquiry_context' };
    const endpoint = context.endpoint ?? null;
    if (endpoint === null || !endpoint.startsWith('https://')) {
      return { kind: 'CONFIGURATION', code: code('ENDPOINT_MISSING') };
    }
    const byOrderId = context.byOrderId === true;
    const reference = byOrderId ? null : invoiceId;
    if (reference !== null && !isSafeReference(reference)) {
      return { kind: 'FAILED', code: 'nexa.invoice_id_unsafe' };
    }
    const answer = await this.exchange(
      secret,
      endpoint,
      'POST',
      CUSTOM_GATEWAY_PATHS.inquiry,
      { invoice_id: context.providerOrderId, reference },
      // A read: it changes nothing at the bridge (§3.2).
      'READ',
    );
    if (answer.kind === 'TRANSPORT') {
      return answer.result.failure === 'BLOCKED_TARGET' || answer.result.failure === 'TLS_FAILED'
        ? { kind: 'CONFIGURATION', code: failureCode(answer.result) }
        : { kind: 'FAILED', code: failureCode(answer.result) };
    }
    const status = answer.status;
    if (status >= 200 && status < 300) {
      // An answer that is not signed for THIS request says nothing — never an approval.
      if (!answer.signed) return { kind: 'FAILED', code: code('UNSIGNED') };
      const body = asObject(answer.body);
      const bridgeStatus = body?.['status'];
      const answeredReference = body?.['reference'];
      const answeredInvoiceId = body?.['invoice_id'];
      if (
        body === null ||
        typeof bridgeStatus !== 'string' ||
        bridgeStatus.length === 0 ||
        bridgeStatus.length > GATEWAY_PROVIDER_STATUS_MAX_LENGTH ||
        !isSafeReference(answeredReference) ||
        typeof answeredInvoiceId !== 'string' ||
        !CUSTOM_INVOICE_ID_PATTERN.test(answeredInvoiceId)
      ) {
        return { kind: 'FAILED', code: code('UNREADABLE') };
      }
      const judgement = customJudgement(
        {
          invoiceId: answeredInvoiceId,
          reference: answeredReference,
          status: bridgeStatus,
          amount: body['amount'],
          amountPaid: body['amount_paid'],
        },
        { orderId: context.providerOrderId, reference, sentAmount: context.sentAmount },
      );
      return {
        kind: 'OBSERVED',
        // The ids the BRIDGE returned; the lane compares them with the attempt's before anything.
        invoiceId: answeredReference,
        orderId: answeredInvoiceId,
        status: bridgeStatus,
        paid: judgement.verdict === 'APPROVED',
        verdict: judgement.verdict,
        // Metadata only: what the bridge said it was asked for, and what it says it captured.
        requestAmount: parseCustomMoney(body['amount']),
        finalAmount: parseCustomMoney(body['amount_paid']),
        ...(judgement.mismatchReason === null ? {} : { mismatchReason: judgement.mismatchReason }),
      };
    }
    // A read that failed is asked again later; nothing here decides anything.
    const errorCode = errorCodeOf(answer.body);
    if (status === 429 && errorCode === 'RATE_LIMITED') {
      const retryAfterMs = retryAfterMsOf(answer.headers);
      return {
        kind: 'RATE_LIMITED',
        code: code('RATE_LIMITED'),
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      };
    }
    if (status === 404 && errorCode === 'NOT_FOUND') {
      return { kind: 'NOT_FOUND', code: code('NOT_FOUND') };
    }
    if (status === 401 || status === 403) {
      return {
        kind: 'CONFIGURATION',
        code: errorCode === null ? `http.${String(status)}` : code(errorCode),
      };
    }
    return {
      kind: 'FAILED',
      code: errorCode === null ? `http.${String(status)}` : code(errorCode),
    };
  }

  /**
   * The Web Admin's «تست اتصال» (§3.4): `GET /v1/ping`, signed; passes only when the answer is
   * signed for this request, names this protocol and version and takes `IRR`. A bridge clock
   * more than a minute off fails it too (`CLOCK_SKEW`): signatures would start failing at five.
   * Creates nothing and moves no money.
   */
  async checkCredential(
    secret: string,
    context?: { readonly endpoint: string | null },
  ): Promise<GatewayCredentialCheck> {
    const endpoint = context?.endpoint ?? null;
    if (endpoint === null || !endpoint.startsWith('https://')) {
      return { kind: 'REFUSED', code: code('ENDPOINT_MISSING') };
    }
    const answer = await this.exchange(
      secret,
      endpoint,
      'GET',
      CUSTOM_GATEWAY_PATHS.ping,
      null,
      'READ',
    );
    if (answer.kind === 'TRANSPORT') {
      return answer.result.failure === 'BLOCKED_TARGET'
        ? { kind: 'REFUSED', code: 'nexa.endpoint_blocked' }
        : { kind: 'UNAVAILABLE', code: failureCode(answer.result) };
    }
    if (answer.status < 200 || answer.status >= 300) {
      const errorCode = errorCodeOf(answer.body);
      const named = errorCode === null ? `http.${String(answer.status)}` : code(errorCode);
      return answer.status >= 400 && answer.status < 500
        ? { kind: 'REFUSED', code: named }
        : { kind: 'UNAVAILABLE', code: named };
    }
    if (!answer.signed) return { kind: 'REFUSED', code: code('UNSIGNED') };
    const body = asObject(answer.body);
    if (
      body?.['protocol'] !== CUSTOM_GATEWAY_PROTOCOL ||
      body['version'] !== CUSTOM_GATEWAY_PROTOCOL_VERSION
    ) {
      return { kind: 'REFUSED', code: code('PROTOCOL_MISMATCH') };
    }
    const currencies = body['currencies'];
    if (!Array.isArray(currencies) || !currencies.includes(CUSTOM_AMOUNT_UNIT)) {
      return { kind: 'REFUSED', code: code('CURRENCY_UNSUPPORTED') };
    }
    const bridgeTime = body['bridge_time'];
    if (typeof bridgeTime === 'string') {
      const at = Date.parse(bridgeTime);
      if (
        Number.isFinite(at) &&
        Math.abs(at - this.now().getTime()) > CUSTOM_GATEWAY_CLOCK_WARNING_SECONDS * 1000
      ) {
        return { kind: 'REFUSED', code: code('CLOCK_SKEW') };
      }
    }
    return { kind: 'OK' };
  }

  /** The callback's signature (§5): verified over the RAW bytes, before any field is read. */
  verifyWebhook(
    secret: string,
    _body: unknown,
    signature: string | undefined,
    context?: { readonly rawBody: Uint8Array | null; readonly now: Date },
  ): boolean {
    if (context === undefined) return false;
    return verifyBridgeSignature(secret, 'callback', context.rawBody, signature, context.now);
  }

  /** The bridge admin's own test delivery (§3.3): `event: "test"`, names no payment. */
  isWebhookProbe(body: unknown): boolean {
    const top = asObject(body);
    return (
      top?.['version'] === CUSTOM_GATEWAY_PROTOCOL_VERSION &&
      top['event'] === CUSTOM_GATEWAY_TEST_EVENT
    );
  }

  /**
   * Shape-checks a VERIFIED callback (§3.3): version `1`, `payment.status_changed`, the invoice
   * id, the reference when given, a delivery id that is the header's too (the body is what is
   * signed, so a header that disagrees is refused). Only the attempt's locators, the status as a
   * display hint and the delivery id (the dedupe key) are read: nothing in it can settle.
   */
  parseWebhook(body: unknown, deliveryIdHeader: string | undefined): GatewayWebhookHint | null {
    const top = asObject(body);
    if (top === null) return null;
    if (top['version'] !== CUSTOM_GATEWAY_PROTOCOL_VERSION) return null;
    if (top['event'] !== CUSTOM_GATEWAY_STATUS_EVENT) return null;
    const deliveryId = top['delivery_id'];
    if (typeof deliveryId !== 'string' || !CUSTOM_DELIVERY_ID_PATTERN.test(deliveryId)) return null;
    if (deliveryIdHeader !== deliveryId) return null;
    const invoiceId = top['invoice_id'];
    if (typeof invoiceId !== 'string' || !CUSTOM_INVOICE_ID_PATTERN.test(invoiceId)) return null;
    const reference = top['reference'];
    if (reference !== undefined && reference !== null && !isSafeReference(reference)) return null;
    const status = top['status'];
    return {
      orderId: invoiceId,
      invoiceId: isSafeReference(reference) ? reference : null,
      status:
        typeof status === 'string' &&
        status.length > 0 &&
        status.length <= GATEWAY_PROVIDER_STATUS_MAX_LENGTH
          ? status
          : null,
      deliveryId,
      creditAmount: null,
    };
  }
}
