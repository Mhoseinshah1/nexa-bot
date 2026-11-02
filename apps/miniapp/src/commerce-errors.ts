// R12 F3 item 5: the customer-facing sentence for every commerce refusal the mini app can meet.
//
// The mini app and the bot are two surfaces over the SAME application services, so a refusal
// is the same fact on both and is told in the same words: this table maps a commerce error code
// to the bot's own template (`REFUSAL_REPLIES` in the Telegram surface is the other copy of
// this mapping; `tests/web/miniapp-r12-f3.test.tsx` holds the two to each other). Codes the
// mini app words itself (`miniapp.*` keys in `ui.tsx`) win over this table.
import {
  COMMERCE_ERROR_CODES,
  PAYMENT_RECEIPT_MAX_PER_PAYMENT,
  type TemplateKey,
} from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';

export const COMMERCE_ERROR_BOT_KEY: Readonly<Record<string, TemplateKey>> = {
  [COMMERCE_ERROR_CODES.SERVICE_USERNAME_INVALID]: 'bot.username.invalid',
  [COMMERCE_ERROR_CODES.SERVICE_USERNAME_TAKEN]: 'bot.username.taken',
  [COMMERCE_ERROR_CODES.DISCOUNT_CODE_REJECTED]: 'bot.discount.rejected',
  [COMMERCE_ERROR_CODES.DISCOUNT_NO_LONGER_VALID]: 'bot.discount.no_longer_valid',
  [COMMERCE_ERROR_CODES.SERVICE_USERNAME_EXHAUSTED]: 'bot.username.exhausted',
  [COMMERCE_ERROR_CODES.SERVICE_USERNAME_UNGENERATABLE]: 'bot.username.unavailable',
  [COMMERCE_ERROR_CODES.SERVICE_USERNAME_MODE_UNAVAILABLE]: 'bot.username.mode_unavailable',
  [COMMERCE_ERROR_CODES.SERVICE_USERNAME_STALE]: 'bot.username.stale',
  [COMMERCE_ERROR_CODES.PRODUCT_NOT_FOUND]: 'bot.order.unavailable',
  [COMMERCE_ERROR_CODES.PRODUCT_NOT_PURCHASABLE]: 'bot.order.unavailable',
  [COMMERCE_ERROR_CODES.PRODUCT_NOT_FOR_AUDIENCE]: 'bot.order.unavailable',
  [COMMERCE_ERROR_CODES.RESELLER_NOT_ENTITLED]: 'bot.order.unavailable',
  [COMMERCE_ERROR_CODES.RESELLER_TERMS_CHANGED]: 'bot.order.terms_changed',
  [COMMERCE_ERROR_CODES.CUSTOM_SERVICE_DISABLED]: 'bot.custom_service.unavailable',
  [COMMERCE_ERROR_CODES.CUSTOM_SERVICE_UNAVAILABLE]: 'bot.custom_service.unavailable',
  [COMMERCE_ERROR_CODES.CUSTOM_SERVICE_TERMS_CHANGED]: 'bot.custom_service.terms_changed',
  [COMMERCE_ERROR_CODES.CUSTOM_SERVICE_NOT_EXTENDABLE]: 'bot.custom_service.not_extendable',
  [COMMERCE_ERROR_CODES.PRODUCT_NOT_PRICED]: 'bot.order.unavailable',
  [COMMERCE_ERROR_CODES.PRODUCT_NOT_FULFILLABLE]: 'bot.order.unavailable',
  [COMMERCE_ERROR_CODES.PRODUCT_NOT_CATEGORISED]: 'bot.order.unavailable',
  [COMMERCE_ERROR_CODES.CATEGORY_NOT_PURCHASABLE]: 'bot.order.unavailable',
  [COMMERCE_ERROR_CODES.PANEL_NOT_ELIGIBLE]: 'bot.order.unavailable',
  [COMMERCE_ERROR_CODES.ORDER_NOT_FOUND]: 'bot.order.unavailable',
  [COMMERCE_ERROR_CODES.SERVICE_NOT_FOUND]: 'bot.service.not_found',
  [COMMERCE_ERROR_CODES.ORDER_STATE_INVALID]: 'bot.order.not_awaiting_payment',
  [COMMERCE_ERROR_CODES.ORDER_EXPIRED]: 'bot.order.expired',
  [COMMERCE_ERROR_CODES.CUSTOMER_BLOCKED]: 'bot.blocked',
  [COMMERCE_ERROR_CODES.WALLET_NEGATIVE_TOP_UP_REQUIRED]: 'bot.wallet.negative_balance',
  [COMMERCE_ERROR_CODES.PAYMENT_METHOD_UNAVAILABLE]: 'bot.payment.unconfigured',
  [COMMERCE_ERROR_CODES.PAYMENT_WINDOW_TOO_SHORT]: 'bot.payment.window_too_short',
  [COMMERCE_ERROR_CODES.PAYMENT_NOT_FOUND]: 'bot.order.unavailable',
  [COMMERCE_ERROR_CODES.TOPUP_UNAVAILABLE]: 'bot.wallet.topup_unavailable',
  [COMMERCE_ERROR_CODES.TOPUP_NOT_OFFERED]: 'bot.wallet.topup_refused',
  [COMMERCE_ERROR_CODES.TOPUP_BELOW_MINIMUM]: 'bot.wallet.topup_refused',
  [COMMERCE_ERROR_CODES.TOPUP_ABOVE_MAXIMUM]: 'bot.wallet.topup_refused',
  [COMMERCE_ERROR_CODES.PAYMENT_DESTINATION_UNCONFIGURED]: 'bot.payment.unconfigured',
  [COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID]: 'bot.request_unavailable',
  [COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND]: 'bot.request_unavailable',
  [COMMERCE_ERROR_CODES.WALLET_INSUFFICIENT_FUNDS]: 'bot.request_unavailable',
  [COMMERCE_ERROR_CODES.PAYMENT_GATEWAY_UNAVAILABLE]: 'bot.wallet.topup_unavailable',
  [COMMERCE_ERROR_CODES.PAYMENT_GATEWAY_AMOUNT_REJECTED]: 'bot.wallet.topup_refused',
  [COMMERCE_ERROR_CODES.RECEIPT_NOT_EXPECTED]: 'bot.payment.receipt_not_expected',
  [COMMERCE_ERROR_CODES.RECEIPT_WINDOW_EXPIRED]: 'bot.payment.receipt_expired',
  [COMMERCE_ERROR_CODES.RECEIPT_LIMIT_REACHED]: 'bot.payment.receipt_limit',
  [COMMERCE_ERROR_CODES.PAYMENT_STATE_INVALID]: 'bot.payment.not_pending',
  [COMMERCE_ERROR_CODES.ORDER_TRANSFER_UNDER_REVIEW]: 'bot.order.transfer_under_review',
  [COMMERCE_ERROR_CODES.PAYMENT_CHECKOUT_IN_PROGRESS]: 'bot.payment.checkout_in_progress',
  [COMMERCE_ERROR_CODES.SETTLEMENT_NOT_FUNDED]: 'bot.order.unavailable',
  [COMMERCE_ERROR_CODES.WALLET_CURRENCY_UNSUPPORTED]: 'bot.order.unavailable',
  [COMMERCE_ERROR_CODES.SERVICE_ACTION_NOT_ALLOWED]: 'bot.service.action_not_allowed',
  [COMMERCE_ERROR_CODES.SERVICE_ACTION_UNAVAILABLE]: 'bot.service.action_unavailable',
  [COMMERCE_ERROR_CODES.ADDON_NOT_FOUND]: 'bot.service.action_unavailable',
  [COMMERCE_ERROR_CODES.ADDON_NOT_PURCHASABLE]: 'bot.service.action_unavailable',
  [COMMERCE_ERROR_CODES.PANEL_NOT_OPERABLE]: 'bot.service.capability_unsupported',
  [COMMERCE_ERROR_CODES.SERVICE_ACTION_IN_PROGRESS]: 'bot.service.action_in_progress',
  [COMMERCE_ERROR_CODES.AUTO_RENEW_DISABLED]: 'bot.service.auto_renew_unavailable',
  [COMMERCE_ERROR_CODES.AUTO_RENEW_NOT_AVAILABLE]: 'bot.service.auto_renew_unavailable',
  [COMMERCE_ERROR_CODES.LOCATION_CHANGE_SAME_LOCATION]: 'bot.service.location_same',
  [COMMERCE_ERROR_CODES.LOCATION_CHANGE_COOLDOWN]: 'bot.service.location_cooldown',
  [COMMERCE_ERROR_CODES.LOCATION_CHANGE_LIMIT_REACHED]: 'bot.service.location_limit',
  [COMMERCE_ERROR_CODES.PRODUCT_CURRENCY_UNSUPPORTED]: 'bot.service.action_unavailable',
  [COMMERCE_ERROR_CODES.SERVICE_SYNC_TOO_SOON]: 'bot.service.refresh_too_soon',
  [COMMERCE_ERROR_CODES.REFERRAL_GIFT_DISABLED]: 'bot.referral.gift_disabled',
  [COMMERCE_ERROR_CODES.GIFT_CARDS_DISABLED]: 'bot.wallet.gift_card_unavailable',
  [COMMERCE_ERROR_CODES.CAPTURE_NOT_OPEN]: 'bot.wallet.topup_expired',
  // The bot's own sentences for the customer-reachable service-request refusals.
  [COMMERCE_ERROR_CODES.SERVICE_NOT_TRANSFERABLE]: 'bot.service.transfer_unavailable',
  [COMMERCE_ERROR_CODES.SERVICE_REFUND_NOT_ELIGIBLE]: 'bot.service.refund_request_unavailable',
  [COMMERCE_ERROR_CODES.SERVICE_REFUND_REQUEST_STATE_INVALID]: 'bot.service.refund_request_pending',
  [COMMERCE_ERROR_CODES.SERVICE_TRANSFER_RECIPIENT_REFUSED]:
    'bot.service.transfer_recipient_unavailable',
};

/**
 * The commerce codes a customer is never refused with in the mini app, each answered by the
 * one generic sentence: an administrator's catalogue / payment-account / refund / trial /
 * reseller / gift-card / FAQ / tag work, a code the bot words by a screen of its own, or a
 * state the mini app never reaches. A code in neither table nor this list fails
 * `tests/web/miniapp-r12-f3.test.tsx`, so a new commerce code has to be decided here.
 */
export const COMMERCE_ERROR_GENERIC: readonly string[] = [
  COMMERCE_ERROR_CODES.CUSTOMER_BLOCK_REASON_REQUIRED,
  COMMERCE_ERROR_CODES.CATEGORY_NOT_FOUND,
  COMMERCE_ERROR_CODES.CATEGORY_NOT_EMPTY,
  COMMERCE_ERROR_CODES.SERVICE_UNRECONCILED,
  COMMERCE_ERROR_CODES.SERVICE_NOT_DELIVERABLE,
  COMMERCE_ERROR_CODES.SERVICE_ROTATION_COOLDOWN,
  COMMERCE_ERROR_CODES.SERVICE_USERNAME_REQUIRED,
  COMMERCE_ERROR_CODES.PAYMENT_ACCOUNT_NOT_FOUND,
  COMMERCE_ERROR_CODES.PAYMENT_ACCOUNT_DUPLICATE,
  COMMERCE_ERROR_CODES.PAYMENT_ACCOUNT_DISABLED,
  COMMERCE_ERROR_CODES.PAYMENT_ACCOUNT_LIMIT_REACHED,
  COMMERCE_ERROR_CODES.PAYMENT_ACCOUNT_DEFAULT_CONFLICT,
  COMMERCE_ERROR_CODES.REFUND_NOT_FOUND,
  COMMERCE_ERROR_CODES.REFUND_NOT_PERMITTED,
  COMMERCE_ERROR_CODES.REFUND_EXCEEDS_REFUNDABLE,
  COMMERCE_ERROR_CODES.REFUND_STATE_INVALID,
  COMMERCE_ERROR_CODES.PAYMENT_GATEWAY_NOT_FOUND,
  COMMERCE_ERROR_CODES.RECEIPT_NOT_FOUND,
  COMMERCE_ERROR_CODES.RECEIPT_UNAVAILABLE,
  COMMERCE_ERROR_CODES.TRIAL_RESET_STALE,
  COMMERCE_ERROR_CODES.TRIAL_RESET_NOTHING,
  COMMERCE_ERROR_CODES.TRIAL_CONFIG_STALE,
  COMMERCE_ERROR_CODES.DISCOUNT_NOT_FOUND,
  COMMERCE_ERROR_CODES.DISCOUNT_CODE_TAKEN,
  COMMERCE_ERROR_CODES.CASHBACK_RULE_NOT_FOUND,
  COMMERCE_ERROR_CODES.RESELLER_NOT_FOUND,
  COMMERCE_ERROR_CODES.RESELLER_ALREADY_REGISTERED,
  COMMERCE_ERROR_CODES.RESELLER_TIER_NOT_FOUND,
  COMMERCE_ERROR_CODES.CAPTURE_INPUT_INVALID,
  COMMERCE_ERROR_CODES.GIFT_CARD_BATCH_NOT_FOUND,
  COMMERCE_ERROR_CODES.GIFT_CARD_BATCH_INVALID,
  COMMERCE_ERROR_CODES.GIFT_CARD_CONFIRMATION_MISMATCH,
  COMMERCE_ERROR_CODES.GIFT_CARD_EXPORT_GONE,
  COMMERCE_ERROR_CODES.SUPPORT_FAQ_NOT_FOUND,
  COMMERCE_ERROR_CODES.SUPPORT_FAQ_VERSION_CONFLICT,
  COMMERCE_ERROR_CODES.SUPPORT_FAQ_LIMIT,
  COMMERCE_ERROR_CODES.MEDIA_INVALID,
  COMMERCE_ERROR_CODES.REFERRAL_GIFT_TERMS_INVALID,
  COMMERCE_ERROR_CODES.SERVICE_REFUND_REQUEST_NOT_FOUND,
  COMMERCE_ERROR_CODES.CUSTOM_SERVICE_RULE_NOT_FOUND,
  COMMERCE_ERROR_CODES.CUSTOM_SERVICE_RULE_OVERLAP,
  COMMERCE_ERROR_CODES.CUSTOM_SERVICE_RULE_INVALID,
  COMMERCE_ERROR_CODES.CUSTOM_SERVICE_LOCATION_NOT_FOUND,
  COMMERCE_ERROR_CODES.SERVICE_LOCATION_NOT_FOUND,
  COMMERCE_ERROR_CODES.SERVICE_LOCATION_INVALID,
  COMMERCE_ERROR_CODES.CUSTOMER_TRANSFER_REFUSED,
  COMMERCE_ERROR_CODES.CUSTOMER_TRANSFER_PREVIEW_STALE,
  COMMERCE_ERROR_CODES.CUSTOMER_TRANSFER_CONFIRMATION_MISMATCH,
  COMMERCE_ERROR_CODES.CUSTOMER_PHONE_INVALID,
  COMMERCE_ERROR_CODES.CUSTOMER_TAG_NOT_FOUND,
  COMMERCE_ERROR_CODES.CUSTOMER_TAG_NAME_TAKEN,
  COMMERCE_ERROR_CODES.CUSTOMER_TAG_ARCHIVED,
  COMMERCE_ERROR_CODES.CUSTOMER_TAG_LIMIT,
];

/**
 * The bot's sentence for a code, ready to show: the icon markers the bot draws from the
 * tenant's Appearance are dropped (the mini app has its own), a `{limit}` is the receipt cap,
 * and a sentence that still holds an unfilled placeholder is not shown at all.
 */
export function commerceErrorText(
  code: string,
  details: Readonly<Record<string, unknown>> = {},
): string | null {
  const key =
    /*
     * OQ-R11-A11-04: an order past its deadline only because a payment of it is still live
     * (the server says so in `paymentLive`) is NOT "order again" — that invites a second
     * payment. The bot's in-review sentence instead.
     */
    code === COMMERCE_ERROR_CODES.ORDER_EXPIRED && details['paymentLive'] === true
      ? 'bot.order.payment_in_review'
      : COMMERCE_ERROR_BOT_KEY[code];
  if (key === undefined) return null;
  const text = CATALOGUE_FA[key]
    .replaceAll(/\{icon:[a-z]+\}\s*/gu, '')
    .replaceAll('{limit}', String(PAYMENT_RECEIPT_MAX_PER_PAYMENT))
    .trim();
  return /\{[a-zA-Z]+\}/u.test(text) ? null : text;
}
