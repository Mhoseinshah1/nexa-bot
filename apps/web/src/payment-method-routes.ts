import type { PaymentGatewayProvider } from '@nexa/contracts';

/**
 * UX Batch 01, item 8: every payment method has its own view at its own URL.
 *
 * The list is `/payment-gateways`, and each route is `/payment-gateways/<slug>`. A slug
 * rather than the provider's enum value, because this is a path an operator reads, pastes
 * and bookmarks; the enum value stays what the API speaks, and nothing here changes it.
 *
 * The table is TOTAL over `PaymentGatewayProvider` (a `Record`, not a partial map), so a
 * provider added to the contract does not compile until it has a view — rather than
 * appearing in the list with a link to a 404.
 */
export const PAYMENT_METHOD_SLUGS: Readonly<Record<PaymentGatewayProvider, string>> = {
  MANUAL_TRANSFER: 'card-to-card',
  TONPAYS: 'tonpays',
  TONPAYS_TELEGRAM: 'tonpays-telegram',
  TELEGRAM_STARS: 'telegram-stars',
  NOWPAYMENTS: 'nowpayments',
  CENTRALPAY: 'centralpay',
};

/** The list of payment methods. */
export const PAYMENT_METHODS_PATH = '/payment-gateways';

/** One payment method's own view. */
export function paymentMethodPath(provider: PaymentGatewayProvider): string {
  return `${PAYMENT_METHODS_PATH}/${PAYMENT_METHOD_SLUGS[provider]}`;
}

/**
 * The provider a slug names, or null for one this release does not have. Case-sensitive
 * and exact: a near-miss is not a payment method, and guessing which one was meant would
 * open a page for a route the operator did not ask for.
 */
export function providerOfSlug(slug: string): PaymentGatewayProvider | null {
  for (const [provider, candidate] of Object.entries(PAYMENT_METHOD_SLUGS)) {
    if (candidate === slug) return provider as PaymentGatewayProvider;
  }
  return null;
}

/**
 * Where the retired «حساب‌های دریافت» screen lives now (item 7): the card-to-card view,
 * which holds the card list and its add / edit / enable / disable controls.
 */
export const CARD_TO_CARD_PATH = paymentMethodPath('MANUAL_TRANSFER');
