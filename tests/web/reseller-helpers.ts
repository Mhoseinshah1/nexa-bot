import { fireEvent, screen } from '@testing-library/react';
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
