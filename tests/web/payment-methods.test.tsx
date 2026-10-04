import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import {
  PAYMENT_GATEWAY_PROVIDERS,
  PERMISSION_KEYS,
  type GatewayHealthView,
  type PaymentGatewayProvider,
} from '@nexa/contracts';
import { App, resolve } from '../../apps/web/src/app';
import { t } from '../../apps/web/src/i18n/web.fa';
import {
  CARD_TO_CARD_PATH,
  PAYMENT_METHOD_SLUGS,
  paymentMethodPath,
  providerOfSlug,
} from '../../apps/web/src/payment-method-routes';
import { PaymentGatewaysPage } from '../../apps/web/src/pages/payment-gateways';
import { navigate } from '../../apps/web/src/router';
import { renderPage, stubApi } from './harness';

/**
 * UX Batch 01, item 8: every payment method has its own view at its own URL, instead of
 * one long page where a click only scrolled. And item 7's move: «حساب‌های دریافت» is the
 * card-to-card method's card list now, and its old path redirects there.
 *
 * What is defended: each provider has a real route and a deep link; the list links to it
 * and its view links back; a reload (a fresh mount at the same URL) lands on the same
 * provider; each view carries only its own provider; each capability is still gated on the
 * key the server charges; and the old path lands on the new place without a history entry
 * of its own.
 */

const ALL = [...PERMISSION_KEYS];

const session = (permissions: readonly string[]) => ({
  url: '/auth/session',
  body: {
    admin: {
      id: '01a05e35-c9ad-7e93-bef3-1ed9b55292c8',
      username: 'owner',
      displayName: 'مدیر اصلی',
      status: 'ACTIVE',
      telegramUserId: null,
      roleKeys: ['owner'],
      createdAt: '2026-01-01T00:00:00.000Z',
      lastLoginAt: '2026-09-06T08:00:00.000Z',
    },
    permissions,
    expiresAt: '2026-09-07T08:00:00.000Z',
  },
});

function gateway(provider: PaymentGatewayProvider, extra: Record<string, unknown> = {}) {
  const keyed = provider !== 'MANUAL_TRANSFER' && provider !== 'TELEGRAM_STARS';
  return {
    provider,
    status: 'ACTIVE',
    displayName: null,
    instructions: null,
    minAmountMinor: '0',
    maxAmountMinor: '0',
    currency: 'IRT',
    eligibility: {
      activateAfterPayments: 0,
      deactivateAfterPayments: 0,
      activateAfterAccountDays: 0,
    },
    sortOrder: 0,
    topupCashbackPercent: 0,
    allowServicePurchase: true,
    allowWalletTopup: true,
    credential: { required: keyed, setAt: keyed ? '2026-09-20T08:00:00.000Z' : null },
    callbackUrl: keyed
      ? `https://bot.example.com/payments/webhook/${provider.toLowerCase()}/t-1`
      : null,
    createdAt: '2026-09-10T12:30:00.000Z',
    updatedAt: '2026-09-10T12:30:00.000Z',
    ...extra,
  };
}

const PROVIDERS: readonly PaymentGatewayProvider[] = [
  'MANUAL_TRANSFER',
  'NOWPAYMENTS',
  'TONPAYS',
  'CENTRALPAY',
];

function health(provider: PaymentGatewayProvider): GatewayHealthView {
  return {
    provider,
    status: 'ACTIVE',
    state: 'NO_ACTIVITY',
    configuration: { complete: true, gaps: [] },
    // A distinct recorded result per route, so a view can be checked for whose health it shows.
    check: {
      supported: true,
      lastAt: '2026-10-03T07:00:00.000Z',
      lastResult: `probe:${provider.toLowerCase()}`,
    },
    answers: {
      lastInvoiceCreatedAt: null,
      lastInquiryAnsweredAt: null,
      lastInquiryFailure: null,
      lastCreateFailure: null,
      attemptsInWindow: 0,
      attemptsWithProviderError: 0,
    },
    callBudget: null,
    openConditions: [],
    queues: null,
    lastReconciliation: null,
    signals: [],
  };
}

const ACCOUNT = {
  id: '019250ab-cdef-7012-8345-6789abcdef01',
  label: 'main',
  bankName: 'Bank Melli',
  holderName: 'Acme Store',
  cardNumber: '6037991234567893',
  iban: null,
  enabled: true,
  isDefault: true,
  sortOrder: 0,
  createdAt: '2026-09-10T12:30:00.000Z',
  updatedAt: '2026-09-10T12:30:00.000Z',
};

const api = (permissions: readonly string[] = ALL) =>
  stubApi([
    session(permissions),
    { url: '/payment-gateways', body: { gateways: PROVIDERS.map((p) => gateway(p)) } },
    {
      url: '/payment-gateways-health',
      body: {
        window: null,
        gateways: PROVIDERS.map(health),
        withheld: ['PAYMENTS'],
        generatedAt: '2026-10-03T09:00:00.000Z',
      },
    },
    { url: '/payment-accounts', body: { accounts: [ACCOUNT] } },
    { url: '/fx/status', body: { state: 'DISABLED', quote: null } },
  ]);

const go = (url: string) => act(() => navigate(url, { replace: true, force: true }));

beforeEach(() => go('/'));
afterEach(() => go('/'));

const heading = (name: string) => screen.findByRole('heading', { level: 1, name });

describe('the payment-method slugs', () => {
  it('give every provider in the contract one distinct slug, and read it back', () => {
    const slugs = PAYMENT_GATEWAY_PROVIDERS.map((provider) => PAYMENT_METHOD_SLUGS[provider]);
    expect(new Set(slugs).size).toBe(PAYMENT_GATEWAY_PROVIDERS.length);
    for (const provider of PAYMENT_GATEWAY_PROVIDERS) {
      expect(providerOfSlug(PAYMENT_METHOD_SLUGS[provider])).toBe(provider);
      expect(paymentMethodPath(provider)).toBe(
        `/payment-gateways/${PAYMENT_METHOD_SLUGS[provider]}`,
      );
    }
    expect(CARD_TO_CARD_PATH).toBe('/payment-gateways/card-to-card');
  });

  it('name the four the owner listed by readable paths, and refuse anything else', () => {
    expect(paymentMethodPath('NOWPAYMENTS')).toBe('/payment-gateways/nowpayments');
    expect(paymentMethodPath('TONPAYS')).toBe('/payment-gateways/tonpays');
    expect(paymentMethodPath('CENTRALPAY')).toBe('/payment-gateways/centralpay');
    expect(paymentMethodPath('MANUAL_TRANSFER')).toBe('/payment-gateways/card-to-card');
    for (const slug of ['NOWPAYMENTS', 'NowPayments', 'nowpayment', '', 'manual_transfer']) {
      expect(providerOfSlug(slug), slug).toBeNull();
    }
  });
});

describe('each provider’s route', () => {
  it.each(PAYMENT_GATEWAY_PROVIDERS.map((provider) => [provider]))(
    '%s resolves to its own view, under the list in the crumbs',
    (provider) => {
      const resolved = resolve(
        { path: paymentMethodPath(provider), query: new URLSearchParams() },
        ALL,
        ['owner'],
      );
      const element = resolved.element as ReactElement<{ slug: string }>;
      expect((element.type as { name: string }).name).toBe('PaymentMethodPage');
      expect(element.props.slug).toBe(PAYMENT_METHOD_SLUGS[provider]);
      expect(resolved.crumbs[0]).toEqual({
        label: t('web.nav_payment_gateways'),
        href: '/payment-gateways',
      });
      expect(resolved.title).not.toBe(t('web.not_found_title'));
    },
  );

  it('names an unknown provider as such, with the way back', async () => {
    api();
    go('/payment-gateways/paypal');
    renderPage(<App />);
    expect(await heading(t('web.payment_method_unknown'))).toBeInTheDocument();
    expect(screen.getByText(t('web.payment_method_missing'))).toBeInTheDocument();
    expect(screen.getByRole('link', { name: t('web.payment_method_back') })).toHaveAttribute(
      'href',
      '/payment-gateways',
    );
  });
});

describe('the list → a provider → back', () => {
  it('links each route to its own view, and edits nothing in place', async () => {
    api();
    go('/payment-gateways');
    const view = renderPage(<App />);
    await heading(t('web.payment_gateways_title'));
    const table = await screen.findByRole('table');
    for (const provider of PROVIDERS) {
      const links = within(table)
        .getAllByRole('link')
        .filter((link) => link.getAttribute('href') === paymentMethodPath(provider));
      // The name and «مدیریت», both to the same view.
      expect(links.length, provider).toBe(2);
    }
    // No write control and no form on the list: they belong to a route's own view.
    expect(within(table).queryByRole('button', { name: t('web.payment_gateway_edit') })).toBeNull();
    expect(view.container.querySelector('#pg-name')).toBeNull();
    // …nor another route's callback URL.
    expect(view.container.textContent).not.toContain('https://bot.example.com/');
  });

  it('opens a provider’s view on click, keeps it on reload, and goes back to the list', async () => {
    api();
    go('/payment-gateways');
    const first = renderPage(<App />);
    const table = await screen.findByRole('table');
    const open = within(table)
      .getAllByRole('link', { name: t('web.payment_method_open') })
      .find((link) => link.getAttribute('href') === '/payment-gateways/nowpayments') as HTMLElement;
    act(() => {
      fireEvent.click(open);
    });
    expect(window.location.pathname).toBe('/payment-gateways/nowpayments');
    expect(await heading(t('web.payment_gateway_provider_nowpayments'))).toBeInTheDocument();

    // A reload is a fresh mount at the same URL: the same provider, nothing else.
    first.unmount();
    const reloaded = renderPage(<App />);
    expect(await heading(t('web.payment_gateway_provider_nowpayments'))).toBeInTheDocument();
    expect(await screen.findByText(t('web.payment_method_settings'))).toBeInTheDocument();
    expect(reloaded.container.textContent).toContain(
      'https://bot.example.com/payments/webhook/nowpayments/t-1',
    );
    expect(reloaded.container.textContent).not.toContain('/webhook/tonpays/');

    // The sidebar still marks «روش‌های پرداخت» as where the operator is.
    const nav = screen.getByRole('navigation', { name: t('web.nav_label') });
    const entry = within(nav)
      .getAllByRole('link')
      .find((link) => link.getAttribute('href') === '/payment-gateways') as HTMLElement;
    expect(entry.getAttribute('aria-current')).toBe('page');

    act(() => {
      fireEvent.click(screen.getByRole('link', { name: t('web.payment_method_back') }));
    });
    expect(window.location.pathname).toBe('/payment-gateways');
    expect(await heading(t('web.payment_gateways_title'))).toBeInTheDocument();
  });

  it('returns to the provider with the browser’s Back, as a real history entry', async () => {
    api();
    go('/payment-gateways');
    renderPage(<App />);
    const table = await screen.findByRole('table');
    const before = window.history.length;
    act(() => {
      fireEvent.click(
        within(table)
          .getAllByRole('link')
          .find((link) => link.getAttribute('href') === '/payment-gateways/tonpays') as HTMLElement,
      );
    });
    expect(window.history.length).toBe(before + 1);
    expect(await heading(t('web.payment_gateway_provider_tonpays'))).toBeInTheDocument();
    act(() => {
      window.history.back();
    });
    await waitFor(() => expect(window.location.pathname).toBe('/payment-gateways'));
    expect(await heading(t('web.payment_gateways_title'))).toBeInTheDocument();
  });
});

describe('a provider’s own view', () => {
  it.each<[PaymentGatewayProvider, string]>([
    ['NOWPAYMENTS', 'web.payment_gateway_provider_nowpayments'],
    ['TONPAYS', 'web.payment_gateway_provider_tonpays'],
    ['CENTRALPAY', 'web.payment_gateway_provider_centralpay'],
    ['MANUAL_TRANSFER', 'web.payment_gateway_provider_manual_transfer'],
  ])(
    '%s deep-links to its own settings and its own health, and nobody else’s',
    async (provider, label) => {
      api();
      go(paymentMethodPath(provider));
      const { container } = renderPage(<App />);
      expect(await heading(t(label as Parameters<typeof t>[0]))).toBeInTheDocument();
      const settings = (
        await screen.findByRole('heading', {
          name: t('web.payment_method_settings'),
        })
      ).closest('section') as HTMLElement;
      // Its own health, by its own recorded check — and no other route's.
      expect(await screen.findByText(`probe:${provider.toLowerCase()}`)).toBeInTheDocument();
      for (const other of PROVIDERS.filter((candidate) => candidate !== provider)) {
        expect(container.textContent, other).not.toContain(`probe:${other.toLowerCase()}`);
      }
      // One route's settings, and its actions drawn once.
      expect(container.querySelectorAll('dl.kv').length).toBeGreaterThan(0);
      expect(
        within(settings).getAllByRole('button', { name: t('web.payment_gateway_edit') }),
      ).toHaveLength(1);
    },
  );

  it('opens a route’s form right under its own settings, on its own view', async () => {
    stubApi([{ url: '/payment-gateways', body: { gateways: PROVIDERS.map((p) => gateway(p)) } }]);
    renderPage(<PaymentGatewaysPage provider="TONPAYS" denied={false} mayEdit />);
    fireEvent.click(await screen.findByRole('button', { name: t('web.payment_gateway_edit') }));
    const name = await screen.findByLabelText(t('web.payment_gateway_name'));
    expect(
      screen.getByText(
        `${t('web.payment_gateway_editing')} — ${t('web.payment_gateway_provider_tonpays')}`,
      ),
    ).toBeInTheDocument();
    expect(name).toBeInTheDocument();
  });

  it('keeps the range filter on the same provider', async () => {
    api();
    go('/payment-gateways/centralpay');
    renderPage(<App />);
    await screen.findByText('probe:centralpay');
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: t('web.payment_ops_range_30d') }));
    });
    expect(window.location.pathname).toBe('/payment-gateways/centralpay');
    expect(window.location.search).toContain('range=LAST_30_DAYS');
  });

  it('draws no write control for a role that may only view the routes', async () => {
    api(['payments.gateways.view']);
    go('/payment-gateways/nowpayments');
    renderPage(<App />);
    await screen.findByText(t('web.payment_method_settings'));
    expect(screen.queryByRole('button', { name: t('web.payment_gateway_edit') })).toBeNull();
    expect(
      screen.queryByRole('button', { name: t('web.payment_gateway_credential_edit') }),
    ).toBeNull();
  });

  it('refuses a role that may read neither the routes nor the cards', async () => {
    const calls = api(['orders.view']);
    go('/payment-gateways/card-to-card');
    renderPage(<App />);
    await heading(t('web.payment_gateway_provider_manual_transfer'));
    expect(screen.queryByText(t('web.payment_method_settings'))).toBeNull();
    expect(screen.queryByText('Bank Melli')).toBeNull();
    expect(
      calls.calls.some(
        (call) => call.url.includes('/payment-gateways') || call.url.includes('/payment-accounts'),
      ),
    ).toBe(false);
  });
});

describe('card-to-card: the cards beside the route (item 7)', () => {
  it('shows the route, «افزودن کارت» beside its actions, and the cards — on one view', async () => {
    api();
    go(CARD_TO_CARD_PATH);
    renderPage(<App />);
    await screen.findByText(t('web.payment_method_settings'));
    expect(await screen.findByText('Bank Melli')).toBeInTheDocument();
    // Beside the route's own actions, and on the cards' card: both open the one form.
    const add = screen.getAllByRole('button', { name: t('web.payment_account_add') });
    expect(add).toHaveLength(2);
    fireEvent.click(add[0] as HTMLElement);
    expect(await screen.findByText(t('web.payment_account_new'))).toBeInTheDocument();
    expect(screen.getAllByLabelText(t('web.payment_account_card'))).toHaveLength(1);
  });

  it('has no cards on another provider’s view', async () => {
    const calls = api();
    go('/payment-gateways/tonpays');
    renderPage(<App />);
    await screen.findByText(t('web.payment_method_settings'));
    expect(screen.queryByRole('button', { name: t('web.payment_account_add') })).toBeNull();
    expect(calls.calls.some((call) => call.url.includes('/payment-accounts'))).toBe(false);
  });

  it('sends a cards-only role from the list to the card-to-card view', async () => {
    api(['payments.accounts.view']);
    go('/payment-gateways');
    renderPage(<App />);
    const link = await screen.findByRole('link', { name: t('web.payment_method_open') });
    expect(link).toHaveAttribute('href', CARD_TO_CARD_PATH);
    act(() => {
      fireEvent.click(link);
    });
    expect(await screen.findByText('Bank Melli')).toBeInTheDocument();
  });
});

describe('the old «حساب‌های دریافت» path', () => {
  it('redirects to the card-to-card view, replacing its own history entry', async () => {
    api();
    go('/payment-accounts');
    const before = window.history.length;
    renderPage(<App />);
    await waitFor(() => expect(window.location.pathname).toBe(CARD_TO_CARD_PATH));
    expect(window.history.length).toBe(before);
    expect(await heading(t('web.payment_gateway_provider_manual_transfer'))).toBeInTheDocument();
    expect(await screen.findByText('Bank Melli')).toBeInTheDocument();
  });

  it('redirects for every reader the old page served, and is not a nav entry', () => {
    const resolved = resolve({ path: '/payment-accounts', query: new URLSearchParams() }, [
      'payments.accounts.view',
    ]);
    const element = resolved.element as ReactElement<{ to: string }>;
    expect((element.type as { name: string }).name).toBe('RedirectPage');
    expect(element.props.to).toBe(CARD_TO_CARD_PATH);
  });
});
