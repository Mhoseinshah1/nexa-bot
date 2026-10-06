import type { PaymentMethod } from '@nexa/contracts';

/**
 * The payment methods' names in Persian, for an operator-facing label that has no route name of
 * its own (a wallet payment, or a route whose name is unknown). A route a customer chose by name
 * is labelled by that route's own template (`bot.payment.route_name_*`) instead.
 */
export const PAYMENT_METHOD_NAMES_FA: Readonly<Record<PaymentMethod, string>> = {
  WALLET: 'کیف پول',
  MANUAL_TRANSFER: 'کارت به کارت',
  GATEWAY: 'درگاه پرداخت',
};
