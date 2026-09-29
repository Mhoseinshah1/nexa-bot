import type {
  CurrencyCode,
  Money,
  ResellerMinimumSource,
  ResellerMinimumState,
  ResellerStatus,
} from '@nexa/contracts';

/**
 * The reseller monthly minimum (round N R2, `docs/round-n-reseller-audit.md` §3), stated once.
 *
 * TRACKING ONLY. Nothing here, and nothing that reads it, has a consequence for a reseller
 * below the minimum: no debt, fee, wallet debit, settlement, demotion, suspension or block.
 */

/**
 * The minimum that applies to a reseller, and where it comes from.
 *
 * The credit limit's own shape (R8): the reseller's own value, else the tier's. On the
 * reseller, NULL inherits and ZERO is an explicit "no minimum for this reseller"; on the
 * tier, null and zero both mean none. Whichever applies, zero is `NONE`.
 */
export function effectiveMonthlyMinimum(
  tier: Money | null,
  own: Money | null,
): { readonly minimum: Money | null; readonly source: ResellerMinimumSource } {
  const applies = own ?? tier;
  if (applies === null || applies.amountMinor <= 0n) {
    return { minimum: null, source: 'NONE' };
  }
  return { minimum: applies, source: own === null ? 'TIER' : 'RESELLER' };
}

/** 1,000,000%: past it the figure is a ceiling, never a wrapped or inexact number. */
const PROGRESS_CEILING_BASIS_POINTS = 100_000_000n;

export interface MinimumStanding {
  readonly state: ResellerMinimumState;
  /** `max(0, minimum − achieved)`, or null when no minimum applies. */
  readonly remaining: bigint | null;
  /** `floor(achieved × 10000 / minimum)` (above 100% allowed), or null when none applies. */
  readonly progressBasisPoints: number | null;
}

/**
 * Where a reseller stands against the minimum, given their month's sales IN THE MINIMUM'S
 * CURRENCY — sales in any other currency were never counted toward it (R8's rule for credit,
 * for the same reason: no rate anybody chose).
 *
 * A SUSPENDED reseller is an ordinary customer (R1): no minimum applies, whatever is set.
 * Integer arithmetic throughout, floored, so "100%" is never shown for a month one minor
 * unit short.
 */
export function minimumStanding(
  status: ResellerStatus,
  minimum: Money | null,
  achieved: bigint,
): MinimumStanding {
  if (status !== 'ACTIVE') return { state: 'NOT_ACTIVE', remaining: null, progressBasisPoints: null };
  if (minimum === null || minimum.amountMinor <= 0n) {
    return { state: 'NO_MINIMUM', remaining: null, progressBasisPoints: null };
  }
  const reached = achieved >= minimum.amountMinor;
  const basis = (achieved * 10_000n) / minimum.amountMinor;
  return {
    state: reached ? 'ACHIEVED' : 'BELOW',
    remaining: reached ? 0n : minimum.amountMinor - achieved,
    // Clamped to [0, PROGRESS_CEILING] only so the figure stays an exact JavaScript number.
    progressBasisPoints: Number(
      basis < 0n ? 0n : basis > PROGRESS_CEILING_BASIS_POINTS ? PROGRESS_CEILING_BASIS_POINTS : basis,
    ),
  };
}

/** One reseller's month's sales, per currency, as the shared reporting fragment answers. */
export type SalesByCurrency = ReadonlyMap<CurrencyCode, bigint>;
