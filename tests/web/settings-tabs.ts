import { fireEvent, screen, within } from '@testing-library/react';
import type { SettingKey } from '@nexa/contracts';
import { t } from '../../apps/web/src/i18n/web.fa';
import {
  SETTING_GROUP_TITLES,
  SETTING_PRESENTATION,
} from '../../apps/web/src/settings-presentation';

/**
 * W2: the settings page shows one group at a time, as tabs. A test that reaches a row
 * outside the first group opens that row's tab first, exactly as an operator does.
 */
export async function openSettingsGroupOf(key: SettingKey): Promise<void> {
  const tabs = await screen.findByRole('tablist', { name: t('web.ob_sections') });
  const title = t(SETTING_GROUP_TITLES[SETTING_PRESENTATION[key].group]);
  const tab = within(tabs)
    .getAllByRole('tab')
    .find((one) => (one.textContent ?? '').startsWith(title));
  if (tab === undefined) throw new Error(`no settings tab for ${key}`);
  fireEvent.click(tab);
}

/** Every group's tab, in order. */
export async function settingsTabs(): Promise<HTMLElement[]> {
  const tabs = await screen.findByRole('tablist', { name: t('web.ob_sections') });
  return within(tabs).getAllByRole('tab');
}
