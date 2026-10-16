import { fireEvent, screen, within } from '@testing-library/react';
import { t, type WebKey } from '../../apps/web/src/i18n/web.fa';
import type { CustomerTab } from '../../apps/web/src/pages/customer-360';

/**
 * Customer 360 draws only the chosen tab (W2). A test about a card outside «نمای کلی» opens
 * that card's tab first, through the real tab button, once the customer has loaded.
 */
const TAB_LABELS: Readonly<Record<CustomerTab, WebKey>> = {
  overview: 'web.c360_tab_overview',
  services: 'web.c360_tab_services',
  support: 'web.c360_tab_support',
  financial: 'web.c360_tab_financial',
  controls: 'web.c360_tab_controls',
  relations: 'web.c360_tab_relations',
  messages: 'web.c360_tab_messages',
  crm: 'web.c360_tab_crm',
  timeline: 'web.c360_tab_timeline',
};

export async function openC360Tab(tab: CustomerTab): Promise<void> {
  fireEvent.click(await screen.findByRole('tab', { name: t(TAB_LABELS[tab]) }));
}

/**
 * W3: the wallet movement is a dialog. Opens the «مالی» tab and the dialog for one
 * direction from the wallet card's header; returns the dialog.
 */
export async function openWalletDialog(direction: 'CREDIT' | 'DEBIT'): Promise<HTMLElement> {
  const label = t(
    direction === 'CREDIT' ? 'web.c360_wallet_credit_open' : 'web.c360_wallet_debit_open',
  );
  if (screen.queryByRole('tab', { name: t('web.c360_tab_financial'), selected: true }) === null) {
    await openC360Tab('financial');
  }
  fireEvent.click(await screen.findByRole('button', { name: label }));
  return screen.getByRole('dialog', { name: label });
}

/** Presses the wallet dialog's own submit button. */
export function submitWalletDialog(dialog: HTMLElement, direction: 'CREDIT' | 'DEBIT'): void {
  fireEvent.click(
    within(dialog).getByRole('button', {
      name: t(direction === 'CREDIT' ? 'web.wallet_credit' : 'web.wallet_debit'),
    }),
  );
}
