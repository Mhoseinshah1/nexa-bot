import { parseUnitRatio, type ScopeContext } from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { FeatureFlagResolver } from '../../../control/features/application/feature-flags.service.js';
import type { SettingChangeGuard } from '../../../control/settings/application/settings.service.js';
import type { SettingsResolver } from '../../../control/settings/application/settings-resolver.js';
import { CENTRAL_FX_FLAG } from './fx.service.js';

/** The two keys these guards speak for, named once. */
export const STARS_PRICING_MODE_KEY = 'stars.pricing_mode';
export const STARS_PER_USDT_KEY = 'stars.per_usdt';

/**
 * `stars.pricing_mode` cannot be switched to the central rate while nothing could price
 * a Star by it (package FX-STARS).
 *
 * Both reads happen inside the setting write's transaction. The refusal is a courtesy:
 * the payment core decides again, authoritatively, in the transaction that opens an
 * attempt — a mode switched on with no ratio, or with the feature off, refuses the
 * attempt with `FX_UNAVAILABLE` rather than pricing it by anything else. So this guard
 * stops the operator where the mistake is still cheap, and never widens what the core
 * accepts.
 */
export class StarsPricingModeGuard implements SettingChangeGuard {
  readonly key = STARS_PRICING_MODE_KEY;

  constructor(
    private readonly features: Pick<FeatureFlagResolver, 'isEnabled'>,
    private readonly settings: Pick<SettingsResolver, 'valueOf'>,
  ) {}

  async refuseChange(
    scope: ScopeContext,
    change: { readonly from: unknown; readonly to: unknown },
    tx: TransactionScope,
  ): Promise<string | null> {
    if (change.to !== 'CENTRAL_FX_RATIO') return null;
    if (!(await this.features.isEnabled(scope, CENTRAL_FX_FLAG, tx))) {
      return (
        'The Stars route can only be priced by the central exchange rate while the central_fx ' +
        'feature is on. Turn the feature on first; until then the route keeps its fixed rate.'
      );
    }
    const ratio = await this.settings.valueOf<string>(scope, STARS_PER_USDT_KEY, tx);
    if (parseUnitRatio(ratio) === null) {
      return (
        'The Stars route can only be priced by the central exchange rate once stars.per_usdt ' +
        'holds a positive ratio. Set how many Stars one USDT buys first.'
      );
    }
    return null;
  }
}

/**
 * `stars.per_usdt` cannot be cleared while the Stars route is priced by it. Clearing it
 * would leave the mode pointing at a ratio that does not exist, and every new Stars
 * attempt refused — the payment core's honest answer, but an operator saving a blank
 * field should be told before customers are.
 */
export class StarsPerUsdtGuard implements SettingChangeGuard {
  readonly key = STARS_PER_USDT_KEY;

  constructor(private readonly settings: Pick<SettingsResolver, 'valueOf'>) {}

  async refuseChange(
    scope: ScopeContext,
    change: { readonly from: unknown; readonly to: unknown },
    tx: TransactionScope,
  ): Promise<string | null> {
    if (typeof change.to === 'string' && parseUnitRatio(change.to) !== null) return null;
    const mode = await this.settings.valueOf<string>(scope, STARS_PRICING_MODE_KEY, tx);
    if (mode !== 'CENTRAL_FX_RATIO') return null;
    return (
      'The Stars route is priced by the central exchange rate and this ratio. Switch ' +
      'stars.pricing_mode back to FIXED_RATE before clearing it, or set a positive ratio.'
    );
  }
}
