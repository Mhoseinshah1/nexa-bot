import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  GATEWAY_PROVIDER_STATUS_MAX_LENGTH,
  GATEWAY_PROVIDER_URL_MAX_LENGTH,
  NOWPAYMENTS_AMOUNT_UNIT,
  NOWPAYMENTS_API_KEY_HEADER,
  NOWPAYMENTS_ATTEMPT_LIFETIME_MINUTES,
  NOWPAYMENTS_BASE_URL,
  NOWPAYMENTS_CALL_BUDGET_PER_MINUTE,
  NOWPAYMENTS_ESTIMATE_PATH,
  NOWPAYMENTS_INQUIRY_BUDGET_PER_MINUTE,
  NOWPAYMENTS_INVOICE_PATH,
  NOWPAYMENTS_PAYMENT_LIST_PATH,
  NOWPAYMENTS_PAYMENT_PATH,
  NOWPAYMENTS_PRICE_CURRENCY,
  providerUnitsByCentralFx,
  type Money,
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
import {
  NOWPAYMENTS_ORDER_ID_RANDOM_BYTES,
  centsOfPriceAmount,
  nowpaymentsOrderId,
  nowpaymentsStatusRank,
  nowpaymentsVerdict,
  priceAmountOfCents,
  strongestJudgement,
} from '../domain/nowpayments.js';
import { verifyIpnSignature } from './nowpayments-signature.js';
import {
  boundedCode,
  firstIssuePath,
  metadataStatus,
  providerId,
  readBounded,
  transportReason,
  unreadableCode,
  type FetchLike,
  type Raw,
  type UnreadableShape,
} from './tonpays-adapter.js';

/**
 * NOWPayments over HTTP, and the only code in the installation that speaks it
 * (`docs/nowpayments-gateway-audit.md`).
 *
 * The TonPays adapter's rules, for the same reasons:
 *
 * - the base URL is the documented constant — a configurable one would be a place to send
 *   the key somewhere else; the sandbox is never used;
 * - `x-api-key` carries the key and it appears NOWHERE else: not in a URL, an outcome, an
 *   error code or a log line;
 * - `redirect: 'error'`, a timeout, a bounded streaming read, and a transport classifier
 *   that keeps a system code and never an error message;
 * - a 5xx, a timeout, a network error and an unreadable body are UNKNOWN on a create and
 *   transient on a read.
 *
 * Specific to NOWPayments:
 *
 * - `pay_currency` is NEVER sent: the customer chooses the coin on the provider's page.
 * - The price is US dollars from the central USDT quote, in cents, by the contract's
 *   `providerUnitsByCentralFx` over the fixed 100-cents-per-USDT ratio. This adapter
 *   accepts no other policy.
 * - A webhook is verified (HMAC-SHA512 over the key-sorted body) BEFORE anything in it is
 *   read, and even then is only a hint: it names the payment the next inquiry reads.
 * - An inquiry reads ONE payment by its id when a verified webhook named one, else the
 *   invoice's payment list (`OQ-NP-02`: whether the list answers a key without a JWT).
 *
 * Never throws for anything the network or the provider does. Refuses to run inside a
 * database transaction.
 */

export const NOWPAYMENTS_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
/** One page of an invoice's payments; an invoice with more is not a customer paying once. */
const PAYMENT_LIST_LIMIT = 100;

const createResponseSchema = z.object({
  id: providerId,
  order_id: providerId,
  invoice_url: z.unknown().optional(),
  price_amount: z.unknown().optional(),
});

/** One payment record, as the status read and the list both carry it. */
const paymentSchema = z.object({
  payment_id: providerId,
  // The status DECIDES, so it stays strict.
  payment_status: z.string().min(1).max(GATEWAY_PROVIDER_STATUS_MAX_LENGTH),
  invoice_id: providerId,
  order_id: z.union([providerId, z.null()]).optional(),
  price_amount: z.unknown().optional(),
  price_currency: z.unknown().optional(),
});

type NowPaymentsRecord = z.infer<typeof paymentSchema>;

const paymentListSchema = z.object({ data: z.array(z.unknown()) });

const webhookSchema = z.object({
  payment_id: providerId,
  invoice_id: providerId,
  order_id: providerId,
  payment_status: z.unknown().optional(),
  updated_at: z.unknown().optional(),
});

const errorBodySchema = z.object({ code: z.string().min(1) });

/** The fields this adapter sends; the only names a validation answer may put into a code. */
const RESPONSE_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'order_id',
  'invoice_url',
  'price_amount',
  'payment_id',
  'payment_status',
  'invoice_id',
  'price_currency',
  'data',
]);

/** A payment id safe to put in a URL path: digits only, bounded. */
const PAYMENT_ID_TEXT = /^[0-9]{1,20}$/u;

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

function errorCodeOf(body: unknown): string | null {
  const parsed = errorBodySchema.safeParse(body);
  return parsed.success ? boundedCode(parsed.data.code) : null;
}

/** A 401 or 403: the provider refused THIS installation's key, never the customer's payment. */
function refusesKey(status: number): boolean {
  return status === 401 || status === 403;
}

export class NowPaymentsAdapter implements ExternalGatewayAdapter {
  readonly provider = 'NOWPAYMENTS' as const;
  readonly unit = NOWPAYMENTS_AMOUNT_UNIT;
  readonly attemptLifetimeMs = NOWPAYMENTS_ATTEMPT_LIFETIME_MINUTES * 60_000;
  readonly callBudgetPerMinute = NOWPAYMENTS_CALL_BUDGET_PER_MINUTE;
  readonly inquiryBudgetPerMinute = NOWPAYMENTS_INQUIRY_BUDGET_PER_MINUTE;

  constructor(
    private readonly options: {
      readonly fetch?: FetchLike;
      readonly timeoutMs?: number;
      readonly random?: (size: number) => Uint8Array;
    } = {},
  ) {}

  /**
   * The payable in US cents: `ceil(payable × 100 / rate)` over the central USDT quote, by
   * the contract's one formula. Only `CENTRAL_FX` with the fixed ratio is accepted; anything
   * else — the same unit, an operator's rate — has no dollar value here.
   */
  providerAmountOf(amount: Money, conversion: ResolvedConversion): bigint | null {
    if (conversion.policy !== 'CENTRAL_FX') return null;
    if (conversion.quote.baseAsset !== 'USDT') return null;
    if (conversion.quote.quoteCurrency !== amount.currency) return null;
    const cents = providerUnitsByCentralFx(
      amount.amountMinor,
      conversion.quote.rate,
      conversion.unitRatio,
    );
    if (cents === null || priceAmountOfCents(cents) === null) return null;
    return cents;
  }

  newOrderId(): string {
    const random = this.options.random ?? ((size: number) => randomBytes(size));
    return nowpaymentsOrderId(random(NOWPAYMENTS_ORDER_ID_RANDOM_BYTES));
  }

  async createInvoice(
    apiKey: string,
    request: GatewayCreateRequest,
  ): Promise<GatewayCreateOutcome> {
    const priceAmount = priceAmountOfCents(request.amount);
    if (priceAmount === null) {
      return { kind: 'REFUSED', code: 'nexa.amount_out_of_range', configuration: false };
    }
    /*
     * The documented fields Nexa has, and NO `pay_currency`: the customer picks the coin on
     * the provider's page (owner, §16). No description — nothing about the customer or the
     * order leaves this installation but the order id Nexa generated.
     */
    const body: Record<string, unknown> = {
      price_amount: priceAmount,
      price_currency: NOWPAYMENTS_PRICE_CURRENCY,
      order_id: request.orderId,
      ...(request.callbackUrl === null ? {} : { ipn_callback_url: request.callbackUrl }),
    };
    const raw = await this.call('POST', NOWPAYMENTS_INVOICE_PATH, apiKey, body);
    if (raw.kind === 'NO_RESPONSE') return { kind: 'UNKNOWN', code: `http.${raw.reason}` };
    if (raw.kind === 'UNREADABLE')
      return { kind: 'UNKNOWN', code: boundedCode(unreadableCode(raw)) };
    if (raw.status >= 200 && raw.status < 300) {
      const parsed = createResponseSchema.safeParse(raw.body);
      if (!parsed.success) {
        return {
          kind: 'UNKNOWN',
          code: boundedCode(
            `http.${String(raw.status)}.unexpected_body:${firstIssuePath(parsed.error, RESPONSE_FIELDS)}`,
          ),
        };
      }
      // An answer for another order id is not an answer to this request (TonPays' rule).
      if (parsed.data.order_id !== request.orderId) {
        return { kind: 'UNKNOWN', code: 'nexa.order_id_mismatch' };
      }
      const invoiceUrl = safeLink(parsed.data.invoice_url);
      return {
        kind: 'CREATED',
        invoiceId: parsed.data.id,
        orderId: parsed.data.order_id,
        invoiceUrl,
        webInvoiceUrl: null,
        // FIX-04: a link was sent and refused as unsafe — the fact, never the value.
        ...(parsed.data.invoice_url != null && invoiceUrl === null ? { linkRejected: true } : {}),
        status: null,
        // Metadata only: the price the provider echoed, in cents, when it reads exactly.
        requestAmount: centsOfPriceAmount(parsed.data.price_amount),
        finalAmount: null,
      };
    }
    /*
     * A 5xx is UNKNOWN before any code is read: the provider may have failed after creating
     * the invoice. A 429 is the provider's own refusal to process — retried with the SAME
     * order id, bounded. A 401/403 refuses the key. Any other 4xx is taken at its word only
     * with a readable code; without one it says nothing documented, and is UNKNOWN.
     */
    if (raw.status >= 500) return { kind: 'UNKNOWN', code: `http.${String(raw.status)}` };
    if (raw.status === 429) return { kind: 'RATE_LIMITED', code: 'http.429' };
    const code = errorCodeOf(raw.body);
    // FIX-04 (Codex P2 on #251): a readable refusal's code is the provider's word and its
    // status is metadata the operations log needs — `INVALID_API_KEY` on a 401 is told
    // apart from one on a 403 only by it. Nothing decides on it.
    if (refusesKey(raw.status)) {
      return {
        kind: 'REFUSED',
        code: code ?? `http.${String(raw.status)}`,
        configuration: true,
        httpStatus: raw.status,
      };
    }
    if (code === null) return { kind: 'UNKNOWN', code: `http.${String(raw.status)}` };
    return { kind: 'REFUSED', code, configuration: false, httpStatus: raw.status };
  }

  async inquire(
    apiKey: string,
    invoiceId: string,
    context?: GatewayInquiryContext,
  ): Promise<GatewayInquiryOutcome> {
    if (context === undefined) return { kind: 'FAILED', code: 'nexa.no_inquiry_context' };
    /*
     * Codex review of #141 (P1): the hinted payment is ONE payment under an invoice that can
     * carry several. Its read is decisive only when it is decisive — `finished` for exactly
     * the invoiced price (APPROVED) or a MISMATCH. Otherwise the invoice-wide list is read
     * too and the strongest of everything seen is reported, so an expired hinted payment can
     * never hide a second, successful one whose IPN was lost. A hinted record about another
     * invoice is not this attempt's and is ignored rather than reported.
     */
    const hinted = context.hintedPaymentId;
    let hintedRecord: NowPaymentsRecord | null = null;
    let hintedFailure: GatewayInquiryOutcome | null = null;
    if (hinted !== null && PAYMENT_ID_TEXT.test(hinted)) {
      const read = await this.readPayment(apiKey, hinted);
      if (read.kind === 'RECORD') {
        if (read.payment.invoice_id === invoiceId && this.isOurs(read.payment, context)) {
          hintedRecord = read.payment;
          const judged = this.judge(read.payment, context);
          if (judged.verdict === 'APPROVED' || judged.verdict === 'MISMATCH') {
            return this.observed(read.payment, invoiceId, context);
          }
        }
      } else {
        hintedFailure = read.outcome;
      }
    }
    const listed = await this.listInvoicePayments(apiKey, invoiceId, context);
    if (listed.kind === 'RECORDS' && (listed.payments.length > 0 || hintedRecord === null)) {
      const candidates = [
        ...listed.payments,
        ...(hintedRecord !== null &&
        !listed.payments.some((one) => one.payment_id === hintedRecord?.payment_id)
          ? [hintedRecord]
          : []),
      ];
      const best = strongestJudgement(
        candidates.map((payment) => ({ payment, ...this.judge(payment, context) })),
      );
      if (best === null) return { kind: 'NOT_FOUND', code: 'nowpayments.no_payment_yet' };
      return this.observed(best.payment, invoiceId, context);
    }
    // The list said nothing usable: what the hinted read saw is still an answer.
    if (hintedRecord !== null) return this.observed(hintedRecord, invoiceId, context);
    if (hintedFailure !== null && listed.kind === 'FAILURE') {
      // A refused LIST (OQ-NP-02) says less than the payment read's own answer.
      return listed.outcome.kind === 'FAILED' && hintedFailure.kind !== 'FAILED'
        ? hintedFailure
        : listed.outcome;
    }
    return listed.kind === 'FAILURE'
      ? listed.outcome
      : { kind: 'NOT_FOUND', code: 'nowpayments.no_payment_yet' };
  }

  private judge(payment: NowPaymentsRecord, context: GatewayInquiryContext) {
    return nowpaymentsVerdict(
      {
        status: payment.payment_status,
        priceAmount: payment.price_amount,
        priceCurrency: payment.price_currency,
      },
      context.sentAmount,
    );
  }

  /** A record that omits its order id is bound by the invoice id; one naming another is not ours. */
  private isOurs(payment: NowPaymentsRecord, context: GatewayInquiryContext): boolean {
    const orderId = payment.order_id ?? null;
    return orderId === null || orderId === context.providerOrderId;
  }

  /**
   * How strongly a status says the customer's money is with the provider, for keeping the
   * hint on the strongest payment (Codex review of #141): a later `waiting` IPN for another
   * payment must never displace a `finished` one before the worker reads it.
   */
  hintRank(status: string | null): number {
    return nowpaymentsStatusRank(status);
  }

  /** `GET /v1/payment/{id}`: the one payment a verified webhook named. */
  private async readPayment(
    apiKey: string,
    paymentId: string,
  ): Promise<
    | { readonly kind: 'RECORD'; readonly payment: NowPaymentsRecord }
    | { readonly kind: 'FAILURE'; readonly outcome: GatewayInquiryOutcome }
  > {
    // Digits only (checked above), so the provider-supplied id cannot shape the path.
    const raw = await this.call('GET', `${NOWPAYMENTS_PAYMENT_PATH}/${paymentId}`, apiKey, null);
    const failure = this.readFailure(raw, false);
    if (failure !== null) return { kind: 'FAILURE', outcome: failure };
    const body = (raw as Extract<Raw, { kind: 'BODY' }>).body;
    const parsed = paymentSchema.safeParse(body);
    if (!parsed.success) {
      return {
        kind: 'FAILURE',
        outcome: {
          kind: 'FAILED',
          code: boundedCode(
            `http.200.unexpected_body:${firstIssuePath(parsed.error, RESPONSE_FIELDS)}`,
          ),
        },
      };
    }
    return { kind: 'RECORD', payment: parsed.data };
  }

  /** `GET /v1/payment/?invoiceId=…`: every payment under the invoice, correlated locally. */
  private async listInvoicePayments(
    apiKey: string,
    invoiceId: string,
    context: GatewayInquiryContext,
  ): Promise<
    | { readonly kind: 'RECORDS'; readonly payments: readonly NowPaymentsRecord[] }
    | { readonly kind: 'FAILURE'; readonly outcome: GatewayInquiryOutcome }
  > {
    const query = new URLSearchParams({
      invoiceId,
      limit: String(PAYMENT_LIST_LIMIT),
      page: '0',
      sortBy: 'created_at',
      orderBy: 'desc',
    });
    const raw = await this.call(
      'GET',
      `${NOWPAYMENTS_PAYMENT_LIST_PATH}?${query.toString()}`,
      apiKey,
      null,
    );
    const failure = this.readFailure(raw, true);
    if (failure !== null) return { kind: 'FAILURE', outcome: failure };
    const listed = paymentListSchema.safeParse((raw as Extract<Raw, { kind: 'BODY' }>).body);
    if (!listed.success) {
      return {
        kind: 'FAILURE',
        outcome: {
          kind: 'FAILED',
          code: boundedCode(
            `http.200.unexpected_body:${firstIssuePath(listed.error, RESPONSE_FIELDS)}`,
          ),
        },
      };
    }
    /*
     * Only records that name THIS invoice and THIS order id count — a provider that ignored
     * the filter must not hand another customer's payment to this attempt.
     */
    const ours = listed.data.data.flatMap((item) => {
      const one = paymentSchema.safeParse(item);
      if (!one.success) return [];
      if (one.data.invoice_id !== invoiceId) return [];
      if (!this.isOurs(one.data, context)) return [];
      return [one.data];
    });
    return { kind: 'RECORDS', payments: ours };
  }

  private observed(
    payment: NowPaymentsRecord,
    invoiceId: string,
    context: GatewayInquiryContext,
  ): GatewayInquiryOutcome {
    const judgement = this.judge(payment, context);
    return {
      kind: 'OBSERVED',
      // The ids the PROVIDER returned; the orchestrator compares them with the attempt's.
      invoiceId: payment.invoice_id,
      // A record that omits its order id is bound by the invoice id alone, which the
      // orchestrator compares; one that names ANOTHER order id is a mismatch.
      orderId: payment.order_id ?? context.providerOrderId,
      status: payment.payment_status,
      paid: judgement.verdict === 'APPROVED',
      verdict: judgement.verdict,
      requestAmount: centsOfPriceAmount(payment.price_amount),
      finalAmount: null,
      providerPaymentId: PAYMENT_ID_TEXT.test(payment.payment_id) ? payment.payment_id : null,
      fundsDetected: judgement.fundsDetected,
    };
  }

  /** What a read's non-answer means, or null for a readable 2xx. */
  private readFailure(raw: Raw, listing: boolean): GatewayInquiryOutcome | null {
    if (raw.kind === 'NO_RESPONSE') return { kind: 'FAILED', code: `http.${raw.reason}` };
    if (raw.kind === 'UNREADABLE')
      return { kind: 'FAILED', code: boundedCode(unreadableCode(raw)) };
    if (raw.status >= 200 && raw.status < 300) return null;
    if (raw.status === 429) return { kind: 'RATE_LIMITED', code: 'http.429' };
    if (raw.status === 404) return { kind: 'NOT_FOUND', code: 'http.404' };
    if (refusesKey(raw.status)) {
      /*
       * The payment LIST may require a JWT the installation never holds (`OQ-NP-02`), so a
       * refusal there is not proof the key is wrong — recorded, never a misconfiguration.
       */
      return listing
        ? { kind: 'FAILED', code: `nowpayments.list_refused.${String(raw.status)}` }
        : { kind: 'CONFIGURATION', code: errorCodeOf(raw.body) ?? `http.${String(raw.status)}` };
    }
    return { kind: 'FAILED', code: errorCodeOf(raw.body) ?? `http.${String(raw.status)}` };
  }

  parseWebhook(body: unknown, _deliveryIdHeader: string | undefined): GatewayWebhookHint | null {
    const parsed = webhookSchema.safeParse(body);
    if (!parsed.success) return null;
    const status = metadataStatus(parsed.data.payment_status);
    const updatedAt =
      typeof parsed.data.updated_at === 'string' || typeof parsed.data.updated_at === 'number'
        ? String(parsed.data.updated_at).slice(0, 40)
        : '';
    return {
      orderId: parsed.data.order_id,
      invoiceId: parsed.data.invoice_id,
      status,
      /*
       * NOWPayments sends no delivery id. A repeat of the same payment's same status at the
       * same update time is the same notification, so that triple deduplicates it.
       */
      deliveryId: `${parsed.data.payment_id}:${status ?? '-'}:${updatedAt}`.slice(0, 128),
      creditAmount: null,
      paymentId: PAYMENT_ID_TEXT.test(parsed.data.payment_id) ? parsed.data.payment_id : null,
    };
  }

  verifyWebhook(secret: string, body: unknown, signature: string | undefined): boolean {
    return verifyIpnSignature(secret, body, signature);
  }

  /**
   * The credential check: `GET /v1/estimate` for ten dollars in BTC — documented, read-only,
   * and requiring the key. A 2xx says the key was accepted; a 401/403 says it was refused.
   */
  async checkCredential(apiKey: string): Promise<GatewayCredentialCheck> {
    const query = new URLSearchParams({ amount: '10', currency_from: 'usd', currency_to: 'btc' });
    const raw = await this.call(
      'GET',
      `${NOWPAYMENTS_ESTIMATE_PATH}?${query.toString()}`,
      apiKey,
      null,
    );
    if (raw.kind === 'NO_RESPONSE') return { kind: 'UNAVAILABLE', code: `http.${raw.reason}` };
    if (raw.kind === 'UNREADABLE') {
      return { kind: 'UNAVAILABLE', code: boundedCode(unreadableCode(raw)) };
    }
    if (raw.status >= 200 && raw.status < 300) return { kind: 'OK' };
    if (refusesKey(raw.status)) {
      return { kind: 'REFUSED', code: errorCodeOf(raw.body) ?? `http.${String(raw.status)}` };
    }
    return { kind: 'UNAVAILABLE', code: errorCodeOf(raw.body) ?? `http.${String(raw.status)}` };
  }

  private async call(
    method: 'GET' | 'POST',
    path: string,
    apiKey: string,
    body: Record<string, unknown> | null,
  ): Promise<Raw> {
    return nowpaymentsRequest(this.options, {
      method,
      url: `${NOWPAYMENTS_BASE_URL}${path}`,
      apiKey,
      body,
    });
  }
}

/**
 * ONE NOWPayments HTTP request: the key in its header and nowhere else, `redirect: 'error'`,
 * the timeout, the bounded streaming read and the transport classifier.
 */
export async function nowpaymentsRequest(
  options: { readonly fetch?: FetchLike; readonly timeoutMs?: number },
  request: {
    readonly method: 'GET' | 'POST';
    readonly url: string;
    readonly apiKey: string;
    readonly body: Record<string, unknown> | null;
  },
): Promise<Raw> {
  assertOutsideTransaction('A NOWPayments call');
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? NOWPAYMENTS_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await doFetch(request.url, {
        method: request.method,
        headers: {
          ...(request.body === null ? {} : { 'content-type': 'application/json' }),
          accept: 'application/json',
          [NOWPAYMENTS_API_KEY_HEADER]: request.apiKey,
        },
        ...(request.body === null ? {} : { body: JSON.stringify(request.body) }),
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
