import { CARD_SWITCH_SETTING_KEYS, type TenantContext } from '@nexa/contracts';
import type { SettingsResolver } from '../../../control/settings/application/settings-resolver.js';
import type { CardSwitchLimits } from './card-switch-policy.js';

/**
 * R5C-1's three owner limits on a card switch, read once for both card-to-card lanes — the
 * manual switch (`CardSwitchService`) and, since R8 A2, the TonPays card change — so the two
 * can never read the bounds differently. Inside the caller's transaction when it passes one.
 */
export async function readCardSwitchLimits(
  settings: Pick<SettingsResolver, 'valueOf'>,
  scope: TenantContext,
  tx?: unknown,
): Promise<CardSwitchLimits> {
  const read = (
    key: (typeof CARD_SWITCH_SETTING_KEYS)[keyof typeof CARD_SWITCH_SETTING_KEYS],
  ): Promise<number> => settings.valueOf<number>(scope, key, tx);
  return {
    maxSwitches: await read(CARD_SWITCH_SETTING_KEYS.MAX_SWITCHES),
    cooldownSeconds: await read(CARD_SWITCH_SETTING_KEYS.COOLDOWN_SECONDS),
    maxDistinctCards: await read(CARD_SWITCH_SETTING_KEYS.MAX_DISTINCT_CARDS),
  };
}
