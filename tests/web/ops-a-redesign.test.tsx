import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { PanelDetailPage, PanelsPage } from '../../apps/web/src/pages/panels';
import { BotsPage } from '../../apps/web/src/pages/bots';
import { BotButtonsPage } from '../../apps/web/src/pages/bot-buttons';
import { PaymentGatewaysPage } from '../../apps/web/src/pages/payment-gateways';
import { PaymentAccountsPage } from '../../apps/web/src/pages/payment-accounts';
import { ClientAppsPage } from '../../apps/web/src/pages/client-apps';
import { LeaveGuardHost } from '../../apps/web/src/ui/kit';
import { navigate } from '../../apps/web/src/router';
import { t } from '../../apps/web/src/i18n/web.fa';
import { OPS_A } from './shots/fixtures/ops-a';
import { panel, renderPage, stubApi } from './harness';

/**
 * OPS-A's redesign (round W, wave 2): the behaviour the new presentation ADDED —
 * the panel detail's tab in the address, the head's banners, the list's
 * sellability marker, the dialogs that replaced inline and browser confirmations,
 * dirty-state protection on every form, and the FX section's new layout. What the
 * pages already did is pinned in their own suites, unchanged.
 */

/** A shot fixture's body, so these cases read the same answers the screenshots do. */
function body(path: string): unknown {
  const found = OPS_A.find((one) => one.path === path && Object.keys(one.query).length === 0);
  if (found === undefined) throw new Error(`no OPS-A fixture for ${path}`);
  return found.body;
}

const go = (url: string) => act(() => navigate(url, { replace: true, force: true }));

beforeEach(() => go('/'));
afterEach(() => go('/'));

/** Asks the router to leave, and returns the dialog that asked, if one did. */
function leave(to = '/orders') {
  act(() => navigate(to));
  return screen.queryByRole('alertdialog', { name: t('web.unsaved_title') });
}

const PANEL_ID = panel().id as string;

describe('the panel detail, redesigned', () => {
  const detail = (overrides: Record<string, unknown> = {}) => [
    { url: `/panels/${PANEL_ID}`, body: { panel: panel(overrides) } },
  ];

  it('opens the tab the address names, and writes the tab it switches to', async () => {
    go(`/panels/${PANEL_ID}?tab=credentials`);
    stubApi(detail());
    renderPage(<PanelDetailPage id={PANEL_ID} mayEdit mayRotate denied={false} />);
    await screen.findByRole('heading', { name: /^Frankfurt A/u });

    expect(screen.getByRole('tab', { name: t('web.panel_tab_credentials') })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    fireEvent.click(screen.getByRole('tab', { name: t('web.panel_tab_workload') }));
    await waitFor(() => expect(window.location.search).toBe('?tab=workload'));
    // Overview is the default and leaves no parameter behind.
    fireEvent.click(screen.getByRole('tab', { name: t('web.panel_tab_overview') }));
    await waitFor(() => expect(window.location.search).toBe(''));
  });

  it('falls back to Overview for a tab the page does not have', async () => {
    go(`/panels/${PANEL_ID}?tab=nonsense`);
    stubApi(detail());
    renderPage(<PanelDetailPage id={PANEL_ID} mayEdit mayRotate denied={false} />);
    await screen.findByRole('heading', { name: /^Frankfurt A/u });
    expect(screen.getByRole('tab', { name: t('web.panel_tab_overview') })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('asks before leaving an unsaved configuration, but not for a tab switch', async () => {
    go(`/panels/${PANEL_ID}`);
    stubApi(detail());
    renderPage(
      <>
        <PanelDetailPage id={PANEL_ID} mayEdit mayRotate denied={false} />
        <LeaveGuardHost />
      </>,
    );
    await screen.findByRole('heading', { name: /^Frankfurt A/u });

    // Untouched: leaving is not interrupted.
    expect(leave(`/panels/${PANEL_ID}?tab=health`)).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: t('web.panel_tab_overview') }));

    fireEvent.change(screen.getByLabelText(t('web.panel_name')), {
      target: { value: 'Frankfurt Z' },
    });
    // A tab switch keeps Overview mounted, so nothing is lost and nothing is asked.
    fireEvent.click(screen.getByRole('tab', { name: t('web.panel_tab_health') }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: t('web.panel_tab_overview') }));
    expect((screen.getByLabelText(t('web.panel_name')) as HTMLInputElement).value).toBe(
      'Frankfurt Z',
    );

    // Leaving the page with the draft asks, and staying keeps the address.
    const dialog = leave('/orders');
    expect(dialog).not.toBeNull();
    fireEvent.click(
      within(dialog as HTMLElement).getByRole('button', { name: t('web.unsaved_stay') }),
    );
    expect(window.location.pathname).toBe(`/panels/${PANEL_ID}`);
  });

  it('lets browser Back return between tabs over an unsaved Overview, without asking', async () => {
    go(`/panels/${PANEL_ID}`);
    stubApi(detail());
    renderPage(
      <>
        <PanelDetailPage id={PANEL_ID} mayEdit mayRotate denied={false} />
        <LeaveGuardHost />
      </>,
    );
    await screen.findByRole('heading', { name: /^Frankfurt A/u });
    fireEvent.change(screen.getByLabelText(t('web.panel_name')), {
      target: { value: 'Frankfurt Z' },
    });
    fireEvent.click(screen.getByRole('tab', { name: t('web.panel_tab_health') }));
    await waitFor(() => expect(window.location.search).toBe('?tab=health'));

    act(() => window.history.back());
    await waitFor(() => expect(window.location.search).toBe(''));
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: t('web.panel_tab_overview') })).toHaveAttribute(
        'aria-selected',
        'true',
      ),
    );
    // Overview never unmounted, so nothing was at stake and nothing was asked.
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect((screen.getByLabelText(t('web.panel_name')) as HTMLInputElement).value).toBe(
      'Frankfurt Z',
    );
  });

  it('draws no leave guard for a viewer, who has no form to lose', async () => {
    go(`/panels/${PANEL_ID}`);
    stubApi(detail());
    renderPage(
      <>
        <PanelDetailPage id={PANEL_ID} mayEdit={false} mayRotate={false} denied={false} />
        <LeaveGuardHost />
      </>,
    );
    await screen.findByRole('heading', { name: /^Frankfurt A/u });
    expect(leave('/orders')).toBeNull();
    expect(window.location.pathname).toBe('/orders');
  });

  it('puts status and health beside the name, and the failure with its remedy above the tabs', async () => {
    stubApi(
      detail({
        health: {
          state: 'AUTH_FAILED',
          checkedAt: '2026-09-06T08:00:00.000Z',
          latencyMs: 88,
          failure: 'AUTHENTICATION_REQUIRES_INTERACTION',
          status: 401,
          providerVersion: '0.8.4',
          lastHealthyAt: null,
          stale: true,
        },
      }),
    );
    renderPage(<PanelDetailPage id={PANEL_ID} mayEdit mayRotate denied={false} />);
    const heading = await screen.findByRole('heading', { name: /Frankfurt A/u });
    expect(within(heading).getByText(t('web.panel_status_active'))).toBeInTheDocument();
    expect(within(heading).getByText(t('web.health_auth_failed'))).toBeInTheDocument();

    expect(screen.getByText(t('web.panel_failure_title'))).toBeInTheDocument();
    expect(
      screen.getByText(t('web.diag_failure_authentication_requires_interaction'), {
        exact: false,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(t('web.panel_stale_title'))).toBeInTheDocument();

    // The banner's action opens the Health tab.
    fireEvent.click(screen.getByRole('button', { name: t('web.panel_open_health') }));
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: t('web.panel_tab_health') })).toHaveAttribute(
        'aria-selected',
        'true',
      ),
    );
  });

  it('draws no failure or staleness banner for a panel with neither', async () => {
    stubApi(detail());
    renderPage(<PanelDetailPage id={PANEL_ID} mayEdit mayRotate denied={false} />);
    await screen.findByRole('heading', { name: /^Frankfurt A/u });
    expect(screen.queryByText(t('web.panel_failure_title'))).toBeNull();
    expect(screen.queryByText(t('web.panel_stale_title'))).toBeNull();
  });

  it('summarises only fields of the response in the head strip', async () => {
    stubApi(
      detail({
        capacity: { maxServices: 50, services: 7, reservations: 2, used: 9, available: 41 },
      }),
    );
    renderPage(<PanelDetailPage id={PANEL_ID} mayEdit mayRotate denied={false} />);
    await screen.findByRole('heading', { name: /^Frankfurt A/u });
    const strip = document.querySelector('.detail-head .head-stats') as HTMLElement;
    const labels = [...strip.querySelectorAll('dt')].map((cell) => cell.textContent);
    expect(labels).toEqual([
      t('web.panel_health'),
      t('web.panel_latency'),
      t('web.panel_last_healthy'),
      t('web.panel_sellable'),
      t('web.panel_capacity'),
      t('web.panel_capacity_services'),
    ]);
    // The capacity is the server's, reservations included, over the cap.
    expect(
      within(strip).getByRole('progressbar', { name: t('web.panel_capacity') }),
    ).toHaveAttribute('aria-valuenow', '18');
  });
});

describe('the panel list, redesigned', () => {
  const LIVE = { path: '/panels', query: new URLSearchParams() };

  it('shows each panel’s host under its name, and marks one the server will not sell', async () => {
    const SELLABLE = {
      sellable: true,
      reason: null,
      activationComplete: true,
      missingActivationFields: [],
      connectionValidated: true,
    };
    stubApi([
      {
        url: '/panels',
        body: {
          panels: [
            panel(),
            panel({
              id: '01a05e35-c9ad-7e93-bef3-1ed9b55292c9',
              name: 'Frankfurt B',
              baseUrl: 'https://b.example:8443/api',
              sellability: SELLABLE,
            }),
          ],
          nextCursor: null,
        },
      },
    ]);
    renderPage(<PanelsPage route={LIVE} mayEdit denied={false} />);
    await screen.findByText('Frankfurt B');

    expect(screen.getByText('panel.example')).toBeInTheDocument();
    expect(screen.getByText('b.example:8443')).toBeInTheDocument();
    // One marker, on the unsellable row, carrying the server's reason as its title.
    const markers = screen.getAllByText(t('web.panels_not_sellable'));
    expect(markers).toHaveLength(1);
    expect(markers[0]?.getAttribute('title')).toBe(t('web.panel_reason_activation_incomplete'));
    expect(markers[0]?.closest('tr')?.textContent).toContain('Frankfurt A');
  });

  it('names the archive filter group, and marks the chip in force', async () => {
    stubApi([{ url: '/panels', body: { panels: [panel()], nextCursor: null } }]);
    renderPage(<PanelsPage route={LIVE} mayEdit denied={false} />);
    await screen.findByText('Frankfurt A');
    const group = screen.getByRole('group', { name: t('web.panels_filter') });
    expect(within(group).getByRole('button', { name: t('web.panels_live') })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(group).getByRole('button', { name: t('web.panels_archived') })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });
});

describe('the bots page, redesigned', () => {
  const page = (mayOperate: boolean) =>
    (<BotsPage denied={false} mayOperate={mayOperate} mayReplaceToken={false} />) as ReactElement;

  it('asks through a dialog before stopping, and a declined or dismissed dialog sends nothing', async () => {
    const api = stubApi([{ url: '/bots', body: body('/bots') }]);
    renderPage(page(true));

    fireEvent.click(await screen.findByRole('button', { name: t('web.bot_stop') }));
    const dialog = await screen.findByRole('alertdialog', {
      name: t('web.bot_stop_confirm_title'),
    });
    fireEvent.click(within(dialog).getByRole('button', { name: t('web.bot_cancel') }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: t('web.bot_stop') }));
    await screen.findByRole('alertdialog');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());

    expect(api.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });

  it('says a viewer may only look, and draws no action', async () => {
    stubApi([{ url: '/bots', body: body('/bots') }]);
    renderPage(page(false));
    expect(await screen.findByText(t('web.bot_read_only'))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t('web.bot_stop') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('web.bot_check') })).toBeNull();
  });
});

describe('dirty-state protection on the OPS-A forms', () => {
  it('guards a moved main-menu arrangement until it is saved or restored', async () => {
    stubApi([
      { url: '/bot-menu', body: body('/bot-menu') },
      { url: '/templates', body: body('/templates') },
    ]);
    renderPage(
      <>
        <BotButtonsPage mayEdit denied={false} mayViewTemplates mayEditTemplates={false} />
        <LeaveGuardHost />
      </>,
    );
    const down = await screen.findAllByRole('button', {
      name: new RegExp(`^${t('web.bot_buttons_move_down')}`, 'u'),
    });
    expect(leave()).toBeNull();
    go('/bot-buttons');

    fireEvent.click(down[0] as HTMLElement);
    expect(leave()).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: t('web.unsaved_stay') }));

    // Back to the stored arrangement: nothing is unsaved, nothing is asked.
    fireEvent.click(screen.getByRole('button', { name: t('web.bot_buttons_restore_default') }));
    expect(leave()).toBeNull();
  });

  it('guards an edited payment route, and releases the guard on cancel', async () => {
    stubApi([
      { url: '/payment-gateways', body: body('/payment-gateways') },
      { url: '/fx/status', body: body('/fx/status') },
    ]);
    renderPage(
      <>
        <PaymentGatewaysPage denied={false} mayEdit />
        <LeaveGuardHost />
      </>,
    );
    const edit = await screen.findAllByRole('button', { name: t('web.payment_gateway_edit') });
    fireEvent.click(edit[0] as HTMLElement);
    // Opened and untouched: nothing to lose.
    expect(leave()).toBeNull();
    go('/payment-gateways');

    fireEvent.change(screen.getByLabelText(t('web.payment_gateway_name')), {
      target: { value: 'کارت' },
    });
    expect(leave()).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: t('web.unsaved_stay') }));

    fireEvent.click(screen.getByRole('button', { name: t('web.payment_gateway_cancel_edit') }));
    expect(leave()).toBeNull();
  });

  it('guards a typed API key that has not been sent', async () => {
    stubApi([
      { url: '/payment-gateways', body: body('/payment-gateways') },
      { url: '/fx/status', body: body('/fx/status') },
    ]);
    renderPage(
      <>
        <PaymentGatewaysPage denied={false} mayEdit />
        <LeaveGuardHost />
      </>,
    );
    fireEvent.click(
      await screen.findByRole('button', { name: t('web.payment_gateway_credential_edit') }),
    );
    fireEvent.change(screen.getByLabelText(t('web.payment_gateway_credential_input')), {
      target: { value: 'secret-key' },
    });
    expect(leave()).not.toBeNull();
  });

  it('guards a half-typed payment account', async () => {
    stubApi([{ url: '/payment-accounts', body: body('/payment-accounts') }]);
    renderPage(
      <>
        <PaymentAccountsPage denied={false} mayEdit />
        <LeaveGuardHost />
      </>,
    );
    await screen.findByText('حساب اصلی');
    expect(leave()).toBeNull();
    go('/payment-accounts');

    fireEvent.change(screen.getByLabelText(t('web.payment_account_bank')), {
      target: { value: 'ملت' },
    });
    expect(leave()).not.toBeNull();
  });

  it('guards an edited client app, and not one merely opened', async () => {
    stubApi([{ url: '/client-apps', body: body('/client-apps') }]);
    renderPage(
      <>
        <ClientAppsPage denied={false} mayEdit />
        <LeaveGuardHost />
      </>,
    );
    const edit = await screen.findAllByRole('button', { name: t('web.client_apps_edit') });
    fireEvent.click(edit[0] as HTMLElement);
    expect(leave()).toBeNull();
    go('/client-apps');

    fireEvent.change(screen.getByLabelText(t('web.client_apps_description')), {
      target: { value: 'توضیح تازه' },
    });
    expect(leave()).not.toBeNull();
  });
});

describe('the FX section', () => {
  const routes = (status: unknown = body('/fx/status')) => [
    { url: '/payment-gateways', body: body('/payment-gateways') },
    { url: '/fx/status', body: status },
  ];

  it('leads with the state, the rate, its age and the last refresh', async () => {
    stubApi(routes());
    renderPage(<PaymentGatewaysPage denied={false} mayEdit={false} />);
    const strip = await screen.findByTestId('fx-strip');
    expect(within(strip).getByText(t('web.fx_state_fresh')).closest('.badge')).toHaveClass('ok');
    // A rate is a quantity: the body's digit shapes, not a technical Latin run.
    expect(within(strip).getByText('104250')).toHaveClass('num');
    expect(within(strip).getByText('104250')).not.toHaveClass('ltr');
    expect(within(strip).getByText(t('web.fx_age'))).toBeInTheDocument();
    expect(within(strip).getByText(t('web.fx_last_refresh'))).toBeInTheDocument();
  });

  it('keeps the raw identifiers behind the technical disclosure', async () => {
    stubApi(routes());
    renderPage(<PaymentGatewaysPage denied={false} mayEdit={false} />);
    const quoteId = await screen.findByText('01a0f1c2-0000-7000-8000-00000000f001');
    const disclosure = quoteId.closest('details');
    expect(disclosure).not.toBeNull();
    expect(disclosure?.open).toBe(false);
    expect(within(disclosure as HTMLElement).getByText(t('web.fx_technical'))).toBeInTheDocument();
  });

  it('draws the unavailable state in danger, and says there is no quote', async () => {
    const status = {
      ...(body('/fx/status') as Record<string, unknown>),
      state: 'UNAVAILABLE',
      quote: null,
    };
    stubApi(routes(status));
    renderPage(<PaymentGatewaysPage denied={false} mayEdit={false} />);
    const strip = await screen.findByTestId('fx-strip');
    expect(within(strip).getByText(t('web.fx_state_unavailable')).closest('.badge')).toHaveClass(
      'danger',
    );
    expect(within(strip).getByText(t('web.fx_no_quote'))).toBeInTheDocument();
  });

  it('offers the refresh only with edit, and tells the outcome it got', async () => {
    const api = stubApi([
      ...routes(),
      {
        url: '/fx/refresh',
        body: { outcome: 'FAILED', reason: 'NOBITEX:timeout', status: body('/fx/status') },
      },
    ]);
    const view = renderPage(<PaymentGatewaysPage denied={false} mayEdit={false} />);
    await screen.findByTestId('fx-strip');
    expect(screen.queryByRole('button', { name: t('web.fx_refresh') })).toBeNull();
    view.unmount();

    renderPage(<PaymentGatewaysPage denied={false} mayEdit />);
    fireEvent.click(await screen.findByRole('button', { name: t('web.fx_refresh') }));
    expect(await screen.findByText(t('web.fx_refresh_failed'))).toBeInTheDocument();
    expect(api.calls.filter((call) => call.url.endsWith('/fx/refresh'))).toHaveLength(1);
  });

  it('leaves the routes table standing when the rates cannot be read', async () => {
    stubApi([
      { url: '/payment-gateways', body: body('/payment-gateways') },
      {
        url: '/fx/status',
        status: 503,
        body: {
          error: { kind: 'unavailable', code: 'test.down', message: 'down', correlationId: 'x' },
        },
      },
    ]);
    renderPage(<PaymentGatewaysPage denied={false} mayEdit={false} />);
    expect(
      await screen.findByText(t('web.payment_gateway_provider_manual_transfer')),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('fx-strip')).toBeNull());
  });
});
