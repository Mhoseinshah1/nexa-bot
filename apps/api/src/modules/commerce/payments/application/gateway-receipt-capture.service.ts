import {
  COMMERCE_ERROR_CODES,
  PAYMENT_GATEWAY_DESCRIPTORS,
  TONPAYS_TELEGRAM_RECEIPT_CAPTURE_MINUTES,
  TONPAYS_TELEGRAM_RECEIPT_MAX_BYTES,
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
import { cardChangeAvailable, receiptUploadAvailable } from '../domain/tonpays-telegram.js';
import type {
  GatewayCardTransferRepository,
  GatewayInvoiceRecord,
  GatewayInvoiceRepository,
  GatewayReceiptCaptureRecord,
} from './gateway-invoice-ports.js';
import type { PaymentRecord, PaymentRepository } from './ports.js';
import { PAYMENT_PLACE_PERMISSION } from './payment.service.js';
import type { InboundReceiptFile } from './receipt-ports.js';

/** What a customer's receipt photo became. Never anything a caller could turn into money. */
export type GatewayReceiptPhotoResult =
  /** No provider window is open for this customer in this bot: not ours (manual flow). */
  | 'NO_WINDOW'
  /** Queued for the gateway worker to send to the provider. */
  | 'QUEUED'
  /** This photo is already a submission, or one is already in flight: nothing new. */
  | 'DUPLICATE'
  /** A document, video or anything but a photo: nothing stored, the window stays open. */
  | 'PHOTO_ONLY'
  /** Declared over the provider's 5 MB: nothing stored, the window stays open. */
  | 'TOO_LARGE'
  /** The payment can no longer take a receipt: the window was closed. */
  | 'CLOSED';

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
        'findByIdForUpdate' | 'hasOtherLivePaymentForOrder'
      >;
      readonly invoices: Pick<GatewayInvoiceRepository, 'findByPayment'>;
      readonly cardTransfer: GatewayCardTransferRepository;
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
      if (!cardChangeAvailable(open.invoice, latest, now)) return false;
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
      const open = await this.openAttempt(scope, input, now, tx);
      if (open === null || open.payment.expiresAt === null) return null;
      const providerInvoiceId = open.invoice.providerInvoiceId;
      if (providerInvoiceId === null) return null;
      const submissions = await this.deps.cardTransfer.submissionsFor(scope, open.payment.id, tx);
      if (!receiptUploadAvailable(open.invoice, submissions)) return null;
      const expiresAt = new Date(
        Math.min(
          now.getTime() + TONPAYS_TELEGRAM_RECEIPT_CAPTURE_MINUTES * 60_000,
          open.payment.expiresAt.getTime(),
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
   * come from its row, never from the update. A photo only, declared at most 5 MB; queued
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
    // TPTG-09: a document (even image/*), a video or anything but a photo stores nothing.
    if (input.file.kind !== 'PHOTO') return 'PHOTO_ONLY';
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
       */
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
      const usable =
        !otherLive &&
        payment !== null &&
        payment.customerId === input.customerId &&
        payment.state === 'PENDING' &&
        payment.providerReviewUntil === null &&
        payment.expiresAt !== null &&
        now.getTime() < payment.expiresAt.getTime() &&
        now.getTime() < capture.expiresAt.getTime() &&
        invoice !== null &&
        invoice.creationState === 'CREATED' &&
        invoice.providerInvoiceId === capture.providerInvoiceId &&
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
      const submissions = await this.deps.cardTransfer.submissionsFor(scope, capture.paymentId, tx);
      if (!receiptUploadAvailable(invoice, submissions)) return 'DUPLICATE';
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
      payment.providerReviewUntil !== null ||
      payment.expiresAt === null ||
      now.getTime() >= payment.expiresAt.getTime()
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
