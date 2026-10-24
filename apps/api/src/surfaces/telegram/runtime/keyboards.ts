// Inline buttons shared by more than one flow.
// Moved verbatim out of bot-runtime.ts, which still re-exports every name it exported.
import type { CustomerNotificationKind } from '@nexa/contracts';
import type { CustomerButton } from '../../../modules/commerce/messaging/application/ports.js';
import { inlineLabel } from '../../../modules/commerce/messaging/application/inline-buttons.js';
import {
  CATALOG_OPEN_CALLBACK_DATA,
  MAIN_MENU_CALLBACK_DATA,
  SERVICE_CALLBACK_PREFIX,
  TICKET_REPLY_CALLBACK_PREFIX,
  TICKET_VIEW_CALLBACK_PREFIX,
  TOPUP_MENU_CALLBACK_PREFIX,
  WALLET_OPEN_CALLBACK_DATA,
} from './callbacks.js';

export function mainMenuButton(): CustomerButton {
  return {
    ...inlineLabel('main_menu'),
    data: MAIN_MENU_CALLBACK_DATA,
  };
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
  subject: { readonly serviceId?: string; readonly ticketId?: string },
): readonly CustomerButton[] {
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
