import { createHash } from 'node:crypto';
import {
  COMMERCE_ERROR_CODES,
  MINIAPP_ERROR_CODES,
  MINIAPP_RECEIPT_MAX_BYTES,
  errors,
  isNexaError,
  type ActorContext,
  type IdempotencyStore,
  type PaymentId,
} from '@nexa/contracts';
import { rememberOnce } from '../../../platform/idempotency/application/remember-once.js';
import type { PaymentRecord } from '../../payments/application/ports.js';
import type { InboundReceiptFile } from '../../payments/application/receipt-ports.js';
import type {
  ReceiptSubmission,
  ReceiptSubmissionResult,
} from '../../payments/application/receipt.service.js';
import type {
  PaymentSentSignal,
  TransferSignalResult,
} from '../../payments/application/payment.service.js';
import { checkReceiptImage } from '../domain/receipt-image.js';
import type { MiniAppContext } from './miniapp-session.service.js';
import type { ReceiptImageUploader } from './ports.js';

export interface MiniAppReceiptServiceDeps {
  readonly payments: {
    pendingTransferForCustomer(
      scope: MiniAppContext['scope'],
      customerId: MiniAppContext['customer']['id'],
      id: string,
    ): Promise<PaymentRecord | null>;
    signalTransferSent(
      scope: MiniAppContext['scope'],
      actor: ActorContext,
      customerId: MiniAppContext['customer']['id'],
      signal: PaymentSentSignal,
    ): Promise<TransferSignalResult>;
  };
  readonly receipts: {
    submit(
      scope: MiniAppContext['scope'],
      actor: ActorContext,
      customerId: MiniAppContext['customer']['id'],
      submission: ReceiptSubmission,
    ): Promise<ReceiptSubmissionResult>;
  };
  readonly uploader: ReceiptImageUploader;
  readonly idempotency: IdempotencyStore;
}

/** What one uploaded receipt became. */
export interface MiniAppReceiptResult {
  readonly paymentId: PaymentId;
  /** False when this exact file was already on the payment (a retried upload). */
  readonly filed: boolean;
  /** True for the payment's FIRST receipt. */
  readonly first: boolean;
}

/**
 * A card-to-card receipt sent from the mini app (owner correction of 2026-10-25): the image
 * is validated by its bytes, put into Telegram by the customer's own bot so it has the
 * `file_id` the receipt module stores, and handed to `ReceiptService.submit` UNCHANGED.
 *
 * So everything that makes a receipt a receipt is the bot's code, not a copy: the open
 * receipt window keyed on (bot, customer), the payment re-read FOR UPDATE and owned, PENDING
 * only, the five-per-payment cap, the `(payment, file_unique_id)` duplicate guard, the
 * blocked-customer refusal, the audit row, the `PaymentReceiptSubmitted` event and the
 * administrators' review push it drives. What the mini app adds is only the step the
 * customer's Telegram client does in the bot: getting the photo into Telegram.
 *
 * The order, cheapest and safest first: the payment must be this customer's own PENDING
 * transfer (another customer's is "not found", before a byte is looked at); the bytes must be
 * a JPEG, PNG or WebP of at most `MINIAPP_RECEIPT_MAX_BYTES` whose declared type matches;
 * then the window is (re)opened FOR THIS payment through `signalTransferSent` — the bot's
 * «پرداخت را انجام دادم», which records the claim and opens the window in one step — so the
 * receipt cannot land on another payment the window happened to name; only then is anything
 * uploaded. The upload is network time in which another tap can move the window, so the
 * submission names the payment too and the receipt service refuses, under its capture lock,
 * a window that no longer names it (`WINDOW_MOVED`) instead of filing the image elsewhere.
 */
export class MiniAppReceiptService {
  constructor(private readonly deps: MiniAppReceiptServiceDeps) {}

  async submit(
    context: MiniAppContext,
    actor: ActorContext,
    input: {
      readonly paymentId: string;
      readonly bytes: Uint8Array;
      readonly declaredMimeType: string;
      /** The client's key, already namespaced `miniapp:<bot>:<customer>:<key>`. */
      readonly idempotencyKey: string;
    },
  ): Promise<MiniAppReceiptResult> {
    const { scope, customer } = context;
    const payment = await this.deps.payments.pendingTransferForCustomer(
      scope,
      customer.id,
      input.paymentId,
    );
    if (payment === null) {
      throw errors.notFound(MINIAPP_ERROR_CODES.MINIAPP_NOT_FOUND, 'No such pending transfer.');
    }
    const verdict = checkReceiptImage({
      bytes: input.bytes,
      declaredMimeType: input.declaredMimeType,
      maxBytes: MINIAPP_RECEIPT_MAX_BYTES,
    });
    if (verdict.outcome === 'REFUSED') {
      throw errors.validation(
        MINIAPP_ERROR_CODES.MINIAPP_RECEIPT_REFUSED,
        'The receipt image is refused.',
        {
          reason: verdict.reason,
          maxBytes: MINIAPP_RECEIPT_MAX_BYTES,
        },
      );
    }

    const signal = await this.deps.payments.signalTransferSent(scope, actor, customer.id, {
      idempotencyKey: `${input.idempotencyKey}:pay-sent`,
      paymentId: payment.id,
      botInstanceId: context.botInstanceId,
    });
    if (signal.receiptWindow === null) {
      // The payment holds every receipt it can, or is already under review: the same
      // answer the bot gives a file nobody asked for.
      throw errors.conflict(
        MINIAPP_ERROR_CODES.MINIAPP_RECEIPT_REFUSED,
        'No receipt is expected for this payment.',
        { reason: 'NOT_EXPECTED' },
      );
    }

    // The upload's message is deleted inside `telegramFile` whatever happens next, so a
    // refusal below leaves nothing behind in the customer's chat.
    const file = await this.telegramFile(context, input, verdict.mimeType);
    let submitted: ReceiptSubmissionResult;
    try {
      submitted = await this.deps.receipts.submit(scope, actor, customer.id, {
        idempotencyKey: `${input.idempotencyKey}:receipt`,
        botInstanceId: context.botInstanceId,
        file,
        // The window was opened for this payment above, but the upload sat between that
        // commit and this call, and another tap (in the bot, or a second upload here) can
        // have moved it. The receipt service re-checks under its capture lock and refuses a
        // window that now names another payment; it never files this image there.
        expectedPaymentId: payment.id,
      });
    } catch (error) {
      if (isNexaError(error) && error.code === COMMERCE_ERROR_CODES.RECEIPT_NOT_EXPECTED) {
        throw errors.conflict(
          MINIAPP_ERROR_CODES.MINIAPP_RECEIPT_REFUSED,
          'No receipt is expected for this payment.',
          { reason: error.details['reason'] === 'WINDOW_MOVED' ? 'WINDOW_MOVED' : 'NOT_EXPECTED' },
        );
      }
      throw error;
    }
    return { paymentId: submitted.paymentId, filed: submitted.filed, first: submitted.first };
  }

  /**
   * The upload, once per client key and file: a retried request with the same bytes gets
   * the file Telegram already holds instead of a second upload (whose new `file_unique_id`
   * would make the receipt key's replay a payload mismatch).
   */
  private async telegramFile(
    context: MiniAppContext,
    input: { readonly bytes: Uint8Array; readonly idempotencyKey: string },
    mimeType: 'image/jpeg' | 'image/png' | 'image/webp',
  ): Promise<InboundReceiptFile> {
    const key = `${input.idempotencyKey}:receipt-upload`;
    const requestHash = createHash('sha256').update(input.bytes).digest('hex');
    const stored = await this.deps.idempotency.find<{ fileId: string; fileUniqueId: string }>(
      context.scope,
      'MINI_APP',
      key,
      requestHash,
    );
    let handle = stored?.result ?? null;
    if (handle === null) {
      const uploaded = await this.deps.uploader.upload(context.scope, {
        botInstanceId: context.botInstanceId,
        chatId: context.telegramUserId,
        bytes: input.bytes,
        mimeType,
      });
      if (uploaded.outcome !== 'UPLOADED') {
        throw errors.preconditionFailed(
          MINIAPP_ERROR_CODES.MINIAPP_RECEIPT_UPLOAD_FAILED,
          'Telegram did not accept the receipt image.',
          { code: uploaded.code },
        );
      }
      handle = { fileId: uploaded.fileId, fileUniqueId: uploaded.fileUniqueId };
      await rememberOnce(
        this.deps.idempotency,
        context.scope,
        'MINI_APP',
        key,
        requestHash,
        handle,
      );
    }
    // The bot path's shape for a photo exactly: Telegram re-encodes a photo, so its type is
    // not claimed; no caption (the mini app asks for none); the upload message is deleted,
    // so there is no message id to point at.
    return {
      kind: 'PHOTO',
      fileId: handle.fileId,
      fileUniqueId: handle.fileUniqueId,
      mimeType: null,
      fileName: null,
      fileSize: null,
      telegramMessageId: null,
      caption: null,
    };
  }
}
