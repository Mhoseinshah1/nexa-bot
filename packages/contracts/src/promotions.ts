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
 * Integer arithmetic, rounded UP to the minor unit, which is the CUSTOMER's favour for a
 * percentage off: a customer promised 10% off 1005 pays at most 90% of it, so the
 * discount is 101 and not 100. The alternative rounds a tenant's revenue up by a unit and
 * does it on every order. `Math.round` on a float would be the obvious way to write this
 * and is exactly what `CLAUDE.md` forbids: `0.1 + 0.2` has no place near a price.
 *
 * This docblock always said "the customer's favour" and the body used to truncate toward
 * zero — the opposite, a smaller discount. Nothing called it until WP8, so the fix
 * changed no observable behaviour; `docs/wp8-pricing-audit.md` P5 records it and
 * `promotions-rounding.test.ts` pins the boundary.
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
  return (subtotalMinor * value + 99n) / 100n;
}

/**
 * How a discount rule reaches an order (WP8, `docs/wp8-pricing-audit.md` P3).
 *
 * - `CODE` applies only when the customer enters its code. `code` is required.
 * - `AUTOMATIC` applies to every order it is eligible for, with no code. `code` is
 *   forbidden: a code nobody has to type is a label, and a label that looks like a code
 *   is an invitation to type it.
 *
 * The legacy per-user discount percent (UBR-004) is an `AUTOMATIC` rule scoped to one
 * customer, not a column on the customer: it then has a window, a priority and a place
 * in the trace like every other adjustment.
 */
export const DISCOUNT_KINDS = ['CODE', 'AUTOMATIC'] as const;
export type DiscountKind = (typeof DISCOUNT_KINDS)[number];
export const discountKindSchema = z.enum(DISCOUNT_KINDS);

/**
 * The order purposes a discount or a cashback rule may name.
 *
 * `ORDER_PURPOSES` minus `TRIAL`, spelled out rather than filtered so that a purpose
 * added to the order later is NOT discountable until somebody decides it is. A trial is
 * free; a discount on it is a discount of nothing, and cashback on it would be money
 * minted from a free order.
 *
 * `CUSTOM_SERVICE` was decided (Package D §6): a custom purchase is paid for, so a code,
 * an automatic rule and cashback may name it. Adding it widens nothing that exists — a
 * stored rule's `applies_to` does not name it until an operator says so.
 */
export const DISCOUNTABLE_PURPOSES = [
  'NEW_SERVICE',
  'RENEW',
  'ADD_TRAFFIC',
  'ADD_TIME',
  'CUSTOM_SERVICE',
  /*
   * WP-A5: extra users / devices follow the add-on commercial rules — a code, an automatic
   * rule and cashback may name it, exactly as they may name extra traffic or time. Adding
   * it widens nothing stored: no rule's `applies_to` names it until an operator says so.
   */
  'ADD_DEVICES',
  /*
   * WP-A6: a paid location change goes through the one pricing boundary like every other
   * commercial action, so a rule may name it — and none does until an operator says so.
   */
  'CHANGE_LOCATION',
] as const;
export type DiscountablePurpose = (typeof DISCOUNTABLE_PURPOSES)[number];
export const discountablePurposeSchema = z.enum(DISCOUNTABLE_PURPOSES);

export function isDiscountablePurpose(value: string): value is DiscountablePurpose {
  return (DISCOUNTABLE_PURPOSES as readonly string[]).includes(value);
}

/** The operator's name for a rule, and the trace's `ruleLabel`. */
export const DISCOUNT_LABEL_MAX_LENGTH = 80;

/**
 * Priority orders the candidates, higher first (P4). A bounded integer rather than a
 * free one so that "above everything" is a number an operator can actually type.
 */
export const DISCOUNT_PRIORITY_MIN = 0;
export const DISCOUNT_PRIORITY_MAX = 1000;

/**
 * Why a rule did not apply, for the operator and the audit trail — NEVER for the
 * customer.
 *
 * `bot.discount.rejected` is one message for every one of these, and its frozen
 * description says why: telling a customer that a code exists but is exhausted is an
 * oracle for guessing codes. So the customer-facing error is one code,
 * `DISCOUNT_CODE_REJECTED`, and this reason travels in its details, into the audit row
 * and to the operator's preview.
 *
 * `UNKNOWN_CODE` is the entered code matching no rule. `NOT_COMBINABLE` is a rule that
 * is eligible on its own and was skipped by the stacking rule (P4 step 3).
 */
export const DISCOUNT_REFUSAL_REASONS = [
  'UNKNOWN_CODE',
  'INACTIVE',
  'NOT_STARTED',
  'ENDED',
  'PURPOSE',
  'PRODUCT',
  'CATEGORY',
  'CUSTOMER',
  'FIRST_PURCHASE',
  'MINIMUM_SUBTOTAL',
  'CURRENCY',
  'TOTAL_LIMIT',
  'CUSTOMER_LIMIT',
  'NOT_COMBINABLE',
] as const;
export type DiscountRefusalReason = (typeof DISCOUNT_REFUSAL_REASONS)[number];
export const discountRefusalReasonSchema = z.enum(DISCOUNT_REFUSAL_REASONS);

/**
 * The window in which a customer's next plain message is read as a discount code.
 *
 * The same three ways out as `USERNAME_CAPTURE_CLOSE_REASONS` and
 * `RECEIPT_CAPTURE_CLOSE_REASONS`, for the same reason: a window is closed by the answer
 * it was opened for, by a newer window, or by its deadline, and by nothing else.
 */
export const DISCOUNT_CODE_CAPTURE_CLOSE_REASONS = ['RECEIVED', 'SUPERSEDED', 'EXPIRED'] as const;
export type DiscountCodeCaptureCloseReason = (typeof DISCOUNT_CODE_CAPTURE_CLOSE_REASONS)[number];

/**
 * How long a discount-code window stays open: `USERNAME_CAPTURE_TTL_MS`'s ten minutes,
 * because it is the same kind of question asked on the same summary.
 */
export const DISCOUNT_CODE_CAPTURE_TTL_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Cashback
// ---------------------------------------------------------------------------

/**
 * Cashback is NOT a discount (WP8 P8).
 *
 * It never changes what the customer pays, so it is not a step in `PRICING_PRECEDENCE`;
 * it is a promise recorded beside the quote and honoured as a wallet credit once the
 * order is delivered. Its own rule table, its own states and its own ledger reasons, so
 * that no reader can confuse "money taken off the price" with "money given back later".
 */
export const CASHBACK_RULE_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type CashbackRuleStatus = (typeof CASHBACK_RULE_STATUSES)[number];
export const cashbackRuleStatusSchema = z.enum(CASHBACK_RULE_STATUSES);

export const CASHBACK_PERCENT_MIN = 1;
export const CASHBACK_PERCENT_MAX = 100;

/**
 * An order's cashback, once confirmed.
 *
 * - `PENDING` — promised in the quote the customer confirmed; nothing credited.
 * - `EARNED` — the order was delivered and the credit written. Later refunds reverse it
 *   proportionally; the row stays `EARNED` and the reversals are their own rows.
 * - `VOID` — the order ended without delivery (cancelled, expired or refunded), so the
 *   promise lapsed with nothing ever credited.
 *
 * `EARNED` and `VOID` are terminal. There is no `REVERSED`: a reversal is a second
 * movement, not an erasure of the first, exactly as a refund does not un-settle an order.
 */
export const CASHBACK_STATES = ['PENDING', 'EARNED', 'VOID'] as const;
export type CashbackState = (typeof CASHBACK_STATES)[number];
export const cashbackStateSchema = z.enum(CASHBACK_STATES);

/**
 * The cashback on a basis, rounded DOWN.
 *
 * A stated percentage is a ceiling on what is credited: rounding up would credit a unit
 * the rule never promised, on every order. The opposite choice to
 * `discountAmountMinor`, and deliberately so — both round in the direction that keeps the
 * stated percentage true from the customer's side and never costs the tenant more than it
 * said.
 */
export function cashbackAmountMinor(basisMinor: bigint, percent: number): bigint {
  if (basisMinor <= 0n || percent <= 0) return 0n;
  if (percent >= CASHBACK_PERCENT_MAX) return basisMinor;
  return (basisMinor * BigInt(percent)) / 100n;
}

/**
 * What an order's cashback is WORTH once some of its payment has gone back.
 *
 * `floor(promised × (paid − refunded) / paid)`, from the CUMULATIVE refunded amount and
 * never per refund, so a series of partial refunds cannot drift from the answer a single
 * full refund gives: at `refunded = paid` it is exactly zero, and the reversals recorded
 * along the way add up to exactly what was earned. P5 and P9.
 */
export function proportionalTargetMinor(
  promisedMinor: bigint,
  paidMinor: bigint,
  refundedMinor: bigint,
): bigint {
  if (promisedMinor <= 0n || paidMinor <= 0n) return 0n;
  const kept = paidMinor - refundedMinor;
  if (kept <= 0n) return 0n;
  if (kept >= paidMinor) return promisedMinor;
  return (promisedMinor * kept) / paidMinor;
}

/**
 * The name WP8 gave `proportionalTargetMinor`, kept so nothing that imports it moves.
 *
 * The arithmetic is not cashback's: a referral commission is reversed by exactly the same
 * cumulative formula (`docs/wp9-referral-audit.md` F1), and a second copy of it would be
 * a second answer to "how much of this is still owed".
 */
export const cashbackTargetMinor = proportionalTargetMinor;

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
 * When a referral pays out, as snapshotted onto the attribution.
 *
 * `ON_SIGNUP` pays for an account, which is cheap to manufacture, and is DECLARED ONLY:
 * nothing produces it, because a signup reward is a credit for a button click and the
 * owner's plan forbids exactly that (`docs/wp9-referral-audit.md` F5).
 * `ON_FIRST_PAID_ORDER` and `ON_EVERY_PAID_ORDER` are the two commission scopes
 * (`REFERRAL_COMMISSION_SCOPES`), recorded on the referral at attribution so a later
 * change to the setting governs only people referred afterwards.
 */
export const REFERRAL_TRIGGERS = [
  'ON_SIGNUP',
  'ON_FIRST_PAID_ORDER',
  'ON_EVERY_PAID_ORDER',
] as const;
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
  // WP9. Attribution happens on the update that CREATES the referee and nowhere else
  // (`docs/wp9-referral-audit.md` F2): a customer who already exists is never claimed by
  // whoever sends them a link first.
  'ALREADY_REGISTERED',
  // The tenant is not running a referral program (F4). A link followed then is recorded
  // as refused, not remembered for later: the program's terms did not exist yet.
  'PROGRAM_INACTIVE',
] as const;
export type ReferralRejection = (typeof REFERRAL_REJECTIONS)[number];
export const referralRejectionSchema = z.enum(REFERRAL_REJECTIONS);

/**
 * How a referral link carries its code: `/start ref-<CODE>`.
 *
 * A prefix, because `/start` carries other payloads and will carry more, and a bare
 * eight-character payload would be a referral code by accident. Hyphen, not underscore:
 * both are legal in a Telegram start parameter, and the hyphen is the one a customer
 * copying the code by eye does not mistake for a space.
 */
export const REFERRAL_START_PREFIX = 'ref-';

export function referralStartPayload(code: string): string {
  return `${REFERRAL_START_PREFIX}${code}`;
}

const REFERRAL_CODE_PATTERN = new RegExp(`^[${REFERRAL_CODE_ALPHABET}]{${REFERRAL_CODE_LENGTH}}$`);

/**
 * The code in a `/start` payload, or null when the payload is not a referral.
 *
 * Case-insensitive, because a code retyped from a screenshot is retyped in whatever case
 * the keyboard was in, and the alphabet has no letter whose lower case means something
 * else. Null for anything else — the caller treats a payload it does not recognise as no
 * payload, which is what a `/start` with no referral is.
 */
export function referralCodeFromStartPayload(payload: string): string | null {
  if (!payload.toLowerCase().startsWith(REFERRAL_START_PREFIX)) return null;
  const code = payload.slice(REFERRAL_START_PREFIX.length).toUpperCase();
  return REFERRAL_CODE_PATTERN.test(code) ? code : null;
}

/**
 * How many of a referee's paid orders pay their referrer (WP9 F5).
 *
 * `FIRST_PAID_ORDER` is the default and the bounded one: one referral, one commission,
 * whatever the referee does afterwards. `EVERY_PAID_ORDER` is a standing share of a
 * customer's spend and has to be chosen.
 */
export const REFERRAL_COMMISSION_SCOPES = ['FIRST_PAID_ORDER', 'EVERY_PAID_ORDER'] as const;
export type ReferralCommissionScope = (typeof REFERRAL_COMMISSION_SCOPES)[number];
export const referralCommissionScopeSchema = z.enum(REFERRAL_COMMISSION_SCOPES);

/** The trigger a scope is snapshotted as on the attribution. */
export function referralTriggerFor(scope: ReferralCommissionScope): ReferralTrigger {
  return scope === 'FIRST_PAID_ORDER' ? 'ON_FIRST_PAID_ORDER' : 'ON_EVERY_PAID_ORDER';
}

/** The scope an attribution's trigger means. `ON_SIGNUP` is never produced (F5). */
export function referralScopeOf(trigger: ReferralTrigger): ReferralCommissionScope | null {
  if (trigger === 'ON_FIRST_PAID_ORDER') return 'FIRST_PAID_ORDER';
  if (trigger === 'ON_EVERY_PAID_ORDER') return 'EVERY_PAID_ORDER';
  return null;
}

export const REFERRAL_COMMISSION_PERCENT_MIN = 1;
export const REFERRAL_COMMISSION_PERCENT_MAX = 100;

/**
 * An order's referral commission, once confirmed.
 *
 * The same three states as cashback and for the same reasons: `EARNED` and `VOID` are
 * terminal, and a refund that reverses an earned commission is its own row, never an
 * erasure of the credit.
 */
export const REFERRAL_COMMISSION_STATES = ['PENDING', 'EARNED', 'VOID'] as const;
export type ReferralCommissionState = (typeof REFERRAL_COMMISSION_STATES)[number];
export const referralCommissionStateSchema = z.enum(REFERRAL_COMMISSION_STATES);

/**
 * The commission on a basis, rounded DOWN, for the reason cashback rounds down: a stated
 * percentage is a ceiling on what is credited, and rounding up would pay a unit the
 * program never promised on every order.
 */
export function referralCommissionMinor(basisMinor: bigint, percent: number): bigint {
  if (basisMinor <= 0n || percent <= 0) return 0n;
  if (percent >= REFERRAL_COMMISSION_PERCENT_MAX) return basisMinor;
  return (basisMinor * BigInt(percent)) / 100n;
}

// ---------------------------------------------------------------------------
// Trial
// ---------------------------------------------------------------------------

/**
 * Why a trial was refused.
 *
 * `UNCONFIGURED` is listed first because it is the state a tenant is in until they
 * enable a trial on at least one panel (F5: there is no flag in front of it any more),
 * and the honest answer to a customer in that state is "this installation does not
 * offer a trial" — not a zero-traffic service that looks broken.
 *
 * `LIMIT_REACHED` was `ALREADY_TAKEN`, renamed before anything consumed it. ADR-0015
 * makes a trial allowance a LIMIT with a separate USED count, so a customer can be
 * allowed more than one and the refusal is about the limit, not about a first trial.
 *
 * Trial accounting uses the strongest identity Nexa legitimately has, the customer
 * row keyed on `(tenant_id, telegram_user_id)`. Deliberately NOT the username, which
 * is reassignable, and deliberately not an IP or a device fingerprint, neither of which
 * this installation collects.
 *
 * `TRIALS_PER_CUSTOMER = 1` used to sit below this. It said "one, ever", which ADR-0015
 * — accepted product policy — does not, and nothing read it; it was removed with the
 * unique index that enforced it. `docs/wp6-audit.md` A3.
 */
export const TRIAL_REJECTIONS = [
  'UNCONFIGURED',
  'LIMIT_REACHED',
  'CUSTOMER_BLOCKED',
  'PRODUCT_UNAVAILABLE',
] as const;
export type TrialRejection = (typeof TRIAL_REJECTIONS)[number];
export const trialRejectionSchema = z.enum(TRIAL_REJECTIONS);

/**
 * The bounds on `trial.limit_per_customer`.
 *
 * Zero is a legal value and means ZERO trials, never unlimited (ADR-0015). The upper
 * bound is a sanity ceiling, not a product number: a limit an operator can set to a
 * million is a limit indistinguishable from none, and "unlimited" would have to be its
 * own explicit policy state if anyone ever asks for it.
 */
export const TRIAL_LIMIT_MIN = 0;
export const TRIAL_LIMIT_MAX = 100;

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
 * The ONLY reseller credit limit there is: zero.
 *
 * **Owner decision (2026-10-01): no reseller debt and no credit purchases.** WP9-B R8 let an
 * ACTIVE reseller's wallet purchase take the balance down to a configured limit below zero.
 * The owner removed it (`docs/reseller-phase3-closure.md` §5). A wallet purchase now needs
 * the whole amount, for a reseller exactly as for any customer
 * (`WALLET_ALLOWS_NEGATIVE_BALANCE` is `false`), and every reseller write refuses a credit
 * limit other than this one, except the idempotent replay of a command that committed
 * before the decision (`RESELLER_MAX_CREDIT_LIMIT_MINOR`).
 *
 * The `credit_limit_*` columns stay. Migration `0153_reseller_credit_removed` set every
 * stored limit to zero (a tier) or null (a reseller), so a replica from before the decision,
 * still serving during a rolling update, also computes no credit. A balance that is
 * already negative is a legacy debt, left exactly as it is — never collected, never
 * touched — and repaid only by the same top-ups and credits as any balance.
 */
export const RESELLER_DEFAULT_CREDIT_LIMIT_MINOR = 0n;

/**
 * The largest limit a client from before the decision could send. Kept ONLY so such a
 * request still parses and reaches the service's idempotent replay: a command that
 * committed before the upgrade and lost its response must replay its original result
 * rather than be refused by the schema. The service refuses any non-zero limit that is
 * not a replay (`COMMERCE_REQUEST_INVALID`), so nothing above zero is ever stored again.
 */
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

// ---------------------------------------------------------------------------
// Reseller tiers, overrides and entitlements (WP9-B, `docs/wp9-reseller-audit.md`)
// ---------------------------------------------------------------------------

/**
 * How a reseller's OWN row prices, over its tier (R3).
 *
 * `TIER` is "no override": the tier's policy applies. `LIST_PRICE` and
 * `PERCENTAGE_DISCOUNT` REPLACE the tier's policy for this one reseller. A tier itself is
 * priced by `RESELLER_PRICING_MODES`, which has no `TIER`: a tier has nothing above it.
 */
export const RESELLER_OVERRIDE_MODES = ['TIER', 'LIST_PRICE', 'PERCENTAGE_DISCOUNT'] as const;
export type ResellerOverrideMode = (typeof RESELLER_OVERRIDE_MODES)[number];
export const resellerOverrideModeSchema = z.enum(RESELLER_OVERRIDE_MODES);

/**
 * What a tier may grant (R5). Deny by default, per kind: a kind with no grant row grants
 * nothing, and a grant row with no subject grants every subject of its kind.
 *
 * `PRODUCT` and `CATEGORY` together are one dimension — a product is granted when it or its
 * category is. The others are each their own.
 */
export const RESELLER_GRANT_KINDS = ['PRODUCT', 'CATEGORY', 'PANEL', 'BOT', 'OPERATION'] as const;
export type ResellerGrantKind = (typeof RESELLER_GRANT_KINDS)[number];
export const resellerGrantKindSchema = z.enum(RESELLER_GRANT_KINDS);

/**
 * The operations a tier can grant: every CATALOGUE purpose a customer pays for. A trial is
 * not a commercial action and is never a reseller's to be granted or refused.
 *
 * Spelled out rather than equal to `DISCOUNTABLE_PURPOSES`, since Package D: a custom
 * service is not in the catalogue a grant scopes, and a reseller's access to one is the
 * custom-service price rules written for their tier (`docs/package-d-custom-service-audit.md`
 * §7). Deriving this would have widened `reseller_tier_grants_subject_check` with a grant
 * nothing reads.
 */
export const RESELLER_GRANTABLE_OPERATIONS = [
  'NEW_SERVICE',
  'RENEW',
  'ADD_TRAFFIC',
  'ADD_TIME',
  /*
   * WP-A5. Grantable like the other add-ons, and deny-by-default like every operation: a
   * reseller buys extra users only when their tier's grants name it.
   */
  'ADD_DEVICES',
  // WP-A6. Deny-by-default: a reseller moves a service only when their tier grants it.
  'CHANGE_LOCATION',
] as const satisfies readonly DiscountablePurpose[];

/** The dimension an entitlement refusal names, for the audit row and the operator. */
export const RESELLER_ENTITLEMENT_DIMENSIONS = ['OPERATION', 'CATALOGUE', 'PANEL', 'BOT'] as const;
export type ResellerEntitlementDimension = (typeof RESELLER_ENTITLEMENT_DIMENSIONS)[number];

// ---------------------------------------------------------------------------
// Round N, package D: per-reseller entitlement overrides and the monthly minimum
// (`docs/round-n-reseller-audit.md`)
// ---------------------------------------------------------------------------

/**
 * The dimension each grant kind belongs to — the unit a reseller's own row overrides (R1).
 *
 * An override REPLACES the tier's grants of a whole DIMENSION, never of one kind: `PRODUCT`
 * and `CATEGORY` are one dimension, so an override naming only products must not leave the
 * tier's "every category" standing beside it and keep everything it meant to narrow.
 */
export const RESELLER_GRANT_DIMENSION: Readonly<
  Record<ResellerGrantKind, ResellerEntitlementDimension>
> = {
  OPERATION: 'OPERATION',
  PRODUCT: 'CATALOGUE',
  CATEGORY: 'CATALOGUE',
  PANEL: 'PANEL',
  BOT: 'BOT',
};

/** A monthly minimum's sanity ceiling, the credit limit's: a policy, not a product number. */
export const RESELLER_MONTHLY_MINIMUM_MAX_MINOR = 1_000_000_000_000n;

/**
 * Where a reseller's effective monthly minimum comes from (R2): the reseller's own row, else
 * the tier's; `NONE` when the one that applies is absent or zero.
 */
export const RESELLER_MINIMUM_SOURCES = ['RESELLER', 'TIER', 'NONE'] as const;
export type ResellerMinimumSource = (typeof RESELLER_MINIMUM_SOURCES)[number];

/**
 * A reseller's standing against the monthly minimum in one period. Reporting only: none of
 * these states has a consequence — no debt, fee, debit, settlement, demotion or block.
 * `NOT_ACTIVE` is a SUSPENDED reseller, an ordinary customer to whom no minimum applies (R1).
 */
export const RESELLER_MINIMUM_STATES = ['ACHIEVED', 'BELOW', 'NO_MINIMUM', 'NOT_ACTIVE'] as const;
export type ResellerMinimumState = (typeof RESELLER_MINIMUM_STATES)[number];

/** The two things the lane may tell a reseller about a month: at most one of each per month. */
export const RESELLER_MINIMUM_NOTICE_KINDS = ['REMINDER', 'ACHIEVED'] as const;
export type ResellerMinimumNoticeKind = (typeof RESELLER_MINIMUM_NOTICE_KINDS)[number];

/**
 * How many local days before the month ends the reminder goes out. Three is Mirza's VERIFIED
 * value (`📊 کف خرید ماهانه نمایندگی`, RGS/MASTER.md); one to ten.
 */
export const RESELLER_MINIMUM_REMINDER_DAYS_DEFAULT = 3;
export const RESELLER_MINIMUM_REMINDER_DAYS_MIN = 1;
export const RESELLER_MINIMUM_REMINDER_DAYS_MAX = 10;

/**
 * Which pricing layer set a reseller's price (R3, R9).
 *
 * `LIST` — neither the tier nor an override changed the list price. `TIER` — the tier's
 * percentage. `OVERRIDE` — the reseller's own policy, which may itself be the list price.
 */
export const RESELLER_PRICE_LAYERS = ['LIST', 'TIER', 'OVERRIDE'] as const;
export type ResellerPriceLayer = (typeof RESELLER_PRICE_LAYERS)[number];
export const resellerPriceLayerSchema = z.enum(RESELLER_PRICE_LAYERS);

export const RESELLER_TIER_NAME_MAX = 64;
/** A tier's grants, bounded: a grant list is a policy, not a catalogue export. */
export const RESELLER_TIER_GRANTS_MAX = 500;

/** A pricing policy: a mode and, for `PERCENTAGE_DISCOUNT` only, a whole percent 1–100. */
export interface ResellerPricingPolicy {
  readonly mode: ResellerPricingMode;
  readonly percent: number | null;
}

/**
 * The layer that prices a reseller, and its percent (R3). ONE statement of inheritance.
 *
 * The override REPLACES the tier, so at most one of the two ever applies. `percent` is null
 * when the layer charges the list price.
 */
export function resellerPriceLayer(
  tier: ResellerPricingPolicy,
  override: { readonly mode: ResellerOverrideMode; readonly percent: number | null },
): { readonly layer: ResellerPriceLayer; readonly percent: number | null } {
  if (override.mode === 'TIER') {
    return tier.mode === 'PERCENTAGE_DISCOUNT' && tier.percent !== null
      ? { layer: 'TIER', percent: tier.percent }
      : { layer: 'LIST', percent: null };
  }
  return {
    layer: 'OVERRIDE',
    percent:
      override.mode === 'PERCENTAGE_DISCOUNT' && override.percent !== null
        ? override.percent
        : null,
  };
}

/**
 * What a reseller layer takes off a subtotal: the discount engine's own percentage, so a
 * reseller rounds exactly as a customer discount does — up, in the buyer's favour — and
 * the codebase has one rounding rule rather than two.
 *
 * **Never down to zero.** A positive subtotal keeps at least one minor unit: the
 * reduction is `min(computed, subtotal − 1)`. A reseller cost of zero is an order nobody
 * can pay — `payments_amount_check` and `wallet_entries_amount_check` refuse a zero
 * amount, so the settlement fails after the customer confirmed — and it is reachable two
 * ways: a 100% rate, which the write schemas no longer accept but the database still
 * stores, and the upward rounding on a tiny subtotal (1 minor unit at 1% rounds its
 * reduction up to 1). The floor is here, in the one function both the pricing layer and
 * the confirmation's re-derivation call, so the two cannot disagree about it.
 */
export function resellerReductionMinor(subtotalMinor: bigint, percent: number | null): bigint {
  if (percent === null || subtotalMinor <= 0n) return 0n;
  const computed = discountAmountMinor('PERCENTAGE', subtotalMinor, BigInt(percent));
  const ceiling = subtotalMinor - 1n;
  return computed < ceiling ? computed : ceiling;
}
