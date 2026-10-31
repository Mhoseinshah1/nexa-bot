// R12 F3 item 3: no dead ends. A customer reply that would leave the customer with no button
// at all gets at least one way on — back to their services, «🛒 خرید سرویس», the wallet or the
// main menu — chosen by what the reply says, never by who is asking.
import type { TemplateKey } from '@nexa/contracts';
import type { CustomerButton } from '../../../modules/commerce/messaging/application/ports.js';
import { inlineLabel } from '../../../modules/commerce/messaging/application/inline-buttons.js';
import {
  CATALOG_OPEN_CALLBACK_DATA,
  INPUT_CANCEL_CALLBACK_DATA,
  SERVICES_LIST_PAGE_CALLBACK_PREFIX,
  TOPUP_MENU_CALLBACK_PREFIX,
} from './callbacks.js';
import { mainMenuButton } from './keyboards.js';
import type { PendingReply } from './replies.js';

/**
 * The ways on, by what the reply is about.
 *
 * - `MAIN`: only the main menu — the answer has no better next step than "start again".
 * - `BUY`: «🛒 خرید سرویس» and the main menu — an order that ended, a plan that is gone.
 * - `SERVICES`: the customer's service list and the main menu — a service that is gone or an
 *   action it cannot take; where the reply knows the service, its own site draws the way back
 *   to the card (`inCard`) and this is only the floor.
 * - `WALLET`: the top-up menu and the main menu.
 * - `CANCEL_ENTRY`: «انصراف» alone — a typed-input window that STAYS open after a refusal (a
 *   username or a code that did not fit): the customer may type another, or leave.
 */
type WayOn = 'MAIN' | 'BUY' | 'SERVICES' | 'WALLET' | 'CANCEL_ENTRY';

const WAYS: Readonly<Record<WayOn, () => readonly CustomerButton[]>> = {
  MAIN: () => [mainMenuButton()],
  BUY: () => [
    { ...inlineLabel('catalog.open'), data: CATALOG_OPEN_CALLBACK_DATA },
    mainMenuButton(),
  ],
  SERVICES: () => [
    { ...inlineLabel('service.back_to_list'), data: `${SERVICES_LIST_PAGE_CALLBACK_PREFIX}1` },
    mainMenuButton(),
  ],
  WALLET: () => [
    { ...inlineLabel('wallet.topup'), data: TOPUP_MENU_CALLBACK_PREFIX },
    mainMenuButton(),
  ],
  CANCEL_ENTRY: () => [{ ...inlineLabel('order.input_cancel'), data: INPUT_CANCEL_CALLBACK_DATA }],
};

/**
 * Every customer reply key that is answered with no button of its own, and the way on it gets.
 * Includes every refusal sentence (`REFUSAL_REPLIES`); `tests/unit/r12-no-dead-ends.test.ts`
 * fails when a reply with `buttons: []` names a key that is in neither this table nor
 * `NO_WAY_ON_ALLOWED`.
 */
export const WAY_ON: Readonly<Partial<Record<TemplateKey, WayOn>>> = {
  // The unrecognised message: the one sentence every stray text gets.
  'bot.unknown_command': 'MAIN',
  // Orders.
  'bot.order.cancelled': 'BUY',
  'bot.order.expired': 'BUY',
  'bot.order.not_awaiting_payment': 'BUY',
  'bot.order.terms_changed': 'BUY',
  'bot.order.transfer_under_review': 'MAIN',
  'bot.order.unavailable': 'BUY',
  'bot.discount.no_longer_valid': 'BUY',
  'bot.custom_service.unavailable': 'BUY',
  'bot.custom_service.not_extendable': 'BUY',
  'bot.custom_service.terms_changed': 'BUY',
  // A refused typed answer leaves its window open: the customer may type again, or leave.
  'bot.discount.rejected': 'CANCEL_ENTRY',
  'bot.username.invalid': 'CANCEL_ENTRY',
  'bot.username.taken': 'CANCEL_ENTRY',
  'bot.username.exhausted': 'BUY',
  'bot.username.mode_unavailable': 'BUY',
  'bot.username.stale': 'BUY',
  'bot.username.unavailable': 'BUY',
  // Payments.
  'bot.payment.cancelled': 'MAIN',
  'bot.payment.checkout_in_progress': 'MAIN',
  'bot.payment.not_pending': 'MAIN',
  'bot.payment.receipt_expired': 'MAIN',
  'bot.payment.receipt_limit': 'MAIN',
  'bot.payment.receipt_not_expected': 'MAIN',
  'bot.payment.transfer_under_review': 'MAIN',
  'bot.payment.unconfigured': 'MAIN',
  'bot.payment.window_too_short': 'MAIN',
  'bot.payment.withdraw_under_review': 'MAIN',
  // Wallet.
  'bot.wallet.gift_card_unavailable': 'MAIN',
  'bot.wallet.negative_balance': 'WALLET',
  'bot.wallet.topup_expired': 'WALLET',
  'bot.wallet.topup_refused': 'WALLET',
  'bot.wallet.topup_unavailable': 'MAIN',
  // Referral, trial and the generic refusal.
  'bot.referral.gift_disabled': 'MAIN',
  'bot.request_unavailable': 'MAIN',
  'bot.trial.issued': 'SERVICES',
  // Services.
  'bot.service.action_in_progress': 'SERVICES',
  'bot.service.action_not_allowed': 'SERVICES',
  'bot.service.action_requested': 'SERVICES',
  'bot.service.action_unavailable': 'SERVICES',
  'bot.service.auto_renew_unavailable': 'SERVICES',
  'bot.service.capability_unsupported': 'SERVICES',
  'bot.service.files_partial': 'SERVICES',
  'bot.service.files_rate_limited': 'SERVICES',
  'bot.service.files_unavailable': 'SERVICES',
  'bot.service.location_cooldown': 'SERVICES',
  'bot.service.location_limit': 'SERVICES',
  'bot.service.location_same': 'SERVICES',
  'bot.service.not_found': 'SERVICES',
  'bot.service.refresh_too_soon': 'SERVICES',
};

/**
 * The replies that DELIBERATELY carry no button, each with its reason. A reply with
 * `buttons: []` whose key is neither here nor in `WAY_ON` is a dead end and fails the scan.
 */
export const NO_WAY_ON_ALLOWED: Readonly<Partial<Record<TemplateKey, string>>> = {
  'bot.blocked': 'a blocked account is given no way on; the support link is its own URL button',
  'bot.blocked_spam': 'a blocked account is given no way on',
  'bot.blocked_with_reason': 'a blocked account is given no way on',
  'bot.captcha.locked': 'the customer must wait before /start; there is nothing to tap',
  'bot.custom_button.text': 'the operator’s own content; the operator decides its buttons',
  'bot.payment.receipt_received':
    'the confirmation edited into the closed payment message; the review result follows from the notification lane',
  'bot.payment.received_for_review':
    'the confirmation edited into the closed payment message; the review result follows from the notification lane',
  'bot.custom_service.days_unpriced':
    'a typed answer the window keeps open: carries its own back and cancel (customServiceExitButtons)',
  'bot.custom_service.invalid_days':
    'a typed answer the window keeps open: carries its own back and cancel (customServiceExitButtons)',
  'bot.custom_service.invalid_volume':
    'a typed answer the window keeps open: carries its own back and cancel (customServiceExitButtons)',
  'bot.custom_service.volume_unpriced':
    'a typed answer the window keeps open: carries its own back and cancel (customServiceExitButtons)',
};

/**
 * The reply with its way on, when it would otherwise have none. Touches only the keys in
 * `WAY_ON`; a reply that already has a button, that sends nothing (`key: null`), that is a
 * CLOSED wizard step, or that sets the reply keyboard is returned as it is.
 */
export function withWayOn(reply: PendingReply): PendingReply {
  if (reply.key === null || reply.buttons.length > 0) return reply;
  if (reply.keyboard !== undefined || reply.wizard?.step === 'CLOSED') return reply;
  const way = WAY_ON[reply.key];
  return way === undefined ? reply : { ...reply, buttons: WAYS[way]() };
}
