import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { ResellerWebPanelCard } from '../../apps/web/src/pages/reseller-web-panel';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';

/**
 * The Web Admin's reseller drawer: «پنل وب: آخرین ورود …» and «خروج اجباری از همهٔ دستگاه‌ها»
 * (a reason is required; the key travels with it).
 */
const SUMMARY = '/resellers/cust-1/web-panel';

afterEach(() => vi.unstubAllGlobals());

describe('the reseller drawer’s «پنل وب» card', () => {
  it('shows the last sign-in, the open sessions and the 2FA state', async () => {
    stubApi([
      {
        url: SUMMARY,
        method: 'GET',
        body: { lastLoginAt: '2026-11-09T10:00:00.000Z', activeSessions: 2, secondFactor: true },
      },
    ]);
    renderPage(<ResellerWebPanelCard customerId="cust-1" mayEdit />);
    expect(await screen.findByText(/آخرین ورود:/u)).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText(t('web.rp_2fa_on'))).toBeInTheDocument();
  });

  it('says «هنوز وارد نشده» for a reseller who never signed in, and offers no forced logout', async () => {
    stubApi([
      {
        url: SUMMARY,
        method: 'GET',
        body: { lastLoginAt: null, activeSessions: 0, secondFactor: false },
      },
    ]);
    renderPage(<ResellerWebPanelCard customerId="cust-1" mayEdit />);
    expect(await screen.findByText(t('web.rp_admin_never'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t('web.rp_admin_force') })).toBeDisabled();
  });

  it('forced logout needs a reason of at least 3 characters and posts it with a key', async () => {
    const api = stubApi([
      {
        url: SUMMARY,
        method: 'GET',
        body: { lastLoginAt: '2026-11-09T10:00:00.000Z', activeSessions: 1, secondFactor: false },
      },
      { url: `${SUMMARY}/force-logout`, method: 'POST', body: { ended: 1 } },
    ]);
    renderPage(<ResellerWebPanelCard customerId="cust-1" mayEdit />);
    fireEvent.click(await screen.findByRole('button', { name: t('web.rp_admin_force') }));
    const confirm = screen.getByRole('button', { name: t('web.rp_admin_force_confirm') });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText(t('web.rp_admin_force_reason')), {
      target: { value: 'دستگاه گم شد' },
    });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(api.calls.some((c) => c.url.endsWith('/force-logout'))).toBe(true));
    const body = api.calls.find((c) => c.url.endsWith('/force-logout'))?.body as {
      reason: string;
      idempotencyKey: string;
    };
    expect(body.reason).toBe('دستگاه گم شد');
    expect(body.idempotencyKey.length).toBeGreaterThanOrEqual(8);
  });

  it('without resellers.edit the button is not offered', async () => {
    stubApi([
      {
        url: SUMMARY,
        method: 'GET',
        body: { lastLoginAt: null, activeSessions: 1, secondFactor: false },
      },
    ]);
    renderPage(<ResellerWebPanelCard customerId="cust-1" mayEdit={false} />);
    await screen.findByText(t('web.reseller_edit_denied'));
    expect(screen.queryByRole('button', { name: t('web.rp_admin_force') })).toBeNull();
  });
});
