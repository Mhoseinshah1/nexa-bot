import { createHash } from 'node:crypto';
import {
  COMMERCE_ERROR_CODES,
  NexaError,
  PAYMENT_GATEWAY_DESCRIPTORS,
  PAYMENT_GATEWAY_PROVIDERS,
  type LateDeliveryFallbackReason,
  type OrderId,
  type PaymentId,
} from '@nexa/contracts';
import type { OrderRecord } from '../../orders/application/ports.js';
import type { LateCreditBasis } from '../domain/late-credit.js';
import { gatewaySettlementDeadline } from '../domain/settlement.js';
import type { PaymentRecord } from './ports.js';

/**
 * NEXA-OWNER-BATCH-1 PR-5 — the rules of a LATE approval DELIVERED as the order's service
 * (`PaymentService.deliverLateGatewayApproval`), as functions the unit tests pin one by one.
 */

/** The audit action of a delivery's refusal, and of the fulfilment order it creates. */
export const LATE_DELIVERY_ACTION = 'payment.gateway_late_delivery';
export const LATE_DELIVERY_ORDER_ACTION = 'order.late_fulfilment_create';

/** How long a fulfilment order is held open: it is paid in the transaction that creates it. */
export const LATE_DELIVERY_ORDER_HOLD_MS = 15 * 60_000;

/**
 * How long past its deadline a still-PENDING payment is waited for (the expiry sweep runs every
 * minute) before the delivery gives up and the money goes to the wallet instead.
 */
export const LATE_DELIVERY_DEFER_MAX_MS = 30 * 60_000;

/** The purchase's idempotency key: every reference the delivery writes derives from it. */
export function lateDeliveryKey(paymentId: string): string {
  return `late-deliver:${paymentId}`;
}

/**
 * The id of the fulfilment order tied to a payment: a UUIDv7 that keeps the payment's own
 * timestamp and draws the rest from a hash of `late-deliver:<paymentId>`. Derived, so a second
 * delivery of one payment can only ever name the same order — the order's primary key is a
 * second lock on "one fulfilment per payment".
 */
export function lateDeliveryOrderId(paymentId: string): OrderId {
  const hex = createHash('sha256').update(lateDeliveryKey(paymentId)).digest('hex');
  const time = paymentId.replace(/-/gu, '').slice(0, 12);
  const variant = ((parseInt(hex.slice(15, 16), 16) & 0x3) | 0x8).toString(16);
  const body = `${time}7${hex.slice(0, 3)}${variant}${hex.slice(3, 18)}`;
  return `${body.slice(0, 8)}-${body.slice(8, 12)}-${body.slice(12, 16)}-${body.slice(16, 20)}-${body.slice(20, 32)}` as OrderId;
}

/**
 * Which order a delivery pays: the ORIGINAL while it still awaits payment, or a FULFILMENT
 * order tied to the payment when the original has expired. Null: there is nothing to deliver
 * (cancelled, paid another way, refunded, never confirmed).
 */
export type LateDeliveryTarget =
  | { readonly kind: 'ORIGINAL'; readonly orderId: OrderId }
  | { readonly kind: 'FULFILMENT'; readonly orderId: OrderId };

export function lateDeliveryTarget(
  paymentId: PaymentId,
  order: Pick<OrderRecord, 'id' | 'state'> | null,
): LateDeliveryTarget | null {
  if (order === null) return null;
  if (order.state === 'AWAITING_PAYMENT') return { kind: 'ORIGINAL', orderId: order.id };
  if (order.state === 'EXPIRED')
    return { kind: 'FULFILMENT', orderId: lateDeliveryOrderId(paymentId) };
  return null;
}

/** Why a delivery stopped before the money moved. Thrown inside its transaction, which rolls back. */
export type LateDeliveryStopReason =
  /* The late credit already exists: whatever it became, it happened once. */
  | { readonly kind: 'EXISTING' }
  /* The credit's own refusal (the approval is not verified, the policy is REVIEW, ...). */
  | { readonly kind: 'NOT_ELIGIBLE'; readonly reason: string }
  /* Not a delivery at all (money RETURNED for an attempt that cannot pay its order): the plain credit. */
  | { readonly kind: 'CREDIT' }
  /* A condition failed: the WALLET path instead. */
  | { readonly kind: 'FALLBACK'; readonly reason: LateDeliveryFallbackReason }
  /* The payment is still PENDING just past its deadline: asked again after the expiry sweep. */
  | { readonly kind: 'DEFER' }
  /* The order moved between the advisory read and the lock: choose the target again. */
  | { readonly kind: 'RETRY' };

export class LateDeliveryStop extends Error {
  constructor(readonly stop: LateDeliveryStopReason) {
    super(`late delivery stopped: ${stop.kind}`);
    this.name = 'LateDeliveryStop';
  }
}

/**
 * The conditions a delivery decides from the rows it holds under the payment's lock, before
 * any money moves. Null: deliver. The two the rows cannot answer — the product still sellable
 * (the catalogue) and the customer not blocked (the customer row) — are asked by the caller;
 * the panel's capacity is asked by the purchase itself, under the panel's lock.
 */
export function lateDeliveryDecision(input: {
  readonly payment: Pick<
    PaymentRecord,
    'state' | 'customerId' | 'amount' | 'expiresAt' | 'providerReviewUntil'
  >;
  readonly basis: LateCreditBasis;
  readonly order: Pick<OrderRecord, 'id' | 'state' | 'customerId' | 'purpose' | 'totals'> | null;
  readonly target: LateDeliveryTarget;
  readonly now: Date;
}): LateDeliveryStopReason | null {
  const { payment, order, target } = input;
  // Money for an attempt that can no longer pay its order (R12 F1): returned, never delivered.
  if (input.basis === 'RETURNED') return { kind: 'CREDIT' };
  // R5A item 4: an UNKNOWN payment is credited to the wallet only, never settled into an order.
  if (payment.state === 'UNKNOWN') return { kind: 'FALLBACK', reason: 'PAYMENT_UNKNOWN' };
  if (payment.state === 'PENDING') {
    /*
     * Past its deadline (the credit's verdict said so) but not yet EXPIRED by the sweep: paying
     * the order now would have the purchase withdraw this very payment. Waited for briefly; a
     * sweep that is not running is no reason to keep the money from the customer.
     */
    const deadline = gatewaySettlementDeadline(payment);
    return deadline !== null &&
      input.now.getTime() < deadline.getTime() + LATE_DELIVERY_DEFER_MAX_MS
      ? { kind: 'DEFER' }
      : { kind: 'FALLBACK', reason: 'PURCHASE_REFUSED' };
  }
  if (order === null || order.customerId !== payment.customerId) {
    return { kind: 'FALLBACK', reason: 'ORDER_CLOSED' };
  }
  if (order.purpose !== 'NEW_SERVICE') {
    return { kind: 'FALLBACK', reason: 'PURPOSE_NOT_DELIVERABLE' };
  }
  if (order.state === 'AWAITING_PAYMENT') {
    if (target.kind !== 'ORIGINAL' || target.orderId !== order.id) return { kind: 'RETRY' };
  } else if (order.state === 'EXPIRED') {
    if (target.kind !== 'FULFILMENT') return { kind: 'RETRY' };
  } else {
    return { kind: 'FALLBACK', reason: 'ORDER_CLOSED' };
  }
  // The order's FROZEN total, never a price computed now; the payment must cover it.
  if (
    payment.amount.currency !== order.totals.total.currency ||
    payment.amount.amountMinor < order.totals.total.amountMinor
  ) {
    return { kind: 'FALLBACK', reason: 'AMOUNT_DOES_NOT_COVER' };
  }
  return null;
}

/**
 * A refusal the wallet purchase raised inside the delivery's transaction, as the reason the
 * money went to the wallet instead; null for anything else (a fault, a stopped scope), which
 * is rethrown so the approval is asked again rather than decided.
 */
export function lateDeliveryFallbackOf(error: unknown): LateDeliveryFallbackReason | null {
  if (!(error instanceof NexaError)) return null;
  switch (error.code) {
    case COMMERCE_ERROR_CODES.PANEL_NOT_ELIGIBLE:
      return 'PANEL_FULL';
    case COMMERCE_ERROR_CODES.CUSTOMER_BLOCKED:
      return 'CUSTOMER_BLOCKED';
    case COMMERCE_ERROR_CODES.WALLET_INSUFFICIENT_FUNDS:
    case COMMERCE_ERROR_CODES.ORDER_TRANSFER_UNDER_REVIEW:
    case COMMERCE_ERROR_CODES.PAYMENT_CHECKOUT_IN_PROGRESS:
    case COMMERCE_ERROR_CODES.ORDER_EXPIRED:
    case COMMERCE_ERROR_CODES.ORDER_NOT_FOUND:
    case COMMERCE_ERROR_CODES.SETTLEMENT_NOT_FUNDED:
      return 'PURCHASE_REFUSED';
    default:
      return null;
  }
}

/**
 * Whether a person may decide a late completion on this payment (the Web Admin's two actions
 * and the ops-group message's two buttons): a gateway payment that has ENDED (`EXPIRED`), on
 * a route with a late-payment policy. An UNKNOWN payment is reconciled instead; a route
 * without a policy (Stars, card-to-card) keeps its own rule. Advisory: the decision itself is
 * taken again under the payment's lock.
 */
export function lateDecisionOpen(
  payment: Pick<PaymentRecord, 'method' | 'state' | 'gatewayProvider'>,
): boolean {
  const provider = payment.gatewayProvider;
  return (
    payment.method === 'GATEWAY' &&
    payment.state === 'EXPIRED' &&
    provider !== null &&
    (PAYMENT_GATEWAY_PROVIDERS as readonly string[]).includes(provider) &&
    PAYMENT_GATEWAY_DESCRIPTORS[provider].lateCreditSetting !== null
  );
}
