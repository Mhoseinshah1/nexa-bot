import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  GATEWAY_PROVIDER_ID_MAX_LENGTH,
  GATEWAY_PROVIDER_STATUS_MAX_LENGTH,
  GATEWAY_PROVIDER_URL_MAX_LENGTH,
  GATEWAY_ERROR_CODE_MAX_LENGTH,
  TONPAYS_AMOUNT_UNIT,
  TONPAYS_ATTEMPT_LIFETIME_MINUTES,
  TONPAYS_CALL_BUDGET_PER_MINUTE,
  TONPAYS_INQUIRY_BUDGET_PER_MINUTE,
  TONPAYS_API_KEY_HEADER,
  TONPAYS_BASE_URL,
  TONPAYS_CHECK_PATH,
  TONPAYS_CREATE_PATH,
  type Money,
} from '@nexa/contracts';
import { assertOutsideTransaction } from '../../../../infrastructure/transaction-boundary.js';
import type {
  ExternalGatewayAdapter,
  GatewayCreateOutcome,
  GatewayCreateRequest,
  GatewayInquiryOutcome,
  GatewayWebhookHint,
} from '../application/gateway-invoice-ports.js';
import {
  TONPAYS_ORDER_ID_RANDOM_BYTES,
  classifyTonPaysError,
  tomanAmountOf,
  tonpaysOrderId,
  tonpaysVerdict,
} from '../domain/tonpays.js';

/**
 * TonPays over HTTP, and the only code in the installation that speaks it (WP11A).
 *
 * Everything here is read off `https://doc.tonpays.online/` and nothing is added to it:
 *
 * - The base URL is the documented constant. There is no sandbox and no configurable
 *   URL — a configurable base would be a place to send the API key somewhere else.
 * - `X-API-Key` carries the key, and the key appears NOWHERE else: not in a URL, not in
 *   an error message, not in a returned outcome, not in a log line. An outcome carries a
 *   machine code and the provider's documented fields only.
 * - `redirect: 'error'`, the rule `send-message.ts` states for the Telegram token: a 30x
 *   would carry the header to wherever it points.
 * - A readable `{ detail: { code } }` is the provider speaking; everything else is
 *   classified by what can honestly be concluded from it. A 5xx, a timeout, a network
 *   error and a body that will not parse are UNKNOWN on a create — the provider may have
 *   made the invoice — and transient on an inquiry.
 * - The webhook's signature header is not read. Its verification is undocumented, so a
 *   webhook is only ever a hint that schedules an inquiry.
 *
 * Never throws for anything the network or the provider does; every path returns an
 * outcome. Refuses to run inside a database transaction.
 */

/** A request that takes longer than this is abandoned and is UNKNOWN for a create. */
export const TONPAYS_TIMEOUT_MS = 15_000;
/** The largest response body read. The documented bodies are a few hundred bytes. */
const MAX_RESPONSE_BYTES = 64 * 1024;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** An amount as the provider sends it: a JSON integer. Anything else is not an amount. */
const providerAmount = z
  .number()
  .int()
  .nonnegative()
  .transform((value) => BigInt(value));
const bounded = (max: number) => z.string().min(1).max(max);

const createResponseSchema = z.object({
  invoice_id: bounded(GATEWAY_PROVIDER_ID_MAX_LENGTH),
  order_id: bounded(GATEWAY_PROVIDER_ID_MAX_LENGTH),
  request_amount: providerAmount.optional(),
  final_amount: providerAmount.optional(),
  status: bounded(GATEWAY_PROVIDER_STATUS_MAX_LENGTH).optional(),
  invoice_url: z.string().max(GATEWAY_PROVIDER_URL_MAX_LENGTH).optional().nullable(),
  web_invoice_url: z.string().max(GATEWAY_PROVIDER_URL_MAX_LENGTH).optional().nullable(),
});

const inquiryResponseSchema = z.object({
  invoice_id: bounded(GATEWAY_PROVIDER_ID_MAX_LENGTH),
  order_id: bounded(GATEWAY_PROVIDER_ID_MAX_LENGTH),
  request_amount: providerAmount.optional(),
  final_amount: providerAmount.optional(),
  status: bounded(GATEWAY_PROVIDER_STATUS_MAX_LENGTH),
  /*
   * Kept as whatever JSON value it was, and judged by `tonpaysVerdict`, which accepts
   * only the boolean `true`. Parsing it to a boolean here would turn `"true"` or `1` into
   * an approval nobody documented.
   */
  paid: z.unknown().optional(),
});

const errorBodySchema = z.object({
  detail: z.object({ code: z.string().min(1) }),
});

const webhookBodySchema = z.object({
  invoice_id: bounded(GATEWAY_PROVIDER_ID_MAX_LENGTH),
  order_id: bounded(GATEWAY_PROVIDER_ID_MAX_LENGTH),
  status: z.string().max(GATEWAY_PROVIDER_STATUS_MAX_LENGTH).optional(),
  delivery_id: z.string().max(128).optional(),
  credit_amount: providerAmount.optional(),
});

/** A link the customer may be sent: https only, and nothing a customer should not open. */
function safeLink(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function boundedCode(code: string): string {
  return code.replace(/[^A-Za-z0-9_.:-]/gu, '_').slice(0, GATEWAY_ERROR_CODE_MAX_LENGTH);
}

type Raw =
  | { readonly kind: 'BODY'; readonly status: number; readonly body: unknown }
  | { readonly kind: 'UNREADABLE'; readonly status: number }
  | { readonly kind: 'NO_RESPONSE'; readonly reason: 'timeout' | 'network' };

export class TonPaysAdapter implements ExternalGatewayAdapter {
  readonly provider = 'TONPAYS' as const;
  readonly unit = TONPAYS_AMOUNT_UNIT;
  readonly attemptLifetimeMs = TONPAYS_ATTEMPT_LIFETIME_MINUTES * 60_000;
  readonly callBudgetPerMinute = TONPAYS_CALL_BUDGET_PER_MINUTE;
  readonly inquiryBudgetPerMinute = TONPAYS_INQUIRY_BUDGET_PER_MINUTE;

  constructor(
    private readonly options: {
      readonly fetch?: FetchLike;
      readonly timeoutMs?: number;
      readonly random?: (size: number) => Uint8Array;
    } = {},
  ) {}

  providerAmountOf(amount: Money): bigint | null {
    return tomanAmountOf(amount);
  }

  newOrderId(): string {
    const random = this.options.random ?? ((size: number) => randomBytes(size));
    return tonpaysOrderId(random(TONPAYS_ORDER_ID_RANDOM_BYTES));
  }

  async createInvoice(
    apiKey: string,
    request: GatewayCreateRequest,
  ): Promise<GatewayCreateOutcome> {
    /*
     * The documented fields, and only the ones Nexa has: `callback_url` and
     * `buyer_chat_id` are OMITTED rather than sent empty when unknown (brief §10) — an
     * empty value is a value the provider may reject.
     */
    const body: Record<string, unknown> = {
      // A JSON integer. The amount is bounded far below 2^53 by the payment's own bound
      // divided into Toman; refuse rather than lose precision if it ever is not.
      amount: Number(request.amount),
      order_id: request.orderId,
      ...(request.callbackUrl === null ? {} : { callback_url: request.callbackUrl }),
      ...(request.buyerChatId === null ? {} : { buyer_chat_id: Number(request.buyerChatId) }),
    };
    if (!Number.isSafeInteger(body.amount)) {
      return { kind: 'REFUSED', code: 'nexa.amount_out_of_range', configuration: false };
    }
    if (request.buyerChatId !== null && !Number.isSafeInteger(body.buyer_chat_id)) {
      delete body.buyer_chat_id;
    }

    const raw = await this.call('POST', TONPAYS_CREATE_PATH, apiKey, body);
    if (raw.kind === 'NO_RESPONSE') return { kind: 'UNKNOWN', code: `http.${raw.reason}` };
    if (raw.kind === 'UNREADABLE') {
      return { kind: 'UNKNOWN', code: `http.${String(raw.status)}.unreadable` };
    }
    if (raw.status >= 200 && raw.status < 300) {
      const parsed = createResponseSchema.safeParse(raw.body);
      if (!parsed.success) {
        return { kind: 'UNKNOWN', code: `http.${String(raw.status)}.unexpected_body` };
      }
      /*
       * An answer for a DIFFERENT order id is not an answer to this request. It is not
       * adopted — adopting it would bind somebody else's invoice to this attempt — and it
       * is not a refusal either: the invoice for this order may exist. So UNKNOWN.
       */
      if (parsed.data.order_id !== request.orderId) {
        return { kind: 'UNKNOWN', code: 'nexa.order_id_mismatch' };
      }
      return {
        kind: 'CREATED',
        invoiceId: parsed.data.invoice_id,
        orderId: parsed.data.order_id,
        invoiceUrl: safeLink(parsed.data.invoice_url),
        webInvoiceUrl: safeLink(parsed.data.web_invoice_url),
        status: parsed.data.status ?? null,
        requestAmount: parsed.data.request_amount ?? null,
        finalAmount: parsed.data.final_amount ?? null,
      };
    }
    const code = this.errorCodeOf(raw.body);
    if (code === null) {
      // A 5xx, or a 4xx/429 with no readable code: nothing documented was said.
      return {
        kind: 'UNKNOWN',
        code: `http.${String(raw.status)}`,
      };
    }
    switch (classifyTonPaysError(code)) {
      case 'CONFIGURATION':
        return { kind: 'REFUSED', code: boundedCode(code), configuration: true };
      case 'RATE_LIMITED':
        return { kind: 'RATE_LIMITED', code: boundedCode(code) };
      case 'AMBIGUOUS':
        return { kind: 'AMBIGUOUS', code: boundedCode(code) };
      case 'NOT_FOUND':
      case 'REFUSED':
        /*
         * A readable refusal from a 5xx is still a 5xx: the provider may have failed
         * after doing the work. Only a 4xx refusal is taken at its word.
         */
        if (raw.status >= 500) return { kind: 'UNKNOWN', code: `http.${String(raw.status)}` };
        return { kind: 'REFUSED', code: boundedCode(code), configuration: false };
    }
  }

  async inquire(apiKey: string, invoiceId: string): Promise<GatewayInquiryOutcome> {
    // The documented POST form, so the invoice id travels in the body rather than a path.
    const raw = await this.call('POST', TONPAYS_CHECK_PATH, apiKey, { invoice_id: invoiceId });
    if (raw.kind === 'NO_RESPONSE') return { kind: 'FAILED', code: `http.${raw.reason}` };
    if (raw.kind === 'UNREADABLE') {
      return { kind: 'FAILED', code: `http.${String(raw.status)}.unreadable` };
    }
    if (raw.status >= 200 && raw.status < 300) {
      const parsed = inquiryResponseSchema.safeParse(raw.body);
      if (!parsed.success) {
        return { kind: 'FAILED', code: `http.${String(raw.status)}.unexpected_body` };
      }
      return {
        kind: 'OBSERVED',
        invoiceId: parsed.data.invoice_id,
        orderId: parsed.data.order_id,
        status: parsed.data.status,
        paid: typeof parsed.data.paid === 'boolean' ? parsed.data.paid : null,
        verdict: tonpaysVerdict(parsed.data.status, parsed.data.paid),
        requestAmount: parsed.data.request_amount ?? null,
        finalAmount: parsed.data.final_amount ?? null,
      };
    }
    const code = this.errorCodeOf(raw.body);
    if (code === null) {
      return raw.status === 429
        ? { kind: 'RATE_LIMITED', code: 'http.429' }
        : { kind: 'FAILED', code: `http.${String(raw.status)}` };
    }
    switch (classifyTonPaysError(code)) {
      case 'CONFIGURATION':
        return { kind: 'CONFIGURATION', code: boundedCode(code) };
      case 'RATE_LIMITED':
        return { kind: 'RATE_LIMITED', code: boundedCode(code) };
      case 'NOT_FOUND':
        return { kind: 'NOT_FOUND', code: boundedCode(code) };
      case 'AMBIGUOUS':
      case 'REFUSED':
        return { kind: 'FAILED', code: boundedCode(code) };
    }
  }

  parseWebhook(body: unknown, deliveryIdHeader: string | undefined): GatewayWebhookHint | null {
    const parsed = webhookBodySchema.safeParse(body);
    if (!parsed.success) return null;
    const header =
      typeof deliveryIdHeader === 'string' && deliveryIdHeader.length > 0
        ? deliveryIdHeader.slice(0, 128)
        : null;
    return {
      orderId: parsed.data.order_id,
      invoiceId: parsed.data.invoice_id,
      status: parsed.data.status ?? null,
      deliveryId: header ?? parsed.data.delivery_id ?? null,
      creditAmount: parsed.data.credit_amount ?? null,
    };
  }

  private errorCodeOf(body: unknown): string | null {
    const parsed = errorBodySchema.safeParse(body);
    return parsed.success ? parsed.data.detail.code : null;
  }

  private async call(
    method: 'POST',
    path: string,
    apiKey: string,
    body: Record<string, unknown>,
  ): Promise<Raw> {
    // The provider is dialled only after the caller has committed. A call inside a
    // transaction could not be rolled back, and would hold a connection for its length.
    assertOutsideTransaction('A TonPays call');
    const doFetch: FetchLike = this.options.fetch ?? ((url, init) => fetch(url, init));
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs ?? TONPAYS_TIMEOUT_MS,
    );
    try {
      let response: Response;
      try {
        response = await doFetch(`${TONPAYS_BASE_URL}${path}`, {
          method,
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            [TONPAYS_API_KEY_HEADER]: apiKey,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
          redirect: 'error',
        });
      } catch {
        // Nothing about the error is kept: an undici error can quote the request.
        return { kind: 'NO_RESPONSE', reason: controller.signal.aborted ? 'timeout' : 'network' };
      }
      let text: string;
      try {
        text = await response.text();
      } catch {
        return controller.signal.aborted
          ? { kind: 'NO_RESPONSE', reason: 'timeout' }
          : { kind: 'UNREADABLE', status: response.status };
      }
      if (text.length > MAX_RESPONSE_BYTES) return { kind: 'UNREADABLE', status: response.status };
      try {
        return { kind: 'BODY', status: response.status, body: JSON.parse(text) as unknown };
      } catch {
        return { kind: 'UNREADABLE', status: response.status };
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
