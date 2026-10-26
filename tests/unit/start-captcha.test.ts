import { describe, expect, it } from 'vitest';
import { INLINE_BUTTONS, START_CAPTCHA_OPTION_COUNT } from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';
import {
  captchaMinutesLeft,
  newCaptchaChallenge,
  type StartCaptchaOutcome,
} from '../../apps/api/src/modules/commerce/customers/application/start-captcha.service.js';
import type { CaptchaRandom } from '../../apps/api/src/modules/commerce/customers/application/start-captcha-ports.js';
import {
  captchaOptionButtons,
  captchaReply,
} from '../../apps/api/src/surfaces/telegram/runtime/captcha-flow.js';
import {
  START_CAPTCHA_CALLBACK_PREFIX,
  intentOf,
} from '../../apps/api/src/surfaces/telegram/bot-runtime.js';

/**
 * R10 D5 (a): the /start captcha's pure parts — the question, the answer buttons, the
 * replies and the callback's parsing. The gate's behaviour against a database is
 * `tests/integration/start-captcha.test.ts`.
 */

const QUESTION = '01900000-0000-7000-8000-0000000000c1';

/** A `CaptchaRandom` that answers from a fixed list, cycling. */
function sequence(values: readonly number[]): CaptchaRandom {
  let at = 0;
  return {
    randomInt(max) {
      const value = values[at % values.length] as number;
      at += 1;
      return value % max;
    },
  };
}

describe('a captcha question', () => {
  it('is a sum of two digits with four DIFFERENT answers, the right one where the index says', () => {
    for (let seed = 0; seed < 500; seed += 1) {
      const challenge = newCaptchaChallenge(
        sequence([seed, seed * 7 + 3, seed * 13 + 5, seed * 3 + 1, seed * 11 + 2, seed]),
        QUESTION,
      );
      expect(challenge.operandA).toBeGreaterThanOrEqual(1);
      expect(challenge.operandA).toBeLessThanOrEqual(9);
      expect(challenge.operandB).toBeGreaterThanOrEqual(1);
      expect(challenge.operandB).toBeLessThanOrEqual(9);
      expect(challenge.options).toHaveLength(START_CAPTCHA_OPTION_COUNT);
      expect(new Set(challenge.options).size).toBe(START_CAPTCHA_OPTION_COUNT);
      expect(challenge.options[challenge.answerIndex]).toBe(
        challenge.operandA + challenge.operandB,
      );
      // Every option is a sum two digits can make, so none gives itself away as impossible.
      for (const option of challenge.options) {
        expect(option).toBeGreaterThanOrEqual(2);
        expect(option).toBeLessThanOrEqual(18);
      }
      expect(challenge.challengeId).toBe(QUESTION);
    }
  });

  it('puts the right answer in each of the four positions', () => {
    const positions = new Set<number>();
    for (let seed = 0; seed < 40; seed += 1) {
      positions.add(
        newCaptchaChallenge(sequence([seed, seed + 1, 0, 0, 0, seed]), QUESTION).answerIndex,
      );
    }
    expect([...positions].sort()).toEqual([0, 1, 2, 3]);
  });

  it('rounds the minutes of a cooldown up, never down to zero', () => {
    const now = new Date('2026-10-26T10:00:00.000Z');
    expect(captchaMinutesLeft(new Date('2026-10-26T10:10:00.000Z'), now)).toBe(10);
    expect(captchaMinutesLeft(new Date('2026-10-26T10:00:01.000Z'), now)).toBe(1);
    expect(captchaMinutesLeft(new Date('2026-10-26T10:09:00.001Z'), now)).toBe(10);
    expect(captchaMinutesLeft(now, now)).toBe(1);
  });
});

describe('the answer buttons', () => {
  const question = { challengeId: QUESTION, first: 4, second: 7, options: [9, 11, 14, 3] };

  it('carry the question and a POSITION, never the number they show', () => {
    const buttons = captchaOptionButtons(question);
    expect(buttons.map((button) => ('data' in button ? button.data : null))).toEqual([
      `hc:${QUESTION}:0`,
      `hc:${QUESTION}:1`,
      `hc:${QUESTION}:2`,
      `hc:${QUESTION}:3`,
    ]);
    // Within Telegram's 64-byte callback limit.
    for (const button of buttons) {
      expect(Buffer.byteLength('data' in button ? button.data : '')).toBeLessThanOrEqual(64);
    }
    // Two to a row, labelled from the registry with the offered number.
    expect(buttons.map((button) => button.row)).toEqual([1, 1, 2, 2]);
    expect(buttons.map((button) => button.label)).toEqual(
      question.options.map((answer) => ({
        kind: 'TEMPLATE',
        key: 'bot.captcha.option_button',
        values: { answer },
      })),
    );
    expect(INLINE_BUTTONS.find((entry) => entry.key === 'captcha.option')).toMatchObject({
      label: 'bot.captcha.option_button',
      action: 'CALLBACK',
      group: 'CAPTCHA',
    });
  });

  it('parse back to the question and the position, and nothing else parses', () => {
    const tap = (data: string) => intentOf({ callback_query: { id: 'q', data } });
    expect(tap(`${START_CAPTCHA_CALLBACK_PREFIX}${QUESTION}:2`)).toEqual({
      intent: 'CAPTCHA_ANSWER',
      targetId: QUESTION,
      choice: 2,
      callbackQueryId: 'q',
    });
    for (const data of [
      'hc:',
      `hc:${QUESTION}`,
      `hc:${QUESTION}:4`,
      `hc:${QUESTION}:-1`,
      `hc:${QUESTION}:1:2`,
      `hc:${QUESTION}:11`,
      'hc:not-a-uuid-not-a-uuid-not-a-uuid-xx:0',
    ]) {
      expect(tap(data).intent, data).toBe('UNSUPPORTED');
    }
  });
});

describe('the replies', () => {
  const question = { challengeId: QUESTION, first: 4, second: 7, options: [9, 11, 14, 3] };
  const ask = (reason: 'CURRENT' | 'WRONG' | 'EXPIRED' | 'RENEWED'): StartCaptchaOutcome => ({
    kind: 'ASK',
    reason,
    question,
    remaining: 2,
  });

  it('asks the question as a NEW message for anything typed, and EDITS it for a tap', () => {
    expect(captchaReply(ask('CURRENT'), false)).toMatchObject({
      key: 'bot.captcha.challenge',
      values: { first: 4, second: 7 },
    });
    expect(captchaReply(ask('CURRENT'), false)?.edit).toBeUndefined();
    expect(captchaReply(ask('CURRENT'), true)?.edit).toBe(true);
    // Never the main-menu keyboard: that rides only on the greeting after a pass.
    expect(captchaReply(ask('CURRENT'), false)?.keyboard).toBeUndefined();
  });

  it('says a wrong answer counts and how many are left, an expired one does not', () => {
    expect(captchaReply(ask('WRONG'), true)).toMatchObject({
      key: 'bot.captcha.wrong',
      values: { remaining: 2, first: 4, second: 7 },
      edit: true,
    });
    expect(captchaReply(ask('EXPIRED'), true)).toMatchObject({
      key: 'bot.captcha.expired',
      values: { first: 4, second: 7 },
    });
    expect(captchaReply(ask('RENEWED'), false)).toMatchObject({ key: 'bot.captcha.challenge' });
  });

  it('answers the cooldown with the minutes and no buttons, and holds nobody when FREE or PASSED', () => {
    expect(captchaReply({ kind: 'LOCKED', minutes: 10 }, false)).toMatchObject({
      key: 'bot.captcha.locked',
      values: { minutes: 10 },
      buttons: [],
    });
    expect(captchaReply({ kind: 'FREE' }, false)).toBeNull();
    expect(captchaReply({ kind: 'PASSED' }, true)).toBeNull();
  });

  it('never tells the customer they are blocked', () => {
    for (const key of [
      'bot.captcha.challenge',
      'bot.captcha.wrong',
      'bot.captcha.expired',
      'bot.captcha.locked',
    ] as const) {
      expect(CATALOGUE_FA[key]).not.toMatch(/مسدود/u);
    }
  });
});
