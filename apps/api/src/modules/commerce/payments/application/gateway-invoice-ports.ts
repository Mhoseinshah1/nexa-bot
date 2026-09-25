import type {
  CurrencyCode,
  GatewayApprovalVerdict,
  GatewayInvoiceCreationState,
  GatewayInvoiceOutcome,
  Money,
  PaymentGatewayProvider,
  PaymentId,
  TenantContext,
} from '@nexa/contracts';

/**
 * The generic external-gateway contract (WP11A, `docs/tonpays-gateway-audit.md` §5.1).
 *
 * An adapter is the ONLY code that speaks a provider's HTTP. It answers in these
 * provider-neutral outcomes, and everything that decides what an outcome MEANS for an
 * order or a wallet is outside it: `GatewayPaymentService` orchestrates, and
 * `PaymentService` owns the one settlement path. TonPays is the only adapter; the next
 * gateway implements this interface and inherits the rest.
 */

/** What Nexa asks the provider to create. Amounts are in the provider's own unit. */
export interface GatewayCreateRequest {
  readonly orderId: string;
  readonly amount: bigint;
  /** Null: the installation has no public origin registered, so none is sent. */
  readonly callbackUrl: string | null;
  /** Null when this customer's Telegram id is not known; the field is then omitted. */
  readonly buyerChatId: string | null;
}

/**
 * What a create call produced.
 *
 * - `CREATED` — a readable answer with an invoice id. The provider's amounts and status
 *   are carried as metadata.
 * - `REFUSED` — a readable refusal: no invoice exists. `configuration` says whether it
 *   is the merchant's own setup (never the customer's payment).
 * - `RATE_LIMITED` — a readable rate-limit refusal: not processed, may be asked again.
 * - `AMBIGUOUS` — a readable refusal saying an invoice may already exist under this id.
 * - `UNKNOWN` — no readable answer: a timeout, a network error, a 5xx, an unreadable
 *   body. The invoice MAY exist.
 */
export type GatewayCreateOutcome =
  | {
      readonly kind: 'CREATED';
      readonly invoiceId: string;
      readonly orderId: string;
      readonly invoiceUrl: string | null;
      readonly webInvoiceUrl: string | null;
      readonly status: string | null;
      readonly requestAmount: bigint | null;
      readonly finalAmount: bigint | null;
    }
  | { readonly kind: 'REFUSED'; readonly code: string; readonly configuration: boolean }
  | { readonly kind: 'RATE_LIMITED'; readonly code: string }
  | { readonly kind: 'AMBIGUOUS'; readonly code: string }
  | { readonly kind: 'UNKNOWN'; readonly code: string };

/**
 * What an inquiry produced. Only `OBSERVED` carries anything the provider asserted, and
 * only its `verdict` — decided by the adapter's pure mapping — may drive approval.
 */
export type GatewayInquiryOutcome =
  | {
      readonly kind: 'OBSERVED';
      readonly invoiceId: string;
      readonly orderId: string;
      readonly status: string;
      readonly paid: boolean | null;
      readonly verdict: GatewayApprovalVerdict;
      readonly requestAmount: bigint | null;
      readonly finalAmount: bigint | null;
    }
  | { readonly kind: 'NOT_FOUND'; readonly code: string }
  | { readonly kind: 'RATE_LIMITED'; readonly code: string }
  | { readonly kind: 'CONFIGURATION'; readonly code: string }
  | { readonly kind: 'FAILED'; readonly code: string };

/**
 * What a webhook body HINTS. Never evidence: it schedules an inquiry and nothing else.
 */
export interface GatewayWebhookHint {
  readonly orderId: string;
  readonly invoiceId: string;
  readonly status: string | null;
  readonly deliveryId: string | null;
  readonly creditAmount: bigint | null;
}

export interface ExternalGatewayAdapter {
  readonly provider: PaymentGatewayProvider;
  /** The unit the provider's amounts are in. */
  readonly unit: CurrencyCode;
  /**
   * How long an attempt through this provider lives, from the creation of the internal
   * payment, with no grace. A NEXA rule per provider (TonPays: seventy minutes).
   */
  readonly attemptLifetimeMs: number;
  /**
   * The provider's calls per minute this installation allows itself, per tenant, across
   * every replica: all calls, and the part background inquiries may use — the rest is a
   * floor reserved for creates, so a backlog of inquiries never stops a customer getting
   * an invoice.
   */
  readonly callBudgetPerMinute: number;
  readonly inquiryBudgetPerMinute: number;
  /** The payment's amount in the provider's unit, or null when it has no exact value there. */
  providerAmountOf(amount: Money): bigint | null;
  /** A fresh provider order id for one attempt. Never reused, never re-keyed. */
  newOrderId(): string;
  createInvoice(apiKey: string, request: GatewayCreateRequest): Promise<GatewayCreateOutcome>;
  inquire(apiKey: string, invoiceId: string): Promise<GatewayInquiryOutcome>;
  /** Shape-checks a webhook body. Null for anything that is not one. Reads no secret header. */
  parseWebhook(body: unknown, deliveryIdHeader: string | undefined): GatewayWebhookHint | null;
}

// ---------------------------------------------------------------------------------------

/** One `gateway_invoices` row, as the application reads it. Links included; see the view. */
export interface GatewayInvoiceRecord {
  readonly paymentId: PaymentId;
  readonly provider: PaymentGatewayProvider;
  readonly providerOrderId: string;
  readonly providerInvoiceId: string | null;
  readonly hintedInvoiceId: string | null;
  readonly creationState: GatewayInvoiceCreationState;
  readonly creationAttempts: number;
  readonly creationSentAt: Date | null;
  readonly creationRetryAt: Date | null;
  readonly creationErrorCode: string | null;
  readonly createdInvoiceAt: Date | null;
  readonly buyerChatIdSent: boolean;
  readonly callbackUrlSent: boolean;
  readonly invoiceUrl: string | null;
  readonly webInvoiceUrl: string | null;
  readonly providerUnit: CurrencyCode;
  readonly sentAmount: bigint;
  readonly requestAmount: bigint | null;
  readonly finalAmount: bigint | null;
  readonly creditAmount: bigint | null;
  readonly providerStatus: string | null;
  readonly providerPaid: boolean | null;
  readonly lastInquiryAt: Date | null;
  readonly lastInquiryErrorCode: string | null;
  readonly inquiryAttempts: number;
  readonly nextInquiryAt: Date | null;
  readonly postDeadlineInquiries: number;
  readonly webhookStatusHint: string | null;
  readonly lastWebhookAt: Date | null;
  readonly lastWebhookDeliveryId: string | null;
  readonly webhookCount: number;
  readonly outcome: GatewayInvoiceOutcome | null;
  readonly outcomeAt: Date | null;
  readonly lateCompletionObservedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A row claimed by the worker, with the payment facts the worker needs beside it. */
export interface ClaimedGatewayInvoice {
  readonly invoice: GatewayInvoiceRecord;
  readonly customerId: string;
  readonly paymentState: string;
  readonly paymentExpiresAt: Date | null;
}

export interface GatewayInvoiceRepository {
  /** Inserted in the transaction that creates the payment. */
  open(
    scope: TenantContext,
    input: {
      readonly paymentId: PaymentId;
      readonly provider: PaymentGatewayProvider;
      readonly providerOrderId: string;
      readonly providerUnit: CurrencyCode;
      readonly sentAmount: bigint;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<GatewayInvoiceRecord>;

  findByPayment(
    scope: TenantContext,
    paymentId: PaymentId,
    tx?: unknown,
  ): Promise<GatewayInvoiceRecord | null>;

  /** Tenant-scoped: resolved ONLY within the tenant the caller already established. */
  findByProviderOrderId(
    scope: TenantContext,
    provider: PaymentGatewayProvider,
    providerOrderId: string,
    tx?: unknown,
  ): Promise<GatewayInvoiceRecord | null>;

  /**
   * Claims up to `limit` CREATING rows whose payment is still PENDING, taking a lease.
   * `SKIP LOCKED` plus a conditional lease, so two worker replicas never claim one row.
   */
  claimCreating(
    scope: TenantContext,
    now: Date,
    leaseMs: number,
    limit: number,
    tx?: unknown,
  ): Promise<readonly ClaimedGatewayInvoice[]>;

  /** Stamps `creation_sent_at` BEFORE the call, conditional on it being unset. */
  markCreationSent(
    scope: TenantContext,
    paymentId: PaymentId,
    now: Date,
    tx?: unknown,
  ): Promise<boolean>;

  recordCreated(
    scope: TenantContext,
    paymentId: PaymentId,
    created: {
      readonly invoiceId: string;
      readonly invoiceUrl: string | null;
      readonly webInvoiceUrl: string | null;
      readonly status: string | null;
      readonly requestAmount: bigint | null;
      readonly finalAmount: bigint | null;
      readonly buyerChatIdSent: boolean;
      readonly callbackUrlSent: boolean;
      readonly firstInquiryAt: Date;
    },
    now: Date,
    tx: unknown,
  ): Promise<boolean>;

  /** `CREATING → CREATE_FAILED | CREATE_UNKNOWN`, conditional on CREATING. */
  recordCreationEnded(
    scope: TenantContext,
    paymentId: PaymentId,
    to: 'CREATE_FAILED' | 'CREATE_UNKNOWN',
    errorCode: string,
    now: Date,
    tx: unknown,
  ): Promise<boolean>;

  /** A rate-limited create: stays CREATING, send stamp cleared, retried later. */
  deferCreation(
    scope: TenantContext,
    paymentId: PaymentId,
    errorCode: string,
    retryAt: Date,
    now: Date,
    tx?: unknown,
  ): Promise<boolean>;

  /** Claims up to `limit` rows whose next inquiry is due, taking a lease. */
  claimInquiries(
    scope: TenantContext,
    now: Date,
    leaseMs: number,
    limit: number,
    tx?: unknown,
  ): Promise<readonly ClaimedGatewayInvoice[]>;

  /** Records what an inquiry returned and when the next one is due (null: none). */
  recordInquiry(
    scope: TenantContext,
    paymentId: PaymentId,
    result: {
      readonly status: string | null;
      readonly paid: boolean | null;
      readonly requestAmount: bigint | null;
      readonly finalAmount: bigint | null;
      readonly errorCode: string | null;
      readonly adoptInvoiceId: string | null;
      readonly nextInquiryAt: Date | null;
      readonly postDeadline: boolean;
    },
    now: Date,
    tx?: unknown,
  ): Promise<void>;

  /** Records how the attempt ended, once. Conditional on no outcome yet. */
  recordOutcome(
    scope: TenantContext,
    paymentId: PaymentId,
    outcome: GatewayInvoiceOutcome,
    now: Date,
    tx?: unknown,
  ): Promise<boolean>;

  /** Stamps the first late completion, once. */
  markLateCompletion(
    scope: TenantContext,
    paymentId: PaymentId,
    now: Date,
    tx?: unknown,
  ): Promise<boolean>;

  /**
   * A webhook's hint: bookkeeping only, and an inquiry brought forward when one may be.
   * Returns whether the delivery was new (false: a duplicate delivery id).
   */
  recordWebhook(
    scope: TenantContext,
    paymentId: PaymentId,
    hint: {
      readonly status: string | null;
      readonly deliveryId: string | null;
      readonly creditAmount: bigint | null;
      readonly hintedInvoiceId: string | null;
      /** Null: bring nothing forward. */
      readonly inquireAt: Date | null;
    },
    now: Date,
    tx?: unknown,
  ): Promise<boolean>;

  /** Brings the next inquiry forward to `at`, never later than it already is. */
  requestInquiry(
    scope: TenantContext,
    paymentId: PaymentId,
    at: Date,
    tx?: unknown,
  ): Promise<boolean>;

  /**
   * The open attempt for an order or a customer's top-up through this provider:
   * a PENDING payment whose invoice is CREATING or CREATED, inside its deadline.
   */
  findOpenAttempt(
    scope: TenantContext,
    input: {
      readonly provider: PaymentGatewayProvider;
      readonly orderId: string | null;
      readonly customerId: string;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<GatewayInvoiceRecord | null>;
}

/**
 * A route's API key, encrypted at rest. The plaintext exists only inside `read`'s
 * return value, handed to the one caller that sends it as a header.
 */
export interface GatewayCredentialStore {
  /** When the key was last replaced, or null. Never the key. */
  setAt(scope: TenantContext, provider: PaymentGatewayProvider, tx?: unknown): Promise<Date | null>;
  /** The key, decrypted, or null. For the adapter call only; never logged or returned. */
  read(scope: TenantContext, provider: PaymentGatewayProvider): Promise<string | null>;
  /** Replaces the key. Returns the new set-at time. */
  replace(
    scope: TenantContext,
    provider: PaymentGatewayProvider,
    apiKey: string,
    now: Date,
    tx: unknown,
  ): Promise<Date>;
}

/**
 * The tenant's per-minute call budget to one provider, shared by every replica. `take`
 * is one conditional write: granted or not, with nothing decided in a process.
 */
export interface GatewayCallBudget {
  take(
    scope: TenantContext,
    provider: PaymentGatewayProvider,
    limit: number,
    now: Date,
  ): Promise<boolean>;
}

/**
 * The public origin this installation has already proven — its registered Telegram
 * webhook's origin — for the gateway callback URL. Null when none is registered.
 */
export interface PublicOriginReader {
  originFor(scope: TenantContext): Promise<string | null>;
}
