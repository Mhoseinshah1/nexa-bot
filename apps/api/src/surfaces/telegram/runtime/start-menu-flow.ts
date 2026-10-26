// The start menu's own screens: the greeting, the marketing preference, and the two gates'
// replies (membership and terms). The gate chain itself (`guardedAct` -> `termsGatedAct` ->
// `acceptTerms`) stays in BotRuntime, where `terms-gate.test.ts` reads it.
// Moved verbatim out of bot-runtime.ts, which still re-exports every name it exported.
import type { BotIntent } from './intents.js';
import {
  type TelegramChannel,
  telegramChannelJoinUrl,
  isNexaError,
  type TenantContext,
  type ActorContext,
  type TemplateKey,
  type TemplateValues,
  money,
} from '@nexa/contracts';
import type { PendingReply } from './replies.js';
import type { CustomerButton } from '../../../modules/commerce/messaging/application/ports.js';
import {
  inlineDataLabel,
  inlineLabel,
} from '../../../modules/commerce/messaging/application/inline-buttons.js';
import {
  MEMBERSHIP_CHECK_CALLBACK_DATA,
  TERMS_ACCEPT_CALLBACK_PREFIX,
  MARKETING_OPT_IN_CALLBACK_DATA,
  MARKETING_OPT_OUT_CALLBACK_DATA,
} from './callbacks.js';
import { mainMenuButton } from './keyboards.js';
import { MARKETING_OPT_OUT_DISABLED_REASON } from '../../../modules/commerce/customers/application/customer.service.js';
import type { CustomerRecord } from '../../../modules/commerce/customers/application/ports.js';
import type { StartGreetingKey } from '../../../modules/commerce/messaging/application/start-greeting.js';
import type { BotRuntime } from '../bot-runtime.js';

/**
 * The intents the membership guard lets through (Package B, brief B3): support and help —
 * the minimal support path, which `/paysupport` opens too. The check button and the
 * management panel are let through by `guardedAct` itself.
 */
export const MEMBERSHIP_EXEMPT_INTENTS: ReadonlySet<BotIntent> = new Set<BotIntent>([
  'SUPPORT',
  'HELP',
  'MARKETING_OPT_OUT',
  'MARKETING_OPT_IN',
]);

/**
 * The join screen (brief B4): one message, a URL button per missing REQUIRED channel, and
 * the check button. A public channel's button is its `@handle`; a private one is numbered.
 * A channel with no join link cannot be configured as required, so every one has a button.
 */
export function membershipRequired(
  key: 'bot.channels.join_required' | 'bot.channels.still_missing',
  missing: readonly TelegramChannel[],
): PendingReply {
  const buttons: CustomerButton[] = [];
  missing.forEach((channel, index) => {
    const url = telegramChannelJoinUrl(channel);
    if (url === null) return;
    buttons.push({
      ...(channel.handle !== undefined
        ? inlineDataLabel('channels.join_public', { kind: 'TEXT', text: channel.handle })
        : inlineLabel('channels.join_private', { number: index + 1 })),
      url,
    });
  });
  buttons.push({
    ...inlineLabel('channels.check'),
    data: MEMBERSHIP_CHECK_CALLBACK_DATA,
  });
  return {
    key,
    values: {},
    buttons,
    orderId: null,
    /*
     * R2: a gate, not a step — its own message, so the screen the customer tapped stays
     * behind it and works again once they have joined.
     */
    wizard: { kind: 'ORDER', step: 'NOTICE', placement: 'NEW' },
  };
}

/**
 * The terms screen (program §6): the current version's title and text, as the operator
 * wrote them, and one accept button that names THAT version. A gate like the join screen —
 * its own message, so the screen the customer tapped stays behind it.
 */
export function termsRequired(
  key: 'bot.terms.required' | 'bot.terms.updated',
  version: { readonly id: string; readonly title: string; readonly body: string },
): PendingReply {
  return {
    key,
    values: { title: version.title, body: version.body },
    buttons: [
      {
        ...inlineLabel('terms.accept'),
        data: `${TERMS_ACCEPT_CALLBACK_PREFIX}${version.id}`,
      },
    ],
    orderId: null,
    wizard: { kind: 'ORDER', step: 'NOTICE', placement: 'NEW' },
  };
}

/**
 * Batch 01 item 1: the answer to an accept button once the acceptance is recorded (now or
 * by an earlier tap). It EDITS the terms message the button sits on (`edit`), so the
 * customer is left with one message that says the rules were accepted, and no new one.
 *
 * The accept button goes with the edit (the keyboard is always replaced), and the way to
 * the main menu takes its place: a customer stopped at their very first `/start` has
 * never been sent the persistent menu keyboard, and the tap on «منوی اصلی» is the
 * customer's own request for it. Pure, so the shape is pinned without a database.
 *
 * When Telegram cannot edit the message (deleted, or a photo) the SAME reply goes out once
 * as a new message — `editOrSend`'s one fallback; "not modified" is success, never a
 * fallback, so a repeated tap can never become a second message.
 */
export function termsAcceptedReply(): PendingReply {
  return {
    key: 'bot.terms.accepted',
    values: {},
    buttons: [mainMenuButton()],
    orderId: null,
    edit: true,
  };
}

/**
 * Batch 01 item 1: an accept button whose version is no longer current. The SAME message is
 * edited into the version that replaced it, with that version's own button — the customer
 * never has two terms prompts on screen, one of them dead.
 */
export function termsStaleReply(version: {
  readonly id: string;
  readonly title: string;
  readonly body: string;
}): PendingReply {
  return { ...termsRequired('bot.terms.updated', version), edit: true };
}

/**
 * Round N close (§D): the opt-in button when the customer has opted out of promotions, the
 * opt-out button otherwise. One button, the reverse of the state, so the screen never shows
 * a choice that is already the case.
 */
/** Spec §9: the service's refusal while customers may not change their preference. */
export function isMarketingOptOutDisabled(error: unknown): boolean {
  return isNexaError(error) && error.details['reason'] === MARKETING_OPT_OUT_DISABLED_REASON;
}

export function marketingPreferenceButton(optedOut: boolean): CustomerButton {
  return optedOut
    ? {
        ...inlineLabel('marketing.opt_in'),
        data: MARKETING_OPT_IN_CALLBACK_DATA,
      }
    : {
        ...inlineLabel('marketing.opt_out'),
        data: MARKETING_OPT_OUT_CALLBACK_DATA,
      };
}

/**
 * R6 item 3: `/start`'s greeting for the customer whose update this is, as a key and VALUES.
 *
 * Every fact is read now, for THIS customer (the row the signed update resolved to), and
 * handed to the pure `startGreetingValues`; the name is sanitised by the one renderer when
 * the message is sent. Nothing rendered is stored — the reply carries values, and the text
 * is composed by the messenger at send time from the tenant's raw template.
 */
export async function startGreeting(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: CustomerRecord,
  key: StartGreetingKey,
): Promise<{ readonly key: TemplateKey; readonly values: TemplateValues }> {
  const now = rt.deps.clock.now();
  const [balance, serving] = await Promise.all([
    rt.deps.wallet.balanceForCustomer(scope, actor, customer.id),
    rt.deps.services.greetingFactsForCustomer(scope, customer.id, now),
  ]);
  return rt.deps.screens.startGreeting(key, {
    telegramUserId: customer.telegramUserId,
    username: customer.username,
    firstName: customer.firstName,
    balance: money(balance.amountMinor, balance.currency),
    activeServices: serving.serving,
    nearestExpiresAt: serving.nearestExpiresAt,
    now,
  });
}

/**
 * The FAQ/support screen (§J): the tenant's active entries in parts split at item
 * boundaries, the earlier parts as leads and the last carrying the keyboard; with no
 * active entry, the contact action alone. The contact button opens the FIRST configured
 * support account and is not drawn when none is configured.
 */
/**
 * Round N close (§D): the customer's own promotional opt-out or opt-in, under the update's
 * key. The reply names what changed and carries the way back; a repeated tap is answered
 * with the same reply, because the preference already holds.
 */
export async function marketingPreference(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customer: CustomerRecord,
  optedOut: boolean,
  idempotencyKey: string,
): Promise<PendingReply> {
  /*
   * Spec §9: while the installation does not let customers stop promotions, /stop and an
   * old opt-out / opt-in button are answered and change nothing. The service decides
   * again inside its transaction; its refusal (the switch moved between the two reads) is
   * answered the same way.
   */
  const unavailable: PendingReply = {
    key: 'bot.marketing.unavailable',
    values: {},
    buttons: [mainMenuButton()],
    orderId: null,
  };
  if (!(await rt.deps.customers.marketingOptOutAllowed(scope))) return unavailable;
  // The update's key is already spent by `resolveFromUpdate` under this surface: the
  // preference is a second command of the same turn, so it takes the turn's sub-key.
  try {
    await rt.deps.customers.setMarketingOptOut(scope, actor, {
      idempotencyKey: `${idempotencyKey}:marketing`,
      customerId: customer.id,
      optedOut,
    });
  } catch (error) {
    if (isMarketingOptOutDisabled(error)) return unavailable;
    throw error;
  }
  /*
   * The way back, never the thing just done: `marketingPreferenceButton` takes "is the
   * customer opted out now", and answers the opt-in button for a customer who is. It was
   * passed `!optedOut`, so «promotions are off — tap below to turn them back on» carried
   * the OPT-OUT button, and the reply to turning them back on carried the opt-in one.
   */
  return {
    key: optedOut ? 'bot.marketing.opted_out' : 'bot.marketing.opted_in',
    values: {},
    buttons: [marketingPreferenceButton(optedOut), mainMenuButton()],
    orderId: null,
  };
}
