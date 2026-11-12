import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { PanelShell } from '../../apps/web/src/reseller/shell';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi, type Route } from './harness';
import {
  irt,
  me,
  problem,
  serviceDetail,
  serviceRow,
  servicesPage,
  signedIn,
} from './reseller-fixtures';

/**
 * The reseller panel's selling half (PR-5): buying (one or several), the clients book,
 * auto-renew, the trial card and the tier-progress card. The real client and schemas run; only
 * `fetch` is stubbed.
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

function mount(path: string, routes: readonly Route[]) {
  visit(path);
  const api = stubApi(signedIn(routes));
  renderPage(<PanelShell />);
  return api;
}

const plan = (id: string, title: string, price: string, list: string | null) => ({
  id,
  title,
  price: irt(price),
  personalDiscount: null,
  trafficBytes: '32212254720',
  durationDays: 30,
  deviceLimit: null,
  locations: [],
  features: [],
  listPrice: list === null ? null : irt(list),
});

const SERVERS_OFF = { enabled: false, step: false, items: [], page: 0, hasMore: false };
const CATEGORIES = {
  items: [
    { id: 'cat-1', name: 'ماهانه', emoji: null },
    { id: 'cat-2', name: 'دوماهه', emoji: null },
  ],
  page: 0,
  hasMore: false,
};
const CUSTOM_OFF = { offered: false, locations: [] };
const CLIENTS = {
  items: [
    {
      id: 'cl-1',
      name: 'رضا احمدی',
      contact: '@reza',
      note: 'یادداشت قدیمی',
      serviceCount: 2,
      expiringCount: 1,
      archived: false,
      createdAt: '2026-05-01T00:00:00.000Z',
    },
    {
      id: 'cl-2',
      name: 'سارا',
      contact: null,
      note: null,
      serviceCount: 0,
      expiringCount: 0,
      archived: false,
      createdAt: '2026-06-01T00:00:00.000Z',
    },
  ],
};

const baseBuyRoutes: Route[] = [
  { url: `${API}/catalogue/servers`, body: SERVERS_OFF },
  { url: `${API}/catalogue/categories`, body: CATEGORIES },
  {
    url: `${API}/catalogue/categories/cat-1`,
    body: {
      items: [plan('p1', 'پلن الف', '96000', '120000'), plan('p2', 'پلن ب', '50000', null)],
      page: 0,
      hasMore: false,
    },
  },
  {
    url: `${API}/catalogue/categories/cat-2`,
    body: { items: [plan('p3', 'پلن دو ماهه', '180000', '230000')], page: 0, hasMore: false },
  },
  { url: `${API}/catalogue/custom`, body: CUSTOM_OFF },
  { url: `${API}/clients`, body: CLIENTS },
];
/** The catalogue routes, with any route of `extra` for the same address replacing the base one. */
const buyRoutes = (extra: readonly Route[] = []): Route[] => [
  ...baseBuyRoutes.filter(
    (base) => !extra.some((one) => one.url === base.url && one.method === base.method),
  ),
  ...extra,
];

const quoteOf = (overrides: Record<string, unknown> = {}) => ({
  batchId: 'batch-1',
  title: 'پلن الف',
  quantity: 2,
  unitPrice: irt('96000'),
  listUnitPrice: irt('120000'),
  total: irt('192000'),
  saving: irt('48000'),
  balance: irt('2450000'),
  balanceAfter: irt('2258000'),
  sufficient: true,
  shortfall: null,
  usernameMode: 'AUTOMATIC',
  username: null,
  clientId: null,
  note: null,
  ...overrides,
});

const item = (index: number, overrides: Record<string, unknown> = {}) => ({
  index,
  orderId: `o-${index}`,
  orderCode: `A-${index}`,
  status: 'CREATED',
  reason: null,
  total: irt('96000'),
  serviceId: `svc-${index}`,
  username: `ar_${index}`,
  subscriptionUrl: `https://sub.example.com/s/${index}`,
  ...overrides,
});

const batchOf = (items: readonly Record<string, unknown>[]) => ({
  batchId: 'batch-1',
  title: 'پلن الف',
  quantity: items.length,
  confirmed: true,
  clientId: null,
  clientName: null,
  note: null,
  createdAt: '2026-11-10T10:00:00.000Z',
  items,
});

const press = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
const radio = (name: string | RegExp) => screen.getByRole('radio', { name });

// --- Buying -------------------------------------------------------------------------------------

describe('«خرید سرویس»', () => {
  it('draws the bot’s categories in the API order and the plan cards with the struck list price', async () => {
    mount('/r/buy', buyRoutes());
    const tabs = await screen.findAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['ماهانه', 'دوماهه']);
    expect(await screen.findByRole('radio', { name: /پلن الف/u })).toBeInTheDocument();
    expect(screen.getByText('120,000 تومان')).toHaveClass('rp-struck');
    expect(screen.getByText('96,000 تومان')).toBeInTheDocument();
    // A plan with no list price shows no struck figure; «سرویس دلخواه» is not offered.
    expect(screen.queryByRole('tab', { name: t('web.rp_buy_custom_tab') })).toBeNull();
    // The server step is hidden when the API says there is none.
    expect(screen.queryByText(t('web.rp_buy_server_title'))).toBeNull();
  });

  it('draws the server step only when the API says so, and asks for a server first', async () => {
    mount(
      '/r/buy',
      buyRoutes([
        {
          url: `${API}/catalogue/servers`,
          body: {
            enabled: true,
            step: true,
            items: [
              { id: 's-1', name: 'آلمان' },
              { id: 's-2', name: 'هلند' },
            ],
            page: 0,
            hasMore: false,
          },
        },
      ]),
    );
    expect(await screen.findByText(t('web.rp_buy_server_first'))).toBeInTheDocument();
    expect(screen.queryByRole('tab')).toBeNull();
    fireEvent.click(radio('آلمان'));
    expect(await screen.findByRole('tab', { name: 'ماهانه' })).toBeInTheDocument();
  });

  it('draws «سرویس دلخواه» only when the bot offers it', async () => {
    mount(
      '/r/buy',
      buyRoutes([
        {
          url: `${API}/catalogue/custom`,
          body: {
            offered: true,
            locations: [
              {
                panelId: 'pan-1',
                label: 'آلمان',
                volume: { min: '1000', max: '50000' },
                days: { min: '7', max: '90' },
              },
            ],
          },
        },
      ]),
    );
    fireEvent.click(await screen.findByRole('tab', { name: t('web.rp_buy_custom_tab') }));
    expect(await screen.findByLabelText(t('web.rp_buy_custom_volume'))).toBeInTheDocument();
    expect(screen.getByText('بین 10 و 500')).toBeInTheDocument();
  });

  it('calls the quote only at the review step, with the batch key, and shows the quote', async () => {
    const api = mount(
      '/r/buy',
      buyRoutes([{ url: `${API}/purchases/quote`, method: 'POST', body: quoteOf() }]),
    );
    fireEvent.click(await screen.findByRole('radio', { name: /پلن الف/u }));
    fireEvent.click(screen.getByRole('button', { name: t('web.rp_buy_qty_inc') }));
    // The summary is the card's price × quantity — no quote yet (it creates drafts).
    expect(screen.getByText('192,000 تومان')).toBeInTheDocument();
    expect(api.calls.some((call) => call.url.includes('/purchases/quote'))).toBe(false);

    press(t('web.rp_buy_review'));
    expect(await screen.findByText(t('web.rp_buy_review_title'))).toBeInTheDocument();
    const quoteCalls = api.calls.filter((call) => call.url.includes('/purchases/quote'));
    expect(quoteCalls).toHaveLength(1);
    expect(quoteCalls[0]?.body).toEqual({
      plan: { kind: 'PLAN', productId: 'p1' },
      quantity: 2,
      username: { mode: 'AUTOMATIC' },
      clientId: null,
      note: null,
    });
    expect(screen.getByText('2,258,000 تومان')).toBeInTheDocument();
    expect(screen.getByText('48,000 تومان')).toBeInTheDocument();
    expect(screen.getByText(t('web.rp_buy_sum_saving'))).toBeInTheDocument();
  });

  it('«دلخواه» is disabled for a quantity above one, and a chosen one is sent as AUTOMATIC', async () => {
    const api = mount(
      '/r/buy',
      buyRoutes([{ url: `${API}/purchases/quote`, method: 'POST', body: quoteOf() }]),
    );
    fireEvent.click(await screen.findByRole('radio', { name: /پلن الف/u }));
    // One service: «دلخواه» is available, and the typed name goes to the quote.
    fireEvent.click(radio(t('web.rp_buy_username_custom')));
    fireEvent.change(screen.getByLabelText(t('web.rp_buy_username_custom_label')), {
      target: { value: 'reza_home' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('web.rp_buy_qty_inc') }));
    // Two services: the option is disabled, the input is gone, and the mode is AUTOMATIC.
    expect(radio(t('web.rp_buy_username_custom'))).toBeDisabled();
    expect(radio(t('web.rp_buy_username_auto'))).toBeChecked();
    expect(screen.queryByLabelText(t('web.rp_buy_username_custom_label'))).toBeNull();
    expect(screen.getByText(t('web.rp_buy_username_multi'))).toBeInTheDocument();
    press(t('web.rp_buy_review'));
    await screen.findByText(t('web.rp_buy_review_title'));
    const body = api.calls.find((call) => call.url.includes('/purchases/quote'))?.body as {
      username: unknown;
    };
    expect(body.username).toEqual({ mode: 'AUTOMATIC' });
  });

  it('a single service with «دلخواه» sends the typed name', async () => {
    const api = mount(
      '/r/buy',
      buyRoutes([
        {
          url: `${API}/purchases/quote`,
          method: 'POST',
          body: quoteOf({ quantity: 1, usernameMode: 'CUSTOM', username: 'reza_home' }),
        },
      ]),
    );
    fireEvent.click(await screen.findByRole('radio', { name: /پلن الف/u }));
    fireEvent.click(radio(t('web.rp_buy_username_custom')));
    // No name typed yet: nothing to review.
    expect(screen.getByRole('button', { name: t('web.rp_buy_review') })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(t('web.rp_buy_username_custom_label')), {
      target: { value: 'reza_home' },
    });
    press(t('web.rp_buy_review'));
    await screen.findByText(t('web.rp_buy_review_title'));
    const body = api.calls.find((call) => call.url.includes('/purchases/quote'))?.body as {
      username: unknown;
    };
    expect(body.username).toEqual({ mode: 'CUSTOM', value: 'reza_home' });
  });

  it('with enough balance the review offers «خرید», and confirming shows each service’s result', async () => {
    const api = mount(
      '/r/buy',
      buyRoutes([
        { url: `${API}/purchases/quote`, method: 'POST', body: quoteOf() },
        {
          url: `${API}/purchases/batch-1/confirm`,
          method: 'POST',
          body: batchOf([
            item(0),
            item(1, {
              status: 'FAILED',
              reason: 'commerce.wallet_insufficient_funds',
              serviceId: null,
              username: null,
              subscriptionUrl: null,
            }),
          ]),
        },
        {
          url: `${API}/purchases/batch-1`,
          method: 'GET',
          body: batchOf([
            item(0),
            item(1, {
              status: 'FAILED',
              reason: 'commerce.wallet_insufficient_funds',
              serviceId: null,
              username: null,
              subscriptionUrl: null,
            }),
          ]),
        },
      ]),
    );
    fireEvent.click(await screen.findByRole('radio', { name: /پلن الف/u }));
    fireEvent.click(screen.getByRole('button', { name: t('web.rp_buy_qty_inc') }));
    press(t('web.rp_buy_review'));
    await screen.findByText(t('web.rp_buy_review_title'));
    expect(
      within(screen.getByRole('main')).queryByRole('button', { name: t('web.rp_buy_charge') }),
    ).toBeNull();
    press(t('web.rp_buy_confirm').replace('{n}', '2'));

    expect(await screen.findByText(t('web.rp_buy_result_title'))).toBeInTheDocument();
    expect(
      screen.getByText(t('web.rp_buy_result_summary').replace('{ok}', '1').replace('{n}', '2')),
    ).toBeInTheDocument();
    // Per item: the created one with its link, the failed one with its Persian reason.
    expect(screen.getByText('ar_0')).toBeInTheDocument();
    expect(screen.getByText(t('web.rp_buy_item_created'))).toBeInTheDocument();
    expect(screen.getByText(t('web.rp_buy_item_failed'))).toBeInTheDocument();
    expect(screen.getByText(t('web.err_commerce_wallet_insufficient_funds'))).toBeInTheDocument();
    expect(screen.getByText('https://sub.example.com/s/0')).toBeInTheDocument();
    const confirmCall = api.calls.find((call) => call.url.endsWith('/purchases/batch-1/confirm'));
    expect(confirmCall?.method).toBe('POST');
  });

  it('«ارسال همهٔ لینک‌ها در تلگرام» posts the batch and «کپی همهٔ لینک‌ها» copies every link', async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (text: string) => (written.push(text), Promise.resolve()) },
    });
    const done = batchOf([item(0), item(1)]);
    const api = mount(
      '/r/buy',
      buyRoutes([
        { url: `${API}/purchases/quote`, method: 'POST', body: quoteOf() },
        { url: `${API}/purchases/batch-1/confirm`, method: 'POST', body: done },
        {
          url: `${API}/purchases/batch-1/send-links`,
          method: 'POST',
          body: { sent: 2, failed: 0 },
        },
        { url: `${API}/purchases/batch-1`, method: 'GET', body: done },
      ]),
    );
    fireEvent.click(await screen.findByRole('radio', { name: /پلن الف/u }));
    press(t('web.rp_buy_review'));
    await screen.findByText(t('web.rp_buy_review_title'));
    press(t('web.rp_buy_confirm').replace('{n}', '2'));
    await screen.findByText(t('web.rp_buy_result_title'));

    press(t('web.rp_buy_send'));
    await waitFor(() =>
      expect(api.calls.some((call) => call.url.endsWith('/purchases/batch-1/send-links'))).toBe(
        true,
      ),
    );
    press(t('web.rp_buy_copy'));
    await waitFor(() =>
      expect(written).toEqual(['https://sub.example.com/s/0\nhttps://sub.example.com/s/1']),
    );
  });

  it('a short wallet replaces «خرید» with «شارژ کیف پول», which opens the wallet', async () => {
    mount(
      '/r/buy',
      buyRoutes([
        {
          url: `${API}/purchases/quote`,
          method: 'POST',
          body: quoteOf({
            sufficient: false,
            shortfall: irt('50000'),
            balance: irt('142000'),
            balanceAfter: irt('-50000'),
          }),
        },
      ]),
    );
    fireEvent.click(await screen.findByRole('radio', { name: /پلن الف/u }));
    fireEvent.click(screen.getByRole('button', { name: t('web.rp_buy_qty_inc') }));
    press(t('web.rp_buy_review'));
    await screen.findByText(t('web.rp_buy_review_title'));
    expect(screen.queryByRole('button', { name: /خرید و ساخت/u })).toBeNull();
    expect(
      screen.getByText(t('web.rp_buy_short').replace('{amount}', '50,000 تومان')),
    ).toBeInTheDocument();
    // The sidebar's own «شارژ کیف پول» is not the review's: the main area has exactly one.
    fireEvent.click(
      within(screen.getByRole('main')).getByRole('button', { name: t('web.rp_buy_charge') }),
    );
    expect(window.location.pathname).toBe('/r/wallet');
  });

  it('opens with the client chosen when it comes from the clients screen', async () => {
    const api = mount(
      '/r/buy?client=cl-1',
      buyRoutes([
        {
          url: `${API}/purchases/quote`,
          method: 'POST',
          body: quoteOf({ quantity: 1, clientId: 'cl-1' }),
        },
      ]),
    );
    fireEvent.click(await screen.findByRole('radio', { name: /پلن الف/u }));
    const select = (await screen.findByLabelText(t('web.rp_buy_client'))) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('cl-1'));
    press(t('web.rp_buy_review'));
    await screen.findByText(t('web.rp_buy_review_title'));
    const body = api.calls.find((call) => call.url.includes('/purchases/quote'))?.body as {
      clientId: string | null;
    };
    expect(body.clientId).toBe('cl-1');
  });

  it('shows the API’s Persian refusal when the quote is refused', async () => {
    mount(
      '/r/buy',
      buyRoutes([problem(`${API}/purchases/quote`, 400, 'reseller_web.custom_username_single')]),
    );
    fireEvent.click(await screen.findByRole('radio', { name: /پلن الف/u }));
    press(t('web.rp_buy_review'));
    expect(
      await screen.findByText(t('web.err_reseller_web_custom_username_single')),
    ).toBeInTheDocument();
    expect(screen.queryByText(t('web.rp_buy_review_title'))).toBeNull();
  });
});

// --- Clients book ---------------------------------------------------------------------------------

const autoRenew = (overrides: Record<string, unknown> = {}) => ({
  enabled: false,
  offered: true,
  price: irt('96000'),
  leadHours: 24,
  imported: false,
  planId: null,
  plans: [],
  unavailable: null,
  ...overrides,
});

const clientServices = {
  items: [
    {
      ...serviceRow({ id: 'svc-a', username: 'rz_1', client: 'رضا احمدی' }),
      autoRenew: autoRenew(),
    },
    {
      ...serviceRow({ id: 'svc-b', username: 'rz_2', client: 'رضا احمدی' }),
      autoRenew: autoRenew({ enabled: true, offered: false }),
    },
  ],
};

describe('«مشتری‌ها»', () => {
  const routes = (extra: readonly Route[] = []): Route[] => [
    { url: `${API}/clients`, body: CLIENTS },
    { url: `${API}/clients/cl-1/services`, body: clientServices },
    ...extra,
  ];

  it('lists the clients and the first one’s services with auto-renew switches', async () => {
    mount('/r/clients', routes());
    expect((await screen.findAllByText('رضا احمدی')).length).toBeGreaterThan(0);
    expect(screen.getByText(t('web.rp_cl_expiring').replace('{n}', '1'))).toBeInTheDocument();
    expect(screen.getByText(t('web.rp_cl_all_ok'))).toBeInTheDocument();
    expect(await screen.findByText('rz_1')).toBeInTheDocument();
    expect(
      screen.getByRole('switch', { name: t('web.rp_ar_label').replace('{user}', 'rz_1') }),
    ).toHaveAttribute('aria-checked', 'false');
    expect(
      screen.getByRole('switch', { name: t('web.rp_ar_label').replace('{user}', 'rz_2') }),
    ).toHaveAttribute('aria-checked', 'true');
  });

  it('«+ سرویس برای این مشتری» opens buying with the client', async () => {
    mount('/r/clients', routes());
    await screen.findByText('rz_1');
    press(t('web.rp_cl_buy'));
    expect(window.location.pathname).toBe('/r/buy');
    expect(window.location.search).toBe('?client=cl-1');
  });

  it('«+ مشتری جدید» posts the name and the contact', async () => {
    const api = mount(
      '/r/clients',
      routes([
        {
          url: `${API}/clients`,
          method: 'POST',
          body: { ...CLIENTS.items[1], id: 'cl-3', name: 'علی' },
        },
      ]),
    );
    await screen.findByText('rz_1');
    press(t('web.rp_cl_new'));
    fireEvent.change(await screen.findByLabelText(t('web.rp_cl_name')), {
      target: { value: 'علی' },
    });
    fireEvent.change(screen.getByLabelText(t('web.rp_cl_contact')), { target: { value: '@ali' } });
    const form = screen
      .getByLabelText(t('web.rp_cl_name'))
      .closest('.rp-client-form') as HTMLElement;
    fireEvent.click(within(form).getByRole('button', { name: t('web.rp_cl_save') }));
    await waitFor(() =>
      expect(api.calls.find((call) => call.method === 'POST')?.body).toEqual({
        name: 'علی',
        contact: '@ali',
        note: null,
      }),
    );
  });

  it('archives (never deletes) after a confirmation', async () => {
    const api = mount(
      '/r/clients',
      routes([
        {
          url: `${API}/clients/cl-1/archive`,
          method: 'POST',
          body: { ...CLIENTS.items[0], archived: true },
        },
      ]),
    );
    await screen.findByText('rz_1');
    press(t('web.rp_cl_archive'));
    fireEvent.click(await screen.findByRole('button', { name: t('web.rp_cl_archive_confirm') }));
    await waitFor(() =>
      expect(api.calls.some((call) => call.url.endsWith('/clients/cl-1/archive'))).toBe(true),
    );
    expect(api.calls.some((call) => call.method === 'DELETE')).toBe(false);
  });

  it('«تمدید همهٔ سرویس‌های او» pre-checks each service and then shows each result', async () => {
    const api = mount(
      '/r/clients',
      routes([
        {
          url: `${API}/clients/cl-1/renew-all`,
          method: 'GET',
          body: {
            count: 1,
            total: irt('96000'),
            balance: irt('2450000'),
            sufficient: true,
            shortfall: null,
            items: [
              { serviceId: 'svc-a', username: 'rz_1', price: irt('96000'), skipped: null },
              { serviceId: 'svc-b', username: 'rz_2', price: null, skipped: 'PLAN_REQUIRED' },
            ],
          },
        },
        {
          url: `${API}/clients/cl-1/renew-all`,
          method: 'POST',
          body: { items: [{ serviceId: 'svc-a', status: 'RENEWED', reason: null, orderId: 'o1' }] },
        },
      ]),
    );
    await screen.findByText('rz_1');
    press(t('web.rp_cl_renew_all'));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(t('web.rp_cl_renew_skipped_plan'))).toBeInTheDocument();
    expect(within(dialog).getByText('96,000 تومان')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: /^تمدید 1 سرویس$/u }));
    expect(await within(dialog).findByText(t('web.rp_cl_renew_renewed'))).toBeInTheDocument();
    expect(api.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  it('a short wallet replaces the renewal with «شارژ کیف پول»', async () => {
    mount(
      '/r/clients',
      routes([
        {
          url: `${API}/clients/cl-1/renew-all`,
          method: 'GET',
          body: {
            count: 2,
            total: irt('192000'),
            balance: irt('1000'),
            sufficient: false,
            shortfall: irt('191000'),
            items: [
              { serviceId: 'svc-a', username: 'rz_1', price: irt('96000'), skipped: null },
              { serviceId: 'svc-b', username: 'rz_2', price: irt('96000'), skipped: null },
            ],
          },
        },
      ]),
    );
    await screen.findByText('rz_1');
    press(t('web.rp_cl_renew_all'));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/191,000/u)).toBeInTheDocument();
    expect(
      within(dialog).getByRole('button', { name: t('web.rp_buy_charge') }),
    ).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /^تمدید 2 سرویس$/u })).toBeNull();
  });
});

// --- «سرویس‌های من»: clients and auto-renew ----------------------------------------------------------

describe('«سرویس‌های من» with clients and auto-renew', () => {
  it('filters by client (clientId), and the drawer assigns a client', async () => {
    const api = mount('/r/services', [
      {
        url: `${API}/services`,
        body: servicesPage([serviceRow({ client: 'رضا احمدی', clientId: 'cl-1' })]),
      },
      { url: `${API}/clients`, body: CLIENTS },
      { url: `${API}/services/svc-1/auto-renew`, body: autoRenew() },
    ]);
    await screen.findByText('ar_1043');
    expect(screen.getByRole('columnheader', { name: t('web.rp_col_client') })).toBeInTheDocument();
    const filter = await screen.findByLabelText(t('web.rp_filter_client'));
    await screen.findByRole('option', { name: 'سارا' });
    fireEvent.change(filter, { target: { value: 'cl-2' } });
    await waitFor(() =>
      expect(api.calls.some((call) => call.url.includes('clientId=cl-2'))).toBe(true),
    );
  });

  it('the drawer’s «مشتری» tab assigns and releases a client', async () => {
    const api = mount('/r/services', [
      {
        url: `${API}/services/svc-1`,
        body: serviceDetail({ client: 'رضا احمدی', clientId: 'cl-1', working: false }),
      },
      {
        url: `${API}/services/svc-1/client`,
        method: 'PUT',
        body: { clientId: null },
      },
      {
        url: `${API}/services`,
        body: servicesPage([serviceRow({ client: 'رضا احمدی', clientId: 'cl-1' })]),
      },
      { url: `${API}/clients`, body: CLIENTS },
      { url: `${API}/services/svc-1/auto-renew`, body: autoRenew() },
    ]);
    fireEvent.click(await screen.findByRole('button', { name: t('web.rp_manage') }));
    fireEvent.click(await screen.findByRole('tab', { name: t('web.rp_tab_client') }));
    const select = (await screen.findByLabelText(
      t('web.rp_client_assign_label'),
    )) as HTMLSelectElement;
    await within(select).findByRole('option', { name: 'سارا' });
    fireEvent.change(select, { target: { value: '' } });
    press(t('web.rp_client_assign_save'));
    await waitFor(() =>
      expect(api.calls.find((call) => call.method === 'PUT')?.body).toEqual({ clientId: null }),
    );
  });

  it('a plain service switches auto-renew on with the price it showed', async () => {
    const api = mount('/r/services', [
      { url: `${API}/services`, body: servicesPage([serviceRow()]) },
      { url: `${API}/clients`, body: { items: [] } },
      { url: `${API}/services/svc-1/auto-renew`, body: autoRenew() },
      {
        url: `${API}/services/svc-1/auto-renew`,
        method: 'PUT',
        body: autoRenew({ enabled: true, offered: false }),
      },
    ]);
    fireEvent.click(
      await screen.findByRole('switch', {
        name: t('web.rp_ar_label').replace('{user}', 'ar_1043'),
      }),
    );
    await waitFor(() => expect(api.calls.some((call) => call.method === 'PUT')).toBe(true));
    expect(api.calls.find((call) => call.method === 'PUT')?.body).toEqual({
      enabled: true,
      expected: irt('96000'),
      planId: null,
    });
  });

  it('an imported service says to choose a plan, and switches on only with the chosen plan', async () => {
    const imported = autoRenew({
      offered: false,
      price: null,
      imported: true,
      unavailable: 'PLAN_REQUIRED',
      plans: [
        { planId: 'plan-1', title: 'پلن الف', price: irt('96000') },
        { planId: 'plan-2', title: 'پلن ب', price: irt('50000') },
      ],
    });
    const api = mount('/r/services', [
      { url: `${API}/services`, body: servicesPage([serviceRow()]) },
      { url: `${API}/clients`, body: { items: [] } },
      { url: `${API}/services/svc-1/auto-renew`, body: imported },
      {
        url: `${API}/services/svc-1/auto-renew`,
        method: 'PUT',
        body: { ...imported, enabled: true, planId: 'plan-2', unavailable: null },
      },
    ]);
    expect(await screen.findByText(t('web.rp_ar_plan_required'))).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('switch', { name: t('web.rp_ar_label').replace('{user}', 'ar_1043') }),
    );
    // The picker opens; nothing is sent until a plan is chosen.
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: t('web.rp_ar_enable') })).toBeDisabled();
    expect(api.calls.some((call) => call.method === 'PUT')).toBe(false);
    fireEvent.change(within(dialog).getByLabelText(t('web.rp_ar_plan')), {
      target: { value: 'plan-2' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: t('web.rp_ar_enable') }));
    await waitFor(() => expect(api.calls.some((call) => call.method === 'PUT')).toBe(true));
    expect(api.calls.find((call) => call.method === 'PUT')?.body).toEqual({
      enabled: true,
      expected: irt('50000'),
      planId: 'plan-2',
    });
  });

  it('an imported service with no plan to choose stays off, with the reason, and cannot be switched', async () => {
    mount('/r/services', [
      { url: `${API}/services`, body: servicesPage([serviceRow()]) },
      { url: `${API}/clients`, body: { items: [] } },
      {
        url: `${API}/services/svc-1/auto-renew`,
        body: autoRenew({
          offered: false,
          price: null,
          imported: true,
          unavailable: 'NOT_AVAILABLE',
        }),
      },
    ]);
    const toggle = await screen.findByRole('switch', {
      name: t('web.rp_ar_label').replace('{user}', 'ar_1043'),
    });
    expect(toggle).toBeDisabled();
    expect(screen.getByText(t('web.rp_ar_unavailable'))).toBeInTheDocument();
  });
});

// --- Dashboard: trial and tier progress ----------------------------------------------------------------

describe('the dashboard’s trial and tier-progress cards', () => {
  const dash = { url: `${API}/dashboard`, body: undefined as unknown };
  const dashboardRoute = async (): Promise<Route> => {
    const { dashboard } = await import('./reseller-fixtures');
    return { ...dash, body: dashboard() };
  };

  it('draws «سرویس تست — امروز: x از N» and «ساخت تست» posts with a key', async () => {
    const api = mount('/r/dashboard', [
      await dashboardRoute(),
      { url: `${API}/trial`, method: 'GET', body: { enabled: true, quota: 3, usedToday: 1 } },
      {
        url: `${API}/trial`,
        method: 'POST',
        body: { serviceId: 's', orderId: 'o', usedToday: 2, quota: 3 },
      },
    ]);
    expect(
      await screen.findByText(
        t('web.rp_trial_today').replace('{used}', '1').replace('{quota}', '3'),
      ),
    ).toBeInTheDocument();
    press(t('web.rp_trial_make'));
    expect(
      await screen.findByText(
        t('web.rp_trial_today').replace('{used}', '2').replace('{quota}', '3'),
      ),
    ).toBeInTheDocument();
    expect(api.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  it('hides the trial card at quota 0 (the API says not enabled)', async () => {
    mount('/r/dashboard', [
      await dashboardRoute(),
      { url: `${API}/trial`, body: { enabled: false, quota: 0, usedToday: 0 } },
    ]);
    await screen.findByText(t('web.rp_stat_sales'));
    await waitFor(() => expect(screen.queryByText(t('web.rp_trial_title'))).toBeNull());
    expect(screen.queryByRole('button', { name: t('web.rp_trial_make') })).toBeNull();
  });

  it('disables «ساخت تست» once today’s quota is used', async () => {
    mount('/r/dashboard', [
      await dashboardRoute(),
      { url: `${API}/trial`, body: { enabled: true, quota: 3, usedToday: 3 } },
    ]);
    expect(await screen.findByRole('button', { name: t('web.rp_trial_make') })).toBeDisabled();
  });

  it('draws the tier progress: the bar, «x از N سرویس این ماه» and what is left to the month’s end', async () => {
    mount('/r/dashboard', [
      await dashboardRoute(),
      {
        url: `${API}/tier-progress`,
        body: {
          shown: true,
          tierName: 'طلایی',
          target: { kind: 'COUNT', count: 50 },
          count: 38,
          amount: null,
          remainingCount: 12,
          remainingAmount: null,
          monthEnd: '2026-11-21T20:30:00.000Z',
        },
      },
    ]);
    expect(
      await screen.findByText(
        t('web.rp_progress_count').replace('{count}', '38').replace('{target}', '50'),
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: t('web.rp_progress_bar') })).toHaveAttribute(
      'aria-valuenow',
      '76',
    );
    expect(screen.getByText(/12 سرویس دیگر تا آخر آبان/u)).toBeInTheDocument();
  });

  it('draws no progress card when the API returns none (flag off or no target)', async () => {
    mount('/r/dashboard', [
      await dashboardRoute(),
      {
        url: `${API}/tier-progress`,
        body: {
          shown: false,
          tierName: null,
          target: null,
          count: 0,
          amount: null,
          remainingCount: null,
          remainingAmount: null,
          monthEnd: '2026-11-21T20:30:00.000Z',
        },
      },
    ]);
    await screen.findByText(t('web.rp_stat_sales'));
    expect(screen.queryByText(t('web.rp_progress_title'))).toBeNull();
    expect(screen.queryByRole('progressbar', { name: t('web.rp_progress_bar') })).toBeNull();
  });
});

// --- «حساب و تنظیمات» --------------------------------------------------------------------------------

describe('«حساب و تنظیمات»', () => {
  it('draws the three notification switches with no «not yet consumed» note', async () => {
    mount('/r/settings', [
      {
        url: `${API}/settings/notifications`,
        body: {
          newDeviceAlert: true,
          expiringDigest: true,
          dailySalesReport: false,
          ticketReply: true,
        },
      },
      { url: `${API}/security/sessions`, body: { items: [] } },
      { url: `${API}/security/activity`, body: { items: [], nextCursor: null } },
    ]);
    expect(
      await screen.findByRole('switch', { name: t('web.rp_notif_expiring') }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/هنوز فرستاده نمی‌شود/u)).toBeNull();
    void me;
  });
});
