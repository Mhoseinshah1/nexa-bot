// Inline buttons shared by more than one flow.
// Moved verbatim out of bot-runtime.ts, which still re-exports every name it exported.
import type { CustomerNotificationKind } from '@nexa/contracts';
import type { CustomerButton } from '../../../modules/commerce/messaging/application/ports.js';
import { SUPPORT_CALLBACK_DATA } from '../../../modules/commerce/provisioning/application/delivery.service.js';
import { inlineLabel } from '../../../modules/commerce/messaging/application/inline-buttons.js';
import type { OrderReorderTarget } from '../../../modules/commerce/messaging/application/order-end-screen.js';
import {
  CATALOG_OPEN_CALLBACK_DATA,
  CUSTOM_SERVICE_CALLBACK_DATA,
  MAIN_MENU_CALLBACK_DATA,
  PAY_METHODS_CALLBACK_PREFIX,
  REORDER_CATEGORY_CALLBACK_PREFIX,
  SERVICE_ADD_TRAFFIC_CALLBACK_PREFIX,
  SERVICE_CALLBACK_PREFIX,
  SERVICE_RENEW_CALLBACK_PREFIX,
  TICKET_REPLY_CALLBACK_PREFIX,
  TICKET_VIEW_CALLBACK_PREFIX,
  TOPUP_MENU_CALLBACK_PREFIX,
  WALLET_OPEN_CALLBACK_DATA,
} from './callbacks.js';

/** R12 F3 item 1: the service reminders that point at the expiry (the renew + card pair). */
const EXPIRY_NOTIFICATION_KINDS: ReadonlySet<CustomerNotificationKind> = new Set([
  'SERVICE_EXPIRY_EARLY',
  'SERVICE_EXPIRY_FIRST',
  'SERVICE_EXPIRY_SECOND',
  'SERVICE_EXPIRY_DAY',
  'SERVICE_EXPIRED',
]);
/** R12 F3 item 1: the service reminders that point at the traffic allowance. */
const USAGE_NOTIFICATION_KINDS: ReadonlySet<CustomerNotificationKind> = new Set([
  'SERVICE_USAGE_FIRST',
  'SERVICE_USAGE_SECOND',
  'SERVICE_USAGE_FINAL',
]);

export function mainMenuButton(): CustomerButton {
  return {
    ...inlineLabel('main_menu'),
    data: MAIN_MENU_CALLBACK_DATA,
  };
}

/**
 * R11 A11: the two buttons under an ended order's screen (expired or cancelled), side by side
 * — «🔁 سفارش دوباره» and «🏠 منوی اصلی» — and nothing that pays. The first leads to a
 * READ-ONLY entry of the purchase flow (`OrderReorderTarget`): the order's category's product
 * list, the custom-service menu or the catalogue. None of those writes
 * anything; a new order exists only once the customer picks a plan and confirms it.
 */
export function orderEndButtons(reorder: OrderReorderTarget): readonly CustomerButton[] {
  const data =
    reorder.kind === 'CATEGORY'
      ? `${REORDER_CATEGORY_CALLBACK_PREFIX}${reorder.categoryId}`
      : reorder.kind === 'CUSTOM_SERVICE'
        ? CUSTOM_SERVICE_CALLBACK_DATA
        : CATALOG_OPEN_CALLBACK_DATA;
  return [
    { ...inlineLabel('order.reorder'), data, row: 0 },
    { ...inlineLabel('order.main_menu'), data: MAIN_MENU_CALLBACK_DATA, row: 0 },
  ];
}

/**
 * The inline buttons a customer NOTIFICATION carries, derived from its subject by kind
 * (Package F). Handed to the notification lane by the composition root, because the
 * callback vocabulary is this surface's: the lane stores no button and carries no payload.
 *
 * A transfer's and a renewal's open the service; support's reply opens the ticket; the
 * low-balance alert offers the top-up and a wallet credit the wallet and the catalogue
 * (owner spec §2) — those last are derived from the KIND alone. Every label and style is
 * the registry's (`inlineLabel`); a button key is not a payload.
 */
export function notificationButtons(
  kind: CustomerNotificationKind,
  subject: {
    readonly serviceId?: string;
    readonly ticketId?: string;
    readonly reorder?: OrderReorderTarget;
    /** R12 F3 item 1: the order a pending-order reminder is about. */
    readonly orderId?: string;
    /** R12 F3 item 1: the payment a notice is about and its order (null: a wallet top-up). */
    readonly payment?: { readonly orderId: string | null };
  },
): readonly CustomerButton[] {
  // R11 A11: an ended order's screen — re-order and the main menu, nothing that pays.
  if ((kind === 'ORDER_EXPIRED' || kind === 'ORDER_CANCELLED') && subject.reorder !== undefined) {
    return orderEndButtons(subject.reorder);
  }
  /*
   * R12 F3 item 1: every notification that asks the customer to do something carries the
   * button that does it — and only buttons that open an existing screen, never one that pays.
   * A service's expiry reminders offer the renewal and the card; its usage reminders the
   * extra-traffic offer; a pending order or payment its payment methods (a top-up: the
   * top-up menu); a rejected or expired payment «پرداخت دوباره»; a failed or late service
   * action support. A kind whose subject could not be read has no id and so no button.
   */
  if (EXPIRY_NOTIFICATION_KINDS.has(kind) && subject.serviceId !== undefined) {
    return [
      {
        ...inlineLabel('service.renew'),
        data: `${SERVICE_RENEW_CALLBACK_PREFIX}${subject.serviceId}`,
        row: 0,
      },
      {
        ...inlineLabel('service.renewed_details'),
        data: `${SERVICE_CALLBACK_PREFIX}${subject.serviceId}`,
        row: 0,
      },
    ];
  }
  if (USAGE_NOTIFICATION_KINDS.has(kind) && subject.serviceId !== undefined) {
    return [
      {
        ...inlineLabel('service.add_traffic'),
        data: `${SERVICE_ADD_TRAFFIC_CALLBACK_PREFIX}${subject.serviceId}`,
      },
    ];
  }
  if (kind === 'ORDER_PENDING_REMINDER' && subject.orderId !== undefined) {
    return [
      {
        ...inlineLabel('payment.methods'),
        data: `${PAY_METHODS_CALLBACK_PREFIX}${subject.orderId}`,
      },
    ];
  }
  if (kind === 'PAYMENT_PENDING_REMINDER' && subject.payment !== undefined) {
    return [
      subject.payment.orderId === null
        ? { ...inlineLabel('wallet.topup'), data: TOPUP_MENU_CALLBACK_PREFIX }
        : {
            ...inlineLabel('payment.methods'),
            data: `${PAY_METHODS_CALLBACK_PREFIX}${subject.payment.orderId}`,
          },
    ];
  }
  if (
    (kind === 'PAYMENT_REJECTED' || kind === 'PAYMENT_EXPIRED') &&
    subject.payment !== undefined
  ) {
    return [
      subject.payment.orderId === null
        ? { ...inlineLabel('payment.retry'), data: TOPUP_MENU_CALLBACK_PREFIX }
        : {
            ...inlineLabel('payment.retry'),
            data: `${PAY_METHODS_CALLBACK_PREFIX}${subject.payment.orderId}`,
          },
    ];
  }
  if (kind === 'SERVICE_ACTION_FAILED' || kind === 'SERVICE_PROVISION_DELAYED') {
    return [{ ...inlineLabel('service.support'), data: SUPPORT_CALLBACK_DATA }];
  }
  // WP-A7: support's reply opens the ticket, or its reply window, for whoever taps it.
  if (kind === 'TICKET_REPLY' && subject.ticketId !== undefined) {
    return [
      {
        ...inlineLabel('tickets.reply'),
        data: `${TICKET_REPLY_CALLBACK_PREFIX}${subject.ticketId}`,
      },
      {
        ...inlineLabel('tickets.view'),
        data: `${TICKET_VIEW_CALLBACK_PREFIX}${subject.ticketId}`,
      },
    ];
  }
  /*
   * Owner spec §2.1: the low-balance alert's one action, the top-up — the wallet screen's
   * own «افزایش موجودی», so the flow it opens is the existing one, not a copy. No id: the
   * tap's customer is the subject, and the top-up re-decides what it may offer.
   */
  if (kind === 'WALLET_LOW_BALANCE') {
    return [{ ...inlineLabel('wallet.topup'), data: TOPUP_MENU_CALLBACK_PREFIX }];
  }
  /*
   * Owner spec §2.2: a credit to the wallet — a confirmed top-up, or a receipt a reviewer
   * credited — answers with the two useful next actions, side by side. Both open a NEW
   * message, so the credit stays in the chat as its record.
   */
  if (
    kind === 'WALLET_TOPUP_CREDITED' ||
    kind === 'RECEIPT_CREDITED_TO_WALLET' ||
    // R5A item 4: a late gateway approval credited to the wallet offers the same next steps.
    kind === 'GATEWAY_LATE_PAYMENT_CREDITED' ||
    // R4 A5: an administrator's manual credit offers the same two next steps.
    kind === 'WALLET_ADMIN_CREDITED'
  ) {
    return [
      { ...inlineLabel('wallet.open'), data: WALLET_OPEN_CALLBACK_DATA, row: 0 },
      { ...inlineLabel('catalog.open'), data: CATALOG_OPEN_CALLBACK_DATA, row: 0 },
    ];
  }
  // R4 A5: a manual debit opens the wallet, where the new balance and its history are.
  if (kind === 'WALLET_ADMIN_DEBITED') {
    return [{ ...inlineLabel('wallet.open'), data: WALLET_OPEN_CALLBACK_DATA }];
  }
  // R4 A5: unblocked — the way back into the bot.
  if (kind === 'ACCOUNT_UNBLOCKED') return [mainMenuButton()];
  // Round 10, D1: a wallet short of an automatic renewal opens the wallet, to top it up.
  if (kind === 'SERVICE_AUTO_RENEW_FUNDS_SHORT') {
    return [{ ...inlineLabel('wallet.open'), data: WALLET_OPEN_CALLBACK_DATA }];
  }
  // Round 10, D1: a renewal price above the consent opens the service, to renew it by hand.
  if (kind === 'SERVICE_AUTO_RENEW_PRICE_CHANGED' && subject.serviceId !== undefined) {
    return [
      {
        ...inlineLabel('service.renewed_details'),
        data: `${SERVICE_CALLBACK_PREFIX}${subject.serviceId}`,
      },
    ];
  }
  // R2 (item 11): the renewal result's one button opens the renewed service's card.
  if (
    (kind === 'SERVICE_RENEWED' ||
      // R5C-1 item 4: a package's receipt opens the service it was bought for, like a renewal's.
      kind === 'SERVICE_TRAFFIC_ADDED' ||
      kind === 'SERVICE_TIME_ADDED') &&
    subject.serviceId !== undefined
  ) {
    return [
      {
        ...inlineLabel('service.renewed_details'),
        data: `${SERVICE_CALLBACK_PREFIX}${subject.serviceId}`,
      },
    ];
  }
  if (kind !== 'SERVICE_TRANSFER_RECEIVED' || subject.serviceId === undefined) return [];
  return [
    {
      ...inlineLabel('service.transfer_details'),
      data: `${SERVICE_CALLBACK_PREFIX}${subject.serviceId}`,
    },
  ];
}
