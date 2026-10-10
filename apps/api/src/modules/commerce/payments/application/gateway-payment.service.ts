import {
  GATEWAY_RETURN_PATH_PREFIX,
  PAYMENT_GATEWAY_DESCRIPTORS,
  TONPAYS_TELEGRAM_RECEIPT_MAX_ATTEMPTS,
  TONPAYS_TELEGRAM_REVIEW_CHECK_SPACING_MS,
  TONPAYS_TELEGRAM_REVIEW_WINDOW_MS,
  paymentTrackingCode,
  systemJobActor,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type CorrelationId,
  type IdGenerator,
  type OperationalEventRecorder,
  type PaymentGatewayProvider,
  type PaymentId,
  type TenantContext,
  type UnitOfWork,
  type UserId,
} from '@nexa/contracts';
import type { OutboxWriter } from '../../../platform/eventing/infrastructure/outbox-writer.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { CustomerRepository } from '../../customers/application/ports.js';
import {
  FIRST_INQUIRY_DELAY_MS,
  INQUIRY_MIN_SPACING_MS,
  POST_DEADLINE_INQUIRY_MAX,
  TONPAYS_CREATE_MAX_ATTEMPTS,
  TONPAYS_CREATE_RETRY_MS,
  inquiryBackoffMs,
} from '../domain/tonpays.js';
import { gatewaySettlementDeadline } from '../domain/settlement.js';
import {
  receiptAcknowledged,
  reviewInquiryNextAt,
  sniffReceiptImage,
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
  GatewayWebhookHint,
} from './gateway-invoice-ports.js';
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
import { recordQuietly } from '../../../platform/opslog/application/error-events.js';

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

/** How long a claimed row is held before another replica may take it. */
export const GATEWAY_CLAIM_LEASE_MS = 60_000;
/** Rows per pass, per queue. Small: every one of them is a call to a third party. */
export const GATEWAY_CREATE_BATCH = 5;
export const GATEWAY_INQUIRY_BATCH = 10; /** TonPays Telegram: card changes and receipt uploads per pass; review and window sweeps. */
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
  };
  /**
   * CentralPay's browser return (§5.6): the tenant's bot as a `https://t.me/<username>` link
   * the result redirects to, from the stored bot row (no Telegram call on a public GET), or
   * null. Absent, the return answers without a link.
   */
  readonly botLinkFor?: (scope: TenantContext) => Promise<string | null>;
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
  readonly budgetExhausted: boolean;
  /** TonPays Telegram: payments whose review lapsed (UNKNOWN), card changes, receipts. */
  readonly reviewsLapsed: number;
  readonly cardChanges: number;
  readonly receipts: number;
  /** NOWPayments: attempts whose coins were seen (review opened) or held for a MISMATCH. */
  readonly reviewsOpened: number;
  readonly held: number;
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
  | 'IGNORED_UNVERIFIED';

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
  constructor(private readonly deps: GatewayPaymentServiceDeps) {}

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
      budgetExhausted: false,
      reviewsLapsed: 0,
      cardChanges: 0,
      receipts: 0,
      reviewsOpened: 0,
      held: 0,
    };
    // A stopped tenant's rows simply wait, and nothing about them is sent anywhere.
    if (!(await this.deps.scopeActivity.scopeIsActive(scope))) return report;
    const now = this.deps.clock.now();
    const actor = this.actor();

    const creationLease = new Date(now.getTime() + GATEWAY_CLAIM_LEASE_MS);
    const creating = await this.deps.uow.run(scope, (tx) =>
      this.deps.invoices.claimCreating(
        scope,
        now,
        GATEWAY_CLAIM_LEASE_MS,
        GATEWAY_CREATE_BATCH,
        tx,
      ),
    );
    for (const [index, claimed] of creating.entries()) {
      const result = await this.processCreation(scope, actor, claimed);
      if (result === 'BUDGET') {
        report.budgetExhausted = true;
        // The deferred row cleared its own lease; the rows not reached give theirs back.
        await this.releaseUnreached(scope, 'CREATION', creating.slice(index + 1), creationLease);
        break;
      }
      report[result] += 1;
      // R2: the invoice is ready, refused or unknown — the waiting message shows it now.
      if (result !== 'createDeferred') await this.refreshScreens(scope, claimed.invoice.paymentId);
    }

    if (!report.budgetExhausted) {
      const inquiryNow = this.deps.clock.now();
      const inquiryLease = new Date(inquiryNow.getTime() + GATEWAY_CLAIM_LEASE_MS);
      const due = await this.deps.uow.run(scope, (tx) =>
        this.deps.invoices.claimInquiries(
          scope,
          inquiryNow,
          GATEWAY_CLAIM_LEASE_MS,
          GATEWAY_INQUIRY_BATCH,
          tx,
        ),
      );
      for (const [index, claimed] of due.entries()) {
        const result = await this.processInquiry(scope, actor, claimed);
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
        report.inquired += 1;
        if (result === 'SETTLED') report.settled += 1;
        if (result === 'UNSUCCESSFUL') report.unsuccessful += 1;
        if (result === 'LATE') report.lateCompletions += 1;
        if (result === 'REVIEW') report.reviewsOpened += 1;
        if (result === 'HELD') report.held += 1;
        // R2: an attempt that settled or ended is shown so on the message that shows it.
        if (
          result === 'SETTLED' ||
          result === 'UNSUCCESSFUL' ||
          result === 'LATE' ||
          result === 'REVIEW' ||
          result === 'HELD'
        ) {
          await this.refreshScreens(scope, claimed.invoice.paymentId);
        }
      }
    }

    // TonPays Telegram: no provider call — always run, whatever the budget said.
    report.reviewsLapsed = await this.loseTrackOfLapsedReviews(scope, actor);
    await this.sweepReceiptCaptures(scope);
    if (!report.budgetExhausted) {
      const cards = await this.runCardChanges(scope, actor);
      report.cardChanges = cards.done;
      report.budgetExhausted = cards.budgetExhausted;
    }
    if (!report.budgetExhausted) {
      const receipts = await this.runReceipts(scope, actor);
      report.receipts = receipts.done;
      report.budgetExhausted = receipts.budgetExhausted;
    }
    return report;
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
  ): Promise<'created' | 'createFailed' | 'createUnknown' | 'createDeferred' | 'BUDGET'> {
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
    const callbackUrl =
      descriptor.approval === 'INQUIRY'
        ? await this.deps.callbackUrlFor(scope, invoice.provider)
        : null;
    const presentation =
      descriptor.invoiceCredential === 'BOT_TOKEN' ? await this.deps.presentation(scope) : null;

    const stamped = await this.deps.uow.run(scope, (tx) =>
      this.deps.invoices.markCreationSent(scope, invoice.paymentId, now, tx),
    );
    if (!stamped) return 'createUnknown';

    const calledAt = this.deps.clock.now();
    const outcome = await adapter.createInvoice(apiKey, {
      orderId: invoice.providerOrderId,
      amount: invoice.sentAmount,
      callbackUrl,
      buyerChatId,
      presentation,
      // A `numericIdentity` route's customer number, frozen on the attempt (CentralPay).
      providerUserId: invoice.providerUserId,
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
    const linkFailure = paymentLinkFailureOf(outcome, descriptor.invoiceForm, {
      rateLimitIsFinal: invoice.creationAttempts + 1 >= TONPAYS_CREATE_MAX_ATTEMPTS,
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
                  ? new Date(at.getTime() + FIRST_INQUIRY_DELAY_MS)
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
        if (invoice.creationAttempts + 1 < TONPAYS_CREATE_MAX_ATTEMPTS) {
          await this.deps.uow.run(scope, (tx) =>
            this.deps.invoices.deferCreation(
              scope,
              invoice.paymentId,
              outcome.code,
              new Date(at.getTime() + TONPAYS_CREATE_RETRY_MS),
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
        await this.endCreation(scope, actor, invoice, 'CREATE_FAILED', outcome.code);
        await this.deps.payments.failGatewayPayment(scope, actor, invoice.paymentId, {
          reasonCode: `${invoice.provider.toLowerCase()}:${outcome.code}`,
          notifyCustomer: !outcome.configuration,
        });
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
  ): Promise<
    'OPEN' | 'SETTLED' | 'UNSUCCESSFUL' | 'LATE' | 'ERROR' | 'BUDGET' | 'REVIEW' | 'HELD'
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
    let postDeadline = !eligible;
    // An operator's "ask again" on an UNKNOWN payment lets ONE inquiry past the bound.
    const operatorAsked = invoice.reconcileInquiryRequestedAt !== null;

    /*
     * A provider that PUSHES its payments (Stars) is never asked. Its row is due only
     * because a payment was recorded on it, and the recorded charge IS the approval —
     * written under the row's lock after every identity check (`StarsPaymentService`).
     * No call, no budget: this is the settlement the webhook's own attempt did not finish.
     */
    if (PAYMENT_GATEWAY_DESCRIPTORS[invoice.provider].approval === 'RECORDED_PAYMENT') {
      return this.settleRecordedClaim(scope, actor, invoice, eligible, expiresAt);
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
    if (
      invoiceId === null ||
      adapter === null ||
      apiKey === null ||
      (postDeadline && invoice.postDeadlineInquiries >= POST_DEADLINE_INQUIRY_MAX && !operatorAsked)
    ) {
      // Nothing that could be asked, or nothing more to ask. Stop scheduling.
      await this.deps.uow.run(scope, (tx) =>
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
          },
          now,
          tx,
        ),
      );
      return 'ERROR';
    }

    if (
      !(await this.deps.budget.take(scope, invoice.provider, adapter.inquiryBudgetPerMinute, now))
    ) {
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
    const outcome = await adapter.inquire(apiKey, invoiceId, {
      providerOrderId: invoice.providerOrderId,
      sentAmount: invoice.sentAmount,
      hintedPaymentId: invoice.hintedPaymentId,
      // CentralPay: the customer's number as SENT — a verify naming another never approves.
      providerUserId: invoice.providerUserId,
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
      postDeadline = !eligible;
    }
    const next = postDeadline
      ? null
      : reviewUntil !== null
        ? // In review (§9.6.5): the review cadence, ending fifteen seconds before its deadline.
          reviewInquiryNextAt(
            new Date(reviewUntil.getTime() - TONPAYS_TELEGRAM_REVIEW_WINDOW_MS),
            reviewUntil,
            at,
          )
        : this.nextInquiryAt(invoice, at, expiresAt);

    if (outcome.kind !== 'OBSERVED') {
      const retry =
        outcome.kind === 'RATE_LIMITED' && next !== null
          ? new Date(Math.max(next.getTime(), at.getTime() + 60_000))
          : next;
      await this.deps.uow.run(scope, (tx) =>
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
            nextInquiryAt:
              retry !== null && expiresAt !== null && retry >= expiresAt ? null : retry,
            postDeadline,
          },
          at,
          tx,
        ),
      );
      if (outcome.kind === 'CONFIGURATION') await this.misconfigured(scope, invoice, outcome.code);
      return 'ERROR';
    }

    /*
     * An answer about ANOTHER invoice or another order is not an answer about this
     * attempt, whatever it says. It is recorded and never acted on.
     */
    if (outcome.invoiceId !== invoiceId || outcome.orderId !== invoice.providerOrderId) {
      await this.deps.uow.run(scope, (tx) =>
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
          },
          at,
          tx,
        ),
      );
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
    let verdict = outcome.verdict;
    let mismatchReason = outcome.mismatchReason ?? null;
    const reference = outcome.providerReference ?? null;
    await this.deps.uow.run(scope, async (tx) => {
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
          adoptInvoiceId: invoice.providerInvoiceId === null ? invoiceId : null,
          /*
           * A terminal verdict keeps the next inquiry scheduled until its outcome is
           * recorded — `recordOutcome` is what clears it. A crash, or a failed transaction,
           * between here and the settlement or the failure is then retried rather than
           * lost: an UNSUCCESSFUL row unscheduled here would leave its payment PENDING and
           * its rejected invoice handed back as the open attempt. The retry is harmless:
           * the settlement is exactly-once, and a payment already failed is no longer
           * eligible, so the retry only records the outcome.
           */
          nextInquiryAt: next,
          postDeadline,
          // The payment this identity-checked answer described (NOWPayments): followed next.
          hintedPaymentId: outcome.providerPaymentId ?? null,
        },
        at,
        tx,
      );
    });

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
      return 'OPEN';
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
    );
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
  ): Promise<'SETTLED' | 'LATE' | 'ERROR' | 'HELD'> {
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
      this.deps.logger.error(
        { paymentId: invoice.paymentId, error: error instanceof Error ? error.name : 'unknown' },
        'a gateway approval could not be settled',
      );
      return 'ERROR';
    }
    switch (confirmation.outcome) {
      case 'SETTLED':
        await this.deps.invoices.recordOutcome(scope, invoice.paymentId, 'SETTLED', at);
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
        await this.lateCompletion(scope, actor, invoice, confirmation.reason);
        return 'LATE';
    }
  }

  /** The worker's settlement of a recorded payment (Stars). No provider call is made. */
  private async settleRecordedClaim(
    scope: TenantContext,
    actor: ActorContext,
    invoice: GatewayInvoiceRecord,
    eligible: boolean,
    expiresAt: Date | null,
  ): Promise<'OPEN' | 'SETTLED' | 'LATE' | 'ERROR'> {
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
    await this.deps.uow.run(scope, (tx) =>
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
        },
        now,
        tx,
      ),
    );
    if (!recorded) return 'OPEN';
    // A recorded payment carries no provider reference, so it is never held here.
    const settled = await this.settleApproved(
      scope,
      actor,
      invoice,
      `${invoice.provider.toLowerCase()}:successful_payment`,
      now,
    );
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
    );
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
    const next = new Date(at.getTime() + inquiryBackoffMs(invoice.inquiryAttempts + 1));
    if (next.getTime() < expiresAt.getTime()) return next;
    /*
     * One last question just before the deadline, so a payment made in the final minutes
     * is not lost to the backoff; after the deadline there is nothing to ask for.
     */
    const last = new Date(expiresAt.getTime() - 15_000);
    return last.getTime() > at.getTime() ? last : null;
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
  ): Promise<{ readonly done: number; readonly budgetExhausted: boolean }> {
    const cards = this.deps.cardTransfer;
    if (cards === undefined) return { done: 0, budgetExhausted: false };
    const now = this.deps.clock.now();
    const lease = new Date(now.getTime() + GATEWAY_CLAIM_LEASE_MS);
    const claimed = await this.deps.uow.run(scope, (tx) =>
      cards.claimCardChanges(scope, now, GATEWAY_CLAIM_LEASE_MS, GATEWAY_CARD_CHANGE_BATCH, tx),
    );
    let done = 0;
    for (const [index, row] of claimed.entries()) {
      const result = await this.processCardChange(scope, actor, cards, row);
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
  ): Promise<{ readonly done: number; readonly budgetExhausted: boolean }> {
    const cards = this.deps.cardTransfer;
    if (cards === undefined) return { done: 0, budgetExhausted: false };
    const now = this.deps.clock.now();
    const lease = new Date(now.getTime() + GATEWAY_CLAIM_LEASE_MS);
    const claimed = await this.deps.uow.run(scope, (tx) =>
      cards.claimSubmissions(scope, now, GATEWAY_CLAIM_LEASE_MS, GATEWAY_RECEIPT_BATCH, tx),
    );
    let done = 0;
    for (const [index, row] of claimed.entries()) {
      const result = await this.processReceipt(scope, actor, cards, row);
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
    const windowOpen = (payment: {
      readonly state: string;
      readonly expiresAt: Date | null;
      readonly reviewUntil: Date | null;
    }): boolean =>
      payment.state === 'PENDING' &&
      payment.reviewUntil === null &&
      payment.expiresAt !== null &&
      this.deps.clock.now().getTime() < payment.expiresAt.getTime();
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
      invoice.providerInvoiceId !== submission.providerInvoiceId ||
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
        current.providerInvoiceId !== submission.providerInvoiceId
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
    const outcome = await adapter.uploadReceipt(apiKey, invoice.providerInvoiceId, {
      bytes: file.bytes,
      mimeType,
      fileName: mimeType === 'image/png' ? 'receipt.png' : 'receipt.jpg',
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
        if (submission.attempts + 1 < TONPAYS_TELEGRAM_RECEIPT_MAX_ATTEMPTS) {
          await this.deps.uow.run(scope, (tx) =>
            cards.requeueSubmission(
              scope,
              submission.id,
              outcome.code,
              new Date(at.getTime() + RECEIPT_RATE_LIMIT_RETRY_MS),
              at,
              tx,
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
  ): Promise<GatewayWebhookResult | 'MALFORMED' | 'NO_ADAPTER'> {
    const adapter = this.deps.adapters(provider);
    if (adapter === null) return 'NO_ADAPTER';
    // A browser-return route documents no webhook (CentralPay): nothing posted is read.
    if (PAYMENT_GATEWAY_DESCRIPTORS[provider].browserReturn) return 'NO_ADAPTER';
    /*
     * A route whose provider SIGNS its webhooks (NOWPayments): verified against the stored
     * secret, in constant time, BEFORE a single field of the body is read. Unverified is
     * dropped. Verified is still only a hint — it never reaches the settlement path.
     */
    if (PAYMENT_GATEWAY_DESCRIPTORS[provider].webhookSecret) {
      const verified = await this.verifyWebhook(tenantId, provider, adapter, body, signatureHeader);
      if (verified !== 'VERIFIED') return verified;
    }
    // Shape only. TonPays' signature and API-key headers are never read (brief §6).
    const hint = adapter.parseWebhook(body, deliveryIdHeader);
    if (hint === null) return 'MALFORMED';
    return this.applyWebhookHint(tenantId, provider, hint, adapter);
  }

  private async verifyWebhook(
    tenantId: string,
    provider: PaymentGatewayProvider,
    adapter: ExternalGatewayAdapter,
    body: unknown,
    signature: string | undefined,
  ): Promise<'VERIFIED' | 'IGNORED_INACTIVE' | 'IGNORED_UNVERIFIED'> {
    const scope: TenantContext = {
      tenantId: tenantId as TenantContext['tenantId'],
      botInstanceId: null,
    };
    // An unknown or stopped tenant is answered like every other ignored webhook.
    if (!(await this.deps.scopeActivity.scopeIsActive(scope))) return 'IGNORED_INACTIVE';
    let secret: string | null;
    try {
      secret = await this.deps.credentials.readWebhookSecret(scope, provider);
    } catch (error: unknown) {
      // A secret that will not decrypt verifies nothing. Never logged beyond its class.
      this.deps.logger.error(
        { provider, error: error instanceof Error ? error.name : 'unknown' },
        'a gateway webhook secret could not be read',
      );
      secret = null;
    }
    const verified =
      secret !== null &&
      adapter.verifyWebhook !== undefined &&
      adapter.verifyWebhook(secret, body, signature);
    const dedupeKey = `${GATEWAY_WEBHOOK_UNVERIFIED_CODE}:${provider}`;
    if (!verified) {
      this.deps.logger.warn(
        { provider, secretStored: secret !== null, signaturePresent: signature !== undefined },
        'gateway webhook dropped: signature not verified',
      );
      await this.deps.opsLog.record(scope, {
        code: GATEWAY_WEBHOOK_UNVERIFIED_CODE,
        severity: 'WARN',
        message:
          'A payment gateway notification arrived whose signature did not verify against the ' +
          'stored webhook secret. It was ignored; check the IPN secret if this repeats. Payments ' +
          'are still confirmed by the gateway’s own status read.',
        dedupeKey,
        context: { provider, secretStored: secret !== null },
      });
      return 'IGNORED_UNVERIFIED';
    }
    if (await this.deps.conditions.conditionIsOpen(scope, dedupeKey)) {
      await this.deps.opsLog.record(scope, {
        code: GATEWAY_WEBHOOK_VERIFIED_CODE,
        severity: 'INFO',
        message: 'A payment gateway notification verified against the stored webhook secret.',
        context: { provider },
        recoversCode: GATEWAY_WEBHOOK_UNVERIFIED_CODE,
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
    if (invoice.providerInvoiceId !== null && invoice.providerInvoiceId !== hint.invoiceId) {
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
    let inquireAt: Date | null = null;
    if (askable && invoice.outcome === null && eligible) {
      inquireAt = earliest;
    } else if (
      askable &&
      !eligible &&
      payment.state !== 'CONFIRMED' &&
      invoice.lateCompletionObservedAt === null &&
      invoice.postDeadlineInquiries < POST_DEADLINE_INQUIRY_MAX
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
    const recorded = await this.deps.uow.run(scope, (tx) =>
      this.deps.invoices.recordWebhook(
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
      ),
    );
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
    invoice: Pick<GatewayInvoiceRecord, 'paymentId' | 'provider'>,
  ): Promise<GatewayCardFacts | null> {
    const cards = this.deps.cardTransfer;
    if (
      cards === undefined ||
      PAYMENT_GATEWAY_DESCRIPTORS[invoice.provider].invoiceForm !== 'CARD_TRANSFER'
    ) {
      return null;
    }
    const [latestChange, submissions] = await Promise.all([
      cards.latestCardChange(scope, invoice.paymentId),
      cards.submissionsFor(scope, invoice.paymentId),
    ]);
    return { latestChange, submissions };
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

  private async endCreation(
    scope: TenantContext,
    actor: ActorContext,
    invoice: GatewayInvoiceRecord,
    to: 'CREATE_FAILED' | 'CREATE_UNKNOWN',
    code: string,
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
        trackingCode: payment === null ? null : paymentTrackingCode(payment.reference),
        telegramUserId,
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
    await this.deps.opsLog.record(scope, {
      code: GATEWAY_MISCONFIGURED_CODE,
      severity: 'ERROR',
      message:
        'The payment gateway refused this installation’s configuration. Customers are told the ' +
        'method is unavailable; check the API key and the gateway account.',
      dedupeKey: `${GATEWAY_MISCONFIGURED_CODE}:${invoice.provider}`,
      context: { provider: invoice.provider, reason: code },
    });
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
