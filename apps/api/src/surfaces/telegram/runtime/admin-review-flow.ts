// Admin-in-bot: the receipt review queue and its decisions — approve, reject, credit,
// block, refund requests — and the review-message pipeline. Moved verbatim out of
// bot-runtime.ts (R9 split): each method is a free function taking the runtime first.
import {
  ADMIN_AMOUNT_CAPTURE_TTL_MS,
  COMMERCE_ERROR_CODES,
  paymentTrackingCode,
  isNexaError,
} from '@nexa/contracts';
import type {
  ActorContext,
  BotInstanceId,
  PaymentId,
  PermissionKey,
  TemplateKey,
  TemplateValues,
  TenantContext,
} from '@nexa/contracts';
import type { ReasonAskResult } from '../../../modules/commerce/payments/application/receipt-reason-capture.service.js';
import { ADMIN_CAPTURE_REASON_MAX_LENGTH } from '@nexa/contracts';
import type {
  CustomerButton,
  CustomerSendOutcome,
  CustomerSendResult,
  CustomerMessageRef,
} from '../../../modules/commerce/messaging/application/ports.js';
import type { CustomerRecord } from '../../../modules/commerce/customers/application/ports.js';
import { amountToTransfer } from '../../../modules/commerce/payments/domain/amount-to-transfer.js';
import type { TelegramReviewOutcome } from '@nexa/contracts';
import { REVIEW_OUTCOME_KEYS, type CallbackOrigin, type ReviewDirective } from '../wizard-state.js';
import {
  ADMIN_APPROVE_CALLBACK_PREFIX,
  ADMIN_BLOCK_ASK_CALLBACK_PREFIX,
  ADMIN_BLOCK_CANCEL_CALLBACK_PREFIX,
  ADMIN_BLOCK_CONFIRM_CALLBACK_PREFIX,
  ADMIN_BLOCK_OPEN_CALLBACK_PREFIX,
  ADMIN_CREDIT_CALLBACK_PREFIX,
  ADMIN_CREDIT_CANCEL_CALLBACK_PREFIX,
  ADMIN_CREDIT_CONFIRM_CALLBACK_PREFIX,
  ADMIN_CUSTOMER_CALLBACK_PREFIX,
  ADMIN_RECEIPT_CALLBACK_PREFIX,
  ADMIN_REFUND_REQUEST_APPROVE_CALLBACK_PREFIX,
  ADMIN_REFUND_REQUEST_APPROVE_CANCEL_CALLBACK_PREFIX,
  ADMIN_REFUND_REQUEST_APPROVE_CONFIRM_CALLBACK_PREFIX,
  ADMIN_REFUND_REQUEST_REJECT_CALLBACK_PREFIX,
  ADMIN_REJECT_CALLBACK_PREFIX,
  ADMIN_REJECT_CANCEL_CALLBACK_PREFIX,
  ADMIN_REJECT_CONFIRM_CALLBACK_PREFIX,
  ADMIN_SERVICE_CALLBACK_PREFIX,
} from './callbacks.js';
import { updateIdOf } from './intent-of.js';
import { type BotIntent } from './intents.js';
import { type PendingReply, type ReplyMedia, editSent } from './replies.js';
import type { BotRuntime } from '../bot-runtime.js';
import {
  ADMIN_QUEUE_LIMIT,
  CUSTOMERS_BLOCK_PERMISSION,
  CUSTOMERS_VIEW_PERMISSION,
  RECEIPTS_REVIEW_PERMISSION,
  SERVICES_VIEW_PERMISSION,
  WALLET_CREDIT_PERMISSION,
} from './admin-common.js';

/**
 * The decisions a receipt's message carries, for ONE administrator — the builder the pull item
 * and the administrators' push both use, so the two messages cannot offer different buttons.
 *
 * Each button is drawn only for the key its path charges, and each key gates its own:
 *
 *   - approve and reject: `receipts.review` (`receipts.view` opens the item, and the seeded
 *     observer holds it without the review key);
 *   - credit to wallet: `receipts.review` AND `users.wallet.credit`, both of which the credit
 *     charges;
 *   - block the customer: `users.block`, INDEPENDENT of `receipts.review` — it is the customers
 *     section's permission, and a support administrator who may block but not decide money
 *     gets that one button and no other.
 *
 * Advertising only: every tap is charged again by the path behind it.
 */
export function receiptReviewButtons(
  paymentId: string,
  permissions: ReadonlySet<PermissionKey>,
  available: { readonly credit: boolean; readonly block: boolean },
): CustomerButton[] {
  const buttons: CustomerButton[] = [];
  if (permissions.has(RECEIPTS_REVIEW_PERMISSION)) {
    buttons.push(
      {
        label: { kind: 'TEMPLATE', key: 'bot.admin.approve_button' },
        data: `${ADMIN_APPROVE_CALLBACK_PREFIX}${paymentId}`,
        row: 0,
      },
      {
        label: { kind: 'TEMPLATE', key: 'bot.admin.reject_button' },
        data: `${ADMIN_REJECT_CALLBACK_PREFIX}${paymentId}`,
        row: 0,
      },
    );
    if (available.credit && permissions.has(WALLET_CREDIT_PERMISSION)) {
      buttons.push({
        label: { kind: 'TEMPLATE', key: 'bot.admin.credit_button' },
        data: `${ADMIN_CREDIT_CALLBACK_PREFIX}${paymentId}`,
        row: 1,
      });
    }
  }
  if (available.block && permissions.has(CUSTOMERS_BLOCK_PERMISSION)) {
    buttons.push({
      label: { kind: 'TEMPLATE', key: 'bot.admin.block_button' },
      data: `${ADMIN_BLOCK_ASK_CALLBACK_PREFIX}${paymentId}`,
      row: 1,
    });
  }
  return buttons;
}

/**
 * The four buttons of a refund request's review card (brief §2.5). Approve and reject are
 * decisions; "view user" and "view service" reuse the administrators' own navigation, so the
 * card adds no second way of showing either. Drawn only to an administrator the push lane
 * already found holding both decision keys, and every tap is charged again behind it.
 *
 * The two view buttons open panel sections, which `adminTurn` admits only for their own view
 * keys, so each is drawn only for a recipient holding it (Codex review of #83, round 10). A
 * reviewer with the two decision keys alone is sent the two buttons that work for them, not
 * two more that would answer as if they were a customer. `receiptReviewButtons` draws the
 * same way.
 */
export function refundRequestReviewButtons(
  request: {
    readonly id: string;
    readonly customerId: string;
    readonly serviceId: string;
  },
  permissions: ReadonlySet<PermissionKey>,
): CustomerButton[] {
  const buttons: CustomerButton[] = [
    {
      label: { kind: 'TEMPLATE', key: 'bot.admin.refund_request_approve_button' },
      data: `${ADMIN_REFUND_REQUEST_APPROVE_CALLBACK_PREFIX}${request.id}`,
      row: 0,
    },
    {
      label: { kind: 'TEMPLATE', key: 'bot.admin.refund_request_reject_button' },
      data: `${ADMIN_REFUND_REQUEST_REJECT_CALLBACK_PREFIX}${request.id}`,
      row: 0,
    },
  ];
  if (permissions.has(CUSTOMERS_VIEW_PERMISSION)) {
    buttons.push({
      label: { kind: 'TEMPLATE', key: 'bot.admin.refund_request_user_button' },
      data: `${ADMIN_CUSTOMER_CALLBACK_PREFIX}v:${request.customerId}`,
      row: 1,
    });
  }
  if (permissions.has(SERVICES_VIEW_PERMISSION)) {
    buttons.push({
      label: { kind: 'TEMPLATE', key: 'bot.admin.refund_request_service_button' },
      data: `${ADMIN_SERVICE_CALLBACK_PREFIX}${request.serviceId}`,
      row: 1,
    });
  }
  return buttons;
}

/** R2: a reply, with what it does to the receipt-review messages of its payment. */
function withReview(review: ReviewDirective, reply: PendingReply): PendingReply {
  return { ...reply, review };
}

/** The rejection capture's cancel button. */
function rejectCancelButton(captureId: string): CustomerButton {
  return {
    label: { kind: 'TEMPLATE', key: 'bot.admin.reject_cancel_button' },
    data: `${ADMIN_REJECT_CANCEL_CALLBACK_PREFIX}${captureId}`,
  };
}

/** Block User's cancel button. */
function blockCancelButton(captureId: string): CustomerButton {
  return {
    label: { kind: 'TEMPLATE', key: 'bot.admin.block_cancel_button' },
    data: `${ADMIN_BLOCK_CANCEL_CALLBACK_PREFIX}${captureId}`,
  };
}

/** The capture's cancel button. */
/** Abandons a refund request's amount or reason prompt (WP19). */
function refundRequestCancelButton(captureId: string): CustomerButton {
  return {
    label: { kind: 'TEMPLATE', key: 'bot.admin.refund_request_cancel_button' },
    data: `${ADMIN_REFUND_REQUEST_APPROVE_CANCEL_CALLBACK_PREFIX}${captureId}`,
  };
}

function creditCancelButton(captureId: string): CustomerButton {
  return {
    label: { kind: 'TEMPLATE', key: 'bot.admin.credit_cancel_button' },
    data: `${ADMIN_CREDIT_CANCEL_CALLBACK_PREFIX}${captureId}`,
  };
}

/**
 * What a reviewer is told when the credit path refuses (Payment File 02 §11–§12).
 *
 * Four refusals have a sentence, and each is a fact about the PAYMENT rather than about
 * other administrators: already decided (approve, reject or another credit won the
 * conditional UPDATE — the answer a stale approve button gets), no receipt, and a currency
 * the installation no longer sells in. Everything else — a permission denied above all —
 * is rethrown to `adminTurn`'s one refusal, `bot.admin.refused`, for the reason that
 * catch states.
 */
export function creditRefusal(error: unknown): PendingReply {
  if (isNexaError(error)) {
    if (error.code === COMMERCE_ERROR_CODES.PAYMENT_STATE_INVALID) {
      return error.details['reason'] === 'NO_RECEIPT'
        ? { key: 'bot.admin.credit_no_receipt', values: {}, buttons: [], orderId: null }
        : { key: 'bot.admin.receipt_gone', values: {}, buttons: [], orderId: null };
    }
    if (error.code === COMMERCE_ERROR_CODES.PAYMENT_NOT_FOUND) {
      return { key: 'bot.admin.receipt_gone', values: {}, buttons: [], orderId: null };
    }
    if (error.code === COMMERCE_ERROR_CODES.WALLET_CURRENCY_UNSUPPORTED) {
      return { key: 'bot.admin.credit_currency', values: {}, buttons: [], orderId: null };
    }
  }
  throw error;
}

/**
 * The queue: the manual transfers that hold a receipt and are still pending.
 *
 * Bounded by `ADMIN_QUEUE_LIMIT` and ordered oldest first by the service, so the
 * buttons are the work in the order it arrived. The rows carry the REFERENCE and the
 * amount rather than a payment id: the reference is what the customer quoted to their
 * bank and what a reviewer matches against a statement.
 */
export async function adminReceipts(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
): Promise<PendingReply> {
  const items = await rt.deps.receipts.reviewQueue(scope, actor, ADMIN_QUEUE_LIMIT);
  if (items.length === 0) {
    return { key: 'bot.admin.receipts_none', values: {}, buttons: [], orderId: null };
  }
  return {
    key: 'bot.admin.receipts_list',
    values: {},
    buttons: items.map((item) => ({
      label: {
        kind: 'TEXT' as const,
        text: paymentTrackingCode(item.payment),
        // R6 item 4: what the customer had to transfer, which a receipt is checked against.
        amount: amountToTransfer(item.payment),
      },
      data: `${ADMIN_RECEIPT_CALLBACK_PREFIX}${item.payment.id}`,
    })),
    orderId: null,
  };
}

/**
 * One queue item, as ONE message (Payment File 02 §10): the first receipt, with the
 * facts as its caption and the decisions as its buttons. Further receipts follow as bare
 * files, and a reviewer who cannot be sent the file still gets the caption and the
 * buttons as text — see `PendingReply.media`.
 *
 * Nothing is sent from here. The reply is decided and `handle` sends it after every read
 * above has committed, which is the "decide then send" order this surface keeps.
 *
 * The customer's own caption is customer TEXT: it is rendered into the reviewer's
 * caption through the template (plain text, so no markup it contains is interpreted) and
 * is never logged.
 */
export async function adminReceipt(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  paymentId: string,
  permissions: ReadonlySet<PermissionKey>,
): Promise<PendingReply> {
  const item = await rt.deps.receipts.reviewItem(scope, actor, paymentId as PaymentId);
  if (item === null) return decidedReply(rt, scope, actor, paymentId);

  const [first, ...rest] = item.receipts.map((receipt): ReplyMedia => ({
    // The bot that RECEIVED the upload, from the row. A `file_id` is scoped to that
    // bot, and the wrong token answers "file not found" for a receipt that exists —
    // which is why the column is on `payment_receipts` at all.
    botInstanceId: receipt.botInstanceId,
    kind: receipt.kind === 'PHOTO' ? 'PHOTO' : 'DOCUMENT',
    fileId: receipt.fileId,
  }));

  return {
    key: 'bot.admin.receipt',
    // The ONE caption builder the push shares (File 01 §4): what this reviewer may see.
    values: item.caption,
    buttons: receiptDecisionButtons(rt, item.payment.id, permissions),
    orderId: null,
    ...(first === undefined ? {} : { media: first, attachments: rest }),
    // R2: recorded once sent, so the decision taken on it edits it in place.
    review: { paymentId: item.payment.id, sent: 'REVIEW' },
  };
}

/**
 * What a stale button is told when the payment is no longer pending (WP10 follow-up §5):
 * WHICH way the receipt was decided — a credited FAILED payment named as credited, with its
 * amount, and never read as a rejection. `receipt_gone` for everything that is not a
 * receipt disposition. Nothing moves here.
 */
async function decidedReply(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  paymentId: string,
  /**
   * R2 (item 3): the tap came from a message of this payment's review — the receipt, or a
   * prompt — and that message is edited into the decision already taken, once: a receipt
   * into the outcome's one line (`finaliseReview`), a prompt into this sentence. Absent,
   * a new message, as before.
   */
  tapped?: 'REVIEW' | 'PROMPT',
): Promise<PendingReply> {
  const found = await rt.deps.receipts.dispositionOf(scope, actor, paymentId as PaymentId);
  const reply = (
    key: TemplateKey,
    outcome: TelegramReviewOutcome | 'GONE',
    values: TemplateValues = {},
  ): PendingReply => ({
    key,
    values,
    buttons: [],
    orderId: null,
    ...(tapped === undefined ? {} : { review: { paymentId, origin: tapped, outcome } }),
  });
  if (found === null) return reply('bot.admin.receipt_gone', 'GONE');
  switch (found.disposition) {
    case 'APPROVED':
      return reply('bot.admin.receipt_already_approved', 'APPROVED');
    case 'REJECTED':
      return reply('bot.admin.receipt_already_rejected', 'REJECTED');
    case 'CREDITED_TO_WALLET':
      return found.credit === null
        ? reply('bot.admin.receipt_gone', 'GONE')
        : reply('bot.admin.receipt_already_credited', 'CREDITED', {
            amount: found.credit.amount,
          });
  }
}

/** The decisions a receipt's message carries, for THIS administrator. */
function receiptDecisionButtons(
  rt: BotRuntime,
  paymentId: string,
  permissions: ReadonlySet<PermissionKey>,
): CustomerButton[] {
  return receiptReviewButtons(paymentId, permissions, {
    credit: rt.deps.receiptCredits !== undefined,
    block: rt.deps.receiptBlocks !== undefined,
  });
}

/**
 * The credit button: open this administrator's amount capture for this payment, and ask.
 *
 * Nothing moves here. The prompt states the payment and what it asked for, so the unit
 * the reviewer must type is on the screen; a cancel button beside it abandons the
 * capture rather than leaving it to expire.
 */
export async function adminCreditOpen(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  paymentId: string,
  botInstanceId: BotInstanceId,
  idempotencyKey: string,
): Promise<PendingReply | null> {
  const credits = rt.deps.receiptCredits;
  if (credits === undefined) return null;
  try {
    const opened = await credits.open(scope, actor, {
      idempotencyKey: `${idempotencyKey}:credit-open`,
      botInstanceId,
      paymentId,
    });
    if (opened.outcome === 'GONE') return decidedReply(rt, scope, actor, paymentId, 'REVIEW');
    return {
      key: 'bot.admin.credit_amount_prompt',
      values: {
        reference: paymentTrackingCode(opened.payment),
        total: amountToTransfer(opened.payment),
        minutes: Math.round(ADMIN_AMOUNT_CAPTURE_TTL_MS / 60_000),
      },
      buttons: [creditCancelButton(opened.capture.id)],
      orderId: null,
      review: { paymentId: opened.payment.id, origin: 'REVIEW', sent: 'PROMPT' },
    };
  } catch (error) {
    if (
      isNexaError(error) &&
      error.code === COMMERCE_ERROR_CODES.PAYMENT_STATE_INVALID &&
      error.details['reason'] !== 'NO_RECEIPT'
    ) {
      return decidedReply(rt, scope, actor, paymentId, 'REVIEW');
    }
    return creditRefusal(error);
  }
}

/**
 * An administrator's plain message, offered to their amount capture FIRST.
 *
 * `null` — the answer for almost every message — when the sender is not an
 * administrator or has no capture waiting, and the message then takes exactly the path
 * it took before this existed. The lookup is by the SENDER's own administrator id, so
 * another administrator's message, and every customer's, cannot reach this capture.
 */
export async function adminCreditAmount(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  text: string,
  input: {
    readonly idempotencyKey: string;
    readonly botInstanceId: BotInstanceId;
    readonly telegramUserId: string;
  },
): Promise<PendingReply | null> {
  const credits = rt.deps.receiptCredits;
  const admins = rt.deps.telegramAdmins;
  if (credits === undefined || admins === undefined) return null;
  const identity = await admins.resolve(scope, input.telegramUserId, actor.correlationId);
  if (identity === null) return null;
  try {
    const result = await credits.submitAmount(scope, identity.actor, {
      idempotencyKey: `${input.idempotencyKey}:credit-amount`,
      botInstanceId: input.botInstanceId,
      text,
    });
    switch (result.outcome) {
      case 'NO_CAPTURE':
        return null;
      case 'INVALID':
        /*
         * Answered, and the capture stays open. INCIDENT-FIN-001 is a message swallowed
         * without a word; an unreadable amount is told so and asked for again.
         */
        return {
          key: 'bot.admin.credit_amount_invalid',
          values: { total: amountToTransfer(result.payment) },
          buttons: [],
          orderId: null,
        };
      case 'EXPIRED':
        return { key: 'bot.admin.credit_expired', values: {}, buttons: [], orderId: null };
      case 'GONE':
        return { key: 'bot.admin.receipt_gone', values: {}, buttons: [], orderId: null };
      case 'ENTERED':
        return {
          key: 'bot.admin.credit_confirm',
          values: {
            amount: result.amount,
            reference: paymentTrackingCode(result.payment),
            customer: result.customer?.telegramUserId ?? result.payment.customerId,
            total: amountToTransfer(result.payment),
          },
          buttons: [
            {
              label: { kind: 'TEMPLATE', key: 'bot.admin.credit_confirm_button' },
              data: `${ADMIN_CREDIT_CONFIRM_CALLBACK_PREFIX}${result.capture.id}`,
              row: 0,
            },
            { ...creditCancelButton(result.capture.id), row: 0 },
          ],
          orderId: null,
          review: { paymentId: result.payment.id, sent: 'PROMPT' },
        };
    }
  } catch {
    return { key: 'bot.admin.refused', values: {}, buttons: [], orderId: null };
  }
}

/** The confirm button: the stated amount, credited once, through the one credit path. */
export async function adminCreditConfirm(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  captureId: string,
): Promise<PendingReply | null> {
  const credits = rt.deps.receiptCredits;
  if (credits === undefined) return null;
  try {
    const result = await credits.confirm(scope, actor, { captureId });
    if (result.outcome === 'CREDITED') {
      return {
        key: 'bot.admin.credited',
        values: {
          amount: result.amount,
          reference: paymentTrackingCode(result.result.payment),
        },
        buttons: [],
        orderId: null,
        // R2: this confirmation in place, and the receipt it came from into its one line.
        review: { paymentId: result.result.payment.id, origin: 'PROMPT', outcome: 'CREDITED' },
      };
    }
    if (result.outcome === 'CLOSED' && result.reason !== 'CANCELLED') {
      return { key: 'bot.admin.credit_expired', values: {}, buttons: [], orderId: null };
    }
    if (result.outcome === 'CLOSED') {
      return { key: 'bot.admin.credit_cancelled', values: {}, buttons: [], orderId: null };
    }
    return { key: 'bot.admin.receipt_gone', values: {}, buttons: [], orderId: null };
  } catch (error) {
    return creditRefusal(error);
  }
}

/** The cancel button. A capture already confirmed is past cancelling, and says so. */
export async function adminCreditCancel(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  captureId: string,
  idempotencyKey: string,
): Promise<PendingReply | null> {
  const credits = rt.deps.receiptCredits;
  if (credits === undefined) return null;
  const result = await credits.cancel(scope, actor, {
    idempotencyKey: `${idempotencyKey}:credit-cancel`,
    captureId,
  });
  return {
    key: result.outcome === 'CANCELLED' ? 'bot.admin.credit_cancelled' : 'bot.admin.receipt_gone',
    values: {},
    buttons: [],
    orderId: null,
  };
}

/**
 * Block User from the receipt (WP10 follow-up §4): ask → yes (open the reason capture) →
 * the reason, as text → a confirmation restating it → the block. Every step is
 * `ReceiptBlockCaptureService`, which charges `users.block` itself and blocks only through
 * `CustomerService`; a denial reaches `adminTurn`'s one refusal. Nothing here touches the
 * payment: the receipt stays in the queue for any reviewer to decide.
 */
export async function adminBlockTurn(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  intent: BotIntent,
  targetId: string,
  input: { readonly idempotencyKey: string; readonly botInstanceId: BotInstanceId },
): Promise<PendingReply | null> {
  const blocks = rt.deps.receiptBlocks;
  if (blocks === undefined) return null;
  const reply = (
    key: TemplateKey,
    values: TemplateValues = {},
    buttons: CustomerButton[] = [],
  ): PendingReply => ({ key, values, buttons, orderId: null });
  const who = (customer: CustomerRecord | null, fallback: string): string =>
    customer?.telegramUserId ?? fallback;
  const askReply = (asked: ReasonAskResult, tapped: 'REVIEW' | 'PROMPT'): PendingReply => {
    if (asked.outcome === 'GONE') return reply('bot.admin.receipt_gone');
    return withReview(
      { paymentId: asked.payment.id, origin: tapped, sent: 'PROMPT' },
      reply('bot.admin.block_ask', { customer: who(asked.customer, asked.payment.customerId) }, [
        {
          label: { kind: 'TEMPLATE', key: 'bot.admin.block_yes_button' },
          data: `${ADMIN_BLOCK_OPEN_CALLBACK_PREFIX}${asked.payment.id}`,
          row: 0,
        },
        {
          label: { kind: 'TEMPLATE', key: 'bot.admin.block_cancel_button' },
          // Nothing is open yet, so there is nothing to cancel: the receipt again.
          data: `${ADMIN_RECEIPT_CALLBACK_PREFIX}${asked.payment.id}`,
          row: 0,
        },
      ]),
    );
  };

  switch (intent) {
    case 'ADMIN_BLOCK_ASK':
      return askReply(await blocks.ask(scope, actor, targetId), 'REVIEW');
    case 'ADMIN_BLOCK_OPEN': {
      const opened = await blocks.open(scope, actor, {
        idempotencyKey: `${input.idempotencyKey}:block-open`,
        botInstanceId: input.botInstanceId,
        targetId,
      });
      if (opened.outcome === 'GONE') return reply('bot.admin.receipt_gone');
      return withReview(
        { paymentId: opened.payment.id, origin: 'PROMPT', sent: 'PROMPT' },
        reply(
          'bot.admin.block_reason_prompt',
          {
            customer: who(opened.customer, opened.payment.customerId),
            minutes: Math.round(ADMIN_AMOUNT_CAPTURE_TTL_MS / 60_000),
          },
          [blockCancelButton(opened.capture.id)],
        ),
      );
    }
    case 'ADMIN_BLOCK_CONFIRM': {
      const done = await blocks.confirm(scope, actor, { captureId: targetId });
      if (done.outcome === 'DONE') {
        // R2: the payment is read from this confirmation's own record.
        return withReview(
          { paymentId: null, origin: 'PROMPT', outcome: 'BLOCKED' },
          reply(
            done.result.changed ? 'bot.admin.blocked_from_receipt' : 'bot.admin.block_already',
            { customer: done.result.customer.telegramUserId },
          ),
        );
      }
      if (done.outcome === 'CLOSED') {
        return reply(
          done.reason === 'CANCELLED' ? 'bot.admin.block_cancelled' : 'bot.admin.block_expired',
        );
      }
      return reply('bot.admin.receipt_gone');
    }
    case 'ADMIN_BLOCK_CANCEL': {
      const cancelled = await blocks.cancel(scope, actor, {
        idempotencyKey: `${input.idempotencyKey}:block-cancel`,
        captureId: targetId,
      });
      if (cancelled.outcome === 'CANCELLED') return reply('bot.admin.block_cancelled');
      if (cancelled.outcome === 'GONE') return reply('bot.admin.receipt_gone');
      /*
       * A CONFIRMED reason is not a block: the block runs after the capture closes, and one
       * refused or interrupted leaves the capture confirmed and the customer untouched. So
       * the customer's own row answers — blocked, or the question again, never "blocked"
       * for a customer who is not.
       */
      const standing = await blocks.ask(scope, actor, cancelled.targetId);
      if (standing.outcome === 'ASK' && standing.customer?.status === 'BLOCKED') {
        return reply('bot.admin.blocked_from_receipt', {
          customer: who(standing.customer, standing.payment.customerId),
        });
      }
      return askReply(standing, 'PROMPT');
    }
    default:
      return null;
  }
}

/**
 * A tap on a refund request's review card, or on the prompt behind it (WP19). Approve and
 * reject open a prompt and decide nothing; the confirmation names the amount CAPTURE and
 * is the only tap that approves. Every refusal is a sentence from the closed list below.
 */
export async function adminRefundRequestTurn(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  intent: BotIntent,
  targetId: string,
  botInstanceId: BotInstanceId,
  updateId: bigint | undefined,
): Promise<PendingReply | null> {
  const decisions = rt.deps.serviceRefundDecisions;
  if (decisions === undefined) return null;
  const minutes = Math.round(ADMIN_AMOUNT_CAPTURE_TTL_MS / 60_000);
  const plain = (key: TemplateKey): PendingReply => ({
    key,
    values: {},
    buttons: [],
    orderId: null,
  });
  try {
    if (intent === 'ADMIN_REFUND_REQUEST_APPROVE' || intent === 'ADMIN_REFUND_REQUEST_REJECT') {
      const approve = intent === 'ADMIN_REFUND_REQUEST_APPROVE';
      const opened = approve
        ? await decisions.openApprove(scope, actor, {
            botInstanceId,
            requestId: targetId,
            ...(updateId === undefined ? {} : { updateId }),
          })
        : await decisions.openReject(scope, actor, {
            botInstanceId,
            requestId: targetId,
            ...(updateId === undefined ? {} : { updateId }),
          });
      if (opened.outcome === 'CLOSED') return plain('bot.admin.refund_request_closed');
      if (opened.outcome === 'NOT_EXECUTABLE') {
        return plain('bot.admin.refund_request_not_executable');
      }
      return {
        key: approve
          ? 'bot.admin.refund_request_amount_prompt'
          : 'bot.admin.refund_request_reject_prompt',
        values: approve ? { remaining: opened.review.remaining, minutes } : { minutes },
        buttons: [refundRequestCancelButton(opened.capture.id)],
        orderId: null,
      };
    }
    if (intent === 'ADMIN_REFUND_REQUEST_CONFIRM') {
      const result = await decisions.confirmApprove(scope, actor, { captureId: targetId });
      switch (result.outcome) {
        case 'EXECUTING':
          return result.request.approvedAmount === null
            ? plain('bot.admin.refund_request_closed')
            : {
                key: 'bot.admin.refund_request_executing',
                values: { amount: result.request.approvedAmount },
                buttons: [],
                orderId: null,
              };
        case 'INVALID_AMOUNT':
          return {
            key: 'bot.admin.refund_request_amount_invalid',
            values: { remaining: result.remaining },
            buttons: [],
            orderId: null,
          };
        case 'EXPIRED':
          return plain('bot.admin.refund_request_expired');
        case 'CANCELLED':
          return plain('bot.admin.refund_request_cancelled');
        case 'NOT_EXECUTABLE':
          return plain('bot.admin.refund_request_not_executable');
        case 'CLOSED':
        case 'GONE':
          return plain('bot.admin.refund_request_closed');
      }
    }
    if (intent === 'ADMIN_REFUND_REQUEST_CANCEL') {
      const result = await decisions.cancel(scope, actor, { captureId: targetId });
      return plain(
        result.outcome === 'CANCELLED'
          ? 'bot.admin.refund_request_cancelled'
          : 'bot.admin.refund_request_closed',
      );
    }
    /* istanbul ignore next -- the four intents above are the only ones routed here. */
    return null;
  } catch {
    return plain('bot.admin.refused');
  }
}

/**
 * An administrator's plain message, offered to their refund-request prompt (WP19): an
 * amount restated with one destructive confirmation, or a reason that rejects at once.
 * `null` when they have no such prompt waiting — the answer for almost every message.
 */
export async function adminRefundRequestText(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  text: string,
  input: {
    readonly idempotencyKey: string;
    readonly botInstanceId: BotInstanceId;
    readonly telegramUserId: string;
    readonly update?: unknown;
  },
): Promise<PendingReply | null> {
  const decisions = rt.deps.serviceRefundDecisions;
  const admins = rt.deps.telegramAdmins;
  if (decisions === undefined || admins === undefined) return null;
  const identity = await admins.resolve(scope, input.telegramUserId, actor.correlationId);
  if (identity === null) return null;
  const plain = (key: TemplateKey): PendingReply => ({
    key,
    values: {},
    buttons: [],
    orderId: null,
  });
  const updateId = updateIdOf(input.update);
  try {
    const result = await decisions.submitText(scope, identity.actor, {
      idempotencyKey: `${input.idempotencyKey}:refund-text`,
      botInstanceId: input.botInstanceId,
      text,
      ...(updateId === undefined ? {} : { updateId }),
    });
    switch (result.outcome) {
      case 'NO_CAPTURE':
        return null;
      case 'EXPIRED':
        return plain('bot.admin.refund_request_expired');
      case 'CLOSED':
        return plain('bot.admin.refund_request_closed');
      case 'NOT_EXECUTABLE':
        return plain('bot.admin.refund_request_not_executable');
      case 'INVALID_AMOUNT':
        // Answered, and the prompt stays open: a swallowed message is INCIDENT-FIN-001.
        return {
          key: 'bot.admin.refund_request_amount_invalid',
          values: { remaining: result.remaining },
          buttons: [],
          orderId: null,
        };
      case 'INVALID_REASON':
        return {
          key: 'bot.admin.refund_request_reject_invalid',
          values: { max: ADMIN_CAPTURE_REASON_MAX_LENGTH },
          buttons: [],
          orderId: null,
        };
      case 'REJECTED':
        return plain('bot.admin.refund_request_rejected');
      case 'AMOUNT_ENTERED':
        return {
          key: 'bot.admin.refund_request_confirm',
          values: {
            amount: result.amount,
            customer: result.review.customer?.telegramUserId ?? '—',
            service: result.review.service?.providerUsername ?? '—',
          },
          buttons: [
            {
              label: { kind: 'TEMPLATE', key: 'bot.admin.refund_request_confirm_button' },
              data: `${ADMIN_REFUND_REQUEST_APPROVE_CONFIRM_CALLBACK_PREFIX}${result.capture.id}`,
              row: 0,
            },
            { ...refundRequestCancelButton(result.capture.id), row: 0 },
          ],
          orderId: null,
        };
    }
  } catch {
    return plain('bot.admin.refused');
  }
}

/** The typed rejection reason, recorded and restated; nothing is rejected until the confirm. */
export async function adminRejectReason(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  text: string,
  input: {
    readonly idempotencyKey: string;
    readonly botInstanceId: BotInstanceId;
    readonly telegramUserId: string;
  },
): Promise<PendingReply | null> {
  const rejects = rt.deps.receiptRejects;
  const admins = rt.deps.telegramAdmins;
  if (rejects === undefined || admins === undefined) return null;
  const identity = await admins.resolve(scope, input.telegramUserId, actor.correlationId);
  if (identity === null) return null;
  try {
    const result = await rejects.submitReason(scope, identity.actor, {
      idempotencyKey: `${input.idempotencyKey}:reject-reason`,
      botInstanceId: input.botInstanceId,
      text,
    });
    switch (result.outcome) {
      case 'NO_CAPTURE':
        return null;
      case 'INVALID':
        return {
          key: 'bot.admin.reject_reason_invalid',
          values: { max: ADMIN_CAPTURE_REASON_MAX_LENGTH },
          buttons: [],
          orderId: null,
        };
      case 'EXPIRED':
        return { key: 'bot.admin.reject_expired', values: {}, buttons: [], orderId: null };
      case 'GONE':
        return { key: 'bot.admin.receipt_gone', values: {}, buttons: [], orderId: null };
      case 'ENTERED':
        return {
          key: 'bot.admin.reject_confirm',
          values: {
            reference: paymentTrackingCode(result.payment),
            reason: result.reason,
          },
          buttons: [
            {
              label: { kind: 'TEMPLATE', key: 'bot.admin.reject_confirm_button' },
              data: `${ADMIN_REJECT_CONFIRM_CALLBACK_PREFIX}${result.capture.id}`,
              row: 0,
            },
            { ...rejectCancelButton(result.capture.id), row: 0 },
          ],
          orderId: null,
          review: { paymentId: result.payment.id, sent: 'PROMPT' },
        };
    }
  } catch {
    return { key: 'bot.admin.refused', values: {}, buttons: [], orderId: null };
  }
}

/** The typed reason, recorded and restated; nothing is blocked until the confirm. */
export async function adminBlockReason(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  text: string,
  input: {
    readonly idempotencyKey: string;
    readonly botInstanceId: BotInstanceId;
    readonly telegramUserId: string;
  },
): Promise<PendingReply | null> {
  const blocks = rt.deps.receiptBlocks;
  const admins = rt.deps.telegramAdmins;
  if (blocks === undefined || admins === undefined) return null;
  const identity = await admins.resolve(scope, input.telegramUserId, actor.correlationId);
  if (identity === null) return null;
  try {
    const result = await blocks.submitReason(scope, identity.actor, {
      idempotencyKey: `${input.idempotencyKey}:block-reason`,
      botInstanceId: input.botInstanceId,
      text,
    });
    switch (result.outcome) {
      case 'NO_CAPTURE':
        return null;
      case 'INVALID':
        return {
          key: 'bot.admin.block_reason_invalid',
          values: { max: ADMIN_CAPTURE_REASON_MAX_LENGTH },
          buttons: [],
          orderId: null,
        };
      case 'EXPIRED':
        return { key: 'bot.admin.block_expired', values: {}, buttons: [], orderId: null };
      case 'GONE':
        return { key: 'bot.admin.receipt_gone', values: {}, buttons: [], orderId: null };
      case 'ENTERED':
        return {
          key: 'bot.admin.block_confirm',
          values: {
            customer: result.customer?.telegramUserId ?? result.payment.customerId,
            reason: result.reason,
          },
          buttons: [
            {
              label: { kind: 'TEMPLATE', key: 'bot.admin.block_confirm_button' },
              data: `${ADMIN_BLOCK_CONFIRM_CALLBACK_PREFIX}${result.capture.id}`,
              row: 0,
            },
            { ...blockCancelButton(result.capture.id), row: 0 },
          ],
          orderId: null,
          review: { paymentId: result.payment.id, sent: 'PROMPT' },
        };
    }
  } catch {
    return { key: 'bot.admin.refused', values: {}, buttons: [], orderId: null };
  }
}

/**
 * Approve, through the SAME application method the Web Admin called.
 *
 * `confirmManualTransfer` — no parallel settlement, no second ledger write, no second
 * notification. Everything that makes a decision safe lives in there: the permission, the
 * conditional state transition, the wallet credit keyed on the payment, the customer's
 * notification, the audit row.
 *
 * A duplicate tap is safe TWICE OVER. The idempotency key is the update's, so Telegram's
 * redelivery of one tap is a replay; and two different taps race a conditional UPDATE that
 * only one can win, after which the loser is told WHICH decision won (WP10 follow-up §5).
 *
 * Rejection is NOT here any more: File 01 §7 makes its reason mandatory, so the reject
 * button opens a reason capture (`adminRejectTurn`) and there is no one-tap rejection.
 */
export async function adminApprove(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  paymentId: string,
  idempotencyKey: string,
): Promise<PendingReply> {
  const item = await rt.deps.receipts.reviewItem(scope, actor, paymentId as PaymentId);
  if (item === null) return decidedReply(rt, scope, actor, paymentId, 'REVIEW');
  try {
    await rt.deps.payments.confirmManualTransfer(scope, actor, paymentId, {
      idempotencyKey: `${idempotencyKey}:admin-approve`,
      // An ASCII note, and an audit field rather than customer-facing text: it says
      // through which surface the decision was taken, which is exactly what a
      // reviewer reading the payment later wants to know.
      note: 'Approved in the Telegram management panel.',
      // A receipt-review decision: the service refuses a transfer with no stored receipt.
      requireReceipt: true,
    });
    /*
     * R2 (item 3): the receipt message the approval was tapped on becomes the result, in
     * place and without its buttons; every other recorded message of this payment too.
     */
    return {
      key: 'bot.admin.approved',
      values: {},
      buttons: [],
      orderId: null,
      review: { paymentId, origin: 'REVIEW', outcome: 'APPROVED' },
    };
  } catch (error) {
    return lostDecision(rt, scope, actor, paymentId, error, 'REVIEW');
  }
}

/**
 * A decision that lost the conditional UPDATE to another between our read and its write:
 * told WHICH decision won, not a generic refusal. Nothing moved — the service's own
 * transaction refused. Every other error is `adminTurn`'s one refusal.
 */
async function lostDecision(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  paymentId: string,
  error: unknown,
  tapped?: 'REVIEW' | 'PROMPT',
): Promise<PendingReply> {
  if (
    isNexaError(error) &&
    error.code === COMMERCE_ERROR_CODES.PAYMENT_STATE_INVALID &&
    error.details['reason'] !== 'NO_RECEIPT'
  ) {
    return decidedReply(rt, scope, actor, paymentId, tapped);
  }
  throw error;
}

/**
 * The rejection, with its MANDATORY reason (File 01 §7): the reject button opens this
 * administrator's reason capture; the reason arrives as text and is restated; the confirm
 * rejects through `rejectManualTransfer` — the one conditional PENDING→FAILED edge approve
 * and credit race on — and the customer's `PAYMENT_REJECTED` sentence carries the reason.
 */
export async function adminRejectTurn(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  intent: BotIntent,
  targetId: string,
  input: { readonly idempotencyKey: string; readonly botInstanceId: BotInstanceId },
  permissions: ReadonlySet<PermissionKey>,
): Promise<PendingReply | null> {
  const rejects = rt.deps.receiptRejects;
  if (rejects === undefined) return null;
  const reply = (key: TemplateKey, values: TemplateValues = {}): PendingReply => ({
    key,
    values,
    buttons: [],
    orderId: null,
  });
  switch (intent) {
    case 'ADMIN_REJECT': {
      const opened = await rejects.open(scope, actor, {
        idempotencyKey: `${input.idempotencyKey}:reject-open`,
        botInstanceId: input.botInstanceId,
        targetId,
      });
      if (opened.outcome === 'GONE') {
        return decidedReply(rt, scope, actor, targetId, 'REVIEW');
      }
      return {
        key: 'bot.admin.reject_reason_prompt',
        values: {
          reference: paymentTrackingCode(opened.payment),
          minutes: Math.round(ADMIN_AMOUNT_CAPTURE_TTL_MS / 60_000),
        },
        buttons: [rejectCancelButton(opened.capture.id)],
        orderId: null,
        review: { paymentId: opened.payment.id, origin: 'REVIEW', sent: 'PROMPT' },
      };
    }
    case 'ADMIN_REJECT_CONFIRM': {
      try {
        const done = await rejects.confirm(scope, actor, { captureId: targetId });
        if (done.outcome === 'DONE') {
          // R2: the payment is read from this confirmation's own record.
          return {
            ...reply('bot.admin.rejected'),
            review: { paymentId: null, origin: 'PROMPT', outcome: 'REJECTED' },
          };
        }
        if (done.outcome === 'CLOSED') {
          return reply(
            done.reason === 'CANCELLED' ? 'bot.admin.reject_cancelled' : 'bot.admin.reject_expired',
          );
        }
        return reply('bot.admin.receipt_gone');
      } catch (error) {
        // Another decision won between the reason and the confirm; nothing was rejected.
        if (isNexaError(error) && error.code === COMMERCE_ERROR_CODES.PAYMENT_STATE_INVALID) {
          return reply('bot.admin.receipt_gone');
        }
        throw error;
      }
    }
    case 'ADMIN_REJECT_CANCEL': {
      const cancelled = await rejects.cancel(scope, actor, {
        idempotencyKey: `${input.idempotencyKey}:reject-cancel`,
        captureId: targetId,
      });
      if (cancelled.outcome === 'CANCELLED') return reply('bot.admin.reject_cancelled');
      if (cancelled.outcome === 'GONE') return reply('bot.admin.receipt_gone');
      // A CONFIRMED reason is not a rejection: one that lost to another decision, or never
      // ran, left the capture confirmed. The payment answers — the receipt again while it
      // is pending, else WHICH decision it received.
      return adminReceipt(rt, scope, actor, cancelled.targetId, permissions);
    }
    default:
      return null;
  }
}

/**
 * R2 (item 3): a receipt decision, shown where the question was.
 *
 * The tapped message is recorded (when the directive names its role) and then every
 * unfinalised message of the payment is stamped — only this chat's for a block, which
 * decides nothing about the payment. Exactly the messages THIS call stamped are edited: the
 * tapped one into this reply, every other receipt into the outcome's one line, every other
 * prompt loses its buttons. A tapped message another turn already stamped is answered and
 * nothing else — the repeated-tap rule, reached through a race instead of the gate.
 *
 * An edit Telegram definitely did not apply has its stamp cleared, so a later tap can
 * finish it. Null when no payment could be named: the reply goes out as before.
 */
export async function finaliseReview(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  reply: PendingReply,
  origin: CallbackOrigin,
  botInstanceId: BotInstanceId,
  telegramUserId: string,
): Promise<CustomerSendOutcome | 'NOT_ATTEMPTED' | null> {
  const state = rt.deps.messageState;
  const directive = reply.review;
  if (state === undefined || directive?.outcome === undefined || reply.key === null) return null;
  const ref = rt.refOf(botInstanceId, origin);
  const tapped = await state.findReview(scope, ref);
  const paymentId = directive.paymentId ?? tapped?.paymentId ?? null;
  if (paymentId === null) return null;
  if (tapped === null) {
    await state.recordReview(scope, actor, {
      ref,
      paymentId,
      role: directive.origin ?? 'PROMPT',
      hasMedia: origin.media,
    });
  }
  const outcome = directive.outcome;
  const stamped = await state.finaliseReviews(
    scope,
    actor,
    outcome === 'BLOCKED' ? { paymentId, chatId: origin.chatId } : { paymentId },
  );
  const same = (row: { botInstanceId: string; chatId: string; messageId: number }): boolean =>
    row.botInstanceId === ref.botInstanceId &&
    row.chatId === ref.chatId &&
    row.messageId === ref.messageId;
  const clearFailed = async (id: string, result: CustomerSendResult): Promise<void> => {
    if (result.outcome === 'REFUSED' || result.outcome === 'RATE_LIMITED') {
      await state.unfinaliseReview(scope, actor, id);
    }
  };
  /*
   * F1 (round N): a receipt becomes the COMPLETE final record — the outcome's label and the
   * facts the reviewer decided on — read once, after the decision committed. The wallet
   * lines go only on this reviewer's own chat: a copy pushed to another reviewer is read by
   * somebody whose permissions this turn does not know, so theirs carries every fact but
   * the balance. A record that cannot be read (no administrator behind the tap, a payment
   * gone) falls back to the outcome's one line, which is still true.
   */
  const records = new Map<boolean, { key: TemplateKey; values: TemplateValues }>();
  const recordFor = async (own: boolean): Promise<{ key: TemplateKey; values: TemplateValues }> => {
    const cached = records.get(own);
    if (cached !== undefined) return cached;
    const record = await finalReviewRecord(
      rt,
      scope,
      actor,
      telegramUserId,
      paymentId,
      outcome,
      own,
    );
    records.set(own, record);
    return record;
  };
  let answer: CustomerSendOutcome | 'NOT_ATTEMPTED' = 'NOT_ATTEMPTED';
  for (const row of stamped) {
    const message = {
      chatId: row.chatId,
      messageId: row.messageId,
      botInstanceId: row.botInstanceId,
    };
    const ownChat = row.botInstanceId === ref.botInstanceId && row.chatId === ref.chatId;
    if (same(row)) {
      // A receipt becomes the final record; a prompt becomes this reply's sentence.
      const receipt = row.role === 'REVIEW';
      const record = receipt ? await recordFor(true) : null;
      const edited =
        record !== null
          ? await editReviewRecord(rt, scope, message, record, origin.media)
          : await editSent(
              rt.deps.messenger,
              scope,
              {
                ...message,
                templateKey: reply.key,
                values: reply.values,
                buttons: reply.buttons,
              },
              origin.media,
            );
      await clearFailed(row.id, edited);
      answer = edited.outcome;
      continue;
    }
    const record = row.role === 'REVIEW' ? await recordFor(ownChat) : null;
    const other =
      record !== null
        ? await editReviewRecord(rt, scope, message, record, row.hasMedia)
        : rt.deps.messenger.clearButtons === undefined
          ? ({ outcome: 'REFUSED' } as const)
          : await rt.deps.messenger.clearButtons(scope, message);
    await clearFailed(row.id, other);
  }
  return answer;
}

/**
 * F1 (round N, Codex review of #113): ONE review message edited into its final record, and
 * never into a record that silently lost its end.
 *
 * The record is edited in place, WHOLE (`whole`): the normal case, and still no new
 * message. A receipt FILE is edited through its caption, which Telegram bounds at 1,024
 * characters, and a tenant's override of the record or of its labels can pass that (a text
 * message, at 4,096). Cut, the tracking code and the wallet lines at the end would be gone
 * while the review reads as final. So a record that does not fit is refused by the
 * messenger before any request, and the one documented fallback is the smallest arrangement
 * that loses nothing and stays attached to the receipt:
 *
 *   1. the message becomes `bot.admin.review_final_short` — the decision and the tracking
 *      code, and a sentence pointing at the reply (bounded; if a tenant's override of THAT
 *      is too long it is cut, and nothing is lost, because the record follows);
 *   2. the complete record is sent as a REPLY to that same message.
 *
 * The result is what the stamp logic reads: a refused or rate-limited step — Telegram
 * definitely did not apply it — unfinalises the message so a later tap finishes it; an
 * UNKNOWN step is left finalised, since it may have landed. This runs only for a message
 * `finaliseReviews` stamped in THIS call, and a finalised message is never stamped again,
 * so a repeated tap never sends the reply a second time.
 */
async function editReviewRecord(
  rt: BotRuntime,
  scope: TenantContext,
  message: CustomerMessageRef,
  record: { readonly key: TemplateKey; readonly values: TemplateValues },
  media: boolean,
): Promise<CustomerSendResult> {
  const full = { ...message, templateKey: record.key, values: record.values, buttons: [] };
  if (record.key !== 'bot.admin.review_final') {
    return editSent(rt.deps.messenger, scope, full, media);
  }
  const whole = await editSent(rt.deps.messenger, scope, { ...full, whole: true }, media);
  if (
    whole.outcome !== 'REFUSED' ||
    (whole.reason !== 'CAPTION_OVER_BOUND' && whole.reason !== 'TEXT_OVER_BOUND')
  ) {
    return whole;
  }
  const short = await editSent(
    rt.deps.messenger,
    scope,
    {
      ...message,
      templateKey: 'bot.admin.review_final_short',
      values: {
        outcome: record.values['outcome'] ?? '',
        reference: record.values['reference'] ?? '',
      },
      buttons: [],
    },
    media,
  );
  if (short.outcome !== 'DELIVERED') return short;
  const reply = await rt.deps.messenger.send(scope, {
    chatId: message.chatId,
    botInstanceId: message.botInstanceId,
    templateKey: record.key,
    values: record.values,
    replyToMessageId: message.messageId,
  });
  return reply.outcome === 'DELIVERED' ? short : reply;
}

/**
 * F1 (round N): the final record a receipt review message becomes — `bot.admin.review_final`
 * with the facts the reviewer decided on, read as the administrator who tapped (the
 * receipts read charges `receipts.view`, and the wallet lines `users.view`). `GONE`, or a
 * record that cannot be read, is the outcome's own one line: still true, and never blank.
 */
async function finalReviewRecord(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  telegramUserId: string,
  paymentId: string,
  outcome: TelegramReviewOutcome | 'GONE',
  wallet: boolean,
): Promise<{ key: TemplateKey; values: TemplateValues }> {
  const line = { key: REVIEW_OUTCOME_KEYS[outcome], values: {} };
  if (outcome === 'GONE') return line;
  try {
    const reviewer = await reviewerActor(rt, scope, actor, telegramUserId);
    if (reviewer === null) return line;
    const values = await rt.deps.receipts.finalRecord(
      scope,
      reviewer,
      paymentId as PaymentId,
      outcome,
      REVIEW_OUTCOME_KEYS[outcome],
      wallet,
    );
    return values === null ? line : { key: 'bot.admin.review_final', values };
  } catch {
    // A refused read decides nothing; the one line still says what was decided.
    return line;
  }
}

/** The administrator behind a review tap, or null when there is none. */
async function reviewerActor(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  telegramUserId: string,
): Promise<ActorContext | null> {
  const admins = rt.deps.telegramAdmins;
  if (admins === undefined) return null;
  const identity = await admins.resolve(scope, telegramUserId, actor.correlationId);
  return identity === null ? null : identity.actor;
}

/**
 * F1 (round N): what a tap on a review message ALREADY finalised is answered with — the
 * callback's own notice, and nothing else. The payment's recorded disposition decides the
 * sentence; a payment still pending whose message was finalised was finalised by a BLOCK
 * (the one decision that leaves it in the queue). Nothing is decided, credited, sent or
 * edited here. A read that cannot be made answers without a notice, as before.
 */
export async function repeatedReviewToast(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  telegramUserId: string,
  paymentId: string,
): Promise<Pick<PendingReply, 'toast'>> {
  const toast = (key: TemplateKey): Pick<PendingReply, 'toast'> => ({
    toast: { key, values: {} },
  });
  try {
    const reviewer = await reviewerActor(rt, scope, actor, telegramUserId);
    if (reviewer === null) return {};
    const found = await rt.deps.receipts.dispositionOf(scope, reviewer, paymentId as PaymentId);
    if (found !== null) {
      switch (found.disposition) {
        case 'APPROVED':
          return toast('bot.admin.review_repeat_approved');
        case 'REJECTED':
          return toast('bot.admin.review_repeat_rejected');
        case 'CREDITED_TO_WALLET':
          return toast('bot.admin.review_repeat_credited');
      }
    }
    const pending = await rt.deps.receipts.reviewItem(scope, reviewer, paymentId as PaymentId);
    return toast(
      pending === null ? 'bot.admin.review_repeat_gone' : 'bot.admin.review_repeat_blocked',
    );
  } catch {
    return {};
  }
}
