import {
  GATEWAY_RETURN_PATH_PREFIX,
  GATEWAY_ROW_FAILING_CODE,
  GATEWAY_ROW_FAILURE_ALERT_AFTER,
  GATEWAY_ROW_RECOVERED_CODE,
  PAYMENT_GATEWAY_DESCRIPTORS,
  TONPAYS_SIGNATURE_REJECTED_CODE,
  TONPAYS_SIGNATURE_VERIFIED_CODE,
  TONPAYS_TELEGRAM_RECEIPT_MAX_ATTEMPTS,
  TONPAYS_TELEGRAM_STATUS_LESS,
  TONPAYS_TELEGRAM_REVIEW_CHECK_SPACING_MS,
  TONPAYS_TELEGRAM_REVIEW_WINDOW_MS,
  paymentTrackingCode,
  systemJobActor,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type CorrelationId,
  type IdGenerator,
  type OperationalEventInput,
  type OperationalEventRecorder,
  orderPurposeCreatesNewService,
  type OrderPurpose,
  type PaymentGatewayProvider,
  type PaymentId,
  type TenantContext,
  type UnitOfWork,
  type UserId,
} from '@nexa/contracts';
import type { OutboxWriter } from '../../../platform/eventing/infrastructure/outbox-writer.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { SettingsResolver } from '../../../control/settings/application/settings-resolver.js';
import type { CustomerRepository } from '../../customers/application/ports.js';
import {
  INQUIRY_MIN_SPACING_MS,
  POST_DEADLINE_INQUIRY_MAX,
  TONPAYS_CREATE_MAX_ATTEMPTS,
  TONPAYS_CREATE_RETRY_MS,
} from '../domain/tonpays.js';
import { gatewaySettlementDeadline } from '../domain/settlement.js';
import { creditAmountDiffers, principalInProviderUnit } from '../domain/credit-amount.js';
import { nextTehranMidnight, tetrapayCallbackUrl } from '../domain/tetrapay.js';
import {
  firstInquiryAt,
  hintReservePerMinute,
  inquiryScheduleFor,
  jitteredMs,
  nextScheduledInquiryAt,
} from '../domain/inquiry-schedule.js';
import {
  inquiryDiscoveryTrigger,
  type GatewayDiscoveryTrigger,
  type InquiryDiscoveryTrigger,
} from '../domain/inquiry-discovery.js';
import {
  buyerConflictRetryAllowed,
  isBuyerConflictCode,
  receiptAcknowledged,
  receiptFileName,
  reviewInquiryNextAt,
  sniffReceiptImage,
  type CardChangeAllowance,
} from '../domain/tonpays-telegram.js';
import type {
  CardTransferGatewayAdapter,
  ClaimedCardTransferRow,
  ClaimedGatewayInvoice,
  ExternalGatewayAdapter,
  GatewayCardChangeRecord,
  GatewayCardTransferRepository,
  GatewayReceiptSubmissionRecord,
  GatewayCallBudget,
  GatewayCredentialStore,
  GatewayInvoicePresentation,
  GatewayInvoiceRecord,
  GatewayInvoiceRepository,
  GatewayProviderFacts,
  GatewayProviderRequestRecord,
  GatewayProviderRequestRepository,
  GatewayWebhookHint,
  RefundCardSealer,
} from './gateway-invoice-ports.js';
import { GATEWAY_HELD_RETRY_MIN_MS } from './gateway-invoice-ports.js';
import { GatewayProviderRequestLane } from './gateway-provider-request.lane.js';
import type { PaymentRecord, PaymentRepository } from './ports.js';
import type { GatewayConfirmation, PaymentService } from './payment.service.js';
import {
  GATEWAY_CREATE_UNKNOWN_EVENT_CODE,
  paymentLinkConfigurationFailure,
  paymentLinkFailureEvent,
  paymentLinkFailureOf,
  paymentLinkInterruptedFailure,
  type PaymentLinkFailure,
} from './payment-link-failure.js';
import {
  recordQuietly,
  sanitizedErrorCode,
} from '../../../platform/opslog/application/error-events.js';
import { GatewayInquiryHealth } from './gateway-inquiry-health.js';
import { readCardSwitchLimits } from './card-switch-limits.js';
import {
  cancelledAttemptPollingOpen,
  lateCreditPollAt,
  lateCreditPollingOpen,
  type LateCreditPolicy,
} from '../domain/late-credit.js';

/**
 * Operational codes this lane raises. Declared beside their producer, and each is part
 * of the schema once shipped (CLAUDE.md): never renamed, never split.
 *
 * - `payments.gateway_misconfigured` — the provider refused this installation's own
 *   configuration (key, account, store, callback). One open condition per provider;
 *   closed by `payments.gateway_configured` when a create next succeeds.
 * - `payments.gateway_create_unknown` — a create's answer was lost. Per attempt.
 * - `payments.gateway_late_completion` — the provider approved an attempt Nexa can no
 *   longer settle (deadline passed, or closed another way). Per attempt. Nothing moved:
 *   an operator decides what, if anything, to do.
 * - `payments.gateway_identity_mismatch` — an inquiry or a webhook named ids that do not
 *   belong to the attempt it was about. Per attempt. Ignored, recorded.
 */
export const GATEWAY_MISCONFIGURED_CODE = 'payments.gateway_misconfigured';
export const GATEWAY_CONFIGURED_CODE = 'payments.gateway_configured';
export const GATEWAY_CREATE_UNKNOWN_CODE = GATEWAY_CREATE_UNKNOWN_EVENT_CODE;
export const GATEWAY_LATE_COMPLETION_CODE = 'payments.gateway_late_completion';
export const GATEWAY_IDENTITY_MISMATCH_CODE = 'payments.gateway_identity_mismatch';
/**
 * TonPays Telegram (`docs/tonpays-telegram-gateway-audit.md` §9.4), declared beside their
 * producer and part of the schema once shipped:
 *
 * - `payments.gateway_receipt_unknown` — a receipt upload's answer was lost. Per payment.
 *   Never re-uploaded; the next inquiry is brought forward.
 * - `payments.gateway_card_change_unknown` — a card change's answer was lost. Per payment.
 *   The current card is hidden and the request is never re-sent.
 * - `payments.gateway_review_unresolved` (WARN) — a provider review ended with no
 *   trustworthy answer and the payment is UNKNOWN. Per payment. Recovered by
 *   `payments.gateway_review_reconciled` (INFO) when an operator reconciles it
 *   (`PaymentService.reconcileGatewayPayment`).
 */
export const GATEWAY_RECEIPT_UNKNOWN_CODE = 'payments.gateway_receipt_unknown';
export const GATEWAY_CARD_CHANGE_UNKNOWN_CODE = 'payments.gateway_card_change_unknown';
export const GATEWAY_REVIEW_UNRESOLVED_CODE = 'payments.gateway_review_unresolved';
export const GATEWAY_REVIEW_RECONCILED_CODE = 'payments.gateway_review_reconciled';
/**
 * The audit action of every `PENDING -> UNKNOWN` this lane writes. A mismatch hold records a
 * machine `reason` in `after`; a lapsed review does not. The Payment Operations Center's
 * `MISMATCH` queue and the timeline's `PAYMENT_OUTCOME_UNKNOWN` read exactly that, so the
 * name is a constant both sides import rather than a string each one spells.
 */
export const PAYMENT_LOSE_TRACK_ACTION = 'payment.lose_track';
/** R8 A6: the audit row of the gateway's rejection reasons, read by the payment timeline. */
export const PROVIDER_REJECTION_REASONS_ACTION = 'gateway_invoice.provider_rejection_reasons';
/**
 * NOWPayments (`docs/nowpayments-gateway-audit.md` §5.6), declared beside their producer and
 * part of the schema once shipped:
 *
 * - `payments.gateway_webhook_unverified` (WARN) — a webhook for a route whose provider
 *   signs them arrived with a signature that did not verify against the stored secret (or
 *   with no secret stored). Dropped unread. One open condition per provider; closed by
 *   `payments.gateway_webhook_verified` (INFO) when a signed webhook next verifies. A
 *   stranger can raise it only by posting junk, and only once: it is deduplicated.
 *
 * A NOWPayments MISMATCH (a partial payment, or `finished` for another price) is raised as
 * `payments.gateway_review_unresolved` with `reason: PROVIDER_AMOUNT_MISMATCH` — the same
 * operator condition an unresolved review raises, closed by the same reconciliation.
 */
export const GATEWAY_WEBHOOK_UNVERIFIED_CODE = 'payments.gateway_webhook_unverified';
export const GATEWAY_WEBHOOK_VERIFIED_CODE = 'payments.gateway_webhook_verified';

/**
 * The condition a refused webhook raises, and the one that closes it. TonPays' routes have their
 * own pair (R7: ERRORS topic, Persian text) because their refusal is also answered 401; every
 * other signed route keeps the SECURITY pair above.
 */
function webhookConditionCodesOf(provider: PaymentGatewayProvider): {
  readonly rejected: string;
  readonly verified: string;
  readonly severity: 'WARN' | 'ERROR';
  readonly rejectedMessage: string;
} {
  if (provider === 'TONPAYS' || provider === 'TONPAYS_TELEGRAM') {
    return {
      rejected: TONPAYS_SIGNATURE_REJECTED_CODE,
      verified: TONPAYS_SIGNATURE_VERIFIED_CODE,
      severity: 'ERROR',
      rejectedMessage:
        'امضای وب‌هوک تون‌پیز تأیید نشد و درخواست رد شد. سکرت وب‌هوک را در نکسا و پنل تون‌پیز ' +
        'یکسان کنید؛ پرداخت‌ها همچنان با استعلام درگاه تأیید می‌شوند.',
    };
  }
  return {
    rejected: GATEWAY_WEBHOOK_UNVERIFIED_CODE,
    verified: GATEWAY_WEBHOOK_VERIFIED_CODE,
    severity: 'WARN',
    rejectedMessage:
      'A payment gateway notification arrived whose signature did not verify against the ' +
      'stored webhook secret. It was ignored; check the webhook secret if this repeats. ' +
      'Payments are still confirmed by the gateway’s own status read.',
  };
}
/**
 * FIX-03 (batch 2026-10-10), declared beside their producer and part of the schema once
 * shipped:
 *
 * - `payments.gateway_settlement_failed` (ERROR) — the provider APPROVED an attempt and the
 *   settlement transaction refused (`confirmGatewayPayment` threw). Nothing moved; the
 *   inquiry stays scheduled and is asked again inside the deadline. One condition per
 *   payment, its counter the number of refusals; closed by `payments.gateway_settlement_decided`
 *   (INFO) once the lane decides that payment (audit P2-b on #260).
 * - `payments.gateway_inquiry_failing` (WARN) — a gateway's inquiries keep failing
 *   (`GatewayInquiryHealth`). One open condition per gateway; closed by
 *   `payments.gateway_inquiry_ok` (INFO) when an inquiry is next answered.
 */
export const GATEWAY_SETTLEMENT_FAILED_CODE = 'payments.gateway_settlement_failed';
export const GATEWAY_INQUIRY_FAILING_CODE = 'payments.gateway_inquiry_failing';
export const GATEWAY_INQUIRY_OK_CODE = 'payments.gateway_inquiry_ok';
/**
 * Audit P2-b on #260: closes a payment's `payments.gateway_settlement_failed` once the lane
 * has DECIDED that payment — settled (or found already settled), failed, held for an
 * operator, or recorded late. Its dedupe key names the payment, so it closes that payment's
 * alarm and no other.
 */
export const GATEWAY_SETTLEMENT_DECIDED_CODE = 'payments.gateway_settlement_decided';

/**
 * The note a CREATED card-transfer attempt carries in `creation_error_code` when the
 * provider's answer named no card: it exists, is still asked about, and cannot be paid
 * from Telegram — so it is never handed back as the open attempt.
 */
export const NO_PAYMENT_CARD_CODE = 'nexa.no_payment_card';

/**
 * F3 (round N): the note a CREATED attempt carries in `creation_error_code` when the
 * provider returned no link a customer can open. A machine code on the row, not an
 * operational-event code.
 */
export const NO_PAYMENT_LINK_CODE = 'nexa.no_payment_link';

/** How long a claimed row is held before another replica may take it (at least). */
export const GATEWAY_CLAIM_LEASE_MS = 60_000;
/**
 * FIX10 R1: the longest ONE row of a lane may take — a provider call at its full timeout and
 * the Telegram calls around it (a receipt's two downloads, the invoice screen's edit). This is
 * the default; the container passes the bound its configured timeouts give (`rowBoundMs`).
 * A lane STARTS a row only while its claim's lease still covers this bound from now, and gives
 * the rest back; and the lease is never shorter than the bound plus the margin. Together they
 * mean a row is never still being worked on when its lease runs out and another replica may
 * claim it — which is what let a second replica call a live create UNKNOWN.
 */
export const GATEWAY_ROW_BOUND_MS = 45_000;
export const GATEWAY_LEASE_MARGIN_MS = 15_000;

export function gatewayClaimLeaseMs(rowBoundMs: number): number {
  return Math.max(GATEWAY_CLAIM_LEASE_MS, rowBoundMs + GATEWAY_LEASE_MARGIN_MS);
}

/** Rows per pass, per queue. Small: every one of them is a call to a third party. */
export const GATEWAY_CREATE_BATCH = 5;
export const GATEWAY_INQUIRY_BATCH = 10;
/**
 * Codex on #277: how many due rows the hinted phase READS to find the hinted ones among
 * them (most likely hinted first). A read, not a claim and not a call: it bounds the work of
 * looking, never the outbound rate.
 */
export const GATEWAY_HINT_SCAN_LIMIT = 50;
/** TonPays Telegram: card changes and receipt uploads per pass; review and window sweeps. */
export const GATEWAY_CARD_CHANGE_BATCH = 5;
export const GATEWAY_RECEIPT_BATCH = 3;
export const GATEWAY_REVIEW_SWEEP_BATCH = 50;
export const GATEWAY_CAPTURE_SWEEP_BATCH = 100;
/** A rate-limited receipt is re-queued this far out (the provider's own word, a 4xx). */
export const RECEIPT_RATE_LIMIT_RETRY_MS = 60_000;
/**
 * How soon a recorded charge whose outcome did not commit is tried again, when no inquiry
 * backoff applies (it is past its deadline, or on the last retry before it).
 */
export const RECORDED_OUTCOME_RETRY_MS = 60_000;

/**
 * How soon a rate-limited inquiry is asked again, at the least: the later of its normal step
 * and this. Shared with the FIX-01 evidence, which must know the row's real schedule.
 */
export const INQUIRY_RATE_LIMIT_RETRY_MS = 60_000;

/**
 * Round 11 A8: the soonest a call the adapter's own limiter HELD (nothing sent) is tried again.
 * Defined beside the ports since R11 A8 (cancel retry): the cancel lane uses it too.
 */
export { GATEWAY_HELD_RETRY_MIN_MS };

/**
 * FIX10 BUG-1: how soon a row whose processing THREW is due again. Measured from the last
 * time the row made progress, halved, and held between the two bounds — so a row that fails
 * once is retried within a minute, one that keeps failing backs off to the cap and stays
 * there (it is never abandoned: a local fault, fixed, must let the row finish), and in
 * neither case does it keep the head of the queue. Its own constants, not the inquiry
 * schedule's: this is not an answer from a provider.
 */
export const GATEWAY_ROW_FAILURE_RETRY_MIN_MS = 30_000;
export const GATEWAY_ROW_FAILURE_RETRY_MAX_MS = 5 * 60_000;

export function rowFailureRetryAt(now: Date, since: Date | null): Date {
  const elapsed = since === null ? 0 : Math.max(0, now.getTime() - since.getTime());
  const delay = Math.min(
    GATEWAY_ROW_FAILURE_RETRY_MAX_MS,
    Math.max(GATEWAY_ROW_FAILURE_RETRY_MIN_MS, Math.floor(elapsed / 2)),
  );
  return new Date(now.getTime() + delay);
}

/**
 * The one log line a failing row leaves, every time it fails: what an operator (or a log
 * alert) searches for. A row that keeps failing repeats it at most every
 * `GATEWAY_ROW_FAILURE_RETRY_MAX_MS`, and the pass report counts it as `rowFailures`.
 */
export const GATEWAY_ROW_FAILED_MESSAGE =
  'gateway payment row failed; backed off, and the pass continues with the next row';

/**
 * FIX10 (audit P1-b on #268): the subject of a failing row's operator condition
 * (`payments.gateway_row_failing`) — one per invoice row, one per receipt submission — so
 * the condition is opened, counted and closed for that row and no other.
 */
export function gatewayRowConditionKey(
  row:
    | { readonly kind: 'INVOICE'; readonly paymentId: string }
    | { readonly kind: 'RECEIPT'; readonly submissionId: string },
): string {
  return row.kind === 'INVOICE'
    ? `${GATEWAY_ROW_FAILING_CODE}:invoice:${row.paymentId}`
    : `${GATEWAY_ROW_FAILING_CODE}:receipt:${row.submissionId}`;
}

/**
 * What a log line may say about an exception: its class, a NexaError's machine code and a
 * PostgreSQL SQLSTATE. Never its message — a driver's message or detail can carry a value
 * (a reference, a key fragment), and a provider error can carry a payload.
 */
export function errorFacts(error: unknown): {
  readonly error: string;
  readonly code: string | null;
} {
  const name = error instanceof Error ? error.name : 'unknown';
  // A SQLSTATE (`23505`) or a machine code (`platform.secret_version_unsupported`), on the
  // error or on the one it wraps (the query builder wraps the driver's); nothing free-form.
  const codeOf = (value: unknown): string | null => {
    const raw =
      typeof value === 'object' && value !== null && 'code' in value
        ? (value as { code?: unknown }).code
        : undefined;
    return typeof raw === 'string' && /^[A-Za-z0-9_.]{1,64}$/.test(raw) ? raw : null;
  };
  const cause = error instanceof Error ? error.cause : undefined;
  return { error: name, code: codeOf(error) ?? codeOf(cause) };
}

/**
 * Codex #269: how many post-deadline inquiries BEYOND `POST_DEADLINE_INQUIRY_MAX` an
 * approval whose decision never committed may still be given. Its retry re-asks the provider
 * (only the inquiry decides) and is therefore a post-deadline inquiry like any other; without
 * this allowance an approval met on the last permitted post-deadline inquiry, whose decision
 * then failed, would be stopped by the bound with neither a settlement nor a late completion.
 * Bounded, so a decision that fails for ever does not ask the provider for ever.
 */
export const GATEWAY_DECISION_RETRY_MAX = 5;

/** The path a provider's webhook is served on. The route and this must agree. */
export const GATEWAY_WEBHOOK_PATH_PREFIX = '/payments/webhook';

export function gatewayWebhookPath(provider: PaymentGatewayProvider, tenantId: string): string {
  return `${GATEWAY_WEBHOOK_PATH_PREFIX}/${provider.toLowerCase()}/${tenantId}`;
}

/**
 * The callback URL a provider is sent, GENERATED (brief §14): the tenant's registered
 * public origin plus the provider's webhook path. Null when no origin is registered —
 * the invoice is then created without one and reconciliation alone decides. No secret
 * travels in it: the path names the tenant, and a webhook only ever schedules an inquiry.
 */
/**
 * The return URL base a `browserReturn` route's provider is sent (CentralPay): the tenant's
 * registered public origin plus the return path. The adapter appends the attempt's own
 * `orderId`. Null when no origin is registered — the create is then refused as the
 * installation's configuration, because the provider requires the URL.
 */
export function gatewayReturnUrl(
  origin: string | null,
  provider: PaymentGatewayProvider,
  tenantId: string,
): string | null {
  return origin === null
    ? null
    : `${origin}${GATEWAY_RETURN_PATH_PREFIX}/${provider.toLowerCase()}/${tenantId}`;
}

export function gatewayCallbackUrl(
  origin: string | null,
  provider: PaymentGatewayProvider,
  tenantId: string,
): string | null {
  return origin === null ? null : `${origin}${gatewayWebhookPath(provider, tenantId)}`;
}

export interface GatewayPaymentServiceDeps {
  readonly invoices: GatewayInvoiceRepository;
  readonly payments: Pick<
    PaymentService,
    | 'confirmGatewayPayment'
    | 'failGatewayPayment'
    | 'recordProviderReview'
    | 'recordProviderFundsDetected'
  >;
  readonly paymentRecords: Pick<
    PaymentRepository,
    'findById' | 'findByIdForUpdate' | 'setExternalReference' | 'loseTrackOfReviewed' | 'loseTrack'
  >;
  /**
   * TonPays Telegram (§7.3–§7.5): card-change requests, receipt windows and submissions.
   * Absent in a lane that serves no card-transfer route; their passes then do nothing.
   */
  readonly cardTransfer?: GatewayCardTransferRepository;
  /**
   * Round 6 (TonPays Telegram): cancel and refund requests, and the provider's latest word on
   * what the customer owes next. Absent, those passes do nothing and an inquiry records no
   * facts.
   */
  readonly providerRequests?: GatewayProviderRequestRepository;
  /** Opens a refund card sealed by the customer's turn (purpose `payment_gateway.refund_card`). */
  readonly refundCards?: RefundCardSealer;
  /** The card-transfer capability, resolved by descriptor (`invoiceForm`), or null. */
  readonly cardAdapters?: (provider: PaymentGatewayProvider) => CardTransferGatewayAdapter | null;
  /**
   * A receipt's bytes, fetched with the token of the bot the photo was sent to (the
   * submission's, which is the invoice's), bounded while streaming. Held only for one upload.
   */
  readonly receiptFiles?: {
    download(
      scope: TenantContext,
      binding: { readonly botInstanceId: string; readonly fileId: string },
      options: { readonly maxBytes: number },
    ): Promise<
      | { readonly outcome: 'SUCCEEDED'; readonly bytes: Uint8Array }
      | { readonly outcome: 'UNAVAILABLE'; readonly reason: string }
    >;
  };
  readonly adapters: (provider: PaymentGatewayProvider) => ExternalGatewayAdapter | null;
  readonly credentials: GatewayCredentialStore;
  /**
   * The token of ONE bot instance, for a `BOT_TOKEN` route (Telegram Stars): the invoice is
   * sent by the bot the customer is talking to. Null when that bot is gone or disabled.
   */
  readonly botTokens: {
    tokenForBotInstance(scope: TenantContext, botInstanceId: string): Promise<string | null>;
  };
  /**
   * The invoice's own text, rendered from the tenant's templates, for a provider whose
   * invoice is a message this installation sends. Never a literal.
   */
  readonly presentation: (scope: TenantContext) => Promise<GatewayInvoicePresentation>;
  readonly budget: GatewayCallBudget;
  /** `gatewayCallbackUrl` over the tenant's registered origin, or null. */
  readonly callbackUrlFor: (
    scope: TenantContext,
    provider: PaymentGatewayProvider,
  ) => Promise<string | null>;
  readonly customers: Pick<CustomerRepository, 'findById'>;
  readonly conditions: {
    conditionIsOpen(scope: TenantContext, dedupeKey: string): Promise<boolean>;
  };
  readonly scopeActivity: ScopeActivityReader;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  /** For `PaymentLateCompletionObserved` (WP18), written beside the audit row. */
  readonly outbox: Pick<OutboxWriter, 'write'>;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: {
    info: (context: Record<string, unknown>, message: string) => void;
    warn: (context: Record<string, unknown>, message: string) => void;
    error: (context: Record<string, unknown>, message: string) => void;
  };
  /**
   * R2 (v0.3.5 real-test item 4): the customer's Telegram message showing this attempt,
   * edited in place once the attempt's state has moved — the invoice ready, the create
   * refused or lost, the payment approved or not. Called AFTER the outcome committed and
   * outside every transaction; it reads the committed attempt and decides nothing about it.
   * Absent, the customer sees the change on their next status-check tap, as before.
   */
  readonly invoiceScreens?: {
    refresh(scope: TenantContext, paymentId: string): Promise<void>;
    /**
     * R9 C1: the customer now owes a NEXT STEP (the remainder of an underpaid invoice, a refund
     * card for an overpaid one): told in a NEW message, which notifies them, rather than only an
     * edit of a message they may no longer be looking at — or that no longer exists. Falls back
     * to `refresh` when there is nothing to tell or nowhere to send it. Absent: `refresh`.
     */
    announce?(scope: TenantContext, paymentId: string): Promise<void>;
  };
  /**
   * CentralPay's browser return (§5.6): the tenant's bot as a `https://t.me/<username>` link
   * the result redirects to, from the stored bot row (no Telegram call on a public GET), or
   * null. Absent, the return answers without a link.
   */
  readonly botLinkFor?: (scope: TenantContext) => Promise<string | null>;
  /**
   * Round 6 item 6: hides a route until `until` because the PROVIDER said so (TetraPay's
   * `DAILY_LIMIT_REACHED`). Written in the lane's own transaction beside its audit row. Absent,
   * a refusal that asks for it is still recorded and the route simply stays offered.
   */
  readonly routeVisibility?: {
    hideUntil(
      scope: TenantContext,
      provider: PaymentGatewayProvider,
      until: Date,
      now: Date,
      tx: TransactionScope,
    ): Promise<boolean>;
  };
  /** FIX10 R1: `GATEWAY_ROW_BOUND_MS` from the configured timeouts; the default otherwise. */
  readonly rowBoundMs?: number;
  /**
   * R5A item 4: crediting a route's verified LATE approval to the customer's wallet. Absent,
   * a late approval is recorded as a late completion and nothing else, exactly as before
   * this existed. `policyFor` is the route's switch and the polling window (the lane's
   * scheduling reads it); `credit` is `PaymentService.creditLateGatewayApproval`, which
   * decides again under the payment's lock — the switch included.
   */
  readonly lateCredit?: {
    policyFor(scope: TenantContext, provider: PaymentGatewayProvider): Promise<LateCreditPolicy>;
    credit: PaymentService['creditLateGatewayApproval'];
  };
  /**
   * FIX-03 (batch 2026-10-10): the per-gateway count of failed inquiries behind
   * `payments.gateway_inquiry_failing`. Absent, the defaults (`GatewayInquiryHealth`).
   */
  readonly inquiryHealth?: GatewayInquiryHealth;
  /**
   * R8 A2: the owner's R5C-1 card-switch limits, read for the card screen's «🔄 تعویض کارت»
   * (a courtesy: the tap decides again under the payment's lock). Absent, the screen applies
   * the provider's rules alone.
   */
  readonly cardSwitchSettings?: Pick<SettingsResolver, 'valueOf'>;
  /**
   * R9 C1: one provider rejection reason as the customer reads it (`rejectReasonFa`, bound
   * from `@nexa/i18n` by the container: this layer may not import the catalogue). Absent:
   * the reasons as worded.
   */
  readonly rejectReasonText?: (reason: string) => string;
  /**
   * Round 10 C1: an `operatorEndpoint` route's callback IP allow-list (the custom gateway,
   * protocol §9.2) and the one address matcher (`matchesTrustedEntry`, exact or CIDR bit by bit,
   * bound by the container). An empty or absent list is no address check. Absent dependency:
   * no check — the signature is the authentication, the list defence in depth.
   */
  readonly webhookSources?: {
    allowlistFor(
      scope: TenantContext,
      provider: PaymentGatewayProvider,
    ): Promise<readonly string[] | null>;
    matches(address: string, entry: string): boolean;
  };
}

/** What one pass did, for the loop's log and for a test. Counts only; no identifiers. */
export interface GatewayPassReport {
  readonly created: number;
  readonly createFailed: number;
  readonly createUnknown: number;
  readonly createDeferred: number;
  readonly inquired: number;
  readonly settled: number;
  readonly unsuccessful: number;
  readonly lateCompletions: number;
  /** R5A item 4: late approvals credited to a wallet this pass. */
  readonly lateCredits: number;
  readonly budgetExhausted: boolean;
  /** TonPays Telegram: payments whose review lapsed (UNKNOWN), card changes, receipts. */
  readonly reviewsLapsed: number;
  readonly cardChanges: number;
  /** Round 6: cancels and refunds sent to the provider. */
  readonly providerRequests: number;
  readonly receipts: number;
  /** NOWPayments: attempts whose coins were seen (review opened) or held for a MISMATCH. */
  readonly reviewsOpened: number;
  readonly held: number;
  /**
   * FIX10 BUG-1: rows whose processing threw this pass. Each was logged as
   * `GATEWAY_ROW_FAILED_MESSAGE` with its ids and backed off; the pass went on without it.
   * A row's failure is isolated: the lane around it still did its work.
   */
  readonly rowFailures: number;
  /**
   * FIX10 R1: rows given back unprocessed because the lease no longer covered one more row
   * (the next pass claims them), and rows whose fenced write found the lease taken over.
   */
  readonly leaseReleased: number;
  readonly leaseLost: number;
  /**
   * FIX10 (Codex #268 A): LANES that threw this pass — a claim, a sweep, anything outside a
   * single row. The pass still runs every other lane, but a lane that failed did nothing, so
   * the loop records NO progress for this pass: a lane that throws on every pass goes stale
   * and the worker's readiness says so, instead of a fresh heartbeat over a dead queue.
   */
  readonly laneFailures: number;
}

/** What a webhook did. Never anything the caller could turn into money. */
export type GatewayWebhookResult =
  | 'SCHEDULED'
  | 'RECORDED'
  | 'DUPLICATE'
  | 'IGNORED_UNKNOWN'
  | 'IGNORED_MISMATCH'
  | 'IGNORED_INACTIVE'
  /** A signed route's webhook whose signature did not verify: dropped before it was read. */
  | 'IGNORED_UNVERIFIED'
  /** Round 9 C4: the provider's own test delivery (Rialit `webhook.test`): answered, nothing else. */
  | 'IGNORED_TEST'
  /**
   * Round 10 C1: an `operatorEndpoint` route with a callback IP allow-list, and a sender outside
   * it: refused before its signature or a single field of its body was read.
   */
  | 'IGNORED_SOURCE';

/**
 * What a browser return found (CentralPay), for the result page: the payment is CONFIRMED,
 * its verify was brought forward (CHECKING), it is closed or held (CLOSED), or nothing this
 * return can name (UNKNOWN). Never anything the caller could turn into money.
 */
export type BrowserReturnState = 'CONFIRMED' | 'CHECKING' | 'CLOSED' | 'UNKNOWN';

/** The state, and where the browser goes next: the tenant's bot, or nowhere known. */
export interface BrowserReturnResult {
  readonly state: BrowserReturnState;
  /** `https://t.me/<bot>` for the tenant's first active bot, or null. Never a payment link. */
  readonly botLink: string | null;
}

/** An attempt as a customer's own surface may see it. */
export interface GatewayAttemptView {
  readonly payment: PaymentRecord;
  readonly invoice: GatewayInvoiceRecord;
}

/**
 * A card-transfer attempt's own facts beside it (TonPays Telegram, §8.1): the latest card
 * change and the receipts sent to the provider — what the screen needs to say "changing
 * card", "receipt sent" or "send it again". Ids and states only; never a file.
 */
export interface GatewayCardFacts {
  readonly latestChange: GatewayCardChangeRecord | null;
  readonly submissions: readonly GatewayReceiptSubmissionRecord[];
  /** Round 6: what the provider's latest inquiry said the customer owes next, if anything. */
  readonly providerFacts?: GatewayProviderFacts | null;
  /**
   * R9 C1: the provider's rejection reasons as the customer is shown them — a reason that is
   * one of the provider's documented codes in Persian, every other one as worded. Absent: the
   * reasons as worded (`providerFacts.rejectReasons`).
   */
  readonly rejectReasonsShown?: readonly string[];
  /** Round 6: the customer's latest cancel and refund requests for this attempt. */
  readonly latestCancel?: GatewayProviderRequestRecord | null;
  readonly latestRefund?: GatewayProviderRequestRecord | null;
  /**
   * Round 6: another attempt of this customer's that is still open — the invoice that stopped
   * a new one from being made — so the screen can point at it. Null when there is none.
   */
  readonly openElsewherePaymentId?: string | null;
  /**
   * R8 A2: the owner's card-switch limits and what this payment has used of them, for the
   * card-change button; null (or absent) when they could not be read here.
   */
  readonly changeAllowance?: CardChangeAllowance | null;
}

/**
 * The external-gateway lane (WP11A, `docs/tonpays-gateway-audit.md` §5).
 *
 * It creates invoices, asks the provider what happened, and hands the provider's
 * APPROVED answer to `PaymentService.confirmGatewayPayment` — the one settlement path.
 * It owns no money rule of its own: whether an approval settles anything is decided
 * under the payment's lock over there, and every figure is the payment's own.
 *
 * ## Three rules this file exists to keep
 *
 * 1. **Only the inquiry decides.** A webhook is recorded as a hint and brings an
 *    inquiry forward; it never reaches `confirmGatewayPayment`. The adapter's pure
 *    mapping says what an inquiry means, and only `APPROVED` is ever passed on.
 * 2. **An unknown create is never retried.** Its send is stamped and committed before
 *    the call; a claim that finds the stamp was interrupted and is `CREATE_UNKNOWN`.
 *    Only the provider's own `RATE_LIMIT_EXCEEDED` clears the stamp for another try,
 *    with the same order id, bounded.
 * 3. **No call inside a transaction, and no call beyond the budget.** Each pass claims
 *    in one short transaction, calls outside any, and records in another; every call
 *    first takes the tenant's per-minute budget, shared by every replica.
 */
export class GatewayPaymentService {
  private readonly inquiryHealth: GatewayInquiryHealth;
  /** Round 6: cancels and refunds, and the cancel a new invoice makes room with. */
  private readonly providerRequestLane: GatewayProviderRequestLane | null;

  constructor(private readonly deps: GatewayPaymentServiceDeps) {
    this.inquiryHealth = deps.inquiryHealth ?? new GatewayInquiryHealth();
    const requests = deps.providerRequests;
    const cardAdapters = deps.cardAdapters;
    this.providerRequestLane =
      requests === undefined || cardAdapters === undefined
        ? null
        : new GatewayProviderRequestLane({
            requests,
            invoices: deps.invoices,
            paymentRecords: deps.paymentRecords,
            payments: deps.payments,
            cardAdapters,
            credentials: deps.credentials,
            budget: deps.budget,
            ...(deps.refundCards === undefined ? {} : { refundCards: deps.refundCards }),
            uow: deps.uow,
            audit: deps.audit,
            opsLog: deps.opsLog,
            clock: deps.clock,
            ids: deps.ids,
            logger: deps.logger,
            hooks: {
              leaseMs: () => this.leaseMs(),
              rowFitsLease: (leaseUntil) => this.rowFitsLease(leaseUntil),
              misconfigured: (scope, invoice, code) => this.misconfigured(scope, invoice, code),
              identityMismatch: (scope, invoice) =>
                this.identityMismatch(scope, invoice, 'INQUIRY'),
              refreshScreens: (scope, paymentId) => this.refreshScreens(scope, paymentId),
              rowFailed: (scope, paymentId, provider, error) =>
                this.rowFailed(scope, 'PROVIDER_REQUEST', paymentId, provider, error, () =>
                  Promise.resolve(false),
                ),
            },
          });
  }

  private rowBoundMs(): number {
    return this.deps.rowBoundMs ?? GATEWAY_ROW_BOUND_MS;
  }

  private leaseMs(): number {
    return gatewayClaimLeaseMs(this.rowBoundMs());
  }

  /** FIX10 R1: true while the claim's lease still covers one more row from now. */
  private rowFitsLease(leaseUntil: Date): boolean {
    return this.deps.clock.now().getTime() + this.rowBoundMs() <= leaseUntil.getTime();
  }

  private actor(): ActorContext {
    return systemJobActor('gateway-payments', this.deps.ids.uuid() as CorrelationId);
  }

  // ---------------------------------------------------------------------------------------
  // The worker pass.
  // ---------------------------------------------------------------------------------------

  async runOnce(scope: TenantContext): Promise<GatewayPassReport> {
    const report = {
      created: 0,
      createFailed: 0,
      createUnknown: 0,
      createDeferred: 0,
      inquired: 0,
      settled: 0,
      unsuccessful: 0,
      lateCompletions: 0,
      lateCredits: 0,
      budgetExhausted: false,
      reviewsLapsed: 0,
      cardChanges: 0,
      providerRequests: 0,
      receipts: 0,
      reviewsOpened: 0,
      held: 0,
      rowFailures: 0,
      leaseReleased: 0,
      leaseLost: 0,
      laneFailures: 0,
    };
    // A stopped tenant's rows simply wait, and nothing about them is sent anywhere.
    if (!(await this.deps.scopeActivity.scopeIsActive(scope))) return report;
    const actor = this.actor();
    /*
     * FIX10 BUG-1: every lane and every row is isolated. One row that throws — a credential
     * that cannot be decrypted, a unique violation from a concurrent bind, a deadlock — is
     * logged, backed off and counted, and the pass goes on to the rows claimed with it and to
     * every lane after it. Before this a single poisoned row threw the whole pass: the rows
     * claimed beside it were never processed, it kept the oldest `next_inquiry_at` so the
     * same batch was claimed and abandoned on every pass, and the sweeps never ran.
     */
    /*
     * FIX-06: a due inquiry a hint brought forward (a webhook, the customer's tap, a browser
     * return, a receipt acknowledgement, an operator) is asked BEFORE this pass's creations.
     * A create may take its whole 15 s timeout, five of them a pass; a customer who has just
     * paid and tapped must not wait behind them. The scheduled rows claimed with them are
     * handed straight back and asked in their usual place below. Same lane, same per-row
     * isolation and lease bound (`runInquiries`).
     */
    // A claim that threw here would throw again below: the lane is counted as failed once.
    let inquiryLaneFailed = true;
    // Each row is asked at most once a pass: one the hinted phase reached is not asked again.
    const askedThisPass = new Set<string>();
    await this.isolatedLane(scope, report, 'INQUIRY', async () => {
      await this.runInquiries(scope, actor, report, 'HINTED', askedThisPass);
      inquiryLaneFailed = false;
    });
    // FIX-06: whether the CALL budget is gone — the creations' answer, not the inquiries'.
    let callBudgetSpent = false;
    await this.isolatedLane(scope, report, 'CREATION', async () => {
      const inquiryShareSpent = report.budgetExhausted;
      report.budgetExhausted = false;
      try {
        await this.runCreations(scope, actor, report);
      } finally {
        callBudgetSpent = report.budgetExhausted;
        report.budgetExhausted ||= inquiryShareSpent;
      }
    });
    if (!report.budgetExhausted && !inquiryLaneFailed) {
      await this.isolatedLane(scope, report, 'INQUIRY', () =>
        this.runInquiries(scope, actor, report, 'ALL', askedThisPass),
      );
    }

    // TonPays Telegram: no provider call — always run, whatever the budget said.
    await this.isolatedLane(scope, report, 'REVIEW_SWEEP', async () => {
      report.reviewsLapsed = await this.loseTrackOfLapsedReviews(scope, actor);
    });
    await this.isolatedLane(scope, report, 'CAPTURE_SWEEP', () => this.sweepReceiptCaptures(scope));
    /*
     * FIX-06: gated on the CALL budget, not on the inquiries' share of it. An inquiry that met
     * its share (smaller now that a quarter is kept for hinted rows) used to stop the card and
     * receipt lanes for the pass — and, every row staying due, for the rest of the minute —
     * though their own limit had room. A receipt upload is how a TonPays Telegram approval
     * starts; it must not wait behind background inquiries. Each lane takes its own budget.
     */
    if (!callBudgetSpent) {
      await this.isolatedLane(scope, report, 'CARD_CHANGE', async () => {
        const cards = await this.runCardChanges(scope, actor, report);
        report.cardChanges = cards.done;
        callBudgetSpent = cards.budgetExhausted;
        report.budgetExhausted ||= cards.budgetExhausted;
      });
    }
    if (!callBudgetSpent) {
      await this.isolatedLane(scope, report, 'PROVIDER_REQUEST', async () => {
        const requests = await this.providerRequestLane?.run(scope, actor, report);
        report.providerRequests = requests?.done ?? 0;
        callBudgetSpent = requests?.budgetExhausted ?? false;
        report.budgetExhausted ||= requests?.budgetExhausted ?? false;
      });
    }
    if (!callBudgetSpent) {
      await this.isolatedLane(scope, report, 'RECEIPT', async () => {
        const receipts = await this.runReceipts(scope, actor, report);
        report.receipts = receipts.done;
        report.budgetExhausted ||= receipts.budgetExhausted;
      });
    }
    return report;
  }

  /** The create queue (§5.2): one claim, then each row on its own. */
  private async runCreations(
    scope: TenantContext,
    actor: ActorContext,
    report: { -readonly [K in keyof GatewayPassReport]: GatewayPassReport[K] },
  ): Promise<void> {
    const now = this.deps.clock.now();
    const creationLease = new Date(now.getTime() + this.leaseMs());
    const creating = await this.deps.uow.run(scope, (tx) =>
      this.deps.invoices.claimCreating(scope, now, this.leaseMs(), GATEWAY_CREATE_BATCH, tx),
    );
    for (const [index, claimed] of creating.entries()) {
      if (!this.rowFitsLease(creationLease)) {
        // FIX10 R1: no lease left for one more row; these go back for the next pass.
        report.leaseReleased += creating.length - index;
        await this.releaseUnreached(scope, 'CREATION', creating.slice(index), creationLease);
        break;
      }
      let result: Awaited<ReturnType<GatewayPaymentService['processCreation']>>;
      try {
        result = await this.processCreation(scope, actor, claimed, creationLease);
      } catch (error: unknown) {
        report.rowFailures += 1;
        await this.rowFailed(
          scope,
          'CREATION',
          claimed.invoice.paymentId,
          claimed.invoice.provider,
          error,
          (at) =>
            this.deps.uow.run(scope, (tx) =>
              this.deps.invoices.backOffClaim(
                scope,
                'CREATION',
                claimed.invoice.paymentId,
                creationLease,
                claimed.invoice.updatedAt,
                rowFailureRetryAt(at, claimed.invoice.createdAt),
                at,
                tx,
              ),
            ),
        );
        continue;
      }
      if (result === 'LOST') {
        report.leaseLost += 1;
        continue;
      }
      if (result === 'BUDGET') {
        report.budgetExhausted = true;
        // The deferred row cleared its own lease; the rows not reached give theirs back.
        await this.releaseUnreached(scope, 'CREATION', creating.slice(index + 1), creationLease);
        break;
      }
      await this.rowSucceeded(scope, {
        kind: 'INVOICE',
        paymentId: claimed.invoice.paymentId,
        rowFailures: claimed.invoice.rowFailures,
      });
      report[result] += 1;
      // R2: the invoice is ready, refused or unknown — the waiting message shows it now.
      if (result !== 'createDeferred') await this.refreshScreens(scope, claimed.invoice.paymentId);
    }
  }

  /**
   * The inquiry queue (§5.4): one claim, then each row on its own. `HINTED` (FIX-06) asks
   * only the claimed rows a hint brought forward and hands the others' leases straight back.
   */
  private async runInquiries(
    scope: TenantContext,
    actor: ActorContext,
    report: { -readonly [K in keyof GatewayPassReport]: GatewayPassReport[K] },
    which: 'HINTED' | 'ALL',
    /** Rows already asked this pass: never claimed for a second answer in the same pass. */
    askedThisPass: Set<string>,
  ): Promise<void> {
    const inquiryNow = this.deps.clock.now();
    const inquiryLease = new Date(inquiryNow.getTime() + this.leaseMs());
    /*
     * Codex on #277: `claimInquiries` takes the OLDEST due rows, ten of them, before anything
     * is filtered — so behind a backlog of ten scheduled rows a fresh webhook, tap or return
     * was never seen by the hinted phase, and the full phase spent its smaller share of the
     * budget on that same backlog while the hint reserve went unused. The hinted phase now
     * READS its candidates (no lease, no call), keeps the hinted ones by the same derivation
     * (`isHinted`), and claims only those, at most a batch. The outbound rate and the budgets
     * are unchanged: this changes which rows the phase asks, never how many.
     */
    const claimed =
      which === 'HINTED'
        ? await this.deps.uow.run(scope, async (tx) => {
            const candidates = await this.deps.invoices.findHintCandidates(
              scope,
              inquiryNow,
              GATEWAY_HINT_SCAN_LIMIT,
              tx,
            );
            const hinted = candidates
              .filter((row) => !askedThisPass.has(row.invoice.paymentId) && this.isHinted(row))
              .slice(0, GATEWAY_INQUIRY_BATCH)
              .map((row) => row.invoice.paymentId);
            return this.deps.invoices.claimInquiriesOf(
              scope,
              inquiryNow,
              this.leaseMs(),
              hinted,
              tx,
            );
          })
        : await this.deps.uow.run(scope, (tx) =>
            this.deps.invoices.claimInquiries(
              scope,
              inquiryNow,
              this.leaseMs(),
              GATEWAY_INQUIRY_BATCH,
              tx,
            ),
          );
    /*
     * FIX-06: `HINTED` keeps only the rows a hint brought forward; both phases skip a row the
     * pass already asked (one whose processing threw while a webhook kept it due, say — it is
     * asked again by the NEXT pass, never twice in one). The rest go straight back.
     */
    const due = claimed.filter(
      (row) => !askedThisPass.has(row.invoice.paymentId) && (which === 'ALL' || this.isHinted(row)),
    );
    await this.releaseUnreached(
      scope,
      'INQUIRY',
      claimed.filter((row) => !due.includes(row)),
      inquiryLease,
    );
    for (const [index, claimed] of due.entries()) {
      if (!this.rowFitsLease(inquiryLease)) {
        // FIX10 R1: no lease left for one more row; these go back for the next pass.
        report.leaseReleased += due.length - index;
        await this.releaseUnreached(scope, 'INQUIRY', due.slice(index), inquiryLease);
        break;
      }
      askedThisPass.add(claimed.invoice.paymentId);
      let result: Awaited<ReturnType<GatewayPaymentService['processInquiry']>>;
      try {
        result = await this.processInquiry(scope, actor, claimed, inquiryLease);
      } catch (error: unknown) {
        report.rowFailures += 1;
        const { invoice } = claimed;
        await this.rowFailed(scope, 'INQUIRY', invoice.paymentId, invoice.provider, error, (at) =>
          this.deps.uow.run(scope, (tx) =>
            this.deps.invoices.backOffClaim(
              scope,
              'INQUIRY',
              invoice.paymentId,
              inquiryLease,
              // The claim's own stamp: a row written since (a hint) keeps its earlier time.
              invoice.updatedAt,
              // Measured from the last inquiry that RECORDED something: a row failing
              // pass after pass backs off further each time, up to the cap.
              rowFailureRetryAt(
                at,
                invoice.lastInquiryAt ?? invoice.createdInvoiceAt ?? invoice.createdAt,
              ),
              at,
              tx,
            ),
          ),
        );
        continue;
      }
      if (result === 'LOST') {
        // FIX10 R1: another replica holds the row now; it records and decides, not this pass.
        report.leaseLost += 1;
        continue;
      }
      if (result === 'BUDGET') {
        report.budgetExhausted = true;
        /*
         * The row that met the empty budget was rescheduled five seconds out; it and
         * every row after it give their leases back, or each would sit leased for the
         * whole lease and miss that retry — the last inquiry before a deadline among them.
         */
        await this.releaseUnreached(scope, 'INQUIRY', due.slice(index), inquiryLease);
        break;
      }
      await this.rowSucceeded(scope, {
        kind: 'INVOICE',
        paymentId: claimed.invoice.paymentId,
        rowFailures: claimed.invoice.rowFailures,
      });
      report.inquired += 1;
      if (result === 'SETTLED') report.settled += 1;
      if (result === 'UNSUCCESSFUL') report.unsuccessful += 1;
      if (result === 'LATE') report.lateCompletions += 1;
      if (result === 'CREDITED') report.lateCredits += 1;
      if (result === 'REVIEW') report.reviewsOpened += 1;
      if (result === 'HELD') report.held += 1;
      // R2: an attempt that settled or ended is shown so on the message that shows it.
      if (
        result === 'SETTLED' ||
        result === 'UNSUCCESSFUL' ||
        result === 'LATE' ||
        // R5A item 4: a credited approval ends the attempt; its message must stop saying "unresolved".
        result === 'CREDITED' ||
        result === 'REVIEW' ||
        result === 'HELD' ||
        result === 'CHANGED'
      ) {
        await this.refreshScreens(scope, claimed.invoice.paymentId);
      }
      // R9 C1: a new next step for the customer — a new message, not only an edit.
      if (result === 'ANNOUNCE') await this.announceScreens(scope, claimed.invoice.paymentId);
      // Audit P2-b on #260: a decision closes this payment's "settlement refused" alarm.
      if (
        result === 'SETTLED' ||
        result === 'UNSUCCESSFUL' ||
        result === 'LATE' ||
        result === 'CREDITED' ||
        result === 'HELD'
      ) {
        await this.settlementDecided(scope, claimed.invoice.paymentId);
      }
    }
  }

  /**
   * One lane of the pass, isolated from the others: a lane that throws (its claim
   * transaction failed, say) is logged and counted, and the pass carries on to the next —
   * the sweeps above all, which make no provider call and must run on every pass.
   */
  private async isolatedLane(
    scope: TenantContext,
    report: { laneFailures: number },
    lane:
      | 'CREATION'
      | 'INQUIRY'
      | 'REVIEW_SWEEP'
      | 'CAPTURE_SWEEP'
      | 'CARD_CHANGE'
      | 'PROVIDER_REQUEST'
      | 'RECEIPT',
    run: () => Promise<void>,
  ): Promise<void> {
    try {
      await run();
    } catch (error: unknown) {
      // Counted apart from a row's failure: this one withholds the pass's progress.
      report.laneFailures += 1;
      this.deps.logger.error(
        { tenantId: String(scope.tenantId), lane, ...errorFacts(error) },
        'gateway payment lane failed; the pass continues with the next lane',
      );
    }
  }

  /**
   * A row whose processing threw. Logged with ids and machine codes only (never a message,
   * a payload or a key), then backed off by `backOff` — conditional on this claim's own
   * lease, so a row whose outcome already committed keeps that outcome's schedule. The
   * payment is never failed or marked unknown here: a local exception is not an answer
   * from anyone. A back-off that itself fails leaves the lease to run out, which is the
   * old behaviour for that one row and never the lane's.
   */
  private async rowFailed(
    scope: TenantContext,
    lane: 'CREATION' | 'INQUIRY' | 'CARD_CHANGE' | 'PROVIDER_REQUEST' | 'RECEIPT',
    paymentId: string,
    provider: PaymentGatewayProvider | null,
    error: unknown,
    backOff: (at: Date) => Promise<number | null | false>,
    submissionId?: string,
  ): Promise<void> {
    const at = this.deps.clock.now();
    let backedOff = false;
    // FIX10 (audit P1-b on #268): the row's durable count of consecutive thrown claims, as
    // the back-off that advanced it returned it; null when nothing was counted.
    let failures: number | null = null;
    try {
      const counted = await backOff(at);
      backedOff = counted !== false && counted !== null;
      failures = typeof counted === 'number' ? counted : null;
    } catch (backOffError: unknown) {
      this.deps.logger.error(
        { tenantId: String(scope.tenantId), lane, paymentId, ...errorFacts(backOffError) },
        'gateway payment row could not be backed off; its lease will run out',
      );
    }
    this.deps.logger.error(
      {
        tenantId: String(scope.tenantId),
        lane,
        paymentId,
        provider,
        backedOff,
        failures,
        ...errorFacts(error),
      },
      GATEWAY_ROW_FAILED_MESSAGE,
    );
    /*
     * FIX10 (audit P1-b on #268): isolating the row means nothing else reports it — it never
     * reaches a settlement, an inquiry error or a lane failure — so a row that keeps
     * throwing (possibly an approval nobody is settling) opens ONE operator condition,
     * deduplicated per row, from the durable count. Every later failure lands on the same
     * open row as an occurrence; the row's next clean pass closes it (`rowSucceeded`).
     */
    if (failures === null || failures < GATEWAY_ROW_FAILURE_ALERT_AFTER) return;
    const facts = errorFacts(error);
    await recordQuietly(
      this.deps.opsLog,
      scope,
      {
        code: GATEWAY_ROW_FAILING_CODE,
        severity: 'ERROR',
        message:
          'A payment gateway row keeps failing in the worker and is retried with a back-off. ' +
          'Nothing was decided about the payment; check the worker log for this payment id.',
        dedupeKey: gatewayRowConditionKey(
          submissionId === undefined
            ? { kind: 'INVOICE', paymentId }
            : { kind: 'RECEIPT', submissionId },
        ),
        context: {
          paymentId,
          ...(submissionId === undefined ? {} : { submissionId }),
          provider,
          lane,
          failures,
          error: facts.error,
          errorCode: facts.code === null ? null : sanitizedErrorCode(facts.code),
        },
      },
      this.deps.logger,
    );
  }

  /**
   * FIX10 (audit P1-b on #268): a row that had thrown before processed without throwing.
   * Its count goes back to zero and, when its condition is open, the condition is closed.
   * Only a row that HAD failed is written — a clean row costs nothing — and nothing here
   * can fail the lane: the row's own outcome has already committed.
   */
  private async rowSucceeded(
    scope: TenantContext,
    row:
      | { readonly kind: 'INVOICE'; readonly paymentId: PaymentId; readonly rowFailures: number }
      | {
          readonly kind: 'RECEIPT';
          readonly paymentId: PaymentId;
          readonly submissionId: string;
          readonly rowFailures: number;
        },
  ): Promise<void> {
    if (row.rowFailures === 0) return;
    const cards = this.deps.cardTransfer;
    try {
      const cleared =
        row.kind === 'INVOICE'
          ? await this.deps.uow.run(scope, (tx) =>
              this.deps.invoices.clearRowFailures(scope, row.paymentId, tx),
            )
          : cards !== undefined &&
            (await this.deps.uow.run(scope, (tx) =>
              cards.clearSubmissionFailures(scope, row.submissionId, tx),
            ));
      if (!cleared) return;
      const dedupeKey = gatewayRowConditionKey(row);
      if (!(await this.deps.conditions.conditionIsOpen(scope, dedupeKey))) return;
      await recordQuietly(
        this.deps.opsLog,
        scope,
        {
          code: GATEWAY_ROW_RECOVERED_CODE,
          severity: 'INFO',
          message: 'The payment gateway row is processed again.',
          context: {
            paymentId: row.paymentId,
            ...(row.kind === 'RECEIPT' ? { submissionId: row.submissionId } : {}),
          },
          recoversCode: GATEWAY_ROW_FAILING_CODE,
          recoversDedupeKey: dedupeKey,
        },
        this.deps.logger,
      );
    } catch (error: unknown) {
      // The count stays; the next clean pass clears it and closes the condition then.
      this.deps.logger.error(
        { tenantId: String(scope.tenantId), paymentId: row.paymentId, ...errorFacts(error) },
        'gateway payment row recovered, but its failure count could not be cleared',
      );
    }
  }

  /**
   * R2: best effort, and never the lane's failure — a Telegram edit that cannot be made
   * leaves the customer's status-check button, and must not stop the next invoice.
   */
  private async refreshScreens(scope: TenantContext, paymentId: string): Promise<void> {
    if (this.deps.invoiceScreens === undefined) return;
    try {
      await this.deps.invoiceScreens.refresh(scope, paymentId);
    } catch (error: unknown) {
      this.deps.logger.warn(
        { paymentId, error: error instanceof Error ? error.name : 'unknown' },
        'gateway invoice screen refresh failed',
      );
    }
  }

  /** R9 C1: best effort, like `refreshScreens`; a screen without `announce` is refreshed. */
  private async announceScreens(scope: TenantContext, paymentId: string): Promise<void> {
    const screens = this.deps.invoiceScreens;
    if (screens === undefined) return;
    if (screens.announce === undefined) {
      await this.refreshScreens(scope, paymentId);
      return;
    }
    try {
      await screens.announce(scope, paymentId);
    } catch (error: unknown) {
      this.deps.logger.warn(
        { paymentId, error: error instanceof Error ? error.name : 'unknown' },
        'gateway invoice next-step announcement failed',
      );
    }
  }

  private async releaseUnreached(
    scope: TenantContext,
    lane: 'CREATION' | 'INQUIRY',
    rows: readonly ClaimedGatewayInvoice[],
    leaseUntil: Date,
  ): Promise<void> {
    if (rows.length === 0) return;
    await this.deps.uow.run(scope, (tx) =>
      this.deps.invoices.releaseClaims(
        scope,
        lane,
        rows.map((row) => row.invoice.paymentId),
        leaseUntil,
        this.deps.clock.now(),
        tx,
      ),
    );
  }

  private async processCreation(
    scope: TenantContext,
    actor: ActorContext,
    claimed: ClaimedGatewayInvoice,
    /** FIX10 R1: this pass's claim on the row, which the send stamp is fenced on. */
    leaseUntil: Date,
  ): Promise<'created' | 'createFailed' | 'createUnknown' | 'createDeferred' | 'BUDGET' | 'LOST'> {
    const { invoice } = claimed;
    const now = this.deps.clock.now();

    /*
     * A row whose send was stamped and never answered: a worker died mid-call, or its
     * lease ran out. The provider may have made the invoice. UNKNOWN, never re-sent.
     */
    if (invoice.creationSentAt !== null) {
      await this.endCreation(scope, actor, invoice, 'CREATE_UNKNOWN', 'nexa.send_interrupted');
      await this.reportLinkFailure(
        scope,
        claimed,
        paymentLinkInterruptedFailure('nexa.send_interrupted'),
      );
      return 'createUnknown';
    }

    /*
     * The attempt closed before anything was sent — its deadline passed, or it was
     * withdrawn. Nothing was ever asked of the provider, so no invoice exists: a FAILED
     * creation, and the payment is left exactly as it is.
     */
    if (
      claimed.paymentState !== 'PENDING' ||
      claimed.paymentExpiresAt === null ||
      now.getTime() >= claimed.paymentExpiresAt.getTime()
    ) {
      await this.endCreation(scope, actor, invoice, 'CREATE_FAILED', 'nexa.attempt_closed');
      return 'createFailed';
    }

    const adapter = this.deps.adapters(invoice.provider);
    const apiKey = adapter === null ? null : await this.invoiceCredential(scope, invoice);
    if (adapter === null || apiKey === null) {
      await this.endCreation(scope, actor, invoice, 'CREATE_FAILED', 'nexa.credential_missing');
      await this.deps.payments.failGatewayPayment(scope, actor, invoice.paymentId, {
        reasonCode: `${invoice.provider.toLowerCase()}:nexa.credential_missing`,
        notifyCustomer: false,
      });
      await this.misconfigured(scope, invoice, 'nexa.credential_missing');
      await this.reportLinkFailure(
        scope,
        claimed,
        paymentLinkConfigurationFailure('nexa.credential_missing'),
      );
      return 'createFailed';
    }

    /*
     * Round 6 item 3: a customer who starts a new top-up while an own `pending` TonPays Telegram
     * invoice exists has that one cancelled FIRST, then the new one created. Done here, in the
     * worker, so Telegram never waits for it. A cancel that could not be sent (budget, the
     * provider's rate limit) defers the create; one the provider refused or lost does not —
     * the provider answers `BUYER_HAS_*` if it must, and the customer is shown that invoice.
     */
    if (
      this.providerRequestLane !== null &&
      PAYMENT_GATEWAY_DESCRIPTORS[invoice.provider].invoiceForm === 'CARD_TRANSFER' &&
      (await this.providerRequestLane.cancelSiblingsBeforeCreate(
        scope,
        actor,
        invoice,
        claimed.customerId,
      )) === 'DEFER'
    ) {
      await this.deps.uow.run(scope, (tx) =>
        this.deps.invoices.deferCreation(
          scope,
          invoice.paymentId,
          'nexa.budget',
          new Date(this.deps.clock.now().getTime() + 5_000),
          this.deps.clock.now(),
          tx,
        ),
      );
      return 'createDeferred';
    }

    if (!(await this.deps.budget.take(scope, invoice.provider, adapter.callBudgetPerMinute, now))) {
      // Not a failure: the next pass tries again, and the attempt's deadline still runs.
      await this.deps.uow.run(scope, (tx) =>
        this.deps.invoices.deferCreation(
          scope,
          invoice.paymentId,
          'nexa.budget',
          new Date(now.getTime() + 5_000),
          now,
          tx,
        ),
      );
      return 'BUDGET';
    }

    const customer = await this.deps.customers.findById(scope, claimed.customerId as UserId);
    // brief §10: sent when known, omitted otherwise, and never a reason to fail.
    const buyerChatId = customer?.telegramUserId ?? null;
    const descriptor = PAYMENT_GATEWAY_DESCRIPTORS[invoice.provider];
    // A Stars invoice is a message this bot sends and is paid on the bot's own webhook:
    // no callback URL, and its text from the tenant's templates.
    /*
     * A `returnToBot` route (TetraPay) is sent the BOT's start link, where the customer lands
     * after paying and is shown this payment's status read from the payment (`tp-<payment id>`);
     * its webhook URL is pasted into the provider's own panel by the operator, so it is never
     * sent. Every other inquiry route is sent the generated webhook (or return) URL.
     */
    const callbackUrl =
      descriptor.approval !== 'INQUIRY'
        ? null
        : descriptor.returnToBot
          ? tetrapayCallbackUrl(
              this.deps.botLinkFor === undefined ? null : await this.deps.botLinkFor(scope),
              invoice.paymentId,
            )
          : await this.deps.callbackUrlFor(scope, invoice.provider);
    const presentation =
      descriptor.invoiceCredential === 'BOT_TOKEN' ? await this.deps.presentation(scope) : null;
    /*
     * Round 9 C4: whether Nexa's own fee is charged on this attempt (its frozen snapshot), for
     * the owner's rule that only one side charges (Rialit). A payment that cannot be read is
     * left unknown, which the adapter reads as charged — the refusing side.
     */
    const customerFee = (await this.deps.paymentRecords.findById(scope, invoice.paymentId))
      ?.customerFee;

    /*
     * FIX10 R1: the stamp is fenced on this pass's lease, and it HOLDS the row for the row
     * bound (a provider call at its full timeout) plus a whole lease from now — so no other
     * replica can claim it, find the stamp and call a create still in flight UNKNOWN, even one
     * whose worker stalled a lease past its timeout. Only after that is an unanswered stamp
     * UNKNOWN, as before. Not stamped: the lease was taken over (or the row decided) and
     * nothing was sent.
     */
    /*
     * Codex #270: the hold is measured from a clock read NOW, not from `now` (read before the
     * credential, customer, callback and template steps above). A setup that stalled past
     * `rowBound + lease` would otherwise pass the lease-token fence (nobody reclaimed it) and
     * write a hold already expired — and the call below would start while another replica
     * could claim the row and call the live create UNKNOWN.
     */
    const stampAt = this.deps.clock.now();
    const stamped = await this.deps.uow.run(scope, (tx) =>
      this.deps.invoices.markCreationSent(
        scope,
        invoice.paymentId,
        stampAt,
        {
          claimedUntil: leaseUntil,
          holdUntil: new Date(stampAt.getTime() + this.rowBoundMs() + this.leaseMs()),
        },
        tx,
      ),
    );
    if (!stamped) return 'LOST';

    const calledAt = this.deps.clock.now();
    const outcome = await adapter.createInvoice(apiKey, {
      orderId: invoice.providerOrderId,
      amount: invoice.sentAmount,
      callbackUrl,
      buyerChatId,
      ...(customerFee === undefined
        ? {}
        : { customerFeeCharged: customerFee !== null && customerFee.fee.amountMinor > 0n }),
      presentation,
      // A `numericIdentity` route's customer number, frozen on the attempt (CentralPay).
      providerUserId: invoice.providerUserId,
      /*
       * Round 10 C1: an `operatorEndpoint` route (the custom gateway) is sent to the bridge URL
       * FROZEN on this attempt when it opened, with the attempt's own deadline. Every other
       * adapter ignores both.
       */
      ...(descriptor.operatorEndpoint
        ? { endpoint: invoice.endpointBaseUrl ?? null, expiresAt: claimed.paymentExpiresAt }
        : {}),
    });
    const at = this.deps.clock.now();
    /*
     * F3 (round N): every create leaves one line saying what the provider's answer was and
     * how long it took — the machine code the adapter classified it by, never a body, a URL
     * or the key. Before this a create that ended UNKNOWN left the operator the customer's
     * one sentence and nothing to tell a timeout from a firewall page from a changed answer.
     */
    const elapsedMs = at.getTime() - calledAt.getTime();
    /*
     * A provider whose invoice is a LINK (every one but a bot-sent Stars invoice) answered
     * "created" without one the customer can open: the invoice exists and is still asked
     * about, but it cannot be paid from Telegram. Recorded against the attempt, so the
     * operator reads it on the payment, and the customer is told exactly that.
     */
    /*
     * By the route's invoice FORM (§5.3), never by its credential: a LINK invoice with no
     * link, or a CARD invoice with no card, was created and cannot be paid from Telegram.
     */
    const card = outcome.kind === 'CREATED' ? (outcome.instructions ?? null) : null;
    const unpayableNote =
      outcome.kind !== 'CREATED'
        ? null
        : descriptor.invoiceForm === 'LINK' &&
            outcome.webInvoiceUrl === null &&
            outcome.invoiceUrl === null
          ? NO_PAYMENT_LINK_CODE
          : descriptor.invoiceForm === 'CARD_TRANSFER' && card === null
            ? NO_PAYMENT_CARD_CODE
            : null;
    const unpayable = unpayableNote !== null;
    /*
     * FIX-04: the one classification of this answer for the operations log — null when the
     * customer got a usable invoice, or when a rate limit will be asked again (a retry in
     * progress is nothing an operator can act on yet).
     */
    // Round 11 A8: a create the adapter's own limiter held was never sent, and never final.
    const heldLocally = outcome.kind === 'RATE_LIMITED' && outcome.notSent === true;
    const linkFailure = paymentLinkFailureOf(outcome, descriptor.invoiceForm, {
      rateLimitIsFinal: !heldLocally && invoice.creationAttempts + 1 >= TONPAYS_CREATE_MAX_ATTEMPTS,
    });
    const logContext = {
      paymentId: invoice.paymentId,
      provider: invoice.provider,
      outcome: outcome.kind,
      reason: outcome.kind === 'CREATED' ? unpayableNote : outcome.code,
      elapsedMs,
    };
    if (outcome.kind === 'CREATED' && !unpayable) {
      this.deps.logger.info(logContext, 'gateway invoice created');
    } else {
      this.deps.logger.warn(logContext, 'gateway invoice create produced no payable invoice');
    }

    switch (outcome.kind) {
      case 'CREATED': {
        await this.deps.uow.run(scope, async (tx) => {
          await this.deps.invoices.recordCreated(
            scope,
            invoice.paymentId,
            {
              invoiceId: outcome.invoiceId,
              invoiceUrl: outcome.invoiceUrl,
              webInvoiceUrl: outcome.webInvoiceUrl,
              status: outcome.status,
              requestAmount: outcome.requestAmount,
              finalAmount: outcome.finalAmount,
              buyerChatIdSent: buyerChatId !== null,
              callbackUrlSent: callbackUrl !== null,
              note: unpayableNote,
              // A card-transfer route's first card: current, and seq 1 of its history.
              card:
                card === null ? null : { instructions: card, policy: outcome.cardChange ?? null },
              // A provider that pushes its payments is never asked (Stars).
              firstInquiryAt:
                descriptor.approval === 'INQUIRY'
                  ? firstInquiryAt(inquiryScheduleFor(invoice.provider), at, invoice.paymentId)
                  : null,
            },
            at,
            tx,
          );
          await this.deps.paymentRecords.setExternalReference(
            scope,
            invoice.paymentId,
            outcome.invoiceId,
            at,
            tx,
          );
          await this.deps.audit.record(
            scope,
            actor,
            {
              action: 'gateway_invoice.created',
              entityType: 'Payment',
              entityId: invoice.paymentId,
              before: { creationState: 'CREATING' },
              after: {
                creationState: 'CREATED',
                provider: invoice.provider,
                providerOrderId: invoice.providerOrderId,
                providerInvoiceId: outcome.invoiceId,
                providerStatus: outcome.status,
                buyerChatIdSent: buyerChatId !== null,
                callbackUrlSent: callbackUrl !== null,
                paymentLinkReturned: !unpayable,
                // Whether a card came back — never the card itself (§7.1).
                cardReturned: card !== null,
                elapsedMs,
              },
              result: 'SUCCESS',
            },
            tx,
          );
        });
        await this.configured(scope, invoice.provider);
        if (unpayable) {
          await this.reportLinkFailure(scope, claimed, linkFailure, {
            elapsedMs,
            providerInvoiceId: outcome.invoiceId,
            telegramUserId: buyerChatId,
          });
        }
        return 'created';
      }
      case 'RATE_LIMITED': {
        /*
         * Round 11 A8: held by the adapter's own rate limiter — the request never left the
         * process, so no invoice can exist. Deferred until the limiter would let it go, the
         * stamp given back and the attempt NOT counted: Nexa's own pacing never uses up the
         * customer's retries. The same order id is sent when it is. Bounded by the attempt's
         * deadline like every deferral.
         */
        if (outcome.notSent === true) {
          await this.deps.uow.run(scope, (tx) =>
            this.deps.invoices.deferCreation(
              scope,
              invoice.paymentId,
              outcome.code,
              new Date(
                at.getTime() + Math.max(GATEWAY_HELD_RETRY_MIN_MS, outcome.retryAfterMs ?? 0),
              ),
              at,
              tx,
              { notSent: true },
            ),
          );
          return 'createDeferred';
        }
        if (invoice.creationAttempts + 1 < TONPAYS_CREATE_MAX_ATTEMPTS) {
          await this.deps.uow.run(scope, (tx) =>
            this.deps.invoices.deferCreation(
              scope,
              invoice.paymentId,
              outcome.code,
              // The provider's own `Retry-After` when it sent one (TetraPay), never sooner.
              new Date(at.getTime() + Math.max(TONPAYS_CREATE_RETRY_MS, outcome.retryAfterMs ?? 0)),
              at,
              tx,
            ),
          );
          return 'createDeferred';
        }
        await this.endCreation(scope, actor, invoice, 'CREATE_FAILED', outcome.code);
        await this.deps.payments.failGatewayPayment(scope, actor, invoice.paymentId, {
          reasonCode: `${invoice.provider.toLowerCase()}:${outcome.code}`,
          // The provider's capacity, not the customer's payment.
          notifyCustomer: false,
        });
        await this.reportLinkFailure(scope, claimed, linkFailure, {
          elapsedMs,
          telegramUserId: buyerChatId,
        });
        return 'createFailed';
      }
      case 'REFUSED': {
        /*
         * Round 6 item 3: `BUYER_HAS_PENDING_INVOICE` is a readable refusal — no invoice was
         * made — so, once, the customer's OWN pending invoice is cancelled and the same create
         * is sent again. A second such refusal, and any invoice Nexa cannot cancel, is final.
         */
        if (
          this.providerRequestLane !== null &&
          buyerConflictRetryAllowed(outcome.code, invoice.creationErrorCode) &&
          (await this.providerRequestLane.cancelOwnPendingForBuyerConflict(
            scope,
            actor,
            invoice,
            claimed.customerId,
          )) === 'RETRY'
        ) {
          await this.deps.uow.run(scope, (tx) =>
            this.deps.invoices.deferCreation(scope, invoice.paymentId, outcome.code, at, at, tx),
          );
          return 'createDeferred';
        }
        /*
         * Round 9 C4: a refusal of a payment the provider DID make (Rialit: both sides would
         * charge a fee) keeps that payment's id on the audit row, so an operator can find it at
         * the provider. Its link is never shown, so nobody can pay it.
         */
        await this.endCreation(
          scope,
          actor,
          invoice,
          'CREATE_FAILED',
          outcome.code,
          outcome.providerInvoiceId ?? null,
        );
        await this.deps.payments.failGatewayPayment(scope, actor, invoice.paymentId, {
          reasonCode: `${invoice.provider.toLowerCase()}:${outcome.code}`,
          // A buyer who already holds an invoice is shown THAT invoice on the edited screen.
          notifyCustomer: !outcome.configuration && !isBuyerConflictCode(outcome.code),
        });
        if (outcome.routeEffect === 'HIDE_UNTIL_TEHRAN_MIDNIGHT') {
          await this.hideRouteUntilTehranMidnight(scope, actor, invoice, outcome.code);
        }
        if (outcome.configuration) await this.misconfigured(scope, invoice, outcome.code);
        await this.reportLinkFailure(scope, claimed, linkFailure, {
          elapsedMs,
          telegramUserId: buyerChatId,
        });
        return 'createFailed';
      }
      case 'AMBIGUOUS':
      case 'UNKNOWN': {
        await this.endCreation(scope, actor, invoice, 'CREATE_UNKNOWN', outcome.code);
        // FIX-04: `GATEWAY_CREATE_UNKNOWN_CODE`, per payment as before, now with the facts an
        // operator needs — built by the one mapping every create failure goes through.
        await this.reportLinkFailure(scope, claimed, linkFailure, {
          elapsedMs,
          telegramUserId: buyerChatId,
        });
        return 'createUnknown';
      }
    }
  }

  private async processInquiry(
    scope: TenantContext,
    actor: ActorContext,
    claimed: ClaimedGatewayInvoice,
    /**
     * FIX10 R1: this pass's claim. Every record of an answer is fenced on it, so a replica
     * whose lease ran out (and whose row another replica took) never overwrites the newer
     * evidence with its older answer, and acts on nothing it could not record.
     */
    leaseUntil: Date,
  ): Promise<
    | 'OPEN'
    /** Round 6: still open, but what the customer should do next changed — redraw the screen. */
    | 'CHANGED'
    /** R9 C1: still open, and the customer now owes a next step — tell them in a new message. */
    | 'ANNOUNCE'
    | 'SETTLED'
    | 'UNSUCCESSFUL'
    | 'LATE'
    | 'CREDITED'
    | 'ERROR'
    | 'BUDGET'
    | 'REVIEW'
    | 'HELD'
    | 'LOST'
  > {
    const { invoice } = claimed;
    const now = this.deps.clock.now();
    const invoiceId = invoice.providerInvoiceId ?? invoice.hintedInvoiceId;
    /*
     * The EFFECTIVE deadline (§9.6.3 d): the review deadline once acknowledged, `expires_at`
     * otherwise. Advisory here — `confirmGatewayPayment` decides under the payment's lock.
     * As of the CLAIM until the provider has answered; re-read then (FIX10 BUG-2, below).
     */
    let paymentState = claimed.paymentState;
    let reviewUntil = claimed.paymentReviewUntil;
    let expiresAt = gatewaySettlementDeadline({
      expiresAt: claimed.paymentExpiresAt,
      providerReviewUntil: reviewUntil,
    });
    let eligible =
      paymentState === 'PENDING' && expiresAt !== null && now.getTime() < expiresAt.getTime();
    /*
     * R12 F1: an attempt Nexa CANCELLED (its order paid from the wallet or withdrawn) is still
     * payable at the provider until its own deadline, so it is asked about on the ordinary
     * schedule until then — never settled (`eligible` stays false), and money it reports is
     * returned to the wallet by the credit path. Whatever the late-credit switch says.
     */
    let cancelledOpen = cancelledAttemptPollingOpen({
      state: paymentState,
      now,
      deadline: expiresAt,
    });
    let postDeadline = !eligible && !cancelledOpen;
    // An operator's "ask again" on an UNKNOWN payment lets ONE inquiry past the bound.
    const operatorAsked = invoice.reconcileInquiryRequestedAt !== null;
    /*
     * Codex #269: an approval was recorded on this row and no decision about it committed
     * (neither an outcome nor a late completion) — its settlement or its late completion
     * failed after the answer was recorded. Such a row is retried past the ordinary
     * post-deadline bound, up to `GATEWAY_DECISION_RETRY_MAX` more.
     */
    const approvalUndecided =
      invoice.providerPaid === true &&
      invoice.outcome === null &&
      invoice.lateCompletionObservedAt === null;
    const postDeadlineBound =
      POST_DEADLINE_INQUIRY_MAX + (approvalUndecided ? GATEWAY_DECISION_RETRY_MAX : 0);
    /*
     * R5A item 4: with the route's late-credit switch ON, a closed payment's open invoice keeps
     * being asked about, slowly, until the window ends — so the ordinary post-deadline bound
     * does not stop it while that window is open. Off (or not wired), nothing below differs
     * from before this existed.
     */
    const lateCredit = await this.lateCreditPolicy(scope, invoice.provider);
    const lateWindowOpen =
      postDeadline &&
      lateCredit.enabled &&
      invoice.outcome === null &&
      lateCreditPollingOpen({
        state: paymentState,
        now,
        deadline: expiresAt,
        windowMs: lateCredit.windowMs,
      });

    /*
     * A provider that PUSHES its payments (Stars) is never asked. Its row is due only
     * because a payment was recorded on it, and the recorded charge IS the approval —
     * written under the row's lock after every identity check (`StarsPaymentService`).
     * No call, no budget: this is the settlement the webhook's own attempt did not finish.
     */
    if (PAYMENT_GATEWAY_DESCRIPTORS[invoice.provider].approval === 'RECORDED_PAYMENT') {
      return this.settleRecordedClaim(scope, actor, invoice, eligible, expiresAt, leaseUntil);
    }

    const adapter = this.deps.adapters(invoice.provider);
    /*
     * What the inquiry is authorised by, by the route's descriptor: the API key, or a SEPARATE
     * verify key (CentralPay — never assumed to be the same credential). Never logged.
     */
    const apiKey =
      adapter === null
        ? null
        : PAYMENT_GATEWAY_DESCRIPTORS[invoice.provider].verifyKey
          ? await this.deps.credentials.readVerifyKey(scope, invoice.provider)
          : await this.deps.credentials.read(scope, invoice.provider);
    /*
     * Round 10 C1: an `inquiresByOrderId` route (the custom gateway) whose create's answer was
     * lost — no reference, no verified hint — is READ by Nexa's own order id instead of being
     * left unasked. Never re-sent: this is the inquiry, and only its signed answer naming this
     * attempt's order id hands the reference over (adopted below). Off for every other route.
     */
    const byOrderId =
      invoiceId === null &&
      invoice.creationState === 'CREATE_UNKNOWN' &&
      PAYMENT_GATEWAY_DESCRIPTORS[invoice.provider].inquiresByOrderId;
    if (
      (invoiceId === null && !byOrderId) ||
      adapter === null ||
      apiKey === null ||
      (postDeadline &&
        invoice.postDeadlineInquiries >= postDeadlineBound &&
        !operatorAsked &&
        !lateWindowOpen)
    ) {
      // Nothing that could be asked, or nothing more to ask. Stop scheduling.
      const kept = await this.deps.uow.run(scope, (tx) =>
        this.deps.invoices.recordInquiry(
          scope,
          invoice.paymentId,
          {
            status: null,
            paid: null,
            requestAmount: null,
            finalAmount: null,
            errorCode: apiKey === null ? 'nexa.credential_missing' : 'nexa.nothing_to_ask',
            adoptInvoiceId: null,
            nextInquiryAt: null,
            postDeadline: false,
            claimedUntil: leaseUntil,
          },
          now,
          tx,
        ),
      );
      if (!kept) return 'LOST';
      /*
       * FIX-03 (batch 2026-10-10): a route whose key went missing while an attempt was open
       * cannot ask about it, and an approval it cannot read is a customer who paid and is
       * not credited. The create path already opens `payments.gateway_misconfigured` for a
       * missing key; the inquiry now says the same, after its own write committed.
       */
      if (adapter !== null && apiKey === null) {
        await this.inquiryMisconfigured(scope, invoice.provider, 'nexa.credential_missing');
      }
      return 'ERROR';
    }

    /*
     * FIX-06: a scheduled inquiry may not take the top quarter of the provider's inquiry
     * budget; a hinted one may. The budget itself is the provider's, unchanged.
     */
    const scheduledLimit =
      adapter.inquiryBudgetPerMinute - hintReservePerMinute(adapter.inquiryBudgetPerMinute);
    /*
     * R5A item 4: a late poll is the LOWEST priority question this lane asks — nobody is waiting
     * on it — so it may use at most half of the scheduled share of the minute. The rows a
     * customer is waiting behind keep the rest, and the provider's total is unchanged.
     */
    const inquiryLimit = this.isHinted(claimed)
      ? adapter.inquiryBudgetPerMinute
      : lateWindowOpen
        ? Math.max(1, Math.floor(scheduledLimit / 2))
        : scheduledLimit;
    if (!(await this.deps.budget.take(scope, invoice.provider, inquiryLimit, now))) {
      await this.deps.uow.run(scope, (tx) =>
        this.deps.invoices.requestInquiry(
          scope,
          invoice.paymentId,
          new Date(now.getTime() + 5_000),
          tx,
        ),
      );
      return 'BUDGET';
    }

    // The clock BEFORE the call: what an answer can say anything about (F11).
    const sentAt = this.deps.clock.now();
    /*
     * What the adapter's pure mapping needs beside the invoice id: OUR order id, the amount
     * Nexa sent (an approval for another figure is a MISMATCH, never a settlement), and the
     * payment a verified webhook last named (NOWPayments).
     */
    const outcome = await adapter.inquire(apiKey, invoiceId ?? invoice.providerOrderId, {
      providerOrderId: invoice.providerOrderId,
      sentAmount: invoice.sentAmount,
      hintedPaymentId: invoice.hintedPaymentId,
      // CentralPay: the customer's number as SENT — a verify naming another never approves.
      providerUserId: invoice.providerUserId,
      // Round 10 C1: the bridge THIS attempt was created against, whatever the route says now.
      ...(PAYMENT_GATEWAY_DESCRIPTORS[invoice.provider].operatorEndpoint
        ? { endpoint: invoice.endpointBaseUrl ?? null, byOrderId }
        : {}),
    });
    const at = this.deps.clock.now();
    /*
     * FIX10 BUG-2: the claim's view of the payment is as old as the claim, and a batch can
     * reach a row many provider calls later. A receipt acknowledged in between opens a 24-hour
     * review; judged from the claim, the approval that follows looked post-deadline and was
     * recorded LATE_COMPLETION, unscheduled and never asked again. So the payment is re-read
     * now, after the answer: the schedule, the post-deadline bound and every branch below use
     * what it is NOW. Still advisory — the settlement path decides under the payment's lock.
     */
    const current = await this.deps.paymentRecords.findById(scope, invoice.paymentId);
    if (current !== null) {
      paymentState = current.state;
      reviewUntil = current.providerReviewUntil;
      expiresAt = gatewaySettlementDeadline(current);
      eligible =
        paymentState === 'PENDING' && expiresAt !== null && at.getTime() < expiresAt.getTime();
      cancelledOpen = cancelledAttemptPollingOpen({
        state: paymentState,
        now: at,
        deadline: expiresAt,
      });
      postDeadline = !eligible && !cancelledOpen;
    }
    const next = postDeadline
      ? null
      : reviewUntil !== null
        ? // In review (§9.6.5): the review cadence, ending fifteen seconds before its deadline.
          reviewInquiryNextAt(
            new Date(reviewUntil.getTime() - TONPAYS_TELEGRAM_REVIEW_WINDOW_MS),
            reviewUntil,
            at,
            (ms) => jitteredMs(ms, invoice.paymentId, invoice.inquiryAttempts + 1),
          )
        : this.nextInquiryAt(invoice, at, expiresAt);
    /*
     * R5A item 4: where the normal schedule ends (the deadline), the slow late poll begins and
     * continues — 5 minutes, then 15, then hourly — until the window closes. Only for an
     * undecided invoice of a payment that is not closed for good, and only while the route's
     * switch is on; the first one is scheduled by the last inquiry inside the deadline.
     */
    const lateNext =
      lateCredit.enabled && invoice.outcome === null && expiresAt !== null
        ? lateCreditPollAt({
            at,
            paymentId: invoice.paymentId,
            step: invoice.postDeadlineInquiries + (postDeadline ? 1 : 0),
            deadline: expiresAt,
            windowMs: lateCredit.windowMs,
          })
        : null;
    const lateNextAllowed =
      paymentState === 'CONFIRMED' || paymentState === 'FAILED' || paymentState === 'CANCELLED'
        ? null
        : lateNext;

    if (outcome.kind !== 'OBSERVED') {
      /*
       * Round 11 A8: a rate limit only DELAYS. It never changes the attempt: no state, no
       * deadline moved, no post-deadline allowance spent and an operator's request left
       * standing (`rateLimited` below).
       *
       * - Provider 429: not before the later of 60 s and what the limiter now pauses the key for
       *   (the provider's `Retry-After`, else the back-off, which grows with each consecutive
       *   429), and never sooner than the row's own next step.
       * - Held by the adapter's own limiter (`notSent`): nothing was asked, so the row is due
       *   again as soon as the limiter would let it go — not a whole step later.
       *
       * `notBefore` binds every path that could ask again (a tap, a webhook, the worker).
       */
      const rateLimitedForMs =
        outcome.kind !== 'RATE_LIMITED'
          ? null
          : outcome.notSent === true
            ? Math.max(GATEWAY_HELD_RETRY_MIN_MS, outcome.retryAfterMs ?? 0)
            : Math.max(INQUIRY_RATE_LIMIT_RETRY_MS, outcome.retryAfterMs ?? 0);
      const notBefore =
        rateLimitedForMs === null ? null : new Date(at.getTime() + rateLimitedForMs);
      const retry =
        notBefore === null || next === null
          ? next
          : outcome.kind === 'RATE_LIMITED' && outcome.notSent === true
            ? notBefore
            : new Date(Math.max(next.getTime(), notBefore.getTime()));
      /*
       * `next` is always inside the deadline (its last step is fifteen seconds before it), so a
       * rate limit moves the row past the deadline only when the provider's own pause runs past
       * it — then nothing can be asked before it anyway, and the late poll takes over.
       */
      const scheduled = retry !== null && expiresAt !== null && retry >= expiresAt ? null : retry;
      /*
       * Codex on #277 (#269): an approval already recorded on this row whose decision never
       * committed is asked again so that its decision can be made — and past the deadline
       * `next` is null. A retry that met a timeout, a 429, a configuration refusal or any
       * other non-answer then cleared the schedule, leaving a provider-paid attempt with
       * neither a settlement nor a LATE_COMPLETION for ever. So such a row stays scheduled
       * through a non-answer. This is NOT an approval: the error is recorded as an error,
       * the recorded approval is the earlier inquiry's, and only a later inquiry's answer
       * leads to a decision. Bounded by the same allowance: this inquiry is counted as a
       * post-deadline one, and the bound above stops the row at
       * `POST_DEADLINE_INQUIRY_MAX + GATEWAY_DECISION_RETRY_MAX`.
       */
      const nextInquiryAt =
        scheduled !== null
          ? scheduled
          : // Round 11 A8: an operator's "ask again" that met a rate limit is asked once allowed.
            operatorAsked && notBefore !== null
            ? notBefore
            : approvalUndecided
              ? new Date(
                  Math.max(at.getTime() + RECORDED_OUTCOME_RETRY_MS, notBefore?.getTime() ?? 0),
                )
              : lateNextAllowed;
      const kept = await this.deps.uow.run(scope, (tx) =>
        this.deps.invoices.recordInquiry(
          scope,
          invoice.paymentId,
          {
            status: null,
            paid: null,
            requestAmount: null,
            finalAmount: null,
            // Recorded as the provider said it. INVOICE_NOT_FOUND is neither paid nor
            // failed: the attempt's own state stands, and the deadline still decides.
            errorCode: outcome.code,
            adoptInvoiceId: null,
            nextInquiryAt,
            postDeadline,
            // A provider's Retry-After binds EVERY path that could ask again (customer check,
            // webhook hint, the worker), not only this row's next scheduled time. Round 11 A8:
            // so does Nexa's own back-off when the provider sent none.
            ...(notBefore === null ? {} : { notBefore }),
            rateLimited: outcome.kind === 'RATE_LIMITED',
            claimedUntil: leaseUntil,
          },
          at,
          tx,
        ),
      );
      if (!kept) return 'LOST';
      if (outcome.kind === 'CONFIGURATION') {
        await this.inquiryMisconfigured(scope, invoice.provider, outcome.code);
      }
      // Round 11 A8: a call Nexa's own limiter held never reached the provider, so it says
      // nothing about whether the provider answers; the 429 that caused a pause was counted.
      if (
        outcome.kind === 'FAILED' ||
        (outcome.kind === 'RATE_LIMITED' && outcome.notSent !== true)
      ) {
        await this.inquiryFailed(scope, invoice.provider, outcome.kind, outcome.code, at);
      }
      return 'ERROR';
    }
    // The provider answered: whatever the answer says, its check endpoint is working.
    await this.inquiryAnswered(scope, invoice.provider, at);

    /*
     * An answer about ANOTHER invoice or another order is not an answer about this
     * attempt, whatever it says. It is recorded and never acted on.
     */
    /*
     * Asked by order id (Round 10 C1), the answer's own reference is not known to Nexa: what
     * identifies it is this attempt's order id, which must match exactly like every other.
     */
    const otherOrder = outcome.orderId !== invoice.providerOrderId;
    const identityMismatch = otherOrder || (byOrderId ? false : outcome.invoiceId !== invoiceId);
    /*
     * Codex on #336 (1): a custom bridge's answer is SIGNED over this request's nonce
     * (`docs/protocols/custom-gateway.md` §5), so it is the bridge's own word about the
     * attempt Nexa asked about — and one that reports money captured (its verdict a MISMATCH
     * or an approval) under another invoice id or reference must not be ignored: ignored, the
     * payment stayed PENDING to expire and the customer could pay again. It is HELD like every
     * other mismatch — never settled (the verdict is forced to MISMATCH), never failed, and
     * nothing in it is adopted or bound. A status that reports no money (PENDING, a FAILED with
     * nothing paid) still takes the ignored path below: an answer naming another payment never
     * fails this one.
     */
    const heldIdentity =
      identityMismatch &&
      invoice.provider === 'CUSTOM' &&
      (outcome.verdict === 'MISMATCH' || outcome.verdict === 'APPROVED');
    if (identityMismatch && !heldIdentity) {
      const kept = await this.deps.uow.run(scope, (tx) =>
        this.deps.invoices.recordInquiry(
          scope,
          invoice.paymentId,
          {
            status: null,
            paid: null,
            requestAmount: null,
            finalAmount: null,
            errorCode: 'nexa.identity_mismatch',
            adoptInvoiceId: null,
            nextInquiryAt: null,
            postDeadline,
            claimedUntil: leaseUntil,
          },
          at,
          tx,
        ),
      );
      if (!kept) return 'LOST';
      await this.identityMismatch(scope, invoice, 'INQUIRY');
      return 'ERROR';
    }

    /*
     * CentralPay (`docs/centralpay-gateway-audit.md` §5.4): the provider's reference for the
     * money is bound to THIS attempt, write-once, in the transaction that records the answer —
     * BEFORE anything can settle. A reference another payment already holds (or a second
     * reference for this one) turns the answer into a MISMATCH: never settled, recorded unpaid,
     * the payment held for an operator. A repeated verify of a settled payment never gets
     * here: its outcome is recorded and nothing more is asked.
     */
    let verdict = heldIdentity ? 'MISMATCH' : outcome.verdict;
    let mismatchReason = heldIdentity
      ? otherOrder
        ? 'PROVIDER_ORDER_ID_MISMATCH'
        : 'PROVIDER_REFERENCE_MISMATCH'
      : (outcome.mismatchReason ?? null);
    const reference = heldIdentity ? null : (outcome.providerReference ?? null);
    let screenChanged = false;
    /** R9 C1: the next step the provider newly asks the customer for, if this answer is one. */
    let announced: 'LESS' | 'MORE' | null = null;
    const kept = await this.deps.uow.run(scope, async (tx) => {
      /*
       * FIX10 R1: first, that the claim is still this pass's — locked, so it cannot change
       * before this transaction commits. Not ours: nothing is written, not a bound reference,
       * not a resolved upload, not the answer; the replica that holds the row decides.
       */
      if (!(await this.deps.invoices.holdsInquiryClaim(scope, invoice.paymentId, leaseUntil, tx))) {
        return false;
      }
      if (reference !== null && (verdict === 'APPROVED' || verdict === 'MISMATCH')) {
        const bound = await this.deps.invoices.bindProviderReference(
          scope,
          invoice.paymentId,
          invoice.provider,
          reference,
          at,
          tx,
        );
        if (bound !== 'BOUND') {
          verdict = 'MISMATCH';
          mismatchReason = 'PROVIDER_REFERENCE_REUSED';
        }
      }
      /*
       * TonPays Telegram (§9.1): an answer about THIS attempt resolves a lost receipt upload
       * FOR DISPLAY — a later `pending` lets the customer send a different photo — and never
       * opens a review: only the upload answer's own acknowledgement does.
       */
      if (this.deps.cardTransfer !== undefined) {
        // `sentAt`: taken before the call, so earlier than the request ever left (F11).
        await this.deps.cardTransfer.resolveUnknownSubmissions(
          scope,
          invoice.paymentId,
          sentAt,
          at,
          tx,
        );
      }
      await this.deps.invoices.recordInquiry(
        scope,
        invoice.paymentId,
        {
          status: outcome.status,
          // Paid only while the verdict is still an approval (a reused reference is not).
          paid: verdict === 'APPROVED' ? outcome.paid : outcome.paid === null ? null : false,
          requestAmount: outcome.requestAmount,
          finalAmount: outcome.finalAmount,
          errorCode: null,
          // A webhook's hinted id for a lost create, now VERIFIED by the provider's own
          // order id: adopted. Nothing else is ever adopted.
          // Round 10 C1: asked by order id, the reference the signed answer named is adopted.
          // Never from an answer that named another payment (Codex on #336).
          adoptInvoiceId:
            invoice.providerInvoiceId === null && !heldIdentity
              ? (invoiceId ?? outcome.invoiceId)
              : null,
          /*
           * A terminal verdict keeps the next inquiry scheduled until its outcome is
           * recorded — `recordOutcome` is what clears it. A crash, or a failed transaction,
           * between here and the settlement or the failure is then retried rather than
           * lost: an UNSUCCESSFUL row unscheduled here would leave its payment PENDING and
           * its rejected invoice handed back as the open attempt. The retry is harmless:
           * the settlement is exactly-once, and a payment already failed is no longer
           * eligible, so the retry only records the outcome.
           */
          /*
           * Codex #269: and a verdict whose DECISION follows this transaction keeps a retry
           * even where no further inquiry would be scheduled (past the deadline, or past the
           * last slot before it). The decision — the settlement path's answer under the
           * payment's lock, or the late completion — is what clears it. Unscheduled here, a
           * decision that then failed (the tenant stopped between the pass's check and the
           * settlement's transaction, a transient database error) stranded a provider-paid
           * attempt with no settlement, no LATE_COMPLETION, no audit and no alert.
           */
          nextInquiryAt:
            next ??
            (verdict === 'APPROVED' ||
            (verdict === 'MISMATCH' && !eligible && paymentState !== 'UNKNOWN')
              ? new Date(at.getTime() + RECORDED_OUTCOME_RETRY_MS)
              : lateNextAllowed),
          postDeadline,
          // The payment this identity-checked answer described (NOWPayments): followed next.
          hintedPaymentId: outcome.providerPaymentId ?? null,
          crypto: outcome.crypto ?? null,
          method: outcome.method ?? null,
          // Unfenced: the claim was checked and locked at the top of this transaction.
        },
        at,
        tx,
      );
      /*
       * Round 6: what the customer owes next (a remainder, a refund card) and any rejection
       * reasons, from the same answer — metadata for the screen and the history. They never
       * reach the verdict above. The reasons are written to the payment's audit once, when
       * they first appear or change, not once per inquiry.
       */
      if (this.deps.providerRequests !== undefined && outcome.facts !== undefined) {
        const recorded = await this.deps.providerRequests.recordFacts(
          scope,
          invoice.paymentId,
          outcome.facts,
          at,
          tx,
        );
        // The status moved to or from a next step too (a remainder with no usable details).
        screenChanged = recorded.changed || invoice.providerStatus !== outcome.status;
        /*
         * R9 C1: a NEW ask — the provider moved to a next step it had not named, or named a new
         * remainder invoice (the remainder itself fell short). Once per ask, decided under the
         * facts row's lock and this pass's claim, so a repeated inquiry, a second replica or a
         * repeated webhook never asks twice. The operations log hears of it in THIS transaction
         * (its own headline, never a failure); the customer is told after it commits. Nothing
         * here settles, fails or credits: the verdict above is the inquiry's, and it is OPEN.
         */
        const need = outcome.facts?.need ?? null;
        const newAsk =
          need !== null &&
          (recorded.needBefore !== need ||
            (need === 'LESS' &&
              outcome.facts?.remainingInvoiceId != null &&
              recorded.remainingInvoiceIdBefore !== outcome.facts.remainingInvoiceId));
        // A stopped scope's ask is recorded (the facts row) but raises nothing new.
        if (
          newAsk &&
          current !== null &&
          (await this.deps.scopeActivity.scopeIsActive(scope, tx))
        ) {
          /*
           * R12 F1: a CANCELLED attempt is still asked about until its deadline, and an ask
           * the provider makes of it reaches the operations log — but the customer is never
           * sent a new message asking them to pay more on an attempt Nexa withdrew.
           */
          if (paymentState !== 'CANCELLED') announced = need;
          await this.deps.outbox.write(tx, actor, {
            eventType: 'GatewayPaymentAttentionRaised',
            aggregateType: 'Payment',
            aggregateId: invoice.paymentId,
            payload: {
              customerId: current.customerId,
              orderId: current.orderId,
              provider: invoice.provider,
              reason: need === 'LESS' ? 'UNDERPAID' : 'OVERPAID',
            },
          });
        }
        if (recorded.reasonsChanged && outcome.facts !== null) {
          await this.deps.audit.record(
            scope,
            actor,
            {
              action: PROVIDER_REJECTION_REASONS_ACTION,
              entityType: 'Payment',
              entityId: invoice.paymentId,
              before: null,
              after: { providerStatus: outcome.status, reasons: [...outcome.facts.rejectReasons] },
              result: 'SUCCESS',
            },
            tx,
          );
        }
      }
      return true;
    });
    if (!kept) return 'LOST';

    if (verdict === 'OPEN') {
      /*
       * NOWPayments (§5.4): the provider's own read says the customer's coins are on their
       * way. On a route that reviews, inside the customer window and with no review yet, that
       * opens the bounded review window — decided again under the payment's lock, strictly
       * before its deadline. It approves nothing.
       */
      if (
        outcome.fundsDetected === true &&
        eligible &&
        reviewUntil === null &&
        PAYMENT_GATEWAY_DESCRIPTORS[invoice.provider].providerReview
      ) {
        try {
          const opened = await this.deps.payments.recordProviderFundsDetected(
            scope,
            actor,
            invoice.paymentId,
            { detectedAt: at, providerStatus: outcome.status },
          );
          if (opened) return 'REVIEW';
        } catch (error: unknown) {
          // Nothing was written; the next inquiry asks again inside the deadline.
          this.deps.logger.error(
            {
              paymentId: invoice.paymentId,
              error: error instanceof Error ? error.name : 'unknown',
            },
            'a provider funds-detected report could not be recorded',
          );
        }
      }
      if (announced !== null) return 'ANNOUNCE';
      return screenChanged ? 'CHANGED' : 'OPEN';
    }

    if (verdict === 'MISMATCH') {
      /*
       * Money the provider holds that is not what this attempt invoiced (§5.5): never
       * settled and never failed. Inside the deadline the payment goes to UNKNOWN for an
       * operator; a payment already UNKNOWN stays as it is; one already closed records the
       * money as a late completion — nothing moves either way.
       */
      const reason = mismatchReason ?? 'PROVIDER_AMOUNT_MISMATCH';
      if (eligible) {
        return (await this.holdMismatch(scope, actor, invoice, outcome.status, reason))
          ? 'HELD'
          : 'ERROR';
      }
      if (paymentState !== 'UNKNOWN') {
        await this.lateCompletion(scope, actor, invoice, reason);
        return 'LATE';
      }
      return 'OPEN';
    }

    if (verdict === 'UNSUCCESSFUL') {
      if (eligible) {
        await this.deps.payments.failGatewayPayment(scope, actor, invoice.paymentId, {
          reasonCode: `${invoice.provider.toLowerCase()}:${outcome.status}`,
          notifyCustomer: true,
          // Round 6: the provider's own reasons go into the payment's audit with the failure.
          providerReasons: outcome.facts?.rejectReasons ?? [],
        });
      }
      await this.deps.invoices.recordOutcome(scope, invoice.paymentId, 'UNSUCCESSFUL', at);
      return 'UNSUCCESSFUL';
    }

    // APPROVED, by the inquiry. The settlement path decides whether it counts.
    return this.settleApproved(
      scope,
      actor,
      invoice,
      `${invoice.provider.toLowerCase()}:${outcome.status}:paid`,
      at,
      reference,
      {
        trigger: this.discoveryTriggerOf(
          claimed,
          expiresAt,
          await this.receiptEndedAt(scope, invoice),
        ),
        dueAt: invoice.nextInquiryAt,
      },
      // What the late-credit decision compares: the provider's echo of the amount Nexa sent.
      { providerRequestAmount: outcome.requestAmount },
    );
  }

  /**
   * What made a due row due (`domain/inquiry-discovery.ts`): logged beside a settlement as
   * FIX-01 evidence, and read by `isHinted` (FIX-06) to decide only WHEN a row is asked and
   * from which share of the budget — never what its answer means.
   */
  private discoveryTriggerOf(
    claimed: ClaimedGatewayInvoice,
    expiresAt: Date | null,
    receiptEndedAt: Date | null = null,
  ): InquiryDiscoveryTrigger {
    const { invoice } = claimed;
    const reviewUntil = claimed.paymentReviewUntil;
    const reviewStartedAt =
      reviewUntil === null
        ? null
        : new Date(reviewUntil.getTime() - TONPAYS_TELEGRAM_REVIEW_WINDOW_MS);
    const normal = this.scheduledInquiryAt(invoice, reviewUntil, reviewStartedAt, expiresAt);
    /*
     * Codex #265 (4): after an answer that was an error, the row may have been a rate limit,
     * which waits the later of the normal step and the floor. Both are times the schedule
     * alone could have put it; a hint between them is still a hint.
     */
    const afterRateLimit =
      invoice.lastInquiryErrorCode !== null && invoice.lastInquiryAt !== null
        ? new Date(invoice.lastInquiryAt.getTime() + INQUIRY_RATE_LIMIT_RETRY_MS)
        : null;
    return inquiryDiscoveryTrigger({
      dueAt: invoice.nextInquiryAt,
      scheduledAt: [normal, afterRateLimit].filter((at): at is Date => at !== null),
      lastInquiryAt: invoice.lastInquiryAt,
      lastWebhookAt: invoice.lastWebhookAt,
      operatorRequestedAt: invoice.reconcileInquiryRequestedAt,
      reviewStartedAt,
      receiptEndedAt,
    });
  }

  /**
   * Codex #265 (3): when this card-transfer attempt's latest receipt upload ENDED — accepted or
   * its answer lost — since either brings the next inquiry forward without opening a review.
   * Evidence only; read once, for an approval about to be settled. Null for any other route.
   */
  private async receiptEndedAt(
    scope: TenantContext,
    invoice: GatewayInvoiceRecord,
  ): Promise<Date | null> {
    if (
      this.deps.cardTransfer === undefined ||
      PAYMENT_GATEWAY_DESCRIPTORS[invoice.provider].invoiceForm !== 'CARD_TRANSFER'
    ) {
      return null;
    }
    try {
      const submissions = await this.deps.cardTransfer.submissionsFor(scope, invoice.paymentId);
      const ended = submissions
        .filter((one) => one.state === 'ACCEPTED' || one.state === 'UNKNOWN')
        .map((one) => one.decidedAt?.getTime() ?? null)
        .filter((at): at is number => at !== null);
      return ended.length === 0 ? null : new Date(Math.max(...ended));
    } catch {
      return null;
    }
  }

  /**
   * An approval, handed to the one settlement path. Shared by the inquiry (TonPays) and a
   * recorded payment (Stars), so both are decided by the same lock, the same deadline and
   * the same exactly-once transition — and a late one is recorded the same way.
   */
  private async settleApproved(
    scope: TenantContext,
    actor: ActorContext,
    invoice: GatewayInvoiceRecord,
    evidenceNote: string,
    at: Date,
    /** The provider reference bound to this attempt (CentralPay), re-checked under the lock. */
    providerReference: string | null = null,
    /** FIX-01 evidence: why the approval was seen now, and when its row fell due. */
    discovery: { readonly trigger: GatewayDiscoveryTrigger; readonly dueAt: Date | null } = {
      trigger: 'SCHEDULED',
      dueAt: invoice.nextInquiryAt,
    },
    /**
     * R5A item 4: set only by the INQUIRY path, whose answer re-verified the approval. A late
     * approval is offered to the wallet credit with it; a recorded payment (Stars) passes none
     * and is never credited this way.
     */
    lateCreditInput: { readonly providerRequestAmount: bigint | null } | null = null,
  ): Promise<'SETTLED' | 'LATE' | 'CREDITED' | 'ERROR' | 'HELD'> {
    /*
     * FIX10 BUG-2: EVERY approval goes to the settlement path, whatever the caller's snapshot
     * said about eligibility. Only its answer, taken under the payment's lock, decides whether
     * the approval is late — a snapshot is as old as the read behind it, and a review that
     * opened after it moved the deadline. (FIX-03's case is the same rule: a payment this
     * lane already settled answers `ALREADY_CONFIRMED` and is never a late completion.) A
     * NOT_ELIGIBLE answer is recorded as LATE_COMPLETION with the lock's own reason.
     */
    let confirmation: GatewayConfirmation;
    try {
      confirmation = await this.deps.payments.confirmGatewayPayment(
        scope,
        actor,
        invoice.paymentId,
        { evidenceNote, providerReference },
      );
    } catch (error) {
      /*
       * The settlement refused for a reason of its own (the scope stopped, the currency
       * changed under the payment). Nothing moved; the inquiry stays scheduled, so it is
       * asked again inside the deadline — and past it, the deadline decides.
       */
      const errorName = error instanceof Error ? error.name : 'unknown';
      this.deps.logger.error(
        { paymentId: invoice.paymentId, error: errorName },
        'a gateway approval could not be settled',
      );
      /*
       * FIX-03 (batch 2026-10-10): and the operator is told, once per payment (the row's
       * counter grows on each refusal). The settlement transaction has already rolled back;
       * this write is quiet and outside it, so it can neither move money nor fail the pass.
       */
      await recordQuietly(
        this.deps.opsLog,
        scope,
        {
          code: GATEWAY_SETTLEMENT_FAILED_CODE,
          severity: 'ERROR',
          message:
            'A payment the gateway approved could not be settled. Nothing was credited; it is ' +
            'asked again until its deadline.',
          dedupeKey: `${GATEWAY_SETTLEMENT_FAILED_CODE}:${invoice.paymentId}`,
          context: { paymentId: invoice.paymentId, provider: invoice.provider, error: errorName },
        },
        this.deps.logger,
      );
      return 'ERROR';
    }
    switch (confirmation.outcome) {
      case 'SETTLED':
        this.logSettlementLatency(
          invoice,
          confirmation.payment,
          confirmation.orderPurpose ?? null,
          discovery,
          at,
        );
        await this.deps.invoices.recordOutcome(scope, invoice.paymentId, 'SETTLED', at);
        // R12 F1: the order's other link attempts were closed with it; their messages say so.
        for (const siblingId of confirmation.closedSiblings ?? []) {
          await this.refreshScreens(scope, siblingId);
        }
        return 'SETTLED';
      case 'ALREADY_CONFIRMED':
        await this.deps.invoices.recordOutcome(scope, invoice.paymentId, 'ALREADY_SETTLED', at);
        return 'SETTLED';
      case 'NOT_ELIGIBLE':
        /*
         * The reference the lane bound is not this attempt's under the payment's lock: the
         * money is not provably this payment's. Held for an operator, never settled.
         */
        if (confirmation.reason === 'PROVIDER_REFERENCE_MISMATCH') {
          return (await this.holdMismatch(
            scope,
            actor,
            invoice,
            invoice.providerStatus ?? 'verified',
            'PROVIDER_REFERENCE_REUSED',
          ))
            ? 'HELD'
            : 'ERROR';
        }
        if (
          lateCreditInput !== null &&
          (confirmation.reason === 'DEADLINE_PASSED' ||
            confirmation.reason === 'PAYMENT_NOT_PENDING' ||
            /*
             * R12 F1: money for an order another payment already settled (a second provider,
             * the wallet). It can never pay the order; the credit path returns it to the wallet
             * under the payment's lock, whatever the late-credit switch says.
             */
            confirmation.reason === 'ORDER_NOT_AWAITING_PAYMENT' ||
            // Already credited: the credit path answers CREDITED again and records the outcome.
            confirmation.reason === 'LATE_CREDIT_ALREADY_APPLIED')
        ) {
          const credited = await this.creditLateApproval(
            scope,
            actor,
            invoice,
            evidenceNote,
            lateCreditInput.providerRequestAmount,
          );
          if (credited.kind === 'CREDITED') return 'CREDITED';
          if (credited.kind === 'ERROR') return 'ERROR';
          await this.lateCompletion(scope, actor, invoice, credited.reason ?? confirmation.reason);
          return 'LATE';
        }
        await this.lateCompletion(scope, actor, invoice, confirmation.reason);
        return 'LATE';
    }
  }

  /**
   * R5A item 4: the policy of a route's late credit — its switch and the polling window — or
   * OFF when the lane has no late-credit collaborator, the route names no switch, or the
   * settings cannot be read (a read that fails never turns a credit ON). Never throws.
   */
  private async lateCreditPolicy(
    scope: TenantContext,
    provider: PaymentGatewayProvider,
  ): Promise<LateCreditPolicy> {
    const off: LateCreditPolicy = { enabled: false, windowMs: 0 };
    if (
      this.deps.lateCredit === undefined ||
      PAYMENT_GATEWAY_DESCRIPTORS[provider].lateCreditSetting === null
    ) {
      return off;
    }
    try {
      return await this.deps.lateCredit.policyFor(scope, provider);
    } catch (error: unknown) {
      this.deps.logger.error(
        { provider, ...errorFacts(error) },
        'a late-credit policy could not be read; late approvals are recorded, not credited',
      );
      return off;
    }
  }

  /**
   * Offers a re-verified LATE approval to the wallet credit. The credit decides under the
   * payment's lock (its switch, its state, the recorded approval, the amount); the lane maps
   * its answer:
   *
   * - `CREDITED` — the wallet holds the payment's amount once; nothing else to record here.
   * - `NOT_CREDITED` — recorded as a late completion for an operator, as before. `reason`
   *   names a more specific cause where the credit refused for the amount or the evidence (an
   *   operator reads it on the late-completion record); null keeps the confirmation's own.
   * - `ERROR` — the credit threw. Nothing moved; the approval stays undecided and the row is
   *   asked again, and the operator is told once per payment (the settlement-failed alarm).
   */
  private async creditLateApproval(
    scope: TenantContext,
    actor: ActorContext,
    invoice: GatewayInvoiceRecord,
    evidenceNote: string,
    providerRequestAmount: bigint | null,
  ): Promise<
    | { readonly kind: 'CREDITED' }
    | { readonly kind: 'ERROR' }
    | { readonly kind: 'NOT_CREDITED'; readonly reason: string | null }
  > {
    const collaborator = this.deps.lateCredit;
    if (collaborator === undefined) return { kind: 'NOT_CREDITED', reason: null };
    let credit: Awaited<ReturnType<typeof collaborator.credit>>;
    try {
      credit = await collaborator.credit(scope, actor, invoice.paymentId, {
        providerRequestAmount,
        evidenceNote,
      });
    } catch (error: unknown) {
      const errorName = error instanceof Error ? error.name : 'unknown';
      this.deps.logger.error(
        { paymentId: invoice.paymentId, error: errorName },
        'a late gateway approval could not be credited',
      );
      await recordQuietly(
        this.deps.opsLog,
        scope,
        {
          code: GATEWAY_SETTLEMENT_FAILED_CODE,
          severity: 'ERROR',
          message:
            'A payment the gateway approved late could not be credited to the wallet. Nothing ' +
            'was credited; it is asked again.',
          dedupeKey: `${GATEWAY_SETTLEMENT_FAILED_CODE}:${invoice.paymentId}`,
          context: { paymentId: invoice.paymentId, provider: invoice.provider, error: errorName },
        },
        this.deps.logger,
      );
      return { kind: 'ERROR' };
    }
    if (credit.outcome === 'CREDITED') return { kind: 'CREDITED' };
    switch (credit.reason) {
      case 'AMOUNT_MISMATCH':
        return { kind: 'NOT_CREDITED', reason: 'LATE_CREDIT_AMOUNT_MISMATCH' };
      case 'APPROVAL_NOT_VERIFIED':
        return { kind: 'NOT_CREDITED', reason: 'LATE_CREDIT_APPROVAL_NOT_VERIFIED' };
      default:
        return { kind: 'NOT_CREDITED', reason: null };
    }
  }

  /**
   * FIX-01 (batch 2026-10-10): the four stages of one settlement, in one redacted line —
   * identifiers and durations only, never an amount, a key, a payload or a card.
   *
   *  1. `invoiceToDiscoveryMs` — the invoice's creation to the answer that approved it, and
   *     `dueToDiscoveryMs` — the row falling due to that answer (the lane's own lag: its
   *     interval, the passes ahead of it, the call). The provider's own approval instant is
   *     not knowable here, so it is never claimed.
   *  2. `discoveryToConfirmedMs` — the answer to the committed settlement (ledger + state).
   *  3. `customerMessage` — what announces it: a top-up's `WALLET_TOPUP_CREDITED` is enqueued
   *     IN the settling transaction (confirmed → enqueued is zero by construction) and sent by
   *     the customer notification lane, which logs `customer notification latency`; an order's
   *     service is created and delivered by the provisioner, directly.
   *  4. The send itself is the lane's or the provisioner's line, joined by payment id.
   */
  private logSettlementLatency(
    invoice: GatewayInvoiceRecord,
    payment: PaymentRecord,
    orderPurpose: OrderPurpose | null,
    discovery: { readonly trigger: GatewayDiscoveryTrigger; readonly dueAt: Date | null },
    discoveredAt: Date,
  ): void {
    const since = (from: Date | null): number | null =>
      from === null ? null : discoveredAt.getTime() - from.getTime();
    const confirmedAt = payment.confirmedAt ?? null;
    // Evidence only: a logger that fails must not stand between a settlement and its record.
    try {
      this.deps.logger.info(
        {
          paymentId: invoice.paymentId,
          provider: invoice.provider,
          kind: payment.orderId === null ? 'TOPUP' : 'ORDER',
          orderPurpose,
          trigger: discovery.trigger,
          // Codex #265 (1): a recorded payment (Stars) was discovered by no inquiry at all.
          inquiryAttempt:
            PAYMENT_GATEWAY_DESCRIPTORS[invoice.provider].approval === 'RECORDED_PAYMENT'
              ? null
              : invoice.inquiryAttempts + 1,
          invoiceToDiscoveryMs: since(invoice.createdInvoiceAt),
          dueToDiscoveryMs: since(discovery.dueAt),
          webhookToDiscoveryMs: since(invoice.lastWebhookAt),
          discoveryToConfirmedMs:
            confirmedAt === null ? null : confirmedAt.getTime() - discoveredAt.getTime(),
          customerMessage: finalMessagePath(payment.orderId === null, orderPurpose),
        },
        'gateway payment settlement latency',
      );
    } catch {
      // Nothing to do: the settlement stands, and its record follows.
    }
  }

  /** The worker's settlement of a recorded payment (Stars). No provider call is made. */
  private async settleRecordedClaim(
    scope: TenantContext,
    actor: ActorContext,
    invoice: GatewayInvoiceRecord,
    eligible: boolean,
    expiresAt: Date | null,
    leaseUntil: Date,
  ): Promise<'OPEN' | 'SETTLED' | 'LATE' | 'ERROR' | 'LOST'> {
    const now = this.deps.clock.now();
    const recorded = invoice.providerChargeId !== null && invoice.providerPaid === true;
    /*
     * Nothing recorded is nothing approved: the row is unscheduled and the deadline
     * decides, as it does for every attempt nobody paid.
     *
     * A RECORDED charge stays scheduled until its outcome commits, whatever its
     * eligibility (Codex review of #85). `recordOutcome` is what clears the schedule — for a
     * settlement and for a late completion alike — so a transaction that fails between
     * here and there (the late completion's own write, its audit, its operator notice) is
     * retried rather than stranding money that has already moved with no outcome and no
     * notice. The retry is harmless for the reason the inquiry path's is: the settlement is
     * exactly-once and a late completion is recorded once.
     */
    const retry = recorded
      ? ((eligible && expiresAt !== null ? this.nextInquiryAt(invoice, now, expiresAt) : null) ??
        new Date(now.getTime() + RECORDED_OUTCOME_RETRY_MS))
      : null;
    const kept = await this.deps.uow.run(scope, (tx) =>
      this.deps.invoices.recordInquiry(
        scope,
        invoice.paymentId,
        {
          status: null,
          paid: null,
          requestAmount: null,
          finalAmount: null,
          errorCode: recorded ? null : 'nexa.nothing_recorded',
          adoptInvoiceId: null,
          nextInquiryAt: retry,
          postDeadline: false,
          claimedUntil: leaseUntil,
        },
        now,
        tx,
      ),
    );
    // FIX10 R1: another replica took the row; it settles it, not this pass.
    if (!kept) return 'LOST';
    if (!recorded) return 'OPEN';
    // A recorded payment carries no provider reference, so it is never held here.
    const settled = await this.settleApproved(
      scope,
      actor,
      invoice,
      `${invoice.provider.toLowerCase()}:successful_payment`,
      now,
      null,
      { trigger: 'STARS_RECOVERY', dueAt: invoice.nextInquiryAt },
    );
    // A recorded payment passes no late-credit input, so it is never credited this way.
    if (settled === 'CREDITED') throw new Error('a recorded payment is never a late credit');
    return settled === 'HELD' ? 'ERROR' : settled;
  }

  /**
   * Settle ONE recorded payment now (Stars' `successful_payment`, straight after it was
   * recorded). The same decision the worker takes from the row: this is only its earlier
   * arrival, and if it does not finish the row is still due and the worker finishes it.
   */
  async settleRecorded(
    scope: TenantContext,
    paymentId: PaymentId,
  ): Promise<'SETTLED' | 'LATE' | 'ERROR' | 'NOT_RECORDED'> {
    const invoice = await this.deps.invoices.findByPayment(scope, paymentId);
    const payment = await this.deps.paymentRecords.findById(scope, paymentId);
    if (
      invoice === null ||
      payment === null ||
      PAYMENT_GATEWAY_DESCRIPTORS[invoice.provider].approval !== 'RECORDED_PAYMENT' ||
      invoice.providerChargeId === null ||
      invoice.providerPaid !== true
    ) {
      return 'NOT_RECORDED';
    }
    // Already decided (settled, or recorded late): the transition is exactly-once anyway,
    // and a redelivered update must not write a second late-completion notice.
    if (invoice.outcome !== null) return invoice.outcome === 'LATE_COMPLETION' ? 'LATE' : 'SETTLED';
    const now = this.deps.clock.now();
    // Eligibility is the settlement path's to decide, under the payment's lock (FIX10 BUG-2).
    const settled = await this.settleApproved(
      scope,
      this.actor(),
      invoice,
      `${invoice.provider.toLowerCase()}:successful_payment`,
      now,
      null,
      { trigger: 'STARS_UPDATE', dueAt: null },
    );
    // Audit P2-b on #260: the worker's pass is not the only one that decides a recorded payment.
    if (settled === 'SETTLED' || settled === 'LATE') {
      await this.settlementDecided(scope, paymentId);
    }
    // A recorded payment passes no late-credit input, so it is never credited this way.
    if (settled === 'CREDITED') throw new Error('a recorded payment is never a late credit');
    return settled === 'HELD' ? 'ERROR' : settled;
  }

  /** What an invoice is sent with, by the route's descriptor. Never logged. */
  private async invoiceCredential(
    scope: TenantContext,
    invoice: GatewayInvoiceRecord,
  ): Promise<string | null> {
    switch (PAYMENT_GATEWAY_DESCRIPTORS[invoice.provider].invoiceCredential) {
      case 'GATEWAY_KEY':
        return this.deps.credentials.read(scope, invoice.provider);
      case 'BOT_TOKEN':
        return invoice.botInstanceId === null
          ? null
          : this.deps.botTokens.tokenForBotInstance(scope, invoice.botInstanceId);
      case 'NONE':
        return null;
    }
  }

  private nextInquiryAt(
    invoice: GatewayInvoiceRecord,
    at: Date,
    expiresAt: Date | null,
  ): Date | null {
    if (expiresAt === null) return null;
    // FIX-06: the provider's own schedule (`domain/inquiry-schedule.ts`), jittered.
    const next = nextScheduledInquiryAt(inquiryScheduleFor(invoice.provider), {
      at,
      attempt: invoice.inquiryAttempts + 1,
      invoiceCreatedAt: invoice.createdInvoiceAt,
      paymentId: invoice.paymentId,
    });
    if (next.getTime() < expiresAt.getTime()) return next;
    /*
     * One last question just before the deadline, so a payment made in the final minutes
     * is not lost to the backoff; after the deadline there is nothing to ask for.
     */
    const last = new Date(expiresAt.getTime() - 15_000);
    return last.getTime() > at.getTime() ? last : null;
  }

  /**
   * FIX-06: whether a due row was brought forward by a hint rather than by its schedule
   * (`domain/inquiry-discovery.ts`). Decides only WHEN it is asked and from which share of
   * the budget — never what its answer means.
   */
  private isHinted(claimed: ClaimedGatewayInvoice): boolean {
    const expiresAt = gatewaySettlementDeadline({
      expiresAt: claimed.paymentExpiresAt,
      providerReviewUntil: claimed.paymentReviewUntil,
    });
    const trigger = this.discoveryTriggerOf(claimed, expiresAt);
    if (trigger === 'SCHEDULED') return false;
    /*
     * R5A item 4: a row that fell due AT OR AFTER the deadline with nothing but the schedule
     * behind it is the slow late poll, whose due time the inside-the-deadline schedule cannot
     * reproduce. It is on its schedule, not hinted: it takes the lowest share of the budget
     * and is never asked ahead of the rows a customer is waiting behind. A webhook or an
     * operator's request is still recognised before this and stays a hint.
     */
    if (
      trigger === 'CUSTOMER_HINT' &&
      expiresAt !== null &&
      claimed.invoice.nextInquiryAt !== null &&
      claimed.invoice.nextInquiryAt.getTime() >= expiresAt.getTime() - 15_000
    ) {
      return false;
    }
    return true;
  }

  /**
   * When the schedule ALONE put this row's next inquiry — the same functions, with the same
   * jitter, that wrote it. Null when it cannot be said (no create time, no deadline).
   */
  private scheduledInquiryAt(
    invoice: GatewayInvoiceRecord,
    reviewUntil: Date | null,
    reviewStartedAt: Date | null,
    expiresAt: Date | null,
  ): Date | null {
    if (invoice.lastInquiryAt === null) {
      return invoice.createdInvoiceAt === null
        ? null
        : firstInquiryAt(
            inquiryScheduleFor(invoice.provider),
            invoice.createdInvoiceAt,
            invoice.paymentId,
          );
    }
    if (
      reviewUntil !== null &&
      reviewStartedAt !== null &&
      invoice.lastInquiryAt.getTime() >= reviewStartedAt.getTime()
    ) {
      return reviewInquiryNextAt(reviewStartedAt, reviewUntil, invoice.lastInquiryAt, (ms) =>
        jitteredMs(ms, invoice.paymentId, invoice.inquiryAttempts),
      );
    }
    // `inquiryAttempts` already counts the last inquiry; the schedule was computed before it.
    return this.nextInquiryAt(
      { ...invoice, inquiryAttempts: Math.max(0, invoice.inquiryAttempts - 1) },
      invoice.lastInquiryAt,
      expiresAt,
    );
  }

  // ---------------------------------------------------------------------------------------
  // TonPays Telegram — the review sweep, the card-change lane and the receipt lane
  // (`docs/tonpays-telegram-gateway-audit.md` §8.2, §8.3, §9.1, §9.6). Each provider call is
  // claimed in one short transaction, stamped and COMMITTED before the call, made outside
  // every transaction under the tenant's budget, and recorded in another. A row reclaimed
  // with its stamp set is UNKNOWN and is never sent again. Nothing here settles anything.
  // ---------------------------------------------------------------------------------------

  /**
   * NOWPayments' MISMATCH (§5.5): `PENDING -> UNKNOWN` for ONE payment, in one transaction
   * with its audit row, `PaymentOutcomeUnknown` and the operator's condition — the shape the
   * review sweep below writes. Conditional on the payment still being PENDING inside its
   * effective deadline; a replay moves nothing. True when it moved.
   */
  private async holdMismatch(
    scope: TenantContext,
    actor: ActorContext,
    invoice: GatewayInvoiceRecord,
    providerStatus: string,
    reason = 'PROVIDER_AMOUNT_MISMATCH',
  ): Promise<boolean> {
    const now = this.deps.clock.now();
    const held = await this.deps.uow.run(scope, async (tx) => {
      if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) return null;
      const payment = await this.deps.paymentRecords.loseTrack(scope, invoice.paymentId, now, tx);
      if (payment === null) return null;
      await this.deps.audit.record(
        scope,
        actor,
        {
          action: PAYMENT_LOSE_TRACK_ACTION,
          entityType: 'Payment',
          entityId: payment.id,
          before: { state: 'PENDING' },
          after: {
            state: 'UNKNOWN',
            gatewayProvider: payment.gatewayProvider,
            reason,
            providerStatus,
          },
          result: 'SUCCESS',
        },
        tx,
      );
      await this.deps.outbox.write(tx, actor, {
        eventType: 'PaymentOutcomeUnknown',
        aggregateType: 'Payment',
        aggregateId: payment.id,
        payload: {
          customerId: payment.customerId,
          orderId: payment.orderId,
          method: payment.method,
          amountMinor: payment.amount.amountMinor.toString(),
          currency: payment.amount.currency,
        },
      });
      await this.deps.opsLog.record(
        scope,
        {
          code: GATEWAY_REVIEW_UNRESOLVED_CODE,
          severity: 'WARN',
          message:
            'A payment gateway reported money for an attempt that does not match what was invoiced ' +
            '(a partial payment, another price, another customer or a reference already used). ' +
            'Nothing was settled or failed; reconcile it against the gateway’s records.',
          dedupeKey: `${GATEWAY_REVIEW_UNRESOLVED_CODE}:${payment.id}`,
          context: {
            paymentId: payment.id,
            provider: payment.gatewayProvider,
            reason,
            providerStatus,
          },
        },
        tx,
      );
      return payment;
    });
    return held !== null;
  }

  /**
   * The review sweep (§9.6.3 e), the first producer of `LOSE_TRACK`: a PENDING payment whose
   * provider review window has ended with no trustworthy answer becomes UNKNOWN — never
   * EXPIRED and never FAILED, because the customer has very probably paid. In the same
   * transaction: the audit row, `PaymentOutcomeUnknown` and the operator's condition. Two
   * replicas take different rows (`SKIP LOCKED`); a replay moves nothing. Returns how many.
   */
  private async loseTrackOfLapsedReviews(
    scope: TenantContext,
    actor: ActorContext,
  ): Promise<number> {
    const now = this.deps.clock.now();
    const lapsed = await this.deps.uow.run(scope, async (tx) => {
      // A stopped scope accepts no new state change; its rows wait (checked IN the tx).
      if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) return [];
      const moved = await this.deps.paymentRecords.loseTrackOfReviewed(
        scope,
        now,
        GATEWAY_REVIEW_SWEEP_BATCH,
        tx,
      );
      for (const payment of moved) {
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: PAYMENT_LOSE_TRACK_ACTION,
            entityType: 'Payment',
            entityId: payment.id,
            before: { state: 'PENDING' },
            after: {
              state: 'UNKNOWN',
              gatewayProvider: payment.gatewayProvider,
              providerReviewStartedAt: payment.providerReviewStartedAt?.toISOString() ?? null,
              providerReviewUntil: payment.providerReviewUntil?.toISOString() ?? null,
            },
            result: 'SUCCESS',
          },
          tx,
        );
        await this.deps.outbox.write(tx, actor, {
          eventType: 'PaymentOutcomeUnknown',
          aggregateType: 'Payment',
          aggregateId: payment.id,
          payload: {
            customerId: payment.customerId,
            orderId: payment.orderId,
            method: payment.method,
            amountMinor: payment.amount.amountMinor.toString(),
            currency: payment.amount.currency,
          },
        });
        await this.deps.opsLog.record(
          scope,
          {
            code: GATEWAY_REVIEW_UNRESOLVED_CODE,
            severity: 'WARN',
            message:
              'A payment gateway’s review of a customer’s receipt ended with no confirmed answer. ' +
              'Nothing was settled or failed; reconcile it against the gateway’s records.',
            dedupeKey: `${GATEWAY_REVIEW_UNRESOLVED_CODE}:${payment.id}`,
            context: { paymentId: payment.id, provider: payment.gatewayProvider },
          },
          tx,
        );
      }
      return moved;
    });
    for (const payment of lapsed) await this.refreshScreens(scope, payment.id);
    return lapsed.length;
  }

  /** Receipt windows past their deadline, or whose payment closed or entered review. */
  private async sweepReceiptCaptures(scope: TenantContext): Promise<void> {
    const cards = this.deps.cardTransfer;
    if (cards === undefined) return;
    const now = this.deps.clock.now();
    await this.deps.uow.run(scope, (tx) =>
      cards.sweepCaptures(scope, now, GATEWAY_CAPTURE_SWEEP_BATCH, tx),
    );
  }

  /** The card-change lane (§8.2). */
  private async runCardChanges(
    scope: TenantContext,
    actor: ActorContext,
    report: { rowFailures: number; leaseReleased: number },
  ): Promise<{ readonly done: number; readonly budgetExhausted: boolean }> {
    const cards = this.deps.cardTransfer;
    if (cards === undefined) return { done: 0, budgetExhausted: false };
    const now = this.deps.clock.now();
    const lease = new Date(now.getTime() + this.leaseMs());
    const claimed = await this.deps.uow.run(scope, (tx) =>
      cards.claimCardChanges(scope, now, this.leaseMs(), GATEWAY_CARD_CHANGE_BATCH, tx),
    );
    let done = 0;
    for (const [index, row] of claimed.entries()) {
      if (!this.rowFitsLease(lease)) {
        // FIX10 R1: no lease left for one more row; these go back for the next pass.
        report.leaseReleased += claimed.length - index;
        await this.deps.uow.run(scope, (tx) =>
          cards.releaseCardChangeClaims(
            scope,
            claimed.slice(index).map((one) => one.row.id),
            lease,
            tx,
          ),
        );
        break;
      }
      let result: 'DONE' | 'BUDGET';
      try {
        result = await this.processCardChange(scope, actor, cards, row);
      } catch (error: unknown) {
        /*
         * FIX10 BUG-1: the row keeps its lease, which is its back-off — a card change has no
         * schedule of its own, and a request stamped before the throw is UNKNOWN when the
         * lease runs out and it is claimed again. The rows after it are processed now.
         */
        report.rowFailures += 1;
        await this.rowFailed(scope, 'CARD_CHANGE', row.row.paymentId, null, error, () =>
          Promise.resolve(false),
        );
        continue;
      }
      if (result === 'BUDGET') {
        // The row that met the empty budget and every one after it give their leases back.
        await this.deps.uow.run(scope, (tx) =>
          cards.releaseCardChangeClaims(
            scope,
            claimed.slice(index).map((one) => one.row.id),
            lease,
            tx,
          ),
        );
        return { done, budgetExhausted: true };
      }
      done += 1;
      await this.refreshScreens(scope, row.row.paymentId);
    }
    return { done, budgetExhausted: false };
  }

  private async processCardChange(
    scope: TenantContext,
    actor: ActorContext,
    cards: GatewayCardTransferRepository,
    claimed: ClaimedCardTransferRow<GatewayCardChangeRecord>,
  ): Promise<'DONE' | 'BUDGET'> {
    const change = claimed.row;
    const now = this.deps.clock.now();
    const decide = async (
      to: 'APPLIED' | 'REFUSED' | 'RATE_LIMITED' | 'UNKNOWN',
      code: string | null,
      extra?: (tx: TransactionScope) => Promise<void>,
    ): Promise<void> => {
      await this.deps.uow.run(scope, async (tx) => {
        const moved = await cards.decideCardChange(
          scope,
          change.id,
          to,
          code,
          this.deps.clock.now(),
          tx,
        );
        if (!moved) return;
        if (extra !== undefined) await extra(tx);
        await this.deps.audit.record(
          scope,
          actor,
          {
            action:
              to === 'APPLIED'
                ? 'gateway_invoice.card_change_applied'
                : to === 'UNKNOWN'
                  ? 'gateway_invoice.card_change_unknown'
                  : 'gateway_invoice.card_change_refused',
            entityType: 'Payment',
            entityId: change.paymentId,
            before: { cardChangeId: change.id, state: change.state },
            // Ids, states and codes only: never a card number or a card name.
            after: { cardChangeId: change.id, state: to, reason: code },
            result: 'SUCCESS',
          },
          tx,
        );
      });
    };

    /*
     * TPTG-04: a request whose send was stamped and never answered — a worker died mid-call,
     * or its lease ran out. The provider may have changed the card: UNKNOWN, never re-sent,
     * and the current card is HIDDEN (it may have been retired).
     */
    if (change.sentAt !== null) {
      await decide('UNKNOWN', 'nexa.send_interrupted', (tx) =>
        this.cardUnknown(scope, change.paymentId, 'nexa.send_interrupted', tx),
      );
      return 'DONE';
    }
    const invoice = await this.deps.invoices.findByPayment(scope, change.paymentId);
    const customerWindowOpen =
      claimed.paymentState === 'PENDING' &&
      claimed.paymentReviewUntil === null &&
      claimed.paymentExpiresAt !== null &&
      now.getTime() < claimed.paymentExpiresAt.getTime();
    if (
      !customerWindowOpen ||
      invoice === null ||
      invoice.creationState !== 'CREATED' ||
      invoice.providerInvoiceId === null
    ) {
      await decide('REFUSED', 'nexa.attempt_closed');
      return 'DONE';
    }
    const adapter = this.deps.cardAdapters?.(invoice.provider) ?? null;
    const apiKey =
      adapter === null ? null : await this.deps.credentials.read(scope, invoice.provider);
    if (adapter === null || apiKey === null) {
      await decide('REFUSED', 'nexa.credential_missing');
      await this.misconfigured(scope, invoice, 'nexa.credential_missing');
      return 'DONE';
    }
    if (!(await this.deps.budget.take(scope, invoice.provider, adapter.callBudgetPerMinute, now))) {
      return 'BUDGET';
    }
    const stamped = await this.deps.uow.run(scope, (tx) =>
      cards.markCardChangeSent(scope, change.id, now, tx),
    );
    if (!stamped) return 'DONE';
    const outcome = await adapter.changeCard(apiKey, invoice.providerInvoiceId);
    const at = this.deps.clock.now();
    this.deps.logger.info(
      {
        paymentId: change.paymentId,
        provider: invoice.provider,
        outcome: outcome.kind,
        reason: outcome.kind === 'CHANGED' ? null : outcome.code,
      },
      'gateway card change answered',
    );
    switch (outcome.kind) {
      case 'CHANGED':
        await decide('APPLIED', null, async (tx) => {
          await this.deps.invoices.applyCard(
            scope,
            change.paymentId,
            outcome.instructions,
            'CHANGE_CARD',
            outcome.policy,
            at,
            tx,
            outcome.finalAmount ?? null,
          );
        });
        await this.configured(scope, invoice.provider);
        return 'DONE';
      case 'RATE_LIMITED':
        // Not processed: the current card stays, and the customer may tap again.
        await decide('RATE_LIMITED', outcome.code);
        return 'DONE';
      case 'REFUSED':
        await decide('REFUSED', outcome.code);
        if (outcome.configuration) await this.misconfigured(scope, invoice, outcome.code);
        return 'DONE';
      case 'NOT_FOUND':
        await decide('REFUSED', outcome.code);
        await this.identityMismatch(scope, invoice, 'INQUIRY');
        return 'DONE';
      case 'UNKNOWN':
        await decide('UNKNOWN', outcome.code, (tx) =>
          this.cardUnknown(scope, change.paymentId, outcome.code, tx),
        );
        return 'DONE';
    }
  }

  /** The invoice's own provider id for a submission's payment, or null when it has none. */
  private async invoiceIdOf(
    scope: TenantContext,
    submission: { readonly paymentId: PaymentId },
  ): Promise<string | null> {
    const invoice = await this.deps.invoices.findByPayment(scope, submission.paymentId);
    return invoice?.providerInvoiceId ?? null;
  }

  /**
   * Whether a receipt's target is this invoice: its own provider id, or — only while the
   * provider reports an underpayment — the `remaining_invoice_id` it named. Anything else is
   * not this attempt's, whatever the submission row says.
   */
  private async receiptTargetMatches(
    scope: TenantContext,
    invoice: GatewayInvoiceRecord,
    target: string,
    tx?: TransactionScope,
  ): Promise<boolean> {
    if (invoice.providerInvoiceId === target) return true;
    const requests = this.deps.providerRequests;
    if (requests === undefined || invoice.providerStatus !== TONPAYS_TELEGRAM_STATUS_LESS) {
      return false;
    }
    const facts = await requests.factsFor(scope, invoice.paymentId, tx);
    return facts?.need === 'LESS' && facts.remainingInvoiceId === target;
  }

  /** A card change whose answer was lost: the card is hidden and the operator told. */
  private async cardUnknown(
    scope: TenantContext,
    paymentId: PaymentId,
    reason: string,
    tx: TransactionScope,
  ): Promise<void> {
    await this.deps.invoices.hideCard(scope, paymentId, this.deps.clock.now(), tx);
    await this.deps.opsLog.record(
      scope,
      {
        code: GATEWAY_CARD_CHANGE_UNKNOWN_CODE,
        severity: 'WARN',
        message:
          'A payment gateway’s answer to a card change was lost. The previous card is no ' +
          'longer shown to the customer, and the request is never sent again.',
        dedupeKey: `${GATEWAY_CARD_CHANGE_UNKNOWN_CODE}:${paymentId}`,
        context: { paymentId, reason },
      },
      tx,
    );
  }

  /** The receipt lane (§8.3). */
  private async runReceipts(
    scope: TenantContext,
    actor: ActorContext,
    report: { rowFailures: number; leaseReleased: number },
  ): Promise<{ readonly done: number; readonly budgetExhausted: boolean }> {
    const cards = this.deps.cardTransfer;
    if (cards === undefined) return { done: 0, budgetExhausted: false };
    const now = this.deps.clock.now();
    const lease = new Date(now.getTime() + this.leaseMs());
    const claimed = await this.deps.uow.run(scope, (tx) =>
      cards.claimSubmissions(scope, now, this.leaseMs(), GATEWAY_RECEIPT_BATCH, tx),
    );
    let done = 0;
    for (const [index, row] of claimed.entries()) {
      if (!this.rowFitsLease(lease)) {
        // FIX10 R1: no lease left for one more row; these go back for the next pass.
        report.leaseReleased += claimed.length - index;
        await this.deps.uow.run(scope, (tx) =>
          cards.releaseSubmissionClaims(
            scope,
            claimed.slice(index).map((one) => one.row.id),
            lease,
            tx,
          ),
        );
        break;
      }
      let result: 'DONE' | 'BUDGET';
      try {
        result = await this.processReceipt(scope, actor, cards, row);
      } catch (error: unknown) {
        // FIX10 BUG-1: backed off on its own lease; a stamped upload stays UNKNOWN.
        report.rowFailures += 1;
        await this.rowFailed(
          scope,
          'RECEIPT',
          row.row.paymentId,
          null,
          error,
          (at) =>
            this.deps.uow.run(scope, (tx) =>
              cards.backOffSubmission(
                scope,
                row.row.id,
                lease,
                rowFailureRetryAt(at, row.row.createdAt),
                at,
                tx,
              ),
            ),
          row.row.id,
        );
        continue;
      }
      if (result === 'BUDGET') {
        await this.deps.uow.run(scope, (tx) =>
          cards.releaseSubmissionClaims(
            scope,
            claimed.slice(index).map((one) => one.row.id),
            lease,
            tx,
          ),
        );
        return { done, budgetExhausted: true };
      }
      await this.rowSucceeded(scope, {
        kind: 'RECEIPT',
        paymentId: row.row.paymentId,
        submissionId: row.row.id,
        rowFailures: row.row.rowFailures,
      });
      done += 1;
      await this.refreshScreens(scope, row.row.paymentId);
    }
    return { done, budgetExhausted: false };
  }

  private async processReceipt(
    scope: TenantContext,
    actor: ActorContext,
    cards: GatewayCardTransferRepository,
    claimed: ClaimedCardTransferRow<GatewayReceiptSubmissionRecord>,
  ): Promise<'DONE' | 'BUDGET'> {
    const submission = claimed.row;
    const decide = async (
      to: 'ACCEPTED' | 'REFUSED' | 'UNKNOWN' | 'ABANDONED',
      facts: {
        readonly errorCode: string | null;
        readonly providerStatus?: string | null;
        readonly receiptReceived?: boolean | null;
      },
      extra?: (tx: TransactionScope) => Promise<void>,
    ): Promise<boolean> =>
      this.deps.uow.run(scope, async (tx) => {
        const moved = await cards.decideSubmission(
          scope,
          submission.id,
          to,
          {
            errorCode: facts.errorCode,
            providerStatus: facts.providerStatus ?? null,
            receiptReceived: facts.receiptReceived ?? null,
          },
          this.deps.clock.now(),
          tx,
        );
        if (!moved) return false;
        if (extra !== undefined) await extra(tx);
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: `gateway_receipt.${to.toLowerCase()}`,
            entityType: 'Payment',
            entityId: submission.paymentId,
            before: { submissionId: submission.id, state: submission.state },
            // Ids, states and codes only: no file id, caption, bytes or card (TPTG-21).
            after: {
              submissionId: submission.id,
              state: to,
              reason: facts.errorCode,
              providerStatus: facts.providerStatus ?? null,
              receiptReceived: facts.receiptReceived ?? null,
            },
            result: 'SUCCESS',
          },
          tx,
        );
        return true;
      });
    const lost = async (code: string): Promise<void> => {
      await decide('UNKNOWN', { errorCode: code }, async (tx) => {
        await this.deps.opsLog.record(
          scope,
          {
            code: GATEWAY_RECEIPT_UNKNOWN_CODE,
            severity: 'WARN',
            message:
              'A payment gateway’s answer to a receipt upload was lost. It is never uploaded ' +
              'again; the next inquiry is brought forward, and the deadline still stands.',
            dedupeKey: `${GATEWAY_RECEIPT_UNKNOWN_CODE}:${submission.paymentId}`,
            context: { paymentId: submission.paymentId, reason: code },
          },
          tx,
        );
        // Bring the inquiry forward: only it may say what became of the upload.
        await this.deps.invoices.requestInquiry(
          scope,
          submission.paymentId,
          this.deps.clock.now(),
          tx,
        );
      });
    };

    /*
     * TPTG-05: an upload whose send was stamped and never answered. TonPays documents no
     * receipt idempotency, so it is UNKNOWN and NEVER uploaded again (`OQ-TPTG-08`).
     */
    if (submission.sentAt !== null) {
      await lost('nexa.send_interrupted');
      return 'DONE';
    }
    /*
     * Round 6: a receipt for the REMAINDER of an underpaid invoice (its target is the
     * provider's `remaining_invoice_id`, not the invoice's own id) may be sent while the
     * provider's review is open — the underpayment is found by checking the first receipt.
     * Every other receipt is the customer window's, exactly as before.
     */
    const remainder = submission.providerInvoiceId !== (await this.invoiceIdOf(scope, submission));
    const windowOpen = (payment: {
      readonly state: string;
      readonly expiresAt: Date | null;
      readonly reviewUntil: Date | null;
    }): boolean => {
      const deadline = remainder
        ? gatewaySettlementDeadline({
            expiresAt: payment.expiresAt,
            providerReviewUntil: payment.reviewUntil,
          })
        : payment.reviewUntil === null
          ? payment.expiresAt
          : null;
      return (
        payment.state === 'PENDING' &&
        deadline !== null &&
        this.deps.clock.now().getTime() < deadline.getTime()
      );
    };
    /*
     * TPTG-33: once the customer window has closed nothing is uploaded — a receipt sent
     * after the deadline could not open a review, and must never reopen an expired payment.
     */
    if (
      !windowOpen({
        state: claimed.paymentState,
        expiresAt: claimed.paymentExpiresAt,
        reviewUntil: claimed.paymentReviewUntil,
      })
    ) {
      await decide('ABANDONED', { errorCode: 'nexa.deadline_passed' });
      return 'DONE';
    }
    const invoice = await this.deps.invoices.findByPayment(scope, submission.paymentId);
    if (
      invoice === null ||
      invoice.creationState !== 'CREATED' ||
      invoice.providerInvoiceId === null ||
      !(await this.receiptTargetMatches(scope, invoice, submission.providerInvoiceId)) ||
      invoice.botInstanceId !== submission.botInstanceId
    ) {
      await decide('ABANDONED', { errorCode: 'nexa.identity_mismatch' });
      return 'DONE';
    }
    const adapter = this.deps.cardAdapters?.(invoice.provider) ?? null;
    const apiKey =
      adapter === null ? null : await this.deps.credentials.read(scope, invoice.provider);
    if (adapter === null || apiKey === null || this.deps.receiptFiles === undefined) {
      await decide('ABANDONED', { errorCode: 'nexa.credential_missing' });
      if (adapter === null || apiKey === null) {
        await this.misconfigured(scope, invoice, 'nexa.credential_missing');
      }
      return 'DONE';
    }
    // The bytes, with the token of the bot the photo was sent to, bounded while streaming.
    const file = await this.deps.receiptFiles.download(
      scope,
      { botInstanceId: submission.botInstanceId, fileId: submission.telegramFileId },
      { maxBytes: adapter.receiptMaxBytes },
    );
    if (file.outcome !== 'SUCCEEDED') {
      await decide('ABANDONED', { errorCode: 'nexa.file_unavailable' });
      return 'DONE';
    }
    const mimeType = sniffReceiptImage(file.bytes);
    if (mimeType === null) {
      await decide('ABANDONED', { errorCode: 'nexa.not_an_image' });
      return 'DONE';
    }
    if (file.bytes.byteLength > adapter.receiptMaxBytes) {
      await decide('ABANDONED', { errorCode: 'nexa.receipt_too_large' });
      return 'DONE';
    }
    const now = this.deps.clock.now();
    if (!(await this.deps.budget.take(scope, invoice.provider, adapter.callBudgetPerMinute, now))) {
      return 'BUDGET';
    }
    // Re-read the payment: the window may have closed while the file was fetched.
    const payment = await this.deps.paymentRecords.findById(scope, submission.paymentId);
    if (
      payment === null ||
      !windowOpen({
        state: payment.state,
        expiresAt: payment.expiresAt,
        reviewUntil: payment.providerReviewUntil,
      })
    ) {
      await decide('ABANDONED', { errorCode: 'nexa.deadline_passed' });
      return 'DONE';
    }
    /*
     * Decided again under the payment's lock, in the transaction that stamps the send (Codex
     * review of #136): the read above is unlocked, and an inquiry's confirmation or failure,
     * a review opening or the expiry sweep can close the payment before this commits. The
     * stamp is the point of no return; it is taken only for a payment still open, on the
     * same invoice.
     */
    const stamped = await this.deps.uow.run(scope, async (tx) => {
      const locked = await this.deps.paymentRecords.findByIdForUpdate(
        scope,
        submission.paymentId,
        tx,
      );
      const current = await this.deps.invoices.findByPayment(scope, submission.paymentId, tx);
      if (
        locked === null ||
        !windowOpen({
          state: locked.state,
          expiresAt: locked.expiresAt,
          reviewUntil: locked.providerReviewUntil,
        }) ||
        current === null ||
        current.creationState !== 'CREATED' ||
        current.providerInvoiceId === null ||
        !(await this.receiptTargetMatches(scope, current, submission.providerInvoiceId, tx))
      ) {
        return 'CLOSED' as const;
      }
      return (await cards.markSubmissionSending(
        scope,
        submission.id,
        file.bytes.byteLength,
        now,
        tx,
      ))
        ? ('STAMPED' as const)
        : ('LOST' as const);
    });
    if (stamped === 'CLOSED') {
      await decide('ABANDONED', { errorCode: 'nexa.deadline_passed' });
      return 'DONE';
    }
    if (stamped === 'LOST') return 'DONE';
    // The submission's own target: the invoice, or an underpayment's remainder invoice.
    const outcome = await adapter.uploadReceipt(apiKey, submission.providerInvoiceId, {
      bytes: file.bytes,
      mimeType,
      fileName: receiptFileName(mimeType),
    });
    // The clock AFTER the answer: the earliest moment Nexa knows (§9.6.3 c).
    const at = this.deps.clock.now();
    this.deps.logger.info(
      {
        paymentId: submission.paymentId,
        provider: invoice.provider,
        outcome: outcome.kind,
        reason: outcome.kind === 'ACCEPTED' ? null : outcome.code,
      },
      'gateway receipt upload answered',
    );
    switch (outcome.kind) {
      case 'ACCEPTED': {
        const facts = {
          errorCode: null,
          providerStatus: outcome.status,
          receiptReceived:
            typeof outcome.receiptReceived === 'boolean' ? outcome.receiptReceived : null,
        };
        if (receiptAcknowledged(outcome)) {
          /*
           * The ONE thing that may open the 24-hour review: decided under the payment's lock,
           * strictly before its deadline, written once. The submission is decided in that
           * same transaction. Should it not run (the scope stopped), nothing is written and
           * the submission is reclaimed with its stamp set — UNKNOWN, and the 70-minute rule
           * stands. That is the conservative failure.
           */
          try {
            await this.deps.payments.recordProviderReview(scope, actor, submission.paymentId, {
              submissionId: submission.id,
              acknowledgedAt: at,
              providerStatus: outcome.status,
              receiptReceived: facts.receiptReceived,
            });
          } catch (error: unknown) {
            this.deps.logger.error(
              {
                paymentId: submission.paymentId,
                error: error instanceof Error ? error.name : 'unknown',
              },
              'a provider acknowledgement could not be recorded',
            );
            return 'DONE';
          }
        }
        // Not acknowledged, or acknowledged too late: recorded, and nothing extends. An
        // acknowledged one was decided in the review's own transaction above.
        await decide('ACCEPTED', facts);
        // Either way the next inquiry is brought forward: only it can approve.
        await this.deps.uow.run(scope, (tx) =>
          this.deps.invoices.requestInquiry(scope, submission.paymentId, at, tx),
        );
        await this.configured(scope, invoice.provider);
        return 'DONE';
      }
      case 'RATE_LIMITED': {
        // Definitely not processed (a 4xx): the same photo is queued again, bounded.
        // Round 11 A8: one the adapter's own limiter held was never sent — queued again when
        // the limiter allows, without spending one of its attempts.
        const held = outcome.notSent === true;
        if (held || submission.attempts + 1 < TONPAYS_TELEGRAM_RECEIPT_MAX_ATTEMPTS) {
          await this.deps.uow.run(scope, (tx) =>
            cards.requeueSubmission(
              scope,
              submission.id,
              outcome.code,
              new Date(
                at.getTime() +
                  (held
                    ? Math.max(GATEWAY_HELD_RETRY_MIN_MS, outcome.retryAfterMs ?? 0)
                    : Math.max(RECEIPT_RATE_LIMIT_RETRY_MS, outcome.retryAfterMs ?? 0)),
              ),
              at,
              tx,
              { notSent: held },
            ),
          );
        } else {
          await decide('ABANDONED', { errorCode: outcome.code });
        }
        return 'DONE';
      }
      case 'REFUSED':
        await decide('REFUSED', { errorCode: outcome.code });
        if (outcome.configuration) await this.misconfigured(scope, invoice, outcome.code);
        return 'DONE';
      case 'NOT_FOUND':
        await decide('REFUSED', { errorCode: outcome.code });
        await this.identityMismatch(scope, invoice, 'INQUIRY');
        return 'DONE';
      case 'UNKNOWN':
        await lost(outcome.code);
        return 'DONE';
    }
  }

  // ---------------------------------------------------------------------------------------
  // The webhook — a hint, never evidence.
  // ---------------------------------------------------------------------------------------

  /**
   * A provider's webhook for `tenantId` (brief §6–§7).
   *
   * It locates the attempt by the provider order id WITHIN the tenant the URL names —
   * never globally — checks a known invoice id agrees, deduplicates on the delivery id,
   * records the hint and brings the next inquiry forward (no sooner than five seconds
   * after the last). That is everything: it never reaches the settlement path, and an
   * unknown tenant, an unknown attempt or a mismatch writes nothing that causes work.
   */
  async receiveWebhook(
    tenantId: string,
    provider: PaymentGatewayProvider,
    body: unknown,
    deliveryIdHeader: string | undefined,
    /** The provider's signature header, read only for a route whose provider signs (§5.6). */
    signatureHeader?: string,
    /**
     * The body's RAW bytes as received (TetraPay signs those, not the parsed JSON). Null or
     * absent verifies nothing: a route with a stored secret then drops the webhook.
     */
    rawBody?: Uint8Array | null,
    /**
     * Round 10 C1: the sender's address as the trusted reverse proxy reported it (Fastify's
     * `request.ip`, never a client-supplied header), for an allow-listed route. Absent: unknown.
     */
    sourceIp?: string,
  ): Promise<GatewayWebhookResult | 'MALFORMED' | 'NO_ADAPTER'> {
    const adapter = this.deps.adapters(provider);
    if (adapter === null) return 'NO_ADAPTER';
    const descriptor = PAYMENT_GATEWAY_DESCRIPTORS[provider];
    // A browser-return route documents no webhook (CentralPay): nothing posted is read.
    if (descriptor.browserReturn) return 'NO_ADAPTER';
    /*
     * Round 10 C1: an allow-listed route's sender is checked FIRST, before its signature or any
     * field (protocol §9.2). Defence in depth: the signature below is still the authentication.
     */
    if (
      descriptor.operatorEndpoint &&
      !(await this.webhookSourceAllowed(tenantId, provider, sourceIp))
    ) {
      return 'IGNORED_SOURCE';
    }
    /*
     * A route whose provider SIGNS its webhooks (NOWPayments): verified against the stored
     * secret, in constant time, BEFORE a single field of the body is read. Unverified is
     * dropped. Verified is still only a hint — it never reaches the settlement path. The custom
     * gateway signs with its ONE credential instead (`webhookSignedByCredential`).
     */
    if (descriptor.webhookSecret || descriptor.webhookSignedByCredential) {
      const verified = await this.verifyWebhook(
        tenantId,
        provider,
        adapter,
        body,
        signatureHeader,
        rawBody ?? null,
      );
      if (verified !== 'VERIFIED' && verified !== 'UNSIGNED') return verified;
    }
    /*
     * Round 9 C4: a provider's dashboard TEST delivery (Rialit's `webhook.test`) names no
     * payment. It is answered like any accepted webhook and nothing else happens — no lookup,
     * no record, no inquiry — so the operator's "send a test" sees a 2xx.
     */
    if (adapter.isWebhookProbe?.(body) === true) return 'IGNORED_TEST';
    // Shape only. TonPays' signature and API-key headers are never read (brief §6).
    const hint = adapter.parseWebhook(body, deliveryIdHeader);
    if (hint === null) return 'MALFORMED';
    return this.applyWebhookHint(tenantId, provider, hint, adapter);
  }

  /**
   * Round 10 C1: whether a callback's sender is on the route's allow-list. No list (or an empty
   * one), or no matcher wired: allowed. A list and no known address: refused, fail closed. A
   * refusal is recorded on the unverified-webhook condition with its own reason, never the address.
   */
  private async webhookSourceAllowed(
    tenantId: string,
    provider: PaymentGatewayProvider,
    sourceIp: string | undefined,
  ): Promise<boolean> {
    const sources = this.deps.webhookSources;
    if (sources === undefined) return true;
    const scope: TenantContext = {
      tenantId: tenantId as TenantContext['tenantId'],
      botInstanceId: null,
    };
    // An unknown or stopped tenant is answered like every other ignored webhook, later.
    if (!(await this.deps.scopeActivity.scopeIsActive(scope))) return true;
    const list = await sources.allowlistFor(scope, provider);
    if (list === null || list.length === 0) return true;
    if (sourceIp !== undefined && list.some((entry) => sources.matches(sourceIp, entry))) {
      return true;
    }
    const codes = webhookConditionCodesOf(provider);
    this.deps.logger.warn({ provider }, 'gateway webhook refused: sender not on the allow-list');
    await this.deps.opsLog.record(scope, {
      code: codes.rejected,
      severity: codes.severity,
      message: codes.rejectedMessage,
      dedupeKey: `${codes.rejected}:${provider}`,
      context: { provider, reason: 'SOURCE_NOT_ALLOWED' },
    });
    return false;
  }

  private async verifyWebhook(
    tenantId: string,
    provider: PaymentGatewayProvider,
    adapter: ExternalGatewayAdapter,
    body: unknown,
    signature: string | undefined,
    rawBody: Uint8Array | null,
  ): Promise<'VERIFIED' | 'UNSIGNED' | 'IGNORED_INACTIVE' | 'IGNORED_UNVERIFIED'> {
    const scope: TenantContext = {
      tenantId: tenantId as TenantContext['tenantId'],
      botInstanceId: null,
    };
    // An unknown or stopped tenant is answered like every other ignored webhook.
    if (!(await this.deps.scopeActivity.scopeIsActive(scope))) return 'IGNORED_INACTIVE';
    let secret: string | null;
    // True only when the read FAILED (a missing key, a damaged ciphertext): that is not "no secret".
    let readFailed = false;
    try {
      // Round 10 C1: the custom gateway's ONE credential signs its callbacks too.
      secret = PAYMENT_GATEWAY_DESCRIPTORS[provider].webhookSignedByCredential
        ? await this.deps.credentials.read(scope, provider)
        : await this.deps.credentials.readWebhookSecret(scope, provider);
    } catch (error: unknown) {
      readFailed = true;
      // A secret that will not decrypt verifies nothing. Never logged beyond its class.
      this.deps.logger.error(
        { provider, error: error instanceof Error ? error.name : 'unknown' },
        'a gateway webhook secret could not be read',
      );
      secret = null;
    }
    /*
     * An OPTIONAL secret (TetraPay) that was never stored: the webhook is an UNAUTHENTICATED
     * hint. That is safe by construction — it only locates the attempt and brings the next
     * verify forward, and nothing a webhook says can settle — so it is accepted, deduplicated
     * and scheduled like any hint, and neither raises nor closes the unverified-webhook
     * condition (there is nothing it could have been verified against).
     */
    if (
      secret === null &&
      !readFailed &&
      PAYMENT_GATEWAY_DESCRIPTORS[provider].webhookSecretOptional
    ) {
      return 'UNSIGNED';
    }
    const verified =
      secret !== null &&
      adapter.verifyWebhook !== undefined &&
      adapter.verifyWebhook(secret, body, signature, { rawBody, now: this.deps.clock.now() });
    const codes = webhookConditionCodesOf(provider);
    const dedupeKey = `${codes.rejected}:${provider}`;
    if (!verified) {
      this.deps.logger.warn(
        { provider, secretStored: secret !== null, signaturePresent: signature !== undefined },
        'gateway webhook dropped: signature not verified',
      );
      await this.deps.opsLog.record(scope, {
        code: codes.rejected,
        severity: codes.severity,
        message: codes.rejectedMessage,
        dedupeKey,
        context: { provider, secretStored: secret !== null },
      });
      return 'IGNORED_UNVERIFIED';
    }
    if (await this.deps.conditions.conditionIsOpen(scope, dedupeKey)) {
      await this.deps.opsLog.record(scope, {
        code: codes.verified,
        severity: 'INFO',
        message: 'A payment gateway notification verified against the stored webhook secret.',
        context: { provider },
        recoversCode: codes.rejected,
        recoversDedupeKey: dedupeKey,
      });
    }
    return 'VERIFIED';
  }

  private async applyWebhookHint(
    tenantId: string,
    provider: PaymentGatewayProvider,
    hint: GatewayWebhookHint,
    adapter: Pick<ExternalGatewayAdapter, 'hintRank'>,
  ): Promise<GatewayWebhookResult> {
    const scope: TenantContext = {
      tenantId: tenantId as TenantContext['tenantId'],
      botInstanceId: null,
    };
    if (!(await this.deps.scopeActivity.scopeIsActive(scope))) return 'IGNORED_INACTIVE';
    const invoice = await this.deps.invoices.findByProviderOrderId(scope, provider, hint.orderId);
    if (invoice === null) return 'IGNORED_UNKNOWN';
    if (
      hint.invoiceId !== null &&
      invoice.providerInvoiceId !== null &&
      invoice.providerInvoiceId !== hint.invoiceId
    ) {
      await this.identityMismatch(scope, invoice, 'WEBHOOK');
      return 'IGNORED_MISMATCH';
    }
    const payment = await this.deps.paymentRecords.findById(scope, invoice.paymentId);
    if (payment === null) return 'IGNORED_UNKNOWN';

    const now = this.deps.clock.now();
    // The effective deadline (§9.6.3 d, §9.6.5): a webhook never opens, extends or ends a review.
    const deadline = gatewaySettlementDeadline(payment);
    const eligible =
      payment.state === 'PENDING' && deadline !== null && now.getTime() < deadline.getTime();
    const earliest =
      invoice.lastInquiryAt === null
        ? now
        : new Date(
            Math.max(now.getTime(), invoice.lastInquiryAt.getTime() + INQUIRY_MIN_SPACING_MS),
          );
    // A created invoice, or a create whose answer was lost — which the webhook may name.
    const askable =
      invoice.creationState === 'CREATED' || invoice.creationState === 'CREATE_UNKNOWN';
    // R5A item 4: with the route's late-credit switch ON, the window — not the count — bounds it.
    const lateCredit = await this.lateCreditPolicy(scope, invoice.provider);
    const lateWindowOpen =
      lateCredit.enabled &&
      invoice.outcome === null &&
      lateCreditPollingOpen({
        state: payment.state,
        now,
        deadline,
        windowMs: lateCredit.windowMs,
      });
    let inquireAt: Date | null = null;
    if (askable && invoice.outcome === null && eligible) {
      inquireAt = earliest;
    } else if (
      askable &&
      !eligible &&
      payment.state !== 'CONFIRMED' &&
      invoice.lateCompletionObservedAt === null &&
      (invoice.postDeadlineInquiries < POST_DEADLINE_INQUIRY_MAX || lateWindowOpen)
    ) {
      // Diagnostics only: whether the provider now says a closed attempt was paid.
      inquireAt = earliest;
    }
    /*
     * Codex review of #141 (P1): an invoice that can carry several payments keeps its hint on
     * the STRONGEST one. A webhook about another payment moves the hint only when its status
     * is at least as strong as what the hinted payment last showed — its last inquiry and its
     * last webhook — so a later `waiting` never displaces a `finished` before the worker reads
     * it. A webhook that does not move the hint leaves the hint's status as it was too, so the
     * stored status keeps describing the hinted payment. The next inquiry is brought forward
     * either way, and the invoice-wide list is read whenever the hinted payment is not decisive.
     */
    const rank = adapter.hintRank?.bind(adapter);
    const movesHint =
      hint.paymentId === undefined ||
      hint.paymentId === null ||
      invoice.hintedPaymentId === null ||
      hint.paymentId === invoice.hintedPaymentId ||
      rank === undefined ||
      rank(hint.status) >= Math.max(rank(invoice.providerStatus), rank(invoice.webhookStatusHint));
    /*
     * R9 C1: a `credit_amount` that is neither the principal nor what Nexa invoiced is raised to
     * the operations log — once per new figure, in the transaction that records it, so a
     * repeated delivery (deduped by its id) or the same figure again raises nothing. It is
     * NEVER credited: the wallet is credited with the principal, by the inquiry
     * (`domain/credit-amount.ts` records why).
     */
    const creditDiffers =
      hint.creditAmount !== null &&
      creditAmountDiffers({
        creditAmount: hint.creditAmount,
        sentAmount: invoice.sentAmount,
        principalInProviderUnit: principalInProviderUnit(payment.amount, invoice.providerUnit),
        providerFinalAmount: invoice.finalAmount,
      });
    const recorded = await this.deps.uow.run(scope, async (tx) => {
      /*
       * The stored figure read under the invoice row's lock, BEFORE this delivery writes its
       * own: two deliveries carrying the same new figure at once are serialised here, and the
       * second sees the first's figure — one alert, not two.
       */
      const locked =
        creditDiffers && this.deps.invoices.creditAmountForUpdate !== undefined
          ? await this.deps.invoices.creditAmountForUpdate(scope, invoice.paymentId, tx)
          : undefined;
      const storedCredit = locked === undefined ? invoice.creditAmount : locked;
      const raiseCredit = creditDiffers && storedCredit !== hint.creditAmount;
      const kept = await this.deps.invoices.recordWebhook(
        scope,
        invoice.paymentId,
        {
          status: movesHint ? hint.status : invoice.webhookStatusHint,
          deliveryId: hint.deliveryId,
          creditAmount: hint.creditAmount,
          hintedInvoiceId:
            invoice.creationState === 'CREATE_UNKNOWN' && invoice.providerInvoiceId === null
              ? hint.invoiceId
              : null,
          // Only for a VERIFIED webhook whose ids matched above: what the next inquiry reads.
          hintedPaymentId: movesHint ? (hint.paymentId ?? null) : null,
          inquireAt,
        },
        now,
        tx,
      );
      // A stopped scope accepts no new work: the figure is recorded, the alert is not raised.
      if (kept && raiseCredit && (await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
        await this.deps.outbox.write(tx, this.actor(), {
          eventType: 'GatewayPaymentAttentionRaised',
          aggregateType: 'Payment',
          aggregateId: invoice.paymentId,
          payload: {
            customerId: payment.customerId,
            orderId: payment.orderId,
            provider: invoice.provider,
            reason: 'CREDIT_AMOUNT_MISMATCH',
          },
        });
      }
      return kept;
    });
    if (!recorded) return 'DUPLICATE';
    this.deps.logger.info(
      { paymentId: invoice.paymentId, provider, scheduled: inquireAt !== null },
      'gateway webhook recorded as a hint',
    );
    return inquireAt === null ? 'RECORDED' : 'SCHEDULED';
  }

  // ---------------------------------------------------------------------------------------
  // The customer's own reads.
  // ---------------------------------------------------------------------------------------

  /**
   * The gateway side of a payment the caller has ALREADY been authorized to read (the
   * Web Admin's detail charges `payments.view` through `PaymentService.get` first). Null
   * for a payment with no gateway invoice.
   */
  async invoiceForPayment(
    scope: TenantContext,
    paymentId: PaymentId,
  ): Promise<GatewayInvoiceRecord | null> {
    return this.deps.invoices.findByPayment(scope, paymentId);
  }

  /**
   * A card-transfer attempt's card-change and receipt facts, for the customer's screen and
   * the operator's detail (§8.1, §10). Null for any other route, or with no such lane.
   */
  async cardFactsFor(
    scope: TenantContext,
    invoice: Pick<
      GatewayInvoiceRecord,
      'paymentId' | 'provider' | 'botInstanceId' | 'creationState' | 'creationErrorCode'
    >,
  ): Promise<GatewayCardFacts | null> {
    const cards = this.deps.cardTransfer;
    if (
      cards === undefined ||
      PAYMENT_GATEWAY_DESCRIPTORS[invoice.provider].invoiceForm !== 'CARD_TRANSFER'
    ) {
      return null;
    }
    const requests = this.deps.providerRequests;
    const [latestChange, submissions, providerFacts, latestCancel, latestRefund] =
      await Promise.all([
        cards.latestCardChange(scope, invoice.paymentId),
        cards.submissionsFor(scope, invoice.paymentId),
        requests?.factsFor(scope, invoice.paymentId) ?? Promise.resolve(null),
        requests?.latest(scope, invoice.paymentId, 'CANCEL') ?? Promise.resolve(null),
        requests?.latest(scope, invoice.paymentId, 'REFUND') ?? Promise.resolve(null),
      ]);
    /*
     * A create the provider refused because the buyer already holds an open invoice: point at
     * the customer's OTHER open attempt, if Nexa knows of one, so the screen can open it.
     */
    let openElsewherePaymentId: string | null = null;
    if (
      requests !== undefined &&
      invoice.creationState === 'CREATE_FAILED' &&
      isBuyerConflictCode(invoice.creationErrorCode) &&
      invoice.botInstanceId !== null
    ) {
      const payment = await this.deps.paymentRecords.findById(scope, invoice.paymentId);
      if (payment !== null) {
        const siblings = await requests.siblingAttempts(scope, {
          customerId: payment.customerId,
          provider: invoice.provider,
          botInstanceId: invoice.botInstanceId,
          exceptPaymentId: invoice.paymentId,
          now: this.deps.clock.now(),
          // The invoice that blocked the create may be inside its review window.
          includeReview: true,
        });
        openElsewherePaymentId = siblings[0]?.paymentId ?? null;
      }
    }
    return {
      latestChange,
      submissions,
      providerFacts,
      ...(providerFacts === null || this.deps.rejectReasonText === undefined
        ? {}
        : { rejectReasonsShown: providerFacts.rejectReasons.map(this.deps.rejectReasonText) }),
      latestCancel,
      latestRefund,
      openElsewherePaymentId,
      changeAllowance: await this.changeAllowanceFor(scope, invoice.paymentId),
    };
  }

  /**
   * R8 A2: the owner's card-switch limits with this payment's use of them, for drawing the
   * card-change button. A courtesy read outside any transaction: the tap re-reads both under
   * the payment's lock. A settings read that fails hides the button (null + no limits would
   * offer one the owner may have switched off), so it answers "used up" rather than throw.
   */
  private async changeAllowanceFor(
    scope: TenantContext,
    paymentId: PaymentId,
  ): Promise<CardChangeAllowance | null> {
    const settings = this.deps.cardSwitchSettings;
    const cards = this.deps.cardTransfer;
    if (settings === undefined || cards === undefined) return null;
    try {
      return {
        limits: await readCardSwitchLimits(settings, scope),
        ...(await cards.cardChangeUsage(scope, paymentId)),
      };
    } catch (error: unknown) {
      this.deps.logger.error(
        { paymentId, ...errorFacts(error) },
        'the card-switch limits could not be read; the card-change button is not drawn',
      );
      return {
        limits: { maxSwitches: 0, cooldownSeconds: 0, maxDistinctCards: 1 },
        switches: 0,
        lastSwitchAt: null,
        distinctCards: 1,
      };
    }
  }

  /** The attempt, if it is this customer's GATEWAY payment. Null otherwise — never another's. */
  async attemptFor(
    scope: TenantContext,
    customerId: UserId,
    paymentId: string,
  ): Promise<GatewayAttemptView | null> {
    const payment = await this.deps.paymentRecords.findById(scope, paymentId as PaymentId);
    if (payment === null || payment.customerId !== customerId || payment.method !== 'GATEWAY') {
      return null;
    }
    const invoice = await this.deps.invoices.findByPayment(scope, payment.id);
    return invoice === null ? null : { payment, invoice };
  }

  /**
   * The customer's check tap: bring the next inquiry forward, no sooner than five
   * seconds after the last. A database write only — the provider is asked by the worker.
   */
  async requestCheck(scope: TenantContext, view: GatewayAttemptView): Promise<void> {
    const now = this.deps.clock.now();
    const deadline = gatewaySettlementDeadline(view.payment);
    if (
      // A provider that pushes its payments (Stars) has nothing to ask: the tap only
      // re-reads the attempt's state, which the caller renders.
      PAYMENT_GATEWAY_DESCRIPTORS[view.invoice.provider].approval !== 'INQUIRY' ||
      view.payment.state !== 'PENDING' ||
      deadline === null ||
      now.getTime() >= deadline.getTime() ||
      view.invoice.creationState !== 'CREATED'
    ) {
      return;
    }
    // In review a customer cannot spend the budget: a minute apart (§9.6.5).
    const spacing =
      view.payment.providerReviewUntil === null
        ? INQUIRY_MIN_SPACING_MS
        : TONPAYS_TELEGRAM_REVIEW_CHECK_SPACING_MS;
    const at =
      view.invoice.lastInquiryAt === null
        ? now
        : new Date(Math.max(now.getTime(), view.invoice.lastInquiryAt.getTime() + spacing));
    await this.deps.uow.run(scope, (tx) =>
      this.deps.invoices.requestInquiry(scope, view.payment.id, at, tx),
    );
    // FIX-01 evidence: tells a tap from a browser return when a settlement says CUSTOMER_HINT.
    this.deps.logger.info(
      { paymentId: view.payment.id, provider: view.invoice.provider },
      'gateway status check brought an inquiry forward',
    );
  }

  // ---------------------------------------------------------------------------------------
  // The browser return — a hint, never evidence (CentralPay, `docs/centralpay-gateway-audit.md`
  // §5.6).
  // ---------------------------------------------------------------------------------------

  /**
   * The customer's browser came back from the provider's page to the return URL Nexa
   * generated for `tenantId`, naming `orderIdParam` (a GET: it carries no payment data).
   *
   * It proves NOTHING. It locates the attempt by the provider order id WITHIN the tenant the
   * URL names, and:
   *
   * - an attempt already decided (settled, failed, expired, held, recorded late) is answered
   *   from its LOCAL state and nothing is asked — a repeated return can never verify, settle
   *   or credit again;
   * - an open attempt has its next verify brought forward (no sooner than five seconds after
   *   the last, under the worker's call budget) — a database write only; the worker asks
   *   the provider and only its answer reaches the settlement path;
   * - after the deadline, at most the bounded diagnostic verifies a webhook may trigger.
   *
   * The answer is what the result page needs and nothing about any other attempt: an unknown
   * tenant, order or route is `UNKNOWN`, indistinguishable from a closed attempt to a caller.
   */
  async receiveBrowserReturn(
    tenantId: string,
    provider: PaymentGatewayProvider,
    orderIdParam: string | undefined,
  ): Promise<BrowserReturnResult> {
    const state = await this.browserReturnState(tenantId, provider, orderIdParam);
    const scope: TenantContext = {
      tenantId: tenantId as TenantContext['tenantId'],
      botInstanceId: null,
    };
    /*
     * The link depends on the TENANT only, never on whether the order exists, so where the
     * browser is sent says nothing about which attempts exist.
     */
    const botLink =
      this.deps.botLinkFor === undefined || !(await this.deps.scopeActivity.scopeIsActive(scope))
        ? null
        : await this.deps.botLinkFor(scope);
    return { state, botLink };
  }

  private async browserReturnState(
    tenantId: string,
    provider: PaymentGatewayProvider,
    orderIdParam: string | undefined,
  ): Promise<BrowserReturnState> {
    if (!PAYMENT_GATEWAY_DESCRIPTORS[provider].browserReturn) return 'UNKNOWN';
    if (orderIdParam === undefined || !/^[0-9]{1,20}$/u.test(orderIdParam)) return 'UNKNOWN';
    const scope: TenantContext = {
      tenantId: tenantId as TenantContext['tenantId'],
      botInstanceId: null,
    };
    if (!(await this.deps.scopeActivity.scopeIsActive(scope))) return 'UNKNOWN';
    const invoice = await this.deps.invoices.findByProviderOrderId(scope, provider, orderIdParam);
    if (invoice === null) return 'UNKNOWN';
    const payment = await this.deps.paymentRecords.findById(scope, invoice.paymentId);
    if (payment === null) return 'UNKNOWN';
    if (payment.state === 'CONFIRMED') return 'CONFIRMED';
    const now = this.deps.clock.now();
    const deadline = gatewaySettlementDeadline(payment);
    const eligible =
      payment.state === 'PENDING' && deadline !== null && now.getTime() < deadline.getTime();
    const askable =
      invoice.creationState === 'CREATED' &&
      invoice.outcome === null &&
      payment.state !== 'UNKNOWN';
    const diagnostic =
      !eligible &&
      askable &&
      invoice.lateCompletionObservedAt === null &&
      invoice.postDeadlineInquiries < POST_DEADLINE_INQUIRY_MAX;
    if (askable && (eligible || diagnostic)) {
      const at =
        invoice.lastInquiryAt === null
          ? now
          : new Date(
              Math.max(now.getTime(), invoice.lastInquiryAt.getTime() + INQUIRY_MIN_SPACING_MS),
            );
      await this.deps.uow.run(scope, (tx) =>
        this.deps.invoices.requestInquiry(scope, invoice.paymentId, at, tx),
      );
      this.deps.logger.info(
        { paymentId: invoice.paymentId, provider, eligible },
        'gateway browser return brought a verify forward',
      );
    }
    return eligible ? 'CHECKING' : 'CLOSED';
  }

  // ---------------------------------------------------------------------------------------

  /**
   * The provider's daily limit (TetraPay): the route is hidden until the next 00:00 Tehran, by
   * the PROVIDER's word and not the operator's — `status` is untouched, and nothing clears the
   * hiding but the clock. Best effort after the attempt's own outcome committed: a failure here
   * leaves the route offered and the next refusal tries again.
   */
  private async hideRouteUntilTehranMidnight(
    scope: TenantContext,
    actor: ActorContext,
    invoice: GatewayInvoiceRecord,
    reason: string,
  ): Promise<void> {
    const visibility = this.deps.routeVisibility;
    if (visibility === undefined) return;
    const now = this.deps.clock.now();
    const until = nextTehranMidnight(now);
    try {
      await this.deps.uow.run(scope, async (tx) => {
        await visibility.hideUntil(scope, invoice.provider, until, now, tx);
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'payment_gateway.hidden_by_provider',
            entityType: 'PaymentGateway',
            entityId: invoice.provider,
            before: null,
            after: { provider: invoice.provider, hiddenUntil: until.toISOString(), reason },
            result: 'SUCCESS',
          },
          tx,
        );
      });
    } catch (error: unknown) {
      this.deps.logger.error(
        { provider: invoice.provider, ...errorFacts(error) },
        'a provider daily limit could not be recorded on its route',
      );
    }
  }

  private async endCreation(
    scope: TenantContext,
    actor: ActorContext,
    invoice: GatewayInvoiceRecord,
    to: 'CREATE_FAILED' | 'CREATE_UNKNOWN',
    code: string,
    /** A payment the provider made and Nexa refused to present (Rialit's double fee), or null. */
    refusedProviderInvoiceId: string | null = null,
  ): Promise<void> {
    const now = this.deps.clock.now();
    await this.deps.uow.run(scope, async (tx) => {
      const moved = await this.deps.invoices.recordCreationEnded(
        scope,
        invoice.paymentId,
        to,
        code,
        now,
        tx,
      );
      if (!moved) return;
      await this.deps.audit.record(
        scope,
        actor,
        {
          action:
            to === 'CREATE_FAILED'
              ? 'gateway_invoice.create_failed'
              : 'gateway_invoice.create_unknown',
          entityType: 'Payment',
          entityId: invoice.paymentId,
          before: { creationState: 'CREATING' },
          after: {
            creationState: to,
            provider: invoice.provider,
            providerOrderId: invoice.providerOrderId,
            reason: code,
            ...(refusedProviderInvoiceId === null
              ? {}
              : { refusedProviderInvoiceId, paymentLinkShown: false }),
          },
          result: 'SUCCESS',
        },
        tx,
      );
    });
  }

  private async lateCompletion(
    scope: TenantContext,
    actor: ActorContext,
    invoice: GatewayInvoiceRecord,
    reason: string,
  ): Promise<void> {
    const now = this.deps.clock.now();
    await this.deps.uow.run(scope, async (tx) => {
      const first = await this.deps.invoices.markLateCompletion(scope, invoice.paymentId, now, tx);
      await this.deps.invoices.recordOutcome(scope, invoice.paymentId, 'LATE_COMPLETION', now, tx);
      if (!first) return;
      await this.deps.audit.record(
        scope,
        actor,
        {
          action: 'gateway_invoice.late_completion',
          entityType: 'Payment',
          entityId: invoice.paymentId,
          before: null,
          after: {
            provider: invoice.provider,
            providerOrderId: invoice.providerOrderId,
            providerInvoiceId: invoice.providerInvoiceId ?? invoice.hintedInvoiceId,
            reason,
            settled: false,
          },
          result: 'SUCCESS',
        },
        tx,
      );
      await this.deps.opsLog.record(
        scope,
        {
          code: GATEWAY_LATE_COMPLETION_CODE,
          severity: 'WARN',
          message:
            'A payment gateway reported a paid invoice for an attempt this installation can no ' +
            'longer settle. Nothing was settled or credited automatically.',
          dedupeKey: `${GATEWAY_LATE_COMPLETION_CODE}:${invoice.paymentId}`,
          context: {
            paymentId: invoice.paymentId,
            provider: invoice.provider,
            providerOrderId: invoice.providerOrderId,
            reason,
          },
        },
        tx,
      );
      /*
       * And the financial log (WP18). Once, with the audit row — `first` is the same
       * conditional stamp that keeps a second inquiry from writing either. The payment
       * row is read for its customer and order; the event carries ids only.
       */
      const payment = await this.deps.paymentRecords.findById(scope, invoice.paymentId, tx);
      if (payment !== null) {
        await this.deps.outbox.write(tx, actor, {
          eventType: 'PaymentLateCompletionObserved',
          aggregateType: 'Payment',
          aggregateId: invoice.paymentId,
          payload: {
            customerId: payment.customerId,
            orderId: payment.orderId,
            provider: invoice.provider,
          },
        });
      }
    });
  }

  /**
   * FIX-04: tells the operations log that this attempt's payment link could not be made.
   *
   * ONE place, called from every exit of `processCreation` that leaves the customer without
   * a usable invoice, after that exit's own outcome has committed. Best effort by
   * construction: the reads and the write are each allowed to fail, and none of them can
   * change what the lane already decided or stop the next attempt in the pass.
   */
  private async reportLinkFailure(
    scope: TenantContext,
    claimed: ClaimedGatewayInvoice,
    failure: PaymentLinkFailure | null,
    known: {
      readonly elapsedMs?: number;
      readonly providerInvoiceId?: string;
      /** The customer's Telegram id when the caller already read it; read here otherwise. */
      readonly telegramUserId?: string | null;
    } = {},
  ): Promise<void> {
    if (failure === null) return;
    const { invoice } = claimed;
    let event;
    try {
      const payment = await this.deps.paymentRecords.findById(scope, invoice.paymentId);
      const telegramUserId =
        known.telegramUserId !== undefined
          ? known.telegramUserId
          : ((await this.deps.customers.findById(scope, claimed.customerId as UserId))
              ?.telegramUserId ?? null);
      event = paymentLinkFailureEvent(failure, {
        provider: invoice.provider,
        paymentId: invoice.paymentId,
        orderId: payment?.orderId ?? null,
        providerOrderId: invoice.providerOrderId,
        providerInvoiceId: known.providerInvoiceId ?? invoice.providerInvoiceId,
        // The public code the customer's invoice shows (FIX-02), never the stored
        // `<code>:<role>` reference — an operator matches the two by eye.
        trackingCode: payment === null ? null : paymentTrackingCode(payment),
        telegramUserId,
        customerId: claimed.customerId,
        amount:
          payment === null
            ? null
            : { amountMinor: payment.amount.amountMinor, currency: payment.amount.currency },
        botInstanceId: invoice.botInstanceId,
        elapsedMs: known.elapsedMs ?? null,
        at: this.deps.clock.now(),
      });
    } catch (error: unknown) {
      this.deps.logger.warn(
        { paymentId: invoice.paymentId, error: error instanceof Error ? error.name : 'unknown' },
        'payment link failure could not be described for the operations log',
      );
      return;
    }
    await recordQuietly(this.deps.opsLog, scope, event, this.deps.logger);
  }

  private async misconfigured(
    scope: TenantContext,
    invoice: GatewayInvoiceRecord,
    code: string,
  ): Promise<void> {
    await this.deps.opsLog.record(scope, misconfiguredEvent(invoice.provider, code));
  }

  /** A failed inquiry (FAILED or RATE_LIMITED), counted per gateway. Never throws. */
  private async inquiryFailed(
    scope: TenantContext,
    provider: PaymentGatewayProvider,
    kind: 'FAILED' | 'RATE_LIMITED',
    errorCode: string,
    at: Date,
  ): Promise<void> {
    if (!this.inquiryHealth.failure(provider, at.getTime())) return;
    const recorded = await recordQuietly(
      this.deps.opsLog,
      scope,
      {
        code: GATEWAY_INQUIRY_FAILING_CODE,
        severity: 'WARN',
        message:
          'The payment gateway keeps failing to answer inquiries, so approvals cannot be read. ' +
          'Payments stay pending and are asked again until their deadline.',
        dedupeKey: `${GATEWAY_INQUIRY_FAILING_CODE}:${provider}`,
        context: { provider, reason: kind, errorCode },
      },
      this.deps.logger,
    );
    // Only a WRITTEN record holds the next one off (Codex P2 on #260): `recordQuietly`
    // swallows a failure, and marking it recorded anyway silenced the outage for a window.
    if (recorded !== null) this.inquiryHealth.recorded(provider, at.getTime());
  }

  /**
   * The inquiry could not be authorised: no key to ask with, or the provider refused the
   * one it was given (Codex P1 on #260).
   *
   * For a route whose inquiry uses the SAME credential as its create (TonPays), this is the
   * route's one `payments.gateway_misconfigured` condition, and a create that succeeds proves
   * the key and closes it. For a route whose inquiry is authorised by a SEPARATE verify key
   * (CentralPay), it is a condition of its own — same code, its own subject — because a
   * create made with the link key proves nothing about the verify key, and closing the alarm
   * on it would clear the one signal that no approval can be read. That subject is closed
   * only by an inquiry the provider answered (`inquiryAnswered`).
   */
  private async inquiryMisconfigured(
    scope: TenantContext,
    provider: PaymentGatewayProvider,
    code: string,
  ): Promise<void> {
    if (!PAYMENT_GATEWAY_DESCRIPTORS[provider].verifyKey) {
      await recordQuietly(
        this.deps.opsLog,
        scope,
        misconfiguredEvent(provider, code),
        this.deps.logger,
      );
      return;
    }
    const recorded = await recordQuietly(
      this.deps.opsLog,
      scope,
      {
        ...misconfiguredEvent(provider, code),
        message:
          'The payment gateway could not be asked about payments: its verify key is missing or ' +
          'was refused, so no approval can be read. Check the verify key.',
        dedupeKey: inquiryCredentialConditionKey(provider),
        context: { provider, reason: code, kind: 'VERIFY_KEY' },
      },
      this.deps.logger,
    );
    // The next answered inquiry looks for it at once, not a recheck later.
    if (recorded !== null) this.inquiryHealth.forgetCheck(provider);
  }

  /** An answered inquiry: closes the failing condition when one is open. Never throws. */
  private async inquiryAnswered(
    scope: TenantContext,
    provider: PaymentGatewayProvider,
    at: Date,
  ): Promise<void> {
    if (!this.inquiryHealth.success(provider, at.getTime())) return;
    const dedupeKey = `${GATEWAY_INQUIRY_FAILING_CODE}:${provider}`;
    const credentialKey = PAYMENT_GATEWAY_DESCRIPTORS[provider].verifyKey
      ? inquiryCredentialConditionKey(provider)
      : null;
    let open: boolean;
    let credentialOpen: boolean;
    try {
      open = await this.deps.conditions.conditionIsOpen(scope, dedupeKey);
      credentialOpen =
        credentialKey !== null &&
        (await this.deps.conditions.conditionIsOpen(scope, credentialKey));
    } catch (error: unknown) {
      this.deps.logger.warn(
        { provider, error: error instanceof Error ? error.name : 'unknown' },
        'could not read the inquiry condition; it is checked again on a later answer',
      );
      this.inquiryHealth.forgetCheck(provider);
      return;
    }
    if (credentialOpen && credentialKey !== null) {
      // The verify key worked: the provider answered an inquiry authorised by it.
      const closed = await recordQuietly(
        this.deps.opsLog,
        scope,
        {
          code: GATEWAY_CONFIGURED_CODE,
          severity: 'INFO',
          message: 'The payment gateway is answering inquiries with this installation’s key again.',
          context: { provider, kind: 'VERIFY_KEY' },
          recoversCode: GATEWAY_MISCONFIGURED_CODE,
          recoversDedupeKey: credentialKey,
        },
        this.deps.logger,
      );
      if (closed === null) this.inquiryHealth.forgetCheck(provider);
    }
    if (!open) return;
    await recordQuietly(
      this.deps.opsLog,
      scope,
      {
        code: GATEWAY_INQUIRY_OK_CODE,
        severity: 'INFO',
        message: 'The payment gateway is answering inquiries again.',
        context: { provider },
        recoversCode: GATEWAY_INQUIRY_FAILING_CODE,
        recoversDedupeKey: dedupeKey,
      },
      this.deps.logger,
    );
  }

  private async configured(scope: TenantContext, provider: PaymentGatewayProvider): Promise<void> {
    const dedupeKey = `${GATEWAY_MISCONFIGURED_CODE}:${provider}`;
    if (!(await this.deps.conditions.conditionIsOpen(scope, dedupeKey))) return;
    await this.deps.opsLog.record(scope, {
      code: GATEWAY_CONFIGURED_CODE,
      severity: 'INFO',
      message: 'The payment gateway is accepting this installation’s invoices again.',
      context: { provider },
      recoversCode: GATEWAY_MISCONFIGURED_CODE,
      recoversDedupeKey: dedupeKey,
    });
  }

  /**
   * Audit P2-b on #260: the lane decided this payment, so a "could not be settled, nothing
   * was credited" alarm open for it is no longer true. Only an OPEN condition is answered
   * (a decision with no earlier refusal records nothing), and never a failure of the pass:
   * the decision has already committed.
   */
  private async settlementDecided(scope: TenantContext, paymentId: PaymentId): Promise<void> {
    const dedupeKey = `${GATEWAY_SETTLEMENT_FAILED_CODE}:${paymentId}`;
    try {
      if (!(await this.deps.conditions.conditionIsOpen(scope, dedupeKey))) return;
    } catch (error: unknown) {
      this.deps.logger.warn(
        { paymentId, error: error instanceof Error ? error.name : 'unknown' },
        'a settlement alarm could not be checked; it is closed by the next decision',
      );
      return;
    }
    await recordQuietly(
      this.deps.opsLog,
      scope,
      {
        code: GATEWAY_SETTLEMENT_DECIDED_CODE,
        severity: 'INFO',
        message: 'The payment the gateway approved has now been decided.',
        context: { paymentId },
        recoversCode: GATEWAY_SETTLEMENT_FAILED_CODE,
        recoversDedupeKey: dedupeKey,
      },
      this.deps.logger,
    );
  }

  private async identityMismatch(
    scope: TenantContext,
    invoice: GatewayInvoiceRecord,
    source: 'INQUIRY' | 'WEBHOOK',
  ): Promise<void> {
    await this.deps.opsLog.record(scope, {
      code: GATEWAY_IDENTITY_MISMATCH_CODE,
      severity: 'WARN',
      message:
        'A payment gateway answer named an invoice or order that does not belong to the attempt ' +
        'it was about. It was ignored.',
      dedupeKey: `${GATEWAY_IDENTITY_MISMATCH_CODE}:${invoice.paymentId}`,
      context: { paymentId: invoice.paymentId, provider: invoice.provider, source },
    });
  }
}

/**
 * Codex #265 (2): which component sends the customer's FINAL message for a settled payment.
 * A top-up's `WALLET_TOPUP_CREDITED` is enqueued in the settling transaction and sent by the
 * customer notification lane. An order that CREATES a service is delivered by the provisioner
 * directly, in the tick that creates it. An order that acts on an existing service (a renewal,
 * an add-on, extra devices, a location change) is run by the provisioner as a commercial
 * operation, and its result (`SERVICE_RENEWED` / `SERVICE_ACTION_SUCCEEDED`) is queued by the
 * operation outcome announcer for the notification lane — both waits apply.
 */
export function finalMessagePath(
  isTopup: boolean,
  orderPurpose: OrderPurpose | null,
): 'NOTIFICATION_LANE' | 'PROVISIONER' | 'PROVISIONER_THEN_NOTIFICATION_LANE' | 'UNKNOWN' {
  if (isTopup) return 'NOTIFICATION_LANE';
  if (orderPurpose === null) return 'UNKNOWN';
  return orderPurposeCreatesNewService(orderPurpose)
    ? 'PROVISIONER'
    : 'PROVISIONER_THEN_NOTIFICATION_LANE';
}

/**
 * The subject of `payments.gateway_misconfigured` for a route's SEPARATE inquiry credential
 * (a descriptor with `verifyKey`; Codex P1 on #260). Same code, its own condition: opened by
 * an inquiry that could not be authorised, closed only by one the provider answered — never
 * by a create, which uses the other key. One function: the format IS the identity.
 */
export function inquiryCredentialConditionKey(provider: PaymentGatewayProvider): string {
  return `${GATEWAY_MISCONFIGURED_CODE}:${provider}:verify-key`;
}

/**
 * The `payments.gateway_misconfigured` event, one shape for every site that opens it — the
 * create path, the inquiry's CONFIGURATION answer, and (FIX-03, batch 2026-10-10) an inquiry
 * whose route has no key to ask with.
 */
function misconfiguredEvent(provider: PaymentGatewayProvider, code: string): OperationalEventInput {
  return {
    code: GATEWAY_MISCONFIGURED_CODE,
    severity: 'ERROR',
    message:
      'The payment gateway refused this installation’s configuration. Customers are told the ' +
      'method is unavailable; check the API key and the gateway account.',
    dedupeKey: `${GATEWAY_MISCONFIGURED_CODE}:${provider}`,
    context: { provider, reason: code },
  };
}
