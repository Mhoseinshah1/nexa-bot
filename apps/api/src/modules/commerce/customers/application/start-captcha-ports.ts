import type { StartCaptchaQuestionKind, StartCaptchaState, TenantContext } from '@nexa/contracts';

/**
 * R10 D5 (a): the `/start` captcha's persistence. One row per customer, keyed by
 * `(tenant_id, customer_id)`; every method carries the tenant.
 */

/**
 * One question of a kind. `MATH`: `operandA + operandB` and four numbers; `EMOJI`: four emoji,
 * `options[answerIndex]` the one to tap; `WORD_NUMBER`: four numbers, `options[answerIndex]`
 * the one written in words; `IMAGE_NUMBER`: no buttons, the digits in `answerText`.
 */
export interface StartCaptchaChallenge {
  readonly challengeId: string;
  readonly kind: StartCaptchaQuestionKind;
  /** `MATH` only; 0 for the other kinds. */
  readonly operandA: number;
  readonly operandB: number;
  /** The offered answers in button order; empty for `IMAGE_NUMBER`. */
  readonly options: readonly (number | string)[];
  /** Which of `options` is right (0 for `IMAGE_NUMBER`). Never leaves the server. */
  readonly answerIndex: number;
  /** `IMAGE_NUMBER` only: the digits on the picture. Never leaves the server. */
  readonly answerText: string | null;
}

export interface StartCaptchaRecord extends StartCaptchaChallenge {
  readonly customerId: string;
  readonly state: StartCaptchaState;
  /** Wrong answers since the last cooldown. */
  readonly attempts: number;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly lockedUntil: Date | null;
  readonly passedAt: Date | null;
  /** `IMAGE_NUMBER`: how many times this question was swapped for a new picture. */
  readonly refreshes: number;
}

/** What a re-ask writes: a new question, and the counters as they stand after it. */
export interface StartCaptchaReissue {
  readonly challenge: StartCaptchaChallenge;
  readonly attempts: number;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly lockedUntil: Date | null;
  /** The new question's swap count: 0 for a new question, +1 for a swapped picture. */
  readonly refreshes: number;
  readonly now: Date;
}

export interface StartCaptchaRepository {
  /** The first question, written with the customer. False when a row already exists. */
  insert(
    scope: TenantContext,
    row: {
      readonly customerId: string;
      readonly challenge: StartCaptchaChallenge;
      readonly issuedAt: Date;
      readonly expiresAt: Date;
    },
    tx: unknown,
  ): Promise<boolean>;

  /** The customer's row, or null when they were never asked. Never locks. */
  find(scope: TenantContext, customerId: string, tx?: unknown): Promise<StartCaptchaRecord | null>;

  /** The same row `FOR UPDATE`, inside the answer's transaction. */
  lock(scope: TenantContext, customerId: string, tx: unknown): Promise<StartCaptchaRecord | null>;

  /**
   * Replaces the question, conditionally: `WHERE state = 'PENDING' AND challenge_id = $from`.
   * False when the row had already moved on — the caller then writes nothing else.
   */
  reissue(
    scope: TenantContext,
    customerId: string,
    fromChallengeId: string,
    next: StartCaptchaReissue,
    tx: unknown,
  ): Promise<boolean>;

  /** `PENDING -> PASSED`, conditionally on the question answered. */
  pass(
    scope: TenantContext,
    customerId: string,
    challengeId: string,
    now: Date,
    tx: unknown,
  ): Promise<boolean>;
}

/**
 * Where the question's numbers come from. `randomInt(n)` is a uniform integer in `[0, n)`.
 * The default is the platform CSPRNG (`node:crypto.randomInt`); a test injects a sequence.
 */
export interface CaptchaRandom {
  randomInt(maxExclusive: number): number;
}

/**
 * Draws the `IMAGE_NUMBER` picture: a PNG of `digits`. Pure over its arguments — the same
 * `(digits, seed)` gives the same bytes — so the picture is drawn again from the stored
 * answer and the question's id whenever it is needed and is never itself stored.
 */
export interface CaptchaImageRenderer {
  render(digits: string, seed: string): Uint8Array;
}
