import { z } from 'zod';

/**
 * Discounts, referral, trial and reseller.
 *
 * ## Every commercial number in here is absent on purpose
 *
 * The research fixes no discount rate, no referral reward, no trial size and no
 * reseller credit limit, and `CLAUDE.md` forbids resolving an `UNKNOWN` by guessing.
 * The legacy system's own values are a competitor's commercial decisions and copying
 * them would be inventing this tenant's margin for them.
 *
 * So this file declares MECHANISMS and the shape of their configuration. Every one of
 * them is inert until a tenant configures it, and "inert" means the feature reports
 * itself unconfigured rather than applying a zero — a 0% discount silently applied is
 * indistinguishable from a broken discount engine.
 *
 * ## One enum per subsystem
 *
 * The legacy system reuses a single customer-tier enum across product visibility,
 * pricing, discount scoping, cashback and mass tools — "one enum, four subsystems" —
 * and the crossmap in the research is the bill for it. Nothing here is shared with
 * `catalog.ts`'s audience or with anything else.
 */

// ---------------------------------------------------------------------------
// Discounts
// ---------------------------------------------------------------------------

export const DISCOUNT_TYPES = ['PERCENTAGE', 'FIXED_AMOUNT'] as const;
export type DiscountType = (typeof DISCOUNT_TYPES)[number];
export const discountTypeSchema = z.enum(DISCOUNT_TYPES);

export const DISCOUNT_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type DiscountStatus = (typeof DISCOUNT_STATUSES)[number];
export const discountStatusSchema = z.enum(DISCOUNT_STATUSES);

/**
 * The code, as typed by a customer.
 *
 * Stored and compared in UPPER CASE, because a customer typing `summer` and a customer
 * typing `SUMMER` are the same customer with the same intent, and two rows differing
 * only in case would be two redemption counters. The normalisation is a function rather
 * than a convention so a repository cannot skip it.
 *
 * ASCII letters, digits, hyphen and underscore only. Not a style preference: a code is
 * read aloud, retyped from a screenshot and pasted from a channel, and a code containing
 * a Persian digit or a zero-width character is a support ticket.
 */
export const DISCOUNT_CODE_MIN_LENGTH = 3;
export const DISCOUNT_CODE_MAX_LENGTH = 40;

export const discountCodeSchema = z
  .string()
  .trim()
  .min(DISCOUNT_CODE_MIN_LENGTH)
  .max(DISCOUNT_CODE_MAX_LENGTH)
  .regex(/^[A-Za-z0-9_-]+$/, 'a discount code is ASCII letters, digits, hyphen or underscore')
  .transform((value) => value.toUpperCase());

export function normaliseDiscountCode(value: string): string {
  return value.trim().toUpperCase();
}

/** Percentage rates are whole percent. A fractional percent is a price, not a rate. */
export const DISCOUNT_PERCENTAGE_MIN = 1;
export const DISCOUNT_PERCENTAGE_MAX = 100;

/**
 * Applies a discount, in minor units, with no floating point anywhere.
 *
 * Integer arithmetic and truncation toward zero, which rounds in the CUSTOMER's favour
 * for a percentage off — the alternative rounds a tenant's revenue up by a unit and does
 * it on every order. `Math.round` on a float would be the obvious way to write this and
 * is exactly what `CLAUDE.md` forbids: `0.1 + 0.2` has no place near a price.
 *
 * The caller clamps the result against the subtotal (`clampDiscount`); this function
 * only computes the nominal amount, so the clamp is visible at the call site rather than
 * hidden in here.
 */
export function discountAmountMinor(
  type: DiscountType,
  subtotalMinor: bigint,
  /** Whole percent for PERCENTAGE; minor units for FIXED_AMOUNT. */
  value: bigint,
): bigint {
  if (subtotalMinor <= 0n || value <= 0n) return 0n;
  if (type === 'FIXED_AMOUNT') return value;
  if (value >= BigInt(DISCOUNT_PERCENTAGE_MAX)) return subtotalMinor;
  return (subtotalMinor * value) / 100n;
}

/**
 * Redemption limits.
 *
 * Null means unlimited, and a separate per-customer limit exists because "one hundred
 * uses" and "one use each" are different promotions that the legacy system's single
 * counter cannot express.
 */
export interface DiscountLimits {
  readonly totalRedemptions: number | null;
  readonly redemptionsPerCustomer: number | null;
  /** Orders below this subtotal are not eligible. Null for no floor. */
  readonly minimumSubtotalMinor: bigint | null;
}

// ---------------------------------------------------------------------------
// Referral
// ---------------------------------------------------------------------------

/**
 * When a referral pays out.
 *
 * Two policies, because the research describes both shapes and they have different
 * abuse profiles. `ON_SIGNUP` pays for an account, which is cheap to manufacture;
 * `ON_FIRST_PAID_ORDER` pays for a customer, which is not. Both are available and
 * neither is a default — the tenant chooses, and an unconfigured referral engine pays
 * nothing.
 */
export const REFERRAL_TRIGGERS = ['ON_SIGNUP', 'ON_FIRST_PAID_ORDER'] as const;
export type ReferralTrigger = (typeof REFERRAL_TRIGGERS)[number];
export const referralTriggerSchema = z.enum(REFERRAL_TRIGGERS);

export const REFERRAL_REWARD_TYPES = ['FIXED_AMOUNT', 'ORDER_PERCENTAGE'] as const;
export type ReferralRewardType = (typeof REFERRAL_REWARD_TYPES)[number];
export const referralRewardTypeSchema = z.enum(REFERRAL_REWARD_TYPES);

/**
 * The referral code a customer shares.
 *
 * Derived from the customer's own id rather than generated and stored, for the same
 * reason `operation.ts` derives an operation id: a derived value needs no row, cannot
 * drift, and two replicas computing it agree. It is also not guessable backwards into a
 * Telegram id, because the input is the internal UUID.
 *
 * Eight characters of Crockford-style base32 over the id's own bytes. Ambiguous glyphs
 * (I, L, O, U) are excluded because this string is retyped by humans from a chat.
 */
export const REFERRAL_CODE_LENGTH = 8;
export const REFERRAL_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function referralCodeFor(userId: string): string {
  const compact = userId.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(compact)) {
    throw new Error('a referral code is derived from a UUID user id');
  }
  // The LAST 64 bits, not the first: a UUIDv7 leads with a timestamp, so codes derived
  // from the front would share a prefix for everyone who joined the same millisecond —
  // and look to a customer as though they had been given somebody else's code.
  let value = BigInt(`0x${compact.slice(16)}`);
  let out = '';
  for (let i = 0; i < REFERRAL_CODE_LENGTH; i += 1) {
    out = REFERRAL_CODE_ALPHABET[Number(value % 32n)] + out;
    value /= 32n;
  }
  return out;
}

/**
 * Why a referral attribution was refused.
 *
 * Refusals are recorded rather than silently dropped, because "my friend used my code
 * and I got nothing" is a support conversation that needs an answer, and the answer is
 * usually one of these.
 */
export const REFERRAL_REJECTIONS = [
  'SELF_REFERRAL',
  'ALREADY_ATTRIBUTED',
  'CODE_UNKNOWN',
  'REFERRER_BLOCKED',
  'CIRCULAR',
] as const;
export type ReferralRejection = (typeof REFERRAL_REJECTIONS)[number];

// ---------------------------------------------------------------------------
// Trial
// ---------------------------------------------------------------------------

/**
 * Why a trial was refused.
 *
 * `UNCONFIGURED` is listed first because it is the state a tenant is in until they
 * choose a trial product, and the honest answer to a customer in that state is "this
 * installation does not offer a trial" — not a zero-traffic service that looks broken.
 *
 * Trial uniqueness uses the strongest identity Nexa legitimately has, which is
 * `(tenant_id, telegram_user_id)` — the same identity the customer row is keyed on.
 * Deliberately NOT the username, which is reassignable, and deliberately not an IP or a
 * device fingerprint, neither of which this installation collects.
 */
export const TRIAL_REJECTIONS = [
  'UNCONFIGURED',
  'ALREADY_TAKEN',
  'CUSTOMER_BLOCKED',
  'PRODUCT_UNAVAILABLE',
] as const;
export type TrialRejection = (typeof TRIAL_REJECTIONS)[number];

/**
 * One trial per customer per tenant, enforced by a partial unique index rather than a
 * count.
 *
 * A count is a read followed by a write, and two concurrent `/trial` commands both read
 * zero. `CLAUDE.md` records the same reasoning for the backup lease: "one at a time is a
 * partial unique index, not a process".
 */
export const TRIALS_PER_CUSTOMER = 1;

// ---------------------------------------------------------------------------
// Reseller
// ---------------------------------------------------------------------------

export const RESELLER_STATUSES = ['ACTIVE', 'SUSPENDED'] as const;
export type ResellerStatus = (typeof RESELLER_STATUSES)[number];
export const resellerStatusSchema = z.enum(RESELLER_STATUSES);

/**
 * How a reseller's price differs from the list price.
 *
 * A rate, never a price list. A second price list would have to be kept in step with the
 * first, and the legacy system's custom-pricing rules — no priority, no enabled flag, no
 * date scope, overlapping by design — are what that becomes.
 *
 * The rate itself is configuration. There is no default margin.
 */
export const RESELLER_PRICING_MODES = ['LIST_PRICE', 'PERCENTAGE_DISCOUNT'] as const;
export type ResellerPricingMode = (typeof RESELLER_PRICING_MODES)[number];
export const resellerPricingModeSchema = z.enum(RESELLER_PRICING_MODES);

/**
 * The credit line, in minor units, and its default.
 *
 * **Zero.** A reseller with no configured limit may not go below zero, which is
 * `WALLET_ALLOWS_NEGATIVE_BALANCE` expressed per customer. The owner's instruction says
 * a credit feature must default to no credit, and the reason is that the failure mode of
 * the other default is a tenant discovering it has extended unsecured credit to everyone
 * it ever marked a reseller.
 *
 * A limit is an ALLOWANCE below zero, stored positive: a limit of 5,000,000 means the
 * balance may reach -5,000,000. Storing it as a negative number would make every
 * comparison a double negative, and the first person to get that backwards grants
 * unlimited credit.
 */
export const RESELLER_DEFAULT_CREDIT_LIMIT_MINOR = 0n;
export const RESELLER_MAX_CREDIT_LIMIT_MINOR = 1_000_000_000_000n;

/**
 * Whether a debit is within a customer's means.
 *
 * One function, used by every debit path, so the reseller credit line cannot be a second
 * code path that forgets a check. An ordinary customer has a limit of zero, which makes
 * this the plain "no overdraft" rule with no branch.
 */
export function debitIsWithinMeans(
  balanceMinor: bigint,
  debitMinor: bigint,
  creditLimitMinor: bigint,
): boolean {
  if (debitMinor <= 0n) return false;
  const limit = creditLimitMinor < 0n ? 0n : creditLimitMinor;
  return balanceMinor - debitMinor >= -limit;
}
