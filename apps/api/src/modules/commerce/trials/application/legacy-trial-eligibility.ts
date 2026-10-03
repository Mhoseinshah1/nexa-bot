import { createHash } from 'node:crypto';
import type { LegacyTrialDecision, TenantContext, UserId } from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';

/**
 * Legacy trial-eligibility preservation (program Item 15,
 * `docs/legacy-migration/trial-eligibility.md`).
 *
 * The rule is pure and lives here; the service applies it under the customer's lock, and
 * the effect is an ordinary `trial_limit_overrides` row — the one input ADR-0015's
 * allowance evaluator already reads. There is no second trial subsystem and no second
 * evaluator: a migrated customer's claim is decided by `trialAllowanceFor` exactly like
 * anyone's.
 */

/** The two legacy facts, as Q2 of `docs/legacy-migration/sql-evidence.md` reads them. */
export interface LegacyTrialFacts {
  /** `user.limit_usertest` as the archive holds it. */
  readonly limitUsertest: string | number | null;
  /** Whether a test invoice (`invoice.is_test = 1`, any status) exists for the user. */
  readonly hadTrial: boolean;
}

export interface LegacyTrialVerdict {
  readonly decision: LegacyTrialDecision;
  /** The normalised legacy limit, or null when it was not a whole number. */
  readonly legacyLimit: number | null;
  /** The override the decision leaves: the existing one, 0, or none. */
  readonly overrideAfter: number | null;
}

/** The largest value `legacy_limit_usertest` (a PostgreSQL integer) can hold. */
const INT4_MAX = 2_147_483_647;

/** A whole number, possibly negative, or null. Nothing else is read as a limit. */
export function normaliseLegacyLimit(raw: string | number | null): number | null {
  if (raw === null) return null;
  const text = typeof raw === 'number' ? (Number.isInteger(raw) ? String(raw) : '') : raw.trim();
  if (!/^-?[0-9]{1,10}$/u.test(text)) return null;
  const value = Number(text);
  return Math.abs(value) > INT4_MAX ? null : value;
}

/**
 * What one legacy customer's trial entitlement becomes in NEXA. Conservative throughout:
 * every branch either preserves a restriction or defers to NEXA's current policy; none
 * grants more than NEXA would grant a customer with no history.
 *
 * In order:
 * 1. The customer already has a NEXA override — an operator's decision, newer than the
 *    archive. Kept exactly; the migration never loosens and never rewrites it.
 * 2. The legacy limit is not a whole number — an unreadable entitlement is not evidence
 *    of an unused one. No trials.
 * 3. The legacy limit is 0 (or negative) — the legacy bot said no trials. No trials.
 * 4. Legacy allowed trials and the customer HAD one — consumed, whatever the limit says
 *    (`limit_usertest = 1` is not evidence of an unused trial). No trials.
 * 5. Legacy allowed trials and there is no evidence one was used — no override; NEXA's
 *    current policy applies, exactly as it does to any customer who never had a trial.
 */
export function decideLegacyTrial(
  facts: LegacyTrialFacts,
  existingOverride: number | null,
): LegacyTrialVerdict {
  const legacyLimit = normaliseLegacyLimit(facts.limitUsertest);
  if (existingOverride !== null) {
    return { decision: 'KEPT_EXISTING_OVERRIDE', legacyLimit, overrideAfter: existingOverride };
  }
  if (legacyLimit === null) {
    return { decision: 'LEGACY_LIMIT_UNREADABLE', legacyLimit, overrideAfter: 0 };
  }
  if (legacyLimit <= 0) return { decision: 'LEGACY_NO_TRIALS', legacyLimit, overrideAfter: 0 };
  if (facts.hadTrial) return { decision: 'LEGACY_TRIAL_CONSUMED', legacyLimit, overrideAfter: 0 };
  return { decision: 'INHERIT_NEXA_POLICY', legacyLimit, overrideAfter: null };
}

/**
 * The identity of the legacy FACTS, not of the decision: a rerun bringing the same facts
 * is a replay even when the customer's override has changed since, and one bringing
 * different facts is a conflict.
 */
export function legacyTrialInputHash(facts: LegacyTrialFacts): string {
  const limit = normaliseLegacyLimit(facts.limitUsertest);
  return createHash('sha256')
    .update(
      `legacy-trial:v1:${limit === null ? 'unreadable' : String(limit)}:${facts.hadTrial ? 1 : 0}`,
    )
    .digest('hex');
}

/** One stored decision (`legacy_trial_eligibility`). */
export interface LegacyTrialRecord {
  readonly customerId: UserId;
  readonly legacyLimitUsertest: number | null;
  readonly legacyHadTrial: boolean;
  readonly decision: LegacyTrialDecision;
  readonly overrideBefore: number | null;
  readonly overrideAfter: number | null;
  readonly inputHash: string;
  readonly recordedAt: Date;
}

export interface LegacyTrialEligibilityRepository {
  find(
    scope: TenantContext,
    customerId: UserId,
    tx?: TransactionScope,
  ): Promise<LegacyTrialRecord | null>;
  /** Written once; the table refuses an UPDATE or a DELETE. */
  insert(
    scope: TenantContext,
    record: Omit<LegacyTrialRecord, 'recordedAt'>,
    now: Date,
    tx: TransactionScope,
  ): Promise<LegacyTrialRecord>;
}
