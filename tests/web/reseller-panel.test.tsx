import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { ResellerLoginPage } from '../../apps/web/src/reseller/login';
import { ResellerRoot } from '../../apps/web/src/reseller/root';
import { PanelShell } from '../../apps/web/src/reseller/shell';
import { NAV_ITEMS } from '../../apps/web/src/reseller/route';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';
import {
  TOKEN,
  dashboard,
  irt,
  problem,
  serviceDetail,
  serviceRow,
  servicesPage,
  signedIn,
} from './reseller-fixtures';

/**
 * The reseller web panel (`/r/…`), PR-4: login (the one-time link, the used-link state, the 2FA
 * step), the shell and its sidebar, and the read screens. The real API client and the real
 * schemas run; only `fetch` is stubbed.
 */
const API = '/api/reseller/v1';

function visit(path: string) {
  act(() => {
    window.history.replaceState(null, '', path);
    window.dispatchEvent(new Event('popstate'));
  });
}

beforeEach(() => visit('/r/login'));
afterEach(() => {
  vi.unstubAllGlobals();
  visit('/');
});

describe('login', () => {
  it('has a neutral tab title before and after the reseller app mounts', () => {
    const html = readFileSync(resolve(__dirname, '../../apps/web/index.html'), 'utf8');
    const page = new DOMParser().parseFromString(html, 'text/html');
    expect(page.title).toBe('پنل کاربری');
    stubApi([problem(`${API}/me`, 401, 'reseller_web.session_invalid')]);
    renderPage(<ResellerRoot takeToken={() => ({ token: null, alreadyOpened: false })} />);
    expect(document.title).toBe('پنل نماینده');
  });

  it('posts the link token once, then opens the dashboard', async () => {
    const api = stubApi([
      { url: `${API}/auth/exchange`, method: 'POST', body: { state: 'ACTIVE', expiresAt: 'x' } },
    ]);
    renderPage(<ResellerLoginPage initialToken={TOKEN} />);
    await waitFor(() => expect(window.location.pathname).toBe('/r/dashboard'));
    const posts = api.calls.filter((call) => call.url.endsWith('/auth/exchange'));
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toEqual({ token: TOKEN });
  });

  it('shows «این لینک قبلاً باز شده است» for a refresh of an opened link, and posts nothing', async () => {
    const api = stubApi([
      problem(`${API}/me`, 401, 'reseller_web.session_invalid'),
      { url: `${API}/auth/exchange`, method: 'POST', body: { state: 'ACTIVE', expiresAt: 'x' } },
    ]);
    renderPage(<ResellerLoginPage initialToken={null} linkAlreadyOpened />);
    expect(await screen.findByText(t('web.rp_login_link_used'))).toBeInTheDocument();
    expect(api.calls.some((call) => call.url.endsWith('/auth/exchange'))).toBe(false);
  });

  it('shows the instructions for a visit with no link at all', async () => {
    stubApi([problem(`${API}/me`, 401, 'reseller_web.session_invalid')]);
    renderPage(<ResellerLoginPage initialToken={null} />);
    expect(await screen.findByText(t('web.rp_login_title'))).toBeInTheDocument();
    expect(screen.queryByText(t('web.rp_login_link_used'))).toBeNull();
  });

  it('says a token of the wrong shape is incomplete, without asking the server', async () => {
    const api = stubApi([]);
    renderPage(<ResellerLoginPage initialToken="short" />);
    expect(await screen.findByText(t('web.rp_login_link_invalid'))).toBeInTheDocument();
    expect(api.calls).toHaveLength(0);
  });

  it('shows the server’s Persian refusal for a used, expired or foreign link', async () => {
    stubApi([problem(`${API}/auth/exchange`, 401, 'reseller_web.link_expired')]);
    renderPage(<ResellerLoginPage initialToken={TOKEN} />);
    expect(await screen.findByText(t('web.err_reseller_web_link_expired'))).toBeInTheDocument();
  });

  it('asks for the 2FA code after the link, and a right code opens the panel', async () => {
    const api = stubApi([
      {
        url: `${API}/auth/exchange`,
        method: 'POST',
        body: { state: 'SECOND_FACTOR_REQUIRED', expiresAt: 'x' },
      },
      {
        url: `${API}/auth/second-factor`,
        method: 'POST',
        body: { state: 'ACTIVE', expiresAt: 'x' },
      },
    ]);
    renderPage(<ResellerLoginPage initialToken={TOKEN} />);
    const input = await screen.findByLabelText(t('web.rp_2fa_label'));
    expect(window.location.pathname).toBe('/r/login');
    fireEvent.change(input, { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: t('web.rp_2fa_submit') }));
    await waitFor(() => expect(window.location.pathname).toBe('/r/dashboard'));
    expect(api.calls.find((call) => call.url.endsWith('/auth/second-factor'))?.body).toEqual({
      code: '123456',
    });
  });

  it('shows the code step again when a refresh finds a session still waiting for its code', async () => {
    stubApi([problem(`${API}/me`, 401, 'reseller_web.second_factor_required')]);
    renderPage(<ResellerLoginPage initialToken={null} linkAlreadyOpened />);
    expect(await screen.findByLabelText(t('web.rp_2fa_label'))).toBeInTheDocument();
  });

  it('a wrong code is refused in Persian and keeps the step', async () => {
    stubApi([
      {
        url: `${API}/auth/exchange`,
        method: 'POST',
        body: { state: 'SECOND_FACTOR_REQUIRED', expiresAt: 'x' },
      },
      problem(`${API}/auth/second-factor`, 401, 'reseller_web.second_factor_invalid'),
    ]);
    renderPage(<ResellerLoginPage initialToken={TOKEN} />);
    fireEvent.change(await screen.findByLabelText(t('web.rp_2fa_label')), {
      target: { value: '000000' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('web.rp_2fa_submit') }));
    expect(
      await screen.findByText(t('web.err_reseller_web_second_factor_invalid')),
    ).toBeInTheDocument();
  });

  it('is not offered a spent token again after a sign-out in the same tab', async () => {
    const take = vi.fn(() => ({ token: TOKEN, alreadyOpened: false }));
    const api = stubApi([
      { url: `${API}/auth/exchange`, method: 'POST', body: { state: 'ACTIVE', expiresAt: 'x' } },
      problem(`${API}/me`, 401, 'reseller_web.session_invalid'),
    ]);
    renderPage(<ResellerRoot takeToken={take} />);
    await waitFor(() => expect(window.location.pathname).toBe('/r/dashboard'));
    act(() => {
      window.history.pushState(null, '', '/r/login');
      window.dispatchEvent(new Event('popstate'));
    });
    await screen.findByText(t('web.rp_login_title'));
    expect(api.calls.filter((call) => call.url.endsWith('/auth/exchange'))).toHaveLength(1);
  });
});

describe('the shell', () => {
  it('draws the sidebar in the owner’s order, the balance card and «خروج از پنل»', async () => {
    visit('/r/dashboard');
    stubApi(signedIn([{ url: `${API}/dashboard`, body: dashboard() }]));
    renderPage(<PanelShell />);
    const nav = await screen.findByRole('navigation', { name: t('web.rp_nav_label') });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(NAV_ITEMS.map((item) => t(item.label)));
    expect(
      within(nav)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual([
      'داشبورد',
      'خرید سرویس',
      'سرویس‌های من',
      'مشتری‌ها',
      'کیف پول',
      'لیست قیمت',
      'پشتیبانی',
      'ربات اختصاصی',
      'حساب و تنظیمات',
    ]);
    expect(screen.getByText(t('web.rp_mini_balance'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t('web.rp_sign_out') })).toBeInTheDocument();
  });

  it('«خروج از پنل» signs out and goes to the login page', async () => {
    visit('/r/dashboard');
    const api = stubApi(
      signedIn([
        { url: `${API}/dashboard`, body: dashboard() },
        { url: `${API}/auth/logout`, method: 'POST', body: { ok: true } },
      ]),
    );
    renderPage(<PanelShell />);
    fireEvent.click(await screen.findByRole('button', { name: t('web.rp_sign_out') }));
    await waitFor(() => expect(window.location.pathname).toBe('/r/login'));
    expect(api.calls.some((call) => call.url.endsWith('/auth/logout'))).toBe(true);
  });

  it('draws nothing of the panel when the session is gone, and points to the bot', async () => {
    visit('/r/dashboard');
    stubApi([problem(`${API}/me`, 401, 'reseller_web.session_invalid')]);
    renderPage(<PanelShell />);
    expect(await screen.findByText(t('web.rp_gate_signed_out_title'))).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: t('web.rp_nav_label') })).toBeNull();
  });

  it('treats the flag being off as «the panel does not exist»', async () => {
    visit('/r/dashboard');
    stubApi([problem(`${API}/me`, 404, 'reseller_web.unavailable')]);
    renderPage(<PanelShell />);
    expect(await screen.findByText(t('web.rp_gate_unavailable_title'))).toBeInTheDocument();
  });
});

describe('the dashboard', () => {
  it('shows what the API returns — balance, active, month sales, expiring — and no trial or progress card without their answers', async () => {
    visit('/r/dashboard');
    stubApi(signedIn([{ url: `${API}/dashboard`, body: dashboard() }]));
    renderPage(<PanelShell />);
    expect(await screen.findByText(t('web.rp_stat_sales'))).toBeInTheDocument();
    expect(screen.getByText('12,450,000 تومان')).toBeInTheDocument();
    expect(screen.getByText('ar_9001')).toBeInTheDocument();
    expect(screen.getByText(t('web.rp_tier_title'))).toBeInTheDocument();
    // No `/trial` and no `/tier-progress` answer (404 here): neither card is drawn.
    expect(screen.queryByText(/سرویس تست/u)).toBeNull();
    expect(screen.queryByText(/پیشرفت تا سطح/u)).toBeNull();
    // Never the demo's sample badge.
    expect(screen.queryByText(/دادهٔ نمونه/u)).toBeNull();
  });

  it('«تمدید» opens the drawer on the renewal tab', async () => {
    visit('/r/dashboard');
    stubApi(
      signedIn([
        { url: `${API}/dashboard`, body: dashboard() },
        {
          url: `${API}/services/svc-exp`,
          body: serviceDetail({ id: 'svc-exp', username: 'ar_9001' }),
        },
        {
          url: `${API}/services/svc-exp/offer/RENEW`,
          body: {
            kind: 'RENEW',
            options: [
              {
                addonId: null,
                planId: 'plan-1',
                title: '30 روز',
                price: irt('96000'),
                personalDiscount: null,
              },
            ],
          },
        },
      ]),
    );
    renderPage(<PanelShell />);
    fireEvent.click(await screen.findByRole('button', { name: t('web.rp_renew') }));
    expect(await screen.findByText('30 روز')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t('web.rp_pay_renew') })).toBeInTheDocument();
  });
});

describe('«سرویس‌های من»', () => {
  it('draws chips with the server counts and the table columns', async () => {
    visit('/r/services');
    stubApi(signedIn([{ url: `${API}/services`, body: servicesPage([serviceRow()]) }]));
    renderPage(<PanelShell />);
    await screen.findByText('ar_1043');
    const chips = screen.getByRole('group', { name: t('web.rp_filters_label') });
    expect(
      within(chips)
        .getAllByRole('button')
        .map((chip) => chip.textContent),
    ).toEqual([
      `${t('web.rp_filter_all')}14`,
      `${t('web.rp_filter_active')}12`,
      `${t('web.rp_filter_expiring')}1`,
      `${t('web.rp_filter_expired')}1`,
      `${t('web.rp_filter_suspended')}0`,
      `${t('web.rp_filter_other')}0`,
    ]);
    expect(screen.getByText('ar_1043')).toBeInTheDocument();
    expect(screen.getByText('آلمان')).toBeInTheDocument();
    // PR-5: the client and the auto-renew columns are always drawn.
    expect(screen.getByRole('columnheader', { name: t('web.rp_col_client') })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: t('web.rp_col_ar') })).toBeInTheDocument();
  });

  it('shows the client of a row that carries one', async () => {
    visit('/r/services');
    stubApi(
      signedIn([
        { url: `${API}/services`, body: servicesPage([serviceRow({ client: 'رضا احمدی' })]) },
      ]),
    );
    renderPage(<PanelShell />);
    expect(
      await screen.findByRole('columnheader', { name: t('web.rp_col_client') }),
    ).toBeInTheDocument();
    expect(screen.getByText('رضا احمدی')).toBeInTheDocument();
  });

  it('a chip and the search box ask the server (filter, q) from the first page', async () => {
    visit('/r/services');
    const api = stubApi(signedIn([{ url: `${API}/services`, body: servicesPage([serviceRow()]) }]));
    renderPage(<PanelShell />);
    await screen.findByText('ar_1043');
    fireEvent.click(screen.getByRole('button', { name: new RegExp(t('web.rp_filter_expiring')) }));
    await waitFor(() =>
      expect(api.calls.some((call) => call.url.includes('filter=EXPIRING&page=0'))).toBe(true),
    );
    fireEvent.change(screen.getByLabelText(t('web.rp_search_label')), {
      target: { value: 'ar_10' },
    });
    await waitFor(() => expect(api.calls.some((call) => call.url.includes('q=ar_10'))).toBe(true));
  });

  it('says so when nothing matches', async () => {
    visit('/r/services');
    stubApi(signedIn([{ url: `${API}/services`, body: servicesPage([]) }]));
    renderPage(<PanelShell />);
    expect(await screen.findByText(t('web.rp_services_empty'))).toBeInTheDocument();
  });

  it('starts on the chip named by ?filter=', async () => {
    visit('/r/services?filter=EXPIRING');
    const api = stubApi(signedIn([{ url: `${API}/services`, body: servicesPage([serviceRow()]) }]));
    renderPage(<PanelShell />);
    await screen.findByText('ar_1043');
    expect(api.calls.some((call) => call.url.includes('filter=EXPIRING'))).toBe(true);
  });
});
