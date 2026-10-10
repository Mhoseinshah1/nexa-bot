import type {
  FxBaseAsset,
  FxRate,
  FxSource,
  FxUnitRatio,
  GatewayApprovalVerdict,
  GatewayCardChangeState,
  GatewayCardSource,
  GatewayConversionPolicy,
  GatewayReceiptCaptureCloseReason,
  GatewayReceiptSubmissionState,
  GatewayInvoiceCreationState,
  GatewayInvoiceOutcome,
  GatewayProviderUnit,
  Money,
  PaymentGatewayProvider,
  PaymentId,
  ResolvedConversion,
  SalesCurrencyCode,
  TenantContext,
  TonPaysTelegramReceiptMimeType,
} from '@nexa/contracts';

/**
 * What a `CENTRAL_FX` attempt snapshots (package FX, `docs/fx-audit.md` §3.5): the quote
 * exactly as it was read and its state at the moment it priced the attempt, the unit
 * ratio the route was configured with, and the effective sales-currency figure per
 * provider unit as an exact fraction. Enough to explain the provider amount later
 * without consulting any rate that came afterwards.
 */
export interface GatewayInvoiceFxSnapshot {
  readonly quoteId: string;
  readonly source: FxSource;
  readonly baseAsset: FxBaseAsset;
  readonly quoteCurrency: SalesCurrencyCode;
  readonly rate: FxRate;
  readonly sourceAt: Date | null;
  readonly fetchedAt: Date;
  readonly quoteState: 'FRESH' | 'STALE_ALLOWED';
  readonly policyVersion: number;
  readonly unitRatio: FxUnitRatio;
  readonly effectiveRate: { readonly numerator: bigint; readonly denominator: bigint };
}

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
  /**
   * The integer the provider knows the customer by, for a `numericIdentity` route
   * (CentralPay's `userId`): the number frozen on the attempt. Null for every other route.
   */
  readonly providerUserId?: string | null;
  /**
   * The invoice's own customer-facing text, rendered from templates by the caller, for a
   * provider whose invoice is a message this installation sends (Telegram Stars). Null
   * for a provider that draws its own page.
   */
  readonly presentation: GatewayInvoicePresentation | null;
}

/** The title, description and price label of an invoice this installation sends itself. */
export interface GatewayInvoicePresentation {
  readonly title: string;
  readonly description: string;
  readonly priceLabel: string;
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
      /**
       * A card-transfer provider's payee card (`TONPAYS_TELEGRAM`, audit §5.2): what the
       * customer transfers to. Absent or null for every other adapter, and for a card answer
       * that carried no card — a created invoice that cannot be paid from Telegram.
       */
      readonly instructions?: GatewayCardInstructions | null;
      /** What the provider said about changing that card, when it said anything. */
      readonly cardChange?: GatewayCardChangePolicy | null;
      /**
       * FIX-04: the provider DID return a link and it was refused as unsafe (not an https
       * URL), which is why both links are null. Absent or false: no link was returned. Only
       * the fact — the refused value itself is never carried.
       */
      readonly linkRejected?: boolean;
    }
  /*
   * FIX-04: `httpStatus` is the status the provider answered with, when the adapter knows
   * it and its code does not already carry it (`http.<status>…`). Metadata for the
   * operations log; nothing decides on it.
   */
  | {
      readonly kind: 'REFUSED';
      readonly code: string;
      readonly configuration: boolean;
      readonly httpStatus?: number;
    }
  | { readonly kind: 'RATE_LIMITED'; readonly code: string; readonly httpStatus?: number }
  | { readonly kind: 'AMBIGUOUS'; readonly code: string; readonly httpStatus?: number }
  | { readonly kind: 'UNKNOWN'; readonly code: string; readonly httpStatus?: number };

/** A payee card, exactly as the provider sent it (format undocumented, `OQ-TPTG-06`). */
export interface GatewayCardInstructions {
  readonly cardNumber: string;
  readonly cardName: string | null;
}

/** The provider's own word on changing the card. Null fields: it did not say. */
export interface GatewayCardChangePolicy {
  readonly showChangeCard: boolean | null;
  readonly cooldownSeconds: number | null;
  readonly exhausted: boolean | null;
}

/**
 * A card change (audit §5.2). The five-way vocabulary the create uses: a new card, a
 * readable refusal, the provider's own rate limit, an invoice it does not know, or no
 * readable answer — after which the current card is no longer shown.
 */
export type GatewayCardChangeOutcome =
  | {
      readonly kind: 'CHANGED';
      readonly instructions: GatewayCardInstructions;
      readonly policy: GatewayCardChangePolicy;
    }
  | { readonly kind: 'REFUSED'; readonly code: string; readonly configuration: boolean }
  | { readonly kind: 'RATE_LIMITED'; readonly code: string }
  | { readonly kind: 'NOT_FOUND'; readonly code: string }
  | { readonly kind: 'UNKNOWN'; readonly code: string };

/**
 * A receipt upload (audit §5.2). `ACCEPTED` carries what the answer said as METADATA:
 * `status` bounded, `paid` and `receiptReceived` as the raw JSON values, judged only by
 * `receiptAcknowledged` (which accepts the boolean `true` and the exact string
 * `processing`). Nothing here ever reaches settlement.
 */
export type GatewayReceiptOutcome =
  | {
      readonly kind: 'ACCEPTED';
      readonly status: string | null;
      readonly paid: unknown;
      readonly receiptReceived: unknown;
    }
  | {
      readonly kind: 'REFUSED';
      readonly code: string;
      readonly configuration: boolean;
      /** The provider refused the IMAGE (type, size): the customer may send another. */
      readonly receiptRefused: boolean;
    }
  | { readonly kind: 'RATE_LIMITED'; readonly code: string }
  | { readonly kind: 'NOT_FOUND'; readonly code: string }
  | { readonly kind: 'UNKNOWN'; readonly code: string };

/** The receipt image, held only for the length of one upload and never logged. */
export interface GatewayReceiptFile {
  readonly bytes: Uint8Array;
  readonly mimeType: TonPaysTelegramReceiptMimeType;
  readonly fileName: string;
}

/**
 * The capability a card-transfer provider adds (audit §5.2), resolved by DESCRIPTOR
 * (`invoiceForm === 'CARD_TRANSFER'`), never by `instanceof`. Both calls are invoice-scoped
 * and made by the gateway worker only — never while Telegram waits.
 */
export interface CardTransferGatewayAdapter extends ExternalGatewayAdapter {
  /** The largest receipt the provider documents, in bytes. */
  readonly receiptMaxBytes: number;
  changeCard(apiKey: string, invoiceId: string): Promise<GatewayCardChangeOutcome>;
  uploadReceipt(
    apiKey: string,
    invoiceId: string,
    file: GatewayReceiptFile,
  ): Promise<GatewayReceiptOutcome>;
}

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
      /**
       * The provider's own id for the payment this answer describes, when an invoice can
       * carry several (NOWPayments' `payment_id`). Recorded as the hint the next inquiry
       * reads. Absent for a provider whose invoice IS the payment.
       */
      readonly providerPaymentId?: string | null;
      /**
       * Whether the provider reports the customer's money as already on its way (coins seen
       * on chain) — the trigger, on a route whose descriptor says `providerReview`, that opens
       * the bounded review window. Never an approval.
       */
      readonly fundsDetected?: boolean;
      /**
       * The provider's own reference for the money it says arrived (CentralPay's
       * `referenceId`): bound write-once to this attempt before anything settles, and refused
       * when another payment already holds it. Absent for every other provider.
       */
      readonly providerReference?: string | null;
      /** Why a MISMATCH is one (a machine reason for the audit row and the condition). */
      readonly mismatchReason?: string | null;
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
  /** The provider's payment id under the invoice, when it names one (NOWPayments). */
  readonly paymentId?: string | null;
}

/**
 * What the orchestrator tells an adapter about the attempt it asks after, beside the
 * invoice id: OUR order id, the amount Nexa sent in the provider's unit (so a pure mapping
 * can refuse an approval for another figure), and the payment id a verified webhook last
 * named, for a provider whose invoice may carry several payments.
 */
export interface GatewayInquiryContext {
  readonly providerOrderId: string;
  readonly sentAmount: bigint;
  readonly hintedPaymentId: string | null;
  /** The customer's integer as sent, for a `numericIdentity` route; null otherwise. */
  readonly providerUserId?: string | null;
}

/**
 * The operator's credential check (`docs/nowpayments-gateway-audit.md` §5.7): one read-only
 * call with the stored key. `OK` — the provider answered it; `REFUSED` — it refused the key
 * (a configuration code); `UNAVAILABLE` — no readable answer. A machine code only.
 */
export type GatewayCredentialCheck =
  | { readonly kind: 'OK' }
  | { readonly kind: 'REFUSED'; readonly code: string }
  | { readonly kind: 'UNAVAILABLE'; readonly code: string };

export interface ExternalGatewayAdapter {
  readonly provider: PaymentGatewayProvider;
  /** The unit the provider's amounts are in: a sales currency, or `XTR` for Stars. */
  readonly unit: GatewayProviderUnit;
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
  /**
   * The payment's amount in the provider's unit, or null when it has no exact value there
   * — or when the conversion handed in is not one this provider's unit can be priced by.
   *
   * `conversion` is what the payment core resolved for the attempt from the route's
   * descriptor (package FX): the same unit, an operator's fixed rate, or the central
   * quote with a unit ratio. The adapter is the authority on its UNIT; the arithmetic for
   * each policy is the contract's, so no adapter derives a rate of its own.
   */
  providerAmountOf(amount: Money, conversion: ResolvedConversion): bigint | null;
  /** A fresh provider order id for one attempt. Never reused, never re-keyed. */
  newOrderId(): string;
  /**
   * A fresh candidate for a customer's stable provider number, for a route whose descriptor
   * says `numericIdentity` (CentralPay's `userId`). Drawn once per customer and stored.
   */
  newCustomerNumber?(): string;
  /**
   * `credential` is what the route's descriptor says an invoice is sent with: the stored
   * gateway key (`GATEWAY_KEY`), or the token of the attempt's bot (`BOT_TOKEN`).
   */
  createInvoice(credential: string, request: GatewayCreateRequest): Promise<GatewayCreateOutcome>;
  inquire(
    apiKey: string,
    invoiceId: string,
    context?: GatewayInquiryContext,
  ): Promise<GatewayInquiryOutcome>;
  /** Shape-checks a webhook body. Null for anything that is not one. Reads no secret header. */
  parseWebhook(body: unknown, deliveryIdHeader: string | undefined): GatewayWebhookHint | null;
  /**
   * For a route whose descriptor says `webhookSecret`: whether `signature` is the stored
   * secret's signature of `body`, compared in constant time. Called BEFORE `parseWebhook`,
   * so nothing in an unverified body is ever read. Absent for every other adapter.
   */
  verifyWebhook?(secret: string, body: unknown, signature: string | undefined): boolean;
  /**
   * For a provider whose invoice can carry several payments (NOWPayments): how strongly a
   * webhook status says the money is with the provider. A verified webhook moves the hint to
   * its payment only when it is at least as strong as what the hinted payment last showed,
   * so a later weaker notification never displaces a stronger one. Absent: always moves.
   */
  hintRank?(status: string | null): number;
  /** The operator's read-only credential check, for a provider that offers a safe read. */
  checkCredential?(apiKey: string): Promise<GatewayCredentialCheck>;
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
  readonly providerUnit: GatewayProviderUnit;
  readonly sentAmount: bigint;
  /**
   * The rate `sentAmount` was computed at, for a `FIXED_RATE` provider (Package A): sales-
   * currency minor units per provider unit. Frozen with the row. Null for `SAME_UNIT`.
   */
  readonly conversionRateMinor: bigint | null;
  /** How `sentAmount` was derived from the payable (package FX). Frozen with the row. */
  readonly conversionPolicy: GatewayConversionPolicy;
  /** The central-rate snapshot of a `CENTRAL_FX` attempt, frozen with the row. Null otherwise. */
  readonly fx: GatewayInvoiceFxSnapshot | null;
  /** The bot whose token sends the invoice and whose webhook may pay it. Stars only. */
  readonly botInstanceId: string | null;
  /**
   * The provider's own id for the charge that paid this attempt (Stars:
   * `telegram_payment_charge_id`). Written once, unique per tenant and provider.
   */
  readonly providerChargeId: string | null;
  readonly requestAmount: bigint | null;
  readonly finalAmount: bigint | null;
  readonly creditAmount: bigint | null;
  readonly providerStatus: string | null;
  readonly providerPaid: boolean | null;
  readonly lastInquiryAt: Date | null;
  readonly lastInquiryErrorCode: string | null;
  /**
   * FIX10 (audit P1-b on #268): how many claims of this row in a row ended in a thrown
   * exception (`backOffClaim`), as read when it was claimed. Zero once it processes cleanly.
   */
  readonly rowFailures: number;
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
  /**
   * A card-transfer route's CURRENT card (`TONPAYS_TELEGRAM`): null before the create, and
   * after a card change whose answer was lost. Never logged and never in an audit `after`.
   */
  readonly cardNumber: string | null;
  readonly cardName: string | null;
  readonly cardSeq: number | null;
  readonly cardReceivedAt: Date | null;
  /** What the provider last said about changing the card. Null: it did not say. */
  readonly cardChangeShown: boolean | null;
  readonly cardChangeCooldownUntil: Date | null;
  readonly cardChangeExhausted: boolean | null;
  /** An operator asked the provider again on an UNKNOWN payment; cleared by that inquiry. */
  readonly reconcileInquiryRequestedAt: Date | null;
  /** The provider payment id a verified webhook (or a listing inquiry) last named. A hint. */
  readonly hintedPaymentId: string | null;
  /** The customer's integer as sent (CentralPay's `userId`), frozen at open. Null otherwise. */
  readonly providerUserId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A row claimed by the worker, with the payment facts the worker needs beside it. */
export interface ClaimedGatewayInvoice {
  readonly invoice: GatewayInvoiceRecord;
  readonly customerId: string;
  readonly paymentState: string;
  readonly paymentExpiresAt: Date | null;
  /** The provider review deadline, read beside `expires_at` (§9.6.3 d). */
  readonly paymentReviewUntil: Date | null;
}

export interface GatewayInvoiceRepository {
  /** Inserted in the transaction that creates the payment. */
  open(
    scope: TenantContext,
    input: {
      readonly paymentId: PaymentId;
      readonly provider: PaymentGatewayProvider;
      readonly providerOrderId: string;
      readonly providerUnit: GatewayProviderUnit;
      readonly sentAmount: bigint;
      readonly conversionRateMinor: bigint | null;
      readonly conversionPolicy: GatewayConversionPolicy;
      readonly fx: GatewayInvoiceFxSnapshot | null;
      readonly botInstanceId: string | null;
      /** A `numericIdentity` route's customer number as sent; null for every other route. */
      readonly providerUserId?: string | null;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<GatewayInvoiceRecord>;

  /**
   * Whether a provider order id is already used by ANY attempt of `provider`, across every
   * tenant (CentralPay: tenants sharing one merchant account share its order namespace). An
   * existence check only; nothing about the other attempt is returned.
   */
  providerOrderIdTaken(
    provider: PaymentGatewayProvider,
    providerOrderId: string,
    tx: unknown,
  ): Promise<boolean>;

  /**
   * The customer's stable provider number (`gateway_customer_numbers`), drawing one with
   * `draw` the first time — retried on a collision with another customer's, bounded. Null
   * only when every draw collided.
   */
  customerNumberFor(
    scope: TenantContext,
    provider: PaymentGatewayProvider,
    customerId: string,
    draw: () => string,
    now: Date,
    tx: unknown,
  ): Promise<string | null>;

  /**
   * Binds the provider's reference for the money (CentralPay's `referenceId`) to this attempt,
   * write-once, as its charge id. `BOUND` — written now, or already this attempt's; `TAKEN`
   * — another attempt of the tenant holds it; `DIFFERENT` — this attempt already holds
   * another reference. Nothing is written unless `BOUND`.
   */
  bindProviderReference(
    scope: TenantContext,
    paymentId: PaymentId,
    provider: PaymentGatewayProvider,
    reference: string,
    now: Date,
    tx: unknown,
  ): Promise<'BOUND' | 'TAKEN' | 'DIFFERENT'>;

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
   * The attempt a provider's payload names, row-locked (`FOR UPDATE`), within the tenant
   * the caller established. For recording a pushed payment (Stars) under the row's lock.
   */
  lockByProviderOrderId(
    scope: TenantContext,
    provider: PaymentGatewayProvider,
    providerOrderId: string,
    tx: unknown,
  ): Promise<GatewayInvoiceRecord | null>;

  /** The attempt a provider charge id is already attached to, if any. */
  findByChargeId(
    scope: TenantContext,
    provider: PaymentGatewayProvider,
    chargeId: string,
    tx?: unknown,
  ): Promise<GatewayInvoiceRecord | null>;

  /**
   * Records a payment the provider PUSHED (Stars' `successful_payment`): the charge id,
   * `provider_paid = true`, and the row made due for settlement at `dueAt`. Conditional
   * on no charge id yet; false when one is already recorded.
   */
  recordCharge(
    scope: TenantContext,
    paymentId: PaymentId,
    charge: { readonly chargeId: string; readonly status: string; readonly dueAt: Date },
    now: Date,
    tx: unknown,
  ): Promise<boolean>;

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
      /**
       * F3: a note kept in `creation_error_code` on a created invoice — `nexa.no_payment_link`
       * when the provider returned no link a customer can open. Null otherwise.
       */
      readonly note?: string | null;
      /**
       * Null for a `RECORDED_PAYMENT` provider, which is never asked: the row keeps
       * whatever schedule it has, so a charge recorded before this commits stays due.
       */
      readonly firstInquiryAt: Date | null;
      /**
       * A card-transfer provider's first card (`TONPAYS_TELEGRAM`): made current AND appended
       * to `gateway_invoice_cards` as seq 1, in this same statement's transaction.
       */
      readonly card?: {
        readonly instructions: GatewayCardInstructions;
        readonly policy: GatewayCardChangePolicy | null;
      } | null;
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

  /**
   * Gives back the leases a pass took and will not use. Only a lease still carrying the
   * value this claim set is cleared, so a row another worker has since claimed keeps its
   * lease. A pass that stops early (the call budget ran out) calls this for the rows it
   * did not reach; otherwise each would sit leased for the whole lease and miss the
   * retry that was promised a few seconds out.
   */
  releaseClaims(
    scope: TenantContext,
    lane: 'CREATION' | 'INQUIRY',
    paymentIds: readonly PaymentId[],
    leaseUntil: Date,
    now: Date,
    tx?: unknown,
  ): Promise<number>;

  /**
   * FIX10 BUG-1: a row whose processing THREW (a local exception, never a provider answer)
   * gives its lease back and is not due again before `retryAt`, so it neither sits at the
   * head of the queue on every pass nor holds its lease. Only a lease still carrying the
   * value this claim set is touched — a row whose outcome already committed (which clears
   * the lease) keeps the schedule that commit wrote. Nothing else changes: not the payment,
   * not the attempt's evidence, and never `creation_sent_at` — a stamped send stays stamped,
   * so the next claim still calls it UNKNOWN. An unscheduled inquiry stays unscheduled.
   *
   * Codex #268 B: an INQUIRY row is pushed to `retryAt` only while it is exactly as the claim
   * left it (`updated_at` still `claimedAt`, the claim's own stamp). A verified webhook, a
   * receipt acknowledgement or an operator's recheck that landed after the claim wrote the
   * row without touching its lease — and, because each of them only brings the schedule
   * FORWARD (`LEAST`), usually without changing `next_inquiry_at` either. Such a row keeps
   * the earlier of its schedule and `retryAt`, so the inquiry somebody asked for is not
   * suppressed behind the back-off (possibly past the attempt's deadline). The CREATION
   * lane does not read `claimedAt`.
   *
   * FIX10 (audit P1-b on #268): the same statement advances `row_failures` and returns its
   * new value — the durable count of consecutive thrown claims, advanced only by the replica
   * holding the lease — or null when nothing was backed off (and nothing counted).
   */
  backOffClaim(
    scope: TenantContext,
    lane: 'CREATION' | 'INQUIRY',
    paymentId: PaymentId,
    leaseUntil: Date,
    claimedAt: Date,
    retryAt: Date,
    now: Date,
    tx?: unknown,
  ): Promise<number | null>;

  /**
   * FIX10 (audit P1-b on #268): the row processed without throwing; its consecutive-failure
   * count goes back to zero. Touches nothing else (not `updated_at`, which the claim and the
   * hint paths compare). Returns whether a non-zero count was cleared.
   */
  clearRowFailures(scope: TenantContext, paymentId: PaymentId, tx?: unknown): Promise<boolean>;

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
      /** A provider payment id the answer named under this invoice; kept as the hint. */
      readonly hintedPaymentId?: string | null;
    },
    now: Date,
    tx?: unknown,
  ): Promise<void>;

  /**
   * An operator's "ask the provider again" on an UNKNOWN payment (§9.6.4): flags the row and
   * brings its next inquiry to `at`, conditional on no request in the last `spacingMs`.
   * A database write only; the worker makes the call under the ordinary budget.
   */
  requestReconcileInquiry(
    scope: TenantContext,
    paymentId: PaymentId,
    at: Date,
    spacingMs: number,
    tx: unknown,
  ): Promise<boolean>;

  /**
   * A new current card (a change-card answer): appended to `gateway_invoice_cards` with the
   * next sequence and made current, with what the provider said about changing it.
   */
  applyCard(
    scope: TenantContext,
    paymentId: PaymentId,
    card: GatewayCardInstructions,
    source: GatewayCardSource,
    policy: GatewayCardChangePolicy | null,
    now: Date,
    tx: unknown,
  ): Promise<number>;

  /** The current card is no longer shown (a card change whose answer was lost). History stays. */
  hideCard(scope: TenantContext, paymentId: PaymentId, now: Date, tx: unknown): Promise<boolean>;

  /** Every card the attempt was ever shown, oldest first. */
  cardsFor(
    scope: TenantContext,
    paymentId: PaymentId,
    tx?: unknown,
  ): Promise<readonly GatewayCardRecord[]>;

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
      /** A VERIFIED webhook's provider payment id under this invoice (NOWPayments). */
      readonly hintedPaymentId?: string | null;
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
   * a PENDING payment whose invoice is CREATING or CREATED, inside its deadline,
   * for exactly `amount`. A top-up has no order to pin its figure, so an attempt for
   * another amount is not this request's: handing it back would take a sum the
   * customer did not ask to pay.
   */
  findOpenAttempt(
    scope: TenantContext,
    input: {
      readonly provider: PaymentGatewayProvider;
      readonly orderId: string | null;
      readonly customerId: string;
      readonly amount: Money;
      /**
       * The bot the attempt's invoice was sent through, for a `BOT_TOKEN` provider: an
       * attempt opened in another bot's chat cannot be paid from this one. Null matches
       * an attempt with no bot.
       */
      readonly botInstanceId: string | null;
      readonly now: Date;
      /**
       * What makes a CREATED invoice payable, by the route's `invoiceForm` (audit §5.3):
       * `LINK` — a link the customer can open (F3); `CARD` — a card the provider named (a
       * created card invoice without one is not open); `ANY` — a message this bot sends
       * (Stars). A CREATING invoice is open in every form.
       */
      readonly payableForm: 'LINK' | 'CARD' | 'ANY';
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
  /** When the webhook signing secret was last replaced, or null. Never the secret. */
  webhookSecretSetAt(
    scope: TenantContext,
    provider: PaymentGatewayProvider,
    tx?: unknown,
  ): Promise<Date | null>;
  /** The webhook signing secret, decrypted, or null. For the verification only. */
  readWebhookSecret(scope: TenantContext, provider: PaymentGatewayProvider): Promise<string | null>;
  /**
   * Replaces the webhook signing secret on the route's EXISTING credential row (the key is
   * set first). Returns the new set-at time, or null when no row exists yet.
   */
  replaceWebhookSecret(
    scope: TenantContext,
    provider: PaymentGatewayProvider,
    secret: string,
    now: Date,
    tx: unknown,
  ): Promise<Date | null>;
  /** When the separate inquiry (verify) key was last replaced, or null. Never the key. */
  verifyKeySetAt(
    scope: TenantContext,
    provider: PaymentGatewayProvider,
    tx?: unknown,
  ): Promise<Date | null>;
  /** The separate inquiry (verify) key, decrypted, or null. For the inquiry call only. */
  readVerifyKey(scope: TenantContext, provider: PaymentGatewayProvider): Promise<string | null>;
  /**
   * Replaces the verify key on the route's EXISTING credential row (the API key is set
   * first). Returns the new set-at time, or null when no row exists yet.
   */
  replaceVerifyKey(
    scope: TenantContext,
    provider: PaymentGatewayProvider,
    verifyKey: string,
    now: Date,
    tx: unknown,
  ): Promise<Date | null>;
  /** The last credential check, latest state only. Null when never checked. */
  lastCheck(
    scope: TenantContext,
    provider: PaymentGatewayProvider,
    tx?: unknown,
  ): Promise<{ readonly at: Date; readonly result: string } | null>;
  /** Records a credential check's machine result on the existing row. False with no row. */
  recordCheck(
    scope: TenantContext,
    provider: PaymentGatewayProvider,
    result: string,
    now: Date,
    tx: unknown,
  ): Promise<boolean>;
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

/** One card in an attempt's history. */
export interface GatewayCardRecord {
  readonly seq: number;
  readonly cardNumber: string;
  readonly cardName: string | null;
  readonly source: GatewayCardSource;
  readonly receivedAt: Date;
}

// ---------------------------------------------------------------------------------------
// TonPays Telegram: card-change requests, receipt capture windows and receipt submissions
// (`docs/tonpays-telegram-gateway-audit.md` §7.3–§7.5). Every transition is a conditional
// UPDATE naming its `from` states; every row is tenant-scoped.
// ---------------------------------------------------------------------------------------

export interface GatewayCardChangeRecord {
  readonly id: string;
  readonly paymentId: PaymentId;
  readonly botInstanceId: string;
  readonly customerId: string;
  readonly state: GatewayCardChangeState;
  readonly requestedAt: Date;
  readonly sentAt: Date | null;
  readonly decidedAt: Date | null;
  readonly errorCode: string | null;
}

export interface GatewayReceiptCaptureRecord {
  readonly id: string;
  readonly botInstanceId: string;
  readonly customerId: string;
  readonly paymentId: PaymentId;
  readonly providerInvoiceId: string;
  readonly openedAt: Date;
  readonly expiresAt: Date;
}

export interface GatewayReceiptSubmissionRecord {
  readonly id: string;
  readonly paymentId: PaymentId;
  readonly providerInvoiceId: string;
  readonly botInstanceId: string;
  readonly customerId: string;
  readonly captureId: string;
  readonly telegramFileId: string;
  readonly telegramFileUniqueId: string;
  readonly declaredSize: bigint | null;
  readonly state: GatewayReceiptSubmissionState;
  readonly attempts: number;
  readonly sentAt: Date | null;
  readonly retryAt: Date | null;
  readonly decidedAt: Date | null;
  readonly errorCode: string | null;
  readonly providerStatus: string | null;
  readonly receiptReceived: boolean | null;
  readonly openedReview: boolean;
  readonly inquiryResolvedAt: Date | null;
  readonly byteLength: number | null;
  /** FIX10 (audit P1-b on #268): consecutive thrown claims, as on an invoice. */
  readonly rowFailures: number;
  readonly createdAt: Date;
}

/** A claimed row with the payment facts the worker re-reads beside it. */
export interface ClaimedCardTransferRow<T> {
  readonly row: T;
  readonly paymentState: string;
  readonly paymentExpiresAt: Date | null;
  readonly paymentReviewUntil: Date | null;
}

export interface GatewayCardTransferRepository {
  // --- card changes ------------------------------------------------------------------
  /** `REQUESTED`, refused by the partial unique index while one is in flight (null). */
  requestCardChange(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly paymentId: PaymentId;
      readonly botInstanceId: string;
      readonly customerId: string;
      readonly idempotencyKey: string;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<GatewayCardChangeRecord | null>;
  latestCardChange(
    scope: TenantContext,
    paymentId: PaymentId,
    tx?: unknown,
  ): Promise<GatewayCardChangeRecord | null>;
  claimCardChanges(
    scope: TenantContext,
    now: Date,
    leaseMs: number,
    limit: number,
    tx: unknown,
  ): Promise<readonly ClaimedCardTransferRow<GatewayCardChangeRecord>[]>;
  /** `REQUESTED -> SENT`, stamped BEFORE the call. */
  markCardChangeSent(scope: TenantContext, id: string, now: Date, tx: unknown): Promise<boolean>;
  /** `REQUESTED | SENT -> APPLIED | REFUSED | RATE_LIMITED | UNKNOWN`. */
  decideCardChange(
    scope: TenantContext,
    id: string,
    to: Exclude<GatewayCardChangeState, 'REQUESTED' | 'SENT'>,
    errorCode: string | null,
    now: Date,
    tx: unknown,
  ): Promise<boolean>;
  /** Gives back unreached leases (only those still carrying `leaseUntil`). */
  releaseCardChangeClaims(
    scope: TenantContext,
    ids: readonly string[],
    leaseUntil: Date,
    tx: unknown,
  ): Promise<number>;

  // --- receipt capture windows ---------------------------------------------------------
  /**
   * Opens the payment-scoped window, under the (tenant, bot, customer) advisory lock the
   * manual window takes: closes this customer's open gateway window AND open manual
   * `receipt_captures` window in this bot as SUPERSEDED (or EXPIRED), then inserts.
   */
  openCapture(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly botInstanceId: string;
      readonly customerId: string;
      readonly paymentId: PaymentId;
      readonly providerInvoiceId: string;
      readonly openedAt: Date;
      readonly expiresAt: Date;
    },
    tx: unknown,
  ): Promise<GatewayReceiptCaptureRecord>;
  /**
   * Take the (tenant, bot, customer) capture lock every window opening takes — manual and
   * provider alike — so a photo's routing and a window's supersession are serialised.
   */
  lockCaptureNamespace(
    scope: TenantContext,
    botInstanceId: string,
    customerId: string,
    tx: unknown,
  ): Promise<void>;
  /** The open window for (tenant, bot, customer), whatever its deadline, or null. */
  findOpenCapture(
    scope: TenantContext,
    botInstanceId: string,
    customerId: string,
    tx?: unknown,
  ): Promise<GatewayReceiptCaptureRecord | null>;
  closeCapture(
    scope: TenantContext,
    id: string,
    reason: GatewayReceiptCaptureCloseReason,
    at: Date,
    tx: unknown,
  ): Promise<boolean>;
  /** Every open window of one payment, closed with `reason`. */
  closeCapturesForPayment(
    scope: TenantContext,
    paymentId: PaymentId,
    reason: GatewayReceiptCaptureCloseReason,
    at: Date,
    tx: unknown,
  ): Promise<number>;
  /**
   * The sweep: windows past their deadline become EXPIRED; windows whose payment left
   * PENDING (or entered review) become PAYMENT_CLOSED. Bounded.
   */
  sweepCaptures(scope: TenantContext, now: Date, limit: number, tx: unknown): Promise<number>;

  // --- receipt submissions --------------------------------------------------------------
  /** `QUEUED`; null when this photo is already a submission for this payment. */
  queueSubmission(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly paymentId: PaymentId;
      readonly providerInvoiceId: string;
      readonly botInstanceId: string;
      readonly customerId: string;
      readonly captureId: string;
      readonly telegramFileId: string;
      readonly telegramFileUniqueId: string;
      readonly declaredSize: bigint | null;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<GatewayReceiptSubmissionRecord | null>;
  submissionsFor(
    scope: TenantContext,
    paymentId: PaymentId,
    tx?: unknown,
  ): Promise<readonly GatewayReceiptSubmissionRecord[]>;
  claimSubmissions(
    scope: TenantContext,
    now: Date,
    leaseMs: number,
    limit: number,
    tx: unknown,
  ): Promise<readonly ClaimedCardTransferRow<GatewayReceiptSubmissionRecord>[]>;
  /** `QUEUED -> SENDING`, stamped and committed BEFORE the upload. */
  markSubmissionSending(
    scope: TenantContext,
    id: string,
    byteLength: number,
    now: Date,
    tx: unknown,
  ): Promise<boolean>;
  /** `QUEUED | SENDING -> ACCEPTED | REFUSED | UNKNOWN | ABANDONED`. */
  decideSubmission(
    scope: TenantContext,
    id: string,
    to: 'ACCEPTED' | 'REFUSED' | 'UNKNOWN' | 'ABANDONED',
    facts: {
      readonly errorCode: string | null;
      readonly providerStatus: string | null;
      readonly receiptReceived: boolean | null;
    },
    now: Date,
    tx: unknown,
  ): Promise<boolean>;
  /** A provider rate limit: `SENDING -> QUEUED`, send stamp cleared, retried at `retryAt`. */
  requeueSubmission(
    scope: TenantContext,
    id: string,
    errorCode: string,
    retryAt: Date,
    now: Date,
    tx: unknown,
  ): Promise<boolean>;
  /** The ACCEPTED submission whose acknowledgement opened the review. Once per payment. */
  markOpenedReview(scope: TenantContext, id: string, tx: unknown): Promise<boolean>;
  /**
   * An inquiry SENT after these UNKNOWN uploads were given up on: resolved FOR DISPLAY, never
   * a review. Compared with the inquiry's send time, not its answer time — an inquiry already
   * on the wire when the upload was lost says nothing about the upload (review F11).
   */
  resolveUnknownSubmissions(
    scope: TenantContext,
    paymentId: PaymentId,
    inquirySentAt: Date,
    now: Date,
    tx?: unknown,
  ): Promise<number>;
  releaseSubmissionClaims(
    scope: TenantContext,
    ids: readonly string[],
    leaseUntil: Date,
    tx: unknown,
  ): Promise<number>;
  /**
   * FIX10 BUG-1: a submission whose processing threw gives its lease back and waits until
   * `retryAt`. Conditional on the lease this claim set and on a state still in flight; its
   * `sent_at` is never cleared, so a stamped upload is still UNKNOWN on the next claim.
   */
  backOffSubmission(
    scope: TenantContext,
    id: string,
    leaseUntil: Date,
    retryAt: Date,
    now: Date,
    tx: unknown,
  ): Promise<number | null>;
  /** FIX10 (audit P1-b on #268): as `GatewayInvoiceRepository.clearRowFailures`. */
  clearSubmissionFailures(scope: TenantContext, id: string, tx: unknown): Promise<boolean>;
}
