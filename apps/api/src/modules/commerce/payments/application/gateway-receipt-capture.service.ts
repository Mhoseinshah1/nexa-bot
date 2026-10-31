import {
  COMMERCE_ERROR_CODES,
  PAYMENT_GATEWAY_DESCRIPTORS,
  TONPAYS_TELEGRAM_RECEIPT_CAPTURE_MINUTES,
  TONPAYS_TELEGRAM_RECEIPT_MAX_BYTES,
  TONPAYS_TELEGRAM_RECEIPT_MIME_TYPES,
  TONPAYS_TELEGRAM_STATUS_LESS,
  errors,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdGenerator,
  type OperationalEventRecorder,
  type PaymentId,
  type TenantContext,
  type UnitOfWork,
  type UserId,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import { runAuthorizedMutation } from '../../../platform/access/application/authorized-mutation.js';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import type { SessionRepository } from '../../../platform/identity/application/ports.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { SettingsResolver } from '../../../control/settings/application/settings-resolver.js';
import { gatewaySettlementDeadline } from '../domain/settlement.js';
import {
  cancelAvailable,
  cancelRetryNotBefore,
  cardChangeAvailable,
  type CardChangeAllowance,
  maskRefundCard,
  parseRefundCardInput,
  receiptUploadAvailable,
  refundCardAvailable,
  remainderReceiptAvailable,
} from '../domain/tonpays-telegram.js';
import type {
  GatewayCardTransferRepository,
  GatewayInvoiceRecord,
  GatewayInvoiceRepository,
  GatewayProviderRequestRepository,
  GatewayReceiptCaptureRecord,
  RefundCardSealer,
} from './gateway-invoice-ports.js';
import type { PaymentRecord, PaymentRepository } from './ports.js';
import { PAYMENT_PLACE_PERMISSION } from './payment.service.js';
import type { InboundReceiptFile } from './receipt-ports.js';
import { readCardSwitchLimits } from './card-switch-limits.js';

/** What a customer's receipt photo became. Never anything a caller could turn into money. */
export type GatewayReceiptPhotoResult =
  /** No provider window is open for this customer in this bot: not ours (manual flow). */
  | 'NO_WINDOW'
  /** Queued for the gateway worker to send to the provider. */
  | 'QUEUED'
  /** This photo is already a submission, or one is already in flight: nothing new. */
  | 'DUPLICATE'
  /** This photo was sent for this payment before and that submission has ended. */
  | 'ALREADY_SENT'
  /** A document, video or anything but a photo: nothing stored, the window stays open. */
  | 'PHOTO_ONLY'
  /** Declared over the provider's 10 MB: nothing stored, the window stays open. */
  | 'TOO_LARGE'
  /** The payment can no longer take a receipt: the window was closed. */
  | 'CLOSED';

/** What a customer's typed refund card became (Round 6). */
export type GatewayRefundCardResult =
  /** Not two lines, not a 16-digit number, or a holder with more than letters: nothing stored. */
  | 'INVALID'
  /** Sealed, masked and queued for the gateway worker. */
  | 'REQUESTED'
  /** The invoice is not (or no longer) an overpayment that can be refunded: nothing stored. */
  | 'REFUSED';

/**
 * The customer's three TonPays Telegram commands (`docs/tonpays-telegram-gateway-audit.md`
 * §8.2, §8.3): ask for another card, open the receipt window, and hand a photo to it.
 *
 * Every one is a DATABASE write only — the provider is dialled by the gateway worker, never
 * while Telegram waits (`surfaces/telegram/webhook.controller.ts`). Each is an authorized
 * mutation under the guard, reads `ScopeActivityReader` inside its transaction, takes the
 * payment's row lock FIRST, and re-decides everything against the rows: the owner, the
 * method, a card-transfer route, PENDING, inside the CUSTOMER window (`now < expires_at`, no
 * review started — the review deadline never reopens either action), a created invoice, and
 * the bot the invoice is bound to. A tap names a payment id and nothing else.
 *
 * The receipt goes to the PROVIDER, never to Nexa's manual-transfer review queue: no
 * `payment_receipts` row, no `receipt_captures` window (opening this one supersedes the
 * customer's manual window in the same bot), and no exemption from expiry. Only the
 * provider's acknowledgement in the upload answer, recorded by the worker under the
 * payment's lock, may open the review window — this tap extends nothing.
 */
export class GatewayReceiptCaptureService {
  constructor(
    private readonly deps: {
      readonly guard: PermissionGuard;
      readonly uow: UnitOfWork<TransactionScope>;
      readonly audit: AuditWriter;
      readonly opsLog: OperationalEventRecorder;
      readonly sessions: SessionRepository;
      readonly scopeActivity: ScopeActivityReader;
      readonly clock: Clock;
      readonly ids: IdGenerator;
      readonly payments: Pick<
        PaymentRepository,
        'findById' | 'findByIdForUpdate' | 'hasOtherLivePaymentForOrder'
      >;
      readonly invoices: Pick<GatewayInvoiceRepository, 'findByPayment'>;
      readonly cardTransfer: GatewayCardTransferRepository;
      /** Round 6: cancel and refund requests, and the provider's latest word. */
      readonly providerRequests?: GatewayProviderRequestRepository;
      /** Round 6: seals a refund card between the customer's turn and the worker's send. */
      readonly refundCards?: RefundCardSealer;
      /** R8 A2: the owner's R5C-1 card-switch limits, which bound a TonPays card change too. */
      readonly settings: Pick<SettingsResolver, 'valueOf'>;
    },
  ) {}

  /**
   * «🔄 تعویض کارت»: a `gateway_card_changes` row `REQUESTED`, refused locally while one is
   * in flight, during the provider's cooldown, once exhausted, or when the provider hides
   * the change. Returns whether a request was written.
   */
  async requestCardChange(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly customerId: UserId;
      readonly paymentId: string;
      readonly botInstanceId: string;
      readonly idempotencyKey: string;
    },
  ): Promise<boolean> {
    const denial = {
      action: 'gateway_invoice.card_change_requested',
      entityType: 'Payment',
      entityId: input.paymentId,
    };
    return this.mutate(scope, actor, denial, async (tx, now) => {
      const open = await this.openAttempt(scope, input, now, tx);
      if (open === null) return false;
      const latest = await this.deps.cardTransfer.latestCardChange(scope, open.payment.id, tx);
      // R8 A2: the owner's limits are read under the payment's lock, with what it has used.
      const allowance: CardChangeAllowance = {
        limits: await readCardSwitchLimits(this.deps.settings, scope, tx),
        ...(await this.deps.cardTransfer.cardChangeUsage(scope, open.payment.id, tx)),
      };
      if (!cardChangeAvailable(open.invoice, latest, now, allowance)) return false;
      const requested = await this.deps.cardTransfer.requestCardChange(
        scope,
        {
          id: this.deps.ids.uuid(),
          paymentId: open.payment.id,
          botInstanceId: input.botInstanceId,
          customerId: input.customerId,
          idempotencyKey: input.idempotencyKey,
          now,
        },
        tx,
      );
      if (requested === null) return false;
      await this.deps.audit.record(
        scope,
        actor,
        {
          action: 'gateway_invoice.card_change_requested',
          entityType: 'Payment',
          entityId: open.payment.id,
          before: null,
          after: { cardChangeId: requested.id, state: requested.state },
          result: 'SUCCESS',
        },
        tx,
      );
      return true;
    });
  }

  /**
   * «📤 ارسال فیش واریزی»: opens the payment-scoped receipt window, bound to the tenant, this
   * bot, this customer, this payment, the provider and its invoice — every one from the rows.
   * Refused while a submission is in flight, while a lost upload is unresolved, once the
   * provider's last word is not `pending`, once a review started, and at or after the
   * deadline. The window lasts ten minutes, capped at the payment's own deadline.
   */
  async openReceiptCapture(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly customerId: UserId;
      readonly paymentId: string;
      readonly botInstanceId: string;
    },
  ): Promise<GatewayReceiptCaptureRecord | null> {
    const denial = {
      action: 'gateway_receipt.capture_opened',
      entityType: 'Payment',
      entityId: input.paymentId,
    };
    return this.mutate(scope, actor, denial, async (tx, now) => {
      const open = await this.openAttempt(scope, input, now, tx, 'SETTLEMENT');
      if (open === null || open.payment.expiresAt === null) return null;
      const invoiceId = open.invoice.providerInvoiceId;
      if (invoiceId === null) return null;
      const submissions = await this.deps.cardTransfer.submissionsFor(scope, open.payment.id, tx);
      /*
       * Round 6: an UNDERPAID invoice takes the receipt of its remainder, sent to the invoice
       * the provider named (`remaining_invoice_id`), and may do so inside the provider's review
       * window. Any other invoice takes the ordinary receipt: pending, customer window only.
       */
      const facts =
        open.invoice.providerStatus === TONPAYS_TELEGRAM_STATUS_LESS
          ? ((await this.deps.providerRequests?.factsFor(scope, open.payment.id, tx)) ?? null)
          : null;
      let providerInvoiceId: string;
      let deadline: Date;
      if (facts !== null && facts.need === 'LESS') {
        if (!remainderReceiptAvailable(open.invoice, facts, submissions)) return null;
        if (facts.remainingInvoiceId === null) return null;
        providerInvoiceId = facts.remainingInvoiceId;
        deadline = gatewaySettlementDeadline(open.payment) ?? open.payment.expiresAt;
      } else {
        if (open.payment.providerReviewUntil !== null) return null;
        if (!receiptUploadAvailable(open.invoice, submissions)) return null;
        providerInvoiceId = invoiceId;
        deadline = open.payment.expiresAt;
      }
      const expiresAt = new Date(
        Math.min(
          now.getTime() + TONPAYS_TELEGRAM_RECEIPT_CAPTURE_MINUTES * 60_000,
          deadline.getTime(),
        ),
      );
      const capture = await this.deps.cardTransfer.openCapture(
        scope,
        {
          id: this.deps.ids.uuid(),
          botInstanceId: input.botInstanceId,
          customerId: input.customerId,
          paymentId: open.payment.id,
          providerInvoiceId,
          openedAt: now,
          expiresAt,
        },
        tx,
      );
      await this.deps.audit.record(
        scope,
        actor,
        {
          action: 'gateway_receipt.capture_opened',
          entityType: 'Payment',
          entityId: open.payment.id,
          before: null,
          after: { captureId: capture.id, expiresAt: capture.expiresAt.toISOString() },
          result: 'SUCCESS',
        },
        tx,
      );
      return capture;
    });
  }

  /** The open provider window for this customer in this bot, if any. A read. */
  async openCaptureFor(
    scope: TenantContext,
    botInstanceId: string,
    customerId: UserId,
  ): Promise<GatewayReceiptCaptureRecord | null> {
    return this.deps.cardTransfer.findOpenCapture(scope, botInstanceId, customerId);
  }

  /**
   * A file the customer sent while a provider window is open IN THIS BOT (TPTG-07): the
   * window is looked up by (tenant, this bot, customer) and the payment, provider and invoice
   * come from its row, never from the update. A photo only, declared at most 10 MB; queued
   * and the window closed `RECEIVED`, under the payment's lock. Nothing is downloaded or
   * uploaded here.
   */
  async receivePhoto(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly customerId: UserId;
      readonly botInstanceId: string;
      readonly file: InboundReceiptFile;
    },
  ): Promise<GatewayReceiptPhotoResult> {
    const capture = await this.deps.cardTransfer.findOpenCapture(
      scope,
      input.botInstanceId,
      input.customerId,
    );
    if (capture === null) return 'NO_WINDOW';
    /*
     * Round 6: a photo, or a document whose declared type is one of the provider's four image
     * types (JPEG, PNG, WebP, GIF — Telegram only delivers WebP and GIF as documents). A video,
     * a PDF or any other document stores nothing. The declared type is a claim: the worker
     * sniffs the bytes before anything is uploaded.
     */
    const acceptedDocument =
      input.file.kind === 'DOCUMENT' &&
      input.file.mimeType !== null &&
      (TONPAYS_TELEGRAM_RECEIPT_MIME_TYPES as readonly string[]).includes(
        input.file.mimeType.toLowerCase(),
      );
    if (input.file.kind !== 'PHOTO' && !acceptedDocument) return 'PHOTO_ONLY';
    if (
      input.file.fileSize !== null &&
      input.file.fileSize > BigInt(TONPAYS_TELEGRAM_RECEIPT_MAX_BYTES)
    ) {
      return 'TOO_LARGE';
    }
    const denial = {
      action: 'gateway_receipt.queued',
      entityType: 'Payment',
      entityId: capture.paymentId,
    };
    return this.mutate(scope, actor, denial, async (tx, now) => {
      const payment = await this.deps.payments.findByIdForUpdate(scope, capture.paymentId, tx);
      /*
       * The window read again, in this transaction and after the payment's lock (review
       * F10): the read above was outside any transaction, and a manual window opened since
       * has closed this one. The photo is then the manual flow's, never this provider's.
       *
       * UNDER the capture namespace's lock (Codex review of #136), the one every window
       * opening takes: an unlocked re-read could see this window open while a manual one,
       * opening concurrently, closed it — and the photo would still go to TonPays.
       */
      await this.deps.cardTransfer.lockCaptureNamespace(
        scope,
        input.botInstanceId,
        input.customerId,
        tx,
      );
      const current = await this.deps.cardTransfer.findOpenCapture(
        scope,
        input.botInstanceId,
        input.customerId,
        tx,
      );
      if (current === null || current.id !== capture.id) return 'NO_WINDOW';
      /*
       * One payment in flight per order (OQ-TPTG-17, decided): a receipt is not taken while
       * the order has another live payment. Read after this payment's lock, which every path
       * issuing a new payment for the order takes first (`lockPendingForOrder`): either that
       * path sees this receipt and refuses, or this read sees its payment and refuses.
       */
      const otherLive =
        payment !== null &&
        payment.orderId !== null &&
        (await this.deps.payments.hasOtherLivePaymentForOrder(
          scope,
          payment.orderId,
          payment.id,
          tx,
        ));
      const invoice = await this.deps.invoices.findByPayment(scope, capture.paymentId, tx);
      const submissions = await this.deps.cardTransfer.submissionsFor(scope, capture.paymentId, tx);
      /*
       * The window's target is the invoice's own id, or — for a remainder — the id the provider
       * named, re-read now: a remainder window is usable only while the provider still reports
       * the underpayment, and only inside the settlement deadline (the review window included).
       */
      const facts =
        invoice !== null && invoice.providerStatus === TONPAYS_TELEGRAM_STATUS_LESS
          ? ((await this.deps.providerRequests?.factsFor(scope, capture.paymentId, tx)) ?? null)
          : null;
      const remainder =
        invoice !== null &&
        invoice.providerInvoiceId !== capture.providerInvoiceId &&
        facts !== null &&
        facts.need === 'LESS' &&
        facts.remainingInvoiceId === capture.providerInvoiceId;
      const deadline =
        payment === null
          ? null
          : remainder
            ? gatewaySettlementDeadline(payment)
            : payment.providerReviewUntil === null
              ? payment.expiresAt
              : null;
      const usable =
        !otherLive &&
        payment !== null &&
        payment.customerId === input.customerId &&
        payment.state === 'PENDING' &&
        deadline !== null &&
        now.getTime() < deadline.getTime() &&
        now.getTime() < capture.expiresAt.getTime() &&
        invoice !== null &&
        invoice.creationState === 'CREATED' &&
        (remainder || invoice.providerInvoiceId === capture.providerInvoiceId) &&
        invoice.botInstanceId === capture.botInstanceId &&
        capture.botInstanceId === input.botInstanceId;
      if (!usable) {
        await this.deps.cardTransfer.closeCapture(
          scope,
          capture.id,
          now.getTime() >= capture.expiresAt.getTime() ? 'EXPIRED' : 'PAYMENT_CLOSED',
          now,
          tx,
        );
        return 'CLOSED';
      }
      if (
        remainder
          ? !remainderReceiptAvailable(invoice, facts, submissions)
          : !receiptUploadAvailable(invoice, submissions)
      ) {
        return 'DUPLICATE';
      }
      /*
       * The very photo of a submission that has ENDED (Codex review of #136): the (payment,
       * file) key refuses a second row, so nothing would be queued — the customer is asked
       * for another photo instead of being told this one is on its way, and the window stays
       * open for it.
       */
      if (
        submissions.some(
          (one) =>
            one.telegramFileUniqueId === input.file.fileUniqueId &&
            one.state !== 'QUEUED' &&
            one.state !== 'SENDING',
        )
      ) {
        return 'ALREADY_SENT';
      }
      const queued = await this.deps.cardTransfer.queueSubmission(
        scope,
        {
          id: this.deps.ids.uuid(),
          paymentId: capture.paymentId,
          providerInvoiceId: capture.providerInvoiceId,
          botInstanceId: capture.botInstanceId,
          customerId: input.customerId,
          captureId: capture.id,
          telegramFileId: input.file.fileId,
          telegramFileUniqueId: input.file.fileUniqueId,
          declaredSize: input.file.fileSize,
          now,
        },
        tx,
      );
      if (queued === null) return 'DUPLICATE';
      await this.deps.cardTransfer.closeCapture(scope, capture.id, 'RECEIVED', now, tx);
      await this.deps.audit.record(
        scope,
        actor,
        {
          action: 'gateway_receipt.queued',
          entityType: 'Payment',
          entityId: capture.paymentId,
          before: null,
          // The submission's id and state only: never the file id, a caption or bytes.
          after: { submissionId: queued.id, state: queued.state, captureId: capture.id },
          result: 'SUCCESS',
        },
        tx,
      );
      return 'QUEUED';
    });
  }

  /**
   * «❌ لغو فاکتور» (Round 6): a `gateway_provider_requests` row `CANCEL / REQUESTED`, which the
   * gateway worker sends. Re-decided under the payment's lock: this customer's PENDING payment
   * inside the CUSTOMER window (a review means a receipt, and a receipt means `processing`), a
   * created invoice whose provider status is `pending`, no cancel in flight or applied, no
   * receipt on its way. Returns whether a request was written.
   *
   * R11 A8 (owner): a previous cancel whose answer was lost, or that the provider rate-limited,
   * does not stop this one — it is a NEW row (the in-flight index still allows one at a time),
   * held back from the worker for `cancelRetryNotBefore` so it is not sent into the same trouble.
   */
  async requestCancel(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly customerId: UserId;
      readonly paymentId: string;
      readonly botInstanceId: string;
      readonly idempotencyKey: string;
    },
  ): Promise<boolean> {
    const requests = this.deps.providerRequests;
    if (requests === undefined) return false;
    const denial = {
      action: 'gateway_invoice.cancel_requested',
      entityType: 'Payment',
      entityId: input.paymentId,
    };
    return this.mutate(scope, actor, denial, async (tx, now) => {
      const open = await this.openAttempt(scope, input, now, tx);
      if (open === null) return false;
      const latest = await requests.latest(scope, open.payment.id, 'CANCEL', tx);
      const submissions = await this.deps.cardTransfer.submissionsFor(scope, open.payment.id, tx);
      if (!cancelAvailable(open.invoice, latest, submissions)) return false;
      /*
       * Codex (#356): a retry whose spacing would only end at or after the customer window is
       * not written. Such a row would still be waiting when Nexa's deadline expires the attempt;
       * one cancel at a time, so the expiry cancel could not be written, and the lane would then
       * refuse this one (`nexa.attempt_closed`), leaving TonPays' invoice `pending`. Without it,
       * the expiry cancel follows at the deadline. Same bound as the lane's HELD requeue.
       */
      const notBefore = cancelRetryNotBefore(latest, now);
      const deadline = gatewaySettlementDeadline(open.payment) ?? open.payment.expiresAt;
      if (notBefore !== null && (deadline === null || notBefore.getTime() >= deadline.getTime())) {
        return false;
      }
      const requested = await requests.request(
        scope,
        {
          id: this.deps.ids.uuid(),
          paymentId: open.payment.id,
          botInstanceId: input.botInstanceId,
          customerId: input.customerId,
          kind: 'CANCEL',
          idempotencyKey: input.idempotencyKey,
          now,
          claimedUntil: notBefore,
          refund: null,
        },
        tx,
      );
      if (requested === null) return false;
      await this.deps.audit.record(
        scope,
        actor,
        {
          action: 'gateway_invoice.cancel_requested',
          entityType: 'Payment',
          entityId: open.payment.id,
          before: null,
          after: {
            requestId: requested.id,
            state: requested.state,
            reason: 'CUSTOMER',
            // R11 A8: the cancel request this one follows, if any (a retry after a lost answer).
            retryOf: latest === null ? null : latest.id,
          },
          result: 'SUCCESS',
        },
        tx,
      );
      return true;
    });
  }

  /** Whether the cancel question may be asked NOW (a read; the write re-decides under the lock). */
  async cancelOffered(
    scope: TenantContext,
    input: {
      readonly customerId: UserId;
      readonly paymentId: string;
      readonly botInstanceId: string;
    },
  ): Promise<boolean> {
    const requests = this.deps.providerRequests;
    if (requests === undefined || !/^[0-9a-f-]{36}$/u.test(input.paymentId)) return false;
    const now = this.deps.clock.now();
    const payment = await this.deps.payments.findById(scope, input.paymentId as PaymentId);
    if (
      payment === null ||
      payment.customerId !== input.customerId ||
      payment.state !== 'PENDING' ||
      payment.providerReviewUntil !== null ||
      payment.expiresAt === null ||
      now.getTime() >= payment.expiresAt.getTime()
    ) {
      return false;
    }
    const invoice = await this.deps.invoices.findByPayment(scope, payment.id);
    if (invoice === null || invoice.botInstanceId !== input.botInstanceId) return false;
    const [latest, submissions] = await Promise.all([
      requests.latest(scope, payment.id, 'CANCEL'),
      this.deps.cardTransfer.submissionsFor(scope, payment.id),
    ]);
    return cancelAvailable(invoice, latest, submissions);
  }

  /** Whether the refund-card prompt may be opened NOW (a read; the write re-decides). */
  async refundCardOffered(
    scope: TenantContext,
    input: {
      readonly customerId: UserId;
      readonly paymentId: string;
      readonly botInstanceId: string;
    },
  ): Promise<boolean> {
    const requests = this.deps.providerRequests;
    if (
      requests === undefined ||
      this.deps.refundCards === undefined ||
      !/^[0-9a-f-]{36}$/u.test(input.paymentId)
    ) {
      return false;
    }
    const now = this.deps.clock.now();
    const payment = await this.deps.payments.findById(scope, input.paymentId as PaymentId);
    if (
      payment === null ||
      payment.customerId !== input.customerId ||
      payment.state !== 'PENDING' ||
      payment.expiresAt === null ||
      now.getTime() >= (gatewaySettlementDeadline(payment) ?? payment.expiresAt).getTime()
    ) {
      return false;
    }
    const invoice = await this.deps.invoices.findByPayment(scope, payment.id);
    if (invoice === null || invoice.botInstanceId !== input.botInstanceId) return false;
    const [facts, latest] = await Promise.all([
      requests.factsFor(scope, payment.id),
      requests.latest(scope, payment.id, 'REFUND'),
    ]);
    return refundCardAvailable(invoice, facts, latest);
  }

  /**
   * The customer's typed refund card (Round 6): validated locally, then — under the payment's
   * lock, with the overpayment re-decided — sealed and queued for the worker. The number
   * exists in this method's memory only; the row keeps the masked form and the sealed form
   * until the worker's send stamp wipes it. Nothing here is logged or audited but ids and
   * states. Returns `INVALID` for a bad format and `REFUSED` when the invoice cannot take a
   * refund now; neither stores anything.
   */
  async requestRefund(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly customerId: UserId;
      readonly paymentId: string;
      readonly botInstanceId: string;
      readonly idempotencyKey: string;
      readonly text: string;
    },
  ): Promise<GatewayRefundCardResult> {
    const requests = this.deps.providerRequests;
    const sealer = this.deps.refundCards;
    const card = parseRefundCardInput(input.text);
    if (card === null) return 'INVALID';
    if (requests === undefined || sealer === undefined) return 'REFUSED';
    const denial = {
      action: 'gateway_invoice.refund_requested',
      entityType: 'Payment',
      entityId: input.paymentId,
    };
    return this.mutate(scope, actor, denial, async (tx, now) => {
      const open = await this.openAttempt(scope, input, now, tx, 'SETTLEMENT');
      if (open === null) return 'REFUSED' as const;
      const [facts, latest] = await Promise.all([
        requests.factsFor(scope, open.payment.id, tx),
        requests.latest(scope, open.payment.id, 'REFUND', tx),
      ]);
      if (!refundCardAvailable(open.invoice, facts, latest)) return 'REFUSED' as const;
      const id = this.deps.ids.uuid();
      const requested = await requests.request(
        scope,
        {
          id,
          paymentId: open.payment.id,
          botInstanceId: input.botInstanceId,
          customerId: input.customerId,
          kind: 'REFUND',
          idempotencyKey: input.idempotencyKey,
          now,
          claimedUntil: null,
          refund: {
            masked: maskRefundCard(card.cardNumber),
            sealed: sealer.seal(scope, id, card),
          },
        },
        tx,
      );
      if (requested === null) return 'REFUSED' as const;
      await this.deps.audit.record(
        scope,
        actor,
        {
          action: 'gateway_invoice.refund_requested',
          entityType: 'Payment',
          entityId: open.payment.id,
          before: null,
          // The request's id and state only: not the card, not the holder, not the mask.
          after: { requestId: requested.id, state: requested.state },
          result: 'SUCCESS',
        },
        tx,
      );
      return 'REQUESTED' as const;
    });
  }

  // ---------------------------------------------------------------------------------------

  /**
   * The attempt a tap names, re-decided under the payment's lock: this customer's PENDING
   * card-transfer payment inside its customer window, with a created invoice bound to the
   * bot the tap arrived through. Null for anything else — the caller answers "closed".
   */
  private async openAttempt(
    scope: TenantContext,
    input: {
      readonly customerId: UserId;
      readonly paymentId: string;
      readonly botInstanceId: string;
    },
    now: Date,
    tx: TransactionScope,
    /**
     * `CUSTOMER` (default): the seventy-minute window with no review started. `SETTLEMENT`
     * (Round 6): the payment's settlement deadline — the review window included — for the
     * actions an under- or overpayment makes possible; the caller narrows it again.
     */
    window: 'CUSTOMER' | 'SETTLEMENT' = 'CUSTOMER',
  ): Promise<{ readonly payment: PaymentRecord; readonly invoice: GatewayInvoiceRecord } | null> {
    if (!/^[0-9a-f-]{36}$/u.test(input.paymentId)) return null;
    const payment = await this.deps.payments.findByIdForUpdate(
      scope,
      input.paymentId as PaymentId,
      tx,
    );
    if (
      payment === null ||
      payment.customerId !== input.customerId ||
      payment.method !== 'GATEWAY' ||
      payment.gatewayProvider === null ||
      PAYMENT_GATEWAY_DESCRIPTORS[payment.gatewayProvider].invoiceForm !== 'CARD_TRANSFER' ||
      payment.state !== 'PENDING' ||
      (window === 'CUSTOMER' && payment.providerReviewUntil !== null) ||
      payment.expiresAt === null ||
      (window === 'CUSTOMER' && now.getTime() >= payment.expiresAt.getTime()) ||
      (window === 'SETTLEMENT' &&
        now.getTime() >= (gatewaySettlementDeadline(payment) ?? payment.expiresAt).getTime())
    ) {
      return null;
    }
    const invoice = await this.deps.invoices.findByPayment(scope, payment.id, tx);
    if (
      invoice === null ||
      invoice.creationState !== 'CREATED' ||
      invoice.botInstanceId !== input.botInstanceId
    ) {
      return null;
    }
    return { payment, invoice };
  }

  private mutate<T>(
    scope: TenantContext,
    actor: ActorContext,
    denial: { readonly action: string; readonly entityType: string; readonly entityId: string },
    fn: (tx: TransactionScope, now: Date) => Promise<T>,
  ): Promise<T> {
    return runAuthorizedMutation(
      {
        uow: this.deps.uow,
        guard: this.deps.guard,
        audit: this.deps.audit,
        opsLog: this.deps.opsLog,
        sessions: this.deps.sessions,
        clock: this.deps.clock,
      },
      scope,
      actor,
      PAYMENT_PLACE_PERMISSION,
      denial,
      async (tx) => {
        // A stopped scope accepts no new work, decided INSIDE the transaction.
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
            'This installation has stopped accepting work.',
          );
        }
        return fn(tx, this.deps.clock.now());
      },
    );
  }
}
