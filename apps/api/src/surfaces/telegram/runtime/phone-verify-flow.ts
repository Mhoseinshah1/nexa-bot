// R11 B7 / NEXA v095 PR-4: phone verification by the customer's OWN Telegram contact — the
// prompt with its contact keyboard, the bot-wide mandatory gate's screen (A), a payment route
// that needs a verified number (C), the contact the customer shares, and the two way-back
// labels. The rules (own number only, the allowed numbers, the write, the remembered action)
// are `PhoneVerificationService`'s; this file draws the replies and names the held action.
import {
  COMMERCE_ERROR_CODES,
  isNexaError,
  type ActorContext,
  type TenantContext,
} from '@nexa/contracts';
import type { CustomerButton } from '../../../modules/commerce/messaging/application/ports.js';
import { inlineLabel } from '../../../modules/commerce/messaging/application/inline-buttons.js';
import type { CustomerRecord } from '../../../modules/commerce/customers/application/ports.js';
import type { SharedContact } from '../../../modules/commerce/customers/application/phone-verification.service.js';
import { PHONE_VERIFY_CALLBACK_DATA } from './callbacks.js';
import { intentOf } from './intent-of.js';
import type { BotCommand, BotIntent } from './intents.js';
import { mainMenuButton } from './keyboards.js';
import type { PendingReply } from './replies.js';
import type { BotRuntime } from '../bot-runtime.js';

/**
 * The inline verify button (`phone.verify`): opens the prompt. NEXA v095 PR-4 took it off the
 * account and payment screens; it is drawn under nothing now, and a copy already in a chat
 * still opens the prompt.
 */
export function phoneVerifyButton(): CustomerButton {
  return { ...inlineLabel('phone.verify'), data: PHONE_VERIFY_CALLBACK_DATA };
}

/** Not wired (a fixture): nothing to verify here, and the main menu comes back. */
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
 * The prompt: one message carrying the CONTACT keyboard («📞 Share Contact» over the cancel
 * label). A reply keyboard and inline buttons cannot share a message, so it carries no inline
 * button; the cancel label is the way back. Offered whatever `phone_verification` says (a
 * payment route's rule verifies with it off), whenever verification is wired.
 */
export function phoneVerifyPrompt(rt: BotRuntime): PendingReply {
  if (rt.deps.phoneVerification === undefined) return unavailable(undefined);
  return {
    key: 'bot.phone.prompt',
    values: {},
    buttons: [],
    orderId: null,
    keyboard: 'PHONE_REQUEST',
  };
}

/**
 * NEXA v095 PR-4 A: the mandatory gate's screen — the contact button alone, since there is
 * nothing to go back to. `phoneHold`: the action it held is remembered, to resume after.
 */
export function phoneRequiredReply(): PendingReply {
  return {
    key: 'bot.phone.required',
    values: {},
    buttons: [],
    orderId: null,
    keyboard: 'PHONE_REQUIRED',
    phoneHold: true,
  };
}

/**
 * NEXA v095 PR-4 C: the chosen route needs a verified number. Nothing was charged and no
 * payment exists. «📞 Share Contact» continues straight to the route (the tap is remembered,
 * `phoneHold`), «↩️ انتخاب درگاه دیگر» goes back to the methods.
 */
export function phoneGatewayRequiredReply(): PendingReply {
  return {
    key: 'bot.phone.gateway_required',
    values: {},
    buttons: [],
    orderId: null,
    keyboard: 'PHONE_REQUEST_GATEWAY',
    phoneHold: true,
  };
}

/**
 * The intents the bot-wide phone gate never holds: the verification's own steps, and the
 * promotional opt-out/in (a customer must always be able to say "stop", as at the captcha).
 */
export const PHONE_GATE_EXEMPT_INTENTS: ReadonlySet<BotIntent> = new Set<BotIntent>([
  'PHONE_VERIFY',
  'PHONE_CONTACT',
  'MARKETING_OPT_OUT',
  'MARKETING_OPT_IN',
]);

/** Intents that are never remembered to resume: a gate's own step, or free text. */
const NOT_RESUMABLE: ReadonlySet<BotIntent> = new Set<BotIntent>([
  ...PHONE_GATE_EXEMPT_INTENTS,
  'PHONE_VERIFY_CANCEL',
  'PHONE_OTHER_GATEWAY',
  'UNSUPPORTED',
  'USERNAME_TEXT',
  'MEMBERSHIP_CHECK',
  'TERMS_ACCEPT',
]);

/** The longest typed command remembered (a `/start` deep link is far shorter). */
const RESUME_TEXT_MAX = 256;

/**
 * NEXA v095 PR-4 A/C: the action a phone gate held, as it is remembered: `c:<callback data>`
 * for a tapped button, `t:<text>` for a typed command or a keyboard label.
 *
 * A tap is remembered only when re-reading its data gives back the intent this turn acted on —
 * a captcha's right answer continues as `/start`, and its `hc:` data must not be what resumes;
 * such a turn is remembered as `/start`. Free text (an amount, a username, a search) is never
 * remembered: it answers a window the customer may no longer have. A label is re-read through
 * the tenant's own table when it resumes, and refused there if it no longer routes.
 */
export function phoneResumeOf(update: unknown, command: BotCommand): string | null {
  if (NOT_RESUMABLE.has(command.intent)) return null;
  const data = (update as { callback_query?: { data?: unknown } } | null)?.callback_query?.data;
  const text = (update as { message?: { text?: unknown } } | null)?.message?.text;
  if (typeof data === 'string' && data.length > 0) {
    if (intentOf(resumedUpdate(`c:${data}`)).intent === command.intent) return `c:${data}`;
  } else if (typeof text === 'string' && text.length > 0 && text.length <= RESUME_TEXT_MAX) {
    return `t:${text}`;
  }
  return command.intent === 'START' || command.intent === 'MAIN_MENU' ? 't:/start' : null;
}

/** The update a remembered action is re-read from, or null for a value that names none. */
export function resumedUpdate(resume: string): unknown {
  if (resume.startsWith('c:') && resume.length > 2) {
    return { callback_query: { data: resume.slice(2) } };
  }
  if (resume.startsWith('t:') && resume.length > 2) return { message: { text: resume.slice(2) } };
  return null;
}

/** Whether a re-read remembered action may run: never a gate's own step or free text. */
export function resumable(command: BotCommand): boolean {
  return !NOT_RESUMABLE.has(command.intent);
}

/** What a shared contact did: the reply, and — on a verification — the row and the held action. */
export type PhoneContactOutcome =
  | { readonly kind: 'REFUSED'; readonly reply: PendingReply }
  | {
      readonly kind: 'VERIFIED';
      readonly reply: PendingReply;
      readonly customer: CustomerRecord;
      readonly masked: string;
      readonly resume: string | null;
    };

/**
 * A contact the customer sent. Verified only when it is their OWN (the service compares the
 * contact's account with the resolved customer's) and an allowed number (B); the verified
 * reply brings the main menu keyboard back, which takes the contact keyboard away (E). A
 * refusal of somebody else's contact keeps the contact keyboard so the customer can tap the
 * right button.
 */
export async function phoneContactShared(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: CustomerRecord,
  contact: SharedContact,
  idempotencyKey: string,
  mainMenu: 'MAIN_MENU' | 'MAIN_MENU_ADMIN',
): Promise<PhoneContactOutcome> {
  const refused = (reply: PendingReply): PhoneContactOutcome => ({ kind: 'REFUSED', reply });
  if (rt.deps.phoneVerification === undefined) return refused(unavailable(mainMenu));
  try {
    // The update's key is spent by `resolveFromUpdate`; this is the turn's second command.
    const verified = await rt.deps.phoneVerification.verifyOwnContact(scope, actor, {
      idempotencyKey: `${idempotencyKey}:phone`,
      customerId: customer.id,
      contact,
    });
    return {
      kind: 'VERIFIED',
      reply: phoneVerifiedReply(verified.masked, mainMenu),
      customer: verified.customer,
      masked: verified.masked,
      resume: verified.resume,
    };
  } catch (error) {
    if (!isNexaError(error)) throw error;
    if (error.code === COMMERCE_ERROR_CODES.PHONE_CONTACT_NOT_OWN) {
      return refused({
        key: 'bot.phone.not_own',
        values: {},
        buttons: [],
        orderId: null,
        keyboard: 'PHONE_REQUEST',
      });
    }
    if (error.code === COMMERCE_ERROR_CODES.CUSTOMER_PHONE_INVALID) {
      return refused({
        key: 'bot.phone.invalid',
        values: {},
        buttons: [],
        orderId: null,
        keyboard: mainMenu,
      });
    }
    // B: only +98 numbers are accepted here. Nothing was stored.
    if (error.code === COMMERCE_ERROR_CODES.PHONE_NOT_IRANIAN) {
      return refused({
        key: 'bot.phone.iran_only',
        values: {},
        buttons: [],
        orderId: null,
        keyboard: mainMenu,
      });
    }
    throw error;
  }
}

/** The verified reply: the masked number, and the main menu keyboard in place of the contact one. */
export function phoneVerifiedReply(
  masked: string,
  mainMenu: 'MAIN_MENU' | 'MAIN_MENU_ADMIN',
): PendingReply {
  return {
    key: 'bot.phone.verified',
    values: { phone: masked },
    buttons: [],
    orderId: null,
    keyboard: mainMenu,
  };
}

/** The cancel label: nothing stored, and the main menu keyboard back. */
export function phoneVerifyCancelled(mainMenu: 'MAIN_MENU' | 'MAIN_MENU_ADMIN'): PendingReply {
  return { key: 'bot.phone.cancelled', values: {}, buttons: [], orderId: null, keyboard: mainMenu };
}
