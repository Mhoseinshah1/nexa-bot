import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  CENTRALPAY_AMOUNT_UNIT,
  CENTRALPAY_ATTEMPT_LIFETIME_MINUTES,
  CENTRALPAY_BASE_URL,
  CENTRALPAY_CALL_BUDGET_PER_MINUTE,
  CENTRALPAY_DEPOSIT_TYPE,
  CENTRALPAY_GET_LINK_PATH,
  CENTRALPAY_INQUIRY_BUDGET_PER_MINUTE,
  CENTRALPAY_VERIFY_PATH,
  GATEWAY_PROVIDER_URL_MAX_LENGTH,
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
  CENTRALPAY_INTEGER_RANDOM_BYTES,
  centralpayInteger,
  centralpayReturnUrl,
  centralpayVerdict,
  isCentralPayInteger,
  providerInteger,
} from '../domain/centralpay.js';
import { tomanAmountOf } from '../domain/tonpays.js';
import {
  boundedCode,
  readBounded,
  transportReason,
  unreadableCode,
  type FetchLike,
  type Raw,
  type UnreadableShape,
} from './tonpays-adapter.js';

/**
 * CentralPay over HTTP, and the only code in the installation that speaks it
 * (`docs/centralpay-gateway-audit.md`).
 *
 * The TonPays adapter's rules, for the same reasons:
 *
 * - the base URL is the documented constant — a configurable one would be a place to send
 *   a key somewhere else;
 * - each key appears in exactly one place, the request body field `api_key` the guide
 *   documents: never in a URL, an outcome, an error code or a log line — and since the body
 *   carries a key, no body (sent or received) is ever logged or echoed;
 * - `redirect: 'error'`, a timeout, a bounded read, and a transport classifier that keeps a
 *   system code and never an error message;
 * - a 5xx, a timeout, a network error and an unreadable body are UNKNOWN on a create and
 *   transient on a read.
 *
 * Specific to CentralPay:
 *
 * - `getLink` and `verify` use DIFFERENT keys; the orchestrator hands each call its own.
 * - Amounts are integer TOMAN, sent and verified exactly (an IRR payable must divide by ten).
 * - `orderId` is the attempt's integer and also stands as its invoice id: `getLink` returns
 *   no id of its own, and `verify` is asked by `orderId`.
 * - `verify`'s `userCardNumber` is NEVER read: it is not in the schema, so it never reaches
 *   an outcome, a row, an audit `after` or a log line.
 * - No webhook is documented, so `parseWebhook` accepts nothing.
 *
 * Never throws for anything the network or the provider does. Refuses to run inside a
 * database transaction.
 */

export const CENTRALPAY_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

const envelopeSchema = z.object({ success: z.unknown(), data: z.unknown().optional() });
const linkDataSchema = z.object({ redirectUrl: z.string().min(1) });
/*
 * The verify fields a decision reads, raw — judged by `centralpayVerdict`, never coerced
 * here. `userCardNumber` is deliberately absent: zod drops it with every other unknown key.
 */
const verifyDataSchema = z.object({
  amount: z.unknown().optional(),
  userId: z.unknown().optional(),
  referenceId: z.unknown().optional(),
  orderId: z.unknown().optional(),
});

function safeLink(value: string): string | null {
  if (value.length > GATEWAY_PROVIDER_URL_MAX_LENGTH) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/** A 401 or 403: the provider refused THIS installation's key, never the customer's payment. */
function refusesKey(status: number): boolean {
  return status === 401 || status === 403;
}

/** A JSON number for an integer this installation chose; null past the exact range. */
function jsonInteger(value: bigint | string): number | null {
  const big = typeof value === 'bigint' ? value : BigInt(value);
  return big > 0n && big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : null;
}

export class CentralPayAdapter implements ExternalGatewayAdapter {
  readonly provider = 'CENTRALPAY' as const;
  readonly unit = CENTRALPAY_AMOUNT_UNIT;
  readonly attemptLifetimeMs = CENTRALPAY_ATTEMPT_LIFETIME_MINUTES * 60_000;
  readonly callBudgetPerMinute = CENTRALPAY_CALL_BUDGET_PER_MINUTE;
  readonly inquiryBudgetPerMinute = CENTRALPAY_INQUIRY_BUDGET_PER_MINUTE;

  constructor(
    private readonly options: {
      readonly fetch?: FetchLike;
      readonly timeoutMs?: number;
      readonly random?: (size: number) => Uint8Array;
    } = {},
  ) {}

  /** The payable in whole Toman, or null (an IRR figure that is not a whole Toman). */
  providerAmountOf(amount: Money, conversion: ResolvedConversion): bigint | null {
    if (conversion.policy !== 'SAME_UNIT') return null;
    return tomanAmountOf(amount);
  }

  newOrderId(): string {
    return this.draw();
  }

  newCustomerNumber(): string {
    return this.draw();
  }

  private draw(): string {
    const random = this.options.random ?? ((size: number) => randomBytes(size));
    return centralpayInteger(random(CENTRALPAY_INTEGER_RANDOM_BYTES));
  }

  async createInvoice(
    apiKey: string,
    request: GatewayCreateRequest,
  ): Promise<GatewayCreateOutcome> {
    /*
     * The return URL is REQUIRED by the guide and must carry the order id. With no public
     * origin registered there is no URL to send: the installation's configuration, refused
     * before any call, never presented as the customer's payment.
     */
    if (request.callbackUrl === null) {
      return { kind: 'REFUSED', code: 'nexa.no_return_url', configuration: true };
    }
    const amount = jsonInteger(request.amount);
    const orderId = isCentralPayInteger(request.orderId) ? jsonInteger(request.orderId) : null;
    const userId =
      request.providerUserId !== undefined &&
      request.providerUserId !== null &&
      isCentralPayInteger(request.providerUserId)
        ? jsonInteger(request.providerUserId)
        : null;
    if (amount === null) {
      return { kind: 'REFUSED', code: 'nexa.amount_out_of_range', configuration: false };
    }
    if (orderId === null || userId === null) {
      return { kind: 'REFUSED', code: 'nexa.identity_unavailable', configuration: false };
    }
    const raw = await this.call(CENTRALPAY_GET_LINK_PATH, {
      api_key: apiKey,
      type: CENTRALPAY_DEPOSIT_TYPE,
      amount,
      userId,
      orderId,
      returnUrl: centralpayReturnUrl(request.callbackUrl, request.orderId),
    });
    if (raw.kind === 'NO_RESPONSE') return { kind: 'UNKNOWN', code: `http.${raw.reason}` };
    if (raw.kind === 'UNREADABLE') {
      return { kind: 'UNKNOWN', code: boundedCode(unreadableCode(raw)) };
    }
    // A 5xx may have failed after the link was made; a 429 was not processed.
    if (raw.status >= 500) return { kind: 'UNKNOWN', code: `http.${String(raw.status)}` };
    if (raw.status === 429) return { kind: 'RATE_LIMITED', code: 'http.429' };
    if (refusesKey(raw.status)) {
      return { kind: 'REFUSED', code: `http.${String(raw.status)}`, configuration: true };
    }
    const envelope = envelopeSchema.safeParse(raw.body);
    if (!envelope.success) {
      return {
        kind: 'UNKNOWN',
        code: `http.${String(raw.status)}.unexpected_body:success`,
      };
    }
    if (envelope.data.success === true && raw.status >= 200 && raw.status < 300) {
      const data = linkDataSchema.safeParse(envelope.data.data);
      if (!data.success) {
        return {
          kind: 'UNKNOWN',
          code: `http.${String(raw.status)}.unexpected_body:redirectUrl`,
        };
      }
      return {
        kind: 'CREATED',
        // CentralPay returns no id of its own: the attempt's order id stands as the invoice id.
        invoiceId: request.orderId,
        orderId: request.orderId,
        invoiceUrl: safeLink(data.data.redirectUrl),
        webInvoiceUrl: null,
        // FIX-04: a redirect URL was sent and refused as unsafe — the fact, never the value.
        ...(safeLink(data.data.redirectUrl) === null ? { linkRejected: true } : {}),
        status: null,
        requestAmount: null,
        finalAmount: null,
      };
    }
    /*
     * A readable `success: false`: no link exists. The guide names no failure vocabulary,
     * so nothing in it is read (it may echo the request, which carries the key), and it is
     * treated as the merchant's configuration — the operator is told, and the customer is
     * told the method is unavailable rather than that a payment failed (`OQ-CP-03`).
     */
    if (envelope.data.success === false) {
      return { kind: 'REFUSED', code: 'centralpay.not_success', configuration: true };
    }
    return { kind: 'UNKNOWN', code: `http.${String(raw.status)}.unexpected_body:success` };
  }

  async inquire(
    verifyKey: string,
    invoiceId: string,
    context?: GatewayInquiryContext,
  ): Promise<GatewayInquiryOutcome> {
    if (context === undefined) return { kind: 'FAILED', code: 'nexa.no_inquiry_context' };
    const orderId = isCentralPayInteger(invoiceId) ? jsonInteger(invoiceId) : null;
    if (orderId === null) return { kind: 'FAILED', code: 'nexa.not_an_order_id' };
    const raw = await this.call(CENTRALPAY_VERIFY_PATH, { api_key: verifyKey, orderId });
    if (raw.kind === 'NO_RESPONSE') return { kind: 'FAILED', code: `http.${raw.reason}` };
    if (raw.kind === 'UNREADABLE') {
      return { kind: 'FAILED', code: boundedCode(unreadableCode(raw)) };
    }
    if (raw.status === 429) return { kind: 'RATE_LIMITED', code: 'http.429' };
    if (refusesKey(raw.status)) {
      return { kind: 'CONFIGURATION', code: `http.${String(raw.status)}` };
    }
    if (raw.status >= 500) return { kind: 'FAILED', code: `http.${String(raw.status)}` };
    const envelope = envelopeSchema.safeParse(raw.body);
    if (!envelope.success || typeof envelope.data.success !== 'boolean') {
      return { kind: 'FAILED', code: `http.${String(raw.status)}.unexpected_body:success` };
    }
    /*
     * `success: false` (on a 2xx, or a 4xx the provider chose to answer that way) is NOT a
     * definitive "no": the guide documents no failure vocabulary. Recorded as `unverified`,
     * open, asked again on the schedule until the deadline.
     */
    if (!envelope.data.success) {
      return this.observed(invoiceId, invoiceId, context, {
        success: false,
        amount: undefined,
        userId: undefined,
        referenceId: undefined,
      });
    }
    if (raw.status < 200 || raw.status >= 300) {
      return { kind: 'FAILED', code: `http.${String(raw.status)}` };
    }
    const data = verifyDataSchema.safeParse(envelope.data.data ?? {});
    const fields = data.success ? data.data : {};
    /*
     * The guide's success data carries no `orderId`; one that IS present and names another
     * order makes this an answer about another attempt — handed back as such, and the
     * orchestrator records it as an identity mismatch and acts on nothing.
     */
    const echoed = 'orderId' in fields ? providerInteger(fields.orderId) : null;
    const answeredOrderId =
      'orderId' in fields && fields.orderId !== undefined && fields.orderId !== null
        ? (echoed?.toString() ?? 'unreadable')
        : invoiceId;
    return this.observed(invoiceId, answeredOrderId, context, {
      success: true,
      amount: fields.amount,
      userId: fields.userId,
      referenceId: fields.referenceId,
    });
  }

  private observed(
    invoiceId: string,
    orderId: string,
    context: GatewayInquiryContext,
    verification: {
      readonly success: boolean;
      readonly amount: unknown;
      readonly userId: unknown;
      readonly referenceId: unknown;
    },
  ): GatewayInquiryOutcome {
    const judgement = centralpayVerdict(verification, {
      toman: context.sentAmount,
      userId: context.providerUserId ?? null,
    });
    return {
      kind: 'OBSERVED',
      invoiceId,
      orderId,
      status: judgement.status,
      paid: judgement.verdict === 'APPROVED',
      verdict: judgement.verdict,
      // Metadata only: the Toman the provider reported, when it reads as an exact integer.
      requestAmount: verification.success ? providerInteger(verification.amount) : null,
      finalAmount: null,
      providerReference: judgement.reference,
      mismatchReason: judgement.mismatchReason,
    };
  }

  /** CentralPay documents no webhook: nothing posted to Nexa is ever read as one. */
  parseWebhook(_body: unknown, _deliveryIdHeader: string | undefined): GatewayWebhookHint | null {
    return null;
  }

  private async call(path: string, body: Record<string, unknown>): Promise<Raw> {
    return centralpayRequest(this.options, { url: `${CENTRALPAY_BASE_URL}${path}`, body });
  }
}

/**
 * ONE CentralPay HTTP request: a JSON POST whose body carries the key (the guide's own
 * shape), `redirect: 'error'`, the timeout, the bounded read and the transport classifier.
 * Neither the request nor the response body is ever logged.
 */
export async function centralpayRequest(
  options: { readonly fetch?: FetchLike; readonly timeoutMs?: number },
  request: { readonly url: string; readonly body: Record<string, unknown> },
): Promise<Raw> {
  assertOutsideTransaction('A CentralPay call');
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? CENTRALPAY_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await doFetch(request.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(request.body),
        signal: controller.signal,
        redirect: 'error',
      });
    } catch (error: unknown) {
      return { kind: 'NO_RESPONSE', reason: transportReason(error, controller.signal.aborted) };
    }
    let text: string | null;
    try {
      text = await readBounded(response, MAX_RESPONSE_BYTES);
    } catch {
      return controller.signal.aborted
        ? { kind: 'NO_RESPONSE', reason: 'timeout' }
        : { kind: 'UNREADABLE', status: response.status, shape: 'stream' };
    }
    if (text === null) return { kind: 'UNREADABLE', status: response.status, shape: 'too_large' };
    try {
      return { kind: 'BODY', status: response.status, body: JSON.parse(text) as unknown };
    } catch {
      const trimmed = text.trimStart();
      const contentType = response.headers.get('content-type') ?? '';
      const shape: UnreadableShape =
        trimmed === ''
          ? 'empty'
          : trimmed.startsWith('<') || /html/iu.test(contentType)
            ? 'html'
            : 'text';
      return { kind: 'UNREADABLE', status: response.status, shape };
    }
  } finally {
    clearTimeout(timer);
  }
}
