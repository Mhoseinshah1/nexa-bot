import {
  LATE_CREDIT_WINDOW_SETTING_KEY,
  PAYMENT_GATEWAY_DESCRIPTORS,
  isSettingKey,
  latePaymentPolicyOf,
  type LatePaymentPolicy,
  type PaymentGatewayProvider,
  type ScopeContext,
  type TenantContext,
} from '@nexa/contracts';
import type { SettingsResolver } from '../../../control/settings/application/settings-resolver.js';
import type { LateCreditPolicy } from '../domain/late-credit.js';

const HOUR_MS = 3_600_000;

/**
 * NEXA-OWNER-BATCH-1 PR-5: THE resolver of a route's late-payment policy — `WALLET`, `REVIEW`
 * or `DELIVER` — from the setting its descriptor names (`lateCreditSetting`). Every late path
 * of every route reads it through here: the lane's scheduling and its choice between delivery
 * and credit, the credit's own gate under the payment's lock, and the delivery's.
 *
 * Null for a route that names no setting (Stars, card-to-card and every other route that keeps
 * its own rule). A name the registry does not declare, or a stored value that is not one of the
 * three, is `REVIEW` — the one policy that moves no money by itself.
 */
export async function resolveLatePaymentPolicy(
  settings: Pick<SettingsResolver, 'valueOf'>,
  scope: ScopeContext,
  provider: PaymentGatewayProvider,
  tx?: unknown,
): Promise<LatePaymentPolicy | null> {
  const name = PAYMENT_GATEWAY_DESCRIPTORS[provider].lateCreditSetting;
  if (name === null) return null;
  if (!isSettingKey(name)) return 'REVIEW';
  return latePaymentPolicyOf(await settings.valueOf<unknown>(scope, name, tx));
}

/** Whether a policy asks the provider about a closed payment after its deadline. */
export function latePolicyPolls(policy: LatePaymentPolicy | null): boolean {
  return policy === 'WALLET' || policy === 'DELIVER';
}

/**
 * R5A item 4: a route's late-credit SCHEDULING policy from the settings registry — whether the
 * late poll runs (the policy is `WALLET` or `DELIVER`) and the one window, in hours.
 *
 * What the gateway lane's SCHEDULING reads; the credit and the delivery read the policy again
 * under the payment's lock. A route that names no setting is OFF, and so is `REVIEW`.
 */
export function settingsLateCreditPolicy(
  settings: Pick<SettingsResolver, 'valueOf'>,
): (scope: TenantContext, provider: PaymentGatewayProvider) => Promise<LateCreditPolicy> {
  return async (scope, provider) => {
    const policy = await resolveLatePaymentPolicy(settings, scope, provider);
    if (!latePolicyPolls(policy)) return { enabled: false, windowMs: 0 };
    const hours = await settings.valueOf<number>(scope, LATE_CREDIT_WINDOW_SETTING_KEY);
    return { enabled: true, windowMs: hours * HOUR_MS };
  };
}
