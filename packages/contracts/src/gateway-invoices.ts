import { z } from 'zod';

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
 */
export const GATEWAY_APPROVAL_VERDICTS = ['APPROVED', 'OPEN', 'UNSUCCESSFUL'] as const;
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
 * The gateway side of one payment, for the Web Admin's payment detail.
 *
 * The provider amounts are decimal STRINGS in the provider's own unit and are labelled
 * as provider metadata: they never decide approval and never replace the payment's own
 * amount. The links are omitted — a payment link is a capability, and an operator
 * diagnosing a payment needs the ids and the states, not a way to pay it.
 */
export const gatewayInvoiceViewSchema = z.object({
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
  requestAmount: z.string().nullable(),
  finalAmount: z.string().nullable(),
  creditAmount: z.string().nullable(),
  outcome: z.enum(GATEWAY_INVOICE_OUTCOMES).nullable(),
  lateCompletionObservedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type GatewayInvoiceView = z.infer<typeof gatewayInvoiceViewSchema>;
