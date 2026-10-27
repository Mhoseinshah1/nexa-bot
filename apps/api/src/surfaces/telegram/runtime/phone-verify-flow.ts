// R11 B7: phone verification by the customer's OWN Telegram contact — the «تأیید شماره تلفن»
// prompt with its contact keyboard, the contact the customer shares, and the cancel label.
// The rule (own number only, the flag, the write) is `PhoneVerificationService`'s; this file
// draws the replies.
import {
  COMMERCE_ERROR_CODES,
  isNexaError,
  type ActorContext,
  type Money,
  type PaymentPurpose,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import type { CustomerButton } from '../../../modules/commerce/messaging/application/ports.js';
import { inlineLabel } from '../../../modules/commerce/messaging/application/inline-buttons.js';
import type { CustomerRecord } from '../../../modules/commerce/customers/application/ports.js';
import type { SharedContact } from '../../../modules/commerce/customers/application/phone-verification.service.js';
import { PHONE_VERIFY_CALLBACK_DATA } from './callbacks.js';
import { mainMenuButton } from './keyboards.js';
import type { PendingReply } from './replies.js';
import type { BotRuntime } from '../bot-runtime.js';

/** «📱 تأیید شماره تلفن»: opens the prompt. Drawn only while the feature is on. */
export function phoneVerifyButton(): CustomerButton {
  return { ...inlineLabel('phone.verify'), data: PHONE_VERIFY_CALLBACK_DATA };
}

/**
 * Whether a screen should carry the verify button for this customer: the feature is on and
 * their number is not verified. A courtesy — a tap re-decides, and the write decides again.
 */
export async function phoneVerifyOffered(
  rt: BotRuntime,
  scope: TenantContext,
  customer: CustomerRecord,
): Promise<boolean> {
  if (rt.deps.phoneVerification === undefined || customer.phoneVerifiedAt !== null) return false;
  return rt.deps.phoneVerification.enabled(scope);
}

/**
 * Whether a PAYMENT screen should carry the verify button: verifying would offer this
 * customer a route for this purpose (and amount) that they are not offered now —
 * `CheckoutService.phoneVerificationOffered`, the route evaluation itself. False while the
 * feature is off or the customer is verified, so such a screen is exactly as before.
 */
export async function phoneUnlocksRoutes(
  rt: BotRuntime,
  scope: TenantContext,
  customerId: UserId,
  purpose: PaymentPurpose,
  amount: Money | null,
): Promise<boolean> {
  if (rt.deps.phoneVerification === undefined) return false;
  return rt.deps.checkout.phoneVerificationOffered(scope, customerId, purpose, amount);
}

/** The feature is off (or not wired): nothing to verify here, and the main menu comes back. */
function unavailable(restore: PendingReply['keyboard']): PendingReply {
  return {
    key: 'bot.phone.unavailable',
    values: {},
    buttons: restore === undefined ? [mainMenuButton()] : [],
    orderId: null,
    ...(restore === undefined ? {} : { keyboard: restore }),
  };
}

/**
 * The prompt: one message carrying the CONTACT keyboard (Telegram's contact button over
 * the cancel label). A reply keyboard and inline buttons cannot share a message, so it
 * carries no inline button; the cancel label is the way back.
 */
export async function phoneVerifyPrompt(
  rt: BotRuntime,
  scope: TenantContext,
): Promise<PendingReply> {
  if (
    rt.deps.phoneVerification === undefined ||
    !(await rt.deps.phoneVerification.enabled(scope))
  ) {
    return unavailable(undefined);
  }
  return {
    key: 'bot.phone.prompt',
    values: {},
    buttons: [],
    orderId: null,
    keyboard: 'PHONE_REQUEST',
  };
}

/**
 * A contact the customer sent. Verified only when it is their OWN (the service compares the
 * contact's account with the resolved customer's); the answer brings the main menu
 * keyboard back, except a refusal of somebody else's contact, which keeps the contact
 * keyboard so the customer can tap the right button.
 */
export async function phoneContactShared(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: CustomerRecord,
  contact: SharedContact,
  idempotencyKey: string,
  mainMenu: 'MAIN_MENU' | 'MAIN_MENU_ADMIN',
): Promise<PendingReply> {
  if (rt.deps.phoneVerification === undefined) return unavailable(mainMenu);
  try {
    // The update's key is spent by `resolveFromUpdate`; this is the turn's second command.
    const verified = await rt.deps.phoneVerification.verifyOwnContact(scope, actor, {
      idempotencyKey: `${idempotencyKey}:phone`,
      customerId: customer.id,
      contact,
    });
    return {
      key: 'bot.phone.verified',
      values: { phone: verified.masked },
      buttons: [],
      orderId: null,
      keyboard: mainMenu,
    };
  } catch (error) {
    if (!isNexaError(error)) throw error;
    if (error.code === COMMERCE_ERROR_CODES.PHONE_CONTACT_NOT_OWN) {
      return {
        key: 'bot.phone.not_own',
        values: {},
        buttons: [],
        orderId: null,
        keyboard: 'PHONE_REQUEST',
      };
    }
    if (error.code === COMMERCE_ERROR_CODES.CUSTOMER_PHONE_INVALID) {
      return {
        key: 'bot.phone.invalid',
        values: {},
        buttons: [],
        orderId: null,
        keyboard: mainMenu,
      };
    }
    if (error.code === COMMERCE_ERROR_CODES.PHONE_VERIFICATION_DISABLED) {
      return unavailable(mainMenu);
    }
    throw error;
  }
}

/** The cancel label: nothing stored, and the main menu keyboard back. */
export function phoneVerifyCancelled(mainMenu: 'MAIN_MENU' | 'MAIN_MENU_ADMIN'): PendingReply {
  return { key: 'bot.phone.cancelled', values: {}, buttons: [], orderId: null, keyboard: mainMenu };
}
