import {
  PAYMENT_GATEWAY_DESCRIPTORS,
  TONPAYS_TELEGRAM_STATUS_MORE,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type GatewayProviderRequestKind,
  type IdGenerator,
  type OperationalEventRecorder,
  type PaymentGatewayProvider,
  type PaymentId,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import { gatewaySettlementDeadline } from '../domain/settlement.js';
import {
  CANCELLED_BY_CUSTOMER_STATUS,
  CANCELLED_BY_NEXA_STATUS,
} from '../domain/payment-failure-outcome.js';
import { GATEWAY_HELD_RETRY_MIN_MS, NEXA_CANCEL_KEY_PREFIX } from './gateway-invoice-ports.js';
import type {
  CardTransferGatewayAdapter,
  ClaimedProviderRequest,
  GatewayCallBudget,
  GatewayCredentialStore,
  GatewayInvoiceRecord,
  GatewayInvoiceRepository,
  GatewayProviderRequestRepository,
  GatewayRefundCard,
  GatewaySiblingAttempt,
  RefundCardSealer,
} from './gateway-invoice-ports.js';
import type { PaymentRepository } from './ports.js';
import type { PaymentService } from './payment.service.js';

/** The operational code of a cancel or refund whose answer was lost. Per request. */
export const GATEWAY_REQUEST_UNKNOWN_CODE = 'payments.gateway_request_unknown';

/** How many cancels and refunds one pass sends. */
export const GATEWAY_PROVIDER_REQUEST_BATCH = 5;

/**
 * What the lane needs from `GatewayPaymentService` and cannot own itself: the lease arithmetic
 * of its claims, the operator conditions it shares, and the Telegram screen refresh.
 */
export interface GatewayProviderRequestHooks {
  leaseMs(): number;
  rowFitsLease(leaseUntil: Date): boolean;
  misconfigured(scope: TenantContext, invoice: GatewayInvoiceRecord, code: string): Promise<void>;
  identityMismatch(scope: TenantContext, invoice: GatewayInvoiceRecord): Promise<void>;
  refreshScreens(scope: TenantContext, paymentId: string): Promise<void>;
  rowFailed(
    scope: TenantContext,
    paymentId: string,
    provider: PaymentGatewayProvider | null,
    error: unknown,
  ): Promise<void>;
}

export interface GatewayProviderRequestLaneDeps {
  readonly requests: GatewayProviderRequestRepository;
  readonly invoices: Pick<
    GatewayInvoiceRepository,
    'findByPayment' | 'requestInquiry' | 'recordOutcome'
  >;
  readonly paymentRecords: Pick<PaymentRepository, 'findById'>;
  readonly payments: Pick<PaymentService, 'failGatewayPayment'>;
  readonly cardAdapters: (provider: PaymentGatewayProvider) => CardTransferGatewayAdapter | null;
  readonly credentials: GatewayCredentialStore;
  readonly budget: GatewayCallBudget;
  readonly refundCards?: RefundCardSealer;
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
  readonly hooks: GatewayProviderRequestHooks;
}

/**
 * The cancel and refund lane of TonPays Telegram (Round 6, `docs/tonpays-telegram-gateway-
 * audit.md` §19). The customer's tap is a row; this is what sends it — never while Telegram
 * waits, the stamp committed before the call, an unanswered stamp UNKNOWN and never sent again,
 * and every transition a conditional UPDATE.
 *
 * It decides no payment's money. A cancel that the provider accepted FAILS the local payment
 * (nothing was received for it); a refund that the provider accepted changes nothing locally —
 * the invoice becomes `completed` and `paid` when the provider says so, the inquiry reads that,
 * and `confirmGatewayPayment` settles it under the payment's lock at the principal it always
 * did. The provider's refund and remainder amounts are never read by anything here.
 */
export class GatewayProviderRequestLane {
  constructor(private readonly deps: GatewayProviderRequestLaneDeps) {}

  /** The queue: one claim, then each row on its own. */
  async run(
    scope: TenantContext,
    actor: ActorContext,
    report: { rowFailures: number; leaseReleased: number },
  ): Promise<{ readonly done: number; readonly budgetExhausted: boolean }> {
    const now = this.deps.clock.now();
    const lease = new Date(now.getTime() + this.deps.hooks.leaseMs());
    const claimed = await this.deps.uow.run(scope, (tx) =>
      this.deps.requests.claim(
        scope,
        now,
        this.deps.hooks.leaseMs(),
        GATEWAY_PROVIDER_REQUEST_BATCH,
        tx,
      ),
    );
    let done = 0;
    for (const [index, row] of claimed.entries()) {
      if (!this.deps.hooks.rowFitsLease(lease)) {
        report.leaseReleased += claimed.length - index;
        await this.releaseFrom(scope, claimed, index, lease);
        break;
      }
      let result: 'DONE' | 'BUDGET';
      try {
        result = await this.process(scope, actor, row);
      } catch (error: unknown) {
        // The row keeps its lease, which is its back-off; a stamped send is UNKNOWN when it ends.
        report.rowFailures += 1;
        await this.deps.hooks.rowFailed(scope, row.row.paymentId, null, error);
        continue;
      }
      if (result === 'BUDGET') {
        await this.releaseFrom(scope, claimed, index, lease);
        return { done, budgetExhausted: true };
      }
      done += 1;
      await this.deps.hooks.refreshScreens(scope, row.row.paymentId);
    }
    return { done, budgetExhausted: false };
  }

  private async releaseFrom(
    scope: TenantContext,
    claimed: readonly ClaimedProviderRequest[],
    from: number,
    lease: Date,
  ): Promise<void> {
    await this.deps.uow.run(scope, (tx) =>
      this.deps.requests.releaseClaims(
        scope,
        claimed.slice(from).map((one) => one.row.id),
        lease,
        tx,
      ),
    );
  }

  /**
   * One request, to its end. `BUDGET` means nothing was stamped and nothing was sent: the row
   * keeps its sealed card (a refund) and goes back for the next pass.
   */
  async process(
    scope: TenantContext,
    actor: ActorContext,
    claimed: ClaimedProviderRequest,
  ): Promise<'DONE' | 'BUDGET'> {
    const request = claimed.row;
    const now = this.deps.clock.now();
    const decide = async (
      to: 'APPLIED' | 'REFUSED' | 'RATE_LIMITED' | 'UNKNOWN',
      code: string | null,
      extra?: (tx: TransactionScope) => Promise<void>,
    ): Promise<void> => {
      await this.deps.uow.run(scope, async (tx) => {
        const moved = await this.deps.requests.decide(
          scope,
          request.id,
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
            action: `gateway_invoice.${request.kind.toLowerCase()}_${to.toLowerCase()}`,
            entityType: 'Payment',
            entityId: request.paymentId,
            before: { requestId: request.id, kind: request.kind, state: request.state },
            // Ids, states and codes only: never a card number, a holder or a masked card.
            after: { requestId: request.id, kind: request.kind, state: to, reason: code },
            result: 'SUCCESS',
          },
          tx,
        );
      });
    };
    const bringInquiryForward = (tx: TransactionScope): Promise<boolean> =>
      this.deps.invoices.requestInquiry(scope, request.paymentId, this.deps.clock.now(), tx);
    const lost = (code: string): Promise<void> =>
      decide('UNKNOWN', code, async (tx) => {
        await this.deps.opsLog.record(
          scope,
          {
            code: GATEWAY_REQUEST_UNKNOWN_CODE,
            severity: 'WARN',
            message:
              'A payment gateway’s answer to a customer’s cancel or refund request was lost. ' +
              'It is never sent again automatically; the next inquiry is brought forward and ' +
              'says what became of the invoice.',
            dedupeKey: `${GATEWAY_REQUEST_UNKNOWN_CODE}:${request.id}`,
            context: { paymentId: request.paymentId, kind: request.kind, reason: code },
          },
          tx,
        );
        await bringInquiryForward(tx);
      });

    /*
     * A request whose send was stamped and never answered — a worker died mid-call, or its
     * lease ran out. The provider may have cancelled or refunded: UNKNOWN, never sent again.
     */
    if (request.sentAt !== null) {
      await lost('nexa.send_interrupted');
      return 'DONE';
    }
    const invoice = await this.deps.invoices.findByPayment(scope, request.paymentId);
    // A cancel is for the customer window of a `pending` invoice; a refund is for an
    // overpayment, which may arise inside the provider review window — the settlement deadline.
    const deadline = gatewaySettlementDeadline({
      expiresAt: claimed.paymentExpiresAt,
      providerReviewUntil: claimed.paymentReviewUntil,
    });
    /*
     * R9 C1: the cancel the expiry sweep asked for is the one request made for a CLOSED
     * attempt — Nexa's own deadline expired it, and the provider's invoice is still open. It is
     * sent only while the payment is still EXPIRED (an operator's reconciliation since then
     * wins), and only for an invoice still undecided and not reported paid.
     */
    const onExpiry = request.kind === 'CANCEL' && request.requestedOnExpiry === true;
    const windowOpen = onExpiry
      ? claimed.paymentState === 'EXPIRED' &&
        invoice !== null &&
        invoice.outcome === null &&
        invoice.providerPaid !== true
      : claimed.paymentState === 'PENDING' &&
        deadline !== null &&
        now.getTime() < deadline.getTime() &&
        (request.kind === 'REFUND' || claimed.paymentReviewUntil === null);
    if (
      !windowOpen ||
      invoice === null ||
      invoice.creationState !== 'CREATED' ||
      invoice.providerInvoiceId === null
    ) {
      await decide('REFUSED', 'nexa.attempt_closed');
      return 'DONE';
    }
    // The state the request was made for: a refund needs an overpayment, a cancel a pending one.
    if (request.kind === 'REFUND' && invoice.providerStatus !== TONPAYS_TELEGRAM_STATUS_MORE) {
      await decide('REFUSED', 'nexa.not_overpaid');
      return 'DONE';
    }
    if (
      request.kind === 'CANCEL' &&
      invoice.providerStatus !== null &&
      invoice.providerStatus !== 'pending'
    ) {
      await decide('REFUSED', 'nexa.not_pending');
      return 'DONE';
    }
    const adapter = this.deps.cardAdapters(invoice.provider);
    const apiKey =
      adapter === null ? null : await this.deps.credentials.read(scope, invoice.provider);
    if (adapter === null || apiKey === null) {
      await decide('REFUSED', 'nexa.credential_missing');
      await this.deps.hooks.misconfigured(scope, invoice, 'nexa.credential_missing');
      return 'DONE';
    }
    // The refund card, unsealed in memory for this one call; a card that will not open is no card.
    let card: GatewayRefundCard | null = null;
    if (request.kind === 'REFUND') {
      if (claimed.sealed === null || this.deps.refundCards === undefined) {
        await decide('REFUSED', 'nexa.card_unavailable');
        return 'DONE';
      }
      try {
        card = this.deps.refundCards.open(scope, request.id, claimed.sealed);
      } catch {
        await decide('REFUSED', 'nexa.card_unreadable');
        return 'DONE';
      }
    }
    if (!(await this.deps.budget.take(scope, invoice.provider, adapter.callBudgetPerMinute, now))) {
      return 'BUDGET';
    }
    // The point of no return, committed BEFORE the call. It also wipes the sealed card.
    const stamped = await this.deps.uow.run(scope, (tx) =>
      this.deps.requests.markSent(scope, request.id, now, tx),
    );
    if (!stamped) return 'DONE';
    const outcome =
      card === null
        ? await adapter.cancelInvoice(apiKey, invoice.providerInvoiceId)
        : await adapter.refundInvoice(apiKey, invoice.providerInvoiceId, card);
    const at = this.deps.clock.now();
    this.deps.logger.info(
      {
        paymentId: request.paymentId,
        provider: invoice.provider,
        kind: request.kind,
        outcome: outcome.kind,
        reason: outcome.kind === 'CANCELLED' || outcome.kind === 'ACCEPTED' ? null : outcome.code,
      },
      'gateway provider request answered',
    );
    switch (outcome.kind) {
      case 'CANCELLED':
        if (onExpiry) {
          /*
           * The payment is already EXPIRED: nothing to fail, and the customer was told so by
           * the expiry. The invoice is read again; its `canceled` records the outcome.
           */
          await decide('APPLIED', null, async (tx) => {
            await bringInquiryForward(tx);
          });
          return 'DONE';
        }
        await decide('APPLIED', null);
        await this.cancelled(scope, actor, invoice, at, request.requestedByNexa === true);
        return 'DONE';
      case 'ACCEPTED':
        // The invoice is read again: the refund is the provider's, the approval still is not ours.
        await decide('APPLIED', null, async (tx) => {
          await bringInquiryForward(tx);
        });
        return 'DONE';
      case 'RATE_LIMITED':
        /*
         * R11 A8: the CUSTOMER's cancel that the TonPays client's own limiter HELD never left
         * the process — not a lost answer, not the provider's word, nothing for the customer to
         * ask again. It goes back as it was asked, due when the limiter would let it go (the
         * key's pause after a 429, or the next token): the customer's tap is not spent on
         * Nexa's own pacing. Its window and the invoice's `pending` are checked again when it
         * is sent, and it is sent at most once like any request. Only while it would be due
         * BEFORE the customer window closes: one still waiting at Nexa's deadline would stand
         * in the way of the expiry cancel (one cancel at a time) and then be refused, leaving
         * TonPays' invoice open — decided `RATE_LIMITED` instead, the expiry cancel may follow.
         * Nexa's own cancels keep the decision (their callers ask a rate-limited one again as a
         * new row), and so does a refund, whose sealed card went with the send stamp.
         */
        if (
          outcome.notSent === true &&
          request.kind === 'CANCEL' &&
          request.requestedByNexa !== true &&
          !onExpiry
        ) {
          const notBefore = new Date(
            at.getTime() + Math.max(GATEWAY_HELD_RETRY_MIN_MS, outcome.retryAfterMs ?? 0),
          );
          const requeued =
            deadline !== null &&
            notBefore.getTime() < deadline.getTime() &&
            (await this.deps.uow.run(scope, (tx) =>
              this.deps.requests.requeueUnsentCancel(scope, request.id, now, notBefore, tx),
            ));
          if (requeued) return 'DONE';
        }
        // Not processed: the customer may ask again (a refund must be typed again).
        await decide('RATE_LIMITED', outcome.code);
        return 'DONE';
      case 'REFUSED':
        await decide('REFUSED', outcome.code, async (tx) => {
          if (!outcome.configuration) await bringInquiryForward(tx);
        });
        if (outcome.configuration)
          await this.deps.hooks.misconfigured(scope, invoice, outcome.code);
        return 'DONE';
      case 'NOT_FOUND':
        await decide('REFUSED', outcome.code);
        await this.deps.hooks.identityMismatch(scope, invoice);
        return 'DONE';
      case 'UNKNOWN':
        await lost(outcome.code);
        return 'DONE';
    }
  }

  /**
   * The provider cancelled the invoice at the customer's request: nothing was received for it,
   * so the local payment is FAILED (quietly — the customer asked, and the screen says so) and
   * the attempt's outcome recorded, which stops its inquiries. Both are idempotent, and the
   * next inquiry would say `canceled` anyway: a failure here only delays what the inquiry
   * finishes.
   */
  private async cancelled(
    scope: TenantContext,
    actor: ActorContext,
    invoice: GatewayInvoiceRecord,
    at: Date,
    byNexa: boolean,
  ): Promise<void> {
    try {
      await this.deps.payments.failGatewayPayment(scope, actor, invoice.paymentId, {
        // R8 A3: who cancelled is in the note, so the operations log can say so.
        reasonCode: `${invoice.provider.toLowerCase()}:${
          byNexa ? CANCELLED_BY_NEXA_STATUS : CANCELLED_BY_CUSTOMER_STATUS
        }`,
        notifyCustomer: false,
      });
      await this.deps.invoices.recordOutcome(scope, invoice.paymentId, 'UNSUCCESSFUL', at);
    } catch (error: unknown) {
      this.deps.logger.warn(
        {
          paymentId: invoice.paymentId,
          error: error instanceof Error ? error.name : 'unknown',
        },
        'a cancelled invoice could not be closed locally; the next inquiry will',
      );
    }
  }

  // ---------------------------------------------------------------------------------------
  // Called by the create lane.
  // ---------------------------------------------------------------------------------------

  /**
   * A NEW invoice is about to be created for a customer who already holds an open pending one
   * (Round 6 item 3): cancel the old one first, then the caller creates the new. Each sibling
   * is cancelled at most once, ever (`cancelRequested`), only while the provider's last word is
   * `pending` and no receipt is on its way — a receipt makes it `processing`, which the
   * provider refuses to cancel. A cancel the provider refuses, or whose answer was lost, does
   * not stop the create: the provider is the authority and answers `BUYER_HAS_*` if it must.
   *
   * `DEFER` means the call budget or the provider's rate limit stopped a cancel that was not
   * sent: the create waits, nothing was created.
   */
  async cancelSiblingsBeforeCreate(
    scope: TenantContext,
    actor: ActorContext,
    invoice: GatewayInvoiceRecord,
    customerId: string,
  ): Promise<'PROCEED' | 'DEFER'> {
    if (invoice.botInstanceId === null) return 'PROCEED';
    const siblings = await this.deps.requests.siblingAttempts(scope, {
      customerId,
      provider: invoice.provider,
      botInstanceId: invoice.botInstanceId,
      exceptPaymentId: invoice.paymentId,
      now: this.deps.clock.now(),
    });
    // A cancel still with the provider (or on its way) is the create's prerequisite: wait for it.
    if (siblings.some(cancelOutstanding)) return 'DEFER';
    for (const sibling of siblings) {
      if (!cancellable(sibling)) continue;
      const result = await this.cancelNow(scope, actor, sibling, invoice.paymentId, 'NEW_INVOICE');
      if (result === 'DEFER') return 'DEFER';
    }
    return 'PROCEED';
  }

  /**
   * `BUYER_HAS_PENDING_INVOICE` on a create: cancel the customer's OWN pending invoice, if
   * Nexa knows of one that was never asked to be cancelled, and report whether the create may
   * be tried again. The caller allows ONE retry (`buyerConflictRetryAllowed`); the refusal
   * means no invoice was made, so the same order id is sent again.
   */
  async cancelOwnPendingForBuyerConflict(
    scope: TenantContext,
    actor: ActorContext,
    invoice: GatewayInvoiceRecord,
    customerId: string,
  ): Promise<'RETRY' | 'FINAL'> {
    if (invoice.botInstanceId === null) return 'FINAL';
    const siblings = await this.deps.requests.siblingAttempts(scope, {
      customerId,
      provider: invoice.provider,
      botInstanceId: invoice.botInstanceId,
      exceptPaymentId: invoice.paymentId,
      now: this.deps.clock.now(),
    });
    for (const sibling of siblings) {
      if (!cancellable(sibling)) continue;
      const result = await this.cancelNow(
        scope,
        actor,
        sibling,
        invoice.paymentId,
        'BUYER_CONFLICT',
      );
      if (result === 'CANCELLED') return 'RETRY';
    }
    return 'FINAL';
  }

  /**
   * A cancel the worker itself asks for: the row is written already claimed by this pass (so
   * no other replica sends it) and processed at once, by the very code a customer's tap goes
   * through. Idempotent per (old attempt, new attempt).
   */
  private async cancelNow(
    scope: TenantContext,
    actor: ActorContext,
    sibling: GatewaySiblingAttempt,
    forPaymentId: PaymentId,
    reason: 'NEW_INVOICE' | 'BUYER_CONFLICT',
  ): Promise<'CANCELLED' | 'DEFER' | 'NOT_CANCELLED'> {
    const now = this.deps.clock.now();
    const id = this.deps.ids.uuid();
    const claimed = await this.deps.uow.run(scope, async (tx) => {
      const row = await this.deps.requests.request(
        scope,
        {
          id,
          paymentId: sibling.paymentId,
          botInstanceId: sibling.botInstanceId,
          customerId: sibling.customerId,
          kind: 'CANCEL' satisfies GatewayProviderRequestKind,
          // A rate-limited cancel is asked again as a new row; the in-flight index keeps one.
          idempotencyKey: `${NEXA_CANCEL_KEY_PREFIX}${id}`,
          now,
          claimedUntil: new Date(now.getTime() + this.deps.hooks.leaseMs()),
          refund: null,
        },
        tx,
      );
      if (row === null) return null;
      await this.deps.audit.record(
        scope,
        actor,
        {
          action: 'gateway_invoice.cancel_requested',
          entityType: 'Payment',
          entityId: sibling.paymentId,
          before: null,
          after: { requestId: id, state: row.state, reason, forPaymentId },
          result: 'SUCCESS',
        },
        tx,
      );
      return this.deps.requests.claimedById(scope, id, tx);
    });
    if (claimed === null) return 'NOT_CANCELLED';
    const result = await this.process(scope, actor, claimed);
    const after = await this.deps.requests.latest(scope, sibling.paymentId, 'CANCEL');
    await this.deps.hooks.refreshScreens(scope, sibling.paymentId);
    if (result === 'BUDGET' || after?.state === 'RATE_LIMITED') return 'DEFER';
    return after?.state === 'APPLIED' ? 'CANCELLED' : 'NOT_CANCELLED';
  }
}

/**
 * R9 C1: the cancel Nexa asks for when ITS deadline expires a card-transfer attempt whose
 * provider invoice is still open (`docs/tonpays-telegram-gateway-audit.md` §20). Written in the
 * expiry sweep's transaction, by ONE conditional statement (`requestExpiryCancel`), and sent
 * later by the lane above, the send stamped before the call like every other request — so a
 * lost answer is UNKNOWN and never repeated. Without it an expired attempt left a `pending`
 * invoice behind, and the customer's next top-up met `BUYER_HAS_PENDING_INVOICE`.
 */
export class GatewayExpiryCancels {
  constructor(
    private readonly deps: {
      readonly requests: Pick<GatewayProviderRequestRepository, 'requestExpiryCancel'>;
      readonly audit: AuditWriter;
      readonly ids: IdGenerator;
    },
  ) {}

  /** In the caller's transaction. True when a cancel request was written. */
  async requestOnExpiry(
    scope: TenantContext,
    actor: ActorContext,
    payment: { readonly id: PaymentId; readonly gatewayProvider: PaymentGatewayProvider | null },
    now: Date,
    tx: TransactionScope,
  ): Promise<boolean> {
    const provider = payment.gatewayProvider;
    // Only a route with the provider cancel endpoint (a card-transfer route) has one to ask.
    if (
      provider === null ||
      PAYMENT_GATEWAY_DESCRIPTORS[provider].invoiceForm !== 'CARD_TRANSFER'
    ) {
      return false;
    }
    const id = this.deps.ids.uuid();
    const row = await this.deps.requests.requestExpiryCancel(
      scope,
      { id, paymentId: payment.id, now },
      tx,
    );
    if (row === null) return false;
    await this.deps.audit.record(
      scope,
      actor,
      {
        action: 'gateway_invoice.cancel_requested',
        entityType: 'Payment',
        entityId: payment.id,
        before: null,
        after: { requestId: id, state: row.state, reason: 'NEXA_EXPIRY' },
        result: 'SUCCESS',
      },
      tx,
    );
    return true;
  }
}

/** Whether Nexa may ask for this sibling's cancel: never asked, not receipt-bearing, `pending`. */
export function cancellable(sibling: GatewaySiblingAttempt): boolean {
  return (
    // Never asked, or asked and definitively NOT processed (the provider's own rate limit).
    (sibling.latestCancelState === null || sibling.latestCancelState === 'RATE_LIMITED') &&
    !sibling.receiptSent &&
    (sibling.providerStatus === null || sibling.providerStatus === 'pending')
  );
}

/** A cancel row that is still with the provider or waiting to be sent. */
export function cancelOutstanding(sibling: GatewaySiblingAttempt): boolean {
  return sibling.latestCancelState === 'REQUESTED' || sibling.latestCancelState === 'SENT';
}
