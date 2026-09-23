import type { TenantContext, UserId } from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { FeatureFlagResolver } from '../../../control/features/application/feature-flags.service.js';
import type { SettingsResolver } from '../../../control/settings/application/settings-resolver.js';
import type { TrialGrantRepository, TrialOverrideRepository } from './ports.js';

/**
 * One customer's trial allowance: ADR-0015's two numbers and what follows from them.
 *
 * `remaining` is derived and never stored. `effectiveLimit` is the override when there
 * is one — `0` included, which means no trials, never unlimited — and the global
 * `trial.limit_per_customer` otherwise.
 */
export interface TrialAllowance {
  readonly customerId: UserId;
  readonly featureEnabled: boolean;
  readonly globalLimit: number;
  readonly override: { readonly limit: number; readonly setAt: Date } | null;
  readonly effectiveLimit: number;
  readonly used: number;
  readonly remaining: number;
}

export interface TrialAllowanceDeps {
  readonly settings: SettingsResolver;
  readonly features: FeatureFlagResolver;
  readonly grants: Pick<TrialGrantRepository, 'countCounting'>;
  readonly overrides: Pick<TrialOverrideRepository, 'find'>;
}

/**
 * THE allowance evaluator (`docs/wp6-audit.md` B1). `TrialService` decides a claim with
 * it under the customer's row lock; the operator's view renders it outside one. There is
 * no second copy, so the screen and the decision cannot compute the limit differently —
 * only at different moments, which the lock is for.
 */
export async function trialAllowanceFor(
  deps: TrialAllowanceDeps,
  scope: TenantContext,
  customerId: UserId,
  tx?: TransactionScope,
): Promise<TrialAllowance> {
  const featureEnabled = await deps.features.isEnabled(scope, 'trials', tx);
  const globalLimit = await deps.settings.valueOf<number>(scope, 'trial.limit_per_customer', tx);
  const stored = await deps.overrides.find(scope, customerId, tx);
  const effectiveLimit = stored === null ? globalLimit : stored.limit;
  const used = await deps.grants.countCounting(scope, customerId, tx);
  return {
    customerId,
    featureEnabled,
    globalLimit,
    override: stored === null ? null : { limit: stored.limit, setAt: stored.setAt },
    effectiveLimit,
    used,
    remaining: Math.max(0, effectiveLimit - used),
  };
}
