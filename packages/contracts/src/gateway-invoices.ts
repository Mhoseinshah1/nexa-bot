import { z } from 'zod';
import { CURRENCY_CODES, salesCurrencyCodeSchema } from './money.js';
import { TELEGRAM_STARS_CURRENCY } from './telegram-stars.js';
import {
  GATEWAY_CARD_CHANGE_STATES,
  GATEWAY_RECEIPT_SUBMISSION_STATES,
} from './tonpays-telegram.js';
import {
  FX_USABLE_QUOTE_STATES,
  fxBaseAssetSchema,
  fxSourceSchema,
  gatewayConversionPolicySchema,
} from './fx.js';

/**
 * The central-rate snapshot on one attempt, for the Web Admin's payment detail (package
 * FX). Every figure is a decimal STRING: the rate's mantissa and scale as stored, the
 * unit ratio the same way, the effective sales-currency figure per provider unit as an
 * exact fraction, and a rendered decimal of it for the screen.
 */
export const fxSnapshotViewSchema = z.object({
  quoteId: z.string(),
  source: fxSourceSchema,
  baseAsset: fxBaseAssetSchema,
  quoteCurrency: salesCurrencyCodeSchema,
  rateMantissa: z.string(),
  rateScale: z.number().int(),
  /** The rate as decimal text, quote-currency minor units per base unit. */
  rate: z.string(),
  sourceAt: z.iso.datetime().nullable(),
  fetchedAt: z.iso.datetime(),
  quoteState: z.enum(FX_USABLE_QUOTE_STATES),
  policyVersion: z.number().int(),
  unitRatioMantissa: z.string(),
  unitRatioScale: z.number().int(),
  /** Provider units per base unit, as decimal text. */
  unitRatio: z.string(),
  effectiveRateNumerator: z.string(),
  effectiveRateDenominator: z.string(),
  /** Sales-currency minor units per ONE provider unit, rendered to four places. */
  effectiveRate: z.string(),
});
export type FxSnapshotView = z.infer<typeof fxSnapshotViewSchema>;

/**
 * The units a provider's invoice may be denominated in: every sales currency, and the ones
 * only a provider bills in. `XTR` (Telegram Stars) is here and deliberately NOT in
 * `CURRENCY_CODES`: a Star is never `Money` in Nexa. The payment, its fee, the ledger and
 * every report stay in the sales currency; the Star figure lives on the invoice row only.
 */
export const GATEWAY_PROVIDER_UNITS = [...CURRENCY_CODES, TELEGRAM_STARS_CURRENCY] as const;
export type GatewayProviderUnit = (typeof GATEWAY_PROVIDER_UNITS)[number];

/**
 * The invoice an EXTERNAL gateway holds for one payment attempt (WP11A,
 * `docs/tonpays-gateway-audit.md`).
 *
 * Provider-neutral vocabulary. A payment with method `GATEWAY` is the attempt; its
 * `gateway_invoices` row is the provider's side of it — the provider's own order id and
 * invoice id, the links the customer pays through, and what the provider last said. The
 * split keeps every provider concept off `orders`, `payments` and the ledger: Order is
 * not Payment, Payment is not a wallet entry, and a provider's word is not Nexa's state.
 */

/**
 * Where creating the provider's invoice got to.
 *
 * - `CREATING` — the attempt exists and the worker has not yet had an answer. The
 *   customer is told the invoice is being prepared.
 * - `CREATED` — the provider answered with an invoice id and a link.
 * - `CREATE_FAILED` — the provider REFUSED with a documented code. No invoice exists,
 *   so the payment is FAILED and nothing could ever settle it.
 * - `CREATE_UNKNOWN` — the answer was lost: a timeout, a network error, a 5xx, a body
 *   that would not parse, or a refusal that says an invoice may already exist under this
 *   order id. It is NEVER retried and never re-keyed — the invoice may exist, and a
 *   second one for the same attempt is a customer paying twice. The payment stays
 *   PENDING until its own deadline; nothing about it moves money.
 */
export const GATEWAY_INVOICE_CREATION_STATES = [
  'CREATING',
  'CREATED',
  'CREATE_FAILED',
  'CREATE_UNKNOWN',
] as const;
export type GatewayInvoiceCreationState = (typeof GATEWAY_INVOICE_CREATION_STATES)[number];

/**
 * What the provider's answer MEANT for Nexa, decided by a pure mapping per provider.
 *
 * - `APPROVED` — the one result with a business effect. For TonPays: `completed` AND
 *   `paid === true`, and only when read from the inquiry endpoint.
 * - `OPEN` — nothing decided yet; keep asking until the attempt's deadline.
 * - `UNSUCCESSFUL` — the provider definitively did not approve it.
 * - `MISMATCH` — the provider holds money for this attempt that is NOT what Nexa asked for
 *   (NOWPayments: `partially_paid`, or `finished` for another price or currency). Never
 *   fulfils and never fails on its own: the payment goes to `UNKNOWN` for an operator to
 *   reconcile against the provider's records (`docs/nowpayments-gateway-audit.md` §5.5).
 */
export const GATEWAY_APPROVAL_VERDICTS = ['APPROVED', 'OPEN', 'UNSUCCESSFUL', 'MISMATCH'] as const;
export type GatewayApprovalVerdict = (typeof GATEWAY_APPROVAL_VERDICTS)[number];

/**
 * How an attempt's inquiries ENDED, recorded once on the invoice row for an operator.
 *
 * - `SETTLED` — an approval confirmed the payment and settled the order or credited the
 *   wallet, in this installation's one settlement path.
 * - `ALREADY_SETTLED` — an approval found the payment already CONFIRMED.
 * - `UNSUCCESSFUL` — the provider did not approve; the payment is FAILED.
 * - `LATE_COMPLETION` — the provider approved AFTER the attempt stopped being eligible
 *   (its deadline passed, or it was closed another way). Recorded; nothing moved.
 */
export const GATEWAY_INVOICE_OUTCOMES = [
  'SETTLED',
  'ALREADY_SETTLED',
  'UNSUCCESSFUL',
  'LATE_COMPLETION',
] as const;
export type GatewayInvoiceOutcome = (typeof GATEWAY_INVOICE_OUTCOMES)[number];

/** Bounds on the provider-supplied strings a row stores. Never trusted beyond these. */
export const GATEWAY_PROVIDER_ID_MAX_LENGTH = 64;
export const GATEWAY_PROVIDER_STATUS_MAX_LENGTH = 32;
export const GATEWAY_PROVIDER_URL_MAX_LENGTH = 2048;
export const GATEWAY_ERROR_CODE_MAX_LENGTH = 64;

/**
 * Where an attempt's conversion rate came from (roadmap E5, `docs/payment-fees-fx.md`) — ONE
 * shape for every policy, so an operator reads "which authority priced this, at what, when"
 * the same way for a TonPays, a Stars and a NOWPayments attempt.
 *
 * - `NONE` — `SAME_UNIT`: the provider bills in the sales currency; nothing was converted.
 * - `OPERATOR` — `FIXED_RATE`: the route's operator-set rate, frozen on the attempt.
 * - `MARKET` — `CENTRAL_FX`: the central quote (source, book time, fetch time, state, id),
 *   frozen on the attempt.
 *
 * Every member is the attempt's OWN snapshot (`gateway_invoices`, frozen by
 * `nexa_gateway_invoices_snapshot_guard`), never today's rate: a historical settled rate is
 * kept with its evidence, and a newer quote changes nothing here. `rate` is the effective
 * sales-currency figure per provider unit as decimal text, rendered by the server.
 */
export const GATEWAY_RATE_AUTHORITIES = ['NONE', 'OPERATOR', 'MARKET'] as const;
export type GatewayRateAuthority = (typeof GATEWAY_RATE_AUTHORITIES)[number];

export const gatewayRateProvenanceSchema = z.object({
  authority: z.enum(GATEWAY_RATE_AUTHORITIES),
  policy: gatewayConversionPolicySchema,
  /** Sales-currency minor units per ONE provider unit, as decimal text; null for NONE. */
  rate: z.string().nullable(),
  /** The market source; null unless MARKET. */
  source: fxSourceSchema.nullable(),
  /** The quote's identity and policy version; null unless MARKET. */
  quoteId: z.string().nullable(),
  policyVersion: z.number().int().nullable(),
  /** The provider's own book time, when it gave one; null unless MARKET. */
  quotedAt: z.iso.datetime().nullable(),
  /** When this installation read the quote; null unless MARKET. */
  fetchedAt: z.iso.datetime().nullable(),
  /** FRESH or STALE_ALLOWED at the moment it priced the attempt; null unless MARKET. */
  quoteState: z.enum(FX_USABLE_QUOTE_STATES).nullable(),
  /** When the rate was frozen onto the attempt: the attempt's creation. */
  frozenAt: z.iso.datetime(),
});
export type GatewayRateProvenance = z.infer<typeof gatewayRateProvenanceSchema>;

/** The facts the provenance is read from: the attempt's own snapshot, nothing live. */
export interface GatewayRateProvenanceInput {
  readonly policy: (typeof gatewayConversionPolicySchema)['options'][number];
  /** A FIXED_RATE attempt's frozen rate, sales-currency minor units per provider unit. */
  readonly fixedRateMinor: bigint | null;
  readonly fx: {
    readonly source: (typeof fxSourceSchema)['options'][number];
    readonly quoteId: string;
    readonly policyVersion: number;
    readonly sourceAt: Date | null;
    readonly fetchedAt: Date;
    readonly quoteState: (typeof FX_USABLE_QUOTE_STATES)[number];
    /** The effective figure per provider unit, already rendered by the FX contract. */
    readonly effectiveRateText: string;
  } | null;
  readonly createdAt: Date;
}

/**
 * The ONE provenance reading. Fails closed: a policy whose snapshot is missing reports no
 * rate rather than borrowing another policy's (`gateway_invoices_fx_snapshot_check` makes
 * that row impossible; this is the same rule for a reader).
 */
export function gatewayRateProvenanceOf(input: GatewayRateProvenanceInput): GatewayRateProvenance {
  const frozenAt = input.createdAt.toISOString();
  const none = {
    source: null,
    quoteId: null,
    policyVersion: null,
    quotedAt: null,
    fetchedAt: null,
    quoteState: null,
    frozenAt,
  };
  if (input.policy === 'CENTRAL_FX') {
    if (input.fx === null)
      return { authority: 'MARKET', policy: input.policy, rate: null, ...none };
    return {
      authority: 'MARKET',
      policy: input.policy,
      rate: input.fx.effectiveRateText,
      source: input.fx.source,
      quoteId: input.fx.quoteId,
      policyVersion: input.fx.policyVersion,
      quotedAt: input.fx.sourceAt === null ? null : input.fx.sourceAt.toISOString(),
      fetchedAt: input.fx.fetchedAt.toISOString(),
      quoteState: input.fx.quoteState,
      frozenAt,
    };
  }
  if (input.policy === 'FIXED_RATE') {
    return {
      authority: 'OPERATOR',
      policy: input.policy,
      rate: input.fixedRateMinor === null ? null : input.fixedRateMinor.toString(),
      ...none,
    };
  }
  return { authority: 'NONE', policy: input.policy, rate: null, ...none };
}

/**
 * The gateway side of one payment, for the Web Admin's payment detail.
 *
 * The provider amounts are decimal STRINGS in the provider's own unit and are labelled
 * as provider metadata: they never decide approval and never replace the payment's own
 * amount. The links are omitted — a payment link is a capability, and an operator
 * diagnosing a payment needs the ids and the states, not a way to pay it.
 */
const gatewayInvoiceViewShape = z.object({
  provider: z.string(),
  providerOrderId: z.string(),
  providerInvoiceId: z.string().nullable(),
  creationState: z.enum(GATEWAY_INVOICE_CREATION_STATES),
  creationErrorCode: z.string().nullable(),
  /** The last status the INQUIRY endpoint returned, raw and bounded. */
  providerStatus: z.string().nullable(),
  /** The last `paid` the inquiry returned. Null when never asked or not reported. */
  providerPaid: z.boolean().nullable(),
  lastInquiryAt: z.iso.datetime().nullable(),
  lastInquiryErrorCode: z.string().nullable(),
  /** The last webhook's status, a HINT only. */
  webhookStatusHint: z.string().nullable(),
  lastWebhookAt: z.iso.datetime().nullable(),
  webhookCount: z.number().int(),
  providerUnit: z.string(),
  sentAmount: z.string(),
  /**
   * A `FIXED_RATE` route's rate, snapshotted on this attempt: sales-currency minor units
   * per provider unit. Null for a route that bills in the sales currency.
   */
  conversionRateMinor: z.string().nullable(),
  /**
   * How `sentAmount` was derived from the payable (package FX). ABSENT in a response
   * from the previous release, which had only the fixed rate: the transform below infers
   * it from the legacy rate, so a Stars invoice served by that release during a rolling
   * deploy is never shown as billed in the sales currency (Codex review of #122).
   */
  conversionPolicy: gatewayConversionPolicySchema.optional(),
  /**
   * The central-rate snapshot of a `CENTRAL_FX` attempt: the quote, its provenance, the
   * unit ratio and the effective figure per provider unit, exactly as the attempt was
   * priced. Never recomputed from a newer quote. Null for any other policy.
   */
  fx: fxSnapshotViewSchema.nullable().default(null),
  /**
   * Roadmap E5: where the rate came from, in one shape for every policy
   * (`gatewayRateProvenanceOf`, server-derived from the snapshot). Defaulted on parse so a
   * response from the previous release reads "not said".
   */
  rateProvenance: gatewayRateProvenanceSchema.nullable().default(null),
  /**
   * The provider's charge id: recorded from a pushed payment (Stars), or the `referenceId` a
   * CentralPay verify reported, bound write-once and unique per tenant and provider so one
   * reference can never pay two attempts. Null until then.
   */
  providerChargeId: z.string().nullable(),
  /**
   * The provider's own id for the payment a VERIFIED webhook last named under this invoice
   * (NOWPayments' `payment_id`): what the next inquiry reads. A hint, never evidence.
   * Defaulted so a response from the previous release reads "none".
   */
  hintedPaymentId: z.string().nullable().default(null),
  /**
   * The integer the provider knows this attempt's customer by (CentralPay's `userId`, the
   * customer's stable random number), frozen when the attempt opened; a verify naming any
   * other is never an approval. Null for every other route. Defaulted for older responses.
   */
  providerUserId: z.string().nullable().default(null),
  requestAmount: z.string().nullable(),
  finalAmount: z.string().nullable(),
  creditAmount: z.string().nullable(),
  outcome: z.enum(GATEWAY_INVOICE_OUTCOMES).nullable(),
  lateCompletionObservedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  /*
   * A card-transfer route (`TONPAYS_TELEGRAM`, `docs/tonpays-telegram-gateway-audit.md` §10).
   * The current card's sequence and when it was received — NOT the number: this is an
   * operator's diagnosis view, and a payee card is the provider's. What the provider last
   * said about changing it, the latest card-change request, and every receipt the customer
   * sent to the provider, by state and code only (never a file, a caption or bytes).
   * Defaulted on parse so a response from the previous release reads "none".
   */
  cardSeq: z.number().int().nullable().default(null),
  cardReceivedAt: z.iso.datetime().nullable().default(null),
  cardChangeShown: z.boolean().nullable().default(null),
  cardChangeCooldownUntil: z.iso.datetime().nullable().default(null),
  cardChangeExhausted: z.boolean().nullable().default(null),
  latestCardChange: z
    .object({
      state: z.enum(GATEWAY_CARD_CHANGE_STATES),
      errorCode: z.string().nullable(),
      requestedAt: z.iso.datetime(),
      decidedAt: z.iso.datetime().nullable(),
    })
    .nullable()
    .default(null),
  receiptSubmissions: z
    .array(
      z.object({
        id: z.string(),
        state: z.enum(GATEWAY_RECEIPT_SUBMISSION_STATES),
        errorCode: z.string().nullable(),
        providerStatus: z.string().nullable(),
        receiptReceived: z.boolean().nullable(),
        openedReview: z.boolean(),
        createdAt: z.iso.datetime(),
        decidedAt: z.iso.datetime().nullable(),
      }),
    )
    .default([]),
});
/**
 * The view with its policy always present: what the previous release sent without one is
 * a fixed-rate attempt exactly when it carries a rate, and a same-unit one otherwise —
 * the same inference migration 0150 backfilled into the rows.
 */
export const gatewayInvoiceViewSchema = gatewayInvoiceViewShape.transform((view) => ({
  ...view,
  conversionPolicy:
    view.conversionPolicy ??
    (view.conversionRateMinor === null ? ('SAME_UNIT' as const) : ('FIXED_RATE' as const)),
}));
export type GatewayInvoiceView = z.infer<typeof gatewayInvoiceViewSchema>;
