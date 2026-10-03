/**
 * Legacy migration prerequisites (program Items 14 and 15).
 *
 * The vocabularies the two migration-only tables pin with CHECK constraints. Neither is a
 * customer-facing state and neither is an order, payment or service state: each records
 * what the migration DECIDED about one legacy fact, so an operator can read why.
 *
 * `docs/legacy-migration/hidden-legacy-products.md` and
 * `docs/legacy-migration/trial-eligibility.md` are the designs.
 */

/**
 * Whether a legacy product shape has a CURRENT NEXA tariff.
 *
 * `UNRESOLVED` is the explicit manual-review state the program requires: the shape has a
 * hidden product, the product is INACTIVE and unpriced, and a service of this shape is not
 * adoptable (P6) until it becomes `RESOLVED`. There is no third state that sells at a
 * guessed price.
 */
export const LEGACY_SHAPE_TARIFF_STATUSES = ['UNRESOLVED', 'RESOLVED'] as const;
export type LegacyShapeTariffStatus = (typeof LEGACY_SHAPE_TARIFF_STATUSES)[number];

/**
 * Why a shape is `UNRESOLVED`.
 *
 * - `NOT_YET_RESOLVED` — ensured, no resolution attempted.
 * - `NO_CURRENT_TARIFF` — no ACTIVE public product sells this traffic and duration now.
 * - `AMBIGUOUS_TARIFF` — several do, at different prices; choosing one would be a guess.
 */
export const LEGACY_SHAPE_UNRESOLVED_REASONS = [
  'NOT_YET_RESOLVED',
  'NO_CURRENT_TARIFF',
  'AMBIGUOUS_TARIFF',
] as const;
export type LegacyShapeUnresolvedReason = (typeof LEGACY_SHAPE_UNRESOLVED_REASONS)[number];

/**
 * How a `RESOLVED` shape got its tariff.
 *
 * - `MATCHED_PUBLIC_PRODUCT` — the one current public product with the same traffic and
 *   duration, at its price NOW.
 * - `OPERATOR_STATED` — an operator stated the current tariff for this shape, audited.
 *
 * Never the legacy invoice's `price_product`: that is a historical purchase snapshot, and
 * the owner decided renewals are at the current NEXA tariff.
 */
export const LEGACY_SHAPE_RESOLUTIONS = ['MATCHED_PUBLIC_PRODUCT', 'OPERATOR_STATED'] as const;
export type LegacyShapeResolution = (typeof LEGACY_SHAPE_RESOLUTIONS)[number];

/**
 * What the migration decided about one legacy customer's trial entitlement (Item 15).
 *
 * - `LEGACY_NO_TRIALS` — legacy `limit_usertest` was 0 (or negative): no trials, ever.
 * - `LEGACY_TRIAL_CONSUMED` — legacy allowed trials and the customer HAD one: consumed.
 * - `LEGACY_LIMIT_UNREADABLE` — the legacy limit was not a whole number: treated as no
 *   trials, because an unreadable entitlement is not evidence of an unused one.
 * - `INHERIT_NEXA_POLICY` — legacy allowed trials and there is no evidence one was used:
 *   no override is written, and NEXA's current policy applies exactly as to anyone.
 * - `KEPT_EXISTING_OVERRIDE` — the customer already had a NEXA override, an operator's
 *   decision newer than the archive: left untouched, never loosened or rewritten.
 */
export const LEGACY_TRIAL_DECISIONS = [
  'LEGACY_NO_TRIALS',
  'LEGACY_TRIAL_CONSUMED',
  'LEGACY_LIMIT_UNREADABLE',
  'INHERIT_NEXA_POLICY',
  'KEPT_EXISTING_OVERRIDE',
] as const;
export type LegacyTrialDecision = (typeof LEGACY_TRIAL_DECISIONS)[number];
