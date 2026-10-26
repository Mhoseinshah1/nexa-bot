import type { StartCaptchaState, TenantContext } from '@nexa/contracts';

/**
 * R10 D5 (a): the `/start` captcha's persistence. One row per customer, keyed by
 * `(tenant_id, customer_id)`; every method carries the tenant.
 */

/** One question: `operandA + operandB`, and the four answers in button order. */
export interface StartCaptchaChallenge {
  readonly challengeId: string;
  readonly operandA: number;
  readonly operandB: number;
  readonly options: readonly number[];
  /** Which of `options` is right. Never leaves the server. */
  readonly answerIndex: number;
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
}

/** What a re-ask writes: a new question, and the counters as they stand after it. */
export interface StartCaptchaReissue {
  readonly challenge: StartCaptchaChallenge;
  readonly attempts: number;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly lockedUntil: Date | null;
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
