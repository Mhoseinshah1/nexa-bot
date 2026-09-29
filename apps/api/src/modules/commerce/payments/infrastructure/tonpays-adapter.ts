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

const bounded = (max: number) => z.string().min(1).max(max);

/**
 * A provider identifier: a non-empty bounded string, or a JSON integer, which is normalised
 * to its decimal string. The documentation names the fields and gives no types, and an id
 * the provider chose to send as a number is still the same id — refusing it would turn a
 * created invoice into an UNKNOWN one (F3, round N). Anything else is not an id.
 */
const providerId = z
  .union([bounded(GATEWAY_PROVIDER_ID_MAX_LENGTH), z.number().int().nonnegative()])
  .transform((value) => String(value));

/**
 * The provider's amounts and a create's status are METADATA (CLAUDE.md, TonPays rules):
 * stored for support, never deciding approval or a credited figure. So a value of a shape
 * nobody documented is recorded as absent — it is NEVER a reason to discard the answer it
 * came in. Before round N a `null` or a decimal `final_amount` made the whole create
 * `unexpected_body`, and a created, payable invoice was shown to the customer as a lost one.
 */
function metadataAmount(value: unknown): bigint | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^\d{1,18}$/u.test(value)) return BigInt(value);
  return null;
}

function metadataStatus(value: unknown): string | null {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= GATEWAY_PROVIDER_STATUS_MAX_LENGTH
    ? value
    : null;
}

/*
 * What decides a create is the invoice id and the echo of OUR order id; every other field
 * is read field by field below, so one of them in an undocumented shape costs that field
 * and nothing more.
 */
const createResponseSchema = z.object({
  invoice_id: providerId,
  order_id: providerId,
  request_amount: z.unknown().optional(),
  final_amount: z.unknown().optional(),
  status: z.unknown().optional(),
  invoice_url: z.unknown().optional(),
  web_invoice_url: z.unknown().optional(),
});

const inquiryResponseSchema = z.object({
  invoice_id: providerId,
  order_id: providerId,
  request_amount: z.unknown().optional(),
  final_amount: z.unknown().optional(),
  // The inquiry's status DECIDES (with `paid`), so it stays strict: a string or no answer.
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
  invoice_id: providerId,
  order_id: providerId,
  status: z.unknown().optional(),
  delivery_id: z.unknown().optional(),
  credit_amount: z.unknown().optional(),
});

/**
 * A link the customer may be sent: https only, and nothing a customer should not open. A
 * value that is not a string, or longer than the column holds, is no link — and costs only
 * itself, never the answer it came in.
 */
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

function boundedCode(code: string): string {
  return code.replace(/[^A-Za-z0-9_.:-]/gu, '_').slice(0, GATEWAY_ERROR_CODE_MAX_LENGTH);
}

/**
 * F3 (round N): what an answer that decided nothing LOOKED like, as a machine code an
 * operator can read on the payment and in the operational log — and nothing more. Never a
 * body, a header, a URL or an error message: those can quote the request, and the request
 * carries the key.
 *
 * - `http.<status>.unexpected_body:<field>` — a readable JSON answer missing, or carrying in
 *   an undocumented shape, the one field named (the first zod issue's path);
 * - `http.<status>.unreadable.<html|text|empty|too_large|stream>` — no JSON at all: an HTML
 *   page (a proxy, a firewall or a maintenance page in front of the provider), plain text,
 *   nothing, an answer over the bound, or a stream that broke;
 * - `http.<status>.validation:<field>` — a 4xx whose `detail` is a list of field errors
 *   (the framework's own validation answer) rather than the documented `{ code }`;
 * - `http.timeout`, `http.redirect`, `http.network[.<SYSTEM_CODE>]` — no answer, with the
 *   operating system's own error code (`ENOTFOUND`, `ECONNREFUSED`, a TLS code) when there
 *   is one.
 */
type UnreadableShape = 'html' | 'text' | 'empty' | 'too_large' | 'stream';

type Raw =
  | { readonly kind: 'BODY'; readonly status: number; readonly body: unknown }
  | { readonly kind: 'UNREADABLE'; readonly status: number; readonly shape: UnreadableShape }
  | { readonly kind: 'NO_RESPONSE'; readonly reason: string };

/** Why a request got no answer, from the error alone and never from its message text. */
function transportReason(error: unknown, aborted: boolean): string {
  if (aborted) return 'timeout';
  const cause = (error as { cause?: unknown } | null)?.cause;
  // `redirect: 'error'` refuses a 30x this way; compared, never stored.
  if (cause instanceof Error && cause.message === 'unexpected redirect') return 'redirect';
  const code =
    (cause as { code?: unknown } | null | undefined)?.code ??
    (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,40}$/u.test(code)
    ? `network.${code}`
    : 'network';
}

/** The first field a zod parse refused, as a bounded machine path. */
function firstIssuePath(error: z.ZodError): string {
  const path = error.issues[0]?.path ?? [];
  return path.length === 0 ? 'root' : path.map(String).join('.');
}

/**
 * The field a framework validation answer (`{ detail: [{ loc: [..., field], ... }] }`) names,
 * or null when the body is not one. The provider's MESSAGE is never read.
 */
function validationFieldOf(body: unknown): string | null {
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (!Array.isArray(detail) || detail.length === 0) return null;
  const loc = (detail[0] as { loc?: unknown } | null)?.loc;
  if (!Array.isArray(loc) || loc.length === 0) return 'unknown';
  const last: unknown = loc[loc.length - 1];
  return typeof last === 'string' || typeof last === 'number' ? String(last) : 'unknown';
}

function unreadableCode(raw: { readonly status: number; readonly shape: UnreadableShape }): string {
  return `http.${String(raw.status)}.unreadable.${raw.shape}`;
}

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
      return { kind: 'UNKNOWN', code: boundedCode(unreadableCode(raw)) };
    }
    if (raw.status >= 200 && raw.status < 300) {
      const parsed = createResponseSchema.safeParse(raw.body);
      if (!parsed.success) {
        return {
          kind: 'UNKNOWN',
          code: boundedCode(
            `http.${String(raw.status)}.unexpected_body:${firstIssuePath(parsed.error)}`,
          ),
        };
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
        status: metadataStatus(parsed.data.status),
        requestAmount: metadataAmount(parsed.data.request_amount),
        finalAmount: metadataAmount(parsed.data.final_amount),
      };
    }
    /*
     * A 5xx is UNKNOWN whatever its body says, and is decided BEFORE any code is read:
     * the provider may have failed after doing the work. A readable RATE_LIMIT_EXCEEDED
     * or configuration code in a 500 would otherwise clear the send stamp and send the
     * create again — a second payable invoice for an order that may already have one.
     * Only a 4xx is taken at its word.
     */
    if (raw.status >= 500) return { kind: 'UNKNOWN', code: `http.${String(raw.status)}` };
    const code = this.errorCodeOf(raw.body);
    if (code === null) {
      /*
       * A 4xx/429 with no readable code: nothing documented was said, so UNKNOWN — but the
       * field a framework validation answer names is kept, because it is the one thing that
       * tells an operator which part of the request the provider would not take.
       */
      const field = validationFieldOf(raw.body);
      return {
        kind: 'UNKNOWN',
        code: boundedCode(
          field === null
            ? `http.${String(raw.status)}`
            : `http.${String(raw.status)}.validation:${field}`,
        ),
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
        return { kind: 'REFUSED', code: boundedCode(code), configuration: false };
    }
  }

  async inquire(apiKey: string, invoiceId: string): Promise<GatewayInquiryOutcome> {
    // The documented POST form, so the invoice id travels in the body rather than a path.
    const raw = await this.call('POST', TONPAYS_CHECK_PATH, apiKey, { invoice_id: invoiceId });
    if (raw.kind === 'NO_RESPONSE') return { kind: 'FAILED', code: `http.${raw.reason}` };
    if (raw.kind === 'UNREADABLE') {
      return { kind: 'FAILED', code: boundedCode(unreadableCode(raw)) };
    }
    if (raw.status >= 200 && raw.status < 300) {
      const parsed = inquiryResponseSchema.safeParse(raw.body);
      if (!parsed.success) {
        return {
          kind: 'FAILED',
          code: boundedCode(
            `http.${String(raw.status)}.unexpected_body:${firstIssuePath(parsed.error)}`,
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
    const bodyDelivery = parsed.data.delivery_id;
    const deliveryFromBody =
      (typeof bodyDelivery === 'string' && bodyDelivery.length > 0) ||
      (typeof bodyDelivery === 'number' && Number.isSafeInteger(bodyDelivery))
        ? String(bodyDelivery).slice(0, 128)
        : null;
    return {
      orderId: parsed.data.order_id,
      invoiceId: parsed.data.invoice_id,
      status: metadataStatus(parsed.data.status),
      deliveryId: header ?? deliveryFromBody,
      creditAmount: metadataAmount(parsed.data.credit_amount),
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
      } catch (error: unknown) {
        /*
         * Nothing about the error is kept but its system code: an undici error's MESSAGE can
         * quote the request, while `ENOTFOUND` or a TLS code cannot, and is exactly what an
         * operator needs to tell a DNS, firewall or certificate problem from a slow provider.
         */
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
}

/**
 * The body as text, or null once it is longer than `limit` BYTES. The bound is enforced
 * while the stream is read, never after: `response.text()` would buffer the whole body
 * first, so an oversized or endless answer would cost the worker its heap before the
 * limit was ever consulted. A declared length over the limit is refused unread.
 */
async function readBounded(response: Response, limit: number): Promise<string | null> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
