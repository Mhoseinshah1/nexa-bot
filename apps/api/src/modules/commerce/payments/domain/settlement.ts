import type { OrderRecord } from '../../orders/application/ports.js';
import type { PaymentRecord } from '../application/ports.js';

/**
 * Why a settlement was refused, or `null` when it was not.
 *
 * A REASON rather than a boolean, because every one of these is a different defect and
 * an operator reading an audit row needs to know which. The legacy log cannot answer
 * the equivalent question at all: success and failure land in different topics with no
 * shared key (`LGR-BR-080`/`082`).
 */
export type SettlementRefusal =
  | 'PAYMENT_NOT_CONFIRMED'
  | 'PAYMENT_NAMES_NO_ORDER'
  | 'PAYMENT_NAMES_ANOTHER_ORDER'
  | 'PAYMENT_NAMES_ANOTHER_CUSTOMER'
  | 'ORDER_NOT_AWAITING_PAYMENT'
  | 'AMOUNT_DOES_NOT_COVER_THE_ORDER'
  | 'CURRENCY_DOES_NOT_MATCH_THE_ORDER';

/**
 * `settlementIsFunded` — the guard `ORDER_MACHINE` names and this module implements.
 *
 * `state-machine.ts` says where the two halves live: *"Named guard, resolved by the
 * owning module. Documentation here, code there."* This is the code, and
 * `commerce.ts` is the specification it answers to — an order settles *"only when the
 * money backing it is real — a confirmed payment or a committed wallet debit — and
 * never because a client said so."*
 *
 * Every check compares two ROWS. Nothing here reads a request, and there is no
 * parameter a caller could pass to influence the answer: the payment was written by
 * this system and the order's total was frozen by `nexa_orders_snapshot_guard` at
 * confirmation. That is what makes this guard unfoolable by a callback.
 *
 * ## Why the amount must be EQUAL and not merely sufficient
 *
 * An over-payment is not a funded order, it is an order plus a credit nobody has
 * decided the fate of, and deciding it here would be inventing a financial product
 * rule — the legacy system has three unrelated mechanisms that all end as an opaque
 * balance bump, which is what that invention looks like after a few years. The
 * research measures the rule this states: `LGR-BR-002`, a wallet purchase where
 * `موجودی قبل − موجودی بعد = قیمت نهایی` exactly (993,000 − 888,000 = 105,000).
 *
 * A partial payment with the remainder on another rail is `LGR-BR-003` and is
 * DEFERRED, because a split needs a second rail to take the remainder and this release
 * has none.
 */
export function settlementRefusal(
  order: OrderRecord,
  payment: PaymentRecord,
): SettlementRefusal | null {
  if (payment.state !== 'CONFIRMED') return 'PAYMENT_NOT_CONFIRMED';
  if (payment.orderId === null) return 'PAYMENT_NAMES_NO_ORDER';
  if (payment.orderId !== order.id) return 'PAYMENT_NAMES_ANOTHER_ORDER';
  /*
   * The customer is checked even though `payments_order_fk` is a composite key over
   * `(tenant_id, order_id, customer_id)` that already forbids the mismatch.
   *
   * Two statements of one rule, on purpose, and the reason is in the schema's own
   * comment: that foreign key is MATCH SIMPLE and is therefore NOT enforced when any of
   * its columns is NULL — which `order_id` is allowed to be. A future top-up payment
   * reaching this guard would carry a customer the database never checked against an
   * order.
   */
  if (payment.customerId !== order.customerId) return 'PAYMENT_NAMES_ANOTHER_CUSTOMER';
  if (order.state !== 'AWAITING_PAYMENT') return 'ORDER_NOT_AWAITING_PAYMENT';
  if (payment.amount.currency !== order.totals.total.currency) {
    /*
     * Refused, never converted. `money.ts` requires a currency on every amount because
     * the legacy system has NO exchange rate anywhere — absent from all seven inspected
     * gateways, and Telegram Stars stores a Toman total with no conversion field at all
     * (`FBR-010`, `LGR-BR-062`). A rate this code invented would be a number nobody
     * chose applied to somebody's money.
     */
    return 'CURRENCY_DOES_NOT_MATCH_THE_ORDER';
  }
  if (payment.amount.amountMinor !== order.totals.total.amountMinor) {
    return 'AMOUNT_DOES_NOT_COVER_THE_ORDER';
  }
  return null;
}

/** The guard itself, for a reader looking for the name the machine uses. */
export function settlementIsFunded(order: OrderRecord, payment: PaymentRecord): boolean {
  return settlementRefusal(order, payment) === null;
}
