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
    }
  | { readonly kind: 'REFUSED'; readonly code: string; readonly configuration: boolean }
  | { readonly kind: 'RATE_LIMITED'; readonly code: string }
  | { readonly kind: 'AMBIGUOUS'; readonly code: string }
  | { readonly kind: 'UNKNOWN'; readonly code: string };

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
   * `credential` is what the route's descriptor says an invoice is sent with: the stored
   * gateway key (`GATEWAY_KEY`), or the token of the attempt's bot (`BOT_TOKEN`).
   */
  createInvoice(credential: string, request: GatewayCreateRequest): Promise<GatewayCreateOutcome>;
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
}
