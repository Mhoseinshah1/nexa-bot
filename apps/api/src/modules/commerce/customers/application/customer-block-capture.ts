import type { PermissionKey, UserId } from '@nexa/contracts';
import {
  ReceiptReasonCaptureService,
  type CustomerReasonSubject,
  type ReasonCapturePolicy,
  type ReceiptReasonCaptureDeps,
} from '../../payments/application/receipt-reason-capture.service.js';
import type { CustomerService } from './customer.service.js';
import type { CustomerRecord } from './ports.js';
import { CUSTOMER_BLOCK_PERMISSION, CUSTOMER_VIEW_PERMISSION } from './customer.service.js';

/**
 * The block from the Telegram customers section (WP10G, closing OQ-WP10F-03): ask → the reason,
 * typed → a confirmation restating it → `CustomerService.blockWithOutcome`.
 *
 * The same mechanics as the receipt message's Block User — the same capture table, the same
 * one-open-prompt index, the same "the typed text alone changes nothing" — with a CUSTOMER as the
 * target instead of a payment, because a block taken from the customer's own screen has no
 * receipt to name. Nothing here decides a block: the permission, the conditional UPDATE, the
 * mandatory-reason rule and the audit row are `CustomerService`'s, and this only carries the
 * reason to it.
 */
export type CustomerBlockCaptureService = ReceiptReasonCaptureService<
  CustomerReasonSubject,
  CustomerBlockOutcome
>;

export interface CustomerBlockOutcome {
  readonly customer: CustomerRecord;
  /** Whether THIS block changed the customer — false for one already blocked. */
  readonly changed: boolean;
}

/** Reading the customer to say whom the block is about: the customers section's own read key. */
export const CUSTOMER_BLOCK_VIEW_PERMISSION: PermissionKey = CUSTOMER_VIEW_PERMISSION;

export function customerBlockCaptureKey(captureId: string): string {
  return `customer-block-capture:${captureId}`;
}

export function customerBlockCaptures(
  deps: ReceiptReasonCaptureDeps,
  block: Pick<CustomerService, 'blockWithOutcome'>,
): CustomerBlockCaptureService {
  const policy: ReasonCapturePolicy<CustomerReasonSubject, CustomerBlockOutcome> = {
    purpose: 'CUSTOMER_BLOCK_REASON',
    target: 'CUSTOMER',
    action: 'customer.block',
    permission: CUSTOMER_BLOCK_PERMISSION,
    viewPermission: CUSTOMER_BLOCK_VIEW_PERMISSION,
    // The customer, read in the tenant. Any status admits: a block asked of a customer already
    // blocked is answered truthfully by the conditional UPDATE, not refused before the reason.
    load: async (scope, customerId, tx) => {
      const customer = await deps.customers.findById(scope, customerId as UserId, tx);
      return customer === null ? null : { customer };
    },
    keyFor: customerBlockCaptureKey,
    act: (scope, actor, input) =>
      block.blockWithOutcome(scope, actor, {
        idempotencyKey: input.idempotencyKey,
        customerId: input.subject.customer.id,
        reason: input.reason,
        context: { source: 'CUSTOMERS_SECTION', captureId: input.captureId },
      }),
  };
  return new ReceiptReasonCaptureService(deps, policy);
}
