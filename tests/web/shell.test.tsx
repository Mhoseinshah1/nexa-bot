import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { App } from '../../apps/web/src/app';
import { useCommandShortcut } from '../../apps/web/src/shell';
import { ConfirmDialog } from '../../apps/web/src/ui/confirm-dialog';
import { navigate } from '../../apps/web/src/router';
import { t } from '../../apps/web/src/i18n/web.fa';
import { formatNumber } from '../../apps/web/src/format';
import { COUNTER_CAP } from '@nexa/contracts';
import { navGroupHeader, renderPage, stubApi } from './harness';

/**
 * The shell the owner's reference defines: sidebar, topbar, command search.
 * What is pinned is behaviour an operator relies on — which pages the search
 * offers, what is remembered, and that changing the theme does not throw away
 * the page they are on.
 */

const session = (permissions: readonly string[]) => ({
  url: '/auth/session',
  body: {
    admin: {
      id: '01a05e35-c9ad-7e93-bef3-1ed9b55292c8',
      username: 'sara',
      displayName: 'سارا احمدی',
      status: 'ACTIVE',
      telegramUserId: null,
      roleKeys: ['operator'],
      createdAt: '2026-01-01T00:00:00.000Z',
      lastLoginAt: '2026-09-06T08:00:00.000Z',
    },
    permissions,
    expiresAt: '2026-09-07T08:00:00.000Z',
  },
});

const INFO = {
  url: '/health/info',
  body: {
    name: 'nexa-bot',
    version: '0.4.0',
    commit: '7ba1837e6c2d4a1b9f0e3c5d7a8b9c0d1e2f3a4b',
    buildTime: '2026-09-04T08:00:00.000Z',
    nodeVersion: 'v22.11.0',
    environment: 'staging',
  },
};

beforeEach(() => {
  window.localStorage.clear();
  act(() => navigate('/', { replace: true, force: true }));
});

afterEach(() => {
  window.localStorage.clear();
});

describe('the command search', () => {
  it('offers exactly the pages the sidebar offers this actor, and goes there', async () => {
    stubApi([session(['users.view', 'orders.view'])]);
    renderPage(<App />);
    await screen.findByRole('navigation', { name: t('web.nav_label') });

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const dialog = screen.getByRole('dialog', { name: t('web.search_label') });
    const options = () =>
      within(dialog)
        .queryAllByRole('option')
        // The page's own label, without the group named beside it: «زیرساخت و پنل‌ها» is a
        // group a session-only page sits in, and must not read as the panels page.
        .map((o) => (o.textContent ?? '').replace(o.querySelector('.sub')?.textContent ?? '', ''));
    // Dashboard, users, orders, providers and system need no more than a session.
    expect(options().some((o) => o.includes(t('web.nav_users')))).toBe(true);
    expect(options().some((o) => o.includes(t('web.nav_orders')))).toBe(true);
    // A page this actor may not see is not offered, however it is searched for.
    expect(options().some((o) => o.includes(t('web.nav_panels')))).toBe(false);

    const input = within(dialog).getByRole('combobox');
    fireEvent.change(input, { target: { value: t('web.nav_orders') } });
    expect(options()).toHaveLength(1);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(window.location.pathname).toBe('/orders');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says so when nothing matches, and closes on Escape', async () => {
    stubApi([session([])]);
    renderPage(<App />);
    await screen.findByRole('navigation', { name: t('web.nav_label') });
    fireEvent.click(screen.getByRole('button', { name: t('web.search_label') }));
    const dialog = screen.getByRole('dialog', { name: t('web.search_label') });
    fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'zzzz' } });
    expect(within(dialog).getByText(t('web.search_none'))).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('the command shortcut over a confirmation', () => {
  it('does not open the search while a confirmation is asking', () => {
    let opened = 0;
    let cancelled = 0;
    function Host({ asking }: { asking: boolean }) {
      useCommandShortcut(() => {
        opened += 1;
      });
      return asking ? (
        <ConfirmDialog
          title="t"
          question="q"
          confirmLabel="yes"
          cancelLabel="no"
          onConfirm={() => undefined}
          onCancel={() => {
            cancelled += 1;
          }}
        />
      ) : null;
    }
    const { rerender } = renderPage(<Host asking />);
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(opened).toBe(0);
    // Focus stayed on the question's safe answer.
    expect(document.activeElement?.textContent).toBe('no');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(cancelled).toBe(1);

    rerender(<Host asking={false} />);
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(opened).toBe(1);
  });
});

describe('the sidebar drawer on a narrow screen', () => {
  const realMatch = window.matchMedia;
  const realWidth = window.innerWidth;
  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 600 });
    window.matchMedia = ((query: string) => ({
      ...realMatch(query),
      matches: /max-width:\s*980px/.test(query) || realMatch(query).matches,
    })) as typeof window.matchMedia;
  });
  afterEach(() => {
    window.matchMedia = realMatch;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: realWidth });
  });

  it('takes focus, keeps Tab inside, and closes on Escape back to the opener', async () => {
    stubApi([session(['users.view'])]);
    const { container } = renderPage(<App />);
    const opener = await screen.findByRole('button', { name: t('web.open_menu') });
    expect(container.querySelector('.app')?.classList.contains('collapsed')).toBe(true);
    opener.focus();
    fireEvent.click(opener);
    const sidebar = container.querySelector('#app-sidebar') as HTMLElement;
    expect(container.querySelector('.app')?.classList.contains('collapsed')).toBe(false);
    expect(sidebar.contains(document.activeElement)).toBe(true);

    // Tab from the last control wraps to the first, never to the page behind.
    const controls = sidebar.querySelectorAll<HTMLElement>('button, [href]');
    const last = controls[controls.length - 1] as HTMLElement;
    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(sidebar.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(container.querySelector('.app')?.classList.contains('collapsed')).toBe(true);
    expect(document.activeElement).toBe(opener);
  });
});

describe('the sidebar', () => {
  it('remembers a collapse for the next visit', async () => {
    stubApi([session([])]);
    const first = renderPage(<App />);
    const toggle = await screen.findByRole('button', { name: t('web.toggle_sidebar') });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(toggle);
    expect(window.localStorage.getItem('nexa.sidebar')).toBe('collapsed');
    first.unmount();

    renderPage(<App />);
    const again = await screen.findByRole('button', { name: t('web.toggle_sidebar') });
    expect(again.getAttribute('aria-expanded')).toBe('false');
  });

  it('changes the theme without remounting the page', async () => {
    stubApi([session([])]);
    renderPage(<App />);
    const nav = await screen.findByRole('navigation', { name: t('web.nav_label') });
    const themeButton = screen.getByRole('button', {
      name: `${t('web.theme')}: ${t('web.theme_system')}`,
    });
    fireEvent.click(themeButton);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    fireEvent.click(
      screen.getByRole('button', { name: `${t('web.theme')}: ${t('web.theme_dark')}` }),
    );
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    // The same node: nothing above it was torn down to repaint.
    expect(nav.isConnected).toBe(true);
    expect(screen.getByRole('navigation', { name: t('web.nav_label') })).toBe(nav);
  });

  it('names the build the server reports, and guesses none when it cannot', async () => {
    stubApi([session([]), INFO]);
    const { container, unmount } = renderPage(<App />);
    await waitFor(() =>
      expect(container.querySelector('.build-id')?.textContent).toBe('v0.4.0 · 7ba1837'),
    );
    expect(container.querySelector('.identity-env')?.textContent).toContain('staging');
    unmount();

    stubApi([session([])]);
    const without = renderPage(<App />);
    await screen.findByRole('navigation', { name: t('web.nav_label') });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(without.container.querySelector('.build-id')).toBeNull();
    expect(without.container.querySelector('.identity-env')).toBeNull();
  });

  it('titles the identity card with the product name, never the host', async () => {
    stubApi([session([]), INFO]);
    const { container } = renderPage(<App />);
    const card = await screen.findByRole('group', { name: t('web.identity_label') });
    await waitFor(() => expect(container.querySelector('.identity-env')).not.toBeNull());
    // The title is the catalogue's product name — no contract carries a store name.
    expect(card.querySelector('.identity-name')?.textContent).toBe(t('web.title'));
    // The line beneath is the server's environment and service, as a technical value.
    const env = card.querySelector('.identity-env .ltr');
    expect(env?.textContent).toBe('staging · nexa-bot');
    // And the address the operator typed is not presented as an identity at all.
    expect(card.textContent).not.toContain(window.location.host);
    expect(card.textContent).not.toContain(window.location.hostname);
  });

  it('draws a counter at the cap as "or more", and an exact one as it is', async () => {
    stubApi([
      session(['services.view', 'payments.view']),
      {
        url: '/nav-counters',
        body: {
          generatedAt: '2026-09-06T08:00:00.000Z',
          counters: {
            openConditions: null,
            ticketsAwaitingSupport: null,
            unhealthyPanels: null,
            unreconciledServices: COUNTER_CAP,
            refundRequestsAwaiting: null,
            paymentsUnknown: 7,
          },
        },
      },
    ]);
    const { container } = renderPage(<App />);
    await waitFor(() => expect(container.querySelectorAll('.nav .cnt')).toHaveLength(2));
    // Both groups are folded on the dashboard: open each to read its link's own counter.
    fireEvent.click(navGroupHeader('web.navgroup_customers') as HTMLElement);
    const services = container.querySelector('.nav a[href="/services"]') as HTMLElement;
    const capped = formatNumber(COUNTER_CAP);
    // Seen as "1,000+", heard as "1,000 or more" — never as an exact 1,000.
    expect(services.querySelector('.cnt [aria-hidden="true"]')?.textContent).toBe(`${capped}+`);
    expect(services).toHaveAccessibleDescription(
      t('web.nav_counter_at_least_spoken').replace('{count}', capped),
    );
    // The count is read inside the link's name too, so the name says "or more" as well.
    expect(services).toHaveAccessibleName(
      `${t('web.nav_services')}${t('web.nav_counter_at_least_spoken').replace('{count}', capped)}`,
    );
    fireEvent.click(navGroupHeader('web.navgroup_finance') as HTMLElement);
    const payments = container.querySelector('.nav a[href="/payments"]') as HTMLElement;
    expect(payments.querySelector('.cnt')?.textContent).toBe(formatNumber(7));
    expect(payments).toHaveAccessibleDescription(formatNumber(7));
  });

  it('draws any single counter at the cap as a floor, seen and heard', async () => {
    stubApi([
      session(['opslog.view']),
      {
        url: '/nav-counters',
        body: {
          generatedAt: '2026-09-06T08:00:00.000Z',
          counters: {
            openConditions: COUNTER_CAP,
            ticketsAwaitingSupport: null,
            unhealthyPanels: null,
            unreconciledServices: null,
            refundRequestsAwaiting: null,
            paymentsUnknown: null,
          },
        },
      },
    ]);
    const { container } = renderPage(<App />);
    await waitFor(() => expect(container.querySelector('.nav .cnt')).not.toBeNull());
    fireEvent.click(navGroupHeader('web.navgroup_system') as HTMLElement);
    const badge = container.querySelector('.nav a .cnt') as HTMLElement;
    const capped = formatNumber(COUNTER_CAP);
    const spoken = t('web.nav_counter_at_least_spoken').replace('{count}', capped);
    expect(badge.querySelector('[aria-hidden="true"]')?.textContent).toBe(`${capped}+`);
    const link = badge.closest('a') as HTMLAnchorElement;
    expect(link).toHaveAccessibleName(`${t('web.nav_alerts')}${spoken}`);
    expect(link).toHaveAccessibleDescription(spoken);
  });

  it('draws no counter nobody supplied', async () => {
    stubApi([session(['users.view'])]);
    const { container } = renderPage(<App />);
    await screen.findByRole('navigation', { name: t('web.nav_label') });
    expect(container.querySelectorAll('.nav .cnt')).toHaveLength(0);
  });
});
