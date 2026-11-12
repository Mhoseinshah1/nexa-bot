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

/** The picture question's fixed file name: never derived from the question or its answer. */
export const CAPTCHA_IMAGE_FILE_NAME = 'captcha.png';

/**
 * The buttons under a question, each `hc:<question>:<position>`. Never the answer itself. The
 * four answers go two to a row (numbers for `MATH` and `WORD_NUMBER`, emoji for `EMOJI`); the
 * picture question has none, only «🔄 تصویر جدید» (`hc:<question>:r`) while swaps remain.
 */
export function captchaOptionButtons(question: CaptchaQuestion): CustomerButton[] {
  if (question.kind === 'IMAGE_NUMBER') {
    return question.refreshesLeft > 0
      ? [
          {
            ...inlineLabel('captcha.refresh'),
            data: `${START_CAPTCHA_CALLBACK_PREFIX}${question.challengeId}:r`,
            row: 1,
          },
        ]
      : [];
  }
  return question.options.map((answer, position) => ({
    ...(question.kind === 'EMOJI'
      ? inlineLabel('captcha.emoji_option', { emoji: String(answer) })
      : inlineLabel('captcha.option', { answer: Number(answer) })),
    data: `${START_CAPTCHA_CALLBACK_PREFIX}${question.challengeId}:${String(position)}`,
    row: Math.floor(position / 2) + 1,
  }));
}

/** The template and its values for a question, by kind and by why it is shown. */
function captchaText(
  question: CaptchaQuestion,
  reason: 'CHALLENGE' | 'WRONG' | 'EXPIRED',
  remaining: number,
): Pick<PendingReply, 'key' | 'values'> {
  const wrong = { remaining };
  switch (question.kind) {
    case 'IMAGE_NUMBER':
      return reason === 'WRONG'
        ? { key: 'bot.captcha.image_wrong', values: wrong }
        : {
            key: reason === 'EXPIRED' ? 'bot.captcha.image_expired' : 'bot.captcha.image_challenge',
            values: {},
          };
    case 'EMOJI': {
      const name = { name: question.name ?? '' };
      return reason === 'WRONG'
        ? { key: 'bot.captcha.emoji_wrong', values: { ...wrong, ...name } }
        : {
            key: reason === 'EXPIRED' ? 'bot.captcha.emoji_expired' : 'bot.captcha.emoji_challenge',
            values: name,
          };
    }
    case 'WORD_NUMBER': {
      const words = { words: question.words ?? '' };
      return reason === 'WRONG'
        ? { key: 'bot.captcha.word_wrong', values: { ...wrong, ...words } }
        : {
            key: reason === 'EXPIRED' ? 'bot.captcha.word_expired' : 'bot.captcha.word_challenge',
            values: words,
          };
    }
    case 'MATH': {
      const sum = { first: question.first, second: question.second };
      return reason === 'WRONG'
        ? { key: 'bot.captcha.wrong', values: { ...wrong, ...sum } }
        : {
            key: reason === 'EXPIRED' ? 'bot.captcha.expired' : 'bot.captcha.challenge',
            values: sum,
          };
    }
  }
}

/**
 * The reply for an outcome that holds the customer, or null for one that does not. Pure.
 *
 * A tap on an answer EDITS the question message in place (`edit`), so the chat keeps one
 * question, not a trail of dead ones; any other turn — `/start`, a typed message, a menu
 * label — is answered with the question as a new message. The picture question is always a
 * NEW message (a photo cannot be edited into another photo's text): `image` are its bytes,
 * sent as the photo with the caption below it; absent, the caption goes alone.
 */
export function captchaReply(
  outcome: StartCaptchaOutcome,
  tapped: boolean,
  image: Uint8Array | null = null,
): PendingReply | null {
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
        ...(tapped ? { edit: true as const } : {}),
      };
    case 'ASK': {
      const { question } = outcome;
      const buttons = captchaOptionButtons(question);
      const reason =
        outcome.reason === 'WRONG'
          ? 'WRONG'
          : outcome.reason === 'EXPIRED'
            ? 'EXPIRED'
            : 'CHALLENGE';
      const text = captchaText(question, reason, outcome.remaining);
      if (question.kind === 'IMAGE_NUMBER') {
        return {
          ...text,
          buttons,
          orderId: null,
          ...(image === null
            ? {}
            : {
                mediaBytes: {
                  kind: 'PHOTO' as const,
                  bytes: image,
                  mimeType: 'image/png' as const,
                  fileName: CAPTCHA_IMAGE_FILE_NAME,
                  captioned: true,
                },
              }),
        };
      }
      return { ...text, buttons, orderId: null, ...(tapped ? { edit: true as const } : {}) };
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
  const tapped = command.intent === 'CAPTCHA_ANSWER' || command.intent === 'CAPTCHA_REFRESH';
  // The update's key is already spent by `resolveFromUpdate`: the captcha takes a sub-key.
  const idempotencyKey = `${input.idempotencyKey}:captcha`;
  // A typed message is a possible answer to a picture question; `answerText` shows the
  // question as `present` does for every other kind and for every customer not held.
  const typed = command.intent === 'USERNAME_TEXT' ? command.args?.[0] : undefined;
  let outcome: StartCaptchaOutcome;
  if (
    command.intent === 'CAPTCHA_ANSWER' &&
    command.targetId !== null &&
    command.choice !== undefined
  ) {
    outcome = await captcha.answer(scope, actor, customer.id, {
      idempotencyKey,
      challengeId: command.targetId,
      choice: command.choice,
    });
  } else if (command.intent === 'CAPTCHA_REFRESH' && command.targetId !== null) {
    outcome = await captcha.refresh(scope, actor, customer.id, {
      idempotencyKey,
      challengeId: command.targetId,
    });
  } else if (typed !== undefined) {
    outcome = await captcha.answerText(scope, actor, customer.id, { idempotencyKey, text: typed });
  } else {
    outcome = await captcha.present(scope, actor, customer.id, { idempotencyKey });
  }
  if (outcome.kind === 'PASSED') {
    return {
      kind: 'CONTINUE',
      command: { intent: 'START', targetId: null, callbackQueryId: command.callbackQueryId },
      arrival: 'FIRST_SEEN',
    };
  }
  const picture =
    outcome.kind === 'ASK' && outcome.question.kind === 'IMAGE_NUMBER'
      ? await captcha.renderImage(scope, customer.id, outcome.question.challengeId)
      : null;
  const reply = captchaReply(outcome, tapped, picture?.png ?? null);
  if (reply === null) return carryOn;
  if (
    (await rt.deps.telegramAdmins?.resolve(scope, input.telegramUserId, actor.correlationId)) !=
    null
  ) {
    return carryOn;
  }
  return { kind: 'HOLD', reply };
}
