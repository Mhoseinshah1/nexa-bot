import { fireEvent, screen, within } from '@testing-library/react';
import { t, type WebKey } from '../../apps/web/src/i18n/web.fa';

/** The reseller standing's tabs, by the key of their label. */
export const RESELLER_TABS = {
  profile: 'web.rs_tab_profile',
  pricing: 'web.rs_tab_pricing',
  credit: 'web.rs_tab_credit',
  expiry: 'web.rs_tab_expiry',
  products: 'web.rs_tab_products',
  danger: 'web.rs_tab_danger',
} as const satisfies Record<string, WebKey>;

/** Opens one tab of the reseller standing drawer. */
export async function openResellerTab(tab: keyof typeof RESELLER_TABS): Promise<void> {
  fireEvent.click(await screen.findByRole('tab', { name: t(RESELLER_TABS[tab]) }));
}

/**
 * Answers the reason dialog a sensitive reseller change opens (OQ-V095-01): types the reason
 * and confirms. Save of a suspension or a tier change does nothing until this is done.
 */
export async function confirmSensitiveReason(reason = 'دلیل آزمایشی'): Promise<void> {
  const dialog = await screen.findByRole('alertdialog', { name: t('web.rs_sensitive_title') });
  fireEvent.change(within(dialog).getByLabelText(t('web.rs_reason_label')), {
    target: { value: reason },
  });
  fireEvent.click(within(dialog).getByRole('button', { name: t('web.rs_sensitive_confirm') }));
}
