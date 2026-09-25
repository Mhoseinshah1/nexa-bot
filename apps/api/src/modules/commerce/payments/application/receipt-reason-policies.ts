import type { PaymentId, PermissionKey, TenantContext } from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { CustomerRecord } from '../../customers/application/ports.js';
import type { CustomerService } from '../../customers/application/customer.service.js';
import type { PaymentService } from './payment.service.js';
import type { PaymentRecord } from './ports.js';
import {
  ReceiptReasonCaptureService,
  type ReasonCapturePolicy,
  type ReasonSubject,
  type ReceiptReasonCaptureDeps,
} from './receipt-reason-capture.service.js';

/**
 * Block User's permission: the customers section's own (`CustomerService.block`), and
 * INDEPENDENT of `receipts.review` — each key gates its own button and its own path.
 */
export const RECEIPT_BLOCK_PERMISSION: PermissionKey = 'users.block';
/** Reading the receipt's payment to learn whose it is: the receipt read's own key. */
export const RECEIPT_BLOCK_VIEW_PERMISSION: PermissionKey = 'receipts.view';
/** A rejection's permission: the decision's own. */
export const RECEIPT_REJECT_PERMISSION: PermissionKey = 'receipts.review';
/**
 * And the receipt read the one-tap rejection charged before it (`reviewItem`), which approve
 * still charges: `receipts.review` does not imply it, and a rejection is a decision about
 * evidence its maker must be allowed to see.
 */
export const RECEIPT_REJECT_VIEW_PERMISSION: PermissionKey = 'receipts.view';

export function receiptBlockCaptureKey(captureId: string): string {
  return `receipt-block-capture:${captureId}`;
}

export function receiptRejectCaptureKey(captureId: string): string {
  return `receipt-reject-capture:${captureId}`;
}

export interface ReceiptBlockOutcome {
  readonly customer: CustomerRecord;
  /** Whether THIS block changed the customer — false for one already blocked. */
  readonly changed: boolean;
}

export type ReceiptBlockCaptureService = ReceiptReasonCaptureService<
  ReasonSubject,
  ReceiptBlockOutcome
>;
export type ReceiptRejectCaptureService = ReceiptReasonCaptureService<ReasonSubject, PaymentRecord>;

/**
 * A receipt action's subject: the payment, when it exists, ADMITS the action and carries a stored
 * receipt — and the customer it belongs to. Receipts are append-only
 * (`payment_receipts_no_delete`), so one seen here is still there when the action runs. Null is
 * the policy's `GONE`: a forged callback naming a transfer with no receipt reaches nothing.
 */
function receiptSubject(
  deps: ReceiptReasonCaptureDeps,
  admits: (payment: PaymentRecord) => boolean,
): (
  scope: TenantContext,
  paymentId: string,
  tx?: TransactionScope,
) => Promise<ReasonSubject | null> {
  return async (scope, paymentId, tx) => {
    const payment = await deps.payments.findById(scope, paymentId as PaymentId, tx);
    if (payment === null || !admits(payment)) return null;
    if ((await deps.receipts.countForPayment(scope, payment.id, tx)) === 0) return null;
    const customer = await deps.customers.findById(scope, payment.customerId, tx);
    return { payment, customer };
  };
}

/**
 * Block User from the receipt message (File 01 §9, `docs/wp10-followup-audit.md` §4).
 *
 * NOT a payment disposition: the policy's action is the customers section's own block —
 * its permission, its conditional UPDATE, its audit row (carrying the receipt as its
 * context) and its `CustomerBlocked` event — and nothing here holds a path that could
 * approve, reject or credit a payment. Any manual transfer's receipt may be the context,
 * decided or not: the customer is what is blocked.
 */
export function receiptBlockCaptures(
  deps: ReceiptReasonCaptureDeps,
  block: Pick<CustomerService, 'blockWithOutcome'>,
): ReceiptBlockCaptureService {
  const policy: ReasonCapturePolicy<ReasonSubject, ReceiptBlockOutcome> = {
    purpose: 'RECEIPT_BLOCK_REASON',
    target: 'PAYMENT',
    action: 'customer.block',
    permission: RECEIPT_BLOCK_PERMISSION,
    viewPermission: RECEIPT_BLOCK_VIEW_PERMISSION,
    load: receiptSubject(deps, (payment) => payment.method === 'MANUAL_TRANSFER'),
    keyFor: receiptBlockCaptureKey,
    act: (scope, actor, input) =>
      block.blockWithOutcome(scope, actor, {
        idempotencyKey: input.idempotencyKey,
        customerId: input.subject.payment.customerId,
        reason: input.reason,
        context: {
          source: 'RECEIPT_REVIEW',
          paymentId: input.subject.payment.id,
          captureId: input.captureId,
        },
      }),
  };
  return new ReceiptReasonCaptureService(deps, policy);
}

/**
 * The rejection's MANDATORY reason (File 01 §7, the owner's correction to the follow-up).
 *
 * The reject button no longer rejects: it opens this capture. The confirm that restates the
 * reason rejects through `PaymentService.rejectManualTransfer` — the one conditional
 * PENDING→FAILED edge approve and credit race on — with the reason as the payment's
 * `resolution_note`, which is what the customer's `PAYMENT_REJECTED` sentence reads. Only a
 * PENDING manual transfer admits one: a decided payment has nothing left to reject.
 */
export function receiptRejectCaptures(
  deps: ReceiptReasonCaptureDeps,
  payments: Pick<PaymentService, 'rejectManualTransfer'>,
): ReceiptRejectCaptureService {
  const policy: ReasonCapturePolicy<ReasonSubject, PaymentRecord> = {
    purpose: 'RECEIPT_REJECT_REASON',
    target: 'PAYMENT',
    action: 'payment.reject',
    permission: RECEIPT_REJECT_PERMISSION,
    viewPermission: RECEIPT_REJECT_VIEW_PERMISSION,
    load: receiptSubject(
      deps,
      (payment) => payment.method === 'MANUAL_TRANSFER' && payment.state === 'PENDING',
    ),
    keyFor: receiptRejectCaptureKey,
    act: (scope, actor, input) =>
      payments.rejectManualTransfer(scope, actor, input.subject.payment.id, {
        idempotencyKey: input.idempotencyKey,
        note: input.reason,
        // Checked again inside the rejection's own transaction, beside the capture's check.
        requireReceipt: true,
      }),
  };
  return new ReceiptReasonCaptureService(deps, policy);
}
