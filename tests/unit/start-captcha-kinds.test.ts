import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  INLINE_BUTTONS,
  START_CAPTCHA_IMAGE_REFRESH_MAX,
  START_CAPTCHA_KINDS,
  START_CAPTCHA_QUESTION_KINDS,
  SETTINGS,
} from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';
import {
  CAPTCHA_EMOJI,
  captchaEmojiName,
  newChallengeOfKind,
  newEmojiChallenge,
  newImageChallenge,
  newWordNumberChallenge,
  normaliseCaptchaDigits,
  persianWords,
  resolveQuestionKind,
} from '../../apps/api/src/modules/commerce/customers/application/start-captcha-questions.js';
import {
  CAPTCHA_IMAGE_HEIGHT,
  CAPTCHA_IMAGE_WIDTH,
  renderCaptchaPng,
} from '../../apps/api/src/modules/commerce/customers/infrastructure/captcha-image.js';
import type { CaptchaRandom } from '../../apps/api/src/modules/commerce/customers/application/start-captcha-ports.js';
import type {
  CaptchaQuestion,
  StartCaptchaOutcome,
} from '../../apps/api/src/modules/commerce/customers/application/start-captcha.service.js';
import {
  CAPTCHA_IMAGE_FILE_NAME,
  captchaOptionButtons,
  captchaReply,
} from '../../apps/api/src/surfaces/telegram/runtime/captcha-flow.js';
import { intentOf } from '../../apps/api/src/surfaces/telegram/bot-runtime.js';

/**
 * `captcha.kind`: the pure parts of the four question kinds — the generators, the digit
 * normalisation, the picture, the replies and the buttons. Behaviour against a database is
 * `tests/integration/start-captcha-kinds.test.ts`.
 */

const QUESTION = '01900000-0000-7000-8000-0000000000c2';

/** A small seeded generator, so a run is the same every time. */
function seeded(seed: number): CaptchaRandom {
  let state = seed >>> 0;
  return {
    randomInt(max) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return Math.floor((state / 4294967296) * max);
    },
  };
}

describe('the captcha.kind setting', () => {
  it('defaults to MATH, accepts exactly the five kinds, and configures the captcha', () => {
    const entry = SETTINGS.find((setting) => setting.key === 'captcha.kind');
    expect(entry?.defaultValue).toBe('MATH');
    expect(entry?.configures).toBe('start_captcha');
    expect([...START_CAPTCHA_KINDS]).toEqual([
      'MATH',
      'IMAGE_NUMBER',
      'EMOJI',
      'WORD_NUMBER',
      'RANDOM',
    ]);
    for (const kind of START_CAPTCHA_KINDS)
      expect(entry?.schema.safeParse(kind).success).toBe(true);
    for (const bad of ['math', 'IMAGE', '', 'RANDOM2', 1, null]) {
      expect(entry?.schema.safeParse(bad).success, String(bad)).toBe(false);
    }
  });
});

describe('RANDOM', () => {
  it('picks every one of the four kinds across seeded runs, and never RANDOM itself', () => {
    const seen = new Set<string>();
    for (const seed of [1, 2, 3]) {
      const random = seeded(seed);
      for (let draw = 0; draw < 100; draw += 1) seen.add(resolveQuestionKind('RANDOM', random));
    }
    expect([...seen].sort()).toEqual([...START_CAPTCHA_QUESTION_KINDS].sort());
  });

  it('is exactly the setting for a fixed kind, and draws nothing for it', () => {
    let draws = 0;
    const counting: CaptchaRandom = { randomInt: () => ((draws += 1), 0) };
    for (const kind of START_CAPTCHA_QUESTION_KINDS) {
      expect(resolveQuestionKind(kind, counting)).toBe(kind);
    }
    expect(draws).toBe(0);
  });
});

describe('EMOJI', () => {
  it('has twenty fixed, single-code-point emoji with distinct Persian names', () => {
    expect(CAPTCHA_EMOJI).toHaveLength(20);
    expect(new Set(CAPTCHA_EMOJI.map((entry) => entry.emoji)).size).toBe(20);
    expect(new Set(CAPTCHA_EMOJI.map((entry) => entry.name)).size).toBe(20);
    for (const { emoji, name } of CAPTCHA_EMOJI) {
      // One code point: no skin-tone modifier, no variation selector, no joiner sequence.
      expect([...emoji]).toHaveLength(1);
      expect([...emoji].every((ch) => (ch.codePointAt(0) as number) > 0x1f000)).toBe(true);
      expect(emoji).not.toMatch(/[\u{1f3fb}-\u{1f3ff}]/u);
      expect(emoji).not.toContain(String.fromCodePoint(0x200d));
      expect(emoji).not.toContain(String.fromCodePoint(0xfe0f));
      expect(name).toMatch(/^[\u0600-\u06ff\u200c ]+$/u);
    }
    expect(captchaEmojiName('🍎')).toBe('سیب');
    expect(captchaEmojiName('🚗')).toBeNull();
  });

  it('asks four DIFFERENT emoji of the twenty, the right one where the index says', () => {
    const listed = new Set(CAPTCHA_EMOJI.map((entry) => entry.emoji));
    const positions = new Set<number>();
    for (let seed = 1; seed <= 300; seed += 1) {
      const challenge = newEmojiChallenge(seeded(seed), QUESTION);
      expect(challenge.kind).toBe('EMOJI');
      expect(challenge.options).toHaveLength(4);
      expect(new Set(challenge.options).size).toBe(4);
      for (const option of challenge.options) expect(listed.has(String(option))).toBe(true);
      expect(captchaEmojiName(String(challenge.options[challenge.answerIndex]))).not.toBeNull();
      expect(challenge.answerText).toBeNull();
      positions.add(challenge.answerIndex);
    }
    expect([...positions].sort()).toEqual([0, 1, 2, 3]);
  });
});

describe('WORD_NUMBER', () => {
  it('writes 10 to 99 in Persian words', () => {
    const cases: Record<number, string> = {
      10: 'ده',
      11: 'یازده',
      15: 'پانزده',
      19: 'نوزده',
      20: 'بیست',
      21: 'بیست و یک',
      37: 'سی و هفت',
      40: 'چهل',
      58: 'پنجاه و هشت',
      99: 'نود و نه',
    };
    for (const [value, words] of Object.entries(cases)) {
      expect(persianWords(Number(value)), value).toBe(words);
    }
    expect(persianWords(9)).toBeNull();
    expect(persianWords(100)).toBeNull();
    expect(persianWords(12.5)).toBeNull();
    const all = Array.from({ length: 90 }, (_, i) => persianWords(10 + i));
    expect(new Set(all).size).toBe(90);
  });

  it('offers four distinct numbers in range, at least one wrong one sharing a digit with the answer', () => {
    const shares = (a: number, b: number) =>
      [Math.floor(a / 10), a % 10].some((digit) => [Math.floor(b / 10), b % 10].includes(digit));
    for (let seed = 1; seed <= 500; seed += 1) {
      const challenge = newWordNumberChallenge(seeded(seed), QUESTION);
      const options = challenge.options as number[];
      const answer = options[challenge.answerIndex] as number;
      expect(challenge.kind).toBe('WORD_NUMBER');
      expect(options).toHaveLength(4);
      expect(new Set(options).size).toBe(4);
      for (const option of options) {
        expect(Number.isInteger(option)).toBe(true);
        expect(option).toBeGreaterThanOrEqual(10);
        expect(option).toBeLessThanOrEqual(99);
      }
      const wrong = options.filter((_, index) => index !== challenge.answerIndex);
      expect(
        wrong.some((option) => shares(answer, option)),
        `seed ${String(seed)}`,
      ).toBe(true);
    }
  });
});

describe('IMAGE_NUMBER', () => {
  it('asks a 4-digit number that never starts with 0, with no buttons to guess from', () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const challenge = newImageChallenge(seeded(seed), QUESTION);
      expect(challenge.answerText).toMatch(/^[1-9][0-9]{3}$/u);
      expect(challenge.options).toEqual([]);
    }
  });

  it('normalises Persian and Arabic-Indic digits and drops every kind of space', () => {
    expect(normaliseCaptchaDigits('1234')).toBe('1234');
    expect(normaliseCaptchaDigits('۱۲۳۴')).toBe('1234');
    expect(normaliseCaptchaDigits('١٢٣٤')).toBe('1234');
    expect(normaliseCaptchaDigits(' 1 2 3 4 ')).toBe('1234');
    expect(normaliseCaptchaDigits('۱۲‌۳ ۴\n')).toBe('1234');
    expect(normaliseCaptchaDigits('۱2٣4')).toBe('1234');
    // Anything that is not a digit or a space stays, so it can never equal the answer.
    expect(normaliseCaptchaDigits('12a4')).toBe('12a4');
    expect(normaliseCaptchaDigits('12.34')).toBe('12.34');
    expect(normaliseCaptchaDigits('-1234')).toBe('-1234');
  });
});

describe('the picture', () => {
  const dimensions = (png: Uint8Array) => {
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  };

  it('is a PNG of about 320 x 120, and the same bytes for the same digits, seed and injected noise seed', () => {
    const first = renderCaptchaPng('4096', 'fixed-seed', 'fixed-noise');
    const again = renderCaptchaPng('4096', 'fixed-seed', 'fixed-noise');
    expect([...first.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // A snapshot of the size and dimensions only: the pixels belong to the font.
    expect(dimensions(first)).toEqual({ width: 320, height: 120 });
    expect(CAPTCHA_IMAGE_WIDTH).toBe(320);
    expect(CAPTCHA_IMAGE_HEIGHT).toBe(120);
    expect(first.byteLength).toBeGreaterThan(2_000);
    expect(first.byteLength).toBeLessThan(120_000);
    expect(Buffer.from(first).equals(Buffer.from(again))).toBe(true);
  });

  it('differs with the seed and with the digits', () => {
    const base = Buffer.from(renderCaptchaPng('4096', 'seed-a', 'n'));
    expect(base.equals(Buffer.from(renderCaptchaPng('4096', 'seed-b', 'n')))).toBe(false);
    expect(base.equals(Buffer.from(renderCaptchaPng('4097', 'seed-a', 'n')))).toBe(false);
  });

  it('adds fresh unseeded noise to every render, so two renders of one question differ', () => {
    const one = Buffer.from(renderCaptchaPng('4096', 'one-seed'));
    const two = Buffer.from(renderCaptchaPng('4096', 'one-seed'));
    expect(one.equals(two)).toBe(false);
  });

  it('is not reproduced by drawing candidates with the client-visible question id as the seed', () => {
    const challengeId = '01900000-0000-7000-8000-0000000000c1';
    const served = Buffer.from(renderCaptchaPng('4096', 'a-secret-server-side-seed'));
    // The attacker knows the id and tries every number with it, under any noise seed they like.
    for (const digits of ['4096', '4097', '1000']) {
      expect(served.equals(Buffer.from(renderCaptchaPng(digits, challengeId)))).toBe(false);
      expect(served.equals(Buffer.from(renderCaptchaPng(digits, challengeId, 'x')))).toBe(false);
    }
    const challenge = newImageChallenge({ randomInt: () => 1 }, challengeId);
    expect(challenge.renderSeed).toMatch(/^[0-9a-f]{32}$/u);
    expect(challenge.renderSeed).not.toBe(challengeId);
    expect(newImageChallenge({ randomInt: () => 1 }, challengeId).renderSeed).not.toBe(
      challenge.renderSeed,
    );
  });

  it('draws every digit, and the renderer never touches the disk', () => {
    for (const digits of ['0123', '4567', '8989']) {
      expect(dimensions(renderCaptchaPng(digits, 'all-digits'))).toEqual({
        width: 320,
        height: 120,
      });
    }
    const source = readFileSync(
      new URL(
        '../../apps/api/src/modules/commerce/customers/infrastructure/captcha-image.ts',
        import.meta.url,
      ),
      'utf8',
    );
    expect(source).not.toMatch(/node:fs|from 'fs'|writeFile|createWriteStream|tmpdir/u);
  });
});

describe('the replies of each kind', () => {
  const question = (
    kind: CaptchaQuestion['kind'],
    over: Partial<CaptchaQuestion>,
  ): CaptchaQuestion => ({
    challengeId: QUESTION,
    kind,
    first: 0,
    second: 0,
    options: [],
    name: null,
    words: null,
    refreshesLeft: 0,
    ...over,
  });
  const ask = (
    reason: 'CURRENT' | 'WRONG' | 'EXPIRED' | 'RENEWED' | 'REFRESHED',
    q: CaptchaQuestion,
  ): StartCaptchaOutcome => ({ kind: 'ASK', reason, question: q, remaining: 2 });
  const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

  const picture = question('IMAGE_NUMBER', { refreshesLeft: START_CAPTCHA_IMAGE_REFRESH_MAX });
  const emoji = question('EMOJI', { options: ['🍎', '🐱', '🍇', '🐸'], name: 'سیب' });
  const words = question('WORD_NUMBER', { options: [37, 73, 27, 47], words: 'سی و هفت' });

  it('sends the picture as a captioned PNG photo, a NEW message, with «🔄 تصویر جدید» as its only button', () => {
    for (const reason of ['CURRENT', 'RENEWED', 'REFRESHED'] as const) {
      const reply = captchaReply(ask(reason, picture), true, PNG_BYTES);
      expect(reply).toMatchObject({
        key: 'bot.captcha.image_challenge',
        mediaBytes: {
          kind: 'PHOTO',
          mimeType: 'image/png',
          captioned: true,
          fileName: CAPTCHA_IMAGE_FILE_NAME,
        },
      });
      // A photo cannot be edited into another photo: never an edit.
      expect(reply?.edit).toBeUndefined();
      expect(reply?.buttons).toHaveLength(1);
      expect(reply?.buttons[0]).toMatchObject({
        data: `hc:${QUESTION}:r`,
        label: { kind: 'TEMPLATE', key: 'bot.captcha.refresh_button' },
      });
    }
    expect(captchaReply(ask('WRONG', picture), false, PNG_BYTES)).toMatchObject({
      key: 'bot.captcha.image_wrong',
      values: { remaining: 2 },
    });
    expect(captchaReply(ask('EXPIRED', picture), false, PNG_BYTES)).toMatchObject({
      key: 'bot.captcha.image_expired',
    });
  });

  it('takes the refresh button away when the three swaps are spent', () => {
    const spent = question('IMAGE_NUMBER', { refreshesLeft: 0 });
    expect(captchaReply(ask('CURRENT', spent), false, PNG_BYTES)?.buttons).toEqual([]);
    expect(INLINE_BUTTONS.find((entry) => entry.key === 'captcha.refresh')).toMatchObject({
      label: 'bot.captcha.refresh_button',
      group: 'CAPTCHA',
      action: 'CALLBACK',
    });
  });

  it('names the emoji in the text and puts four emoji on the buttons, not the name', () => {
    expect(captchaReply(ask('CURRENT', emoji), false)).toMatchObject({
      key: 'bot.captcha.emoji_challenge',
      values: { name: 'سیب' },
    });
    expect(captchaReply(ask('WRONG', emoji), true)).toMatchObject({
      key: 'bot.captcha.emoji_wrong',
      values: { remaining: 2, name: 'سیب' },
      edit: true,
    });
    expect(captchaReply(ask('EXPIRED', emoji), true)).toMatchObject({
      key: 'bot.captcha.emoji_expired',
    });
    const buttons = captchaOptionButtons(emoji);
    expect(buttons.map((button) => button.label)).toEqual(
      ['🍎', '🐱', '🍇', '🐸'].map((glyph) => ({
        kind: 'TEMPLATE',
        key: 'bot.captcha.emoji_option_button',
        values: { emoji: glyph },
      })),
    );
    expect(buttons.map((button) => button.row)).toEqual([1, 1, 2, 2]);
  });

  it('writes the number in words and shows Latin-digit buttons', () => {
    expect(captchaReply(ask('CURRENT', words), false)).toMatchObject({
      key: 'bot.captcha.word_challenge',
      values: { words: 'سی و هفت' },
    });
    expect(captchaReply(ask('WRONG', words), true)).toMatchObject({
      key: 'bot.captcha.word_wrong',
      values: { remaining: 2, words: 'سی و هفت' },
    });
    expect(captchaReply(ask('EXPIRED', words), true)).toMatchObject({
      key: 'bot.captcha.word_expired',
    });
    expect(captchaOptionButtons(words).map((button) => button.label)).toEqual(
      [37, 73, 27, 47].map((answer) => ({
        kind: 'TEMPLATE',
        key: 'bot.captcha.option_button',
        values: { answer },
      })),
    );
  });

  it('never puts an answer in callback data: only the question id and a position, or r', () => {
    for (let seed = 1; seed <= 100; seed += 1) {
      for (const kind of START_CAPTCHA_QUESTION_KINDS) {
        const challenge = newChallengeOfKind(kind, seeded(seed), QUESTION);
        const q = question(kind, {
          options: challenge.options,
          refreshesLeft: 3,
          name: null,
          words: null,
        });
        for (const button of captchaOptionButtons(q)) {
          const data = 'data' in button ? button.data : '';
          expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
          expect(data).toMatch(new RegExp(`^hc:${QUESTION}:([0-3]|r)$`, 'u'));
        }
      }
    }
  });

  it('says nothing is blocked, and uses Latin digits, in every new customer text', () => {
    const keys = Object.keys(CATALOGUE_FA).filter(
      (key) =>
        /^bot\.captcha\.(image|emoji|word)_/u.test(key) || key === 'bot.captcha.refresh_button',
    );
    expect(keys).toHaveLength(11);
    for (const key of keys) {
      const text = CATALOGUE_FA[key as keyof typeof CATALOGUE_FA];
      expect(text, key).not.toMatch(/مسدود/u);
      expect(text, key).not.toMatch(/[۰-۹٠-٩]/u);
    }
  });
});

describe('the refresh callback', () => {
  const tap = (data: string) => intentOf({ callback_query: { id: 'q', data } });

  it('parses hc:<question>:r as a refresh, and nothing near it parses', () => {
    expect(tap(`hc:${QUESTION}:r`)).toEqual({
      intent: 'CAPTCHA_REFRESH',
      targetId: QUESTION,
      callbackQueryId: 'q',
    });
    for (const data of [`hc:${QUESTION}:R`, `hc:${QUESTION}:rr`, `hc:${QUESTION}:`, 'hc:r']) {
      expect(tap(data).intent, data).toBe('UNSUPPORTED');
    }
  });
});
