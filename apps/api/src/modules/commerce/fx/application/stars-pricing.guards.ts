import {
  PAYMENT_GATEWAY_PROVIDERS,
  PAYMENT_GATEWAY_DESCRIPTORS,
  isSystemContext,
  parseUnitRatio,
  type PaymentGatewayProvider,
  type ScopeContext,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { SettingChangeGuard } from '../../../control/settings/application/settings.service.js';
import type { PaymentGatewayRepository } from '../../payments/application/gateway-ports.js';

/** The two keys these guards speak for, named once. */
export const STARS_PRICING_MODE_KEY = 'stars.pricing_mode';
export const STARS_PER_USDT_KEY = 'stars.per_usdt';

/**
 * `stars.pricing_mode` is RETIRED (spec §8, "Stars price from central FX only"): the Stars
 * route is priced by the central USDT quote and `stars.per_usdt`, and nothing reads the
 * mode. It stays declared so a value stored before the retirement keeps parsing, and this
 * guard refuses every CHANGE to it — a setting that changes nothing must not be writable,
 * or an operator (or an old Web Admin tab) could believe they had switched Stars back to a
 * manual rate. Writing the value already stored is not a change and is let through.
 */
export class StarsPricingModeGuard implements SettingChangeGuard {
  readonly key = STARS_PRICING_MODE_KEY;

  refuseChange(
    _scope: ScopeContext,
    change: { readonly from: unknown; readonly to: unknown },
  ): Promise<string | null> {
    if (change.from === change.to) return Promise.resolve(null);
    return Promise.resolve(
      'stars.pricing_mode is retired: the Telegram Stars route is always priced by the central ' +
        'exchange rate and stars.per_usdt. There is no manual Stars rate to switch to.',
    );
  }
}

/** The routes whose price depends on `stars.per_usdt`, read from their descriptors. */
const RATIO_ROUTES: readonly PaymentGatewayProvider[] = PAYMENT_GATEWAY_PROVIDERS.filter(
  (provider) => PAYMENT_GATEWAY_DESCRIPTORS[provider].conversion.unitRatioSetting === STARS_PER_USDT_KEY,
);

/**
 * `stars.per_usdt` cannot be cleared while a route priced by it is switched ON. Clearing it
 * would leave every new Stars attempt refused — the payment core's honest answer, but an
 * operator saving a blank field should be told before customers are. Decided on the route's
 * row read inside the setting write's transaction; the attempt decides again regardless.
 */
export class StarsPerUsdtGuard implements SettingChangeGuard {
  readonly key = STARS_PER_USDT_KEY;

  constructor(private readonly gateways: Pick<PaymentGatewayRepository, 'find'>) {}

  async refuseChange(
    scope: ScopeContext,
    change: { readonly from: unknown; readonly to: unknown },
    tx: TransactionScope,
  ): Promise<string | null> {
    if (typeof change.to === 'string' && parseUnitRatio(change.to) !== null) return null;
    if (isSystemContext(scope)) return null;
    for (const provider of RATIO_ROUTES) {
      const route = await this.gateways.find(scope, provider, tx);
      if (route?.status === 'ACTIVE') {
        return (
          'The Telegram Stars route is switched on and is priced by this ratio and the central ' +
          'exchange rate. Switch the route off before clearing it, or set a positive ratio.'
        );
      }
    }
    return null;
  }
}
