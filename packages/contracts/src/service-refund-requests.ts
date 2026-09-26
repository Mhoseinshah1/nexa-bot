import { z } from 'zod';

/**
 * WP19 — a customer's request to cancel a service and have money returned
 * (`docs/wp19-service-refund-request-audit.md`).
 *
 * NOT a gateway reversal and NOT the automatic refund of an undeliverable order. A customer
 * asks, an administrator decides how much of the principal comes back, the provider account
 * is deleted, and only then is the approved amount credited to the customer's Nexa wallet —
 * whatever the original payment method was. The owner's rule (brief §2.7), stated once here
 * so no caller re-derives it.
 */

/**
 * Where a request is in its life.
 *
 * - `OPEN` — the customer filed it with a reason. Nothing is reserved, planned or moved.
 * - `EXECUTING` — an administrator approved an amount. In that one transaction a
 *   `REQUESTED` wallet refund RESERVES the amount against the source payment (so a
 *   concurrent partial refund sees it) and a `TERMINATE` operation is planned. No money
 *   has moved: the credit waits for the deletion.
 * - `COMPLETED` — the provider account was deleted and the service is `TERMINATED`; the
 *   reserved refund completed with one wallet credit, in one transaction.
 * - `REJECTED` — an administrator refused it, with a reason. Nothing was deleted or moved.
 * - `FAILED` — the deletion definitively failed. The reservation is released, nothing is
 *   credited, and the row stays for an operator.
 *
 * There is no state for an ambiguous deletion, deliberately: an operation that ends
 * `UNKNOWN` leaves the request `EXECUTING`, which credits nothing and is what an operator
 * sees. Money is never given back on a guess.
 */
export const SERVICE_REFUND_REQUEST_STATES = [
  'OPEN',
  'EXECUTING',
  'COMPLETED',
  'REJECTED',
  'FAILED',
] as const;
export type ServiceRefundRequestState = (typeof SERVICE_REFUND_REQUEST_STATES)[number];
export const serviceRefundRequestStateSchema = z.enum(SERVICE_REFUND_REQUEST_STATES);

/**
 * The states that hold a service's one slot. A partial unique index over exactly these is
 * what makes "one open request per service" true for a writer that forgets to check.
 */
export const SERVICE_REFUND_REQUEST_ACTIVE_STATES = [
  'OPEN',
  'EXECUTING',
] as const satisfies readonly ServiceRefundRequestState[];

/** Each state's permitted successors. Every write is a conditional UPDATE naming its `from`. */
export const SERVICE_REFUND_REQUEST_TRANSITIONS: {
  readonly [K in ServiceRefundRequestState]: readonly ServiceRefundRequestState[];
} = {
  OPEN: ['EXECUTING', 'REJECTED'],
  EXECUTING: ['COMPLETED', 'FAILED'],
  COMPLETED: [],
  REJECTED: [],
  FAILED: [],
};

export function serviceRefundRequestMayTransition(
  from: ServiceRefundRequestState,
  to: ServiceRefundRequestState,
): boolean {
  return SERVICE_REFUND_REQUEST_TRANSITIONS[from].includes(to);
}

/** The customer's reason, in code points after trimming (brief §2.2). */
export const SERVICE_REFUND_REASON_MIN_LENGTH = 3;
export const SERVICE_REFUND_REASON_MAX_LENGTH = 500;

/**
 * The `refunds.reason` every refund this workflow creates carries.
 *
 * A constant, like `AUTOMATIC_REFUND_REASON`, so a reconciliation can tell these refunds
 * from an operator's own by a filter rather than by reading free text. The customer's
 * words and the administrator's decision are on the request row, which the refund's id
 * links back to.
 */
export const SERVICE_REFUND_REQUEST_REFUND_REASON = 'SERVICE_REFUND_REQUEST';

/**
 * The channel this workflow's money travels on, whatever the payment arrived by.
 *
 * The owner's explicit product rule (brief §2.7): the approved principal is credited to the
 * customer's Nexa wallet for a wallet, a manual-transfer and a gateway payment alike, and
 * nothing claims the original bank or gateway charge was reversed. It does NOT change
 * `REFUND_METHOD_SUPPORT`, which still refuses an operator's own refund of a gateway payment
 * — that table answers a different question.
 */
export const SERVICE_REFUND_REQUEST_CHANNEL = 'WALLET_CREDIT' as const;

/**
 * Why a service cannot have a refund request right now (brief §2.3). Shown to an operator
 * and in tests; a customer is simply not offered the button, or told one sentence.
 */
export const SERVICE_REFUND_INELIGIBILITY_REASONS = [
  /** The tenant has not turned the feature on. */
  'DISABLED',
  /** The service is not ACTIVE, SUSPENDED or EXPIRED. */
  'SERVICE_STATE',
  /** A request is already OPEN or EXECUTING for this service. */
  'ALREADY_REQUESTED',
  /** The service did not come from a paid `NEW_SERVICE` order (a trial, a free order). */
  'NO_PAID_SOURCE',
  /** The source order or its confirmed payment cannot be resolved unambiguously. */
  'SOURCE_UNRESOLVED',
  /** The source payment has nothing left to refund. */
  'NOTHING_REFUNDABLE',
  /** The panel cannot delete an account, or a `TERMINATE` may not be planned now. */
  'CANNOT_DELETE',
] as const;
export type ServiceRefundIneligibilityReason =
  (typeof SERVICE_REFUND_INELIGIBILITY_REASONS)[number];
export const serviceRefundIneligibilityReasonSchema = z.enum(SERVICE_REFUND_INELIGIBILITY_REASONS);

/** The service states a request may be filed and approved from (brief §2.3). */
export const SERVICE_REFUND_ELIGIBLE_SERVICE_STATES = ['ACTIVE', 'SUSPENDED', 'EXPIRED'] as const;
