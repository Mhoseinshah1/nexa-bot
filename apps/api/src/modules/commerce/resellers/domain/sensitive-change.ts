import {
  RESELLER_DEFAULT_CREDIT_LIMIT_MINOR,
  RESELLER_REASON_MAX_LENGTH,
  RESELLER_REASON_MIN_LENGTH,
  type Money,
  type ResellerStatus,
} from '@nexa/contracts';

/** The three reseller changes that need a written reason (OQ-V095-01, owner answer YES). */
export type SensitiveResellerChange = 'SUSPEND' | 'TIER_CHANGE' | 'CREDIT_CHANGE';

/**
 * Which sensitive changes a reseller update makes, against the row as stored.
 *
 * - SUSPEND: the reseller stops being ACTIVE (ACTIVE to anything else).
 * - TIER_CHANGE: a different tier. There is no "normal customer" tier and tiers are not
 *   ranked, so a demotion cannot be told from a promotion: every tier change is held to
 *   the stricter rule.
 * - CREDIT_CHANGE: a credit limit that differs from the stored one. Reseller credit was
 *   removed (the stored limit is always zero, `null` meaning no limit of its own), so this
 *   is any non-null limit other than zero; the write is still refused afterwards.
 */
export function sensitiveResellerChanges(
  before: { readonly status: ResellerStatus; readonly tierId: string },
  write: {
    readonly status: ResellerStatus;
    readonly tierId: string;
    readonly creditLimit: Money | null;
  },
): readonly SensitiveResellerChange[] {
  const found: SensitiveResellerChange[] = [];
  if (before.status === 'ACTIVE' && write.status !== 'ACTIVE') found.push('SUSPEND');
  if (before.tierId !== write.tierId) found.push('TIER_CHANGE');
  if (isCreditChange(write.creditLimit)) found.push('CREDIT_CHANGE');
  return found;
}

/** A limit other than zero or "none" is a change of the stored (always zero) credit limit. */
export function isCreditChange(limit: Money | null): boolean {
  return limit !== null && limit.amountMinor !== RESELLER_DEFAULT_CREDIT_LIMIT_MINOR;
}

/**
 * The reason, trimmed, when it is usable: `RESELLER_REASON_MIN_LENGTH` to
 * `RESELLER_REASON_MAX_LENGTH` characters (code points). Null otherwise.
 */
export function usableResellerReason(reason: string | undefined): string | null {
  if (reason === undefined) return null;
  const trimmed = reason.trim();
  const length = [...trimmed].length;
  return length >= RESELLER_REASON_MIN_LENGTH && length <= RESELLER_REASON_MAX_LENGTH
    ? trimmed
    : null;
}

/**
 * True when the update must be refused for want of a reason: it makes a sensitive change
 * and carries none that is usable. THE reason-required guard; the service calls only this.
 */
export function resellerReasonMissing(
  changes: readonly SensitiveResellerChange[],
  reason: string | undefined,
): boolean {
  return changes.length > 0 && usableResellerReason(reason) === null;
}
