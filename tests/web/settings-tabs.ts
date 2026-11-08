import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { SettingKey } from '@nexa/contracts';
import { t } from '../../apps/web/src/i18n/web.fa';
import {
  SETTING_GROUP_TITLES,
  SETTING_PRESENTATION,
} from '../../apps/web/src/settings-presentation';

/**
 * PR-7: the settings page is a list of collapsible sections, one per group (the first starts
 * open). A test that reaches a row outside the first group opens that row's section first,
 * exactly as an operator does.
 */
export async function openSettingsGroupOf(key: SettingKey): Promise<void> {
  const title = t(SETTING_GROUP_TITLES[SETTING_PRESENTATION[key].group]);
  const head = await waitFor(() => {
    const found = [
      ...document.querySelectorAll<HTMLButtonElement>('.settings-section-head button'),
    ].find((one) => (one.textContent ?? '').startsWith(title));
    if (found === undefined) throw new Error(`no settings section for ${key}`);
    return found;
  });
  if (head.getAttribute('aria-expanded') !== 'true') fireEvent.click(head);
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
    if (document.querySelectorAll('.settings-section-head button').length === 0) {
      throw new Error('no settings section yet');
    }
  });
  return [...document.querySelectorAll<HTMLElement>('.settings-section-head button')];
}
