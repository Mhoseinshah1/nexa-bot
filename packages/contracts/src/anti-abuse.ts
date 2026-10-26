import { z } from 'zod';

/**
 * R10 D5: the two anti-abuse switches — the `/start` captcha for NEW customers and the
 * referral-gift guard. Both ship OFF (`start_captcha`, `referral_abuse_guard`); with either
 * off the bot behaves exactly as it did before they existed.
 */

// --- (a) The /start captcha ---------------------------------------------------------

/**
 * A customer's captcha row. `PENDING` holds the customer at the gate while
 * `start_captcha` is on; `PASSED` never holds anybody again. There is no FAILED: a wrong
 * answer costs an attempt and, at the limit, a cooldown — never a block, never a status
 * change on the customer row.
 */
export const START_CAPTCHA_STATES = ['PENDING', 'PASSED'] as const;
export type StartCaptchaState = (typeof START_CAPTCHA_STATES)[number];

/** How many answers a challenge offers: one right, three wrong, as four inline buttons. */
export const START_CAPTCHA_OPTION_COUNT = 4;
/** Each operand of `a + b` is drawn from 1..9, so every answer is 2..18. */
export const START_CAPTCHA_OPERAND_MIN = 1;
export const START_CAPTCHA_OPERAND_MAX = 9;

export const START_CAPTCHA_EXPIRY_SECONDS_MIN = 60;
export const START_CAPTCHA_EXPIRY_SECONDS_MAX = 3600;
export const START_CAPTCHA_MAX_ATTEMPTS_MIN = 1;
export const START_CAPTCHA_MAX_ATTEMPTS_MAX = 10;
export const START_CAPTCHA_COOLDOWN_SECONDS_MIN = 60;
export const START_CAPTCHA_COOLDOWN_SECONDS_MAX = 86_400;

// --- (b) The referral-gift guard -----------------------------------------------------

/**
 * When a referral's signup gift becomes claimable while `referral_abuse_guard` is on.
 *
 * - `ON_ATTRIBUTION`: from the accepted attribution, exactly as with the guard off.
 * - `ON_FIRST_PAID_PURCHASE`: only once the REFEREE has a paid order that was delivered —
 *   the same "delivered" the purchase commission is earned on. Both sides wait for it.
 */
export const REFERRAL_GIFT_UNLOCK_MODES = ['ON_ATTRIBUTION', 'ON_FIRST_PAID_PURCHASE'] as const;
export type ReferralGiftUnlockMode = (typeof REFERRAL_GIFT_UNLOCK_MODES)[number];
export const referralGiftUnlockModeSchema = z.enum(REFERRAL_GIFT_UNLOCK_MODES);

/** A per-referrer daily cap: a whole count of at least one, or null for no cap. */
export const REFERRAL_DAILY_CAP_MIN = 1;
export const REFERRAL_DAILY_CAP_MAX = 10_000;
export const referralDailyCapSchema = z
  .number()
  .int()
  .min(REFERRAL_DAILY_CAP_MIN)
  .max(REFERRAL_DAILY_CAP_MAX)
  .nullable();
