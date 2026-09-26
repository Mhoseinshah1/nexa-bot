import {
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
import type {
  ClaimedGatewayInvoice,
  ExternalGatewayAdapter,
  GatewayCallBudget,
  GatewayCredentialStore,
  GatewayInvoiceRecord,
  GatewayInvoiceRepository,
  GatewayWebhookHint,
} from './gateway-invoice-ports.js';
import type { PaymentRecord, PaymentRepository } from './ports.js';
import type { GatewayConfirmation, PaymentService } from './payment.service.js';

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
export const GATEWAY_CREATE_UNKNOWN_CODE = 'payments.gateway_create_unknown';
export const GATEWAY_LATE_COMPLETION_CODE = 'payments.gateway_late_completion';
export const GATEWAY_IDENTITY_MISMATCH_CODE = 'payments.gateway_identity_mismatch';

/** How long a claimed row is held before another replica may take it. */
export const GATEWAY_CLAIM_LEASE_MS = 60_000;
/** Rows per pass, per queue. Small: every one of them is a call to a third party. */
export const GATEWAY_CREATE_BATCH = 5;
export const GATEWAY_INQUIRY_BATCH = 10;

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
export function gatewayCallbackUrl(
  origin: string | null,
  provider: PaymentGatewayProvider,
  tenantId: string,
): string | null {
  return origin === null ? null : `${origin}${gatewayWebhookPath(provider, tenantId)}`;
}

export interface GatewayPaymentServiceDeps {
  readonly invoices: GatewayInvoiceRepository;
  readonly payments: Pick<PaymentService, 'confirmGatewayPayment' | 'failGatewayPayment'>;
  readonly paymentRecords: Pick<PaymentRepository, 'findById' | 'setExternalReference'>;
  readonly adapters: (provider: PaymentGatewayProvider) => ExternalGatewayAdapter | null;
  readonly credentials: GatewayCredentialStore;
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
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: {
    info: (context: Record<string, unknown>, message: string) => void;
    warn: (context: Record<string, unknown>, message: string) => void;
    error: (context: Record<string, unknown>, message: string) => void;
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
  readonly budgetExhausted: boolean;
}

/** What a webhook did. Never anything the caller could turn into money. */
export type GatewayWebhookResult =
  | 'SCHEDULED'
  | 'RECORDED'
  | 'DUPLICATE'
  | 'IGNORED_UNKNOWN'
  | 'IGNORED_MISMATCH'
  | 'IGNORED_INACTIVE';

/** An attempt as a customer's own surface may see it. */
export interface GatewayAttemptView {
  readonly payment: PaymentRecord;
  readonly invoice: GatewayInvoiceRecord;
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
      }
    }
    return report;
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
    const apiKey =
      adapter === null ? null : await this.deps.credentials.read(scope, invoice.provider);
    if (adapter === null || apiKey === null) {
      await this.endCreation(scope, actor, invoice, 'CREATE_FAILED', 'nexa.credential_missing');
      await this.deps.payments.failGatewayPayment(scope, actor, invoice.paymentId, {
        reasonCode: `${invoice.provider.toLowerCase()}:nexa.credential_missing`,
        notifyCustomer: false,
      });
      await this.misconfigured(scope, invoice, 'nexa.credential_missing');
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
    const callbackUrl = await this.deps.callbackUrlFor(scope, invoice.provider);

    const stamped = await this.deps.uow.run(scope, (tx) =>
      this.deps.invoices.markCreationSent(scope, invoice.paymentId, now, tx),
    );
    if (!stamped) return 'createUnknown';

    const outcome = await adapter.createInvoice(apiKey, {
      orderId: invoice.providerOrderId,
      amount: invoice.sentAmount,
      callbackUrl,
      buyerChatId,
    });
    const at = this.deps.clock.now();

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
              firstInquiryAt: new Date(at.getTime() + FIRST_INQUIRY_DELAY_MS),
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
              },
              result: 'SUCCESS',
            },
            tx,
          );
        });
        await this.configured(scope, invoice.provider);
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
        return 'createFailed';
      }
      case 'REFUSED': {
        await this.endCreation(scope, actor, invoice, 'CREATE_FAILED', outcome.code);
        await this.deps.payments.failGatewayPayment(scope, actor, invoice.paymentId, {
          reasonCode: `${invoice.provider.toLowerCase()}:${outcome.code}`,
          notifyCustomer: !outcome.configuration,
        });
        if (outcome.configuration) await this.misconfigured(scope, invoice, outcome.code);
        return 'createFailed';
      }
      case 'AMBIGUOUS':
      case 'UNKNOWN': {
        await this.endCreation(scope, actor, invoice, 'CREATE_UNKNOWN', outcome.code);
        await this.deps.opsLog.record(scope, {
          code: GATEWAY_CREATE_UNKNOWN_CODE,
          severity: 'WARN',
          message:
            'A payment gateway invoice may or may not have been created; nothing was charged ' +
            'through it by this installation, and it expires at its deadline.',
          dedupeKey: `${GATEWAY_CREATE_UNKNOWN_CODE}:${invoice.paymentId}`,
          context: {
            paymentId: invoice.paymentId,
            provider: invoice.provider,
            providerOrderId: invoice.providerOrderId,
            reason: outcome.code,
          },
        });
        return 'createUnknown';
      }
    }
  }

  private async processInquiry(
    scope: TenantContext,
    actor: ActorContext,
    claimed: ClaimedGatewayInvoice,
  ): Promise<'OPEN' | 'SETTLED' | 'UNSUCCESSFUL' | 'LATE' | 'ERROR' | 'BUDGET'> {
    const { invoice } = claimed;
    const now = this.deps.clock.now();
    const invoiceId = invoice.providerInvoiceId ?? invoice.hintedInvoiceId;
    const expiresAt = claimed.paymentExpiresAt;
    const eligible =
      claimed.paymentState === 'PENDING' &&
      expiresAt !== null &&
      now.getTime() < expiresAt.getTime();
    const postDeadline = !eligible;

    const adapter = this.deps.adapters(invoice.provider);
    const apiKey =
      adapter === null ? null : await this.deps.credentials.read(scope, invoice.provider);
    if (
      invoiceId === null ||
      adapter === null ||
      apiKey === null ||
      (postDeadline && invoice.postDeadlineInquiries >= POST_DEADLINE_INQUIRY_MAX)
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

    const outcome = await adapter.inquire(apiKey, invoiceId);
    const at = this.deps.clock.now();
    const next = postDeadline ? null : this.nextInquiryAt(invoice, at, expiresAt);

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

    await this.deps.uow.run(scope, (tx) =>
      this.deps.invoices.recordInquiry(
        scope,
        invoice.paymentId,
        {
          status: outcome.status,
          paid: outcome.paid,
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
        },
        at,
        tx,
      ),
    );

    if (outcome.verdict === 'OPEN') return 'OPEN';

    if (outcome.verdict === 'UNSUCCESSFUL') {
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
    if (!eligible) {
      await this.lateCompletion(scope, actor, invoice, 'DEADLINE_PASSED');
      return 'LATE';
    }
    let confirmation: GatewayConfirmation;
    try {
      confirmation = await this.deps.payments.confirmGatewayPayment(
        scope,
        actor,
        invoice.paymentId,
        { evidenceNote: `${invoice.provider.toLowerCase()}:${outcome.status}:paid` },
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
        await this.lateCompletion(scope, actor, invoice, confirmation.reason);
        return 'LATE';
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
  ): Promise<GatewayWebhookResult | 'MALFORMED' | 'NO_ADAPTER'> {
    const adapter = this.deps.adapters(provider);
    if (adapter === null) return 'NO_ADAPTER';
    // Shape only. The signature and API-key headers are never read (brief §6).
    const hint = adapter.parseWebhook(body, deliveryIdHeader);
    if (hint === null) return 'MALFORMED';
    return this.applyWebhookHint(tenantId, provider, hint);
  }

  private async applyWebhookHint(
    tenantId: string,
    provider: PaymentGatewayProvider,
    hint: GatewayWebhookHint,
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
    const eligible =
      payment.state === 'PENDING' &&
      payment.expiresAt !== null &&
      now.getTime() < payment.expiresAt.getTime();
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
    const recorded = await this.deps.uow.run(scope, (tx) =>
      this.deps.invoices.recordWebhook(
        scope,
        invoice.paymentId,
        {
          status: hint.status,
          deliveryId: hint.deliveryId,
          creditAmount: hint.creditAmount,
          hintedInvoiceId:
            invoice.creationState === 'CREATE_UNKNOWN' && invoice.providerInvoiceId === null
              ? hint.invoiceId
              : null,
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
    if (
      view.payment.state !== 'PENDING' ||
      view.payment.expiresAt === null ||
      now.getTime() >= view.payment.expiresAt.getTime() ||
      view.invoice.creationState !== 'CREATED'
    ) {
      return;
    }
    const at =
      view.invoice.lastInquiryAt === null
        ? now
        : new Date(
            Math.max(now.getTime(), view.invoice.lastInquiryAt.getTime() + INQUIRY_MIN_SPACING_MS),
          );
    await this.deps.uow.run(scope, (tx) =>
      this.deps.invoices.requestInquiry(scope, view.payment.id, at, tx),
    );
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
    });
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
