// R10 D5 (a): the `/start` captcha for NEW customers — the first check of the gate chain.
// The decision is `StartCaptchaService`'s; this file only turns its outcome into a reply.
// The chain itself (`guardedAct` -> `termsGatedAct` -> `act`) stays in BotRuntime, where
// `terms-gate.test.ts` reads it.
import type { ActorContext, BotInstanceId, CustomerArrival, TenantContext } from '@nexa/contracts';
import type { CustomerRecord } from '../../../modules/commerce/customers/application/ports.js';
import type {
  CaptchaQuestion,
  StartCaptchaOutcome,
} from '../../../modules/commerce/customers/application/start-captcha.service.js';
import { inlineLabel } from '../../../modules/commerce/messaging/application/inline-buttons.js';
import type { CustomerButton } from '../../../modules/commerce/messaging/application/ports.js';
import { START_CAPTCHA_CALLBACK_PREFIX } from './callbacks.js';
import type { BotCommand, BotIntent } from './intents.js';
import type { PendingReply } from './replies.js';
import type { BotRuntime } from '../bot-runtime.js';

/**
 * The intents the captcha never stands in front of, besides the management panel (which
 * `guardedAct` exempts with the other gates): the promotional opt-out and opt-in. Saying
 * "stop sending me promotions" is a preference, never a service, and the captcha is not the
 * place to refuse it.
 */
export const CAPTCHA_EXEMPT_INTENTS: ReadonlySet<BotIntent> = new Set<BotIntent>([
  'MARKETING_OPT_OUT',
  'MARKETING_OPT_IN',
]);

/**
 * What the gate decided for this turn: carry on down the chain — with the command as it
 * came, or, on the turn whose answer was right, as the customer's first `/start` — or hold
 * the customer with `reply`.
 */
export type CaptchaTurn =
  | {
      readonly kind: 'CONTINUE';
      readonly command: BotCommand;
      readonly arrival: CustomerArrival;
    }
  | { readonly kind: 'HOLD'; readonly reply: PendingReply };

/** The four answers, two to a row, each `hc:<question>:<position>`. Never the answer itself. */
export function captchaOptionButtons(question: CaptchaQuestion): CustomerButton[] {
  return question.options.map((answer, position) => ({
    ...inlineLabel('captcha.option', { answer }),
    data: `${START_CAPTCHA_CALLBACK_PREFIX}${question.challengeId}:${String(position)}`,
    row: Math.floor(position / 2) + 1,
  }));
}

/**
 * The reply for an outcome that holds the customer, or null for one that does not. Pure.
 *
 * A tap on an answer EDITS the question message in place (`edit`), so the chat keeps one
 * question, not a trail of dead ones; any other turn — `/start`, a typed message, a menu
 * label — is answered with the question as a new message.
 */
export function captchaReply(outcome: StartCaptchaOutcome, tapped: boolean): PendingReply | null {
  const edit = tapped ? { edit: true as const } : {};
  switch (outcome.kind) {
    case 'FREE':
    case 'PASSED':
      return null;
    case 'LOCKED':
      return {
        key: 'bot.captcha.locked',
        values: { minutes: outcome.minutes },
        buttons: [],
        orderId: null,
        ...edit,
      };
    case 'ASK': {
      const question = { first: outcome.question.first, second: outcome.question.second };
      const buttons = captchaOptionButtons(outcome.question);
      if (outcome.reason === 'WRONG') {
        return {
          key: 'bot.captcha.wrong',
          values: { remaining: outcome.remaining, ...question },
          buttons,
          orderId: null,
          ...edit,
        };
      }
      return {
        key: outcome.reason === 'EXPIRED' ? 'bot.captcha.expired' : 'bot.captcha.challenge',
        values: question,
        buttons,
        orderId: null,
        ...edit,
      };
    }
  }
}

/**
 * The captcha gate for one turn of a customer the chain has not exempted.
 *
 * An answer is decided by `answer`; anything else is shown the question by `present`. Both
 * say FREE for every customer who was never asked, has passed, or is waiting while the flag
 * is off — the ordinary turn of an ordinary customer costs one primary-key read. A bound
 * administrator is never held: the binding is asked only when the gate would hold.
 *
 * On the right answer the turn continues as the customer's first `/start` (`FIRST_SEEN`):
 * the membership and terms gates still stand in front of it, and then the welcome with the
 * main-menu keyboard — the one reply that attaches it.
 */
export async function captchaGate(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  command: BotCommand,
  customer: CustomerRecord,
  arrival: CustomerArrival,
  input: {
    readonly idempotencyKey: string;
    readonly botInstanceId: BotInstanceId;
    readonly telegramUserId: string;
  },
): Promise<CaptchaTurn> {
  const captcha = rt.deps.captcha;
  const carryOn: CaptchaTurn = { kind: 'CONTINUE', command, arrival };
  if (captcha === undefined) return carryOn;
  const tapped = command.intent === 'CAPTCHA_ANSWER';
  // The update's key is already spent by `resolveFromUpdate`: the captcha takes a sub-key.
  const idempotencyKey = `${input.idempotencyKey}:captcha`;
  const outcome =
    tapped && command.targetId !== null && command.choice !== undefined
      ? await captcha.answer(scope, actor, customer.id, {
          idempotencyKey,
          challengeId: command.targetId,
          choice: command.choice,
        })
      : await captcha.present(scope, actor, customer.id, { idempotencyKey });
  if (outcome.kind === 'PASSED') {
    return {
      kind: 'CONTINUE',
      command: { intent: 'START', targetId: null, callbackQueryId: command.callbackQueryId },
      arrival: 'FIRST_SEEN',
    };
  }
  const reply = captchaReply(outcome, tapped);
  if (reply === null) return carryOn;
  if (
    (await rt.deps.telegramAdmins?.resolve(scope, input.telegramUserId, actor.correlationId)) !=
    null
  ) {
    return carryOn;
  }
  return { kind: 'HOLD', reply };
}
