import {
  START_CAPTCHA_IMAGE_DIGITS,
  START_CAPTCHA_OPERAND_MAX,
  START_CAPTCHA_OPERAND_MIN,
  START_CAPTCHA_OPTION_COUNT,
  START_CAPTCHA_QUESTION_KINDS,
  type StartCaptchaKind,
  type StartCaptchaQuestionKind,
} from '@nexa/contracts';
import type { CaptchaRandom, StartCaptchaChallenge } from './start-captcha-ports.js';

/**
 * The question generators of the `/start` captcha, one per kind. Pure over a `CaptchaRandom`:
 * the service injects the platform CSPRNG, a test injects a sequence. A generator knows its
 * answer and where it sits; what leaves the server is decided by the service, never here.
 */

/** A partial Fisher–Yates: the first `count` of a uniform shuffle of `pool` (which it reorders). */
function draw<T>(random: CaptchaRandom, pool: T[], count: number): T[] {
  for (let i = 0; i < count; i += 1) {
    const j = i + random.randomInt(pool.length - i);
    [pool[i], pool[j]] = [pool[j] as T, pool[i] as T];
  }
  return pool.slice(0, count);
}

/** The right answer among the wrong ones at a random place; returns the options and the place. */
function place<T>(
  random: CaptchaRandom,
  answer: T,
  wrong: readonly T[],
): { readonly options: T[]; readonly answerIndex: number } {
  const answerIndex = random.randomInt(START_CAPTCHA_OPTION_COUNT);
  const options = [...wrong];
  options.splice(answerIndex, 0, answer);
  return { options, answerIndex };
}

/**
 * `MATH`: `a + b` with `a`, `b` in 1..9, the right sum and three different wrong ones (all in
 * 2..18, the range of every possible sum, so no option gives itself away by being impossible),
 * in a random order.
 */
export function newMathChallenge(
  random: CaptchaRandom,
  challengeId: string,
): StartCaptchaChallenge {
  const span = START_CAPTCHA_OPERAND_MAX - START_CAPTCHA_OPERAND_MIN + 1;
  const operandA = START_CAPTCHA_OPERAND_MIN + random.randomInt(span);
  const operandB = START_CAPTCHA_OPERAND_MIN + random.randomInt(span);
  const answer = operandA + operandB;
  const lowest = START_CAPTCHA_OPERAND_MIN * 2;
  const highest = START_CAPTCHA_OPERAND_MAX * 2;
  const wrongSums: number[] = [];
  for (let value = lowest; value <= highest; value += 1)
    if (value !== answer) wrongSums.push(value);
  const { options, answerIndex } = place(
    random,
    answer,
    draw(random, wrongSums, START_CAPTCHA_OPTION_COUNT - 1),
  );
  return {
    challengeId,
    kind: 'MATH',
    operandA,
    operandB,
    options,
    answerIndex,
    answerText: null,
  };
}

/**
 * The twenty emoji of `EMOJI`: ten fruit and ten animals, each a single code point (no skin
 * tone, no variation selector), each named by a different Persian word, and none a look-alike
 * of another (one cat, one dog, one rabbit; the fruit differ in shape and colour).
 */
export const CAPTCHA_EMOJI: readonly { readonly emoji: string; readonly name: string }[] = [
  { emoji: '🍎', name: 'سیب' },
  { emoji: '🍌', name: 'موز' },
  { emoji: '🍇', name: 'انگور' },
  { emoji: '🍓', name: 'توت‌فرنگی' },
  { emoji: '🍉', name: 'هندوانه' },
  { emoji: '🍊', name: 'پرتقال' },
  { emoji: '🍒', name: 'گیلاس' },
  { emoji: '🍍', name: 'آناناس' },
  { emoji: '🥝', name: 'کیوی' },
  { emoji: '🍋', name: 'لیمو' },
  { emoji: '🐱', name: 'گربه' },
  { emoji: '🐶', name: 'سگ' },
  { emoji: '🐰', name: 'خرگوش' },
  { emoji: '🐼', name: 'پاندا' },
  { emoji: '🦁', name: 'شیر' },
  { emoji: '🐸', name: 'قورباغه' },
  { emoji: '🐧', name: 'پنگوئن' },
  { emoji: '🐢', name: 'لاک‌پشت' },
  { emoji: '🐘', name: 'فیل' },
  { emoji: '🐟', name: 'ماهی' },
];

/** The Persian name of one of the twenty emoji, or null for anything else. */
export function captchaEmojiName(emoji: string): string | null {
  return CAPTCHA_EMOJI.find((entry) => entry.emoji === emoji)?.name ?? null;
}

/** `EMOJI`: the right emoji and three other, DIFFERENT ones of the twenty, in a random order. */
export function newEmojiChallenge(
  random: CaptchaRandom,
  challengeId: string,
): StartCaptchaChallenge {
  const picked = draw(
    random,
    CAPTCHA_EMOJI.map((entry) => entry.emoji),
    START_CAPTCHA_OPTION_COUNT,
  );
  const answer = picked[0] as string;
  const { options, answerIndex } = place(random, answer, picked.slice(1));
  return {
    challengeId,
    kind: 'EMOJI',
    operandA: 0,
    operandB: 0,
    options,
    answerIndex,
    answerText: null,
  };
}

const UNITS = ['', 'یک', 'دو', 'سه', 'چهار', 'پنج', 'شش', 'هفت', 'هشت', 'نه'] as const;
const TEENS = [
  'ده',
  'یازده',
  'دوازده',
  'سیزده',
  'چهارده',
  'پانزده',
  'شانزده',
  'هفده',
  'هجده',
  'نوزده',
] as const;
const TENS = ['', '', 'بیست', 'سی', 'چهل', 'پنجاه', 'شصت', 'هفتاد', 'هشتاد', 'نود'] as const;

/** A whole number from 10 to 99 in Persian words: «سی و هفت». Null outside that range. */
export function persianWords(value: number): string | null {
  if (!Number.isInteger(value) || value < 10 || value > 99) return null;
  if (value < 20) return TEENS[value - 10] as string;
  const tens = TENS[Math.floor(value / 10)] as string;
  const units = UNITS[value % 10] as string;
  return units === '' ? tens : `${tens} و ${units}`;
}

/** Whether two numbers of 10..99 share a decimal digit (in either place). */
function sharesDigit(a: number, b: number): boolean {
  const digitsOf = (n: number): number[] => [Math.floor(n / 10), n % 10];
  const other = digitsOf(b);
  return digitsOf(a).some((digit) => other.includes(digit));
}

/**
 * `WORD_NUMBER`: a number from 10 to 99; the four buttons are Latin-digit numbers, the right
 * one and three different wrong ones of which at least one shares a digit with it (a customer
 * who half-reads the words cannot pick by elimination alone).
 */
export function newWordNumberChallenge(
  random: CaptchaRandom,
  challengeId: string,
): StartCaptchaChallenge {
  const answer = 10 + random.randomInt(90);
  const others: number[] = [];
  const near: number[] = [];
  for (let value = 10; value <= 99; value += 1) {
    if (value === answer) continue;
    (sharesDigit(answer, value) ? near : others).push(value);
  }
  const first = draw(random, near, 1)[0] as number;
  const rest = draw(
    random,
    [...near.filter((value) => value !== first), ...others],
    START_CAPTCHA_OPTION_COUNT - 2,
  );
  const { options, answerIndex } = place(random, answer, [first, ...rest]);
  return {
    challengeId,
    kind: 'WORD_NUMBER',
    operandA: 0,
    operandB: 0,
    options,
    answerIndex,
    answerText: null,
  };
}

/** `IMAGE_NUMBER`: a 4-digit number, never starting with 0, which the customer types. */
export function newImageChallenge(
  random: CaptchaRandom,
  challengeId: string,
): StartCaptchaChallenge {
  let digits = String(1 + random.randomInt(9));
  for (let i = 1; i < START_CAPTCHA_IMAGE_DIGITS; i += 1) digits += String(random.randomInt(10));
  return {
    challengeId,
    kind: 'IMAGE_NUMBER',
    operandA: 0,
    operandB: 0,
    options: [],
    answerIndex: 0,
    answerText: digits,
  };
}

/** The kind one NEW question is asked with: the setting, or for `RANDOM` one of the four. */
export function resolveQuestionKind(
  setting: StartCaptchaKind,
  random: CaptchaRandom,
): StartCaptchaQuestionKind {
  if (setting !== 'RANDOM') return setting;
  return START_CAPTCHA_QUESTION_KINDS[
    random.randomInt(START_CAPTCHA_QUESTION_KINDS.length)
  ] as StartCaptchaQuestionKind;
}

/** A new question of `kind`. */
export function newChallengeOfKind(
  kind: StartCaptchaQuestionKind,
  random: CaptchaRandom,
  challengeId: string,
): StartCaptchaChallenge {
  switch (kind) {
    case 'MATH':
      return newMathChallenge(random, challengeId);
    case 'IMAGE_NUMBER':
      return newImageChallenge(random, challengeId);
    case 'EMOJI':
      return newEmojiChallenge(random, challengeId);
    case 'WORD_NUMBER':
      return newWordNumberChallenge(random, challengeId);
  }
}

/** Zero-width characters a keyboard may put between digits: ZWSP, ZWNJ, ZWJ, LRM, RLM, WJ, BOM. */
const INVISIBLE_SPACES: ReadonlySet<number> = new Set([
  0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2060, 0xfeff,
]);

/**
 * What a customer typed under a picture question, as digits: Persian (۰-۹) and Arabic-Indic
 * (٠-٩) digits become Latin, and every space (including the zero-width non-joiner and the
 * no-break space Persian keyboards produce) is dropped. Nothing else is touched, so any other
 * character leaves the text unequal to the answer.
 */
export function normaliseCaptchaDigits(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) as number;
    if (code >= 0x30 && code <= 0x39) out += ch;
    else if (code >= 0x6f0 && code <= 0x6f9) out += String(code - 0x6f0);
    else if (code >= 0x660 && code <= 0x669) out += String(code - 0x660);
    else if (/\s/u.test(ch) || INVISIBLE_SPACES.has(code)) continue;
    else out += ch;
  }
  return out;
}
