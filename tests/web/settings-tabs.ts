import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { SettingKey } from '@nexa/contracts';
import { t } from '../../apps/web/src/i18n/web.fa';
import {
  SETTING_GROUP_TITLES,
  SETTING_PRESENTATION,
} from '../../apps/web/src/settings-presentation';

/**
 * The settings page shows one category at a time (a tab strip with counts), each a collapsible
 * section. A test that reaches a row outside the first group picks that category's tab first,
 * exactly as an operator does.
 */
export async function openSettingsGroupOf(key: SettingKey): Promise<void> {
  const title = t(SETTING_GROUP_TITLES[SETTING_PRESENTATION[key].group]);
  // Demo parity: one category is shown at a time; pick the key's category tab first.
  const tab = await waitFor(() => {
    const found = screen
      .getAllByRole('tab')
      .find((one) => (one.textContent ?? '').startsWith(title));
    if (found === undefined) throw new Error(`no settings category tab for ${key}`);
    return found;
  });
  if (tab.getAttribute('aria-selected') !== 'true') fireEvent.click(tab);
  // Owner ruling (demo parity): the section's title is a plain heading, not a second button
  // beside the tab strip, and its body is always open.
  await waitFor(() => {
    const found = [...document.querySelectorAll<HTMLElement>('.settings-section-head')].find(
      (one) => (one.textContent ?? '').startsWith(title),
    );
    if (found === undefined) throw new Error(`no settings section for ${key}`);
  });
  // R11: each setting is an accordion (the first starts open). A test that reads rows opens
  // them, as an operator would, before it looks inside one.
  for (const fold of document.querySelectorAll<HTMLDetailsElement>('details.set-fold')) {
    fold.open = true;
  }
}

/** Every group's section head, in order. */
export async function settingsTabs(): Promise<HTMLElement[]> {
  await screen.findByRole('heading', { name: t('web.settings_title') });
  await waitFor(() => {
    if (document.querySelectorAll('.settings-section-head').length === 0) {
      throw new Error('no settings section yet');
    }
  });
  return [...document.querySelectorAll<HTMLElement>('.settings-section-head')];
}
