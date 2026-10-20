import {
  LATE_CREDIT_WINDOW_SETTING_KEY,
  PAYMENT_GATEWAY_DESCRIPTORS,
  isSettingKey,
  type PaymentGatewayProvider,
  type TenantContext,
} from '@nexa/contracts';
import type { SettingsResolver } from '../../../control/settings/application/settings-resolver.js';
import type { LateCreditPolicy } from '../domain/late-credit.js';

const HOUR_MS = 3_600_000;

/**
 * R5A item 4: a route's late-credit policy from the settings registry — the switch its
 * descriptor names (`lateCreditSetting`) and the one window, in hours.
 *
 * What the gateway lane's SCHEDULING reads; the credit itself reads the switch again under the
 * payment's lock (`PaymentService.creditLateGatewayApproval`). A route that names no switch is
 * OFF, and so is a name the registry does not declare — a programming error that must never
 * turn a credit on.
 */
export function settingsLateCreditPolicy(
  settings: Pick<SettingsResolver, 'valueOf'>,
): (scope: TenantContext, provider: PaymentGatewayProvider) => Promise<LateCreditPolicy> {
  return async (scope, provider) => {
    const name = PAYMENT_GATEWAY_DESCRIPTORS[provider].lateCreditSetting;
    if (name === null || !isSettingKey(name)) return { enabled: false, windowMs: 0 };
    const enabled = await settings.valueOf<boolean>(scope, name);
    if (enabled !== true) return { enabled: false, windowMs: 0 };
    const hours = await settings.valueOf<number>(scope, LATE_CREDIT_WINDOW_SETTING_KEY);
    return { enabled: true, windowMs: hours * HOUR_MS };
  };
}
